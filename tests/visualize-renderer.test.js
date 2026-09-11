"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const V = require("../plugin/content/visualize-renderer.js");

const marker = path => V.MARKER_START + JSON.stringify({ path, title: "趋势与残差", mode: "wide" }) + "\uE201";
const html = '<div id="demo">图表</div><script src="' + V.D3_URL + '"></script><script>d3.select("#demo");</script>';
const runtime = { d3: "window.d3={};", theme: "body{color:var(--foreground)}", token: "test-token-1234" };

test("visualize marker accepts real Unicode delimiters and bounds malformed/incomplete data", () => {
  const text = marker("/paper/output/a.html");
  assert.deepEqual(V.parseMarkerAt("x" + text, 1), {
    raw: text, length: text.length, path: "/paper/output/a.html", title: "趋势与残差", wide: true
  });
  for (const text of [V.MARKER_START + "{}\uE201", V.MARKER_START + "null\uE201",
    V.MARKER_START + "[]\uE201", V.MARKER_START + "{bad}\uE201", marker("\0a.html"),
    marker("a".repeat(5000)), marker("a.html").slice(0, -1)]) assert.equal(V.parseMarkerAt(text), null);
});

test("visualization paths remain within the exact workspace and reject traversal and URI schemes", () => {
  assert.equal(V.workspaceFile("/papers/one/", "./output/a.html"), "/papers/one/output/a.html");
  assert.equal(V.workspaceFile("/papers/one", "/papers/one/output/a.HTML"), "/papers/one/output/a.HTML");
  for (const path of ["../two/a.html", "/papers/one-other/a.html", "/papers/two/a.html",
    "file:///papers/one/a.html", "https://example.com/a.html", "a.svg", "a.html\0", "x\\a.html"]) {
    assert.throws(() => V.workspaceFile("/papers/one", path));
  }
  assert.throws(() => V.workspaceFile("/", "a.html"));
});

test("Windows drive and UNC workspaces keep native paths while enforcing the workspace boundary", () => {
  assert.equal(V.workspaceFile("C:/Users/AimMetal/Zotero/spt/workspaces/1--ABCDEFGH/session-1", "output/chart.html"),
    "C:\\Users\\AimMetal\\Zotero\\spt\\workspaces\\1--ABCDEFGH\\session-1\\output\\chart.html");
  assert.equal(V.workspaceFile("\\\\server\\share\\spt\\session-1", "output/chart.html"),
    "\\\\server\\share\\spt\\session-1\\output\\chart.html");
  for (const path of ["../escape.html", "C:/Users/AimMetal/Zotero/other.html", "\\\\server\\share\\other.html",
    "https://example.com/chart.html", "chart.svg"]) {
    assert.throws(() => V.workspaceFile("C:/Users/AimMetal/Zotero/spt/session-1", path));
  }
});

function fixture() {
  const bytes = new TextEncoder().encode(html);
  return {
    bytes, inspected: [], reads: 0, kinds: new Map(),
    async inspectPath(path) {
      this.inspected.push(path);
      return this.kinds.get(path) || { type: path.endsWith(".html") ? "regular" : "directory", symlink: false, size: this.bytes.length, lastModified: 1 };
    },
    async read(path, options) { this.reads++; assert.equal(options.maxBytes, V.MAX_BYTES + 1); return this.bytes; }
  };
}

test("HTML reads reject links in every path component, non-files, oversize and malformed UTF-8", async () => {
  const io = fixture();
  assert.equal((await V.readWorkspaceHTML(io, "/papers/one", "a.html")).html, html);
  assert.deepEqual(io.inspected, ["/papers", "/papers/one", "/papers/one/a.html", "/papers", "/papers/one", "/papers/one/a.html"]);
  for (const path of ["/papers", "/papers/one", "/papers/one/a.html"]) {
    const io = fixture(); io.kinds.set(path, { type: "regular", symlink: true });
    await assert.rejects(V.readWorkspaceHTML(io, "/papers/one", "a.html"), /软链接/);
    assert.equal(io.reads, 0);
  }
  const large = fixture(); large.bytes = new Uint8Array(V.MAX_BYTES + 1);
  await assert.rejects(V.readWorkspaceHTML(large, "/papers/one", "a.html"), /1 MiB/);
  assert.equal(large.reads, 0);
  const invalid = fixture(); invalid.bytes = Uint8Array.from([0xff, 0xfe]);
  await assert.rejects(V.readWorkspaceHTML(invalid, "/papers/one", "a.html"), /UTF-8/);
  const changed = fixture(); changed.read = async function () { const b = this.bytes; this.bytes = new Uint8Array(1); return b; };
  await assert.rejects(V.readWorkspaceHTML(changed, "/papers/one", "a.html"), /发生变化/);
});

test("HTML reads inspect Windows drive components with native separators", async () => {
  const io = fixture();
  assert.equal((await V.readWorkspaceHTML(io, "C:/Users/AimMetal/Zotero/spt/session-1", "output/chart.html")).html, html);
  assert.deepEqual(io.inspected, [
    "C:", "C:\\Users", "C:\\Users\\AimMetal", "C:\\Users\\AimMetal\\Zotero",
    "C:\\Users\\AimMetal\\Zotero\\spt", "C:\\Users\\AimMetal\\Zotero\\spt\\session-1",
    "C:\\Users\\AimMetal\\Zotero\\spt\\session-1\\output",
    "C:\\Users\\AimMetal\\Zotero\\spt\\session-1\\output\\chart.html",
    "C:", "C:\\Users", "C:\\Users\\AimMetal", "C:\\Users\\AimMetal\\Zotero",
    "C:\\Users\\AimMetal\\Zotero\\spt", "C:\\Users\\AimMetal\\Zotero\\spt\\session-1",
    "C:\\Users\\AimMetal\\Zotero\\spt\\session-1\\output",
    "C:\\Users\\AimMetal\\Zotero\\spt\\session-1\\output\\chart.html"
  ]);
});

test("only the pinned D3 URL is replaced; unsupported dependencies fail explicitly", () => {
  assert.equal(V.replaceBundledScripts(html), '<div id="demo">图表</div><script>d3.select("#demo");</script>');
  for (const url of ["https://evil.invalid/d3.js", V.D3_URL + "?x", "file:///secret.js", "https://cdn.jsdelivr.net/npm/d3@latest/dist/d3.min.js"]) {
    assert.throws(() => V.replaceBundledScripts(html.replace(V.D3_URL, url)), /未内置/);
  }
});

test("model HTML stays encoded inside the opaque inner frame and cannot close the trusted shell", () => {
  const document = V.buildDocument(html + '"><script>parent.attack()</script>', runtime);
  assert.equal(document.includes('allow-same-origin'), false);
  assert.equal(document.includes('src="https:'), false);
  assert.ok(document.includes('sandbox="allow-scripts"'));
  assert.ok(document.includes('sandbox=&quot;') === false); // No model frame is required by this fixture.
  assert.ok(document.includes('frame-src \'none\''));
  assert.ok(document.includes('connect-src \'none\''));
  assert.ok(document.includes('&lt;script>parent.attack()&lt;/script>'));
  assert.equal(document.includes('<script>parent.attack()'), false);
  assert.ok(document.includes('event.source !== child.contentWindow'));
  assert.throws(() => V.buildDocument(html, { ...runtime, token: '\"></script>' }));
});

class Element {
  constructor(name) { this.localName = name; this.children = []; this.events = new Map(); this.attributes = new Map(); this.style = {}; this.srcdoc = ""; this.sandbox = ""; this.contentWindow = {}; }
  append(...nodes) { for (const node of nodes) { node.parentNode = this; this.children.push(node); } }
  setAttribute(name, value) { this.attributes.set(name, value); }
  addEventListener(name, fn) { this.events.set(name, fn); }
  removeEventListener(name) { this.events.delete(name); }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(x => x !== this); }
  focus() {}
}
function dom() {
  const listeners = new Map(); const timers = new Map(); let id = 0;
  const win = {
    crypto: { randomUUID: () => "fixture-token-1234" },
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: name => listeners.delete(name),
    setTimeout: fn => { timers.set(++id, fn); return id; }, clearTimeout: id => timers.delete(id)
  };
  return { doc: { defaultView: win, createElement: name => new Element(name), createElementNS: (_ns, name) => new Element(name) }, listeners, timers };
}
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

test("mount ignores stale loads and untrusted messages and removes frames/listeners on cleanup", async () => {
  const { doc, listeners, timers } = dom();
  const card = new Element("span");
  const renderer = V.createRenderer({ rootURI: "file:///plugin/", readResource: async url => url.endsWith('.css') ? runtime.theme : runtime.d3 });
  let finish, cleanup;
  renderer.mount(doc, card, { reference: { title: "test", path: "a.html" }, load: () => new Promise(resolve => { finish = resolve; }), registerCleanup: fn => { cleanup = fn; } });
  cleanup(); finish({ html }); await flush();
  assert.equal(card.children[2].children.length, 0);
  assert.equal(listeners.size, 0);
  const clean = renderer.mount(doc, card, { reference: { title: "test", path: "a.html" }, load: async () => ({ html }) });
  await flush();
  const stage = card.children.at(-1), frame = stage.children[0];
  assert.equal(frame.attributes.get('sandbox'), 'allow-scripts');
  const receive = listeners.get('message');
  receive({ source: {}, data: { sptVisualize: "fixture-token-1234", type: "ready", height: 800 } });
  assert.equal(frame.style.height, undefined);
  receive({ source: frame.contentWindow, data: { sptVisualize: "fixture-token-1234", type: "ready", height: 999999 } });
  assert.equal(frame.style.height, "1600px");
  assert.equal(timers.size, 0);
  receive({ source: frame.contentWindow, data: { sptVisualize: "fixture-token-1234", type: "blocked" } });
  assert.equal(stage.children.length, 0);
  assert.equal(listeners.size, 0);
  clean(); renderer.shutdown();
});

test("installed XPI resources use Zotero's UTF-8 resource reader instead of its URI request result", async () => {
  const reads = [];
  const scope = {
    module: { exports: {} },
    Zotero: { File: {
      getContentsAsync() { throw new Error("jar URI returns an XMLHttpRequest, not source text"); },
      async getResourceAsync(uri) {
        reads.push(uri);
        return uri.endsWith(".css") ? runtime.theme : runtime.d3;
      }
    } }
  };
  vm.runInNewContext(fs.readFileSync(require.resolve("../plugin/content/visualize-renderer.js"), "utf8"), scope);
  const renderer = scope.module.exports.createRenderer({ rootURI: "jar:file:///profile/extensions/spt@zotero.local.xpi!/" });
  const { doc } = dom(), card = new Element("span");
  renderer.mount(doc, card, { reference: { title: "test", path: "a.html" }, load: async () => ({ html }) });
  await flush();
  assert.deepEqual(reads, [
    "jar:file:///profile/extensions/spt@zotero.local.xpi!/content/vendor/d3/d3.min.js",
    "jar:file:///profile/extensions/spt@zotero.local.xpi!/content/visualize-theme.css"
  ]);
  assert.ok(card.children[2].children[0].srcdoc.includes(runtime.d3));
  renderer.shutdown();
});

test("invalid resource results fail before iframe creation and a retry reads resources again", async () => {
  let invalid = true;
  const { doc, timers } = dom(), card = new Element("span");
  const renderer = V.createRenderer({ rootURI: "jar:file:///plugin.xpi!/", readResource: async uri => {
    if (invalid) return { responseText: "should not be stringified" };
    return uri.endsWith(".css") ? runtime.theme : runtime.d3;
  } });
  renderer.mount(doc, card, { reference: { title: "test", path: "a.html" }, load: async () => ({ html }) });
  await flush();
  assert.match(card.children[1].textContent, /离线资源未返回有效文本/);
  assert.equal(card.children[2].children.length, 0);
  assert.equal(timers.size, 0);
  invalid = false;
  card.children[0].children[2].events.get("click")();
  await flush();
  assert.equal(card.children[2].children.length, 1);
  renderer.shutdown();
});

test("relay is listening before the child parses and forwards an immediate script failure", () => {
  const documentText = V.buildDocument(html, runtime);
  const script = documentText.match(/<script>([\s\S]*?)<\/script>/u);
  assert.ok(script && script.index < documentText.indexOf("<iframe"));
  const listeners = new Map(), messages = [];
  let child = null;
  vm.runInNewContext(script[1], {
    document: { querySelector: () => child, documentElement: { setAttribute() {} } },
    addEventListener: (type, callback) => listeners.set(type, callback),
    parent: { postMessage: (message, origin) => messages.push({ ...message, origin }) }
  });
  child = { contentWindow: {}, style: {} };
  listeners.get("message")({ source: child.contentWindow, data: { sptVisualize: runtime.token, type: "error" } });
  assert.deepEqual(messages, [{ sptVisualize: runtime.token, type: "error", height: 480, origin: "*" }]);
  listeners.get("message")({ source: {}, data: { sptVisualize: runtime.token, type: "error" } });
  assert.equal(messages.length, 1);
});

test("trusted outer status remains available when Gecko denies postMessage to chrome", () => {
  const script = V.buildDocument(html, runtime).match(/<script>([\s\S]*?)<\/script>/u)[1];
  const listeners = new Map(), attributes = new Map();
  const child = { contentWindow: {}, style: {} };
  vm.runInNewContext(script, {
    document: { querySelector: () => child, documentElement: { setAttribute: (key, value) => attributes.set(key, value) } },
    addEventListener: (type, callback) => listeners.set(type, callback),
    parent: { postMessage() { throw new Error("Permission denied to access property postMessage"); } }
  });
  const data = { sptVisualize: runtime.token, type: "ready", height: 510 };
  listeners.get("message")({ source: {}, data });
  assert.equal(attributes.size, 0);
  listeners.get("message")({ source: child.contentWindow, data });
  assert.deepEqual(JSON.parse(attributes.get("data-spt-visualize-status")), data);
  listeners.get("message")({ source: child.contentWindow, data: { ...data, type: "error" } });
  assert.equal(JSON.parse(attributes.get("data-spt-visualize-status")).type, "error");
});

test("native status observation consumes early status, validates token/document and disconnects on cleanup", async () => {
  const { doc, timers } = dom(), card = new Element("span");
  const observers = [];
  doc.defaultView.MutationObserver = class {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe(root, options) { this.root = root; this.options = options; }
    disconnect() { this.disconnected = true; }
  };
  const renderer = V.createRenderer({ rootURI: "jar:file:///plugin.xpi!/", readResource: async uri => uri.endsWith(".css") ? runtime.theme : runtime.d3 });
  const cleanup = renderer.mount(doc, card, { reference: { title: "test", path: "a.html" }, load: async () => ({ html }) });
  await flush();
  const frame = card.children[2].children[0], root = new Element("html");
  root.getAttribute = name => root.attributes.get(name);
  const outer = { documentURI: "about:srcdoc", documentElement: root };
  frame.contentDocument = outer;
  const set = (token, height, type = "ready") => root.setAttribute("data-spt-visualize-status", JSON.stringify({ sptVisualize: token, type, height }));
  set("fixture-token-1234", 500);
  frame.events.get("load")();
  assert.equal(frame.style.height, "500px");
  assert.equal(timers.size, 0);
  assert.deepEqual(observers[0].options, { attributes: true, attributeFilter: ["data-spt-visualize-status"] });
  set("wrong-token", 800); observers[0].callback();
  assert.equal(frame.style.height, "500px");
  frame.contentDocument = { ...outer };
  set("fixture-token-1234", 900); observers[0].callback();
  assert.equal(frame.style.height, "500px");
  frame.contentDocument = outer;
  root.setAttribute("data-spt-visualize-status", "{".repeat(1025)); observers[0].callback();
  set("fixture-token-1234", 650); observers[0].callback();
  assert.equal(frame.style.height, "650px");
  cleanup();
  assert.equal(observers[0].disconnected, true);
  assert.equal(frame.events.has("load"), false);
  set("fixture-token-1234", 900); observers[0].callback();
  assert.equal(frame.style.height, "650px");
  renderer.shutdown();
});

test("bundled runtime has the documented fixed version and integrity", () => {
  const crypto = require('node:crypto');
  const file = fs.readFileSync(require('node:path').join(__dirname, '../plugin/content/vendor/d3/d3.min.js'));
  const readme = fs.readFileSync(require('node:path').join(__dirname, '../plugin/content/vendor/d3/README.md'), 'utf8');
  assert.match(file.toString('utf8').slice(0, 100), /d3js\.org v7\.9\.0/);
  assert.ok(readme.includes(crypto.createHash('sha256').update(file).digest('hex')));
});
