"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  ItemTreeUI,
  assignTagTones,
  tagTone
} = require("../plugin/content/item-tree-ui.js");
const { makePreferenceStore } = require("./helpers.js");

class FakeElement {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.dataset = {};
    this.attributes = new Map();
    this.className = "";
    this.textContent = "";
    this.title = "";
    this.isConnected = true;
  }

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
    items: { get: (id) => itemMap.get(Number(id)) || null },
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

  assert.equal(harness.manager.registered.dataProvider(harness.item), "");
  assert.equal(harness.manager.registered.dataProvider(harness.item), "");
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
  assert.deepEqual(JSON.parse(data), ["World Model", "Planning", "Reinforcement Learning"]);
  const cell = harness.manager.registered.renderCell(
    0,
    data,
    { className: "smart-tags" },
    false,
    new FakeDocument()
  );
  assert.equal(cell.children.length, 3);
  assert.equal(cell.children[0].textContent, "World Model");
  assert.match(cell.children[0].className, /spt-smart-tag--tone-[0-4]/u);
  assert.equal(cell.children[0].title, "World Model");
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
  assert.equal(harness.manager.registered.dataProvider(standalone), "");
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
  assert.deepEqual(JSON.parse(data), ["Fresh Tag", "Planning", "Control"]);
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
  assert.equal(harness.manager.registered.dataProvider(harness.item), "");
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
  assert.equal(cell.children[0].tagName, "span");
  assert.equal(cell.children[0].textContent, "<img src=x>");
  assert.equal(cell.children[0].children.length, 0);
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
