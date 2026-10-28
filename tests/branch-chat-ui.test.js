"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { BranchChatUI } = require("../plugin/content/branch-chat-ui.js");
const { CodexChatUI } = require("../plugin/content/codex-chat-ui.js");

const WINDOW_URI = "chrome://smart-paper-translator/content/branch-chat.xhtml";
const clone = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function promptly(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("UI task remained pending after close")), 1000);
    })]);
  }
  finally { clearTimeout(timer); }
}

class Events {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, callback, capture = false) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Map());
    this.listeners.get(type).set(callback, capture);
  }
  removeEventListener(type, callback) {
    this.listeners.get(type)?.delete(callback);
    if (!this.listeners.get(type)?.size) this.listeners.delete(type);
  }
  dispatchEvent(event) {
    event.target ||= this;
    event.preventDefault ||= () => { event.defaultPrevented = true; };
    event.stopPropagation ||= () => { event.stopped = true; };
    event.stopImmediatePropagation ||= () => { event.stopped = true; };
    for (const callback of [...(this.listeners.get(event.type)?.keys() || [])]) {
      event.currentTarget = this;
      callback(event);
      if (event.stopped) break;
    }
    return !event.defaultPrevented;
  }
  get listenerCount() {
    return [...this.listeners.values()].reduce((count, entries) => count + entries.size, 0);
  }
}
class Node extends Events {
  constructor(localName, doc, text = "") {
    super();
    this.localName = localName;
    this.ownerDocument = doc;
    this.parentNode = null;
    this.children = [];
    this.attributes = new Map();
    this._text = text;
    this.className = "";
    this.style = {};
    this.dataset = {};
    this.value = "";
    this.hidden = false;
    this.disabled = false;
    this.open = false;
    this.scrollTop = this.scrollHeight = this.clientHeight = 0;
  }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(""); }
  set textContent(text) { this.replaceChildren(); this._text = String(text); }
  set innerHTML(_text) { throw new Error("innerHTML is forbidden"); }
  append(...nodes) {
    for (const child of nodes) {
      child.parentNode = this;
      this.children.push(child);
    }
  }
  insertBefore(node, before) {
    if (!before) return this.append(node);
    node.parentNode = this;
    this.children.splice(this.children.indexOf(before), 0, node);
  }
  replaceChildren(...nodes) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this._text = "";
    this.append(...nodes);
  }
  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this);
    this.parentNode = null;
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  get firstChild() { return this.children[0] || null; }
  get firstElementChild() { return this.children.find(child => child.localName) || null; }
  get lastElementChild() { return [...this.children].reverse().find(child => child.localName) || null; }
  contains(other) { return this === other || this.children.some(child => child.contains(other)); }
  focus() { this.ownerDocument.activeElement = this; }
  reportValidity() { return true; }
}
class Document extends Events {
  constructor(win, url, readyState) {
    super();
    this.defaultView = win;
    this.documentURI = this.URL = url;
    this.readyState = readyState;
    this.documentElement = new Node("html", this);
    this.head = new Node("head", this);
    this.body = new Node("body", this);
    this.documentElement.append(this.head, this.body);
  }
  createElement(name) {
    if (name === this.failTag) throw new Error("DOM creation failure");
    return new Node(name, this);
  }
  createElementNS(_namespace, name) { return this.createElement(name); }
  createTextNode(text) { return new Node(null, this, text); }
  getElementById(id) { return descendants(this.documentElement).find(node => node.id === id) || null; }
}
class Window extends Events {
  constructor(url = "chrome://zotero/content/zoteroPane.xhtml", readyState = "complete") {
    super();
    this.document = new Document(this, url, readyState);
    this.closed = false;
    this.confirmations = [];
    this.alerts = [];
    this.confirmResult = true;
    this.focusCount = 0;
  }
  confirm(text) { this.confirmations.push(text); return this.confirmResult; }
  alert(text) { this.alerts.push(text); }
  focus() { this.focusCount++; }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.dispatchEvent({ type: "close" });
    this.dispatchEvent({ type: "unload", target: this.document });
  }
  loaded(url = WINDOW_URI) {
    this.document.documentURI = this.document.URL = url;
    this.document.readyState = "complete";
    this.dispatchEvent({ type: "load", target: this.document });
  }
}
const descendants = node => [node, ...node.children.flatMap(descendants)];
const byClass = (node, className) => descendants(node).find(child => child.className.split(/\s/u).includes(className));
function context(agentId = "codex", attachmentID = 10) {
  return {
    agentId, attachmentID,
    paper: { storageKey: "1--PAPER123", attachmentKey: "PDF12345", attachmentID, title: "A long paper title: " + "paper ".repeat(25) },
    selectionText: 'Selected <script>not executable</script> & **not Markdown**',
    answerText: "Full source answer", questionText: "Original question",
    config: { model: "provider/full/" + "model-name/".repeat(15), reasoningEffort: "high" }
  };
}
class Service {
  constructor(captured, index, hooks = {}) {
    this.context = captured;
    this.hooks = hooks;
    this.calls = { load: [], send: [], cancel: [], shutdown: 0, unsubscribe: 0, permissions: [], elicitations: [], visualizations: [], citations: [] };
    this.listeners = new Set();
    this.subscriptions = [];
    this.state = {
      agentId: captured.agentId, attachmentID: captured.attachmentID, status: "idle", pendingInteractions: [],
      record: { session: { localID: `branch-${index}`, workspacePath: `/temporary/branch-${index}`, config: clone(captured.config) }, transcript: [] }
    };
  }
  snapshot() { return clone(this.state); }
  subscribe(id, callback) {
    assert.equal(id, this.context.attachmentID);
    if (this.hooks.subscribe) return this.hooks.subscribe(this, callback);
    this.listeners.add(callback);
    this.subscriptions.push(callback);
    return () => { this.calls.unsubscribe++; this.listeners.delete(callback); };
  }
  load(id) {
    this.calls.load.push(id);
    return this.hooks.load ? this.hooks.load(this) : Promise.resolve(this.snapshot());
  }
  emit(patch = {}) {
    Object.assign(this.state, patch);
    for (const callback of this.listeners) callback(this.snapshot());
  }
  answer(text, status = "ready", pendingInteractions = []) {
    this.state.record.transcript = [{ id: "answer", kind: "message", role: "agent", text }];
    this.emit({ status, pendingInteractions });
  }
  async send(id, text) {
    this.calls.send.push([id, text]);
    if (this.hooks.send) return this.hooks.send(this, id, text);
    this.state.record.transcript.push({ id: `user-${this.calls.send.length}`, kind: "message", role: "user", text });
    this.state.record.transcript.push({ id: `reply-${this.calls.send.length}`, kind: "message", role: "agent", text: `Reply to ${text}` });
    this.emit({ status: "ready", error: null });
  }
  async cancel(id) {
    this.calls.cancel.push(id);
    if (this.hooks.cancel) return this.hooks.cancel(this);
    this.emit({ status: "cancelled" });
  }
  async respondPermission(...args) { this.calls.permissions.push(args); }
  async respondElicitation(...args) { this.calls.elicitations.push(args); }
  async readVisualization(...args) { this.calls.visualizations.push(args); return { html: "<p>local</p>" }; }
  async revealCitation(...args) { this.calls.citations.push(args); }
  async shutdown() {
    this.calls.shutdown++;
    if (this.hooks.shutdown) return this.hooks.shutdown(this);
  }
}
function harness(t, options = {}) {
  const h = { services: [], children: [], openCalls: [], logs: [], owner: new Window() };
  h.ui = new BranchChatUI({
    rootURI: "jar:file:///plugin.xpi!/", stylesheetText: ".spt-codex-messages { user-select: text; }",
    windowURI: options.windowURI,
    createService(captured) {
      if (options.createService) return options.createService(captured, h);
      const hooks = typeof options.hooks === "function" ? options.hooks(h.services.length) : options.hooks;
      const service = new Service(captured, h.services.length, hooks);
      h.services.push(service);
      return service;
    },
    openWindow(owner, url, name, features) {
      h.openCalls.push({ owner, url, name, features });
      if (options.openWindow) return options.openWindow(owner, url, h);
      const win = new Window(url, options.readyState || "complete");
      h.children.push(win);
      return win;
    },
    log(...args) { h.logs.push(args); }
  });
  h.record = (owner = h.owner) => h.ui.windows.get(owner)?.current;
  h.open = (value = context(), owner = h.owner) => h.ui.open(owner, value);
  t.after(() => h.ui.shutdown().catch(error => { if (!options.cleanupFails) throw error; }));
  return h;
}

for (const agentId of ["codex", "pi", "opencode"]) {
  test(`${agentId}: minimal window keeps context/settings only in memory and opening sends nothing`, async t => {
    const h = harness(t);
    const source = context(agentId);
    const expected = clone(source);
    const opening = h.open(source);
    source.paper.title = "Different paper after opening";
    source.config.model = "different model";
    source.answerText = "Different answer";
    assert.equal(await opening, true);
    const record = h.record(), service = h.services[0], view = record.view;
    assert.deepEqual(service.context, expected);
    assert.equal(record.renderer instanceof CodexChatUI, true);
    assert.equal(record.renderer.service, service);
    assert.equal(record.renderer.views.get(view.body), view);
    assert.equal(record.renderer.paneID, null);
    assert.deepEqual(service.calls.load, [10]);
    assert.deepEqual(service.calls.send, []);
    assert.deepEqual(service.calls.cancel, []);
    assert.deepEqual(view.elements.input.value, "");
    assert.equal(view.elements.send.disabled, true);
    assert.equal(view.elements.explain.disabled, false);
    assert.equal(view.elements.stop.hidden, true);
    assert.equal(byClass(view.root, "spt-branch-paper-title").textContent, expected.paper.title);
    for (const removed of ["metadata", "disclosure", "context", "quote", "source"]) {
      assert.equal(byClass(view.root, `spt-branch-${removed}`), undefined);
    }
    for (const value of [expected.selectionText, expected.config.model, expected.answerText, expected.questionText]) {
      assert.equal(view.root.textContent.includes(value), false);
    }
    assert.deepEqual(byClass(view.root, "spt-branch-header").children.map(node => node.localName), ["h1", "h2"]);
    assert.equal(view.root.children[1], view.elements.messages, "conversation immediately follows the title");
    assert.equal(descendants(view.root).some(node => ["script", "img", "select"].includes(node.localName)), false);
    assert.deepEqual(descendants(view.root).filter(node => node.localName === "button").map(node => node.textContent),
      ["Explain this passage", "Stop", "Send"]);
    assert.doesNotMatch(view.root.textContent, /not a sandbox|may retain records|Only sending starts/u);
    assert.equal(h.openCalls[0].url, WINDOW_URI);
    assert.match(h.openCalls[0].features, /dialog=no,resizable/u);
    assert.doesNotMatch(h.openCalls[0].features, /modal/u);
    assert.equal(h.children[0].document.activeElement, view.elements.input);
  });
}

test("branch shares GPT progress and non-GPT live/collapsed thought rendering", async t => {
  const h = harness(t);
  await h.open(context("opencode"));
  const service = h.services[0], view = h.record().view;
  service.state.record.session.config.model = "anthropic/claude-sonnet-4";
  service.state.record.transcript = [{ id: "t", kind: "thought", text: "Full thought", status: "streaming" }];
  service.emit({ status: "generating", activityText: "Last thought line" });
  assert.equal(view.elements.status.textContent, "thinking…");
  assert.equal(view.elements.messages.children[0].open, true);
  service.emit({ status: "ready" });
  assert.equal(view.elements.messages.children[0].open, false);
  service.state.record.session.config.model = "openai/gpt-5.6";
  service.emit({ status: "generating" });
  assert.equal(view.elements.status.textContent, "Last thought line");
  assert.equal(view.elements.messages.children.length, 0);
  service.emit({ status: "waiting-approval" });
  assert.equal(view.elements.status.textContent, "Waiting for your response");
});

test("several turns remain isolated by owner, attachment and Agent; explain preserves an existing draft", async t => {
  const h = harness(t), otherOwner = new Window();
  await h.open(context("pi"));
  await h.open(context("opencode", 11), otherOwner);
  const first = h.record(), second = h.record(otherOwner);
  first.view.elements.input.value = "Draft to keep";
  assert.equal(await h.ui._send(first, true), true);
  assert.equal(first.view.elements.input.value, "Draft to keep");
  assert.equal(await h.ui._send(first), true);
  assert.equal(first.view.elements.input.value, "");
  first.view.elements.input.value = "A second custom question";
  assert.equal(await h.ui._send(first), true);
  assert.deepEqual(h.services[0].calls.send, [[10, "Explain this passage"], [10, "Draft to keep"], [10, "A second custom question"]]);
  assert.deepEqual(h.services[1].calls.send, []);
  assert.equal(second.view.elements.messages.textContent.includes("Draft to keep"), false);
  assert.notEqual(first.renderer, second.renderer);
  assert.notEqual(h.openCalls[0].name, h.openCalls[1].name);
  // Main Reader/tab/Agent changes are not observed by this isolated UI.
  h.owner.dispatchEvent({ type: "select", attachmentID: 99 });
  h.owner.dispatchEvent({ type: "TabClose" });
  assert.equal(first.view.attachmentID, 10);
  assert.equal(first.view.agentId, "pi");
  assert.equal(first.window.closed, false);
});

test("declining replacement retains the existing window, history and service", async t => {
  const h = harness(t);
  await h.open();
  const previous = h.record();
  previous.view.elements.input.value = "Unsaved question";
  h.owner.confirmResult = false;
  assert.equal(await h.open(context("pi", 12)), false);
  assert.equal(h.record(), previous);
  assert.equal(h.services.length, 1);
  assert.equal(h.children.length, 1);
  assert.equal(h.services[0].calls.shutdown, 0);
  assert.equal(previous.view.elements.input.value, "Unsaved question");
  assert.equal(previous.window.focusCount, 1);
  assert.equal(h.owner.confirmations.length, 1);
});

test("replacement is serialized behind old backend cleanup, including already-closing windows", async t => {
  const cleanup = deferred();
  const h = harness(t, { hooks: index => index === 0 ? { shutdown: () => cleanup.promise } : {} });
  await h.open();
  const oldView = h.record().view, oldWindow = h.children[0];
  const replacement = h.open(context("pi"));
  await tick();
  assert.equal(h.services[0].calls.shutdown, 1);
  assert.equal(oldWindow.closed, true);
  assert.equal(oldWindow.document.body.children.length, 0);
  assert.equal(oldWindow.document.listenerCount, 0);
  assert.equal(oldView.elements.input.value, "");
  assert.equal(h.services.length, 1);
  assert.equal(h.children.length, 1);
  cleanup.resolve();
  assert.equal(await replacement, true);
  assert.equal(h.services.length, 2);
  assert.equal(h.record().context.agentId, "pi");
  const close = deferred();
  h.services[1].hooks.shutdown = () => close.promise;
  h.children[1].close();
  const next = h.open(context("opencode"));
  await tick();
  assert.equal(h.services.length, 2);
  close.resolve();
  assert.equal(await next, true);
  assert.equal(h.owner.confirmations.length, 1, "an already closed window needs no second discard confirmation");
});

test("cleanup failure fails closed instead of creating another service", async t => {
  const h = harness(t, { cleanupFails: true, hooks: { shutdown: async () => { throw new Error("cleanup failed"); } } });
  await h.open();
  assert.equal(await h.open(context("pi")), false);
  assert.equal(h.services.length, 1);
  assert.equal(h.services[0].calls.shutdown, 1);
  assert.equal(h.children[0].closed, true);
  assert.equal(await h.open(), false);
  assert.match(h.owner.alerts.at(-1), /temporary files may remain|可能残留临时文件/u);
  await assert.rejects(h.ui.shutdown(), /cleanup failed/u);
  assert.equal(h.owner.listenerCount, 0);
});

test("close during document loading settles open without creating a service, and ignores late load", async t => {
  const h = harness(t, { readyState: "loading" });
  const opening = h.open();
  await tick();
  const win = h.children[0];
  const lateLoad = [...win.listeners.get("load").keys()][0];
  win.close();
  assert.equal(await promptly(opening), false);
  assert.equal(h.services.length, 0);
  assert.equal(win.listenerCount, 0);
  win.document.readyState = "complete";
  lateLoad({ target: win.document });
  await tick();
  assert.equal(h.services.length, 0);
  assert.equal(h.ui.windows.size, 0);
});

test("a late asynchronously returned window is closed after owner-close/shutdown, with no hanging open", async t => {
  for (const shutdown of [false, true]) {
    const result = deferred();
    const h = harness(t, { openWindow: () => result.promise });
    const opening = h.open();
    await tick();
    if (shutdown) await promptly(h.ui.shutdown());
    else { h.owner.close(); await promptly(h.ui.closeForWindow(h.owner)); }
    assert.equal(await promptly(opening), false);
    const lateWindow = new Window(WINDOW_URI);
    result.resolve(lateWindow);
    await tick();
    assert.equal(lateWindow.closed, true);
    assert.equal(h.services.length, 0);
    assert.equal(h.ui.windows.size, 0);
  }
});

test("initial about:blank and iframe load/unload do not consume the target document listeners", async t => {
  const h = harness(t, { openWindow(_owner, _url, current) {
    const win = new Window("about:blank");
    current.children.push(win);
    return win;
  } });
  const opening = h.open();
  await tick();
  const win = h.children[0], blank = win.document;
  win.dispatchEvent({ type: "load", target: blank });
  win.dispatchEvent({ type: "unload", target: blank });
  const iframe = new Window(WINDOW_URI);
  win.dispatchEvent({ type: "load", target: iframe.document });
  win.dispatchEvent({ type: "unload", target: iframe.document });
  assert.equal(win.closed, false);
  assert.equal(h.services.length, 0);
  win.document = new Document(win, WINDOW_URI, "complete");
  win.dispatchEvent({ type: "load", target: win.document });
  assert.equal(await opening, true);
  win.dispatchEvent({ type: "unload", target: blank });
  assert.equal(win.closed, false, "even a late initial-document unload cannot discard the bound branch");
  win.dispatchEvent({ type: "unload", target: iframe.document });
  assert.equal(h.services[0].calls.shutdown, 0);
  win.dispatchEvent({ type: "unload", target: win.document });
  await tick();
  assert.equal(h.services[0].calls.shutdown, 1);
});

test("target readyState is checked after binding, and a different document is rejected", async t => {
  const uri = "chrome://test/content/branch.xhtml";
  const h = harness(t, { windowURI: uri });
  assert.equal(await h.open(), true);
  assert.equal(h.openCalls[0].url, uri);
  await h.ui.closeForWindow(h.owner);
  const bad = harness(t, { readyState: "loading" });
  const opening = bad.open();
  await tick();
  bad.children[0].loaded("chrome://other/content/unexpected.xhtml");
  assert.equal(await promptly(opening), false);
  assert.equal(bad.services.length, 0);
  assert.equal(bad.children[0].closed, true);
});

test("close during service load shuts it down immediately and discards late results/rejections", async t => {
  for (const rejects of [false, true]) {
    const load = deferred();
    const h = harness(t, { hooks: index => index === 0 ? { load: () => load.promise } : {} });
    const opening = h.open();
    await tick();
    const service = h.services[0], view = h.record().view;
    const lateSubscriber = service.subscriptions[0];
    h.children[0].close();
    assert.equal(await promptly(opening), false);
    assert.equal(service.calls.shutdown, 1);
    assert.equal(service.calls.unsubscribe, 1);
    assert.equal(view.state, null);
    assert.equal(view.body.children.length, 0);
    assert.equal(await h.open(context("pi")), true);
    if (rejects) load.reject(new Error("late load failure"));
    else load.resolve(service.snapshot());
    lateSubscriber(service.snapshot());
    await tick();
    assert.equal(h.record().view.agentId, "pi");
    assert.equal(h.record().view.elements.notices.textContent, "");
    assert.equal(service.calls.shutdown, 1);
  }
});

test("a stale load return cannot overwrite a newer subscribed snapshot", async t => {
  const load = deferred();
  const h = harness(t, { hooks: { load: () => load.promise } });
  const opening = h.open();
  await tick();
  const initial = h.services[0].snapshot();
  h.services[0].answer("Newer in-memory state");
  load.resolve(initial);
  assert.equal(await opening, true);
  assert.match(h.record().view.elements.messages.textContent, /Newer in-memory state/u);
});

test("close during send/cancel stops the UI task; late failures cannot affect a replacement", async t => {
  const send = deferred(), cancel = deferred();
  const h = harness(t, { hooks: index => index === 0 ? {
    send(service) { service.emit({ status: "connecting" }); return send.promise; },
    cancel: () => cancel.promise
  } : {} });
  await h.open();
  const old = h.record(), view = old.view;
  view.elements.input.value = "Pending question";
  const sending = h.ui._send(old);
  assert.equal(view.elements.stop.hidden, false);
  assert.equal(view.elements.stop.disabled, false);
  const stopping = h.ui._cancel(old);
  await promptly(h.ui.closeForWindow(h.owner));
  assert.equal(await promptly(sending), false);
  assert.equal(await promptly(stopping), false);
  assert.equal(h.services[0].calls.shutdown, 1);
  assert.equal(view.state, null);
  assert.equal(view.elements.input.value, "");
  await h.open(context("opencode", 20));
  send.reject(new Error("old send failed"));
  cancel.reject(new Error("old cancel failed"));
  h.services[0].subscriptions[0](h.services[0].snapshot());
  await tick();
  assert.equal(h.record().view.attachmentID, 20);
  assert.equal(h.record().view.elements.notices.textContent, "");
});

test("owner close only destroys its own branch; shutdown is idempotent and removes every listener", async t => {
  const h = harness(t), secondOwner = new Window();
  await h.open();
  await h.open(context("pi"), secondOwner);
  const firstDoc = h.children[0].document, secondDoc = h.children[1].document;
  h.owner.close();
  await promptly(h.ui.closeForWindow(h.owner));
  assert.equal(h.services[0].calls.shutdown, 1);
  assert.equal(h.services[1].calls.shutdown, 0);
  assert.equal(h.children[1].closed, false);
  const shutdown = h.ui.shutdown();
  assert.equal(h.ui.shutdown(), shutdown);
  await shutdown;
  assert.equal(h.services[1].calls.shutdown, 1);
  assert.equal(h.children.every(win => win.closed && win.listenerCount === 0), true);
  assert.equal(firstDoc.listenerCount, 0);
  assert.equal(secondDoc.listenerCount, 0);
  assert.equal(h.owner.listenerCount, 0);
  assert.equal(secondOwner.listenerCount, 0);
  assert.equal(h.ui.windows.size, 0);
  assert.equal(await h.open(), false);
});

test("queued opens are invalidated by an explicit close rather than reopening after cleanup", async t => {
  const load = deferred();
  const h = harness(t, { hooks: { load: () => load.promise } });
  const first = h.open();
  const second = h.open(context("pi"));
  await tick();
  await promptly(h.ui.closeForWindow(h.owner));
  assert.equal(await first, false);
  assert.equal(await second, false);
  assert.equal(h.services.length, 1);
  assert.equal(h.services[0].calls.shutdown, 1);
  load.resolve(h.services[0].snapshot());
});

test("all initialization failures close the window and dispose any constructed service", async t => {
  const cases = [
    { hooks: { load: async () => { throw new Error("load failure"); } } },
    { hooks: { load: async () => ({ status: "idle" }) } },
    { hooks: { subscribe: () => { throw new Error("subscribe failure"); } } },
    { openWindow(_owner, url, h) { const win = new Window(url); win.document.failTag = "header"; h.children.push(win); return win; } },
    { createService: () => { throw new Error("construction failure"); } },
    { openWindow: () => { throw new Error("window failure"); } }
  ];
  for (const options of cases) {
    const h = harness(t, options);
    assert.equal(await promptly(h.open()), false);
    assert.equal(h.children.every(win => win.closed && win.listenerCount === 0), true);
    assert.equal(h.services.every(service => service.calls.shutdown === 1), true);
    assert.equal(h.ui.windows.size, 0);
    assert.equal(h.owner.listenerCount, 0);
  }
});

test("send failures preserve the exact draft; Enter, IME, quick explain and Stop have explicit semantics", async t => {
  const pending = deferred();
  const h = harness(t, { hooks: { send: () => pending.promise } });
  await h.open();
  const record = h.record(), { input, send, stop, notices, explain } = record.view.elements;
  input.value = "  My question\nwith spacing  ";
  input.dispatchEvent({ type: "input" });
  assert.equal(send.disabled, false);
  for (const options of [{ shiftKey: true }, { isComposing: true }, { keyCode: 229 }]) {
    const event = { type: "keydown", key: "Enter", ...options };
    input.dispatchEvent(event);
    assert.equal(event.defaultPrevented, undefined);
  }
  assert.equal(h.services[0].calls.send.length, 0);
  const event = { type: "keydown", key: "Enter" };
  input.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
  assert.equal(h.services[0].calls.send.length, 1);
  assert.equal(send.disabled, true);
  assert.equal(explain.disabled, true);
  assert.equal(input.readOnly, true);
  assert.equal(input.disabled, false, "a pending draft remains selectable/copyable");
  assert.equal(stop.hidden, false);
  assert.equal(await h.ui._send(record), false, "duplicate sends are locked even before any state notification");
  pending.reject(new Error("Please retry"));
  await tick();
  assert.equal(input.value, "  My question\nwith spacing  ");
  assert.equal(notices.textContent, "Please retry");
  assert.equal(send.disabled, false);
  h.services[0].hooks.send = null;
  assert.equal(await h.ui._send(record), true);
  assert.equal(input.value, "");
  assert.equal(notices.textContent, "");
  assert.equal(send.disabled, true);
  for (const status of ["connecting", "generating", "waiting-approval"]) {
    h.services[0].emit({ status });
    assert.equal(stop.hidden, false);
    assert.equal(stop.disabled, false);
    assert.equal(await h.ui._cancel(record), true);
  }
  assert.deepEqual(h.services[0].calls.cancel, [10, 10, 10]);
  input.value = "Keep while explaining";
  explain.dispatchEvent({ type: "click" });
  await tick();
  assert.equal(h.services[0].calls.send.at(-1)[1], "Explain this passage");
  assert.equal(input.value, "Keep while explaining");
});

test("selected transcript nodes defer updates, not status/Stop/permissions; clearing selection paints latest state", async t => {
  const h = harness(t);
  await h.open();
  const record = h.record(), view = record.view, doc = record.document, service = h.services[0];
  service.answer("Original selected answer");
  const selected = view.elements.messages.firstElementChild;
  const selection = { isCollapsed: false, rangeCount: 1, getRangeAt: () => ({ intersectsNode: node => node === view.elements.messages }) };
  record.window.getSelection = () => selection;
  service.answer("Streaming update", "generating");
  assert.equal(view.elements.messages.firstElementChild, selected);
  assert.equal(view.transcriptDeferred, true);
  assert.equal(view.elements.status.textContent, "thinking…");
  assert.equal(view.elements.stop.hidden, false);
  const permission = { id: "approval-1", type: "permission", title: "Read temporary source", toolCall: { kind: "read", content: [], rawInput: {} }, options: [{ optionId: "once", name: "Allow once", kind: "allow_once" }] };
  service.answer("Still streaming", "waiting-approval", [permission]);
  assert.equal(view.elements.messages.firstElementChild, selected);
  assert.equal(view.elements.status.textContent, "Waiting for your response");
  assert.equal(view.elements.stop.disabled, false);
  const allow = descendants(view.elements.interactions).find(node => node.localName === "button");
  allow.dispatchEvent({ type: "click" });
  await tick();
  assert.deepEqual(service.calls.permissions, [[10, "approval-1", "once"]]);
  service.answer("Final answer", "ready");
  assert.equal(view.elements.messages.firstElementChild, selected);
  assert.equal(view.elements.stop.hidden, true);
  doc.dispatchEvent({ type: "selectionchange" });
  assert.equal(view.elements.messages.firstElementChild, selected);
  selection.isCollapsed = true;
  doc.dispatchEvent({ type: "selectionchange" });
  assert.notEqual(view.elements.messages.firstElementChild, selected);
  assert.match(view.elements.messages.textContent, /Final answer/u);
  const lateSelection = [...doc.listeners.get("selectionchange").keys()][0];
  await h.ui.closeForWindow(h.owner);
  assert.equal(doc.listenerCount, 0);
  lateSelection();
  assert.equal(view.state, null);
});

test("Pi elicitation inputs survive unchanged interaction snapshots and route to the branch service", async t => {
  const h = harness(t);
  await h.open(context("pi"));
  const record = h.record(), service = h.services[0], interactions = record.view.elements.interactions;
  const elicitation = { id: "pi-form", type: "elicitation", message: "Choose a label", requestedSchema: { type: "object", properties: { label: { type: "string", title: "Label" } }, required: ["label"] } };
  service.answer("First", "waiting-approval", [elicitation]);
  const form = descendants(interactions).find(node => node.localName === "form");
  const input = descendants(form).find(node => node.localName === "input");
  input.value = "Partially typed text";
  input.focus();
  service.answer("Stream updates", "waiting-approval", [clone(elicitation)]);
  assert.equal(descendants(interactions).find(node => node.localName === "form"), form);
  assert.equal(input.value, "Partially typed text");
  assert.equal(record.document.activeElement, input);
  const submit = descendants(form).find(node => node.localName === "button");
  submit.dispatchEvent({ type: "click" });
  await tick();
  assert.deepEqual(service.calls.elicitations, [[10, "pi-form", "accept", { label: "Partially typed text" }]]);
  const implicit = { type: "submit" };
  interactions.dispatchEvent(implicit);
  assert.equal(implicit.defaultPrevented, true);
  service.answer("Changed request", "waiting-approval", [{ ...elicitation, id: "pi-form-2" }]);
  assert.notEqual(descendants(interactions).find(node => node.localName === "form"), form);
});

test("existing safe renderer routes file/visualization reads to this branch only and cleans pending previews", async t => {
  const h = harness(t);
  await h.open(context("opencode"));
  const record = h.record(), service = h.services[0];
  const mounted = [];
  let disposed = 0;
  record.renderer.visualizeRenderer = {
    mount(_doc, _node, options) { mounted.push(options); options.registerCleanup(() => disposed++); },
    shutdown() {}
  };
  const text = 'A citation :codex-file-citation{path="output/chart.html"} and \uE200visualize\uE202{"path":"output/chart.html"}\uE201';
  service.answer(text, "generating");
  assert.equal(mounted.length, 0);
  service.answer(text, "ready");
  assert.equal(mounted.length, 1);
  assert.equal(mounted[0].current(), true);
  await mounted[0].load("output/chart.html");
  assert.deepEqual(service.calls.visualizations, [[10, "output/chart.html", "branch-0"]]);
  const citation = byClass(record.view.elements.messages, "spt-codex-file-citation");
  citation.dispatchEvent({ type: "click" });
  await tick();
  assert.deepEqual(service.calls.citations, [[10, "output/chart.html"]]);
  await h.ui.closeForWindow(h.owner);
  assert.equal(mounted[0].current(), false);
  assert.equal(disposed, 1);
});

test("capability catalog is copied only for the backend factory, never rendered or sent as a question", async t => {
  const h = harness(t);
  const source = context();
  const catalog = { schemaVersion: 1, configOptions: [{ id: "model", currentValue: "internal-catalog-value" }] };
  source.configurationCatalog = clone(catalog);
  const opening = h.open(source);
  source.configurationCatalog.configOptions[0].currentValue = "later mutation";
  assert.equal(await opening, true);
  assert.deepEqual(h.services[0].context.configurationCatalog, catalog);
  assert.equal(h.record().view.root.textContent.includes("internal-catalog-value"), false);
  await h.ui._send(h.record(), true);
  assert.deepEqual(h.services[0].calls.send, [[10, "Explain this passage"]]);
});

test("synchronous close inside factory/subscribe still shuts down the service and never calls load", async t => {
  for (const stage of ["factory", "subscribe"]) {
    let detached = 0;
    const h = harness(t, { createService(captured, current) {
      const service = new Service(captured, 0, stage === "subscribe" ? {
        subscribe() { current.owner.close(); return () => { detached++; }; }
      } : {});
      current.services.push(service);
      if (stage === "factory") current.owner.close();
      return service;
    } });
    assert.equal(await promptly(h.open()), false);
    assert.equal(h.services[0].calls.shutdown, 1);
    assert.deepEqual(h.services[0].calls.load, []);
    assert.equal(detached, stage === "subscribe" ? 1 : 0);
    assert.equal(h.ui.windows.size, 0);
  }
});

test("default dialog opener uses only the chrome URI, unique name and nonmodal features", async t => {
  const owner = new Window(), calls = [];
  owner.openDialog = (...args) => {
    calls.push(args);
    return new Window(args[0]);
  };
  const ui = new BranchChatUI({
    rootURI: "jar:file:///resource-only.xpi!/",
    createService: captured => new Service(captured, 0)
  });
  t.after(() => ui.shutdown());
  assert.equal(await ui.open(owner, context()), true);
  assert.equal(calls[0].length, 3, "no owner, context, callback or main service travels as window arguments");
  assert.equal(calls[0][0], WINDOW_URI);
  assert.match(calls[0][1], /^spt-branch-chat-/u);
  assert.match(calls[0][2], /chrome,dialog=no,resizable/u);
});

test("new controls and quick explanation use the opening locale without adding localization resources", async t => {
  const previous = global.Zotero;
  global.Zotero = { locale: "zh-CN" };
  try {
    const h = harness(t);
    assert.equal(await h.open(), true);
    const record = h.record();
    assert.equal(record.view.elements.explain.textContent, "解释这段内容");
    assert.equal(record.view.elements.send.textContent, "发送");
    assert.doesNotMatch(record.view.root.textContent, /不是沙箱|可能保留记录|只有发送才会启动|选中文字|源上下文/u);
    assert.equal(record.document.documentElement.getAttribute("lang"), "zh-CN");
    await h.ui._send(record, true);
    assert.deepEqual(h.services[0].calls.send, [[10, "解释这段内容"]]);
    await h.ui.shutdown();
  }
  finally { global.Zotero = previous; }
});

test("minimal window keeps local styles, selectable titles, theme colors and a filling conversation area", () => {
  const content = path.join(__dirname, "../plugin/content");
  const xhtml = fs.readFileSync(path.join(content, "branch-chat.xhtml"), "utf8");
  const css = fs.readFileSync(path.join(content, "branch-chat.css"), "utf8");
  const js = fs.readFileSync(path.join(content, "branch-chat-ui.js"), "utf8");
  assert.doesNotMatch(xhtml, /<script|\bon\w+=|https?:\/\/(?!www\.w3\.org\/1999\/xhtml)/iu);
  assert.match(xhtml, /href="codex-chat\.css"/u);
  assert.match(xhtml, /href="branch-chat\.css"/u);
  assert.match(css, /color-scheme:\s*light dark/u);
  assert.match(css, /user-select:\s*text/u);
  assert.match(css, /\.spt-branch-paper-title\s*\{[^}]*overflow-wrap:\s*anywhere/u);
  assert.doesNotMatch(css, /spt-branch-(?:metadata|disclosure|context|quote|source)/u);
  assert.match(css, /\.spt-branch-chat\s*\{[^}]*height:\s*100vh/u);
  assert.match(css, /\.spt-branch-chat \.spt-codex-messages\s*\{[^}]*flex:\s*1 1 180px;[^}]*max-height:\s*none/u);
  assert.doesNotMatch(css, /text-overflow:\s*ellipsis/u);
  assert.doesNotMatch(js, /innerHTML|\.init\([^)]/u);
});
