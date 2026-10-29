"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { FulltextUI } = require("../plugin/content/fulltext-ui.js");
const Markdown = require("../plugin/content/fulltext-markdown.js");
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
  replaceChildren(...nodes) { this._text = ""; this.children = []; this.append(...nodes); }
  set textContent(value) { this._text = value; this.children = []; }
  get textContent() { return this._text + this.children.map(node => node.textContent).join(""); }
  get childNodes() { return this.children; }
  set innerHTML(_) { throw new Error("Unsafe HTML"); }
  setAttribute(key, value) { this.attributes[key] = value; }
  getAttribute(key) { return this.attributes[key] ?? null; }
  removeAttribute(key) { delete this.attributes[key]; }
}
class Win extends Events {
  constructor(uri = URI) {
    super(); this.closed = false; this.confirmResult = true; this.confirmations = []; this.alerts = []; this.focusCount = 0;
    this.document = { documentURI: uri, readyState: "complete", body: new Node("body"), createElementNS: (_, tag) => new Node(tag),
      createTextNode(value) { const node = new Node("#text"); node.textContent = value; return node; } };
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
    this.state = { stage: "new", source: "", translated: "", pageCount: 0, busy: false, error: "", draft: "",
      editingReady: true, documentRevision: "rev1", sourceChanged: false };
  }
  snapshot() { return { ...this.state }; }
  emit(patch) { Object.assign(this.state, patch); for (const fn of this.listeners) fn(this.snapshot()); }
  subscribe(fn) { this.listeners.add(fn); fn(this.snapshot()); return () => this.listeners.delete(fn); }
  async load() { this.calls.push(`load:${this.attachmentID}`); return this.snapshot(); }
  async parse(options) { assert.equal(options.consent, true); this.calls.push("parse"); this.emit({ stage: "review", source: "# Source", pageCount: 2 }); }
  async confirm(source) { this.calls.push("confirm"); this.confirmedSource = source; this.emit({ source, sourceChanged: false, approvedHash: "hash", config: { ...config }, stage: "ready" }); }
  getPageBlocks(page) { return Markdown.editableBlocks(this.getPageMarkdown(page) || ""); }
  async enableEditing(options) {
    assert.deepEqual(options, { consent: true }); this.calls.push("migrate");
    this.pages = Array.from({ length: this.state.pageCount }, (_, i) => this.getPageMarkdown(i + 1));
    this.emit({ source: this.pages.join("\n\n"), editingReady: true, documentRevision: "migrated", sourceChanged: true });
  }
  async editBlock({ page, index, revision, text }) {
    assert.equal(revision, this.state.documentRevision);
    const block = this.getPageBlocks(page).find(item => item.index === index); assert.ok(block);
    const source = this.getPageMarkdown(page);
    this.pages ||= Array.from({ length: this.state.pageCount }, (_, i) => this.getPageMarkdown(i + 1));
    this.pages[page - 1] = source.slice(0, block.start) + text + source.slice(block.end);
    this.calls.push("editBlock"); this.emit({ source: this.pages.join("\n\n"), documentRevision: `${revision}+`, sourceChanged: true });
  }
  async translate(options) { assert.equal(options.consent, true); this.calls.push("translate"); }
  async pause() { this.calls.push(`pause:${this.attachmentID}`); }
  getPageMarkdown(page) { return this.pages?.[page - 1] ?? (page <= this.state.pageCount ? `# OCR page ${page}` : null); }
  async preview(page, original) { this.calls.push(`preview:${page}:${original}`); return { dataURI: "data:image/png;base64,YQ==", page, pageCount: this.state.pageCount || 2 }; }
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
  global.SmartPaperTranslatorModules.FulltextMarkdown = { renderMarkdown(_doc, node, source, options = {}) {
    renders++; node.textContent = source;
    for (const block of Markdown.editableBlocks(source)) { const child = new Node("div"); node.append(child); options.onBlock?.(child, block); }
  } };
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

test("snapshot ticks preserve single-block edits and selection without rendering translations", async () => {
  const h = setup(), r = await review(h), s = h.services.get(1);
  click(r, "edit"); edit(r, "source", "# User edit"); r.el.source.selectionStart = 3; r.el.source.selectionEnd = 7;
  const renders = h.renders();
  s.emit({ completed: 2 }); s.emit({ completed: 3, translated: "中文" });
  assert.equal(r.el.source.value, "# User edit"); assert.equal(r.el.source.selectionStart, 3); assert.equal(r.el.source.selectionEnd, 7);
  assert.equal(h.renders(), renders); assert.equal(r.mode, "edit"); assert.equal(r.el.confirm.disabled, true);
  assert.match(r.el["md-note"].textContent, /仅编辑选中块/u);
  await h.ui.shutdown();
});

test("page preview follows only the accepted PDF page and clears stale content on failure", async () => {
  const h = setup(), r = await review(h), s = h.services.get(1);
  click(r, "preview"); assert.equal(r.el.rendered.textContent, "# OCR page 1");
  click(r, "next"); assert.equal(r.el.rendered.textContent, ""); await tick();
  assert.equal(r.el.rendered.textContent, "# OCR page 2");
  assert.match(r.el["md-title"].textContent, /第 2 页/u);
  assert.equal(r.el.rendered.scrollTop, 0);
  s.preview = async () => { throw new Error("image failure"); };
  click(r, "previous"); await tick();
  assert.equal(r.el.image.getAttribute("src"), null); assert.equal(r.el.rendered.textContent, "");
  assert.match(r.el["md-status"].textContent, /失败/u);
  s.getPageMarkdown = () => null; s.preview = Service.prototype.preview;
  click(r, "reload"); await tick();
  assert.equal(r.el.rendered.textContent, ""); assert.match(r.el["md-status"].textContent, /重新解析/u);
  assert.ok(!h.calls.includes("parse"));
  s.getPageMarkdown = () => "";
  click(r, "preview"); assert.match(r.el["md-status"].textContent, /无识别内容/u);
  click(r, "edit"); assert.equal(r.el.source.hidden, true); assert.equal(r.el.edit.disabled, true);
  await h.ui.shutdown();
});

test("reparse of approved tasks needs a separate reset confirmation and preserves unsaved edits on failure", async () => {
  const h = setup(), r = await review(h), s = h.services.get(1);
  s.emit({ approvedHash: "old", translated: "Old translation" });
  assert.equal(r.el.parse.disabled, false);
  let requests = 0;
  s.parse = async options => { requests++; assert.deepEqual(options, { consent: true, replaceApproved: true }); throw new Error("parse failed"); };
  click(r, "edit"); edit(r, "source", "Unsaved full text");
  r.window.confirm = text => { r.window.confirmations.push(text); return !text.includes("归档"); };
  click(r, "parse"); await tick(); assert.equal(requests, 0);
  r.window.confirm = text => { r.window.confirmations.push(text); return true; };
  click(r, "parse"); await tick(); assert.equal(requests, 1);
  assert.equal(r.el.source.value, "Unsaved full text"); assert.equal(r.dirty, true);
  assert.match(r.window.confirmations.at(-1), /归档[\s\S]*重新确认[\s\S]*未确认/u);
  s.parse = async options => { assert.equal(options.replaceApproved, true); s.emit({ source: "New full text", translated: "", approvedHash: null, pageCount: 1 }); };
  click(r, "parse"); await tick();
  assert.equal(r.state.source, "New full text"); assert.equal(r.dirty, false); assert.equal(r.pages, 1);
  assert.notEqual(r.el.source.value, "New full text"); // The textarea is never the full-source store.
  assert.equal(r.el.rendered.textContent, "# OCR page 1");
  s.emit({ importIntent: true }); assert.equal(r.el.parse.disabled, true);
  await h.ui.shutdown();
});

test("late page previews and old-window callbacks cannot replace the current image", async () => {
  const h = setup(), r = await review(h), s = h.services.get(1), a = deferred(), b = deferred();
  s.preview = page => page === 1 ? a.promise : b.promise;
  click(r, "preview"); click(r, "reload"); click(r, "next");
  b.resolve({ dataURI: "data:image/png;base64,Yg==", page: 2, pageCount: 2 }); await tick();
  a.resolve({ dataURI: "data:image/png;base64,YQ==", page: 1, pageCount: 2 }); await tick();
  assert.equal(r.el.image.getAttribute("src"), "data:image/png;base64,Yg==");
  assert.equal(r.el.rendered.textContent, "# OCR page 2");
  const late = deferred(); s.preview = () => late.promise; click(r, "reload");
  await h.ui.open(h.owner, 2); const newer = h.record();
  late.resolve({ dataURI: "data:image/png;base64,Yw==", page: 2, pageCount: 2 }); await tick();
  assert.equal(r.el.image.getAttribute("src"), null); assert.equal(newer.el.image.getAttribute("src"), null);
  const changedDoc = deferred(); h.services.get(2).preview = () => changedDoc.promise; click(newer, "reload");
  newer.window.document = { documentURI: URI }; changedDoc.resolve({ dataURI: "data:image/png;base64,Yw==", page: 1, pageCount: 2 }); await tick();
  assert.equal(newer.el.image.getAttribute("src"), null);
  await h.ui.shutdown();
});

test("wrong-page images and previews superseded by reparse never update either pane", async () => {
  const h = setup(), r = await review(h), s = h.services.get(1), gate = deferred();
  s.preview = async () => ({ dataURI: "data:image/png;base64,YQ==", page: 2, pageCount: 2 });
  click(r, "reload"); await tick();
  assert.equal(r.el.image.getAttribute("src"), null); assert.equal(r.el.rendered.textContent, "");
  assert.match(r.el["preview-error"].textContent, /页码/u);
  s.preview = () => gate.promise;
  click(r, "reload");
  const parsing = deferred(); s.parse = () => parsing.promise;
  click(r, "parse"); await tick();
  gate.resolve({ dataURI: "data:image/png;base64,YQ==", page: 1, pageCount: 2 }); await tick();
  assert.equal(r.el.image.getAttribute("src"), null); assert.equal(r.el.rendered.textContent, "");
  parsing.reject(new Error("offline")); await tick();
  assert.equal(r.previewPending, false); assert.match(r.el["md-status"].textContent, /旧任务/u);
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
  click(r, "edit"); edit(r, "source", "# Corrected"); assert.equal(r.el.finish.disabled, true);
  assert.equal(r.el.confirm.disabled, true); click(r, "save"); await tick();
  assert.equal(r.el.export.disabled, true);
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
test("block selection is exact, accessible and does not rebuild the page; save updates full original only", async () => {
  const h = setup(), r = await review(h), s = r.service;
  s.pages = ["First paragraph\n\n$$x=1$$\n\n|A|B|\n|-|-|\n|1|2|\n\n![figure](https://example.invalid/a.png)\n", "Second page"];
  s.emit({ source: s.pages.join("\n\n"), approvedHash: "old", translated: "中文旧译稿", config: { ...config } });
  const nodes = r.blockNodes.slice(), blocks = s.getPageBlocks(1), renders = h.renders();
  assert.equal(nodes.length, blocks.length); assert.equal(nodes[0].node.getAttribute("aria-pressed"), "true");
  for (const entry of nodes) {
    assert.equal(entry.node.getAttribute("role"), "button"); assert.equal(entry.node.getAttribute("tabindex"), "0");
    entry.node.dispatchEvent({ type: "keydown", key: "Enter" });
    assert.equal(r.selected, entry); assert.equal(entry.node.getAttribute("aria-pressed"), "true");
  }
  nodes[1].node.dispatchEvent({ type: "click" }); assert.equal(h.renders(), renders);
  click(r, "edit"); assert.equal(r.el.source.value, blocks[1].source); assert.equal(r.mode, "edit");
  edit(r, "source", "$$x=2$$\n"); assert.equal(r.el.confirm.disabled, true);
  let request;
  const save = s.editBlock.bind(s); s.editBlock = input => { request = input; return save(input); };
  click(r, "save"); await tick();
  assert.deepEqual(request, { page: 1, index: blocks[1].index, revision: "rev1", text: "$$x=2$$\n" });
  assert.equal(r.dirty, false); assert.equal(r.mode, "page"); assert.equal(r.el.export.disabled, true); assert.equal(r.el.finish.disabled, true);
  assert.ok(r.el.rendered.textContent.includes("x=2")); assert.equal(s.state.approvedHash, "old");
  assert.ok(!h.calls.includes("confirm")); click(r, "full");
  assert.equal(r.mode, "full"); assert.equal(r.el.rendered.textContent, s.state.source);
  assert.ok(!r.el.rendered.textContent.includes("中文旧译稿")); assert.equal(r.blockNodes.length, 0); assert.equal(r.el.edit.hidden, true);
  click(r, "preview"); assert.equal(r.mode, "page"); assert.equal(r.page, 1);
  nodes[0].node.dispatchEvent({ type: "click" }); assert.notEqual(r.selected, nodes[0]);
  const whole = s.state.source; click(r, "confirm"); await tick();
  assert.equal(s.confirmedSource, whole); assert.ok(whole.includes("Second page"));
  await h.ui.shutdown();
});

test("save failures and stale revisions retain the single-block draft; cancel never persists", async () => {
  const h = setup(), r = await review(h), s = r.service;
  click(r, "edit"); edit(r, "source", "Unsaved repair");
  const before = s.state.source;
  s.editBlock = async () => { throw new Error("atomic write failed"); };
  click(r, "save"); await tick();
  assert.equal(r.mode, "edit"); assert.equal(r.dirty, true); assert.equal(r.el.source.value, "Unsaved repair");
  assert.equal(s.state.source, before); assert.match(r.el.error.textContent, /atomic write/u);
  s.emit({ documentRevision: "external-revision", source: "Other saved source" });
  assert.equal(r.el.source.value, "Unsaved repair"); assert.equal(r.el.save.disabled, true);
  assert.match(r.el["md-status"].textContent, /版本已改变/u); await h.ui._save(r);
  r.window.confirmResult = false; click(r, "cancel"); assert.equal(r.mode, "edit");
  r.window.confirmResult = true; click(r, "cancel"); assert.equal(r.mode, "page"); assert.equal(r.dirty, false);
  assert.equal(s.state.source, "Other saved source"); assert.ok(!h.calls.includes("editBlock"));
  await h.ui.shutdown();
});

test("late save completion after pause or close cannot replace or clear the unsaved editor", async () => {
  for (const stop of ["pause", "close"]) {
    const h = setup(), r = await review(h), gate = deferred();
    const node = r.selected.node;
    click(r, "edit"); edit(r, "source", "Keep unsaved"); r.service.editBlock = () => gate.promise;
    click(r, "save"); await tick();
    if (stop === "pause") click(r, "pause"); else r.window.close();
    await tick(); gate.resolve(); await tick();
    assert.equal(r.el.source.value, "Keep unsaved"); assert.equal(r.dirty, true); assert.equal(r.state.source, "# Source");
    if (stop === "close") { assert.equal(r.closed, true); assert.equal(node.listenerCount, 0); }
    else { assert.equal(r.mode, "edit"); assert.equal(r.pending, false); }
    await h.ui.shutdown();
  }
});

test("legacy migration is explicit, can be refused, and never reuses a pre-migration selection", async () => {
  const h = setup(), r = await review(h), s = r.service;
  s.emit({ editingReady: false, documentRevision: "", source: "Old manually edited full source", approvedHash: "old" });
  click(r, "full"); assert.equal(r.el.rendered.textContent, "Old manually edited full source");
  assert.match(r.el["md-note"].textContent, /独立识别预览/u); click(r, "preview");
  const old = r.selected;
  r.window.confirmResult = false; click(r, "edit"); await tick();
  assert.ok(!h.calls.includes("migrate")); assert.equal(s.state.source, "Old manually edited full source");
  assert.match(r.window.confirmations.at(-1), /旧手改内容[\s\S]*保留备份[\s\S]*重新确认翻译/u);
  r.window.confirmResult = true; click(r, "edit"); await tick();
  assert.ok(h.calls.includes("migrate")); assert.equal(r.mode, "page"); assert.equal(r.el.source.hidden, true);
  assert.notEqual(r.selected, old); assert.equal(r.selected.revision, "migrated");
  old.node.dispatchEvent({ type: "click" }); assert.notEqual(r.selected, old);
  click(r, "edit"); assert.equal(r.editing.revision, "migrated");
  await h.ui.shutdown();
});

test("missing, empty, damaged and uncertain-import documents cannot enter editing; malformed Markdown can be repaired as text", async () => {
  const h = setup(), r = await review(h), s = r.service;
  s.emit({ documentError: "损坏 document" }); assert.equal(r.el.edit.disabled, true); assert.match(r.el["md-note"].textContent, /损坏/u);
  s.emit({ documentError: "", importIntent: true }); assert.equal(r.el.edit.disabled, true);
  s.emit({ importIntent: false, editingReady: false, canEnableEditing: false });
  assert.equal(r.el.edit.disabled, true); assert.match(r.el["md-note"].textContent, /不完整/u);
  const confirmations = r.window.confirmations.length; await h.ui._edit(r); assert.equal(r.window.confirmations.length, confirmations);
  s.emit({ editingReady: true, canEnableEditing: true });
  s.getPageMarkdown = () => null; click(r, "preview"); assert.equal(r.el.edit.disabled, true);
  s.getPageMarkdown = () => ""; click(r, "preview"); assert.equal(r.el.edit.disabled, true);
  s.pages = ["```\n<script>bad()</script>\n", "Second"]; s.getPageMarkdown = Service.prototype.getPageMarkdown;
  global.SmartPaperTranslatorModules.FulltextMarkdown.renderMarkdown = () => { throw new Error("malformed Markdown"); };
  click(r, "preview");
  assert.equal(r.el.rendered.children[0].tag, "pre"); assert.equal(r.el.rendered.children[0].textContent, s.pages[0]);
  assert.equal(r.blockNodes.length, 1); assert.match(r.el["md-status"].textContent, /原文文字/u);
  click(r, "edit"); assert.equal(r.el.source.value, s.pages[0]);
  await h.ui.shutdown();
});

test("legacy migration failure keeps old full source and never enables editing", async () => {
  const h = setup(), r = await review(h), s = r.service;
  s.emit({ editingReady: false, documentRevision: "", source: "Old source" });
  s.enableEditing = async () => { throw new Error("完整页映射缺失"); };
  click(r, "edit"); await tick();
  assert.equal(r.mode, "page"); assert.equal(s.state.source, "Old source"); assert.equal(r.state.editingReady, false);
  assert.match(r.el.error.textContent, /完整页映射/u); assert.ok(!h.calls.includes("editBlock"));
  await h.ui.shutdown();
});

test("unsaved edits guard page/mode/reload/original/close and controls stay disabled through a save", async () => {
  const h = setup(), r = await review(h), s = r.service;
  click(r, "edit"); edit(r, "source", "Unsaved"); r.window.confirmResult = false;
  for (const id of ["next", "full", "preview", "reload", "cancel"]) { click(r, id); assert.equal(r.mode, "edit"); assert.equal(r.dirty, true); }
  r.el.original.checked = true; r.el.original.dispatchEvent({ type: "change" }); assert.equal(r.el.original.checked, false);
  r.window.close(); await tick(); assert.equal(r.closed, false); assert.equal(r.page, 1);
  assert.equal(r.el.source.value, "Unsaved");
  const gate = deferred(); s.editBlock = () => gate.promise;
  click(r, "save"); await tick();
  for (const id of ["edit", "full", "preview", "save", "cancel", "parse", "confirm", "previous", "next", "reload", "retry-images", "source"]) assert.equal(r.el[id].disabled, true, id);
  gate.reject(new Error("save failed")); await tick();
  r.window.confirmResult = true; const count = r.window.confirmations.length; click(r, "next"); await tick();
  assert.equal(r.window.confirmations.length, count + 1); assert.equal(r.page, 2); assert.equal(r.mode, "page"); assert.equal(r.dirty, false);
  await h.ui.shutdown();
});

function imageHarness(h, urls) {
  const requests = [], commits = [], placeholders = [], cancellations = [];
  h.runtime.cancelImages = service => cancellations.push(service);
  h.runtime.imageCacheFor = () => ({ resolve(uri, options) {
    const gate = deferred(); requests.push({ uri, options, gate }); return gate.promise;
  } });
  global.SmartPaperTranslatorModules.FulltextMarkdown.renderMarkdown = (_doc, root, source, options) => {
    root.textContent = source;
    for (const block of Markdown.editableBlocks(source)) { const node = new Node("div"); root.append(node); options.onBlock?.(node, block); }
    for (const uri of urls) {
      const placeholder = new Node("span"); placeholder.textContent = `![figure](${uri})`; root.append(placeholder); placeholders.push(placeholder);
      options.onRemoteImage?.(uri, data => {
        const image = new Node("img"); image.setAttribute("src", data); placeholder.replaceChildren(image); commits.push({ uri, data });
      });
    }
  };
  return { requests, commits, placeholders, cancellations };
}
const remoteImage = "https://free-oxr.somark.ai/api/v1/files/" + "a".repeat(32) + "/" + "b".repeat(64) + ".png";
const localImage = "data:image/png;base64,YQ==";

test("remote images load automatically, deduplicate downloads and commit each occurrence without rebuilding selection", async () => {
  const h = setup(), r = await review(h), images = imageHarness(h, [remoteImage, remoteImage]);
  const confirmations = r.window.confirmations.length;
  click(r, "preview"); const root = r.el.rendered, selected = r.selected, nodes = root.children.slice();
  root.scrollTop = 120; await tick();
  assert.equal(images.requests.length, 1); assert.equal(r.window.confirmations.length, confirmations);
  assert.equal(images.requests[0].options.isCurrent(), true);
  for (const node of images.placeholders) { assert.equal(node.getAttribute("src"), null); assert.match(node.textContent, /!\[figure\]/u); }
  images.requests[0].gate.resolve(localImage); await tick();
  assert.equal(images.commits.length, 2); assert.equal(r.selected, selected); assert.deepEqual(root.children, nodes); assert.equal(root.scrollTop, 120);
  assert.match(r.el["image-status"].textContent, /已加载 2/u); assert.equal(r.el["retry-images"].hidden, true);
  assert.equal(images.placeholders[0].children[0].getAttribute("src"), localImage);
  await h.ui.shutdown();
});

test("real renderer handles Markdown and HTML remote images without URL attributes, while code stays literal", async () => {
  const h = setup(), r = await review(h), gate = deferred(), requests = [];
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0S8AAAAASUVORK5CYII=";
  h.runtime.imageCacheFor = () => ({ resolve(uri, options) { requests.push({ uri, options }); return gate.promise; } });
  global.SmartPaperTranslatorModules.FulltextMarkdown = Markdown;
  r.service.pages = [`![Markdown](${remoteImage})\n\n<img src="${remoteImage}" alt="HTML">\n\n\`\`\`js\n![literal](https://other.invalid/no-fetch.png)\n\`\`\`\n`, "Second page"];
  r.service.emit({ source: r.service.pages.join("\n\n") }); await tick();
  const descendants = node => [node, ...node.children.flatMap(descendants)];
  assert.equal(requests.length, 1); assert.equal(requests[0].uri, remoteImage);
  assert.equal(descendants(r.el.rendered).filter(node => node.getAttribute("src")).length, 0);
  assert.ok(r.el.rendered.textContent.includes(remoteImage)); const selected = r.selected;
  gate.resolve(png); await tick();
  const images = descendants(r.el.rendered).filter(node => node.tag === "img");
  assert.equal(images.length, 2); assert.ok(images.every(node => node.getAttribute("src") === png));
  assert.ok(r.el.rendered.textContent.includes("![literal](https://other.invalid/no-fetch.png)"));
  assert.equal(r.selected, selected); assert.equal(r.window.confirmations.length, 0);
  await h.ui.shutdown();
});

test("image failure preserves original Markdown, hides raw errors, and retries only on request", async () => {
  const h = setup(), r = await review(h), images = imageHarness(h, [remoteImage]);
  click(r, "preview"); await tick(); images.requests[0].gate.reject(new Error(`secret response ${remoteImage}`)); await tick();
  assert.match(images.placeholders[0].textContent, /!\[figure\]/u); assert.match(r.el["image-status"].textContent, /加载失败/u);
  assert.ok(!r.el["image-status"].textContent.includes(remoteImage)); assert.equal(r.el.error.textContent, "");
  assert.equal(r.el["retry-images"].hidden, false); await tick(); assert.equal(images.requests.length, 1);
  click(r, "retry-images"); await tick(); assert.equal(images.requests.length, 2);
  images.requests[1].gate.resolve(localImage); await tick(); assert.equal(images.commits.length, 1);
  await h.ui.shutdown();
});

test("image URL limit is per render and duplicate visible images still share one job", async () => {
  const h = setup(), r = await review(h), urls = Array.from({ length: 130 }, (_, i) => `${remoteImage}-${i}`);
  const images = imageHarness(h, [...urls, urls[0]]); click(r, "preview"); await tick();
  assert.equal(images.requests.length, 128); assert.match(r.el["image-status"].textContent, /128 个不同/u);
  for (const job of images.requests) job.gate.resolve(localImage); await tick();
  assert.equal(images.commits.length, 129); assert.equal(r.el["retry-images"].hidden, false);
  await h.ui.shutdown();
});

test("page/mode/edit/source/parse/pause/close/document replacement invalidate late image downloads", async () => {
  for (const change of ["page", "mode", "edit", "source", "parse", "pause", "close", "document"]) {
    const h = setup(), r = await review(h), images = imageHarness(h, [remoteImage]);
    click(r, "preview"); await tick(); const job = images.requests[0];
    if (change === "page") click(r, "next");
    if (change === "mode") click(r, "full");
    if (change === "edit") { click(r, "edit"); edit(r, "source", "Keep draft"); }
    if (change === "source") r.service.emit({ documentRevision: "new", source: "Changed source" });
    if (change === "parse") { r.window.confirmResult = false; click(r, "parse"); }
    if (change === "pause") await h.ui._pause(r);
    if (change === "close") r.window.close();
    if (change === "document") r.window.document = { documentURI: URI };
    await tick(); assert.equal(job.options.isCurrent(), false, change);
    job.gate.resolve(localImage); await tick(); assert.equal(images.commits.length, 0, change);
    if (change === "edit") { assert.equal(r.el.source.value, "Keep draft"); assert.equal(r.dirty, true); }
    assert.ok(images.cancellations.length > 0); await h.ui.shutdown();
  }
});

test("page images require matching PDF results, but full-source preview is independent of PDF loading", async () => {
  const h = setup(), r = await review(h), images = imageHarness(h, [remoteImage]);
  click(r, "preview"); click(r, "edit"); await tick(); assert.equal(images.requests.length, 0);
  click(r, "cancel"); const gate = deferred(); r.service.preview = () => gate.promise;
  click(r, "reload"); click(r, "full"); await tick(); assert.equal(images.requests.length, 1);
  images.requests[0].gate.resolve(localImage); await tick(); assert.equal(images.commits.length, 1);
  const fullNodes = r.el.rendered.children.slice();
  gate.resolve({ dataURI: localImage, page: 2, pageCount: 2 }); await tick();
  assert.deepEqual(r.el.rendered.children, fullNodes); assert.equal(r.mode, "full");
  click(r, "preview"); await tick(); assert.equal(images.requests.length, 1); assert.equal(r.el.edit.disabled, true);
  assert.equal(r.el.rendered.children.length, 0);
  click(r, "full"); await tick(); assert.equal(images.requests.length, 2);
  images.requests[1].gate.resolve(localImage); await tick(); assert.equal(images.commits.length, 2);
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
