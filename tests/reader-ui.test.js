"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { ReaderUI } = require("../plugin/content/reader-ui.js");

class FakeElement {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.listeners = new Map();
    this.dataset = {};
    this.classList = { add() {}, toggle() {} };
    this.isConnected = true;
    this.textContent = "";
    this.disabled = false;
  }
  append(...children) { this.children.push(...children); }
  addEventListener(name, handler) { this.listeners.set(name, handler); }
  removeEventListener(name) { this.listeners.delete(name); }
  setAttribute() {}
  async dispatch(name) { return this.listeners.get(name)?.({}); }
}

class FakeDocument {
  constructor() {
    this.head = new FakeElement("head");
    this.documentElement = { clientWidth: 900, clientHeight: 700 };
  }
  querySelector() { return null; }
  createElement(tag) { return new FakeElement(tag); }
}

test("selection popup performs no translation until the user clicks", async () => {
  let calls = 0;
  const ui = new ReaderUI({
    service: {
      subscribe() { return () => {}; },
      async translateSelection() {
        calls++;
        return { translation: "模型", fromCache: false };
      }
    },
    rootURI: "resource://plugin/"
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
  await button.dispatch("click");
  assert.equal(calls, 1);
  assert.equal(container.children[2].textContent, "模型");
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
    toolbarButton: new FakeElement("button"),
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
