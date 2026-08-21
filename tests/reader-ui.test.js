"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { ReaderUI } = require("../plugin/content/reader-ui.js");
const Constants = require("../plugin/content/constants.js");

class FakeElement {
  constructor(tag, namespaceURI = "http://www.w3.org/1999/xhtml") {
    this.tagName = tag;
    this.namespaceURI = namespaceURI;
    this.children = [];
    this.listeners = new Map();
    this.dataset = {};
    this.attributes = new Map();
    this.style = {};
    this.classes = new Set();
    this.classList = {
      add: (...names) => names.forEach((name) => this.classes.add(name)),
      remove: (...names) => names.forEach((name) => this.classes.delete(name)),
      toggle: (name, force) => {
        const active = force === undefined ? !this.classes.has(name) : Boolean(force);
        if (active) this.classes.add(name);
        else this.classes.delete(name);
        return active;
      },
      contains: (name) => this.classes.has(name)
    };
    this.isConnected = true;
    this.textContent = "";
    this.disabled = false;
    this.hidden = false;
    this.offsetWidth = 390;
    this.offsetHeight = tag === "header" ? 52 : 300;
  }
  append(...children) {
    for (const child of children) {
      child.parentNode = this;
      child.isConnected = true;
      this.children.push(child);
    }
  }
  replaceChildren(...children) {
    this.children = [];
    this.append(...children);
  }
  remove() {
    if (this.parentNode) {
      this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
    }
    this.parentNode = null;
    this.isConnected = false;
  }
  addEventListener(name, handler) { this.listeners.set(name, handler); }
  removeEventListener(name) { this.listeners.delete(name); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  focus() { this.focused = true; }
  closest(selector) { return selector === "button" && this.tagName === "button" ? this : null; }
  setPointerCapture(pointerId) { this.capturedPointerId = pointerId; }
  releasePointerCapture(pointerId) {
    if (this.capturedPointerId === pointerId) this.capturedPointerId = null;
  }
  getBoundingClientRect() {
    const numericStyle = (name, fallback) => {
      const value = Number.parseFloat(this.style[name]);
      return Number.isFinite(value) ? value : fallback;
    };
    return {
      left: numericStyle("left", 500),
      top: numericStyle("top", 56),
      width: numericStyle("width", this.offsetWidth),
      height: numericStyle("height", this.offsetHeight)
    };
  }
  async dispatch(name, event = {}) {
    const payload = Object.assign({
      target: this,
      currentTarget: this,
      button: 0,
      shiftKey: false,
      stopPropagation() { this.propagationStopped = true; },
      preventDefault() { this.defaultPrevented = true; }
    }, event);
    return this.listeners.get(name)?.(payload);
  }
}

class FakeDocument {
  constructor() {
    this.head = new FakeElement("head");
    this.body = new FakeElement("body");
    this.documentElement = { clientWidth: 900, clientHeight: 700 };
    this.listeners = new Map();
  }
  querySelector() { return null; }
  createElement(tag) { return new FakeElement(tag); }
  createElementNS(namespaceURI, tag) { return new FakeElement(tag, namespaceURI); }
  addEventListener(name, handler) { this.listeners.set(name, handler); }
  removeEventListener(name) { this.listeners.delete(name); }
  async dispatch(name, event = {}) {
    const payload = Object.assign({
      target: this.body,
      preventDefault() { this.defaultPrevented = true; }
    }, event);
    return this.listeners.get(name)?.(payload);
  }
}

const readerStylesheet = fs.readFileSync(
  path.join(__dirname, "../plugin/content/reader.css"),
  "utf8"
);

test("selection popup waits for a click after a cache miss when automatic mode is off", async () => {
  let calls = 0;
  let cacheLookups = 0;
  const ui = new ReaderUI({
    service: {
      subscribe() { return () => {}; },
      async getCachedSelection() {
        cacheLookups++;
        return null;
      },
      async translateSelection() {
        calls++;
        return { translation: "模型", fromCache: false };
      }
    },
    getPreference(name) {
      if (name.endsWith("autoTranslateSelection")) return false;
    },
    stylesheetText: readerStylesheet
  });
  const doc = new FakeDocument();
  const reader = { itemID: 10 };
  let container;
  ui.handleSelectionPopup({
    reader,
    doc,
    params: { annotation: { text: "model", position: { pageIndex: 1 } } },
    append(node) { container = node; }
  });
  assert.equal(calls, 0);
  const button = container.children[0];
  assert.equal(button.disabled, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cacheLookups, 1);
  assert.equal(button.disabled, false);
  await button.dispatch("click");
  assert.equal(calls, 1);
  assert.equal(button.hidden, false);
  assert.equal(button.disabled, true);
  assert.equal(container.children[1].hidden, true);
  assert.equal(container.children[2].textContent, "翻译完成");
  assert.equal(container.children[3].textContent, "模型");
});

test("selection popup translates automatically after a cache miss when enabled", async () => {
  let calls = 0;
  let cacheLookups = 0;
  const ui = new ReaderUI({
    service: {
      subscribe() { return () => {}; },
      async getCachedSelection() {
        cacheLookups++;
        return null;
      },
      async translateSelection() {
        calls++;
        return { translation: "模型", fromCache: false };
      }
    },
    getPreference(name) {
      if (name.endsWith("autoTranslateSelection")) return true;
    },
    stylesheetText: readerStylesheet
  });
  const doc = new FakeDocument();
  const reader = { itemID: 10 };
  let container;

  ui.handleSelectionPopup({
    reader,
    doc,
    params: { annotation: { text: "model", position: { pageIndex: 1 } } },
    append(node) { container = node; }
  });
  assert.equal(calls, 0);
  await new Promise((resolve) => setImmediate(resolve));

  const [button, cacheTag, status, result] = container.children;
  assert.equal(cacheLookups, 1);
  assert.equal(calls, 1);
  assert.equal(button.hidden, true);
  assert.equal(button.disabled, true);
  assert.equal(cacheTag.hidden, true);
  assert.equal(status.textContent, "翻译完成");
  assert.equal(result.textContent, "模型");
});

test("selection popup displays a cached translation and only refreshes it after a click", async () => {
  let translationCalls = 0;
  let translationArguments;
  const ui = new ReaderUI({
    service: {
      subscribe() { return () => {}; },
      async getCachedSelection() {
        return { translation: "模型", fromCache: true };
      },
      async translateSelection(...args) {
        translationCalls++;
        translationArguments = args;
        return { translation: "新版模型", fromCache: false };
      }
    },
    getPreference(name) {
      if (name.endsWith("autoTranslateSelection")) return true;
    },
    stylesheetText: readerStylesheet
  });
  const doc = new FakeDocument();
  const reader = { itemID: 10 };
  let container;

  ui.handleSelectionPopup({
    reader,
    doc,
    params: { annotation: { text: "model", position: { pageIndex: 1 } } },
    append(node) { container = node; }
  });
  await new Promise((resolve) => setImmediate(resolve));

  const [button, cacheTag, status, result] = container.children;
  assert.equal(button.hidden, false);
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, "重新翻译");
  assert.match(button.getAttribute("aria-label"), /重新翻译/u);
  assert.equal(cacheTag.hidden, false);
  assert.equal(cacheTag.textContent, "缓存");
  assert.equal(status.textContent, "");
  assert.equal(result.textContent, "模型");
  assert.equal(translationCalls, 0);

  await button.dispatch("click");

  assert.equal(translationCalls, 1);
  assert.deepEqual(translationArguments, [10, "model", 2, { forceRefresh: true }]);
  assert.equal(button.hidden, true);
  assert.equal(cacheTag.hidden, true);
  assert.equal(status.textContent, "翻译完成");
  assert.equal(result.textContent, "新版模型");
});

test("failed cached retranslation keeps the cached result visible and retryable", async () => {
  let translationCalls = 0;
  const ui = new ReaderUI({
    service: {
      subscribe() { return () => {}; },
      async getCachedSelection() {
        return { translation: "原缓存译文", fromCache: true };
      },
      async translateSelection() {
        translationCalls++;
        throw new Error("服务暂时不可用");
      }
    },
    getPreference() { return false; },
    stylesheetText: readerStylesheet
  });
  const doc = new FakeDocument();
  const reader = { itemID: 10 };
  let container;

  ui.handleSelectionPopup({
    reader,
    doc,
    params: { annotation: { text: "model", position: { pageIndex: 0 } } },
    append(node) { container = node; }
  });
  await new Promise((resolve) => setImmediate(resolve));

  const [button, cacheTag, status, result] = container.children;
  await button.dispatch("click");

  assert.equal(translationCalls, 1);
  assert.equal(cacheTag.hidden, false);
  assert.equal(result.textContent, "原缓存译文");
  assert.match(status.textContent, /重新翻译失败.*服务暂时不可用/u);
  assert.equal(status.classList.contains("spt-error"), true);
  assert.equal(button.hidden, false);
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, "重新翻译");
});

test("toolbar injects separate panel and selection-translation buttons", async () => {
  const ui = new ReaderUI({
    service: { subscribe() { return () => {}; } },
    getPreference(name) {
      if (name.endsWith("autoOpen")) return false;
      return -1;
    },
    setPreference() {},
    stylesheetText: readerStylesheet
  });
  ui.refreshState = () => {};
  const doc = new FakeDocument();
  const reader = { itemID: 10 };
  const appended = [];

  ui.handleToolbar({ reader, doc, append: (...nodes) => appended.push(...nodes) });

  assert.equal(appended.length, 2);
  assert.equal(appended[0].tagName, "button");
  assert.equal(appended[0].children[0].tagName, "svg");
  assert.equal(appended[0].getAttribute("aria-pressed"), "false");
  assert.equal(appended[1].tagName, "button");
  assert.equal(appended[1].children[0].tagName, "svg");
  assert.equal(appended[1].getAttribute("aria-pressed"), "false");
  assert.equal(appended[1].getAttribute("aria-label"), "禁用当前论文的划线翻译");
  assert.equal(doc.body.children.length, 1);
  assert.equal(doc.body.children[0].tagName, "aside");
  assert.notEqual(doc.body.children[0].parentNode, appended[0]);
  assert.equal(doc.head.children[0].tagName, "style");
  assert.match(doc.head.children[0].textContent, /\.spt-panel\s*\{[\s\S]*position:\s*fixed/);

  const state = ui.states.get(reader);
  assert.equal(state.resizeHandle.tagName, "button");
  assert.equal(state.resizeHandle.getAttribute("aria-label"), "调整论文智译悬浮窗大小");
  assert.equal(state.tabButtons.summary.getAttribute("aria-selected"), "true");
  assert.equal(state.tabButtons.glossary.getAttribute("aria-selected"), "false");
  assert.equal(state.tabPanels.summary.hidden, false);
  assert.equal(state.tabPanels.glossary.hidden, true);

  await state.tabButtons.glossary.dispatch("click");
  assert.equal(state.tabButtons.summary.getAttribute("aria-selected"), "false");
  assert.equal(state.tabButtons.glossary.getAttribute("aria-selected"), "true");
  assert.equal(state.tabPanels.summary.hidden, true);
  assert.equal(state.tabPanels.glossary.hidden, false);

  await state.tabButtons.glossary.dispatch("keydown", { key: "ArrowLeft" });
  assert.equal(state.tabButtons.summary.getAttribute("aria-selected"), "true");
  assert.equal(state.tabButtons.summary.focused, true);

  await appended[0].dispatch("click");
  assert.equal(doc.body.children[0].hidden, false);
  assert.equal(appended[0].getAttribute("aria-pressed"), "true");
  assert.equal(appended[0].classList.contains("active"), true);

  await appended[0].dispatch("click");
  assert.equal(doc.body.children[0].hidden, true);
  assert.equal(appended[0].getAttribute("aria-pressed"), "false");
  assert.equal(appended[0].classList.contains("active"), false);
});

test("selection-translation toggle persists per PDF and blocks popup work", async () => {
  const values = new Map([
    [Constants.PREFS.selectionTranslationDisabledItems, "[]"],
    [Constants.PREFS.autoOpen, false]
  ]);
  const saved = [];
  let cacheLookups = 0;
  let translationCalls = 0;
  const ui = new ReaderUI({
    service: {
      subscribe() { return () => {}; },
      async getCachedSelection() {
        cacheLookups++;
        return null;
      },
      async translateSelection() {
        translationCalls++;
        return { translation: "不应出现", fromCache: false };
      }
    },
    getPreference(name) {
      return values.has(name) ? values.get(name) : -1;
    },
    setPreference(name, value) {
      saved.push([name, value]);
      values.set(name, value);
    },
    stylesheetText: readerStylesheet
  });
  ui.refreshState = () => {};

  const firstReader = { itemID: 10 };
  const firstButtons = [];
  ui.handleToolbar({
    reader: firstReader,
    doc: new FakeDocument(),
    append: (...nodes) => firstButtons.push(...nodes)
  });
  const firstToggle = firstButtons[1];
  await firstToggle.dispatch("click");

  assert.deepEqual(saved, [[Constants.PREFS.selectionTranslationDisabledItems, '["10"]']]);
  assert.equal(firstToggle.getAttribute("aria-pressed"), "true");
  assert.equal(firstToggle.getAttribute("aria-label"), "启用当前论文的划线翻译");
  assert.equal(firstToggle.classList.contains("active"), true);

  let popupAppends = 0;
  ui.handleSelectionPopup({
    reader: firstReader,
    doc: new FakeDocument(),
    params: { annotation: { text: "model", position: { pageIndex: 0 } } },
    append() { popupAppends++; }
  });
  assert.equal(popupAppends, 0);
  assert.equal(cacheLookups, 0);
  assert.equal(translationCalls, 0);

  const secondReader = { itemID: 10 };
  const secondButtons = [];
  ui.handleToolbar({
    reader: secondReader,
    doc: new FakeDocument(),
    append: (...nodes) => secondButtons.push(...nodes)
  });
  assert.equal(secondButtons[1].getAttribute("aria-pressed"), "true");

  const otherPaperButtons = [];
  ui.handleToolbar({
    reader: { itemID: 11 },
    doc: new FakeDocument(),
    append: (...nodes) => otherPaperButtons.push(...nodes)
  });
  assert.equal(otherPaperButtons[1].getAttribute("aria-pressed"), "false");

  await secondButtons[1].dispatch("click");
  assert.equal(values.get(Constants.PREFS.selectionTranslationDisabledItems), "[]");
  assert.equal(firstToggle.getAttribute("aria-pressed"), "false");
  assert.equal(secondButtons[1].getAttribute("aria-pressed"), "false");
  assert.equal(otherPaperButtons[1].getAttribute("aria-pressed"), "false");
});

test("abstract cache state is a tag and never mutates the translation text", async () => {
  const errors = [];
  const ui = new ReaderUI({
    service: {
      subscribe() { return () => {}; },
      async ensureSmartTags() {
        throw new Error("tag provider unavailable");
      },
      async getGlossaryForItem() {
        return {
          paper: {
            storageKey: "1--ABCDEFGH",
            attachmentID: 10,
            parentItemID: 20,
            title: "A Test Paper"
          },
          entries: []
        };
      },
      async ensureAbstract() {
        return {
          status: "translated",
          fromCache: true,
          translation: "完整摘要译文",
          paper: {
            storageKey: "1--ABCDEFGH",
            attachmentID: 10,
            parentItemID: 20,
            title: "A Test Paper"
          }
        };
      }
    },
    getPreference(name) {
      if (name.endsWith("autoOpen")) return true;
      return -1;
    },
    setPreference() {},
    stylesheetText: readerStylesheet,
    log(message) { errors.push(message); }
  });
  const doc = new FakeDocument();
  const reader = { itemID: 10 };

  ui.handleToolbar({ reader, doc, append() {} });
  await new Promise((resolve) => setImmediate(resolve));

  const state = ui.states.get(reader);
  assert.equal(state.summaryNode.textContent, "完整摘要译文");
  assert.doesNotMatch(state.summaryNode.textContent, /来自缓存/);
  assert.equal(state.summaryCacheTag.hidden, false);
  assert.equal(state.summaryCacheTag.textContent, "缓存");
  assert.deepEqual(errors, ["智能标签生成失败"]);
});

test("panel drag uses pointer capture and persists its freely moved position", async () => {
  const saved = [];
  const ui = new ReaderUI({
    service: { subscribe() { return () => {}; } },
    getPreference(name) {
      if (name.endsWith("autoOpen")) return true;
      if (name.endsWith("panelY")) return 56;
      return -1;
    },
    setPreference(name, value) { saved.push([name, value]); },
    stylesheetText: readerStylesheet
  });
  ui.refreshState = () => {};
  const doc = new FakeDocument();
  const reader = { itemID: 10 };

  ui.handleToolbar({ reader, doc, append() {} });
  const state = ui.states.get(reader);
  await state.panelHeader.dispatch("pointerdown", {
    pointerId: 7,
    clientX: 600,
    clientY: 80
  });
  assert.equal(state.panelHeader.capturedPointerId, 7);
  assert.equal(state.panel.classList.contains("spt-dragging"), true);

  await doc.dispatch("pointermove", {
    pointerId: 7,
    clientX: 320,
    clientY: 260
  });
  assert.equal(state.panel.style.left, "220px");
  assert.equal(state.panel.style.top, "236px");

  await doc.dispatch("pointerup", { pointerId: 7 });
  assert.equal(state.panelHeader.capturedPointerId, null);
  assert.equal(state.panel.classList.contains("spt-dragging"), false);
  assert.deepEqual(saved.map((entry) => entry[1]), [220, 236]);
});

test("panel resize handle changes both dimensions and persists them", async () => {
  const saved = [];
  const ui = new ReaderUI({
    service: { subscribe() { return () => {}; } },
    getPreference(name) {
      if (name.endsWith("autoOpen")) return true;
      if (name.endsWith("panelX")) return 100;
      if (name.endsWith("panelY")) return 56;
      if (name.endsWith("panelWidth")) return 390;
      if (name.endsWith("panelHeight")) return 300;
      return -1;
    },
    setPreference(name, value) { saved.push([name, value]); },
    stylesheetText: readerStylesheet
  });
  ui.refreshState = () => {};
  const doc = new FakeDocument();
  const reader = { itemID: 10 };

  ui.handleToolbar({ reader, doc, append() {} });
  const state = ui.states.get(reader);
  await state.resizeHandle.dispatch("pointerdown", {
    pointerId: 9,
    clientX: 490,
    clientY: 356
  });
  assert.equal(state.resizeHandle.capturedPointerId, 9);
  assert.equal(state.panel.classList.contains("spt-resizing"), true);

  await doc.dispatch("pointermove", {
    pointerId: 9,
    clientX: 610,
    clientY: 436
  });
  assert.equal(state.panel.style.width, "510px");
  assert.equal(state.panel.style.height, "380px");

  await doc.dispatch("pointerup", { pointerId: 9 });
  assert.equal(state.resizeHandle.capturedPointerId, null);
  assert.equal(state.panel.classList.contains("spt-resizing"), false);
  assert.deepEqual(saved.map(([name, value]) => [name.split(".").pop(), value]), [
    ["panelWidth", 510],
    ["panelHeight", 380]
  ]);
});

test("reopening a dismissed panel refreshes state", async () => {
  const ui = new ReaderUI({
    service: { subscribe() { return () => {}; } },
    getPreference() { return false; },
    setPreference() {}
  });
  let refreshes = 0;
  ui.refreshState = () => { refreshes++; };
  const state = {
    doc: new FakeDocument(),
    panel: Object.assign(new FakeElement("aside"), { hidden: true, isConnected: false }),
    panelHeader: new FakeElement("header"),
    closeButton: new FakeElement("button"),
    resizeHandle: new FakeElement("button"),
    toolbarButton: new FakeElement("button"),
    tabButtons: {
      summary: new FakeElement("button"),
      glossary: new FakeElement("button")
    },
    tabPanels: {
      summary: new FakeElement("section"),
      glossary: new FakeElement("section")
    },
    dismissed: true,
    manualOpen: false,
    requestSerial: 1,
    domCleanups: []
  };

  ui._bindPanelEvents(state);
  await state.toolbarButton.dispatch("click");

  assert.equal(state.panel.hidden, false);
  assert.equal(state.dismissed, false);
  assert.equal(state.manualOpen, true);
  assert.equal(refreshes, 1);
});

test("abstract service events cannot bypass the active render guard", () => {
  const ui = new ReaderUI({ service: { subscribe() { return () => {}; } } });
  const summary = new FakeElement("div");
  const state = {
    destroyed: false,
    itemID: 10,
    paperStorageKey: "1--ABCDEFGH",
    summaryNode: summary
  };
  ui.states.set({}, state);
  ui._handleServiceEvent({
    type: "translation",
    paper: { storageKey: "1--ABCDEFGH", attachmentID: 10 },
    entry: { kind: "abstract", isTerm: false },
    translation: "可能已经过期的摘要译文"
  });
  assert.equal(summary.textContent, "");
});
