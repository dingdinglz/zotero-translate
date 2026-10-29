"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { FulltextUI } = require("../plugin/content/fulltext-ui.js");
const URI = "chrome://smart-paper-translator/content/fulltext.xhtml";
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
class Events {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  dispatchEvent(event) {
    event.target ||= this;
    event.preventDefault ||= () => { event.defaultPrevented = true; };
    for (const fn of [...(this.listeners.get(event.type) || [])]) fn(event);
    return !event.defaultPrevented;
  }
  get listenerCount() { return [...this.listeners.values()].reduce((n, set) => n + set.size, 0); }
}
class Node extends Events {
  constructor(tag) { super(); this.tag = tag; this.children = []; this.attributes = {}; this.value = ""; this.hidden = false; this.disabled = false; this._text = ""; }
  append(...nodes) { for (const n of nodes) { this.children.push(n); n.parentNode = this; } }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  set textContent(value) { this._text = value; this.children = []; }
  get textContent() { return this._text; }
  set innerHTML(_) { throw new Error("Unsafe HTML"); }
  setAttribute(key, value) { this.attributes[key] = value; }
  getAttribute(key) { return this.attributes[key] ?? null; }
  removeAttribute(key) { delete this.attributes[key]; }
}
class Win extends Events {
  constructor(uri = URI) {
    super(); this.closed = false; this.confirmResult = true; this.confirmations = []; this.alerts = []; this.focusCount = 0;
    this.document = { documentURI: uri, readyState: "complete", body: new Node("body"), createElementNS: (_, tag) => new Node(tag) };
  }
  focus() { this.focusCount++; }
  confirm(text) { this.confirmations.push(text); return this.confirmResult; }
  alert(text) { this.alerts.push(text); }
  close() {
    if (this.closed || !this.dispatchEvent({ type: "close" })) return;
    this.closed = true; this.dispatchEvent({ type: "unload", target: this.document });
  }
}
const config = { provider: "deepseek", endpoint: "https://api.deepseek.com/chat/completions", model: "deepseek-chat", oxrBaseURL: "https://free-oxr.somark.ai/api/v1", translationPrompt: "translate", reviewPrompt: "review" };
class Service {
  constructor(id, calls) {
    this.attachmentID = id; this.title = `Paper ${id}`; this.calls = calls; this.listeners = new Set();
    this.state = { stage: "new", source: "", translated: "", pageCount: 0, busy: false, error: "", draft: "" };
  }
  snapshot() { return { ...this.state }; }
  emit(patch) { Object.assign(this.state, patch); for (const fn of this.listeners) fn(this.snapshot()); }
  subscribe(fn) { this.listeners.add(fn); fn(this.snapshot()); return () => this.listeners.delete(fn); }
  async load() { this.calls.push(`load:${this.attachmentID}`); return this.snapshot(); }
  async parse(options) { assert.equal(options.consent, true); this.calls.push("parse"); this.emit({ stage: "review", source: "# Source", pageCount: 2 }); }
  async confirm(source) { this.calls.push("confirm"); this.emit({ source, approvedHash: "hash", config: { ...config }, stage: "ready" }); }
  async translate(options) { assert.equal(options.consent, true); this.calls.push("translate"); }
  async pause() { this.calls.push(`pause:${this.attachmentID}`); }
  async preview(page, original) { this.calls.push(`preview:${page}:${original}`); return { dataURI: "data:image/png;base64,YQ==", page, pageCount: 2 }; }
  async setDraft(value) { this.calls.push(`draft:${value}`); this.emit({ draft: value }); }
  async finish(win) { assert.equal(win.closed, false); this.calls.push("finish"); this.emit({ chineseAttachmentID: 42, stage: "complete" }); }
  async export() { this.calls.push("export"); }
}
function setup() {
  const calls = [], services = new Map(), wins = [], owner = new Win("chrome://zotero/content/zoteroPane.xhtml");
  const runtime = { config: () => ({ ...config }), async create(id) {
    calls.push(`create:${id}`); if (!services.has(id)) services.set(id, new Service(id, calls)); return services.get(id);
  }, async openVersion(id, lang) { calls.push(`version:${id}:${lang}`); } };
  const ui = new FulltextUI({ runtime, rootURI: "file:///plugin/", openWindow: (_owner, uri, _name, features) => {
    assert.equal(uri, URI); assert.match(features, /dialog=no.*width=1100,height=800/);
    const win = new Win(); wins.push(win); return win;
  } });
  let renders = 0;
  global.SmartPaperTranslatorModules.FulltextMarkdown = { renderMarkdown(_doc, node, source) { renders++; node.textContent = source; } };
  return { ui, runtime, owner, wins, calls, services, record: () => ui.windows.get(owner).current, renders: () => renders };
}
function click(r, id) { r.el[id].dispatchEvent({ type: "click" }); }
function edit(r, id, value) { r.el[id].value = value; r.el[id].dispatchEvent({ type: "input" }); }
async function review(h) { await h.ui.open(h.owner, 1); h.services.get(1).emit({ source: "# Source", pageCount: 2, stage: "review" }); return h.record(); }

test("open is local; same task focuses; explicit upload and translation confirmations are separate", async () => {
  const h = setup(); await h.ui.open(h.owner, 1); const r = h.record();
  assert.deepEqual(h.calls, ["create:1", "load:1"]);
  assert.match(r.el.destination.textContent, /https:\/\/free-oxr/);
  assert.equal(r.el.error.textContent, "");
  await h.ui.open(h.owner, 1); assert.equal(h.wins.length, 1); assert.equal(r.window.focusCount, 1);
  r.window.confirmResult = false; click(r, "parse"); await tick(); assert.ok(!h.calls.includes("parse"));
  r.window.confirmResult = true; click(r, "parse"); await tick();
  assert.ok(h.calls.includes("parse")); assert.ok(!h.calls.includes("translate"));
  r.window.confirmResult = false; click(r, "confirm"); await tick(); assert.ok(!h.calls.includes("confirm"));
  r.window.confirmResult = true; click(r, "confirm"); await tick();
  assert.ok(h.calls.indexOf("confirm") < h.calls.indexOf("translate"));
  assert.match(r.window.confirmations.at(-1), /deepseek-chat[\s\S]*翻译和独立校对/);
  await h.ui.shutdown();
});

test("snapshot ticks preserve source edits and native selection; preview is user-driven", async () => {
  const h = setup(), r = await review(h), s = h.services.get(1);
  edit(r, "source", "# User edit"); r.el.source.selectionStart = 3; r.el.source.selectionEnd = 7;
  s.emit({ completed: 2 }); s.emit({ completed: 3 });
  assert.equal(r.el.source.value, "# User edit"); assert.equal(r.el.source.selectionStart, 3); assert.equal(r.el.source.selectionEnd, 7);
  assert.equal(h.renders(), 0); click(r, "preview"); assert.equal(h.renders(), 1);
  s.emit({ completed: 4 }); assert.equal(h.renders(), 1);
  assert.equal(r.el.rendered.textContent, "# User edit");
  await h.ui.shutdown();
});

test("late page previews and old-window callbacks cannot replace the current image", async () => {
  const h = setup(), r = await review(h), s = h.services.get(1), a = deferred(), b = deferred();
  s.preview = page => page === 1 ? a.promise : b.promise;
  click(r, "reload"); click(r, "next");
  b.resolve({ dataURI: "data:image/png;base64,Yg==", page: 2, pageCount: 2 }); await tick();
  a.resolve({ dataURI: "data:image/png;base64,YQ==", page: 1, pageCount: 2 }); await tick();
  assert.equal(r.el.image.getAttribute("src"), "data:image/png;base64,Yg==");
  const late = deferred(); s.preview = () => late.promise; click(r, "reload");
  await h.ui.open(h.owner, 2); const newer = h.record();
  late.resolve({ dataURI: "data:image/png;base64,Yw==", page: 2, pageCount: 2 }); await tick();
  assert.equal(r.el.image.getAttribute("src"), null); assert.equal(newer.el.image.getAttribute("src"), null);
  const changedDoc = deferred(); h.services.get(2).preview = () => changedDoc.promise; click(newer, "reload");
  newer.window.document = { documentURI: URI }; changedDoc.resolve({ dataURI: "data:image/png;base64,Yw==", page: 1, pageCount: 2 }); await tick();
  assert.equal(newer.el.image.getAttribute("src"), null);
  await h.ui.shutdown();
});

test("busy controls lock source/upload/confirm and keep pause available; close cancels only this view", async () => {
  const h = setup(), r = await review(h), s = h.services.get(1);
  s.emit({ stage: "translating", busy: true });
  for (const id of ["parse", "confirm", "finish", "export", "save-draft"]) assert.equal(r.el[id].disabled, true, id);
  assert.equal(r.el.source.readOnly, true); assert.equal(r.el.pause.disabled, false);
  r.window.confirmResult = false; r.window.close(); await tick(); assert.equal(r.closed, false);
  const child = { documentURI: URI }; r.window.dispatchEvent({ type: "close", target: child });
  assert.equal(r.closed, false);
  const before = { type: "beforeunload", target: r.document }; r.window.dispatchEvent(before); assert.equal(before.defaultPrevented, true);
  r.window.confirmResult = true; r.window.close(); await tick();
  assert.equal(r.window.closed, true); assert.ok(h.calls.includes("pause:1")); assert.equal(s.listeners.size, 0);
  assert.equal(r.window.listenerCount, 0); assert.equal(r.el.source.listenerCount, 0);
  await h.ui.open(h.owner, 1); assert.equal(h.services.get(1), s); assert.equal(h.wins.length, 2);
  await h.ui.shutdown(); assert.equal(h.owner.listenerCount, 0);
});

test("replacement waits for pause before creating/opening another task", async () => {
  const h = setup(), r = await review(h), paused = deferred();
  h.services.get(1).pause = () => { h.calls.push("pause-start"); return paused.promise; };
  h.owner.confirmResult = false; assert.equal(await h.ui.open(h.owner, 2), false);
  h.owner.confirmResult = true; const replacing = h.ui.open(h.owner, 2); await tick();
  assert.equal(h.wins.length, 1); assert.ok(!h.calls.includes("create:2"));
  paused.resolve(); assert.equal(await replacing, true); assert.equal(r.window.closed, true);
  assert.ok(h.calls.indexOf("pause-start") < h.calls.indexOf("create:2"));
  await h.ui.shutdown();
});

test("owner closure during asynchronous creation awaits pause, never starts requests or prompts", async () => {
  const h = setup(), gate = deferred(), s = new Service(1, h.calls);
  h.runtime.create = () => gate.promise;
  const opening = h.ui.open(h.owner, 1); await tick();
  const closing = h.ui.closeForWindow(h.owner); await tick();
  gate.resolve(s); await closing; assert.equal(await opening, false);
  assert.ok(h.calls.includes("pause:1")); assert.equal(h.owner.confirmations.length, 0);
  assert.equal(h.wins.length, 0); assert.equal(s.listeners.size, 0);
  await h.ui.shutdown();
});

test("about:blank and child load are ignored; early close cleans pending document wait", async () => {
  const h = setup(), win = new Win("about:blank"); h.ui.openWindow = () => win;
  const opening = h.ui.open(h.owner, 1); await tick();
  win.dispatchEvent({ type: "load", target: { documentURI: URI } }); await tick();
  assert.deepEqual(h.calls, ["create:1", "load:1"]);
  await h.ui.closeForWindow(h.owner); assert.equal(await opening, false); assert.equal(win.closed, true);
  assert.equal(win.listenerCount, 0); await h.ui.shutdown();
});

test("a confirmed live translation automatically saves PDF, but reopening does not", async () => {
  const h = setup(); await h.ui.open(h.owner, 1); const r = h.ui.windows.get(h.owner).current;
  const s = r.service;
  s.emit({ pageCount: 1, source: "# Source", stage: "review" });
  s.translate = async () => { h.calls.push("translate"); s.emit({ translated: "# 中文", stage: "translated" }); };
  click(r, "confirm"); await tick();
  assert.ok(h.calls.indexOf("translate") < h.calls.indexOf("finish"));
  assert.match(r.window.confirmations.at(-1), /自动生成/u);
  await h.ui.shutdown();
});

test("completed tasks never auto-import or reset; explicit finish/export/version and reset disclosure", async () => {
  const h = setup(), r = await review(h), s = h.services.get(1);
  s.emit({ approvedHash: "hash", config: { ...config }, translated: "# 中文", stage: "translated" });
  assert.equal(h.renders(), 1); s.emit({ completed: 1 }); assert.equal(h.renders(), 1);
  assert.equal(r.el.confirm.disabled, true); assert.equal(r.el.finish.disabled, false); assert.ok(!h.calls.includes("finish"));
  click(r, "confirm"); await tick(); assert.ok(!h.calls.includes("confirm"));
  click(r, "finish"); await tick(); assert.ok(h.calls.includes("finish"));
  click(r, "zh"); await tick(); assert.ok(h.calls.includes("version:1:zh"));
  click(r, "export"); await tick(); assert.ok(h.calls.includes("export"));
  edit(r, "source", "# Corrected"); assert.equal(r.el.finish.disabled, true);
  r.window.confirmResult = false; click(r, "confirm"); await tick();
  assert.match(r.window.confirmations.at(-1), /重置旧检查点/); assert.ok(!h.calls.includes("confirm"));
  await h.ui.shutdown();
});

test("masked draft is saved explicitly; invalid corrections stay editable and never send", async () => {
  const h = setup(), r = await review(h), s = h.services.get(1);
  s.emit({ stage: "paused", error: "校对失败 sk-secret123", currentID: "s1", currentSource: "Original paragraph", draft: "bad __TOKEN__" });
  assert.equal(r.el.repair.hidden, false); assert.equal(r.el.current.textContent, "Original paragraph");
  assert.ok(!r.el.error.textContent.includes("sk-secret123"));
  edit(r, "draft", "fixed __TOKEN__"); assert.equal(r.el.confirm.disabled, true);
  s.setDraft = async () => { throw new Error("占位符被修改"); };
  click(r, "save-draft"); await tick(); assert.match(r.el.error.textContent, /占位符被修改/);
  assert.equal(r.el.draft.value, "fixed __TOKEN__"); assert.ok(!h.calls.includes("translate"));
  s.setDraft = Service.prototype.setDraft;
  click(r, "save-draft"); await tick(); assert.ok(h.calls.includes("draft:fixed __TOKEN__"));
  assert.ok(!h.calls.includes("translate")); assert.equal(r.el.confirm.disabled, false);
  await h.ui.shutdown();
});

test("pause during confirmation prevents a late confirm response from starting translation", async () => {
  const h = setup(), r = await review(h), gate = deferred(), s = h.services.get(1);
  s.confirm = () => gate.promise;
  click(r, "confirm"); await tick(); assert.equal(r.el.pause.disabled, false);
  click(r, "pause"); await tick(); gate.resolve(); await tick();
  assert.ok(!h.calls.includes("translate")); assert.equal(r.pending, false);
  await h.ui.shutdown();
});

test("two owners sharing the runtime service get one editor; duplicate close never pauses/releases it", async () => {
  const h = setup(), s = new Service(1, h.calls), gate = deferred(), owner2 = new Win();
  s.state.busy = true;
  h.runtime.create = () => gate.promise;
  h.runtime.release = async service => { assert.equal(service, s); h.calls.push("release"); };
  const one = h.ui.open(h.owner, 1), two = h.ui.open(owner2, 42);
  await tick(); gate.resolve(s);
  assert.equal(await one, true); assert.equal(await two, false);
  assert.equal(h.wins.length, 1); assert.equal(h.wins[0].closed, false);
  assert.equal(h.wins[0].focusCount, 1); assert.equal(s.listeners.size, 1);
  assert.ok(!h.calls.some(call => /^(load|pause|release)/u.test(call)));
  await h.ui.closeForWindow(owner2); assert.ok(!h.calls.includes("release"));
  await h.ui.closeForWindow(h.owner);
  assert.equal(h.calls.at(-1), "release"); assert.ok(h.calls.indexOf("pause:1") < h.calls.indexOf("release"));
  await h.ui.shutdown();
});

test("reopen racing another owner's cleanup waits for release then creates a fresh service", async () => {
  const h = setup(), r = await review(h), gate = deferred(), owner2 = new Win();
  h.runtime.release = async service => {
    h.calls.push(`release:${service.attachmentID}`);
    if (service === r.service) await gate.promise;
    if (h.services.get(service.attachmentID) === service) h.services.delete(service.attachmentID);
  };
  const closing = h.ui.closeForWindow(h.owner); await tick();
  const reopening = h.ui.open(owner2, 1); await tick();
  assert.equal(h.services.get(1), r.service);
  gate.resolve(); await closing; assert.equal(await reopening, true);
  assert.notEqual(h.services.get(1), r.service);
  assert.equal(h.ui.windows.get(owner2).current.service, h.services.get(1));
  await h.ui.shutdown();
});

test("isolated native probes can use their own chrome package without changing the default URI", async () => {
  const h = setup(), uri = "chrome://spt-owned-probe/content/fulltext.xhtml";
  const ui = new FulltextUI({ runtime: h.runtime, windowURI: uri, openWindow: (_owner, url) => {
    assert.equal(url, uri); return new Win(uri);
  } });
  assert.equal(await ui.open(h.owner, 1), true);
  assert.equal(ui.windows.get(h.owner).current.document.documentURI, uri);
  await ui.shutdown();
});

function parsing(chunks, phase = "parsing", elapsedMS = 0) {
  return { stage: "parsing", busy: true, parseProgress: { phase, pageCount: 48, chunks, elapsedMS } };
}
test("parse timeline uses page ranges and native disclosure remains user-controlled through updates", async () => {
  const h = setup(); await h.ui.open(h.owner, 1); const r = h.record(), s = r.service;
  assert.equal(r.el["parse-progress"].hidden, true);
  assert.ok(!r.el.status.textContent.includes("0 / 0"));
  s.emit(parsing([], "preparing"));
  assert.equal(r.el["parse-progress"].hidden, false); assert.equal(r.el["parse-progress"].open, true);
  assert.match(r.el.status.textContent, /正在准备 PDF/u); assert.ok(!r.el.status.textContent.includes("段"));
  const chunks = [{ start: 1, end: 20, status: "complete" }, { start: 21, end: 40, status: "processing" }, { start: 41, end: 48, status: "pending" }];
  s.emit(parsing(chunks, "parsing", 138000));
  assert.match(r.el.status.textContent, /已完成 1 \/ 3 块.*02:18/u);
  assert.equal(r.progressRows.length, 3);
  assert.equal(r.progressRows[1].item.children[0].textContent, "第 21–40 页");
  assert.equal(r.progressRows[1].steps[1].getAttribute("data-stage"), "active");
  assert.equal(r.progressRows[0].steps[0].getAttribute("data-stage"), "waiting");
  assert.equal(r.progressRows[0].steps[1].getAttribute("data-stage"), "waiting");
  assert.equal(r.progressRows[0].steps[2].getAttribute("data-stage"), "done");
  assert.equal(r.progressRows[2].status.textContent, "待上传");
  const row = r.progressRows[1].item;
  r.el["parse-progress"].open = false; r.el["parse-progress"].dispatchEvent({ type: "toggle" });
  assert.equal(r.el["parse-toggle"].textContent, "展开");
  s.emit(parsing(chunks.map(c => ({ ...c, status: "complete" })), "assembling", 150000));
  assert.equal(r.el["parse-progress"].open, false); assert.equal(r.progressRows[1].item, row);
  assert.equal(r.progressRows[1].status.textContent, "解析中"); // Hidden rows update on expansion.
  assert.match(r.el.status.textContent, /正在整理解析结果/u);
  assert.match(r.el["parse-note"].textContent, /本地整理/u);
  s.emit({ stage: "review", busy: false, parseProgress: { ...s.state.parseProgress, phase: "complete" } });
  assert.equal(r.el["parse-progress"].open, false); assert.equal(r.el["parse-progress"].hidden, false);
  assert.equal(r.progressTimer, null); assert.ok(!r.el.status.textContent.includes("段"));
  r.el["parse-progress"].open = true; r.el["parse-progress"].dispatchEvent({ type: "toggle" });
  assert.equal(r.el["parse-toggle"].textContent, "收起");
  assert.equal(r.progressRows[1].status.textContent, "解析完成");
  s.emit({ stage: "translating", busy: true, total: 8, completed: 1 });
  assert.match(r.el.status.textContent, /1 \/ 8 段/u);
  await h.ui.shutdown(); assert.equal(r.el["parse-progress"].listenerCount, 0);
});
test("elapsed time updates while remote state is unchanged and stops on pause or close", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 100000 });
  const h = setup(); t.after(() => h.ui.shutdown());
  await h.ui.open(h.owner, 1); const r = h.record(), s = r.service;
  s.emit(parsing([{ start: 1, end: 20, status: "queuing" }], "parsing", 5000));
  const row = r.progressRows[0].item;
  assert.ok(r.progressTimer);
  t.mock.timers.tick(1000);
  assert.match(r.el.status.textContent, /00:06/u); assert.equal(r.progressRows[0].item, row);
  s.emit({ stage: "paused", busy: false, parseProgress: { ...s.state.parseProgress, phase: "paused", elapsedMS: 6200,
    chunks: [{ start: 1, end: 20, status: "paused" }] } });
  assert.equal(r.progressTimer, null); assert.equal(r.progressRows[0].status.textContent, "已暂停");
  assert.match(r.el.status.textContent, /解析已暂停/u);
  s.emit(parsing([{ start: 1, end: 20, status: "submitted" }]));
  assert.equal(r.progressRows[0].status.textContent, "已提交，等待状态"); assert.ok(r.progressTimer);
  await h.ui.shutdown(); assert.equal(r.progressTimer, null);
  s.emit(parsing([{ start: 1, end: 20, status: "complete" }]));
  assert.equal(r.progressRows.length, 0);
});
test("parse failures keep complete rows, expose failure and leave pending rows unqueued", async () => {
  const h = setup(); await h.ui.open(h.owner, 1); const r = h.record(), s = r.service;
  s.emit({ ...parsing([{ start: 1, end: 20, status: "complete" }, { start: 21, end: 40, status: "failed" },
    { start: 41, end: 48, status: "pending" }], "failed", 32000), stage: "paused", busy: false, error: "remote_task_failed" });
  assert.deepEqual(r.progressRows.map(row => row.status.textContent), ["解析完成", "失败", "待上传"]);
  assert.match(r.el.status.textContent, /解析失败.*1 \/ 3 块/u);
  assert.equal(r.progressTimer, undefined); assert.equal(r.el.error.textContent, "remote_task_failed");
  s.emit({ parseProgress: { ...s.state.parseProgress, chunks: [
    { start: 1, end: 20, status: "complete", observed: ["complete"] },
    { start: 21, end: 40, status: "failed", observed: ["queuing", "processing"] },
    { start: 41, end: 48, status: "pending", observed: [] }
  ] } });
  assert.equal(r.progressRows[1].steps[0].getAttribute("data-stage"), "observed");
  assert.equal(r.progressRows[1].steps[1].getAttribute("data-stage"), "observed");
  assert.equal(r.progressRows[1].steps[2].getAttribute("data-stage"), "waiting");
  await h.ui.shutdown();
});
test("fixed XHTML has no scripts or remote resources; implementation never injects HTML", () => {
  const xhtml = fs.readFileSync(require.resolve("../plugin/content/fulltext.xhtml"), "utf8");
  assert.match(xhtml, /script-src 'none'/); assert.match(xhtml, /connect-src 'none'/);
  assert.ok(!/<script/iu.test(xhtml)); assert.match(xhtml, /<link rel="stylesheet" href="fulltext\.css"\s*\/>/u);
  assert.equal(new URL("fulltext.css", URI).href, "chrome://smart-paper-translator/content/fulltext.css");
  const js = fs.readFileSync(require.resolve("../plugin/content/fulltext-ui.js"), "utf8");
  assert.ok(!/\.innerHTML\s*=/u.test(js)); assert.ok(!/service\??\.shutdown\s*\(/u.test(js));
});
