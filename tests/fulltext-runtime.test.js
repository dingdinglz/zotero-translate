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
test("Python progress streams bounded JSON lines across arbitrary pipe chunks", async () => {
  const events = [{ type: "progress", phase: "planning", pageCount: 21 },
    { type: "progress", phase: "chunk", start: 1, end: 20, status: "pending" },
    { type: "progress", phase: "parsing" }];
  const text = events.map(e => JSON.stringify(e) + "\n").join("") + '{"ok":true}\n';
  const proc = processMock(); proc.stdout = pipe(Array.from(text));
  const received = [];
  assert.deepEqual(await collectProcess(proc, { timeoutMS: 1000, onProgress: e => received.push(e) }), { ok: true });
  assert.deepEqual(received, events);
});
test("Python progress is delivered before process exit or terminal result", async () => {
  let release, observed;
  const gate = new Promise(resolve => { release = resolve; });
  const progress = new Promise(resolve => { observed = resolve; });
  let reads = 0;
  const proc = processMock();
  proc.wait = async () => { await gate; return { exitCode: 0 }; };
  proc.stdout = { async readString() {
    if (++reads === 1) return '{"type":"progress","phase":"planning","pageCount":1}\n';
    await gate; return reads === 2 ? '{"ok":true}\n' : "";
  } };
  const collecting = collectProcess(proc, { timeoutMS: 1000, onProgress: observed });
  assert.equal((await progress).pageCount, 1);
  release(); assert.deepEqual(await collecting, { ok: true });
});
test("Python progress rejects malformed frames, unexpected keys and output after terminal", async () => {
  for (const frame of [
    { type: "progress", phase: "planning", pageCount: 0 },
    { type: "progress", phase: "planning", pageCount: 10001 },
    { type: "progress", phase: "chunk", start: 1, end: 21, status: "pending" },
    { type: "progress", phase: "chunk", start: 1, end: 1, status: "secret" },
    { type: "progress", phase: "chunk", start: 1, end: 1, status: "processing", task_id: "PRIVATE" }
  ]) {
    const proc = processMock(JSON.stringify(frame) + '\n{"ok":true}\n');
    await assert.rejects(collectProcess(proc, { timeoutMS: 1000, onProgress() {} }), /进度无效/u);
    assert.ok(proc.killed);
  }
  for (const output of ['{"ok":true}\n{"ok":true}', '{"type":"progress","phase":"parsing"}\n']) {
    await assert.rejects(collectProcess(processMock(output), { timeoutMS: 1000, onProgress() {} }), /有效结果/u);
  }
});
test("Python progress stays streaming beyond old total cap but bounds line and aggregate bytes", async () => {
  const event = '{"type":"progress","phase":"parsing"}\n';
  const proc = processMock(event.repeat(2000) + '{"ok":true}'); let count = 0;
  await collectProcess(proc, { timeoutMS: 1000, onProgress: () => count++ }); assert.equal(count, 2000);
  for (const text of ["x".repeat(65537), "汉".repeat(22000), event.repeat(500000)]) {
    const proc = processMock(text);
    await assert.rejects(collectProcess(proc, { timeoutMS: 1000, onProgress() {} }), /超限/u);
    assert.ok(proc.killed);
  }
});
test("cancelled collector drops late progress and callback failures stop the process", async () => {
  const text = '{"type":"progress","phase":"parsing"}\n{"ok":true}';
  let calls = 0;
  await assert.rejects(collectProcess(processMock(text), { timeoutMS: 1000,
    onProgress: () => calls++, registerCancel: cancel => { cancel(); } }), /暂停/u);
  assert.equal(calls, 0);
  const proc = processMock(text);
  await assert.rejects(collectProcess(proc, { timeoutMS: 1000, onProgress: () => { throw new Error("顺序无效"); } }), /顺序无效/u);
  assert.ok(proc.killed);
});
function pathFixture({ pythonPath = "", windows = false, exists = true, regular = true } = {}) {
  const vm = require("node:vm"), fs = require("node:fs");
  const ACP = require("../plugin/content/acp-client.js");
  const calls = [];
  const scope = { TextEncoder, TextDecoder, URL, setTimeout, clearTimeout,
    SmartPaperTranslatorModules: {
      ACP: { toNativeAbsolutePath: value => ACP.toNativeAbsolutePath(value, windows) },
      Logic: { getProviderConfig: () => ({}) }, FulltextService: {}
    },
    Zotero: { DataDirectory: { dir: windows ? "C:\\data" : "/data" }, isWin: windows },
    PathUtils: { join: (...parts) => parts.join(windows ? "\\" : "/") },
    IOUtils: { exists: async path => { calls.push(["exists", path]); return exists; } },
    Cc: { "@mozilla.org/file/local;1": { createInstance: () => ({
      initWithPath(path) { calls.push(["file", path]); }, isFile: () => regular,
      isSymlink() { throw new Error("Python symlinks must not be rejected"); }
    }) } }, Ci: {},
    ChromeUtils: { importESModule: () => ({ Subprocess: {
      call: async options => { calls.push(["spawn", options]); return processMock(); }
    } }) }
  };
  vm.runInNewContext(fs.readFileSync(require.resolve("../plugin/content/fulltext-runtime.js"), "utf8"), scope);
  const runtime = new scope.SmartPaperTranslatorModules.FulltextRuntime.FulltextRuntime({
    getPreference: key => key.endsWith("fulltextPythonPath") ? pythonPath : ""
  });
  runtime.helpers = async () => { calls.push(["helpers"]); return windows ? "C:\\data\\runtime" : "/data/runtime"; };
  return { runtime, calls };
}

test("missing Python names the setting before any file access or process launch", async () => {
  for (const pythonPath of ["", "   "]) {
    const x = pathFixture({ pythonPath });
    await assert.rejects(x.runtime.python("convert", {}), /尚未选择 Python.*设置.*论文全文翻译.*检测本地依赖/u);
    assert.deepEqual(x.calls, []);
  }
  const x = pathFixture({ pythonPath: "/valid/python" });
  await assert.rejects(x.runtime.inspect(""), /尚未选择 Python/u);
  assert.deepEqual(x.calls, []);
});

test("invalid Python paths name Python and never fall back to another environment", async () => {
  for (const [windows, paths] of [[false, ["python3", "~/env/bin/python", "C:\\env\\python.exe", "/bad\0path"]],
    [true, ["python.exe", "C:python.exe", "/usr/bin/python3"]]]) {
    for (const pythonPath of paths) {
      const x = pathFixture({ windows, pythonPath });
      await assert.rejects(x.runtime.python("convert", {}), /Python 路径无效.*本机绝对路径.*设置/u);
      assert.deepEqual(x.calls, []);
    }
  }
});

test("missing Python executable and directory selection have distinct actionable errors", async () => {
  for (const [options, message] of [[{ exists: false }, /Python 文件不存在.*设置/u],
    [{ regular: false }, /Python 路径不是文件.*目录/u]]) {
    const x = pathFixture({ pythonPath: "/env/bin/python", ...options });
    await assert.rejects(x.runtime.python("convert", {}), message);
    assert.ok(!x.calls.some(([kind]) => ["helpers", "spawn"].includes(kind)));
  }
});

test("valid Python paths preserve isolated argv and accept virtualenv symlinks and Windows separators", async () => {
  for (const [windows, pythonPath, expected] of [[false, "/env with spaces/bin/python", "/env with spaces/bin/python"],
    [true, "C:/env with spaces/python.exe", "C:\\env with spaces\\python.exe"]]) {
    const x = pathFixture({ windows, pythonPath });
    await x.runtime.python("check", {});
    const options = x.calls.find(([kind]) => kind === "spawn")[1];
    assert.equal(options.command, expected);
    assert.equal(options.arguments[0], "-I");
    assert.equal(options.arguments[2], "check");
    assert.equal(options.environment.PYTHONNOUSERSITE, "1");
    assert.equal(x.runtime.processes.size, 0);
  }
});

test("source PDF path errors identify the attachment rather than the Python environment", async () => {
  for (const [sourcePath, exists, message] of [[false, true, /原 PDF 尚未下载到本机/u],
    ["", true, /原 PDF 尚未下载到本机/u], ["relative.pdf", true, /原 PDF 路径无效/u],
    ["/data/paper.pdf", false, /原 PDF 文件不存在/u]]) {
    const x = pathFixture({ exists });
    x.runtime.attachment = async () => ({ item: { key: "KEY", libraryID: 1, getFilePathAsync: async () => sourcePath }, parent: { id: 2 } });
    await assert.rejects(x.runtime._create(1), message);
    assert.ok(!x.calls.some(([kind]) => ["helpers", "spawn"].includes(kind)));
  }
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
