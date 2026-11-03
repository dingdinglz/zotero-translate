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
test("Python dependency failures distinguish installation, version and capability problems", async () => {
  for (const [code, message] of [
    ["python_version", /Python 版本过低.*3\.9/u],
    ["pymupdf_missing", /未安装 PyMuPDF/u],
    ["requests_missing", /未安装 requests/u],
    ["pymupdf_version_invalid", /无法识别 PyMuPDF 版本号/u],
    ["requests_version_invalid", /无法识别 requests 版本号/u],
    ["pymupdf_version_too_old", /PyMuPDF 版本过低.*1\.24\.4/u],
    ["requests_version_too_old", /requests 版本过低.*2\.31/u],
    ["pymupdf_version_unsupported", /PyMuPDF 大版本尚未支持/u],
    ["requests_version_unsupported", /requests 大版本尚未支持/u],
    ["pymupdf_capability", /本地 PDF 功能检测失败/u]
  ]) {
    await assert.rejects(collectProcess(processMock(JSON.stringify({ ok: false, error: code }), 1), { timeoutMS: 1000 }), error => {
      assert.match(error.message, message);
      assert.match(error.message, /设置.*论文全文翻译.*检测本地依赖/u);
      return true;
    });
  }
  await assert.rejects(collectProcess(processMock('{"ok":false,"error":"invalid_cache"}', 1), { timeoutMS: 1000 }), /invalid_cache/u);
  // A successful result still reports the exact dependency version without truncating components.
  const result = { ok: true, python: "3.13.9", pymupdf: "1.27.2.3", requests: "2.32.5.1" };
  assert.deepEqual(await collectProcess(processMock(JSON.stringify(result)), { timeoutMS: 1000 }), result);
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

function nativeOutputException() {
  return Object.assign(new Error("NS_ERROR_ILLEGAL_VALUE Bearer PRIVATE_BEARER sk-PRIVATE_KEY " +
    "https://example.invalid/?api_key=PRIVATE_QUERY&token=PRIVATE_TOKEN " + "x".repeat(1200)), { result: -2147024809 });
}
function assertOutputError(error, stage) {
  assert.ok(error.message.startsWith(`${stage}失败 [0x80070057]：NS_ERROR_ILLEGAL_VALUE`), error.message);
  assert.ok(error.message.length < 1000, "native diagnostics must remain bounded");
  assert.doesNotMatch(error.message, /PRIVATE_BEARER|PRIVATE_KEY|PRIVATE_QUERY|PRIVATE_TOKEN/u);
  assert.match(error.message, /已隐藏密钥/u);
  return true;
}

const PRINT_IMAGE_URI = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0S8AAAAASUVORK5CYII=";
const PRINT_REMOTE_URI = "https://images.example/figure?token=PRIVATE_IMAGE_TOKEN";
const printMarkdown = source => `中文正文\n\n${source}`;

function printFixture({ failedImage = false, delayed = false, failure = "", manualLoad = false,
  hold = "", context = "content", inaccessible = "", factory = "createContentWindow",
  wrappedBridge = false, existingBridge = null, bridgeFailure = "", cloneContext = "content",
  autoClone = true, beforeNative = () => {}, afterClone = () => {} } = {}) {
  const vm = require("node:vm"), fs = require("node:fs");
  const files = new Map([["/data/task/translated.pdf", new TextEncoder().encode("old PDF")]]);
  const dirs = new Set(["/data/task"]), calls = [], assignments = [], timers = new Set();
  const imports = [], insertions = [], lifecycle = [], listeners = new Set(), savedListeners = [];
  const stages = new Map(), gates = new Map();
  const clones = [], bridgeWrites = [], qi = [], nativeRequests = [], bridgeReads = [];
  const rendered = [], remoteImages = [], imageCommits = [], imageSources = [];
  let registered = false;
  const Markdown = require("../plugin/content/fulltext-markdown.js");
  let bridgeValue = existingBridge, nativeBridge, assignedBridge;
  const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
  const signal = name => { if (!stages.has(name)) stages.set(name, deferred()); return stages.get(name); };
  const pause = name => {
    signal(name).resolve();
    if (hold !== name && !(delayed && name === "print")) return Promise.resolve();
    if (!gates.has(name)) gates.set(name, deferred());
    return gates.get(name).promise;
  };
  let frame, cancel, content, initial, loaded, unregistered = 0, serialized = 0;
  let settled = false, contentAccess = inaccessible;
  const csp = "default-src 'none'; script-src 'none'; connect-src 'none'; img-src data:; style-src 'unsafe-inline'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";
  const css = "body { color: black; }";
  const element = (tag = "div", document = null) => ({ tag, localName: tag, nodeName: tag.toUpperCase(),
    nodeType: tag === "#text" ? 3 : 1, ownerDocument: document, attributes: {}, childNodes: [], style: {},
    get children() { return this.childNodes.filter(node => node.nodeType === 1); },
    get firstChild() { return this.childNodes[0] || null; },
    get textContent() { return this.nodeType === 3 ? this.nodeValue || "" : this.childNodes.map(node => node.textContent).join(""); },
    set textContent(value) {
      if (this.nodeType === 3) this.nodeValue = String(value);
      else this.replaceChildren(this.ownerDocument.createTextNode(String(value)));
    },
    append(...nodes) {
      for (const node of nodes) {
        assert.equal(typeof node, "object", "print DOM must not be assembled from strings");
        if (this.ownerDocument?.kind === "loaded") {
          assert.equal(node.ownerDocument, this.ownerDocument, "privileged/inert nodes must be cloned, not moved");
          insertions.push({ parent: this.tag, node });
        }
        node.attributesAtAppend = { ...node.attributes }; node.parentNode = this; this.childNodes.push(node);
      }
    },
    appendChild(node) { this.append(node); return node; },
    replaceChildren(...nodes) { this.childNodes = []; this.append(...nodes); },
    removeChild(node) { this.childNodes.splice(this.childNodes.indexOf(node), 1); return node; },
    setAttribute(name, value) {
      if (name === "src") {
        imageSources.push({ tag: this.tag, value });
        assert.match(value, /^data:image\//u, "a DOM image must never receive an external/local-file URL");
      }
      this.attributes[name] = String(value);
    },
    getAttribute(name) { return this.attributes[name] ?? null; },
    hasAttribute(name) { return Object.hasOwn(this.attributes, name); }
  });
  const descendants = node => node.childNodes.flatMap(child => [child, ...descendants(child)]);
  const makeDocument = kind => {
    const doc = { kind: "building", nodeType: 9, documentURI: "about:blank", readyState: "complete" };
    doc.createElement = tag => element(tag, doc);
    doc.createElementNS = (_ns, tag) => doc.createElement(tag);
    doc.createTextNode = text => Object.assign(element("#text", doc), { textContent: text, nodeValue: text });
    doc.importNode = (source, deep) => {
      assert.equal(deep, true);
      const clone = node => {
        const copy = element(node.tag, doc); copy.attributes = { ...node.attributes };
        if (node.nodeType === 3) copy.textContent = node.textContent;
        for (const child of node.childNodes) copy.append(clone(child));
        if (copy.tag === "img") Object.assign(copy, { complete: true, naturalWidth: failedImage ? 0 : 1,
          naturalHeight: 1, decode: () => pause("image") });
        return copy;
      };
      const copy = clone(source); imports.push({ source, copy, document: doc }); return copy;
    };
    doc.head = doc.createElement("head"); doc.body = doc.createElement("body"); doc.documentElement = doc.createElement("html");
    doc.documentElement.append(doc.head, doc.body); doc.kind = kind;
    Object.defineProperty(doc, "images", { get: () => descendants(doc.body).filter(node => node.tag === "img") });
    doc.fonts = { get ready() { return pause("fonts"); } };
    return doc;
  };
  const inert = makeDocument("inert");
  const title = inert.createElement("title"); title.textContent = "中文译文"; inert.head.append(title);
  const initialized = ["isInitializedFromPrinter", "isInitializedFromPrefs"];
  const createSettings = () => {
    const settings = { isInitializedFromPrinter: false, isInitializedFromPrefs: false };
    let printerName = "";
    Object.defineProperty(settings, "printerName", { enumerable: true, get: () => printerName,
      set(value) {
        printerName = value;
        // nsPrintSettings::SetPrinterName invalidates initialization for the new printer.
        settings.isInitializedFromPrinter = false; settings.isInitializedFromPrefs = false;
      }
    });
    return new Proxy(settings, { set(target, key, value) {
      assignments.push([key, value]);
      if (failure === "settings" && key === "outputFormat") throw nativeOutputException();
      return Reflect.set(target, key, value);
    } });
  };
  const expire = () => { for (const timer of [...timers]) { timers.delete(timer); timer.fn(); } };
  const dispatch = (event = {}, late = false) => {
    const value = { isTrusted: true, target: content, ...event };
    for (const listener of late ? savedListeners : listeners) listener(value);
  };
  const navigate = (event = {}) => {
    if (frame.srcdoc !== undefined) return false; // Top content root srcdoc is forbidden by Gecko.
    loaded = makeDocument("loaded"); content = loaded; loadedHead = loaded.head;
    dispatch(typeof event === "function" ? event(loaded) : event); return true;
  };
  class XMLParser {}
  const ownerContext = { isContent: context === "owner-content", print() { throw new Error("Must not print the chrome owner"); } };
  const owner = { closed: false, browsingContext: ownerContext, DOMParser: XMLParser,
    XMLSerializer: class { serializeToString() { serialized++; return "<!doctype html><html>forbidden serialized print document</html>"; } },
    document: { implementation: { createHTMLDocument: () => inert },
      createElementNS(namespace, tag) {
        assert.equal(namespace, "http://www.w3.org/1999/xhtml"); assert.equal(tag, "iframe");
        initial = makeDocument("initial"); content = initial;
        frame = { ...element(tag, owner.document), isConnected: false,
          get contentDocument() {
            if (contentAccess === "throw") throw nativeOutputException();
            return contentAccess === "null" ? null : content;
          },
          addEventListener(name, fn, capture, wantsUntrusted) {
            assert.equal(name, "load"); assert.equal(capture, true); assert.equal(wantsUntrusted, true);
            listeners.add(fn); savedListeners.push(fn); lifecycle.push("listen");
          },
          removeEventListener(name, fn, capture) {
            assert.equal(name, "load"); assert.equal(capture, true); listeners.delete(fn);
          },
          remove() { this.removed = true; this.isConnected = false; },
          browsingContext: { isContent: context !== "chrome", print: settings => {
            calls.push(["print", { ...settings }]); signal("print").resolve();
            nativeBridge = owner.browserDOMWindow;
            if (!nativeBridge) throw Object.assign(new Error("InvalidStateError"), { result: 0x8053000b });
            const info = { parent: frame.browsingContext, isForWindowDotPrint: false };
            beforeNative({ owner, frame, bridge: nativeBridge, info });
            if (autoClone) {
              const uri = { get spec() { throw new Error("Print clone must never inspect or load the URI"); } };
              const result = factory === "createContentWindow"
                ? nativeBridge.createContentWindow(uri, info, 4, 0, null)
                : nativeBridge.createContentWindowInFrame(uri, { openWindowInfo: info }, 4, 0, null);
              const browser = clones.at(-1);
              assert.ok(browser, "native print must obtain an owned XUL clone");
              assert.equal(result, factory === "createContentWindow" ? browser.browsingContext : browser);
              nativeRequests.push({ info, result, bridge: nativeBridge });
              afterClone({ owner, frame, bridge: nativeBridge, browser, info });
            }
            assert.equal(frame.attributesAtAppend.mozframetype, "content", "print clone requires a content frame at attachment");
            assert.equal(frame.attributesAtAppend.sandbox, ""); assert.equal(frame.attributes.sandbox, "");
            assert.equal(frame.attributesAtAppend["aria-hidden"], "true");
            assert.equal(frame.srcAtAppend, "about:blank"); assert.equal(frame.srcdoc, undefined); assert.equal(serialized, 0);
            assert.equal(content, loaded); assert.notEqual(content, initial);
            assert.equal(content.head, loadedHead, "CSP must bind to the existing destination head");
            const policy = content.head.children[0];
            assert.equal(policy.attributesAtAppend["http-equiv"], "Content-Security-Policy");
            assert.equal(policy.attributesAtAppend.content, csp);
            assert.equal(insertions[0].parent, "head"); assert.equal(insertions[0].node, policy);
            assert.equal(content.head.children.find(node => node.tag === "style").textContent, css);
            assert.equal(content.head.children.find(node => node.tag === "title").textContent, "中文译文");
            assert.equal(content.body.children[0].textContent, "中文正文");
            for (const { source, copy, document } of imports.filter(entry => entry.document === content)) {
              assert.notEqual(source, copy); assert.equal(copy.ownerDocument, document); assert.equal(source.ownerDocument, inert);
            }
            assert.equal(settings.printerName, "Mozilla Save to PDF");
            assert.equal(settings.outputFormat, 1); assert.equal(settings.outputDestination, 2);
            assert.equal(settings.isInitializedFromPrinter, true, "printer initialization must survive the printerName setter reset");
            assert.equal(settings.isInitializedFromPrefs, true, "preference initialization must survive the printerName setter reset");
            const keys = assignments.map(([key]) => key);
            assert.deepEqual(keys.slice(-2), initialized, "initialization flags must follow every other settings assignment");
            assert.equal(keys.filter(key => initialized.includes(key)).length, 2);
            if (failure === "print") throw nativeOutputException();
            return (async () => {
              await pause("print"); files.set(settings.toFileName, new TextEncoder().encode("%PDF-1.7\n" + "x".repeat(120)));
            })();
          } }
        };
        if (context === "owner" || context === "owner-content") frame.browsingContext = ownerContext;
        if (context === "no-print") delete frame.browsingContext.print;
        if (context === "missing") frame.browsingContext = null;
        let src;
        Object.defineProperty(frame, "src", { get: () => src, set(value) {
          assert.ok(listeners.size, "load capture must be installed before src assignment"); lifecycle.push("src"); src = value;
        } });
        return frame;
      },
      createXULElement(tag) {
        assert.equal(tag, "browser");
        if (bridgeFailure === "create") throw nativeOutputException();
        const closeListeners = new Set(), savedCloseListeners = [];
        const browser = { ...element(tag, owner.document), isConnected: false, closeListeners, savedCloseListeners,
          browsingContext: cloneContext === "missing" ? null : cloneContext === "source" ? frame.browsingContext
            : cloneContext === "owner" ? ownerContext : { isContent: cloneContext !== "chrome", id: Symbol("clone") },
          addEventListener(name, fn, ...options) {
            assert.equal(name, "DOMWindowClose"); closeListeners.add(fn); savedCloseListeners.push(fn);
            this.listenerOptions = options;
            if (bridgeFailure === "listen") throw nativeOutputException();
          },
          removeEventListener(name, fn) {
            assert.equal(name, "DOMWindowClose"); closeListeners.delete(fn);
            if (bridgeFailure === "unlisten") throw nativeOutputException();
          },
          remove() {
            this.removed = true; this.isConnected = false;
            if (bridgeFailure === "remove") throw nativeOutputException();
          },
          close({ late = false, ...values } = {}) {
            const event = { type: "DOMWindowClose", target: browser, originalTarget: browser, isTrusted: true,
              prevented: false, stopped: false,
              preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...values };
            for (const listener of late ? savedCloseListeners : closeListeners) listener(event);
            return event;
          },
          loadURI() { throw new Error("Print clones must not navigate"); }
        };
        Object.defineProperty(browser, "src", { set() { throw new Error("Print clones must not set src"); } });
        clones.push(browser); return browser;
      },
      documentElement: { append(node) {
        if (node.localName === "browser") {
          node.attributesAtAppend = { ...node.attributes }; node.infoAtAppend = node.openWindowInfo;
          node.listenerCountAtAppend = node.closeListeners.size;
          assert.ok(node.infoAtAppend, "openWindowInfo must be assigned BEFORE attachment");
          assert.equal(node.infoAtAppend.parent, frame.browsingContext);
          assert.equal(node.attributesAtAppend.type, "content");
          assert.ok(node.style.visibility === "collapse" || node.collapsed === true || node.attributes.collapsed === "true",
            "native clone must remain collapsed");
          assert.equal(node.hasAttribute("src"), false); assert.equal(node.hasAttribute("srcdoc"), false);
          node.isConnected = true;
          if (bridgeFailure === "append") throw nativeOutputException();
          return;
        }
        assert.ok(listeners.size, "load capture must be installed before attachment"); lifecycle.push("append");
        node.attributesAtAppend = { ...node.attributes }; node.srcAtAppend = node.src;
        node.isConnected = true;
        if (node.srcdoc !== undefined) {
          // Deterministic reproduction: no successful load for parentless content srcdoc.
          queueMicrotask(expire);
        } else if (!manualLoad) queueMicrotask(() => load());
      } }
    }
  };
  Object.defineProperty(owner, "browserDOMWindow", {
    get() {
      if (bridgeFailure === "readback" && assignedBridge) throw nativeOutputException();
      bridgeReads.push(bridgeValue); return bridgeValue;
    },
    set(value) {
      bridgeWrites.push(value);
      if (bridgeFailure === "set" && value) throw nativeOutputException();
      assignedBridge = value;
      bridgeValue = bridgeFailure === "readback-null" ? null : value && wrappedBridge ? new Proxy(value, {}) : value;
      if (bridgeFailure === "clear" && !value) throw nativeOutputException();
    }
  });
  owner.document.defaultView = owner;
  let loadedHead;
  const load = event => {
    const result = navigate(event);
    return result;
  };
  const scope = { TextEncoder, TextDecoder, URL,
    setTimeout: (fn, ms) => { const timer = { fn, ms }; timers.add(timer); return timer; },
    clearTimeout: timer => timers.delete(timer),
    SmartPaperTranslatorModules: { Constants: { VERSION: "test" }, ACP: { toNativeAbsolutePath: path => path },
      FulltextMarkdown: { ...Markdown, PRINT_CSS: css, renderMarkdown(doc, body, markdown, options = {}) {
        assert.equal(doc.defaultView.DOMParser, XMLParser);
        rendered.push({ markdown, registered });
        Markdown.renderMarkdown(doc, body, markdown, { ...options,
          ...(options.onRemoteImage ? { onRemoteImage(uri, commit) {
            remoteImages.push(uri);
            options.onRemoteImage(uri, dataURI => { commit(dataURI); imageCommits.push({ uri, dataURI }); });
          } } : {}) });
        // Preserve an inter-block text node to exercise childNodes (not just children) cloning.
        body.append(doc.createTextNode("\n"));
      } } },
    Zotero: { DataDirectory: { dir: "/data" }, getMainWindow() { throw new Error("Never borrow the main window bridge"); } },
    Services: { uuid: { generateUUID: () => "{abcd}" } },
    ChromeUtils: { generateQI(interfaces) {
      qi.push(Array.from(interfaces));
      if (bridgeFailure === "qi") throw nativeOutputException();
      return function QueryInterface() { return this; };
    } },
    PathUtils: { join: (...parts) => parts.join("/") },
    Cc: { "@mozilla.org/file/local;1": { createInstance: () => ({ initWithPath(path) { this.path = path; }, parent: null,
      isSymlink: () => false, exists() { return files.has(this.path) || dirs.has(this.path); }, isFile() { return files.has(this.path); }, isDirectory() { return dirs.has(this.path); } }) },
      "@mozilla.org/gfx/printsettings-service;1": { getService: () => ({ createNewPrintSettings: createSettings }) } },
    Ci: { nsIBrowserDOMWindow: { OPEN_PRINT_BROWSER: 4 },
      nsIPrintSettings: { kOutputFormatPDF: 1, kOutputDestinationFile: 2, kPaperSizeInches: 3 } },
    IOUtils: { stat: async path => {
      if (failure === "stat") throw nativeOutputException();
      await pause("stat"); return { size: files.get(path).length };
    }, read: async path => { await pause("read"); return files.get(path); },
      makeDirectory: async path => { await pause("directory"); dirs.add(path); }, move: async (from, to, options) => {
        calls.push(["move", from, to]); assert.equal(options.noOverwrite, false);
        if (failure === "move") throw nativeOutputException();
        files.set(to, files.get(from)); files.delete(from);
      } }
  };
  vm.runInNewContext(fs.readFileSync(require.resolve("../plugin/content/fulltext-runtime.js"), "utf8"), scope);
  const runtime = new scope.SmartPaperTranslatorModules.FulltextRuntime.FulltextRuntime({});
  runtime.python = async (operation, request) => {
    calls.push([operation, request]);
    if (failure === "validation") throw nativeOutputException();
    await pause("python"); return { pageCount: 1 };
  };
  return { runtime, owner, calls, files, assignments, imports, insertions, lifecycle, listeners, timers,
    clones, bridgeWrites, bridgeReads, qi, nativeRequests, bridge: () => nativeBridge,
    bridgeValue: () => bridgeValue, rendered, remoteImages, imageCommits, imageSources, inert,
    frame: () => frame, initial: () => initial, loaded: () => loaded, content: () => content,
    start(markdown = printMarkdown(`![本地图片](${PRINT_IMAGE_URI})`), getImageCache, { cancelOnRegister = false } = {}) {
      const promise = runtime.printPDF(owner, markdown, "/data/task", fn => {
        registered = true; cancel = fn;
        if (cancelOnRegister) fn();
        return () => { unregistered++; };
      }, getImageCache);
      promise.then(() => { settled = true; }, () => { settled = true; }); return promise;
    },
    settled: () => settled, cancel: () => cancel(), settle: () => gates.get("print").resolve(),
    release: name => gates.get(name).resolve(), expire, load, dispatch,
    async waitFor(name, printing) {
      await Promise.race([signal(name).promise, printing.then(() => { throw new Error(`Print finished before ${name}`); })]);
    },
    replaceDocument() { content = makeDocument("replacement"); },
    replaceContext() { frame.browsingContext = { ...frame.browsingContext }; },
    inaccessible(value) { contentAccess = value; },
    assertCleaned() {
      assert.ok(frame.removed); assert.equal(frame.isConnected, false); assert.equal(unregistered, 1);
      assert.equal(timers.size, 0); assert.equal(listeners.size, 0, "owned load listener must be removed");
      for (const clone of clones) {
        assert.ok(clone.removed, "owned clone must be removed"); assert.equal(clone.isConnected, false);
        assert.equal(clone.closeListeners.size, 0, "owned close listener must be removed");
      }
      if (nativeBridge) assert.notEqual(bridgeValue, nativeBridge, "owned bridge must not outlive native printing");
    }
  };
}

test("native print adapter uses isolated settings, supplies XML parser and validates before replacing PDF", async () => {
  const x = printFixture(); await x.start();
  assert.deepEqual(x.calls.map(call => call[0]), ["print", "preview", "move"]);
  const settings = x.calls[0][1]; assert.equal(settings.printSilent, true); assert.equal(settings.paperWidth, 8.2677);
  assert.equal(settings.headerStrCenter, ""); assert.equal(settings.toFileName, "/data/task/print-abcd.pdf");
  assert.ok(x.frame().removed); x.assertCleaned();
  assert.match(new TextDecoder().decode(x.files.get("/data/task/translated.pdf")), /^%PDF-/u);
  assert.equal(x.files.has("/data/task/print-abcd.pdf"), false);
});

test("failed image decode keeps the previous PDF and never prints", async () => {
  const x = printFixture({ failedImage: true }); await assert.rejects(x.start(), /图片解码/u);
  assert.equal(x.calls.length, 0); assert.equal(new TextDecoder().decode(x.files.get("/data/task/translated.pdf")), "old PDF");
  x.assertCleaned();
});

test("cancelling a delayed print never commits its late temporary output", async () => {
  const x = printFixture({ delayed: true }); const printing = x.start();
  await x.waitFor("print", printing);
  const rejection = assert.rejects(printing, /暂停/u);
  x.cancel(); await rejection; x.settle(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(new TextDecoder().decode(x.files.get("/data/task/translated.pdf")), "old PDF");
  assert.ok(!x.calls.some(call => call[0] === "move")); assert.ok(x.frame().removed); x.assertCleaned();
});

for (const [failure, stage, expectedCalls] of [
  ["settings", "配置 PDF 打印参数", []],
  ["print", "执行原生 PDF 打印", ["print"]],
  ["stat", "校验生成的 PDF", ["print"]],
  ["validation", "校验生成的 PDF", ["print", "preview"]],
  ["move", "保存生成的 PDF", ["print", "preview", "move"]]
]) {
  test(`native ${failure} failure reports stage/nsresult, cleans up and preserves the final PDF`, async () => {
    const x = printFixture({ failure });
    await assert.rejects(x.start(), error => assertOutputError(error, stage));
    assert.deepEqual(x.calls.map(call => call[0]), expectedCalls);
    assert.equal(new TextDecoder().decode(x.files.get("/data/task/translated.pdf")), "old PDF");
    x.assertCleaned();
  });
}

// Event-loop barriers flush promise continuations without wall-clock sleeps; all print timers are manual.
const flushPrint = () => new Promise(resolve => setImmediate(resolve));
function assertOldPDF(x) {
  assert.equal(new TextDecoder().decode(x.files.get("/data/task/translated.pdf")), "old PDF");
  assert.ok(!x.calls.some(call => call[0] === "move"));
}

test("fixture reproduces forbidden top-content srcdoc as timeout, never a successful load", async () => {
  const x = printFixture({ manualLoad: true });
  const frame = x.owner.document.createElementNS("http://www.w3.org/1999/xhtml", "iframe");
  let loads = 0, expired = 0;
  frame.addEventListener("load", () => loads++, true, true);
  frame.setAttribute("mozframetype", "content"); frame.setAttribute("sandbox", "");
  frame.srcdoc = "<!doctype html><html><body>must not load</body></html>";
  x.timers.add({ fn: () => expired++, ms: 30000 });
  x.owner.document.documentElement.append(frame);
  await flushPrint();
  assert.equal(frame.browsingContext.isContent, true);
  assert.equal(loads, 0); assert.equal(expired, 1); assert.equal(x.load(), false);
  assert.equal(x.content(), x.initial()); assert.deepEqual(x.calls, []);
});

test("transient initial blank never imports or prints before real navigation load", async () => {
  const x = printFixture({ manualLoad: true }), printing = x.start();
  await flushPrint();
  assert.equal(x.content(), x.initial()); assert.equal(x.initial().readyState, "complete");
  assert.equal(x.settled(), false, "initial ready blank must not settle the load wait");
  assert.deepEqual(x.calls, []); assert.deepEqual(x.imports, []);
  assert.deepEqual(x.lifecycle, ["listen", "src", "append"]);
  x.load(); await printing; x.assertCleaned();
  assert.notEqual(x.loaded(), x.initial());
});

for (const retargeted of [false, true]) {
  test(`trusted exact document load ${retargeted ? "with originalTarget retargeting" : "without retargeting"} imports CSP first then cloned head/body and prints`, async () => {
    const x = printFixture({ manualLoad: true }), printing = x.start();
    x.load(doc => retargeted ? { target: x.frame(), originalTarget: doc } : { target: doc });
    await printing;
    assert.deepEqual(x.calls.map(call => call[0]), ["print", "preview", "move"]);
    const insertions = x.insertions.filter(entry => ["head", "body"].includes(entry.parent));
    assert.equal(insertions[0].node.tag, "meta");
    assert.ok(insertions.findIndex(entry => entry.node.tag === "style") > 0);
    assert.ok(insertions.findIndex(entry => entry.parent === "body") > insertions.findIndex(entry => entry.node.tag === "style"));
    assert.ok(x.imports.some(entry => entry.source.nodeType === 3), "body childNodes must preserve text nodes too");
    assert.ok(x.loaded().body.childNodes.some(node => node.nodeType === 3 && node.textContent === "\n"));
    assert.ok(x.imports.length >= 6); x.assertCleaned();
  });
}

for (const kind of ["untrusted", "element", "image", "sibling", "original-target-sibling", "wrong-uri", "incomplete"]) {
  test(`print load ignores ${kind} events until a trusted exact complete about:blank document load`, async () => {
    const x = printFixture({ manualLoad: true }), printing = x.start();
    x.load(doc => {
      if (kind === "wrong-uri") doc.documentURI = "https://example.invalid/";
      if (kind === "incomplete") doc.readyState = "interactive";
      if (kind === "untrusted") return { isTrusted: false, target: doc };
      if (kind === "element") return { target: x.frame() };
      if (kind === "image") return { target: { nodeType: 1, localName: "img", ownerDocument: doc } };
      if (kind === "sibling") return { target: { nodeType: 9, documentURI: "about:blank", readyState: "complete" } };
      if (kind === "original-target-sibling") return { target: doc, originalTarget: { nodeType: 9, documentURI: "about:blank" } };
      return { target: doc };
    });
    await flushPrint();
    assert.equal(x.settled(), false); assert.deepEqual(x.calls, []); assert.deepEqual(x.imports, []);
    x.content().documentURI = "about:blank"; x.content().readyState = "complete";
    x.dispatch({ target: x.content() }); await printing; x.assertCleaned();
  });
}

test("load timeout removes listener, frame and timers; even a saved delayed listener cannot print", async () => {
  const x = printFixture({ manualLoad: true }), printing = x.start();
  const rejection = assert.rejects(printing, /加载隔离打印文档失败.*加载超时/u);
  x.expire(); await rejection; x.assertCleaned();
  x.load(); x.dispatch({ target: x.content() }, true); await flushPrint();
  assert.deepEqual(x.calls, []); assert.deepEqual(x.imports, []); assertOldPDF(x); x.assertCleaned();
});

test("cancel before navigation load discards late trusted events and removes owned resources", async () => {
  const x = printFixture({ manualLoad: true }), printing = x.start();
  const rejection = assert.rejects(printing, /暂停/u);
  x.cancel(); await rejection; x.assertCleaned();
  x.load(); x.dispatch({ target: x.content() }, true); await flushPrint();
  assert.deepEqual(x.calls, []); assert.deepEqual(x.imports, []); assertOldPDF(x); x.assertCleaned();
});

for (const inaccessible of ["null", "throw"]) {
  test(`inaccessible ${inaccessible} contentDocument fails at load stage without waiting for timeout`, async () => {
    const x = printFixture({ manualLoad: true, inaccessible }), printing = x.start();
    const rejection = assert.rejects(printing, error => inaccessible === "throw"
      ? assertOutputError(error, "加载隔离打印文档")
      : (assert.match(error.message, /加载隔离打印文档失败/u), assert.doesNotMatch(error.message, /超时/u), true));
    rejection.catch(() => {});
    x.load(); await flushPrint();
    assert.equal(x.settled(), true, "inaccessible documents must fail immediately, not wait 30 seconds");
    await rejection; assert.deepEqual(x.calls, []); assertOldPDF(x); x.assertCleaned();
  });
}

for (const context of ["chrome", "owner-content", "no-print", "missing"]) {
  test(`print rejects ${context} browsing context before importing or printing`, async () => {
    const x = printFixture({ context }), printing = x.start();
    await assert.rejects(printing, error => {
      assert.match(error.message, /加载隔离打印文档失败/u); assert.doesNotMatch(error.message, /超时/u); return true;
    });
    assert.deepEqual(x.calls, []); assert.deepEqual(x.imports, []); assertOldPDF(x); x.assertCleaned();
  });
}

for (const mutation of ["detached", "adopted", "owner-document-replaced"]) {
  test(`load rejects ${mutation} frame ownership`, async () => {
    const x = printFixture({ manualLoad: true }), printing = x.start();
    if (mutation === "detached") x.frame().isConnected = false;
    if (mutation === "adopted") x.frame().ownerDocument = {};
    if (mutation === "owner-document-replaced") x.owner.document = {};
    const rejection = assert.rejects(printing, /失败|暂停/u);
    x.load(); await flushPrint();
    assert.equal(x.settled(), true); await rejection;
    assert.deepEqual(x.calls, []); assert.deepEqual(x.imports, []); assertOldPDF(x); x.assertCleaned();
  });
}

for (const hold of ["fonts", "image", "print", "stat", "read", "directory", "python"]) {
  for (const replacement of ["Document", "Context"]) {
    test(`${replacement} replacement during ${hold} await invalidates pinned print document and blocks commit`, async () => {
      const x = printFixture({ hold }), printing = x.start();
      await x.waitFor(hold, printing);
      x[`replace${replacement}`]();
      const rejection = assert.rejects(printing, /失败|暂停/u);
      x.release(hold); await rejection;
      if (["fonts", "image"].includes(hold)) assert.deepEqual(x.calls, []);
      else assert.equal(x.calls.filter(call => call[0] === "print").length, 1);
      if (["print", "stat", "read", "directory"].includes(hold)) {
        assert.ok(!x.calls.some(call => call[0] === "preview"), "stale document must not launch Python validation");
      }
      assertOldPDF(x); x.assertCleaned();
    });
  }
}

test("native print fixture reproduces InvalidStateError 0x8053000b without an owner bridge", () => {
  const x = printFixture();
  const frame = x.owner.document.createElementNS("http://www.w3.org/1999/xhtml", "iframe");
  assert.throws(() => frame.browsingContext.print({}), error =>
    error.message === "InvalidStateError" && error.result === 0x8053000b);
  assert.deepEqual(x.calls, [["print", {}]]); assert.equal(x.clones.length, 0);
});

function requestPrintClone(bridge, factory, info, where = 4, uri = null) {
  return factory === "createContentWindow"
    ? bridge.createContentWindow(uri, info, where, 0, null)
    : bridge.createContentWindowInFrame(uri, { openWindowInfo: info }, where, 0, null);
}

for (const factory of ["createContentWindow", "createContentWindowInFrame"]) {
  for (const wrappedBridge of [false, true]) {
    test(`owned ${factory} print bridge ${wrappedBridge ? "uses wrapped getter identity" : "uses direct getter identity"} and is gone before validation`, async () => {
      const x = printFixture({ factory, wrappedBridge, hold: "stat" }), printing = x.start();
      await x.waitFor("stat", printing);
      assert.equal(x.owner.browserDOMWindow, null, "bridge lifetime ends before file/Python validation");
      assert.deepEqual(x.qi, [["nsIBrowserDOMWindow"]]);
      assert.equal(typeof x.bridge().QueryInterface, "function");
      assert.equal(x.nativeRequests.length, 1); assert.equal(x.clones.length, 1);
      const clone = x.clones[0], request = x.nativeRequests[0];
      assert.equal(clone.infoAtAppend, request.info); assert.equal(clone.listenerCountAtAppend, 1);
      assert.equal(clone.attributesAtAppend.type, "content");
      assert.equal(clone.browsingContext.isContent, true);
      assert.notEqual(clone.browsingContext, request.info.parent);
      assert.notEqual(clone.browsingContext, x.owner.browsingContext);
      assert.equal(request.result, factory === "createContentWindow" ? clone.browsingContext : clone);
      assert.ok(clone.removed); assert.equal(clone.closeListeners.size, 0);
      assert.equal(x.bridgeWrites.length, 2); assert.equal(x.bridgeWrites[1], null);
      assert.equal(x.bridgeWrites[0] === x.bridge(), !wrappedBridge);
      assert.ok(x.bridgeReads.includes(x.bridge()), "native wrapper must be read back after assignment");
      x.release("stat"); await printing; x.assertCleaned();
      assert.deepEqual(x.calls.map(call => call[0]), ["print", "preview", "move"]);
    });
  }

  test(`${factory} admits only exact source OPEN_PRINT_BROWSER and a single clone; navigation methods never allocate`, async () => {
    const x = printFixture({ factory, autoClone: false, beforeNative({ bridge, info }) {
      for (const where of [0, 1, 2, 3, 5, "4", undefined]) {
        // Pass undefined directly, rather than the helper's default parameter.
        assert.throws(() => factory === "createContentWindow"
          ? bridge.createContentWindow(null, info, where, 0, null)
          : bridge.createContentWindowInFrame(null, { openWindowInfo: info }, where, 0, null));
      }
      for (const invalid of [null, {}, { parent: {} }, { parent: { ...info.parent } },
        { parent: x.owner.browsingContext }, { parent: info.parent, isForWindowDotPrint: true }]) {
        assert.throws(() => requestPrintClone(bridge, factory, invalid));
      }
      for (const method of ["openURI", "openURIInFrame"]) {
        assert.throws(() => bridge[method]("https://example.invalid/never-load", method === "openURI" ? info : { openWindowInfo: info }, 4));
      }
      assert.equal(x.clones.length, 0, "refused requests must not allocate browsers");
      const uri = { get spec() { throw new Error("URI must not be inspected"); } };
      const result = requestPrintClone(bridge, factory, info, 4, uri);
      assert.equal(result, factory === "createContentWindow" ? x.clones[0].browsingContext : x.clones[0]);
      assert.throws(() => requestPrintClone(bridge, factory, info));
      const other = factory === "createContentWindow" ? "createContentWindowInFrame" : "createContentWindow";
      assert.throws(() => requestPrintClone(bridge, other, info));
      assert.equal(x.clones.length, 1);
    } });
    await x.start(); x.assertCleaned();
  });
}

for (const mutation of ["document", "context", "detached", "adopted", "owner-document", "owner-closed", "uri"]) {
  test(`print bridge rejects ${mutation} source staleness before creating a clone`, async () => {
    const x = printFixture({ beforeNative({ owner, frame }) {
      if (mutation === "document") x.replaceDocument();
      if (mutation === "context") x.replaceContext();
      if (mutation === "detached") frame.isConnected = false;
      if (mutation === "adopted") frame.ownerDocument = {};
      if (mutation === "owner-document") owner.document = {};
      if (mutation === "owner-closed") owner.closed = true;
      if (mutation === "uri") x.content().documentURI = "https://example.invalid/";
    } });
    await assert.rejects(x.start(), /失败|暂停/u);
    assert.equal(x.bridgeWrites.filter(Boolean).length, 1, "staleness is checked by an installed bridge callback");
    assert.equal(x.clones.length, 0); assert.equal(x.owner.browserDOMWindow, null);
    assertOldPDF(x); x.assertCleaned();
  });
}

for (const cloneContext of ["missing", "chrome", "source", "owner"]) {
  test(`print bridge rejects ${cloneContext} clone context and removes partially attached browser`, async () => {
    const x = printFixture({ cloneContext });
    await assert.rejects(x.start(), /失败/u);
    assert.equal(x.clones.length, 1); assert.equal(x.owner.browserDOMWindow, null);
    assertOldPDF(x); x.assertCleaned();
  });
}

for (const existingBridge of [{ foreign: true }, false, 0]) {
  test(`existing non-null browserDOMWindow (${typeof existingBridge}) is never replaced or used`, async () => {
    const x = printFixture({ existingBridge });
    await assert.rejects(x.start(), /准备原生打印宿主失败/u);
    assert.equal(x.owner.browserDOMWindow, existingBridge); assert.deepEqual(x.bridgeWrites, []);
    assert.equal(x.clones.length, 0); assert.deepEqual(x.calls, []); assertOldPDF(x); x.assertCleaned();
  });
}

for (const outcome of ["success", "cancel", "timeout", "exception"]) {
  test(`foreign browserDOMWindow replacement survives ${outcome} cleanup; saved callbacks are inert`, async () => {
    const foreign = { foreign: true };
    const x = printFixture({ delayed: outcome === "cancel" || outcome === "timeout",
      failure: outcome === "exception" ? "print" : "", wrappedBridge: true,
      afterClone({ owner }) { owner.browserDOMWindow = foreign; } });
    const printing = x.start();
    if (outcome === "cancel" || outcome === "timeout") {
      await x.waitFor("print", printing);
      const rejection = assert.rejects(printing, outcome === "cancel" ? /暂停/u : /超时/u);
      if (outcome === "cancel") x.cancel(); else x.expire();
      await rejection; x.settle(); await flushPrint();
    } else if (outcome === "exception") await assert.rejects(printing, error => assertOutputError(error, "执行原生 PDF 打印"));
    else await printing;
    // A native setter can wrap foreign values too: compare to its captured readback, not the assigned JS object.
    const foreignReadback = x.owner.browserDOMWindow;
    assert.equal(foreignReadback.foreign, true); assert.notEqual(foreignReadback, x.bridge());
    assert.equal(x.bridgeWrites.includes(null), false, "cleanup must not clear a foreign replacement");
    const count = x.clones.length, info = x.nativeRequests[0].info;
    for (const factory of ["createContentWindow", "createContentWindowInFrame"]) {
      assert.throws(() => requestPrintClone(x.bridge(), factory, info));
    }
    const lateClose = x.clones[0].close({ late: true });
    assert.equal(lateClose.prevented, false); assert.equal(lateClose.stopped, false);
    assert.equal(x.owner.closed, false); assert.equal(x.owner.browserDOMWindow, foreignReadback);
    assert.equal(x.clones.length, count); x.assertCleaned();
    if (outcome !== "success") assertOldPDF(x);
  });
}

test("trusted DOMWindowClose closes only the owned clone and prevents closing its chrome owner", async () => {
  const x = printFixture({ delayed: true }), printing = x.start();
  await x.waitFor("print", printing);
  const clone = x.clones[0], bridge = x.owner.browserDOMWindow;
  const untrusted = clone.close({ isTrusted: false });
  assert.equal(untrusted.prevented, false); assert.equal(untrusted.stopped, false);
  assert.equal(clone.removed, undefined); assert.equal(clone.closeListeners.size, 1);
  const event = clone.close();
  assert.equal(event.prevented, true); assert.equal(event.stopped, true);
  assert.ok(clone.removed); assert.equal(clone.isConnected, false);
  assert.equal(x.owner.closed, false); assert.equal(x.frame().removed, undefined);
  assert.equal(x.owner.browserDOMWindow, bridge);
  assert.throws(() => requestPrintClone(bridge, "createContentWindow", x.nativeRequests[0].info),
    "closing the first clone must not grant a second clone");
  x.settle(); await printing; x.assertCleaned();
});

test("native print timeout disposes bridge and clone before a late print resolves", async () => {
  const x = printFixture({ delayed: true }), printing = x.start();
  await x.waitFor("print", printing);
  const rejection = assert.rejects(printing, /执行原生 PDF 打印失败.*超时/u);
  x.expire(); await rejection; x.assertCleaned(); assert.equal(x.owner.browserDOMWindow, null);
  for (const factory of ["createContentWindow", "createContentWindowInFrame"]) {
    assert.throws(() => requestPrintClone(x.bridge(), factory, x.nativeRequests[0].info));
  }
  x.settle(); await flushPrint(); assertOldPDF(x); x.assertCleaned();
});

test("bridge is not installed during image/font preparation or before successful settings initialization", async () => {
  for (const hold of ["fonts", "image"]) {
    const x = printFixture({ hold }), printing = x.start(); await x.waitFor(hold, printing);
    assert.equal(x.owner.browserDOMWindow, null); assert.deepEqual(x.bridgeWrites, []);
    const rejection = assert.rejects(printing, /暂停/u); x.cancel(); await rejection;
    x.release(hold); await flushPrint(); assert.deepEqual(x.bridgeWrites, []); x.assertCleaned();
  }
  const x = printFixture({ failure: "settings" });
  await assert.rejects(x.start(), error => assertOutputError(error, "配置 PDF 打印参数"));
  assert.deepEqual(x.bridgeWrites, []); x.assertCleaned();
});

test("same-window concurrent print cannot overwrite or dispose the first request's live bridge", async () => {
  const x = printFixture({ delayed: true }), first = x.start(); await x.waitFor("print", first);
  const bridge = x.owner.browserDOMWindow, firstFrame = x.frame();
  await assert.rejects(x.runtime.printPDF(x.owner, "second", "/data/task"), /失败/u);
  assert.equal(x.owner.browserDOMWindow, bridge);
  assert.equal(x.bridgeWrites.filter(Boolean).length, 1); assert.equal(x.calls.length, 1);
  assert.equal(x.clones[0].removed, undefined, "second request cannot remove the first request's clone");
  const rejection = assert.rejects(first, /暂停/u); x.cancel(); await rejection;
  x.settle(); await flushPrint(); assert.ok(firstFrame.removed);
  assert.equal(x.owner.browserDOMWindow, null); assertOldPDF(x); x.assertCleaned();
});

for (const bridgeFailure of ["qi", "set", "create", "listen", "append"]) {
  test(`${bridgeFailure} print bridge setup failure cleans partial resources without replacing the final PDF`, async () => {
    const x = printFixture({ bridgeFailure });
    await assert.rejects(x.start(), error => assertOutputError(error,
      ["qi", "set"].includes(bridgeFailure) ? "准备原生打印宿主" : "执行原生 PDF 打印"));
    assert.equal(x.owner.browserDOMWindow, null); assertOldPDF(x); x.assertCleaned();
    if (["qi", "set"].includes(bridgeFailure)) {
      assert.deepEqual(x.calls, []); assert.equal(x.clones.length, 0);
    } else {
      assert.equal(x.bridgeWrites.filter(Boolean).length, 1);
      assert.equal(x.clones.length, bridgeFailure === "create" ? 0 : 1);
    }
  });
}

for (const bridgeFailure of ["unlisten", "remove", "clear"]) {
  test(`${bridgeFailure} bridge cleanup exception does not skip remaining owned-resource cleanup`, async () => {
    const x = printFixture({ bridgeFailure, failure: "print" });
    await assert.rejects(x.start(), /失败/u);
    assert.equal(x.bridgeValue(), null); assertOldPDF(x); x.assertCleaned();
    assert.throws(() => requestPrintClone(x.bridge(), "createContentWindow", x.nativeRequests[0].info));
  });
}

for (const bridgeFailure of ["unlisten", "remove", "clear"]) {
  test(`${bridgeFailure} cleanup failure after native success blocks PDF validation and atomic replacement`, async () => {
    const x = printFixture({ bridgeFailure });
    await assert.rejects(x.start(), /清理(?:原生打印宿主| PDF 打印资源)失败/u);
    assert.deepEqual(x.calls.map(call => call[0]), ["print"]);
    assert.equal(x.bridgeValue(), null); assertOldPDF(x); x.assertCleaned();
  });
}

test("null native getter readback fails before print and invalidates the assigned bridge", async () => {
  const x = printFixture({ bridgeFailure: "readback-null" });
  await assert.rejects(x.start(), /准备原生打印宿主失败/u);
  assert.deepEqual(x.calls, []); assert.equal(x.clones.length, 0); assert.equal(x.owner.browserDOMWindow, null);
  assertOldPDF(x); x.assertCleaned();
  assert.equal(x.bridgeWrites.length, 1);
  assert.throws(() => requestPrintClone(x.bridgeWrites[0], "createContentWindow", { parent: x.frame().browsingContext }));
});

test("failed native getter readback never prints and leaves the installed callback inactive", async () => {
  const x = printFixture({ bridgeFailure: "readback" });
  await assert.rejects(x.start(), error => assertOutputError(error, "准备原生打印宿主"));
  assert.deepEqual(x.calls, []); assert.equal(x.clones.length, 0); assertOldPDF(x); x.assertCleaned();
  assert.equal(x.bridgeWrites.length, 1, "unreadable current identity must not be overwritten speculatively");
  assert.throws(() => requestPrintClone(x.bridgeValue(), "createContentWindow", { parent: x.frame().browsingContext }));
});

function exportFixture({ result = 0, selectedPath = "/exports/translated.md", pending = false, failure = "" } = {}) {
  const vm = require("node:vm"), fs = require("node:fs"), pathModule = require("node:path").posix;
  const ACP = require("../plugin/content/acp-client.js");
  const files = new Map([["/source/original.pdf", "original PDF"], ["/exports/translated.md", "old Markdown"]]);
  const dirs = new Set(["/", "/source", "/exports"]), links = new Set(), writes = [], imports = [], pathChecks = [];
  const owner = { closed: false, identity: "current confirmation window" }, pickers = [];
  let resolveDialog, notifyShown;
  const dialog = new Promise(resolve => { resolveDialog = resolve; });
  const shown = new Promise(resolve => { notifyShown = resolve; });
  const file = path => ({ path, initWithPath(value) { this.path = value; pathChecks.push(value); },
    get parent() { return this.path === "/" ? null : file(pathModule.dirname(this.path)); },
    exists() { return files.has(this.path) || dirs.has(this.path) || links.has(this.path); },
    isFile() { return files.has(this.path); }, isDirectory() { return dirs.has(this.path); }, isSymlink() { return links.has(this.path); }
  });
  class FilePicker {
    constructor() { this.modeSave = 1; this.returnOK = 0; this.returnCancel = 1; this.returnReplace = 2; this.filters = []; pickers.push(this); }
    init(actualOwner, title, mode) {
      this.owner = actualOwner; this.title = title; this.mode = mode;
      assert.equal(actualOwner, owner, "FilePicker must use the current confirmation window, not a cached/main window");
      if (failure === "init") throw nativeOutputException();
    }
    appendFilter(label, pattern) { this.filters.push([label, pattern]); }
    async show() { this.shown = true; notifyShown(); return pending ? dialog : result; }
    get file() { this.fileRead = true; return selectedPath; }
  }
  const scope = { TextEncoder, TextDecoder, URL, setTimeout, clearTimeout,
    SmartPaperTranslatorModules: { ACP: { toNativeAbsolutePath: value => ACP.toNativeAbsolutePath(value, false) } },
    Zotero: { DataDirectory: { dir: "/data" }, getMainWindow() { throw new Error("Must not substitute the main window"); } },
    PathUtils: { join: pathModule.join }, Ci: {},
    Cc: { "@mozilla.org/file/local;1": { createInstance: () => file() } },
    ChromeUtils: { importESModule(uri) {
      imports.push(uri); assert.equal(uri, "chrome://zotero/content/modules/filePicker.mjs"); return { FilePicker };
    } },
    IOUtils: { async writeUTF8(path, text, options) {
      writes.push({ path, text, options: { ...options } });
      assert.equal(options.tmpPath, path + ".spt-tmp");
      if (failure === "write") throw nativeOutputException();
      files.set(path, text);
    } }
  };
  vm.runInNewContext(fs.readFileSync(require.resolve("../plugin/content/fulltext-runtime.js"), "utf8"), scope);
  const runtime = new scope.SmartPaperTranslatorModules.FulltextRuntime.FulltextRuntime({});
  return { runtime, owner, files, dirs, links, writes, imports, pickers, pathChecks, shown,
    resolveDialog: () => resolveDialog(result),
    start: () => runtime.exportMarkdown(owner, "# 中文\n\n完整译文。", "/source/original.pdf")
  };
}

for (const [result, replace] of [[0, false], [2, true]]) {
  test(`Markdown export ${replace ? "replaces" : "creates"} the selected file atomically through the official owner-bound FilePicker`, async () => {
    const x = exportFixture({ result });
    if (!replace) x.files.delete("/exports/translated.md");
    assert.equal(await x.start(), true);
    assert.deepEqual(x.imports, ["chrome://zotero/content/modules/filePicker.mjs"]);
    assert.equal(x.pickers.length, 1);
    const picker = x.pickers[0];
    assert.equal(picker.owner, x.owner); assert.equal(picker.mode, picker.modeSave);
    assert.equal(picker.title, "导出中文 Markdown"); assert.equal(picker.defaultString, "translated.md");
    assert.deepEqual(picker.filters, [["Markdown", "*.md"]]); assert.equal(picker.shown, true);
    assert.deepEqual(x.writes, [{ path: "/exports/translated.md", text: "# 中文\n\n完整译文。",
      options: { tmpPath: "/exports/translated.md.spt-tmp" } }]);
    assert.deepEqual(x.pathChecks, ["/exports/translated.md", "/exports/translated.md.spt-tmp"]);
    assert.equal(x.files.get("/exports/translated.md"), "# 中文\n\n完整译文。");
    assert.equal(x.files.get("/source/original.pdf"), "original PDF");
  });
}

test("Markdown export cancellation never reads the selected path or writes a file", async () => {
  for (const result of [1, 99]) {
    const x = exportFixture({ result });
    assert.equal(await x.start(), false);
    assert.equal(x.pickers[0].fileRead, undefined); assert.deepEqual(x.pathChecks, []); assert.deepEqual(x.writes, []);
    assert.equal(x.files.get("/exports/translated.md"), "old Markdown");
  }
});

for (const close of ["owner", "runtime"]) {
  test(`Markdown export ignores dialog approval after ${close} closes`, async () => {
    const x = exportFixture({ pending: true, result: 2 });
    const exporting = x.start(); await x.shown;
    assert.equal(x.pickers[0].owner, x.owner); assert.deepEqual(x.writes, []);
    if (close === "owner") x.owner.closed = true;
    else await x.runtime.shutdown();
    x.resolveDialog(); assert.equal(await exporting, false);
    assert.equal(x.pickers[0].fileRead, undefined); assert.deepEqual(x.pathChecks, []); assert.deepEqual(x.writes, []);
    assert.equal(x.files.get("/exports/translated.md"), "old Markdown");
    assert.equal(x.files.get("/source/original.pdf"), "original PDF");
  });
}

test("Markdown export does not open a dialog for an already closed owner or stopped runtime", async () => {
  for (const close of ["owner", "runtime"]) {
    const x = exportFixture();
    if (close === "owner") x.owner.closed = true;
    else await x.runtime.shutdown();
    await assert.rejects(x.start(), /打开 Markdown 保存窗口失败.*关闭或插件已退出/u);
    assert.deepEqual(x.imports, []); assert.deepEqual(x.pickers, []); assert.deepEqual(x.writes, []);
  }
});

test("Markdown export rejects invalid native paths and never overwrites the original PDF", async () => {
  for (const selectedPath of ["", "translated.md", "~/translated.md", "C:\\translated.md", "/bad\0path", "/source/original.pdf"]) {
    const x = exportFixture({ selectedPath });
    await assert.rejects(x.start(), selectedPath === "/source/original.pdf"
      ? /检查 Markdown 保存路径失败.*不能覆盖原始 PDF/u
      : /检查 Markdown 保存路径失败.*Markdown 导出路径无效/u);
    assert.deepEqual(x.writes, []); assert.deepEqual(x.pathChecks, []);
    assert.equal(x.files.get("/source/original.pdf"), "original PDF");
    assert.equal(x.files.get("/exports/translated.md"), "old Markdown");
  }
});

test("Markdown export rejects symlinks in roots, ancestors, selected file and atomic temporary path", async () => {
  for (const link of ["/", "/exports", "/exports/translated.md", "/exports/translated.md.spt-tmp"]) {
    const x = exportFixture(); x.links.add(link);
    await assert.rejects(x.start(), /检查 Markdown 保存路径失败.*软链接/u);
    assert.deepEqual(x.writes, []); assert.equal(x.files.get("/exports/translated.md"), "old Markdown");
  }
});

test("Markdown export rejects directories and non-directory ancestors before writing", async () => {
  const directory = exportFixture({ selectedPath: "/exports" });
  await assert.rejects(directory.start(), /检查 Markdown 保存路径失败.*文件类型/u);
  assert.deepEqual(directory.writes, []);
  const parentFile = exportFixture({ selectedPath: "/exports/translated.md/child.md" });
  await assert.rejects(parentFile.start(), /检查 Markdown 保存路径失败.*父路径不是目录/u);
  assert.deepEqual(parentFile.writes, []);
});

for (const [failure, stage] of [["init", "打开 Markdown 保存窗口"], ["write", "写入 Markdown 文件"]]) {
  test(`Markdown ${failure} native exception preserves old files and reports bounded sanitized stage/nsresult`, async () => {
    const x = exportFixture({ failure });
    await assert.rejects(x.start(), error => assertOutputError(error, stage));
    assert.equal(x.files.get("/exports/translated.md"), "old Markdown");
    assert.equal(x.files.get("/source/original.pdf"), "original PDF");
    assert.equal(x.pickers[0].owner, x.owner);
    if (failure === "init") {
      assert.equal(x.pickers[0].shown, undefined); assert.deepEqual(x.pathChecks, []); assert.deepEqual(x.writes, []);
    } else {
      assert.equal(x.writes.length, 1); assert.equal(x.writes[0].options.tmpPath, "/exports/translated.md.spt-tmp");
    }
  });
}

function storageFixture() {
  const vm = require("node:vm"), fs = require("node:fs"), pathModule = require("node:path").posix;
  const files = new Map(), dirs = new Set(["/", "/task"]), links = new Set(), sizes = new Map(), writes = [], caches = [], imports = [];
  let beforeWrite = async () => {};
  const file = path => ({ path, initWithPath(value) { this.path = value; },
    get parent() { return this.path === "/" ? null : file(pathModule.dirname(this.path)); },
    exists() { return files.has(this.path) || dirs.has(this.path) || links.has(this.path); },
    isFile() { return files.has(this.path); }, isDirectory() { return dirs.has(this.path); }, isSymlink() { return links.has(this.path); } });
  class Cache { constructor(options) { this.options = options; caches.push(this); } cancel() { this.cancelled = true; } dispose() { this.disposed = true; } }
  const scope = { TextEncoder, TextDecoder, URL, setTimeout, clearTimeout,
    SmartPaperTranslatorModules: { ACP: { toNativeAbsolutePath: value => value.startsWith("/") ? value : null },
      FulltextImages: { ImageCache: Cache }, FulltextMarkdown: { imageInfo() {} },
      FulltextImageNetwork: { createFetch: ({ Components, Cr }) => {
        assert.equal(typeof Components.isSuccessCode, "function"); assert.ok(Cr);
        return () => { throw new Error("No real network in tests"); };
      } } },
    PathUtils: { join: pathModule.join, filename: pathModule.basename }, Ci: {}, Cr: {}, Components: { isSuccessCode: status => status === 0 }, Zotero: { DataDirectory: { dir: "/data" } },
    Cc: { "@mozilla.org/file/local;1": { createInstance: () => file() } },
    IOUtils: { exists: async path => files.has(path) || dirs.has(path), stat: async path => ({ size: sizes.get(path) ?? files.get(path).length }),
      read: async path => files.get(path), makeDirectory: async path => dirs.add(path),
      getChildren: async root => [...files.keys(), ...links].filter(path => pathModule.dirname(path) === root),
      write: async (path, bytes, options) => { writes.push({ path, options }); await beforeWrite(); files.set(path, bytes); } },
    ChromeUtils: { importESModule: uri => { imports.push(uri); return { XPCOMUtils: { defineLazyGlobalGetters(target, names) {
      assert.deepEqual(Array.from(names), ["AbortController"]); target.AbortController = AbortController;
    } } }; } }
  };
  vm.runInNewContext(fs.readFileSync(require.resolve("../plugin/content/fulltext-runtime.js"), "utf8"), scope);
  const api = scope.SmartPaperTranslatorModules.FulltextRuntime;
  return { api, files, dirs, links, sizes, writes, caches, imports, beforeWrite: fn => { beforeWrite = fn; } };
}

test("task storage allows only content-addressed document and original backup names", async () => {
  const f = storageFixture(), store = f.api.storeAt("/task");
  for (const name of [`document-${"a".repeat(64)}.json`, `original-${"b".repeat(64)}.md`]) {
    await store.writeText(name, "content"); assert.equal(await store.readText(name), "content");
  }
  for (const name of ["document-other.json", "original.md", "../source.md", "images/a.json"]) await assert.rejects(store.readText(name), /文件名/u);
});

test("image storage uses bounded local atomic files and rejects symlinks at every level", async () => {
  const f = storageFixture(), store = f.api.imageStorageAt("/task/images"), key = "a".repeat(64), path = `/task/images/${key}.json`;
  assert.equal(await store.read(key), null); assert.equal(f.writes.length, 0);
  await store.write(key, { schema: 1 }); assert.equal((await store.read(key)).schema, 1);
  assert.equal(f.writes[0].options.tmpPath, path + ".tmp");
  await assert.rejects(store.read("../escape"), /标识/u);
  for (const link of ["/task", "/task/images", path]) {
    f.links.add(link); await assert.rejects(store.read(key), /软链接/u); f.links.delete(link);
  }
  f.links.add(path + ".tmp"); await assert.rejects(store.write(key, {}), /软链接/u); f.links.clear();
  f.sizes.set(path, 18 * 1024 * 1024); await assert.rejects(store.read(key), /资源上限/u);
  f.sizes.clear(); f.files.set("/task/images/foreign.json", new Uint8Array());
  await assert.rejects(store.write(key, {}), /目录内容/u);
});

test("image storage enforces on-disk count and aggregate limits across reopened caches", async () => {
  const f = storageFixture(); f.dirs.add("/task/images");
  for (let i = 0; i < 128; i++) f.files.set(`/task/images/${i.toString(16).padStart(64, "0")}.json`, new TextEncoder().encode("{}"));
  const store = f.api.imageStorageAt("/task/images");
  await assert.rejects(store.write("f".repeat(64), {}), /总量/u);
  await store.write("0".repeat(64), {});
  for (const path of f.files.keys()) f.sizes.set(path, 1024 * 1024);
  await assert.rejects(store.write("0".repeat(64), {}), /总量/u);
});

test("serialized disk budget conservatively preserves 64MiB decoded limit after reopen", async () => {
  const f = storageFixture(); f.dirs.add("/task/images");
  const encodedTenMiB = Math.ceil(10 * 1024 * 1024 / 3) * 4;
  for (let i = 0; i < 6; i++) {
    const path = `/task/images/${i.toString(16).padStart(64, "0")}.json`;
    f.files.set(path, new TextEncoder().encode("{}")); f.sizes.set(path, encodedTenMiB + 256);
  }
  const reopened = f.api.imageStorageAt("/task/images");
  await assert.rejects(reopened.write("f".repeat(64), { dataURI: "data:image/png;base64," + "A".repeat(encodedTenMiB) }), /总量/u);
  assert.equal(f.writes.length, 0);
});

test("image writes are serialized and idle waits for committed bytes", async () => {
  const f = storageFixture(), store = f.api.imageStorageAt("/task/images"); let release;
  const gate = new Promise(resolve => { release = resolve; }); f.beforeWrite(() => gate);
  const first = store.write("a".repeat(64), {}), second = store.write("b".repeat(64), {});
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.writes.length, 1);
  let idle = false; const waiting = store.idle().then(() => { idle = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(idle, false);
  release(); await Promise.all([first, second, waiting]); assert.equal(f.writes.length, 2);
});

test("runtime image caches use the bounded manual-channel adapter, stay task-bound and drain writes on release", async () => {
  const f = storageFixture(), runtime = new f.api.FulltextRuntime({}), service = { state: { oxrBaseURL: "https://free-oxr.somark.cn/api/v1" }, pause: async () => {} };
  assert.throws(() => runtime.imageCacheFor(service), /已关闭/u);
  runtime.taskRoots.set(service, "/task");
  const first = runtime.imageCacheFor(service); assert.equal(runtime.imageCacheFor(service), first);
  assert.equal(f.imports[0], "resource://gre/modules/XPCOMUtils.sys.mjs");
  runtime.cancelImages(service); assert.equal(first.cancelled, true);
  service.state.oxrBaseURL = "https://free-oxr.somark.ai/api/v1";
  const second = runtime.imageCacheFor(service); assert.equal(first.disposed, true);
  assert.equal(first.options.storage, second.options.storage);
  let release; const gate = new Promise(resolve => { release = resolve; }); f.beforeWrite(() => gate);
  const write = second.options.storage.write("a".repeat(64), {});
  await new Promise(resolve => setImmediate(resolve));
  let closed = false; const closing = runtime.release(service).then(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(second.disposed, true); assert.equal(closed, false);
  release(); await write; await closing;
  assert.throws(() => runtime.imageCacheFor(service), /已关闭/u);
});

function printCacheFixture({ pending = false, result = PRINT_IMAGE_URI, failure = null } = {}) {
  const requests = [];
  let release, cancels = 0, acquisitions = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const cache = {
    async resolve(uri, options) {
      requests.push({ uri, options });
      assert.equal(typeof options?.isCurrent, "function", "cache work must be bound to print liveness");
      assert.equal(options.isCurrent(), true);
      if (pending) await gate;
      if (failure) throw failure;
      return result;
    },
    cancel() { cancels++; }
  };
  return { cache, requests, release,
    getCache() { acquisitions++; return cache; },
    acquisitions: () => acquisitions, cancels: () => cancels };
}
function assertPrintNotStarted(x) {
  assert.deepEqual(x.lifecycle, [], "image preparation must precede even iframe navigation/attachment");
  assert.deepEqual(x.bridgeWrites, [], "no native print host may exist during image preparation");
  assert.deepEqual(x.calls, []);
  assert.deepEqual(x.imports, []);
  assert.equal(x.clones.length, 0);
  assertOldPDF(x);
}
function assertImagePreparationCleaned(x) {
  assertPrintNotStarted(x);
  assert.equal(x.timers.size, 0); assert.equal(x.listeners.size, 0);
  if (x.frame()) x.assertCleaned();
}

for (const cacheKind of ["memory", "disk"]) {
  test(`print embeds real Markdown and HTML images from existing ${cacheKind} task cache without fetching`, async () => {
    const { ImageCache } = require("../plugin/content/fulltext-images.js");
    const { imageInfo } = require("../plugin/content/fulltext-markdown.js");
    const hash = value => require("node:crypto").createHash("sha256").update(value).digest("hex");
    const record = { schema: 1, urlHash: hash(PRINT_REMOTE_URI), contentHash: hash(PRINT_IMAGE_URI),
      mime: "image/png", dataURI: PRINT_IMAGE_URI };
    let reads = 0, fetches = 0, acquired = 0;
    const cache = new ImageCache({ baseURL: "https://images.example/", AbortController, hash, validateImage: imageInfo,
      fetch() { fetches++; throw new Error("Real or simulated fetch is unnecessary for a prefilled cache"); },
      storage: { async read(key) { reads++; assert.equal(key, record.urlHash); return record; },
        async write() { throw new Error("A validated existing cache must not be rewritten"); } } });
    try {
      if (cacheKind === "memory") await cache.resolve(PRINT_REMOTE_URI);
      const priorReads = reads;
      const x = printFixture();
      await x.start(printMarkdown(`![Markdown](${PRINT_REMOTE_URI})\n\n<img src="${PRINT_REMOTE_URI}" alt="HTML">`), () => {
        acquired++; assertPrintNotStarted(x);
        assert.equal(x.rendered[0].registered, true, "register cancellation before rendering or cache access");
        return cache;
      });
      assert.equal(acquired, 1); assert.equal(fetches, 0);
      assert.equal(reads - priorReads, cacheKind === "disk" ? 1 : 0);
      assert.deepEqual(x.remoteImages, [PRINT_REMOTE_URI, PRINT_REMOTE_URI]);
      assert.equal(x.imageCommits.length, 2);
      assert.equal(x.loaded().images.length, 2, "URLs must become actual images, not printed Markdown placeholders");
      assert.deepEqual(x.loaded().images.map(image => image.getAttribute("src")), [PRINT_IMAGE_URI, PRINT_IMAGE_URI]);
      assert.doesNotMatch(x.loaded().body.textContent, /PRIVATE_IMAGE_TOKEN|!\[|<img/u);
      assert.deepEqual(x.calls.map(call => call[0]), ["print", "preview", "move"]); x.assertCleaned();
    } finally { cache.dispose(); }
  });
}

for (const source of ["没有图片的正文。", `[普通链接](${PRINT_REMOTE_URI})`,
  `\`![行内代码](${PRINT_REMOTE_URI})\``,
  `\`\`\`markdown\n![代码示例](${PRINT_REMOTE_URI})\n<img src="${PRINT_REMOTE_URI}">\n\`\`\``,
  `![已嵌入](${PRINT_IMAGE_URI})`]) {
  test(`print keeps cache lazy for non-remote-image source ${source.slice(0, 24)}`, async () => {
    const x = printFixture();
    await x.start(printMarkdown(source), () => { throw new Error("Image-free/embedded-only output must not acquire a task cache"); });
    assert.deepEqual(x.remoteImages, []); assert.deepEqual(x.imageCommits, []);
    assert.equal(x.loaded().images.length, source.startsWith("![已嵌入]") ? 1 : 0);
    assert.deepEqual(x.calls.map(call => call[0]), ["print", "preview", "move"]); x.assertCleaned();
  });
}

test("print resolves each raw URI once, sequentially, and waits for every image before navigation or native host", async () => {
  const x = printFixture(), requests = [], releases = [];
  const second = "https://images.example/second.png";
  let acquisitions = 0;
  const cache = { cancel() {}, resolve(uri, options) {
    requests.push({ uri, options });
    assert.equal(options.isCurrent(), true); assertPrintNotStarted(x);
    return new Promise(resolve => releases.push(() => resolve(PRINT_IMAGE_URI)));
  } };
  const printing = x.start(printMarkdown(`![一](${PRINT_REMOTE_URI}) ![二](${PRINT_REMOTE_URI})\n\n<img src="${second}">`),
    () => { acquisitions++; return cache; });
  printing.catch(() => {}); await flushPrint();
  assert.deepEqual(requests.map(request => request.uri), [PRINT_REMOTE_URI]);
  assert.equal(x.imageCommits.length, 0); assertPrintNotStarted(x);
  releases[0](); await flushPrint();
  assert.deepEqual(requests.map(request => request.uri), [PRINT_REMOTE_URI, second]);
  assert.equal(x.imageCommits.length, 2); assertPrintNotStarted(x);
  releases[1](); await printing;
  assert.equal(acquisitions, 1); assert.equal(x.loaded().images.length, 3);
  assert.equal(x.imageCommits.length, 3); x.assertCleaned();
});

for (const kind of ["absent callback", "null cache", "missing resolve", "missing cancel", "throwing factory", "throwing resolver", "empty result", "external result", "SVG result", "invalid signature", "oversized pixels", "oversized bytes"]) {
  test(`remote print image ${kind} fails closed before printing or final replacement`, async () => {
    const x = printFixture();
    let result = PRINT_IMAGE_URI;
    if (kind === "empty result") result = null;
    if (kind === "external result") result = PRINT_REMOTE_URI;
    if (kind === "SVG result") result = "data:image/svg+xml;base64,PHN2Zy8+";
    if (kind === "invalid signature") result = "data:image/png;base64,AAAA";
    if (kind === "oversized pixels") {
      const bytes = Buffer.from(PRINT_IMAGE_URI.split(",")[1], "base64"); bytes.writeUInt32BE(16385, 16);
      result = "data:image/png;base64," + bytes.toString("base64");
    }
    if (kind === "oversized bytes") result = "data:image/png;base64," + Buffer.alloc(12 * 1024 * 1024 + 1).toString("base64");
    const f = printCacheFixture({ result, failure: kind === "throwing resolver" ? new Error("图片下载失败") : null });
    const factory = kind === "absent callback" ? undefined : kind === "null cache" ? () => null
      : kind === "missing resolve" ? () => ({ cancel() {} }) : kind === "missing cancel" ? () => ({ resolve: f.cache.resolve })
        : kind === "throwing factory" ? () => { throw new Error("缓存不可用"); } : f.getCache;
    await assert.rejects(x.start(printMarkdown(`![图片](${PRINT_REMOTE_URI})`), factory));
    assert.equal(x.imageCommits.length, 0);
    assert.deepEqual(x.imageSources, [], "invalid resolver output cannot become a DOM src");
    assertImagePreparationCleaned(x);
    if (!["absent callback", "null cache", "missing resolve", "missing cancel", "throwing factory"].includes(kind)) {
      assert.ok(f.cancels() >= 1, "errors must cancel pending task image work");
      assert.equal(f.requests[0].options.isCurrent(), false);
    }
  });
}

test("remote image count is bounded at 128 distinct URIs before any cache work or frame navigation", async () => {
  const x = printFixture(), f = printCacheFixture();
  const source = Array.from({ length: 129 }, (_, i) => `![${i}](https://images.example/${i}.png)`).join("\n\n");
  await assert.rejects(x.start(printMarkdown(source), f.getCache), /图片|资源|上限/u);
  assert.equal(f.acquisitions(), 0); assert.deepEqual(f.requests, []);
  assertImagePreparationCleaned(x);
});

test("128 distinct remote images are accepted and repeated placeholders do not consume distinct-URI budget", async () => {
  for (const unique of [true, false]) {
    const x = printFixture(), f = printCacheFixture();
    const count = unique ? 128 : 129;
    const source = Array.from({ length: count }, (_, i) => `![${i}](https://images.example/${unique ? i : 0}.png)`).join("\n\n");
    await x.start(printMarkdown(source), f.getCache);
    assert.equal(f.requests.length, unique ? 128 : 1); assert.equal(f.acquisitions(), 1);
    assert.equal(x.loaded().images.length, count); assert.equal(x.imageCommits.length, count); x.assertCleaned();
  }
});

test("real renderer aggregate embedded-image byte limit still applies to repeated resolved placeholders", async () => {
  const bytes = Buffer.alloc(2 * 1024 * 1024);
  Buffer.from(PRINT_IMAGE_URI.split(",")[1], "base64").copy(bytes);
  const f = printCacheFixture({ result: "data:image/png;base64," + bytes.toString("base64") }), x = printFixture();
  const source = Array.from({ length: 33 }, () => `![重复](${PRINT_REMOTE_URI})`).join("\n\n");
  await assert.rejects(x.start(printMarkdown(source), f.getCache), /64 MiB|总量|上限/u);
  assert.equal(f.requests.length, 1); assert.ok(f.cancels() >= 1);
  assertImagePreparationCleaned(x);
});

test("synchronous cancellation during registration precedes rendering, cache acquisition and navigation", async () => {
  const x = printFixture(), f = printCacheFixture();
  await assert.rejects(x.start(printMarkdown(`![图片](${PRINT_REMOTE_URI})`), f.getCache, { cancelOnRegister: true }), /暂停/u);
  assert.deepEqual(x.rendered, []); assert.equal(f.acquisitions(), 0);
  assertImagePreparationCleaned(x);
});

for (const ending of ["cancel", "owner close", "runtime shutdown", "owner document replacement"]) {
  test(`${ending} during image preparation rejects late results and never commits images, prints or moves PDF`, async () => {
    const x = printFixture(), f = printCacheFixture({ pending: true });
    const printing = x.start(printMarkdown(`![图片](${PRINT_REMOTE_URI})`), f.getCache);
    const rejection = assert.rejects(printing); await flushPrint();
    assert.equal(f.requests.length, 1); assertPrintNotStarted(x);
    if (ending === "cancel") x.cancel();
    else if (ending === "owner close") x.owner.closed = true;
    else if (ending === "runtime shutdown") await x.runtime.shutdown();
    else x.owner.document = {};
    if (ending === "cancel") {
      await flushPrint(); assert.equal(x.settled(), true, "cancellation cannot wait for an uncooperative resolver");
      assert.ok(f.cancels() >= 1);
    }
    assert.equal(f.requests[0].options.isCurrent(), false);
    f.release(); await rejection; await flushPrint();
    assert.ok(f.cancels() >= 1); assert.equal(x.imageCommits.length, 0); assert.deepEqual(x.imageSources, []);
    assertImagePreparationCleaned(x);
  });
}

for (const ending of ["owner close", "runtime shutdown"]) {
  test(`${ending} before print prevents rendering and task cache acquisition`, async () => {
    const x = printFixture(), f = printCacheFixture();
    if (ending === "owner close") x.owner.closed = true; else await x.runtime.shutdown();
    await assert.rejects(x.start(printMarkdown(`![图片](${PRINT_REMOTE_URI})`), f.getCache));
    assert.deepEqual(x.rendered, []); assert.equal(f.acquisitions(), 0);
    assertPrintNotStarted(x); assert.equal(x.timers.size, 0);
  });
}

test("embedded image validation failure remains fatal without acquiring a remote image cache", async () => {
  const x = printFixture(), f = printCacheFixture();
  await assert.rejects(x.start(printMarkdown("![坏图](data:image/png;base64,AAAA)"), f.getCache));
  assert.equal(f.acquisitions(), 0); assert.deepEqual(x.imageSources, []); assertImagePreparationCleaned(x);
});

test("image-ready print still waits for real DOM decode and cancels its task cache on decode failure", async () => {
  const x = printFixture({ failedImage: true }), f = printCacheFixture();
  await assert.rejects(x.start(printMarkdown(`![图片](${PRINT_REMOTE_URI})`), f.getCache), /图片解码/u);
  assert.equal(x.imageCommits.length, 1); assert.equal(x.loaded().images.length, 1);
  assert.ok(f.cancels() >= 1); assert.deepEqual(x.calls, []); assert.deepEqual(x.bridgeWrites, []);
  assertOldPDF(x); x.assertCleaned();
});

for (const timeout of [false, true]) {
  test(`real task ImageCache ${timeout ? "timeout rejects late download" : "fills missing image before print"} without DOM networking`, async () => {
    const { ImageCache } = require("../plugin/content/fulltext-images.js");
    const { imageInfo } = require("../plugin/content/fulltext-markdown.js");
    const x = printFixture(), requests = [], records = [];
    let release, cancels = 0, reads = 0;
    const download = new Promise(resolve => { release = resolve; });
    const cache = new ImageCache({ baseURL: "https://images.example/", AbortController,
      hash: value => require("node:crypto").createHash("sha256").update(value).digest("hex"),
      validateImage: imageInfo,
      fetch: async (uri, options) => { requests.push({ uri, options }); return download; },
      storage: { async read() { return null; }, async write(key, value) { records.push({ key, value }); } },
      timers: { setTimeout(fn, ms) { const timer = { fn, ms }; x.timers.add(timer); return timer; },
        clearTimeout(timer) { x.timers.delete(timer); } } });
    const printing = x.start(printMarkdown(`![自动补齐](${PRINT_REMOTE_URI})`), () => ({
      resolve: (...args) => cache.resolve(...args), cancel() { cancels++; cache.cancel(); }
    }));
    const outcome = timeout ? assert.rejects(printing, /准备 PDF 图片失败.*下载超时/u) : printing;
    outcome.catch(() => {});
    try {
      await flushPrint(); assertPrintNotStarted(x);
      assert.equal(requests.length, 1); assert.equal(requests[0].uri, PRINT_REMOTE_URI);
      const { signal, ...options } = requests[0].options;
      assert.deepEqual(options, { method: "GET", credentials: "omit", redirect: "manual", referrerPolicy: "no-referrer", cache: "no-store" });
      assert.equal(signal.aborted, false);
      assert.equal([...x.timers][0].ms, 15000, "download reuses the task cache's bounded deadline");
      if (timeout) {
        x.expire(); await outcome;
        assert.equal(signal.aborted, true); assert.ok(cancels >= 1); assertImagePreparationCleaned(x);
      }
      let delivered = false;
      release({ status: 200, redirected: false, url: PRINT_REMOTE_URI,
        headers: { get: key => key === "content-type" ? "image/png" : null },
        body: { getReader: () => ({ async read() {
          reads++;
          if (delivered) return { done: true };
          delivered = true; return { done: false, value: new Uint8Array(Buffer.from(PRINT_IMAGE_URI.split(",")[1], "base64")) };
        }, cancel() {}, releaseLock() {} }) } });
      await outcome; await flushPrint();
      if (timeout) {
        assert.equal(reads, 0); assert.deepEqual(records, []); assert.deepEqual(x.imageCommits, []);
        assert.deepEqual(x.imageSources, []); assertImagePreparationCleaned(x);
      } else {
        assert.equal(records.length, 1); assert.equal(records[0].value.dataURI, PRINT_IMAGE_URI);
        assert.doesNotMatch(JSON.stringify(records), /images\.example|PRIVATE_IMAGE_TOKEN/u);
        assert.equal(x.loaded().images.length, 1); assert.equal(x.loaded().images[0].getAttribute("src"), PRINT_IMAGE_URI);
        assert.deepEqual(x.calls.map(call => call[0]), ["print", "preview", "move"]); x.assertCleaned();
      }
    } finally { cache.dispose(); }
  });
}

for (const hold of ["fonts", "image", "print"]) {
  test(`cancellation after remote image preparation during ${hold} also cancels cache and blocks late PDF move`, async () => {
    const x = printFixture({ hold }), f = printCacheFixture();
    const printing = x.start(printMarkdown(`![图片](${PRINT_REMOTE_URI})`), f.getCache);
    await x.waitFor(hold, printing);
    assert.equal(f.requests.length, 1); assert.equal(x.imageCommits.length, 1);
    const rejection = assert.rejects(printing, /暂停/u); x.cancel(); await rejection;
    assert.ok(f.cancels() >= 1); assert.equal(f.requests[0].options.isCurrent(), false);
    x.release(hold); await flushPrint(); assertOldPDF(x); x.assertCleaned();
  });
}

test("service PDF factory supplies the current service task cache lazily as the fifth print argument", () => {
  const source = require("node:fs").readFileSync(require.resolve("../plugin/content/fulltext-runtime.js"), "utf8");
  assert.match(source, /createPDF:\s*\(owner, markdown, registerCancel\)\s*=>\s*this\.printPDF\(owner, markdown, taskRoot, registerCancel,\s*\(\)\s*=>\s*this\.imageCacheFor\(service\)\)/u);
});

test("Python diagnostic stderr is not leaked into public errors", async () => {
  const process = processMock("not json", 1); process.stderr = pipe(["PRIVATE_PAPER_CONTENT secret-key"]);
  await assert.rejects(collectProcess(process, { timeoutMS: 1000 }), error => !error.message.includes("PRIVATE") && !error.message.includes("secret"));
});
