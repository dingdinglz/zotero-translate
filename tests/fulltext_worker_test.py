"""Offline worker regressions. Run with an existing Python containing PyMuPDF/requests.
No tests install dependencies, contact OXR, or touch Zotero data.
"""
import importlib.util
import json
import os
from pathlib import Path
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
worker.load_dependencies(network=True)
fitz = worker.pymupdf


def layout_page(number, blocks=None):
    return {"page_num": number, "page_size": {"w": 612, "h": 792}, "blocks": blocks or []}


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
        self.assertEqual(result, {"ok": True, "markdownFile": "source.md", "layoutFile": "layout.pdf", "pageCount": 1})
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


if __name__ == "__main__":
    unittest.main()
