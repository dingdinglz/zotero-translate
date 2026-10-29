#!/usr/bin/env python3
"""Isolated PDF-only worker: python -I worker.py check|convert|preview JSON.

Adapted from the project-owner-supplied oxr-pdf-to-markdown/pdf_to_markdown.py
(local reference): splitting, OXR multipart protocol, resumable task cache and layout
validation. No Pillow, shell, dependency installer, lossy fallback or URL switch.
Only convert uses the network, after the caller obtains upload consent.

Limits: source/output PDF 512 MiB, 10,000 pages, 20 pages / 9,500,000 bytes per
upload, 64 MiB decoded HTTP response / cache entry, 256 MiB aggregate cache,
128 MiB aggregate Markdown, page content and page-map JSON (each),
100,000 layout blocks (10,000/page). Requests use
15s connect / 120s read timeouts and a 120s streaming deadline, at most 3 retries;
polling is every 5s for at most 1 hour/chunk. Submission retries can create
remote duplicates (OXR has no idempotency key). Signals interrupt local work;
remote tasks may survive. Cache filenames NEVER incorporate remote task IDs.
The caller owns and serializes access to outputDir; it must already exist.
"""
import contextlib
import hashlib
import importlib.util
import ipaddress
import json
import math
import os
from pathlib import Path
import re
import signal
import stat
import sys
import tempfile
import time
from urllib.parse import urlsplit, urlunsplit

sys.dont_write_bytecode = True
MIB = 1024 * 1024
MAX_SOURCE = 512 * MIB
MAX_RESPONSE = 64 * MIB
MAX_CACHE = 256 * MIB
MAX_MARKDOWN = 128 * MIB
MAX_PAGE_MAP = 128 * MIB
BLOCK_FORMATS = {"text", "html", "latex", "markdown"}
MAX_PAGES = 10000
MAX_BLOCKS = 100000
MAX_CHUNK = 9500000
TASK_TIMEOUT = 3600
REQUEST_TIMEOUT = 120
RETRY_STATUSES = {408, 429} | set(range(500, 600))
pymupdf = None
requests = None


class WorkerError(Exception):
    """Only fixed, non-sensitive codes may cross the process boundary."""


def fail(code):
    raise WorkerError(code)


def load_dependencies(network=False):
    global pymupdf, requests
    if sys.version_info < (3, 9):
        fail("python_version")
    try:
        import pymupdf as module
    except ImportError:
        fail("pymupdf_missing")
    version = getattr(module, "VersionBind", "")
    if not re.fullmatch(r"1\.\d+\.\d+", version) or tuple(map(int, version.split("."))) < (1, 24, 4):
        fail("pymupdf_version")
    pymupdf = module
    # Verify the actual local APIs used, not just the distribution version.
    try:
        with module.open() as document:
            page = document.new_page(width=72, height=72)
            page.get_pixmap(matrix=module.Matrix(1, 1), colorspace=module.csRGB, alpha=False)
            document.add_ocg("Capability check")
            document.tobytes(garbage=4, deflate=True, no_new_id=True)
            page.new_shape()
    except Exception:
        fail("pymupdf_capability")
    if network:
        try:
            import requests as client
        except ImportError:
            fail("requests_missing")
        version = getattr(client, "__version__", "")
        if not re.fullmatch(r"2\.\d+\.\d+", version) or tuple(map(int, version.split("."))) < (2, 31, 0):
            fail("requests_version")
        requests = client


def base_url(value):
    if not isinstance(value, str) or not value or len(value) > 2048:
        fail("invalid_base_url")
    if any(ord(c) <= 32 or ord(c) == 127 for c in value) or "\\" in value or "?" in value or "#" in value:
        fail("invalid_base_url")
    try:
        parts = urlsplit(value)
        host = parts.hostname
        if not host or parts.username is not None or parts.password is not None or parts.port == 0:
            fail("invalid_base_url")
        loopback = host.lower() == "localhost"
        try:
            loopback = loopback or ipaddress.ip_address(host).is_loopback
        except ValueError:
            pass
        if parts.scheme != "https" and not (parts.scheme == "http" and loopback):
            fail("invalid_base_url")
        # Do not let URL normalization change endpoint meaning.
        if "%" in parts.netloc or any(p in (".", "..") for p in parts.path.split("/")):
            fail("invalid_base_url")
        return urlunsplit((parts.scheme, parts.netloc, parts.path.rstrip("/"), "", ""))
    except (ValueError, UnicodeError):
        fail("invalid_base_url")


def absolute_path(value):
    if not isinstance(value, str) or len(value) > 32768 or "\0" in value:
        fail("invalid_path")
    path = Path(value)
    if not path.is_absolute() or ".." in path.parts:
        fail("invalid_path")
    return path


def no_symlinks(path):
    for part in reversed((path,) + tuple(path.parents)):
        try:
            mode = part.lstat().st_mode
        except FileNotFoundError:
            fail("invalid_path")
        if stat.S_ISLNK(mode):
            fail("symlink_path")
        if part != path and not stat.S_ISDIR(mode):
            fail("invalid_path")


class Output:
    def __init__(self, directory, source):
        self.root = absolute_path(directory)
        no_symlinks(self.root)
        if not self.root.is_dir():
            fail("invalid_output_dir")
        self.source = source
        self.cache = self.root / "cache"
        # Check all fixed destinations before any request or write, including
        # destinations belonging to another operation (e.g. source=preview.png).
        for name in ("source.md", "layout.pdf", "preview.png"):
            self.path(name)
        if self.cache.exists() or self.cache.is_symlink():
            no_symlinks(self.cache)
            if not self.cache.is_dir():
                fail("invalid_cache")

    def path(self, name):
        if name not in {"source.md", "layout.pdf", "preview.png"} and not re.fullmatch(r"(?:cache/|pages-)[a-f0-9]{64}\.json", name):
            fail("invalid_output_name")
        path = self.root / name
        no_symlinks(path.parent)
        if path == self.source:
            fail("source_alias")
        if path.exists() or path.is_symlink():
            no_symlinks(path)
            info = path.stat()
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or os.path.samefile(path, self.source):
                fail("source_alias")
        return path

    def prepare_cache(self):
        if not self.cache.exists():
            self.cache.mkdir(mode=0o700)
        no_symlinks(self.cache)
        # A hard kill may leave a never-committed atomic-write temporary. Only
        # clean our exact mkstemp namespace, never arbitrary cache entries.
        with os.scandir(self.cache) as entries:
            for index, entry in enumerate(entries):
                if index >= MAX_PAGES * 2:
                    fail("cache_limit")
                if re.fullmatch(r"\.spt-[a-z0-9_]{8}", entry.name):
                    info = entry.stat(follow_symlinks=False)
                    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                        fail("invalid_cache")
                    os.unlink(entry.path)
        self.cache_size()

    def cache_size(self):
        total = 0
        count = 0
        with os.scandir(self.cache) as entries:
            for entry in entries:
                count += 1
                if count > MAX_PAGES or not re.fullmatch(r"[a-f0-9]{64}\.json", entry.name):
                    fail("invalid_cache")
                info = entry.stat(follow_symlinks=False)
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                    fail("invalid_cache")
                if info.st_size > MAX_RESPONSE:
                    fail("cache_limit")
                total += info.st_size
                if total > MAX_CACHE:
                    fail("cache_limit")
        return total

    @contextlib.contextmanager
    def staging(self, name):
        destination = self.path(name)
        fd, temporary = tempfile.mkstemp(prefix=".spt-", dir=destination.parent)
        try:
            with os.fdopen(fd, "w+b") as handle:
                yield handle, Path(temporary)
                if not handle.closed:
                    handle.flush()
                    os.fsync(handle.fileno())
            # A PDF renderer may atomically replace the staging path itself.
            # Sync that final inode, not only the initial mkstemp descriptor.
            with open(temporary, "rb") as final:
                os.fsync(final.fileno())
            self.path(name)
            os.replace(temporary, destination)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def write(self, name, data):
        with self.staging(name) as (handle, _):
            handle.write(data)

    def cache_write(self, name, state):
        data = json.dumps(state, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
        path = self.path(name)
        previous = path.stat().st_size if path.exists() else 0
        if len(data) > MAX_RESPONSE or self.cache_size() - previous + len(data) > MAX_CACHE:
            fail("cache_limit")
        self.write(name, data)

    def cache_read(self, name):
        path = self.path(name)
        if not path.exists():
            return {}
        with path.open("rb") as handle:
            data = handle.read(MAX_RESPONSE + 1)
        if len(data) > MAX_RESPONSE:
            fail("cache_limit")
        try:
            value = json.loads(data)
        except (ValueError, RecursionError):
            fail("invalid_cache")
        if not isinstance(value, dict):
            fail("invalid_cache")
        return value


def source_path(value):
    path = absolute_path(value).resolve(strict=True)
    if not path.is_file() or path.suffix.lower() != ".pdf" or path.stat().st_size > MAX_SOURCE:
        fail("invalid_pdf")
    return path


@contextlib.contextmanager
def open_pdf(path):
    with pymupdf.open(str(path)) as doc:
        if not doc.is_pdf:
            fail("invalid_pdf")
        if doc.needs_pass or doc.is_encrypted or doc.metadata.get("encryption"):
            fail("pdf_encrypted_decrypt_first")
        if not 1 <= len(doc) <= MAX_PAGES:
            fail("page_limit")
        yield doc


def fingerprint(path):
    digest = hashlib.sha256()
    total = 0
    with path.open("rb") as handle:
        while True:
            data = handle.read(MIB)
            if not data:
                return digest.hexdigest()
            total += len(data)
            if total > MAX_SOURCE:
                fail("source_limit")
            digest.update(data)


def extract_pages(source, start, end):
    with pymupdf.open() as part:
        part.insert_pdf(source, from_page=start, to_page=end - 1)
        return part.tobytes(garbage=4, deflate=True, no_new_id=True)


def split_pdf(source, max_pages=20, max_bytes=MAX_CHUNK):
    if not 1 <= max_pages <= 20 or not 0 < max_bytes <= MAX_CHUNK:
        fail("invalid_chunk_limits")

    def split(start, end):
        data = extract_pages(source, start, end)
        if len(data) <= max_bytes:
            yield start, end, data
        elif end - start > 1:
            del data
            middle = (start + end) // 2
            yield from split(start, middle)
            yield from split(middle, end)
        else:
            fail("single_page_too_large")

    for start in range(0, len(source), max_pages):
        yield from split(start, min(start + max_pages, len(source)))


def request_json(session, url, data, files=None):
    for attempt in range(4):
        retry_delay = min(2 ** (attempt + 1), 30)
        try:
            deadline = time.monotonic() + REQUEST_TIMEOUT
            with session.post(url, data=data, files=files, timeout=(15, REQUEST_TIMEOUT),
                              allow_redirects=False, stream=True) as response:
                status = response.status_code
                if 300 <= status < 400:
                    fail("redirect_rejected")
                if status in RETRY_STATUSES:
                    header = response.headers.get("Retry-After", "")
                    if re.fullmatch(r"[0-9]{1,6}", header):
                        retry_delay = min(int(header), 60)
                elif not 200 <= status < 300:
                    fail("http_rejected")
                else:
                    size = response.headers.get("Content-Length", "")
                    if size.isdigit() and (len(size) > 12 or int(size) > MAX_RESPONSE):
                        fail("response_limit")
                    raw = bytearray()
                    for block in response.iter_content(65536):
                        if time.monotonic() > deadline:
                            fail("request_deadline")
                        if len(raw) + len(block) > MAX_RESPONSE:
                            fail("response_limit")
                        raw.extend(block)
                    try:
                        payload = json.loads(raw)
                    except (ValueError, RecursionError):
                        fail("invalid_response")
                    if not isinstance(payload, dict) or type(payload.get("code")) is not int or payload["code"] != 0:
                        fail("service_rejected")
                    if not isinstance(payload.get("data"), dict):
                        fail("invalid_response")
                    return payload["data"]
        except (requests.ConnectionError, requests.Timeout):
            pass
        if attempt == 3:
            fail("request_failed")
        time.sleep(retry_delay)


def read_result(data, count):
    result = data.get("result")
    outputs = result.get("outputs") if isinstance(result, dict) else None
    if not isinstance(outputs, dict) or not isinstance(outputs.get("markdown"), str):
        fail("incomplete_result")
    markdown = outputs["markdown"]
    if len(markdown.encode("utf-8")) > MAX_MARKDOWN:
        fail("markdown_limit")
    layout = outputs.get("json")
    if isinstance(layout, str):
        if len(layout.encode("utf-8")) > MAX_PAGE_MAP:
            fail("page_map_limit")
        try:
            layout = json.loads(layout)
        except (ValueError, RecursionError):
            fail("invalid_layout")
    # Bound JSON supplied as an object as well as the string form. This also
    # applies to completed caches, which re-enter through this same validator.
    page_json(layout)
    pages = layout.get("pages") if isinstance(layout, dict) else None
    if not isinstance(pages, list) or len(pages) != count:
        fail("incomplete_layout")
    normalized = []
    seen = set()
    block_count = 0
    content_size = 0
    for page in pages:
        if not isinstance(page, dict):
            fail("invalid_layout")
        number, size, blocks = page.get("page_num"), page.get("page_size"), page.get("blocks")
        if type(number) is not int or not 0 <= number < count or number in seen:
            fail("incomplete_layout")
        seen.add(number)
        if not isinstance(size, dict) or not isinstance(blocks, list) or len(blocks) > 10000:
            fail("invalid_layout")
        width, height = size.get("w"), size.get("h")
        if not all(type(v) in (int, float) and math.isfinite(v) and 0 < v <= 1e9 for v in (width, height)):
            fail("invalid_layout")
        clean = []
        block_count += len(blocks)
        if block_count > MAX_BLOCKS:
            fail("layout_limit")
        for block in blocks:
            if not isinstance(block, dict):
                fail("invalid_layout")
            box = block.get("bbox")
            kind = block.get("type")
            if not isinstance(box, list) or len(box) != 4 or not all(type(v) in (int, float) and math.isfinite(v) for v in box):
                fail("invalid_layout")
            x1, y1, x2, y2 = box
            if x1 >= x2 or y1 >= y2 or max(0, x1) >= min(width, x2) or max(0, y1) >= min(height, y2):
                fail("invalid_layout")
            # Keep only layout/recognition fields, never arbitrary service
            # metadata. Missing/invalid fields stay absent across cache replay;
            # page_markdown rejects the whole page rather than dropping a block.
            item = {"bbox": box}
            if isinstance(kind, str):
                item["type"] = kind[:64]
            if type(block.get("idx")) is int and block["idx"] >= 0:
                item["idx"] = block["idx"]
            if isinstance(block.get("format"), str) and block["format"] in BLOCK_FORMATS:
                item["format"] = block["format"]
            if isinstance(block.get("content"), str):
                content_size += len(block["content"].encode("utf-8"))
                if content_size > MAX_PAGE_MAP:
                    fail("page_content_limit")
                item["content"] = block["content"]
            clean.append(item)
        normalized.append({"page_num": number, "page_size": {"w": width, "h": height}, "blocks": clean})
    return markdown, sorted(normalized, key=lambda page: page["page_num"])


def page_json(value):
    """Compact UTF-8 JSON, bounded including escapes, keys and separators."""
    data = bytearray()
    try:
        encoder = json.JSONEncoder(ensure_ascii=False, separators=(",", ":"), allow_nan=False)
        for part in encoder.iterencode(value):
            encoded = part.encode("utf-8")
            if len(data) + len(encoded) > MAX_PAGE_MAP:
                fail("page_map_limit")
            data.extend(encoded)
    except (ValueError, TypeError, RecursionError, UnicodeError):
        fail("invalid_layout")
    return bytes(data)


def page_markdown(page):
    """Independent recognition preview; never slice the document Markdown.

    The layout retains service array order for its existing arrows/labels. Only
    this preview uses the official per-page idx ordering. All content is data.
    """
    blocks = page.get("blocks") if isinstance(page, dict) else None
    if not isinstance(blocks, list):
        return None
    seen = set()
    content_size = 0
    for block in blocks:
        if not isinstance(block, dict):
            return None
        index = block.get("idx")
        if (type(index) is not int or index < 0 or index in seen
                or not isinstance(block.get("content"), str)
                or not isinstance(block.get("type"), str)
                or not isinstance(block.get("format"), str)
                or block["format"] not in BLOCK_FORMATS):
            return None
        seen.add(index)
        content_size += len(block["content"].encode("utf-8"))
        if content_size > MAX_PAGE_MAP:
            fail("page_content_limit")
    parts = []
    total = 0
    for block in sorted(blocks, key=lambda item: item["idx"]):
        content = block["content"]
        if block["type"] == "Title":
            content = "# " + content
        elif block["type"] == "Formula":
            content = content.strip()
            for opening, closing in (("$$", "$$"), (r"\[", r"\]"), (r"\(", r"\)"), ("$", "$")):
                if (len(content) >= len(opening) + len(closing)
                        and content.startswith(opening) and content.endswith(closing)
                        and (opening != "$" or not (content.startswith("$$") or content.endswith("$$")))):
                    content = content[len(opening):-len(closing)].strip()
                    break
            content = "$$\n" + content + "\n$$"
        elif block["type"] == "Code Block" and not fenced_code(content):
            # Longer than every run, even embedded non-line-start runs, so an
            # untrusted code block cannot terminate our generated fence early.
            length = max((len(match[0]) for match in re.finditer(r"`+", content)), default=0)
            fence = "`" * max(3, length + 1)
            content = fence + "\n" + content + "\n" + fence
        total += len(content.encode("utf-8")) + (2 if parts else 0)
        if total > MAX_PAGE_MAP:
            fail("page_content_limit")
        parts.append(content)
    return "\n\n".join(parts)


def fenced_code(content):
    lines = content.strip().splitlines()
    if len(lines) < 2:
        return False
    opening = re.fullmatch(r" {0,3}(`{3,}|~{3,})([^\r\n]*)", lines[0])
    if not opening or (opening[1][0] == "`" and "`" in opening[2]):
        return False
    closing = r" {0,3}" + re.escape(opening[1][0]) + "{" + str(len(opening[1])) + r",}[ \t]*"
    for index, line in enumerate(lines[1:], 1):
        if re.fullmatch(closing, line):
            return index == len(lines) - 1
    return False


def write_page_map(output, pages, source_hash, markdown_hash):
    previews = []
    total = 0
    for page in pages:
        preview = page_markdown(page)
        if preview is not None:
            total += len(preview.encode("utf-8"))
            if total > MAX_PAGE_MAP:
                fail("page_content_limit")
        previews.append(preview)
    data = page_json({"schema": 1, "sourceHash": source_hash, "markdownHash": markdown_hash,
                      "pageCount": len(pages), "pages": previews})
    name = "pages-" + hashlib.sha256(data).hexdigest() + ".json"
    output.write(name, data)
    return name


def no_progress(_frame):
    pass


def chunk_progress(progress, start, end, status):
    progress({"type": "progress", "phase": "chunk", "start": start + 1, "end": end, "status": status})


def parse_chunk(session, chunk, base, output, source_hash, progress=no_progress):
    start, end, _ = chunk
    try:
        return _parse_chunk(session, chunk, base, output, source_hash, progress)
    except Exception:
        chunk_progress(progress, start, end, "failed")
        raise


def _parse_chunk(session, chunk, base, output, source_hash, progress):
    start, end, pdf = chunk
    options = {"baseURL": base, "image": "base64", "formula": "latex", "table": "html",
               "keep_header_footer": False, "formats": ["markdown", "json"], "version": 2,
               "source": source_hash, "start": start, "end": end}
    digest = hashlib.sha256(pdf + json.dumps(options, sort_keys=True).encode()).hexdigest()
    name = "cache/" + digest + ".json"
    state = output.cache_read(name)
    if "markdown" in state:
        result = read_result({"result": {"outputs": {"markdown": state["markdown"],
                             "json": {"pages": state.get("layout_pages")}}}}, end - start)
        chunk_progress(progress, start, end, "complete")
        return result
    task = state.get("task_id")
    if state and not valid_task(task):
        fail("invalid_cache")
    if not task:
        chunk_progress(progress, start, end, "uploading")
        data = request_json(session, base + "/parse/async", {
            "api_key": "dummy", "output_formats": ["markdown", "json"],
            "element_formats": json.dumps({"image": "base64", "formula": "latex", "table": "html"}),
            "feature_config": json.dumps({"keep_header_footer": False}),
        }, files={"file": ("pages.pdf", pdf, "application/pdf")})
        task = data.get("task_id")
        if not valid_task(task):
            fail("invalid_task")
        chunk_progress(progress, start, end, "submitted")
        output.cache_write(name, {"task_id": task})
    else:
        # A resumed task is awaiting its first observed remote state too.
        chunk_progress(progress, start, end, "submitted")
    deadline = time.monotonic() + TASK_TIMEOUT
    previous_status = None
    while time.monotonic() < deadline:
        data = request_json(session, base + "/parse/async_check", {"api_key": "dummy", "task_id": task})
        raw = data.get("status")
        status = raw.strip().lower() if isinstance(raw, str) else None
        if status == "success":
            markdown, pages = read_result(data, end - start)
            output.cache_write(name, {"markdown": markdown, "layout_pages": pages})
            chunk_progress(progress, start, end, "complete")
            return markdown, pages
        if status == "failed":
            output.path(name).unlink()
            fail("remote_task_failed")
        if status not in {"queuing", "processing"}:
            fail("unknown_task_status")
        if status != previous_status:
            chunk_progress(progress, start, end, status)
            previous_status = status
        time.sleep(min(5, max(0, deadline - time.monotonic())))
    fail("task_timeout")


def valid_task(task):
    return isinstance(task, str) and 0 < len(task) <= 512 and all(ord(c) >= 32 and ord(c) != 127 for c in task)


def load_layout():
    # -I deliberately removes the script directory from sys.path. Load ONLY
    # the fixed bundled sibling, never a cwd/request-supplied Python module.
    path = Path(__file__).resolve().with_name("layout_pdf.py")
    spec = importlib.util.spec_from_file_location("spt_fulltext_layout", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def convert(request, progress=no_progress):
    base = base_url(request.get("baseURL"))
    source = source_path(request.get("sourcePath"))
    output = Output(request.get("outputDir"), source)
    before = fingerprint(source)
    pages = []
    total = 0
    blocks = 0
    content_size = 0
    markdown_hash = hashlib.sha256()
    with open_pdf(source) as doc:
        count = len(doc)
        progress({"type": "progress", "phase": "planning", "pageCount": count})
        output.prepare_cache()
        # Keep only page ranges between planning and upload.
        ranges = []
        for start, end, data in split_pdf(doc):
            ranges.append((start, end))
            del data
            chunk_progress(progress, start, end, "pending")
        progress({"type": "progress", "phase": "parsing"})
        with requests.Session() as session, output.staging("source.md") as (markdown_file, _):
            session.trust_env = False  # no inherited proxies/netrc credentials
            for start, end in ranges:
                try:
                    pdf = extract_pages(doc, start, end)
                    if len(pdf) > MAX_CHUNK:
                        fail("chunk_limit")
                except Exception:
                    chunk_progress(progress, start, end, "failed")
                    raise
                markdown, layout = parse_chunk(session, (start, end, pdf), base, output, before, progress)
                del pdf
                data = ("<!-- PDF pages {}-{} -->\n\n{}\n\n".format(start + 1, end, markdown.strip())).encode("utf-8")
                total += len(data)
                if total > MAX_MARKDOWN:
                    fail("markdown_limit")
                markdown_file.write(data)
                markdown_hash.update(data)
                content_size += sum(len(block.get("content", "").encode("utf-8"))
                                    for page in layout for block in page["blocks"])
                if content_size > MAX_PAGE_MAP:
                    fail("page_content_limit")
                blocks += sum(len(page["blocks"]) for page in layout)
                if blocks > MAX_BLOCKS:
                    fail("layout_limit")
                pages.extend(dict(page, page_num=start + page["page_num"]) for page in layout)
            if fingerprint(source) != before:
                fail("source_changed")
            progress({"type": "progress", "phase": "assembling"})
            with output.staging("layout.pdf") as (layout_handle, temporary):
                layout_handle.close()  # allow replace on Windows as well
                load_layout().write_layout_pdf(source, temporary, pages)
                if temporary.stat().st_size > MAX_SOURCE:
                    fail("layout_limit")
                with open_pdf(temporary) as result:
                    if len(result) != count:
                        fail("incomplete_layout")
                if fingerprint(source) != before:
                    fail("source_changed")
                # Commit the content-addressed map before either existing final
                # output. A map write failure must not replace source.md.
                page_map_file = write_page_map(output, pages, before, markdown_hash.hexdigest())
                if fingerprint(source) != before:
                    fail("source_changed")
    return {"ok": True, "markdownFile": "source.md", "layoutFile": "layout.pdf",
            "pageMapFile": page_map_file, "pageCount": count}


def preview(request):
    source = source_path(request.get("sourcePath"))
    output = Output(request.get("outputDir"), source)
    number = request.get("page")
    before = fingerprint(source)
    with open_pdf(source) as doc:
        count = len(doc)
        if type(number) is not int or not 1 <= number <= count:
            fail("invalid_page")
        page = doc[number - 1]
        width, height = page.rect.width, page.rect.height
        if not all(math.isfinite(v) and v > 0 for v in (width, height)):
            fail("invalid_page_size")
        scale = min(2, 2399 / max(width, height), math.sqrt(7990000 / (width * height)))
        pixmap = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), colorspace=pymupdf.csRGB, alpha=False)
        if pixmap.width * pixmap.height > 8000000 or max(pixmap.width, pixmap.height) > 2400:
            fail("preview_limit")
        data = pixmap.tobytes("png")
        if len(data) > 32 * MIB:
            fail("preview_limit")
        if fingerprint(source) != before:
            fail("source_changed")
        output.write("preview.png", data)
    return {"ok": True, "imageFile": "preview.png", "pageCount": count, "page": number}


def dispatch(operation, request, progress=no_progress):
    fields = {"check": set(), "convert": {"sourcePath", "outputDir", "baseURL"},
              "preview": {"sourcePath", "outputDir", "page"}}
    if operation not in fields or not isinstance(request, dict) or set(request) != fields[operation]:
        fail("invalid_request")
    load_dependencies(network=operation != "preview")
    if operation == "check":
        return {"ok": True, "python": ".".join(map(str, sys.version_info[:3])),
                "pymupdf": pymupdf.VersionBind, "requests": requests.__version__}
    return convert(request, progress) if operation == "convert" else preview(request)


@contextlib.contextmanager
def quiet_libraries():
    # Native MuPDF warnings may bypass Python's redirect_stdout. Suppress both
    # descriptors during dependency loading/processing; emit our fixed JSON only.
    sys.stdout.flush()
    sys.stderr.flush()
    saved = [os.dup(1), os.dup(2)]
    try:
        # Keep a private protocol stream on the original stdout descriptor.
        # Progress bypasses library suppression without exposing native noise.
        with os.fdopen(os.dup(saved[0]), "w", encoding="utf-8") as protocol, \
                open(os.devnull, "w") as sink, contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
            os.dup2(sink.fileno(), 1)
            os.dup2(sink.fileno(), 2)
            yield protocol
    finally:
        for target, descriptor in zip((1, 2), saved):
            os.dup2(descriptor, target)
            os.close(descriptor)


def cancelled(_signum, _frame):
    fail("cancelled")


def main(argv=None):
    args = sys.argv[1:] if argv is None else argv
    result = None
    code = None
    signal.signal(signal.SIGTERM, cancelled)
    signal.signal(signal.SIGINT, cancelled)
    try:
        with quiet_libraries() as protocol:
            def emit_progress(frame):
                protocol.write(json.dumps(frame, ensure_ascii=True, separators=(",", ":")) + "\n")
                protocol.flush()

            if len(args) != 2 or len(args[1].encode("utf-8")) > 65536:
                fail("invalid_request")
            try:
                request = json.loads(args[1])
            except (ValueError, RecursionError):
                fail("invalid_request")
            result = dispatch(args[0], request, emit_progress)
    except WorkerError as error:
        code = error.args[0]
    except BaseException:
        # Never print exception text, URLs, task IDs, paths or service responses.
        code = "worker_failed"
    if code:
        result = {"ok": False, "error": code}
        sys.stderr.write("fulltext: " + code + "\n")
    sys.stdout.write(json.dumps(result, ensure_ascii=True, separators=(",", ":")) + "\n")
    sys.stdout.flush()
    return 1 if code else 0


if __name__ == "__main__":
    sys.exit(main())
