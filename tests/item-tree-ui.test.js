"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  ItemTreeUI,
  assignTagTones,
  tagTone
} = require("../plugin/content/item-tree-ui.js");
const { makePreferenceStore, makeCache } = require("./helpers.js");
const { TranslationService } = require("../plugin/content/service.js");

class FakeElement {
  constructor(tag) {
    this.tagName = tag;
    this.localName = tag;
    this.children = [];
    this.dataset = {};
    this.attributes = new Map();
    this.className = "";
    this.textContent = "";
    this.title = "";
    this.isConnected = true;
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }

  dispatch(type, extras = {}) {
    const event = { target: this, stopPropagation() {}, preventDefault() {}, ...extras };
    for (const listener of this.listeners.get(type) || []) listener(event);
  }

  focus() { this.focused = true; }
  get firstElementChild() { return this.children[0] || null; }
  get lastElementChild() { return this.children[this.children.length - 1] || null; }
  replaceChildren(...children) {
    for (const child of this.children.slice()) child.remove();
    this.append(...children);
  }
  openPopup() { this.dispatch("popupshown"); }
  hidePopup() { this.dispatch("popuphidden"); }

  append(...children) {
    for (const child of children) {
      child.parentNode = this;
      this.children.push(child);
    }
  }

  remove() {
    if (this.parentNode) {
      this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
    }
    this.parentNode = null;
    this.isConnected = false;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }
}

class FakeDocument {
  constructor() {
    this.head = new FakeElement("head");
    this.documentElement = new FakeElement("html");
  }

  querySelector(selector) {
    if (selector !== 'style[data-smart-paper-translator="item-tree-style"]') return null;
    return this.head.children.find(
      (child) => child.dataset.smartPaperTranslator === "item-tree-style"
    ) || null;
  }

  createElement(tag) {
    return new FakeElement(tag);
  }

  createElementNS(_namespaceURI, tag) {
    return new FakeElement(tag);
  }

  createXULElement(tag) { return new FakeElement(tag); }
}

function makeItem(overrides = {}) {
  const fields = {
    title: "World Models for Control",
    abstractNote: "We learn latent dynamics for planning and reinforcement learning."
  };
  return {
    id: 20,
    libraryID: 1,
    key: "ABCDEFGH",
    parentItemID: null,
    isRegularItem: () => true,
    isPDFAttachment: () => false,
    getField: (name) => fields[name] || "",
    ...overrides
  };
}

function makeHarness({ cachePeek } = {}) {
  const prefs = makePreferenceStore();
  const manager = {
    registered: null,
    refreshes: 0,
    unregistered: [],
    registerColumn(options) {
      this.registered = options;
      return "smart-paper-translator-smart-tags";
    },
    unregisterColumn(dataKey) {
      this.unregistered.push(dataKey);
      return true;
    },
    refreshColumns() {
      this.refreshes++;
    }
  };
  let serviceListener = null;
  let unsubscribed = false;
  const service = {
    subscribe(listener) {
      serviceListener = listener;
      return () => { unsubscribed = true; };
    }
  };
  const item = makeItem();
  const itemMap = new Map([[item.id, item]]);
  let scheduled = null;
  let nextTimerID = 0;
  const ui = new ItemTreeUI({
    cache: {
      peekSmartTags: cachePeek || (async () => null)
    },
    service,
    getPreference: prefs.get,
    itemTreeManager: manager,
    items: {
      get: (id) => itemMap.get(Number(id)) || null,
      getAll: async () => Array.from(itemMap.values())
    },
    stylesheetText: ".spt-smart-tag { border-radius: 999px; }",
    setTimer(callback) {
      scheduled = callback;
      return ++nextTimerID;
    },
    clearTimer() {
      scheduled = null;
    }
  });
  return {
    ui,
    item,
    itemMap,
    manager,
    emit: (event) => serviceListener(event),
    flushRefresh() {
      const callback = scheduled;
      scheduled = null;
      callback?.();
    },
    wasUnsubscribed: () => unsubscribed
  };
}

test("smart-tag column registers after title and lazily refreshes local cache data", async () => {
  let resolveCache;
  const cacheResult = new Promise((resolve) => { resolveCache = resolve; });
  let cacheReads = 0;
  const harness = makeHarness({
    cachePeek: async () => {
      cacheReads++;
      return cacheResult;
    }
  });
  harness.ui.init("smart-paper-translator@zotero.local");
  assert.equal(harness.manager.registered.label, "智能标签");
  assert.equal(harness.manager.registered.ordinal, 0.5);
  assert.deepEqual(harness.manager.registered.defaultIn, ["default"]);
  assert.deepEqual(harness.manager.registered.enabledTreeIDs, ["main"]);

  assert.deepEqual(JSON.parse(harness.manager.registered.dataProvider(harness.item)).tags, []);
  assert.deepEqual(JSON.parse(harness.manager.registered.dataProvider(harness.item)).tags, []);
  assert.equal(cacheReads, 1);
  resolveCache({
    sourceSignature: "source",
    configSignature: "config",
    tags: ["World Model", "Planning", "Reinforcement Learning"],
    createdAt: "2026-08-18T00:00:00.000Z"
  });
  await new Promise((resolve) => setImmediate(resolve));
  harness.flushRefresh();
  assert.equal(harness.manager.refreshes, 1);

  const data = harness.manager.registered.dataProvider(harness.item);
  assert.deepEqual(JSON.parse(data).tags, ["World Model", "Planning", "Reinforcement Learning"]);
  const cell = harness.manager.registered.renderCell(
    0,
    data,
    { className: "smart-tags" },
    false,
    new FakeDocument()
  );
  assert.match(cell.children[0].className, /cell-text/u);
  const content = cell.children[0].children[0];
  assert.equal(content.children.length, 3);
  assert.equal(cell.children[0].children[1].tagName, "button");
  assert.equal(content.children[0].textContent, "World Model");
  assert.match(content.children[0].className, /spt-smart-tag--tone-[0-4]/u);
  assert.equal(content.children[0].tagName, "button");
  assert.equal(content.children[0].title, "查看同标签文章：World Model");
  assert.match(cell.getAttribute("aria-label"), /World Model/u);
});

test("smart-tag tones are deterministic and case-insensitive", () => {
  assert.equal(tagTone("World Model"), tagTone("world model"));
  assert.ok(tagTone("World Model") >= 0 && tagTone("World Model") < 5);
  const tags = [
    "Self-Supervised Learning",
    "Wearable Sensor Data",
    "Missing Data Imputation",
    "Foundation Models",
    "Multimodal Biosignals"
  ];
  const tones = assignTagTones(tags);
  assert.deepEqual(tones, assignTagTones(tags));
  assert.equal(new Set(tones).size, tags.length);
});

test("child attachment rows never probe cache while standalone PDFs remain eligible", () => {
  let cacheReads = 0;
  const harness = makeHarness({ cachePeek: async () => { cacheReads++; return null; } });
  harness.ui.init("smart-paper-translator@zotero.local");
  const child = makeItem({
    id: 10,
    key: "HGFEDCBA",
    parentItemID: 20,
    isRegularItem: () => false,
    isPDFAttachment: () => true
  });
  assert.equal(harness.manager.registered.dataProvider(child), "");
  assert.equal(cacheReads, 0);

  const standalone = makeItem({
    id: 30,
    key: "IJKLMNOP",
    isRegularItem: () => false,
    isPDFAttachment: () => true
  });
  assert.deepEqual(JSON.parse(harness.manager.registered.dataProvider(standalone)).tags, []);
  assert.equal(cacheReads, 1);
});

test("fresh service events win over stale asynchronous cache reads", async () => {
  let resolveCache;
  const cacheResult = new Promise((resolve) => { resolveCache = resolve; });
  let query;
  const harness = makeHarness({
    cachePeek: async (_paper, cacheQuery) => {
      query = cacheQuery;
      return cacheResult;
    }
  });
  harness.ui.init("smart-paper-translator@zotero.local");
  harness.manager.registered.dataProvider(harness.item);
  await new Promise((resolve) => setImmediate(resolve));

  harness.emit({
    type: "smart-tags",
    paper: { storageKey: "1--ABCDEFGH" },
    entry: {
      sourceSignature: query.sourceSignature,
      configSignature: query.configSignature
    },
    tags: ["Fresh Tag", "Planning", "Control"]
  });
  resolveCache({
    sourceSignature: query.sourceSignature,
    configSignature: query.configSignature,
    tags: ["Stale Tag", "Old Planning", "Old Control"]
  });
  await new Promise((resolve) => setImmediate(resolve));
  const data = harness.manager.registered.dataProvider(harness.item);
  assert.deepEqual(JSON.parse(data).tags, ["Fresh Tag", "Planning", "Control"]);
});

test("item modifications invalidate rendered tags and trigger a fresh local probe", async () => {
  let cacheReads = 0;
  const harness = makeHarness({
    cachePeek: async (_paper, query) => {
      cacheReads++;
      return {
        sourceSignature: query.sourceSignature,
        configSignature: query.configSignature,
        tags: ["World Model", "Planning", "Control"]
      };
    }
  });
  harness.ui.init("smart-paper-translator@zotero.local");
  harness.manager.registered.dataProvider(harness.item);
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(harness.manager.registered.dataProvider(harness.item), /World Model/u);

  harness.ui.invalidateModifiedItems([harness.item.id]);
  assert.deepEqual(JSON.parse(harness.manager.registered.dataProvider(harness.item)).tags, []);
  assert.equal(cacheReads, 2);
});

test("cell rendering treats cached tag text as text rather than markup", () => {
  const harness = makeHarness();
  const doc = new FakeDocument();
  const cell = harness.ui.renderCell(
    0,
    JSON.stringify(["<img src=x>", "World Model", "Planning"]),
    { className: "smart-tags" },
    false,
    doc
  );
  assert.equal(cell.children[0].children[0].children[0].tagName, "span");
  assert.equal(cell.children[0].children[0].children[0].textContent, "<img src=x>");
  assert.equal(cell.children[0].children[0].children[0].children.length, 0);
});

test("window styles and registered columns are removed symmetrically", () => {
  const harness = makeHarness();
  harness.ui.init("smart-paper-translator@zotero.local");
  const doc = new FakeDocument();
  const win = { document: doc };
  const cleanup = harness.ui.addToWindow(win);
  assert.equal(doc.head.children.length, 1);
  cleanup();
  assert.equal(doc.head.children.length, 0);

  harness.ui.shutdown();
  assert.deepEqual(harness.manager.unregistered, ["smart-paper-translator-smart-tags"]);
  assert.equal(harness.wasUnsubscribed(), true);
});

function editableHarness() {
  const harness = makeHarness();
  const { cache, io } = makeCache();
  const service = new TranslationService({
    cache,
    credentials: { get() { throw new Error("Editor must not read credentials"); } },
    apiClient: { complete() { throw new Error("Editor must remain local"); } }
  });
  harness.ui.cache = cache;
  harness.ui.service = service;
  harness.ui.init("smart-paper-translator@zotero.local");
  const doc = new FakeDocument();
  const win = { document: doc, ZoteroPane: { itemsView: {} }, Zotero_Tabs: { selectedID: "zotero-pane" } };
  doc.defaultView = win;
  harness.ui.addToWindow(win);
  const anchor = doc.createElement("button");
  const identity = (item) => ({ itemID: item.id, paperStorageKey: `${item.libraryID}--${item.key}` });
  return {
    ...harness, cache, io, service, win, doc, anchor, identity,
    async open(item = harness.item) {
      await harness.ui.openEditor(doc, identity(item), anchor);
      return harness.ui.editors.get(win);
    }
  };
}

test("library editor adds, renames and removes tags locally, including papers without an abstract", async () => {
  const h = editableHarness();
  const item = makeItem({ getField: (field) => field === "title" ? "No abstract" : "" });
  h.itemMap.set(item.id, item);
  let state = await h.open(item);
  state.rows[0].input.value = "  中文主题  ";
  state.add.dispatch("click");
  state.rows[1].input.value = "Research";
  await h.ui._saveEditor(state);
  assert.equal(h.ui.editors.size, 0);
  assert.deepEqual(JSON.parse(h.ui.dataProvider(item)).tags, ["中文主题", "Research"]);

  state = await h.open(item);
  state.rows[0].input.value = "Renamed";
  const deletedRow = state.rows[1];
  deletedRow.remove.dispatch("click");
  deletedRow.remove.dispatch("click");
  assert.equal(state.rows.length, 1);
  await h.ui._saveEditor(state);
  assert.deepEqual(JSON.parse(h.ui.dataProvider(item)).tags, ["Renamed"]);
  state = await h.open(item);
  state.rows[0].remove.dispatch("click");
  await h.ui._saveEditor(state);
  assert.deepEqual((await h.cache.peekSmartTags(h.ui._descriptor(item).paper)).tags, []);
  h.ui.onPreferencesChanged();
  h.ui.dataProvider(item);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(JSON.parse(h.ui.dataProvider(item)).tags, []);
  assert.equal(h.ui.manualValues.has("1--ABCDEFGH"), true);
});

test("save failures keep input and allow retry; concurrent clicks cannot duplicate writes", async () => {
  const h = editableHarness();
  const state = await h.open();
  state.rows[0].input.value = "Mine";
  const write = h.io.writeJSON.bind(h.io);
  h.io.writeJSON = async () => { throw new Error("disk full"); };
  await h.ui._saveEditor(state);
  assert.equal(state.rows[0].input.value, "Mine");
  assert.equal(state.busy, false);
  assert.equal(state.save.disabled, false);
  assert.match(state.status.textContent, /保存失败/u);
  assert.equal(h.ui.manualValues.size, 0);
  h.io.writeJSON = write;
  await Promise.all([h.ui._saveEditor(state), h.ui._saveEditor(state)]);
  assert.equal(h.io.writeJSONCalls.length, 1);
});

test("cancel and late reads cannot replace a newly opened paper editor", async () => {
  const h = editableHarness();
  const originalPeek = h.cache.peekSmartTags.bind(h.cache);
  let resolve;
  h.cache.peekSmartTags = () => new Promise((done) => { resolve = done; });
  const firstOpen = h.open();
  const oldState = h.ui.editors.get(h.win);
  oldState.panel.dispatch("keydown", { key: "Escape" });
  assert.equal(h.ui.editors.size, 0);
  h.cache.peekSmartTags = originalPeek;
  const other = makeItem({ id: 21, key: "OTHERKEY" });
  h.itemMap.set(other.id, other);
  const current = await h.open(other);
  resolve({ tags: ["Stale"] });
  await firstOpen;
  assert.equal(h.ui.editors.get(h.win), current);
  assert.equal(current.rows[0].input.value, "");
  assert.equal(h.io.writeJSONCalls.length, 0);
  h.ui.removeFromWindow(h.win);
  assert.equal(h.ui.editors.size, 0);
});

test("editor identity never follows selection or a changed view, and removed items cannot be saved", async () => {
  const h = editableHarness();
  let state = await h.open();
  state.rows[0].input.value = "Must not save";
  h.win.ZoteroPane.itemsView = {};
  await h.ui._saveEditor(state);
  assert.equal(h.io.writeJSONCalls.length, 0);
  state = await h.open();
  h.itemMap.set(h.item.id, makeItem({ key: "OTHERKEY" }));
  await h.ui._saveEditor(state);
  assert.equal(h.io.writeJSONCalls.length, 0);
  h.ui.closeEditor(h.win);
  await h.open();
  assert.equal(h.ui.editors.size, 0);
});

test("unreadable editor data blocks saving and does not recover or overwrite corrupt records", async () => {
  const h = editableHarness();
  h.io.setText("/records/1--ABCDEFGH.json", "{broken");
  const state = await h.open();
  assert.equal(state.loadFailed, true);
  assert.equal(state.save.disabled, true);
  await h.ui._saveEditor(state);
  assert.equal(h.io.writeJSONCalls.length, 0);
  assert.equal(h.io.files.size, 1);
});

test("manual clearing wins over stale cache probes and automatic events and supports more than five tones", async () => {
  const h = editableHarness();
  let resolve;
  h.cache.peekSmartTags = () => new Promise((done) => { resolve = done; });
  h.ui.dataProvider(h.item);
  await h.service.saveSmartTags(h.ui._descriptor(h.item).paper, []);
  resolve({ tags: ["Stale"], configSignature: "old" });
  await new Promise((done) => setImmediate(done));
  h.ui._handleServiceEvent({
    type: "smart-tags", paper: { storageKey: "1--ABCDEFGH" },
    entry: { configSignature: "old" }, tags: ["Stale event"]
  });
  assert.deepEqual(JSON.parse(h.ui.dataProvider(h.item)).tags, []);
  assert.equal(assignTagTones(Array.from({ length: 20 }, (_, i) => `Tag ${i}`)).length, 20);
});

async function openResults(h, tag = "Planning", item = h.item) {
  await h.ui.openTagResults(h.doc, h.identity(item), tag, h.anchor);
  return h.ui.tagResults.get(h.win);
}

test("individual tag buttons use the clicked item identity and preserve native keyboard activation", async () => {
  const h = editableHarness();
  await h.service.saveSmartTags(h.ui._descriptor(h.item).paper, ["Planning", "Control"]);
  const cell = h.ui.renderCell(999, h.ui.dataProvider(h.item), {}, false, h.doc);
  const chip = cell.children[0].children[0].children[1];
  let clicked;
  h.ui.openTagResults = async (...args) => { clicked = args; };
  h.win.ZoteroPane.getSelectedItems = () => { throw new Error("Must not follow selection"); };
  let stopped = 0;
  chip.dispatch("keydown", {
    key: "Enter", stopPropagation: () => stopped++,
    preventDefault: () => assert.fail("Do not cancel native button activation")
  });
  chip.dispatch("click", { stopPropagation: () => stopped++ });
  assert.equal(stopped, 2);
  assert.equal(chip.type, "button");
  assert.equal(chip.getAttribute("aria-haspopup"), "dialog");
  assert.deepEqual(clicked[1], { tags: ["Planning", "Control"], ...h.identity(h.item) });
  assert.equal(clicked[2], "Control");
  assert.equal(clicked[3], chip);
  assert.equal(h.ui.editors.size, 0);
});

test("tag aggregation spans the clicked library with exact normalized matching and manual precedence", async () => {
  const h = editableHarness();
  const add = (id, overrides = {}) => {
    const item = makeItem({ id, key: `KEY${String(id).padStart(5, "0")}`, ...overrides });
    h.itemMap.set(id, item);
    return item;
  };
  const auto = add(21);
  const cleared = add(22);
  const replaced = add(23);
  const otherLibrary = add(24, { libraryID: 2 });
  const deleted = add(25);
  const child = add(26, { parentItemID: h.item.id, isRegularItem: () => false, isPDFAttachment: () => true });
  const standalone = add(27, { isRegularItem: () => false, isPDFAttachment: () => true });
  const noAbstract = add(28, { getField: (field) => field === "title" ? "<img src=x>" : "" });
  const stale = add(29);
  for (const item of [auto, cleared, replaced, stale]) {
    const d = h.ui._descriptor(item);
    await h.cache.append(d.paper, {
      kind: "smart-tags", normalizedSource: "source", sourceSignature: d.sourceSignature,
      configSignature: item === stale ? "old-config" : d.configSignature,
      tags: ["  PLANNING  "], createdAt: "2026-09-30"
    });
  }
  for (const item of [h.item, otherLibrary, deleted, standalone, noAbstract]) {
    await h.service.saveSmartTags(h.ui._descriptor(item).paper, ["Planning"]);
  }
  deleted.deleted = true;
  await h.service.saveSmartTags(h.ui._descriptor(cleared).paper, []);
  await h.service.saveSmartTags(h.ui._descriptor(replaced).paper, ["Planning Ahead"]);
  const writes = h.io.writeJSONCalls.length;
  let query;
  h.ui.items.getAll = async (...args) => {
    query = args;
    return [...h.itemMap.values(), auto]; // Defensive exclusion and deduplication.
  };
  const state = await openResults(h, " planning ");
  assert.deepEqual(query, [1, true, false]);
  assert.deepEqual(state.results.map((r) => r.itemID).sort((a, b) => a - b), [20, 21, 27, 28]);
  assert.equal(state.list.children[0].lastElementChild.textContent, "<img src=x>");
  assert.equal(state.list.children[0].lastElementChild.children.length, 0);
  assert.match(state.status.textContent, /共 4 篇/u);
  assert.equal(state.failures, 0);
  assert.equal(h.io.writeJSONCalls.length, writes);
  assert.equal(h.ui._descriptor(child), null);
});

test("all matches remain reachable across bounded result pages and bounded cache batches", async () => {
  const h = editableHarness();
  for (let i = 0; i < 104; i++) {
    const item = makeItem({ id: 100 + i, key: `PAGE${String(i).padStart(4, "0")}` });
    h.itemMap.set(item.id, item);
  }
  let active = 0;
  let maximum = 0;
  h.cache.peekSmartTags = async () => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setImmediate(resolve));
    active--;
    return { tags: ["Planning"] };
  };
  const state = await openResults(h);
  assert.equal(state.results.length, 105);
  assert.equal(state.list.children.length, 50);
  assert.ok(maximum <= 8);
  state.next.dispatch("click");
  assert.equal(state.list.getAttribute("start"), "51");
  state.next.dispatch("click");
  assert.equal(state.list.children.length, 5);
  assert.equal(state.next.disabled, true);
  assert.match(state.status.textContent, /共 105 篇 · 第 3 \/ 3 页/u);
  state.previous.dispatch("click");
  assert.equal(state.list.children.length, 50);
  assert.equal(h.io.writeJSONCalls.length, 0);
});

test("closed, replaced, changed-view and destroyed result panels discard late cache reads", async () => {
  for (const change of ["escape", "replace", "tab", "view", "identity", "window", "shutdown"]) {
    const h = editableHarness();
    let resolve;
    h.cache.peekSmartTags = () => new Promise((done) => { resolve = done; });
    const pending = openResults(h);
    await new Promise((done) => setImmediate(done));
    const stale = h.ui.tagResults.get(h.win);
    if (change === "escape") stale.panel.dispatch("keydown", { key: "Escape" });
    if (change === "tab") h.win.Zotero_Tabs.selectedID = "reader-tab";
    if (change === "view") h.win.ZoteroPane.itemsView = {};
    if (change === "identity") h.itemMap.set(h.item.id, makeItem({ key: "OTHERKEY" }));
    if (change === "window") h.ui.removeFromWindow(h.win);
    if (change === "shutdown") h.ui.shutdown();
    let replacement;
    if (change === "replace") {
      h.cache.peekSmartTags = async () => ({ tags: ["Control"] });
      replacement = await openResults(h, "Control");
    }
    resolve({ tags: ["Planning"] });
    await pending;
    assert.equal(stale.list.children.length, 0, change);
    assert.equal(stale.panel.isConnected, false, change);
    assert.equal(h.ui.tagResults.get(h.win), replacement, change);
  }
});

test("tag edits invalidate in-flight aggregation and refresh uses the new local state", async () => {
  const h = editableHarness();
  let resolve;
  const peek = h.cache.peekSmartTags.bind(h.cache);
  h.cache.peekSmartTags = () => new Promise((done) => { resolve = done; });
  const pending = openResults(h);
  await new Promise((done) => setImmediate(done));
  const state = h.ui.tagResults.get(h.win);
  await h.service.saveSmartTags(h.ui._descriptor(h.item).paper, []);
  assert.match(state.status.textContent, /已更新/u);
  h.cache.peekSmartTags = peek;
  await h.ui._loadTagResults(state);
  resolve({ tags: ["Planning"] });
  await pending;
  assert.equal(state.results.length, 0);
  assert.match(state.status.textContent, /没有找到/u);
  assert.equal(state.refresh.disabled, false);
  assert.equal(state.list.getAttribute("aria-busy"), "false");
});

test("cache failures show incomplete results without changing damaged files and allow retry", async () => {
  const h = editableHarness();
  const broken = makeItem({ id: 21, key: "BROKEN01" });
  h.itemMap.set(broken.id, broken);
  await h.service.saveSmartTags(h.ui._descriptor(h.item).paper, ["Planning"]);
  h.io.setText("/records/1--BROKEN01.json", "{broken");
  const writes = h.io.writeJSONCalls.length;
  const state = await openResults(h);
  assert.equal(state.results.length, 1);
  assert.equal(state.failures, 1);
  assert.match(state.status.textContent, /结果可能不完整/u);
  assert.equal(h.io.writeJSONCalls.length, writes);
  assert.equal(h.io.files.size, 2);
  const getAll = h.ui.items.getAll;
  h.ui.items.getAll = async () => { throw new Error("Library not available"); };
  await h.ui._loadTagResults(state);
  assert.equal(state.list.children.length, 0);
  assert.match(state.status.textContent, /无法读取/u);
  assert.equal(state.refresh.disabled, false);
  h.ui.items.getAll = getAll;
  await h.ui._loadTagResults(state);
  assert.equal(state.results.length, 1);
});

test("locating a result revalidates its identity and tag and selects it in the library root", async () => {
  const h = editableHarness();
  await h.service.saveSmartTags(h.ui._descriptor(h.item).paper, ["Planning"]);
  const selected = [];
  h.win.ZoteroPane.selectItem = async (...args) => { selected.push(args); return true; };
  let state = await openResults(h);
  await h.ui._locateTagResult(state, state.results[0]);
  assert.deepEqual(selected, [[h.item.id, { inLibraryRoot: true }]]);
  assert.equal(h.ui.tagResults.size, 0);
  state = await openResults(h);
  h.cache.peekSmartTags = async () => ({ tags: [] });
  await h.ui._locateTagResult(state, state.results[0]);
  assert.equal(selected.length, 1);
  assert.match(state.status.textContent, /已更新/u);
  h.cache.peekSmartTags = async () => ({ tags: ["Planning"] });
  await h.ui._loadTagResults(state);
  const stale = state.results[0];
  h.item.deleted = true;
  await h.ui._locateTagResult(state, stale);
  assert.equal(selected.length, 1);
});

test("late location requests cannot act after closing; result and editor panels clean up each other", async () => {
  const h = editableHarness();
  h.cache.peekSmartTags = async () => ({ tags: ["Planning"] });
  let state = await openResults(h);
  const selected = [];
  h.win.ZoteroPane.selectItem = async (...args) => { selected.push(args); return true; };
  let resolve;
  h.cache.peekSmartTags = () => new Promise((done) => { resolve = done; });
  const locate = h.ui._locateTagResult(state, state.results[0]);
  h.ui.closeTagResults(h.win);
  resolve({ tags: ["Planning"] });
  await locate;
  assert.deepEqual(selected, []);
  h.cache.peekSmartTags = async () => ({ tags: ["Planning"] });
  state = await openResults(h);
  const editor = await h.open();
  assert.equal(state.panel.isConnected, false);
  await openResults(h);
  assert.equal(editor.panel.isConnected, false);
  h.ui.shutdown();
  assert.equal(h.ui.tagResults.size, 0);
  assert.equal(h.ui.editors.size, 0);
});
