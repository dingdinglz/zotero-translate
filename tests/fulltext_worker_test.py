"""Offline worker regressions. Run with an existing Python containing PyMuPDF/requests.
No tests install dependencies, contact OXR, or touch Zotero data.
SPT_TEST_FULLTEXT_PROGRESS_ONLY=1 runs dependency-free progress/page-map tests.
"""
import contextlib
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import selectors
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
WORKER = ROOT / "plugin/content/fulltext-python/worker.py"
spec = importlib.util.spec_from_file_location("fulltext_worker", WORKER.with_name("pdf_to_markdown.py"))
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
PROGRESS_ONLY = os.environ.get("SPT_TEST_FULLTEXT_PROGRESS_ONLY") == "1"
if not PROGRESS_ONLY:
    worker.load_dependencies(network=True)
fitz = worker.pymupdf


def layout_page(number, blocks=None):
    return {"page_num": number, "page_size": {"w": 612, "h": 792}, "blocks": blocks or []}


def recognition_block(index=0, content="正文 α", kind="Text", format="text", **extra):
    return {"bbox": [1, 1, 200, 50], "idx": index, "type": kind,
            "content": content, "format": format, **extra}


def success(count=1, markdown="Paper α", pages=None):
    return {"status": "SUCCESS", "result": {"outputs": {"markdown": markdown,
            "json": {"pages": [layout_page(i) for i in range(count)] if pages is None else pages}}}}


class Response:
    def __init__(self, data=None, status=200, headers=None, chunks=None):
        self.status_code = status
        self.headers = headers or {}
        self.content = json.dumps({"code": 0, "data": data or {}}, ensure_ascii=False).encode()
        self.chunks = chunks
        self.closed = False

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.closed = True

    def iter_content(self, size):
        return iter(self.chunks if self.chunks is not None else [self.content])


@unittest.skipIf(PROGRESS_ONLY, "Explicit progress-only run; PDF/dependency suite not selected")
class WorkerTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.source = self.root / "paper.pdf"
        self.output = self.root / "out"
        self.output.mkdir()
        self.make_pdf(1)
        self.before = self.source.read_bytes()
        self.request = {"sourcePath": str(self.source), "outputDir": str(self.output),
                        "baseURL": "https://free-oxr.somark.ai/api/v1"}
        # A fail-closed tripwire for every test, including dependency checks.
        self.network = mock.patch.object(worker.requests.sessions.Session, "request",
                                         side_effect=AssertionError("Real HTTP forbidden"))
        self.network.start()
        self.addCleanup(self.network.stop)

    def make_pdf(self, count, **kwargs):
        with fitz.open() as document:
            for i in range(count):
                page = document.new_page(width=612, height=792)
                page.insert_text((20, 30), "Synthetic paper page {}".format(i + 1))
            document.save(self.source, **kwargs)

    def store(self):
        output = worker.Output(str(self.output), self.source)
        output.prepare_cache()
        return output

    def session(self, results):
        session = mock.MagicMock()
        session.__enter__.return_value = session
        session.post.side_effect = results
        return session

    def convert_with(self, results):
        session = self.session(results)
        with mock.patch.object(worker.requests, "Session", return_value=session), mock.patch.object(worker.time, "sleep"):
            result = worker.convert(self.request)
        return result, session

    def cli(self, operation, request):
        return subprocess.run([sys.executable, "-I", str(WORKER), operation, json.dumps(request)],
                              capture_output=True, text=True, timeout=30)

    def test_check_protocol_and_versions(self):
        result = self.cli("check", {})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, "")
        self.assertEqual(len(result.stdout.splitlines()), 1)
        data = json.loads(result.stdout)
        self.assertEqual(set(data), {"ok", "python", "pymupdf", "requests"})
        self.assertTrue(data["ok"])
        self.assertLess(len(result.stdout), 1024)

    def test_protocol_rejects_unknown_operation_and_extra_fields(self):
        for operation, request in [("secret", {}), ("check", {"key": "SECRET"}), ("preview", [])]:
            with self.subTest(operation=operation):
                result = self.cli(operation, request)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(json.loads(result.stdout), {"ok": False, "error": "invalid_request"})
                self.assertEqual(result.stderr, "fulltext: invalid_request\n")
                self.assertNotIn("SECRET", result.stdout + result.stderr)

    def test_malformed_json_is_bounded(self):
        result = subprocess.run([sys.executable, "-I", str(WORKER), "convert", "SECRET{{"],
                                capture_output=True, text=True, timeout=30)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(json.loads(result.stdout)["error"], "invalid_request")
        self.assertNotIn("SECRET", result.stderr)

    def test_preview_cli_atomic_png_and_source_unchanged(self):
        result = self.cli("preview", {"sourcePath": str(self.source), "outputDir": str(self.output), "page": 1})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {"ok": True, "imageFile": "preview.png", "pageCount": 1, "page": 1})
        data = (self.output / "preview.png").read_bytes()
        self.assertTrue(data.startswith(b"\x89PNG\r\n\x1a\n"))
        pix = fitz.Pixmap(data)
        self.assertLessEqual(max(pix.width, pix.height), 2400)
        self.assertLessEqual(pix.width * pix.height, 8000000)
        self.assertEqual(self.source.read_bytes(), self.before)
        self.assertEqual(sorted(p.name for p in self.output.iterdir()), ["preview.png"])

    def test_preview_does_not_import_requests(self):
        import builtins
        original = builtins.__import__

        def guarded(name, *args, **kwargs):
            if name == "requests":
                raise AssertionError("preview imported requests")
            return original(name, *args, **kwargs)

        with mock.patch("builtins.__import__", side_effect=guarded):
            result = worker.dispatch("preview", {"sourcePath": str(self.source), "outputDir": str(self.output), "page": 1})
        self.assertTrue(result["ok"])

    def test_preview_large_page_and_page_bounds(self):
        self.source.unlink()
        with fitz.open() as doc:
            doc.new_page(width=20000, height=20000)
            doc.save(self.source)
        request = {"sourcePath": str(self.source), "outputDir": str(self.output), "page": 1}
        worker.preview(request)
        pix = fitz.Pixmap(str(self.output / "preview.png"))
        self.assertLessEqual(max(pix.width, pix.height), 2400)
        for page in (0, 2, -1, True, "1"):
            with self.subTest(page=page), self.assertRaisesRegex(worker.WorkerError, "invalid_page"):
                worker.preview(dict(request, page=page))

    def test_check_dependency_version_and_capability_rejection(self):
        with mock.patch.object(fitz, "VersionBind", "1.24.3"), self.assertRaisesRegex(worker.WorkerError, "pymupdf_version"):
            worker.load_dependencies()
        with mock.patch.object(fitz, "open", side_effect=ValueError("SECRET")), self.assertRaisesRegex(worker.WorkerError, "pymupdf_capability"):
            worker.load_dependencies()

    def test_only_pdf_and_encryption_rejected(self):
        image = self.root / "fake.pdf"
        image.write_bytes(b"not a PDF")
        result = self.cli("preview", {"sourcePath": str(image), "outputDir": str(self.output), "page": 1})
        self.assertNotEqual(result.returncode, 0)
        self.assertLess(len(result.stderr), 100)
        self.source.unlink()
        self.make_pdf(1, encryption=fitz.PDF_ENCRYPT_AES_256, owner_pw="owner", user_pw="password")
        with self.assertRaisesRegex(worker.WorkerError, "pdf_encrypted_decrypt_first"):
            worker.convert(self.request)
        self.assertFalse((self.output / "cache").exists())

    def test_empty_password_encryption_rejected(self):
        self.source.unlink()
        self.make_pdf(1, encryption=fitz.PDF_ENCRYPT_AES_256, owner_pw="owner", user_pw="")
        with self.assertRaisesRegex(worker.WorkerError, "pdf_encrypted_decrypt_first"):
            worker.convert(self.request)

    def test_split_default_order_and_page_limit(self):
        self.source.unlink()
        self.make_pdf(43)
        with fitz.open(self.source) as source:
            chunks = list(worker.split_pdf(source))
        self.assertEqual([(a, b) for a, b, _ in chunks], [(0, 20), (20, 40), (40, 43)])
        for start, end, data in chunks:
            with fitz.open(stream=data, filetype="pdf") as part:
                self.assertEqual(len(part), end - start)
                self.assertIn(str(start + 1), part[0].get_text())
            self.assertLessEqual(len(data), 9500000)

    def test_recursive_byte_limit_and_single_page_no_loss(self):
        def extract(_source, start, end):
            return b"x" * (end - start) * 10
        with mock.patch.object(worker, "extract_pages", side_effect=extract):
            self.assertEqual([(a, b) for a, b, _ in worker.split_pdf(range(5), max_bytes=21)],
                             [(0, 2), (2, 3), (3, 5)])
            with self.assertRaisesRegex(worker.WorkerError, "single_page_too_large"):
                list(worker.split_pdf(range(1), max_bytes=9))

    def test_convert_full_layout_and_offline_completed_cache(self):
        blocks = [{"type": "text", "bbox": [10, 10, 200, 50]}]
        result, session = self.convert_with([Response({"task_id": "../../REMOTE_SECRET"}),
                                             Response(success(pages=[layout_page(0, blocks)]))])
        page_map = (self.output / result["pageMapFile"]).read_bytes()
        self.assertEqual(result, {"ok": True, "markdownFile": "source.md", "layoutFile": "layout.pdf",
                                 "pageMapFile": "pages-" + hashlib.sha256(page_map).hexdigest() + ".json", "pageCount": 1})
        self.assertEqual(json.loads(page_map)["pages"], [None])
        self.assertFalse(session.trust_env)
        self.assertEqual(self.source.read_bytes(), self.before)
        with fitz.open(self.output / "layout.pdf") as layout:
            self.assertEqual(len(layout), 1)
            self.assertIn("Synthetic paper", layout[0].get_text())
            self.assertIn("OXR Layout", str(layout.get_ocgs()))
        files = list((self.output / "cache").iterdir())
        self.assertEqual(len(files), 1)
        self.assertRegex(files[0].name, r"^[a-f0-9]{64}\.json$")
        self.assertNotIn("REMOTE_SECRET", files[0].read_text())
        second, offline = self.convert_with([])
        self.assertEqual(second, result)
        offline.post.assert_not_called()
        options = session.post.call_args_list[0].kwargs
        self.assertFalse(options["allow_redirects"])
        self.assertTrue(options["stream"])
        self.assertEqual(options["timeout"], (15, 120))
        self.assertEqual(json.loads(options["data"]["element_formats"]), {"image": "base64", "formula": "latex", "table": "html"})

    def test_reextracted_bytes_preserve_direct_parse_cache_keys(self):
        self.source.unlink()
        self.make_pdf(21)
        output = self.store()
        source_hash = worker.fingerprint(self.source)
        with fitz.open(self.source) as document:
            for start, end, data in worker.split_pdf(document):
                session = self.session([Response({"task_id": "old"}), Response(success(end - start))])
                worker.parse_chunk(session, (start, end, data), self.request["baseURL"], output, source_hash)
        frames = []
        session = self.session([])
        with mock.patch.object(worker.requests, "Session", return_value=session):
            worker.convert(self.request, frames.append)
        session.post.assert_not_called()
        self.assertEqual([f["status"] for f in frames if f["phase"] == "chunk"],
                         ["pending", "pending", "complete", "complete"])

    def test_pending_task_resume_does_not_resubmit(self):
        with self.assertRaisesRegex(worker.WorkerError, "unknown_task_status"):
            self.convert_with([Response({"task_id": "TASK_SECRET"}), Response({"status": "UNKNOWN_SECRET"})])
        self.assertFalse((self.output / "source.md").exists())
        result, session = self.convert_with([Response(success())])
        self.assertTrue(result["ok"])
        self.assertEqual(session.post.call_count, 1)
        self.assertTrue(session.post.call_args.args[0].endswith("/parse/async_check"))
        self.assertEqual(session.post.call_args.kwargs["data"]["task_id"], "TASK_SECRET")

    def test_changed_base_url_and_source_invalidate_cache(self):
        self.convert_with([Response({"task_id": "one"}), Response(success())])
        self.request["baseURL"] = "https://other.example/api/v1"
        _, session = self.convert_with([Response({"task_id": "two"}), Response(success())])
        self.assertEqual(session.post.call_count, 2)
        self.source.unlink()
        self.make_pdf(2)
        _, session = self.convert_with([Response({"task_id": "three"}), Response(success(2))])
        self.assertEqual(session.post.call_count, 2)
        self.assertEqual(len(list((self.output / "cache").iterdir())), 3)

    def test_convert_chunk_order_and_complete_layout(self):
        self.source.unlink()
        self.make_pdf(21)
        result, session = self.convert_with([Response({"task_id": "first"}),
            Response(success(20, "FIRST", list(reversed([layout_page(i) for i in range(20)])))),
            Response({"task_id": "second"}), Response(success(1, "SECOND"))])
        self.assertEqual(result["pageCount"], 21)
        text = (self.output / "source.md").read_text()
        self.assertLess(text.index("FIRST"), text.index("SECOND"))
        self.assertIn("PDF pages 1-20", text)
        self.assertIn("PDF pages 21-21", text)
        with fitz.open(self.output / "layout.pdf") as doc:
            self.assertEqual(len(doc), 21)
        self.assertEqual(session.post.call_count, 4)

    def test_incomplete_result_preserves_existing_outputs(self):
        (self.output / "source.md").write_text("old markdown")
        (self.output / "layout.pdf").write_bytes(b"old layout")
        with self.assertRaisesRegex(worker.WorkerError, "incomplete_layout"):
            self.convert_with([Response({"task_id": "one"}), Response(success(pages=[]))])
        self.assertEqual((self.output / "source.md").read_text(), "old markdown")
        self.assertEqual((self.output / "layout.pdf").read_bytes(), b"old layout")
        self.assertFalse(any(p.name.startswith(".spt-") for p in self.output.iterdir()))

    def test_failed_task_removed_but_no_partial_output(self):
        with self.assertRaisesRegex(worker.WorkerError, "remote_task_failed"):
            self.convert_with([Response({"task_id": "one"}), Response({"status": "FAILED", "error": "SECRET"})])
        self.assertEqual(list((self.output / "cache").iterdir()), [])
        self.assertFalse((self.output / "source.md").exists())

    def test_queue_processing_and_timeout(self):
        _, session = self.convert_with([Response({"task_id": "one"}), Response({"status": " QUEUING "}),
                                        Response({"status": "processing"}), Response(success())])
        self.assertEqual(session.post.call_count, 4)
        self.request["baseURL"] = "https://another.example"
        with mock.patch.object(worker, "TASK_TIMEOUT", 0), self.assertRaisesRegex(worker.WorkerError, "task_timeout"):
            self.convert_with([Response({"task_id": "pending"})])

    def test_layout_duplicate_missing_outside_and_nonfinite_rejected(self):
        invalid = [success(2, pages=[layout_page(0), layout_page(0)]),
                   success(2, pages=[layout_page(0)]),
                   success(pages=[layout_page(1)]),
                   success(pages=[layout_page(0, [{"bbox": [700, 2, 800, 20]}])]),
                   success(pages=[layout_page(0, [{"bbox": [0, 0, float("inf"), 20]}])]),
                   success(pages=[layout_page(0, [{"bbox": [20, 0, 10, 20]}])])]
        for index, data in enumerate(invalid):
            with self.subTest(index=index), self.assertRaises(worker.WorkerError):
                worker.read_result(data, 2 if index < 2 else 1)
        md, pages = worker.read_result(success(markdown=""), 1)
        self.assertEqual(md, "")
        self.assertEqual(len(pages), 1)

    def test_response_bytes_limit_and_http_status(self):
        session = self.session([Response(headers={"Content-Length": str(worker.MAX_RESPONSE + 1)})])
        with self.assertRaisesRegex(worker.WorkerError, "response_limit"):
            worker.request_json(session, "https://example.invalid", {})
        with mock.patch.object(worker, "MAX_RESPONSE", 4):
            session = self.session([Response(chunks=[b"123", b"45"])])
            with self.assertRaisesRegex(worker.WorkerError, "response_limit"):
                worker.request_json(session, "https://example.invalid", {})
        for status, error in [(301, "redirect_rejected"), (302, "redirect_rejected"), (307, "redirect_rejected"), (401, "http_rejected")]:
            with self.subTest(status=status), self.assertRaisesRegex(worker.WorkerError, error):
                worker.request_json(self.session([Response(status=status, headers={"Location": "https://evil.invalid"})]),
                                    "https://example.invalid", {})

    def test_rate_limit_retry_is_bounded_and_response_closed(self):
        responses = [Response(status=429, headers={"Retry-After": "999999"}) for _ in range(4)]
        session = self.session(responses)
        with mock.patch.object(worker.time, "sleep") as sleep, self.assertRaisesRegex(worker.WorkerError, "request_failed"):
            worker.request_json(session, "https://example.invalid", {})
        self.assertEqual(session.post.call_count, 4)
        self.assertEqual(sleep.call_args_list, [mock.call(60)] * 3)
        self.assertTrue(all(response.closed for response in responses))
        session = self.session([Response(status=503), Response({"task_id": "ok"})])
        with mock.patch.object(worker.time, "sleep"):
            self.assertEqual(worker.request_json(session, "https://example.invalid", {}), {"task_id": "ok"})

    def test_connection_timeout_retry_and_stream_deadline(self):
        session = self.session([worker.requests.Timeout("SECRET")] * 4)
        with mock.patch.object(worker.time, "sleep"), self.assertRaisesRegex(worker.WorkerError, "request_failed"):
            worker.request_json(session, "https://example.invalid", {})
        self.assertEqual(session.post.call_count, 4)
        with mock.patch.object(worker.time, "monotonic", side_effect=[0, 121]), self.assertRaisesRegex(worker.WorkerError, "request_deadline"):
            worker.request_json(self.session([Response()]), "https://example.invalid", {})

    def test_invalid_response_no_secret_diagnostics(self):
        cases = [b"SECRET not JSON", b"[]", b'{"code":true,"data":{}}', b'{"code":7,"message":"SECRET"}', b'{"code":0,"data":[]}']
        for raw in cases:
            with self.subTest(raw=raw), self.assertRaises(worker.WorkerError) as caught:
                worker.request_json(self.session([Response(chunks=[raw])]), "https://example.invalid", {})
            self.assertNotIn("SECRET", str(caught.exception))

    def test_base_url_validation(self):
        for url in ["https://example.org/api/v1/", "http://localhost:8080/api", "http://127.0.0.1:80", "http://[::1]/api"]:
            self.assertEqual(worker.base_url(url), url.rstrip("/"))
        for url in ["http://example.org", "http://127.1", "https://user:pass@example.org", "https://example.org?x=secret",
                    "https://example.org#secret", "file:///tmp/test", "https://example.org?", "https://example.org#",
                    "https://example.org\\@evil.org", "https://example.org:999999", "https://example.org/a/../b", " https://example.org"]:
            with self.subTest(url=url), self.assertRaisesRegex(worker.WorkerError, "invalid_base_url"):
                worker.base_url(url)

    def test_output_symlink_hardlink_and_ancestor_escape(self):
        target = self.output / "layout.pdf"
        target.symlink_to(self.source)
        with self.assertRaises(worker.WorkerError):
            worker.Output(str(self.output), self.source)
        target.unlink()
        os.link(self.source, target)
        with self.assertRaises(worker.WorkerError):
            worker.Output(str(self.output), self.source)
        target.unlink()
        alias = self.root / "alias"
        alias.symlink_to(self.output, target_is_directory=True)
        with self.assertRaisesRegex(worker.WorkerError, "symlink_path"):
            worker.Output(str(alias), self.source)
        with self.assertRaisesRegex(worker.WorkerError, "invalid_path"):
            worker.Output(str(self.output / ".." / "out"), self.source)
        self.assertEqual(self.source.read_bytes(), self.before)

    def test_fixed_destination_cannot_be_source(self):
        source = self.output / "layout.pdf"
        source.write_bytes(self.before)
        with self.assertRaisesRegex(worker.WorkerError, "source_alias"):
            worker.Output(str(self.output), source)
        self.assertEqual(source.read_bytes(), self.before)

    def test_cache_symlink_names_size_and_corruption(self):
        store = self.store()
        name = "cache/" + "a" * 64 + ".json"
        with self.assertRaisesRegex(worker.WorkerError, "invalid_output_name"):
            store.write("../outside", b"bad")
        path = store.path(name)
        path.symlink_to(self.source)
        with self.assertRaises(worker.WorkerError):
            store.cache_read(name)
        path.unlink()
        path.write_bytes(b"bad JSON SECRET")
        with self.assertRaisesRegex(worker.WorkerError, "invalid_cache"):
            store.cache_read(name)
        with mock.patch.object(worker, "MAX_RESPONSE", 2), self.assertRaisesRegex(worker.WorkerError, "cache_limit"):
            store.cache_read(name)
        path.unlink()
        with mock.patch.object(worker, "MAX_CACHE", 2), self.assertRaisesRegex(worker.WorkerError, "cache_limit"):
            store.cache_write(name, {"markdown": "hello"})

    def test_markdown_aggregate_limit_preserves_old_output(self):
        (self.output / "source.md").write_text("old")
        with mock.patch.object(worker, "MAX_MARKDOWN", 10), self.assertRaisesRegex(worker.WorkerError, "markdown_limit"):
            self.convert_with([Response({"task_id": "one"}), Response(success(markdown="12345"))])
        self.assertEqual((self.output / "source.md").read_text(), "old")
        self.assertFalse((self.output / "layout.pdf").exists())

    def test_atomic_write_failure_preserves_target(self):
        store = self.store()
        target = self.output / "source.md"
        target.write_text("old")
        with mock.patch.object(worker.os, "replace", side_effect=OSError("SECRET")), self.assertRaises(OSError):
            store.write("source.md", b"new")
        self.assertEqual(target.read_text(), "old")
        self.assertFalse(any(p.name.startswith(".spt-") for p in self.output.iterdir()))

    def test_source_change_prevents_final_outputs(self):
        with mock.patch.object(worker, "fingerprint", side_effect=["before", "after"]), self.assertRaisesRegex(worker.WorkerError, "source_changed"):
            self.convert_with([Response({"task_id": "one"}), Response(success())])
        self.assertFalse((self.output / "source.md").exists())
        self.assertFalse((self.output / "layout.pdf").exists())

    def test_signal_cancellation_has_fixed_code(self):
        with self.assertRaisesRegex(worker.WorkerError, "cancelled"):
            worker.cancelled(15, None)

    def test_process_signal_and_native_noise_keep_json_protocol(self):
        program = '''
import importlib.util, os, signal, sys
spec = importlib.util.spec_from_file_location("core", sys.argv[1])
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
def dispatch(*args):
    print("SECRET PAPER")
    os.write(1, b"NATIVE SECRET\\n")
    os.write(2, b"SECRET TASK KEY\\n")
    if sys.argv[2] == "signal":
        os.kill(os.getpid(), signal.SIGTERM)
    raise RuntimeError("SECRET RESPONSE")
core.dispatch = dispatch
sys.exit(core.main(["check", "{}"]))
'''
        for mode, error in [("signal", "cancelled"), ("exception", "worker_failed")]:
            with self.subTest(mode=mode):
                result = subprocess.run([sys.executable, "-B", "-I", "-c", program,
                    str(WORKER.with_name("pdf_to_markdown.py")), mode], capture_output=True, text=True, timeout=10)
                self.assertEqual(result.returncode, 1)
                self.assertEqual(json.loads(result.stdout), {"ok": False, "error": error})
                self.assertEqual(len(result.stdout.splitlines()), 1)
                self.assertEqual(result.stderr, "fulltext: " + error + "\n")

    def test_interrupted_cache_write_cleanup_keeps_committed_state(self):
        store = self.store()
        name = "cache/" + "b" * 64 + ".json"
        store.cache_write(name, {"task_id": "pending"})
        temporary = store.cache / ".spt-abc123_x"
        temporary.write_bytes(b"partial SECRET")
        store.prepare_cache()
        self.assertFalse(temporary.exists())
        self.assertEqual(store.cache_read(name), {"task_id": "pending"})
        temporary.symlink_to(self.source)
        with self.assertRaisesRegex(worker.WorkerError, "invalid_cache"):
            store.prepare_cache()
        self.assertEqual(self.source.read_bytes(), self.before)

    def test_cancelled_cache_write_is_atomic(self):
        store = self.store()
        name = "cache/" + "c" * 64 + ".json"
        store.cache_write(name, {"task_id": "pending"})
        with mock.patch.object(worker.os, "replace", side_effect=worker.WorkerError("cancelled")), self.assertRaisesRegex(worker.WorkerError, "cancelled"):
            store.cache_write(name, {"markdown": "new result"})
        self.assertEqual(store.cache_read(name), {"task_id": "pending"})
        self.assertEqual(len(list(store.cache.iterdir())), 1)

    def test_invalid_cached_layout_is_not_used_or_resubmitted(self):
        self.convert_with([Response({"task_id": "one"}), Response(success())])
        cache = next((self.output / "cache").iterdir())
        cache.write_text(json.dumps({"markdown": "cached", "layout_pages": []}))
        session = self.session([])
        with mock.patch.object(worker.requests, "Session", return_value=session), self.assertRaisesRegex(worker.WorkerError, "incomplete_layout"):
            worker.convert(self.request)
        session.post.assert_not_called()

    def test_non_pdf_extension_is_rejected_before_open(self):
        image = self.root / "image.png"
        image.write_bytes(self.before)
        with self.assertRaisesRegex(worker.WorkerError, "invalid_pdf"):
            worker.source_path(str(image))

    def test_layout_resource_limit(self):
        data = success(pages=[layout_page(0, [{"type": "text", "bbox": [1, 1, 2, 2]}])])
        with mock.patch.object(worker, "MAX_BLOCKS", 0), self.assertRaisesRegex(worker.WorkerError, "layout_limit"):
            worker.read_result(data, 1)


class ProgressTest(unittest.TestCase):
    """Protocol/state tests run without third-party PDF or HTTP dependencies."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.source = self.root / "paper.pdf"
        self.source.write_bytes(b"%PDF-synthetic")
        self.output = self.root / "out"
        self.output.mkdir()
        self.request = {"sourcePath": str(self.source), "outputDir": str(self.output),
                        "baseURL": "https://example.invalid/api/v1"}
        self.frames = []
        self.store = worker.Output(str(self.output), self.source)
        self.store.prepare_cache()
        self.chunk = (0, 1, b"original PDF bytes")
        self.session = mock.MagicMock()
        self.session.__enter__.return_value = self.session
        # Every network entry is mocked and fails closed when responses run out.
        self.http = self.enter_patch(mock.patch.object(worker, "request_json"))
        self.http.side_effect = AssertionError("Real HTTP forbidden")
        self.enter_patch(mock.patch.object(worker.time, "sleep"))
        self.enter_patch(mock.patch.object(worker, "requests", mock.Mock(Session=mock.Mock(return_value=self.session))))

    def enter_patch(self, patch):
        value = patch.start()
        self.addCleanup(patch.stop)
        return value

    def frame(self, status, start=1, end=1):
        return {"type": "progress", "phase": "chunk", "start": start, "end": end, "status": status}

    def parse(self, responses):
        self.http.side_effect = responses
        return worker.parse_chunk(self.session, self.chunk, self.request["baseURL"],
                                  self.store, "source-hash", self.frames.append)

    def fake_pdf(self, count, extract=None):
        self.enter_patch(mock.patch.object(worker, "open_pdf", side_effect=lambda _: contextlib.nullcontext(range(count))))
        self.extract = self.enter_patch(mock.patch.object(worker, "extract_pages",
            side_effect=extract or (lambda _doc, start, end: bytes([start]) * (end - start))))

        def write_layout(_source, destination, pages):
            self.assertEqual(self.frames[-1], {"type": "progress", "phase": "assembling"})
            self.assertEqual([page["page_num"] for page in pages], list(range(count)))
            destination.write_bytes(b"%PDF-layout")

        self.enter_patch(mock.patch.object(worker, "load_layout", return_value=mock.Mock(write_layout_pdf=write_layout)))

    def test_page_preview_whitelist_order_and_no_document_slicing(self):
        blocks = [recognition_block(7, "  后段\n", remote_secret="discard", start_line=1),
                  recognition_block(2, "标题", "Title", "markdown")]
        data = success(markdown="Unrelated FULL document", pages=[layout_page(0, blocks)])
        markdown, pages = worker.read_result(data, 1)
        self.assertEqual(markdown, "Unrelated FULL document")
        self.assertEqual([b["idx"] for b in pages[0]["blocks"]], [7, 2])  # layout order unchanged
        self.assertEqual(set(pages[0]["blocks"][0]), {"idx", "type", "content", "format", "bbox"})
        self.assertEqual(worker.page_markdown(pages[0]), "# 标题\n\n  后段\n")
        self.assertEqual(worker.page_markdown(layout_page(0)), "")
        self.assertIsNone(worker.page_markdown({}))
        self.assertNotIn("remote_secret", json.dumps(pages))

    def test_page_preview_missing_or_invalid_field_never_drops_partial_content(self):
        invalid = []
        for field in ("idx", "content", "format", "type"):
            block = recognition_block(1)
            del block[field]
            invalid.append(block)
        for field, values in {
            "idx": [-1, True, 1.5, "1", None, []],
            "content": [None, False, 1, [], {}],
            "format": [None, "", "HTML", "script", False, [], {}],
            "type": [None, False, 1, [], {}],
        }.items():
            invalid.extend(dict(recognition_block(1), **{field: value}) for value in values)
        invalid.append(recognition_block(0))  # duplicate, including an empty block
        invalid.append(recognition_block(0, ""))
        for block in invalid:
            with self.subTest(block=block):
                raw = layout_page(0, [recognition_block(0, "valid text"), block])
                self.assertIsNone(worker.page_markdown(raw))
                _, pages = worker.read_result(success(pages=[raw]), 1)
                self.assertIsNone(worker.page_markdown(pages[0]))
                # Re-normalizing completed caches must not turn invalid into valid.
                _, replay = worker.read_result(success(pages=pages), 1)
                self.assertEqual(replay, pages)
                self.assertIsNone(worker.page_markdown(replay[0]))

    def test_page_preview_formula_delimiters_and_untrusted_content(self):
        for content in ("x + α", "$$x + α$$", "$x + α$", r"\[x + α\]", r"\(x + α\)", "  $$\nx + α\n$$  "):
            with self.subTest(content=content):
                page = layout_page(0, [recognition_block(0, content, "Formula", "latex")])
                self.assertEqual(worker.page_markdown(page), "$$\nx + α\n$$")
        for content in (r"\begin{align}x&=1\end{align}", "$$unpaired$", r"\[mismatch\)"):
            page = layout_page(0, [recognition_block(0, content, "Formula", "latex")])
            self.assertEqual(worker.page_markdown(page), "$$\n" + content + "\n$$")
        for format in ("text", "html", "latex", "markdown"):
            content = '<script>throw "never execute"</script>\n![x](https://invalid/x)'
            page = layout_page(0, [recognition_block(0, content, "Table", format)])
            self.assertEqual(worker.page_markdown(page), content)

    def test_page_preview_code_fences_are_preserved_or_collision_safe(self):
        for content in ("```python\nprint('你好')\n```", "~~~js\nalert(1)\n~~~~", "  ```\nx\n  ```\n"):
            with self.subTest(content=content):
                page = layout_page(0, [recognition_block(0, content, "Code Block", "markdown")])
                self.assertEqual(worker.page_markdown(page), content)
        for content in ("print('你好')", "```\ninside\n````\nmore", "~~~\nmissing close", "x`````y", ""):
            with self.subTest(content=content):
                page = layout_page(0, [recognition_block(0, content, "Code Block")])
                result = worker.page_markdown(page)
                fence, rest = result.split("\n", 1)
                self.assertGreaterEqual(len(fence), 3)
                self.assertNotIn(fence, content)
                self.assertEqual(rest, content + "\n" + fence)

    def test_code_fence_detection_preserves_original_indentation(self):
        for content in ("    ```python\nprint(1)\n```", "\t```python\nprint(1)\n```",
                        "\n    ```python\nprint(1)\n```", "\n```python\nprint(1)\n```"):
            with self.subTest(content=content):
                self.assertFalse(worker.fenced_code(content))
                result = worker.page_markdown(layout_page(0, [recognition_block(0, content, "Code Block")]))
                fence = result.split("\n", 1)[0]
                self.assertEqual(result, fence + "\n" + content + "\n" + fence)
                self.assertNotIn(fence, content)

    def test_page_map_convert_exact_unicode_hashes_order_and_cache_rebuild(self):
        self.fake_pdf(21)
        first_pages = [layout_page(i, [recognition_block(8, "尾 " + str(i)),
                                      recognition_block(0, "页😀 " + str(i), "Title")]) for i in range(20)]
        first_pages[4] = layout_page(4)
        first_pages[7] = layout_page(7, [{"bbox": [1, 1, 2, 2], "type": "Text"}])
        final_page = layout_page(0, [recognition_block(0, "末页 α")])
        self.http.side_effect = [{"task_id": "first"}, success(20, "  原全文一😀\n", list(reversed(first_pages))),
                                 {"task_id": "second"}, success(1, "原全文二", [final_page])]
        result = worker.convert(self.request, self.frames.append)
        exact_md = "<!-- PDF pages 1-20 -->\n\n原全文一😀\n\n<!-- PDF pages 21-21 -->\n\n原全文二\n\n".encode("utf-8")
        self.assertEqual((self.output / "source.md").read_bytes(), exact_md)
        payload = {"schema": 1, "sourceHash": hashlib.sha256(self.source.read_bytes()).hexdigest(),
                   "markdownHash": hashlib.sha256(exact_md).hexdigest(), "pageCount": 21,
                   "pages": [worker.page_markdown(page) for page in first_pages] + ["末页 α"]}
        raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        name = "pages-" + hashlib.sha256(raw).hexdigest() + ".json"
        self.assertEqual(result, {"ok": True, "markdownFile": "source.md", "layoutFile": "layout.pdf",
                                  "pageMapFile": name, "pageCount": 21})
        self.assertEqual((self.output / name).read_bytes(), raw)
        self.assertEqual(payload["pages"][0], "# 页😀 0\n\n尾 0")
        self.assertEqual(payload["pages"][4], "")
        self.assertIsNone(payload["pages"][7])
        self.assertEqual(self.http.call_count, 4)  # no per-page requests
        self.assertNotIn("页", json.dumps(self.frames, ensure_ascii=False))
        (self.output / name).unlink()
        self.frames.clear()
        self.http.reset_mock()
        self.http.side_effect = AssertionError("Completed cache must stay offline")
        self.assertEqual(worker.convert(self.request, self.frames.append), result)
        self.assertEqual((self.output / name).read_bytes(), raw)
        self.http.assert_not_called()

    def test_v1_cache_is_preserved_but_not_reused_for_page_preview(self):
        options = {"baseURL": self.request["baseURL"], "image": "base64", "formula": "latex", "table": "html",
                   "keep_header_footer": False, "formats": ["markdown", "json"], "version": 1,
                   "source": "source-hash", "start": 0, "end": 1}
        digest = hashlib.sha256(self.chunk[2] + json.dumps(options, sort_keys=True).encode()).hexdigest()
        name = "cache/" + digest + ".json"
        self.store.cache_write(name, {"markdown": "OLD", "layout_pages": [layout_page(0)]})
        old_bytes = self.store.path(name).read_bytes()
        pages = [layout_page(0, [recognition_block()])]
        result = self.parse([{"task_id": "new"}, success(pages=pages)])
        self.assertEqual(result, ("Paper α", pages))
        self.assertEqual(self.http.call_count, 2)
        self.assertEqual(self.store.path(name).read_bytes(), old_bytes)
        self.assertEqual(len(list(self.store.cache.iterdir())), 2)
        self.http.reset_mock()
        self.assertEqual(self.parse([]), result)
        self.http.assert_not_called()

    def test_page_map_output_names_links_and_source_aliases(self):
        name = "pages-" + "a" * 64 + ".json"
        for bad in ("pages.json", "pages-" + "A" * 64 + ".json", "pages-" + "a" * 63 + ".json",
                    "../" + name, "sub/" + name, name + ".tmp", name + "\n", "/" + name):
            with self.subTest(name=bad), self.assertRaisesRegex(worker.WorkerError, "invalid_output_name"):
                self.store.write(bad, b"bad")
        path = self.output / name
        for target in (self.source, self.output / "missing"):
            path.symlink_to(target)
            with self.assertRaisesRegex(worker.WorkerError, "symlink_path"):
                self.store.write(name, b"bad")
            path.unlink()
        os.link(self.source, path)
        with self.assertRaisesRegex(worker.WorkerError, "source_alias"):
            self.store.write(name, b"bad")
        path.unlink()
        path.write_bytes(b"source")
        alias_store = worker.Output(str(self.output), path)
        with self.assertRaisesRegex(worker.WorkerError, "source_alias"):
            alias_store.write(name, b"bad")
        self.assertEqual(path.read_bytes(), b"source")
        path.unlink()
        path.mkdir()
        with self.assertRaisesRegex(worker.WorkerError, "source_alias"):
            self.store.write(name, b"bad")
        self.assertEqual(self.source.read_bytes(), b"%PDF-synthetic")

    def test_page_map_limits_include_utf8_content_and_json_overhead(self):
        page = layout_page(0, [recognition_block(0, "😀😀")])
        with mock.patch.object(worker, "MAX_PAGE_MAP", 7), self.assertRaisesRegex(worker.WorkerError, "page_content_limit"):
            worker.page_markdown(page)
        pages = [layout_page(i, [recognition_block(0, "α" * 5)]) for i in range(2)]
        with mock.patch.object(worker, "MAX_PAGE_MAP", 15), self.assertRaisesRegex(worker.WorkerError, "page_content_limit"):
            worker.write_page_map(self.store, pages, "s", "m")
        # Escaped characters, keys and quotes all count in the JSON byte budget.
        value = {"pages": ["\x00😀"]}
        exact = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        with mock.patch.object(worker, "MAX_PAGE_MAP", len(exact)):
            self.assertEqual(worker.page_json(value), exact)
        with mock.patch.object(worker, "MAX_PAGE_MAP", len(exact) - 1), self.assertRaisesRegex(worker.WorkerError, "page_map_limit"):
            worker.page_json(value)
        data = success(pages=[page])
        for layout in (data["result"]["outputs"]["json"], json.dumps(data["result"]["outputs"]["json"])):
            data["result"]["outputs"]["json"] = layout
            with mock.patch.object(worker, "MAX_PAGE_MAP", 40), self.assertRaisesRegex(worker.WorkerError, "page_map_limit"):
                worker.read_result(data, 1)

    def test_page_map_aggregate_content_limit_across_chunks_preserves_old_outputs(self):
        self.fake_pdf(21)
        (self.output / "source.md").write_bytes(b"old markdown")
        (self.output / "layout.pdf").write_bytes(b"old layout")
        # Each result JSON fits; aggregate recognized content does not. Missing
        # idx means unavailable, but must not evade the raw-content budget.
        first = [layout_page(i, [dict(recognition_block(content="x" * 1000), idx=None)]) for i in range(20)]
        last = [layout_page(0, [recognition_block(content="x" * 10000)])]
        self.http.side_effect = [{"task_id": "a"}, success(20, pages=first), {"task_id": "b"}, success(pages=last)]
        with mock.patch.object(worker, "MAX_PAGE_MAP", 25000), self.assertRaisesRegex(worker.WorkerError, "page_content_limit"):
            worker.convert(self.request, self.frames.append)
        self.assertEqual((self.output / "source.md").read_bytes(), b"old markdown")
        self.assertEqual((self.output / "layout.pdf").read_bytes(), b"old layout")
        self.assertEqual(list(self.output.glob("pages-*.json")), [])

    def test_page_map_json_limit_preserves_old_outputs(self):
        self.fake_pdf(1)
        self.http.side_effect = [{"task_id": "a"}, success()]
        (self.output / "source.md").write_bytes(b"old markdown")
        (self.output / "layout.pdf").write_bytes(b"old layout")
        # Empty page content and the layout JSON fit. The final map, including
        # its two SHA-256 fields, must still enforce the serialized-byte limit.
        with mock.patch.object(worker, "MAX_PAGE_MAP", 150), self.assertRaisesRegex(worker.WorkerError, "page_map_limit"):
            worker.convert(self.request, self.frames.append)
        self.assertEqual((self.output / "source.md").read_bytes(), b"old markdown")
        self.assertEqual((self.output / "layout.pdf").read_bytes(), b"old layout")
        self.assertEqual(list(self.output.glob("pages-*.json")), [])
        self.assertEqual(list(self.output.glob(".spt-*")), [])

    def test_page_map_write_failure_preserves_old_outputs_and_cleans_staging(self):
        self.fake_pdf(1)
        self.http.side_effect = [{"task_id": "a"}, success(pages=[layout_page(0, [recognition_block()])])]
        (self.output / "source.md").write_bytes(b"old markdown")
        (self.output / "layout.pdf").write_bytes(b"old layout")
        replace = worker.os.replace
        def replace_except_map(source, destination):
            if Path(destination).name.startswith("pages-"):
                raise OSError("map write failed")
            return replace(source, destination)
        with mock.patch.object(worker.os, "replace", side_effect=replace_except_map), self.assertRaisesRegex(OSError, "map write failed"):
            worker.convert(self.request, self.frames.append)
        self.assertEqual((self.output / "source.md").read_bytes(), b"old markdown")
        self.assertEqual((self.output / "layout.pdf").read_bytes(), b"old layout")
        self.assertEqual(list(self.output.glob(".spt-*")), [])
        self.assertEqual(list(self.output.glob("pages-*.json")), [])
        self.http.reset_mock()
        self.http.side_effect = AssertionError("Resume must use completed cache")
        result = worker.convert(self.request, self.frames.append)
        self.assertEqual(json.loads((self.output / result["pageMapFile"]).read_bytes())["pages"], ["正文 α"])
        self.http.assert_not_called()

    def test_remote_observations_are_deduped_without_fabricated_states(self):
        self.parse([{"task_id": "SECRET_TASK"}, {"status": " QUEUING "}, {"status": "queuing"},
                    {"status": "processing"}, {"status": "PROCESSING"}, success()])
        self.assertEqual(self.frames, [self.frame(status) for status in
                                      ("uploading", "submitted", "queuing", "processing", "complete")])
        self.assertNotIn("SECRET", json.dumps(self.frames))
        self.assertEqual(self.http.call_count, 6)

    def test_immediate_success_and_completed_cache(self):
        self.assertEqual(self.parse([{"task_id": "task"}, success()])[0], "Paper α")
        self.assertEqual(self.frames, [self.frame(s) for s in ("uploading", "submitted", "complete")])
        self.frames.clear()
        self.http.reset_mock()
        self.parse([])
        self.assertEqual(self.frames, [self.frame("complete")])
        self.http.assert_not_called()

    def test_direct_call_without_progress_and_exact_cache_digest(self):
        self.http.side_effect = [{"task_id": "task"}, success()]
        worker.parse_chunk(self.session, self.chunk, self.request["baseURL"], self.store, "source-hash")
        options = {"baseURL": self.request["baseURL"], "image": "base64", "formula": "latex", "table": "html",
                   "keep_header_footer": False, "formats": ["markdown", "json"], "version": 2,
                   "source": "source-hash", "start": 0, "end": 1}
        digest = hashlib.sha256(self.chunk[2] + json.dumps(options, sort_keys=True).encode()).hexdigest()
        self.assertEqual([p.name for p in self.store.cache.iterdir()], [digest + ".json"])
        self.assertEqual(self.http.call_args_list[0].kwargs["files"]["file"][1], self.chunk[2])

    def test_resume_only_reports_submitted_then_observed_state(self):
        with self.assertRaisesRegex(worker.WorkerError, "unknown_task_status"):
            self.parse([{"task_id": "task"}, {"status": "unknown"}])
        self.frames.clear()
        self.http.reset_mock()
        self.parse([{"status": "processing"}, success()])
        self.assertEqual(self.frames, [self.frame(s) for s in ("submitted", "processing", "complete")])
        self.assertTrue(all(call.args[1].endswith("/parse/async_check") for call in self.http.call_args_list))

    def test_upload_failure_reports_failed_and_reraises_same_exception(self):
        error = worker.WorkerError("request_failed")
        with self.assertRaises(worker.WorkerError) as caught:
            self.parse([error])
        self.assertIs(caught.exception, error)
        self.assertEqual(self.frames, [self.frame("uploading"), self.frame("failed")])

    def test_invalid_task_has_no_submitted_state(self):
        with self.assertRaisesRegex(worker.WorkerError, "invalid_task"):
            self.parse([{"task_id": ""}])
        self.assertEqual(self.frames, [self.frame("uploading"), self.frame("failed")])

    def test_remote_failure_does_not_report_complete(self):
        with self.assertRaisesRegex(worker.WorkerError, "remote_task_failed"):
            self.parse([{"task_id": "task"}, {"status": "processing"}, {"status": "FAILED"}])
        self.assertEqual(self.frames, [self.frame(s) for s in ("uploading", "submitted", "processing", "failed")])
        self.assertEqual(list(self.store.cache.iterdir()), [])

    def test_invalid_result_and_corrupt_cache_report_failed(self):
        with self.assertRaisesRegex(worker.WorkerError, "incomplete_layout"):
            self.parse([{"task_id": "task"}, success(pages=[])])
        self.assertEqual(self.frames[-1], self.frame("failed"))
        cache = next(self.store.cache.iterdir())
        cache.write_text(json.dumps({"markdown": "SECRET CONTENT", "layout_pages": []}))
        self.frames.clear()
        self.http.reset_mock()
        with self.assertRaisesRegex(worker.WorkerError, "incomplete_layout"):
            self.parse([])
        self.assertEqual(self.frames, [self.frame("failed")])
        self.http.assert_not_called()

    def test_timeout_reports_failed(self):
        with mock.patch.object(worker, "TASK_TIMEOUT", 0), self.assertRaisesRegex(worker.WorkerError, "task_timeout"):
            self.parse([{"task_id": "task"}])
        self.assertEqual(self.frames, [self.frame(s) for s in ("uploading", "submitted", "failed")])

    def test_plan_has_real_byte_split_ranges_before_any_upload(self):
        self.fake_pdf(5, lambda _doc, start, end: bytes([start]) * (end - start) * 10)
        split = worker.split_pdf
        self.enter_patch(mock.patch.object(worker, "split_pdf", side_effect=lambda doc: split(doc, max_bytes=21)))
        self.enter_patch(mock.patch.object(worker, "MAX_CHUNK", 21))
        ranges = [(0, 2), (2, 3), (3, 5)]
        prefix = [{"type": "progress", "phase": "planning", "pageCount": 5}]
        prefix += [self.frame("pending", a + 1, b) for a, b in ranges]
        prefix += [{"type": "progress", "phase": "parsing"}]
        responses = iter([item for a, b in ranges for item in ({"task_id": "task"}, success(b - a))])

        def http(*_args, **_kwargs):
            self.assertEqual(self.frames[:len(prefix)], prefix)
            return next(responses)

        self.http.side_effect = http
        result = worker.convert(self.request, self.frames.append)
        expected = prefix + [self.frame(status, a + 1, b) for a, b in ranges
                             for status in ("uploading", "submitted", "complete")]
        expected.append({"type": "progress", "phase": "assembling"})
        self.assertEqual(self.frames, expected)
        self.assertEqual(result["pageCount"], 5)
        self.assertEqual([(c.args[1], c.args[2]) for c in self.extract.call_args_list],
                         [(0, 5), (0, 2), (2, 5), (2, 3), (3, 5)] + ranges)
        uploads = [c.kwargs["files"]["file"][1] for c in self.http.call_args_list if "files" in c.kwargs]
        self.assertEqual(uploads, [bytes([a]) * (b - a) * 10 for a, b in ranges])
        self.assertFalse(self.session.trust_env)

    def test_plan_obeys_twenty_page_limit_and_cache_replay(self):
        self.fake_pdf(43)
        self.http.side_effect = [item for count in (20, 20, 3) for item in ({"task_id": "task"}, success(count))]
        worker.convert(self.request, self.frames.append)
        self.assertEqual([(f["start"], f["end"]) for f in self.frames if f.get("status") == "pending"],
                         [(1, 20), (21, 40), (41, 43)])
        self.frames.clear()
        self.http.reset_mock()
        self.http.side_effect = AssertionError("Cache must not contact OXR")
        worker.convert(self.request, self.frames.append)
        self.http.assert_not_called()
        self.assertEqual([f["status"] for f in self.frames if f["phase"] == "chunk"],
                         ["pending"] * 3 + ["complete"] * 3)

    def test_reextract_limit_fails_before_upload(self):
        self.fake_pdf(1)
        self.extract.side_effect = [b"a", b"oversized"]
        split = worker.split_pdf
        self.enter_patch(mock.patch.object(worker, "split_pdf", side_effect=lambda doc: split(doc, max_bytes=2)))
        with mock.patch.object(worker, "MAX_CHUNK", 2), self.assertRaisesRegex(worker.WorkerError, "chunk_limit"):
            worker.convert(self.request, self.frames.append)
        self.assertEqual(self.frames, [{"type": "progress", "phase": "planning", "pageCount": 1},
                         self.frame("pending"), {"type": "progress", "phase": "parsing"}, self.frame("failed")])
        self.http.assert_not_called()
        self.assertFalse((self.output / "source.md").exists())

    def test_reextract_exception_reports_failed_once(self):
        self.fake_pdf(1)
        error = OSError("SECRET PATH")
        self.extract.side_effect = [b"a", error]
        with self.assertRaises(OSError) as caught:
            worker.convert(self.request, self.frames.append)
        self.assertIs(caught.exception, error)
        self.assertEqual(self.frames[-1], self.frame("failed"))
        self.assertEqual(sum(f.get("status") == "failed" for f in self.frames), 1)
        self.http.assert_not_called()

    def test_unplannable_single_page_never_uploads(self):
        self.fake_pdf(1, lambda *_: b"oversized")
        split = worker.split_pdf
        self.enter_patch(mock.patch.object(worker, "split_pdf", side_effect=lambda doc: split(doc, max_bytes=2)))
        with self.assertRaisesRegex(worker.WorkerError, "single_page_too_large"):
            worker.convert(self.request, self.frames.append)
        self.assertEqual(self.frames, [{"type": "progress", "phase": "planning", "pageCount": 1}])
        self.http.assert_not_called()

    def test_chunk_failure_does_not_start_next_chunk_or_assembly(self):
        self.fake_pdf(21)
        self.http.side_effect = [{"task_id": "task"}, {"status": "failed"}]
        with self.assertRaisesRegex(worker.WorkerError, "remote_task_failed"):
            worker.convert(self.request, self.frames.append)
        self.assertEqual(self.frames[-1], self.frame("failed", 1, 20))
        self.assertEqual(sum(f.get("status") == "failed" for f in self.frames), 1)
        self.assertFalse(any(f.get("start") == 21 and f.get("status") != "pending" for f in self.frames))
        self.assertFalse(any(f["phase"] == "assembling" for f in self.frames))
        self.assertFalse((self.output / "source.md").exists())

    def test_check_and_preview_still_emit_only_terminal_json(self):
        program = '''
import importlib.util, sys, types
spec = importlib.util.spec_from_file_location("core", sys.argv[1])
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
core.load_dependencies = lambda **kwargs: None
core.pymupdf = types.SimpleNamespace(VersionBind="1.24.4")
core.requests = types.SimpleNamespace(__version__="2.31.0")
core.preview = lambda request: {"ok": True, "imageFile": "preview.png", "pageCount": 1, "page": 1}
sys.exit(core.main(sys.argv[2:]))
'''
        for operation, request, keys in [("check", {}, {"ok", "python", "pymupdf", "requests"}),
                ("preview", {"sourcePath": "unused", "outputDir": "unused", "page": 1},
                 {"ok", "imageFile", "pageCount", "page"})]:
            with self.subTest(operation=operation):
                result = subprocess.run([sys.executable, "-B", "-I", "-c", program,
                    str(WORKER.with_name("pdf_to_markdown.py")), operation, json.dumps(request)],
                    capture_output=True, text=True, timeout=10)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stderr, "")
                self.assertEqual(len(result.stdout.splitlines()), 1)
                self.assertEqual(set(json.loads(result.stdout)), keys)

    def test_cli_progress_is_flushed_before_terminal_json_and_native_noise_suppressed(self):
        program = '''
import importlib.util, os, sys
spec = importlib.util.spec_from_file_location("core", sys.argv[1])
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
core.load_dependencies = lambda **kwargs: None
def convert(request, progress):
    print("SECRET PAPER")
    os.write(1, b"NATIVE SECRET\\n")
    os.write(2, b"SECRET TASK KEY\\n")
    progress({"type": "progress", "phase": "planning", "pageCount": 1})
    # Parent cannot release us until it receives the frame: proves flush.
    assert sys.stdin.readline() == "continue\\n"
    progress({"type": "progress", "phase": "chunk", "start": 1, "end": 1, "status": "pending"})
    progress({"type": "progress", "phase": "parsing"})
    if sys.argv[2] == "failure":
        progress({"type": "progress", "phase": "chunk", "start": 1, "end": 1, "status": "failed"})
        core.fail("request_failed")
    progress({"type": "progress", "phase": "assembling"})
    return {"ok": True, "markdownFile": "source.md", "layoutFile": "layout.pdf",
            "pageMapFile": "pages-" + "0" * 64 + ".json", "pageCount": 1}
core.convert = convert
sys.exit(core.main(["convert", '{"sourcePath":"SECRET","outputDir":"SECRET","baseURL":"SECRET"}']))
'''
        for mode in ("success", "failure"):
            with self.subTest(mode=mode), subprocess.Popen([sys.executable, "-B", "-I", "-c", program,
                    str(WORKER.with_name("pdf_to_markdown.py")), mode], stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) as process:
                try:
                    with selectors.DefaultSelector() as selector:
                        selector.register(process.stdout, selectors.EVENT_READ)
                        self.assertTrue(selector.select(timeout=10), "Progress buffered until process exit")
                    first = json.loads(process.stdout.readline())
                    self.assertEqual(first, {"type": "progress", "phase": "planning", "pageCount": 1})
                    output, errors = process.communicate("continue\n", timeout=10)
                    frames = [json.loads(line) for line in output.splitlines()]
                    self.assertEqual(frames[:2], [self.frame("pending"), {"type": "progress", "phase": "parsing"}])
                    if mode == "failure":
                        self.assertEqual(process.returncode, 1)
                        self.assertEqual(frames[2:], [self.frame("failed"), {"ok": False, "error": "request_failed"}])
                        self.assertEqual(errors, "fulltext: request_failed\n")
                    else:
                        self.assertEqual(process.returncode, 0)
                        self.assertEqual(frames[2], {"type": "progress", "phase": "assembling"})
                        self.assertEqual(frames[3], {"ok": True, "markdownFile": "source.md", "layoutFile": "layout.pdf",
                                                   "pageMapFile": "pages-" + "0" * 64 + ".json", "pageCount": 1})
                        self.assertEqual(errors, "")
                    self.assertNotIn("SECRET", output + errors)
                finally:
                    if process.poll() is None:
                        process.kill()
                        process.communicate(timeout=10)


if __name__ == "__main__":
    unittest.main()
