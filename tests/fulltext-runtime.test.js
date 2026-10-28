"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { validateOXRURL, collectProcess } = require("../plugin/content/fulltext-runtime.js");
function pipe(parts) { return { async readString() { return parts.shift() || ""; } }; }
function processMock(stdout = '{"ok":true}', exitCode = 0) {
  return { stdout: pipe([stdout]), stderr: pipe([]), killed: false,
    kill() { this.killed = true; }, async wait() { return { exitCode }; } };
}
test("OXR endpoint rejects credentials, insecure nonlocal HTTP and ambiguous URLs", () => {
  assert.equal(validateOXRURL("https://example.org/api/v1/"), "https://example.org/api/v1");
  assert.equal(validateOXRURL("http://127.0.0.1:1234/api/v1"), "http://127.0.0.1:1234/api/v1");
  for (const url of ["file:///tmp/a", "https://user:password@example.org", "https://example.org?key=x", "https://example.org#x", "http://example.org/api", "javascript:alert(1)", "bad"]) {
    assert.throws(() => validateOXRURL(url));
  }
});
test("Python collector accepts exactly one successful JSON result and checks exit status", async () => {
  assert.deepEqual(await collectProcess(processMock(), { timeoutMS: 1000 }), { ok: true });
  await assert.rejects(collectProcess(processMock('{"ok":true}', 1), { timeoutMS: 1000 }), /失败/u);
  await assert.rejects(collectProcess(processMock("log\n{\"ok\":true}"), { timeoutMS: 1000 }), /有效结果/u);
});
test("Python collector bounds output and kills on cancellation", async () => {
  const oversized = processMock("x".repeat(65537));
  await assert.rejects(collectProcess(oversized, { timeoutMS: 1000 }), /超限/u); assert.ok(oversized.killed);
  const cancelled = processMock();
  await assert.rejects(collectProcess(cancelled, { timeoutMS: 1000, registerCancel: cancel => { cancel(); return () => {}; } }), /暂停/u);
  assert.ok(cancelled.killed);
});
function printFixture({ failedImage = false, delayed = false } = {}) {
  const vm = require("node:vm"), fs = require("node:fs");
  const files = new Map([["/data/task/translated.pdf", new TextEncoder().encode("old PDF")]]);
  const dirs = new Set(["/data/task"]), calls = [];
  let frame, cancel, settlePrint;
  const element = () => ({ append() {}, setAttribute() {}, style: {} });
  const inert = { head: element(), body: element(), documentElement: {}, createElement: element,
    createElementNS: element, createTextNode: text => ({ text }), importNode: node => node };
  class XMLParser {}
  const owner = { closed: false, DOMParser: XMLParser, XMLSerializer: class { serializeToString() { return "<html></html>"; } }, document: {
    implementation: { createHTMLDocument: () => inert },
    createElementNS: () => {
      frame = { ...element(), contentDocument: { documentURI: "about:srcdoc", fonts: { ready: Promise.resolve() },
        images: [{ complete: true, naturalWidth: failedImage ? 0 : 1, naturalHeight: 1, async decode() {} }] },
      addEventListener(_name, fn, capture, wantsUntrusted) { assert.equal(capture, true); assert.equal(wantsUntrusted, true); this.load = fn; }, remove() { this.removed = true; },
      browsingContext: { print: async settings => {
        calls.push(["print", { ...settings }]);
        if (delayed) await new Promise(resolve => { settlePrint = resolve; });
        files.set(settings.toFileName, new TextEncoder().encode("%PDF-1.7\n" + "x".repeat(120)));
      } } };
      return frame;
    }, documentElement: { append: node => node.load() }
  } };
  const scope = { TextEncoder, TextDecoder, URL, setTimeout, clearTimeout,
    SmartPaperTranslatorModules: { Constants: { VERSION: "test" }, ACP: { toNativeAbsolutePath: path => path },
      FulltextMarkdown: { PRINT_CSS: "", renderMarkdown: doc => assert.equal(doc.defaultView.DOMParser, XMLParser) } },
    Zotero: { DataDirectory: { dir: "/data" } }, Services: { uuid: { generateUUID: () => "{abcd}" } },
    PathUtils: { join: (...parts) => parts.join("/") },
    Cc: { "@mozilla.org/file/local;1": { createInstance: () => ({ initWithPath(path) { this.path = path; }, parent: null,
      isSymlink: () => false, exists() { return files.has(this.path) || dirs.has(this.path); }, isFile() { return files.has(this.path); }, isDirectory() { return dirs.has(this.path); } }) },
      "@mozilla.org/gfx/printsettings-service;1": { getService: () => ({ createNewPrintSettings: () => ({}) }) } },
    Ci: { nsIPrintSettings: { kOutputFormatPDF: 1, kOutputDestinationFile: 2, kPaperSizeInches: 3 } },
    IOUtils: { stat: async path => ({ size: files.get(path).length }), read: async path => files.get(path),
      makeDirectory: async path => dirs.add(path), move: async (from, to) => { calls.push(["move", from, to]); files.set(to, files.get(from)); files.delete(from); } }
  };
  vm.runInNewContext(fs.readFileSync(require.resolve("../plugin/content/fulltext-runtime.js"), "utf8"), scope);
  const runtime = new scope.SmartPaperTranslatorModules.FulltextRuntime.FulltextRuntime({});
  runtime.python = async (operation, request) => { calls.push([operation, request]); return { pageCount: 1 }; };
  return { runtime, owner, calls, files, frame: () => frame, start: () => runtime.printPDF(owner, "# 中文", "/data/task", fn => { cancel = fn; return () => {}; }), cancel: () => cancel(), settle: () => settlePrint() };
}

test("native print adapter uses isolated settings, supplies XML parser and validates before replacing PDF", async () => {
  const x = printFixture(); await x.start();
  assert.deepEqual(x.calls.map(call => call[0]), ["print", "preview", "move"]);
  const settings = x.calls[0][1]; assert.equal(settings.printSilent, true); assert.equal(settings.paperWidth, 8.2677);
  assert.equal(settings.headerStrCenter, ""); assert.equal(settings.toFileName, "/data/task/print-abcd.pdf");
  assert.ok(x.frame().removed);
});

test("failed image decode keeps the previous PDF and never prints", async () => {
  const x = printFixture({ failedImage: true }); await assert.rejects(x.start(), /图片解码/u);
  assert.equal(x.calls.length, 0); assert.equal(new TextDecoder().decode(x.files.get("/data/task/translated.pdf")), "old PDF");
});

test("cancelling a delayed print never commits its late temporary output", async () => {
  const x = printFixture({ delayed: true }); const printing = x.start();
  const rejection = assert.rejects(printing, /暂停/u);
  while (!x.calls.length) await new Promise(resolve => setImmediate(resolve));
  x.cancel(); await rejection; x.settle(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(new TextDecoder().decode(x.files.get("/data/task/translated.pdf")), "old PDF");
  assert.ok(!x.calls.some(call => call[0] === "move")); assert.ok(x.frame().removed);
});

test("Python diagnostic stderr is not leaked into public errors", async () => {
  const process = processMock("not json", 1); process.stderr = pipe(["PRIVATE_PAPER_CONTENT secret-key"]);
  await assert.rejects(collectProcess(process, { timeoutMS: 1000 }), error => !error.message.includes("PRIVATE") && !error.message.includes("secret"));
});
