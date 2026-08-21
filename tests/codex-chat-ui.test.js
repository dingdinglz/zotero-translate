"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Constants = require("../plugin/content/constants.js");
const {
  CodexChatUI,
  CODEX_L10N_RESOURCE,
  CODEX_HEADER_L10N_ID,
  CODEX_SIDENAV_L10N_ID,
  ensureCodexLocalization,
  resolveReaderAttachmentID,
  renderSafeMarkdown
} = require("../plugin/content/codex-chat-ui.js");

class Node {
  constructor(localName, text = "") {
    this.localName = localName;
    this.tagName = localName;
    this.children = [];
    this.listeners = new Map();
    this.textContent = text;
    this.className = "";
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = [...children]; }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  get lastElementChild() { return [...this.children].reverse().find((child) => child.localName) || null; }
}

class Document {
  constructor() {
    this.defaultView = { navigator: { clipboard: { writeText: async () => {} } } };
  }
  createElement(name) { return new Node(name); }
  createTextNode(text) { return new Node(null, text); }
}

function descendants(node) {
  return [node, ...node.children.flatMap(descendants)];
}

test("Reader attachment resolution uses only the owning item-details tab ID", () => {
  const details = { tabID: "reader-tab-7", dataset: { tabId: "wrong-fallback" } };
  const body = { closest: (selector) => selector === "item-details" ? details : null };
  const calls = [];
  const zotero = {
    Reader: {
      getByTabID(tabID) {
        calls.push(tabID);
        return { itemID: 42 };
      }
    },
    Items: { get: () => ({ parentItemID: 999 }) }
  };
  assert.equal(resolveReaderAttachmentID(body, zotero), 42);
  assert.deepEqual(calls, ["reader-tab-7"]);
});

test("resolution fails closed for library panes, stale tabs, and standalone Reader windows", () => {
  const zotero = { Reader: { getByTabID: () => null } };
  assert.equal(resolveReaderAttachmentID({ closest: () => null }, zotero), null);
  assert.equal(resolveReaderAttachmentID({
    closest: () => ({ dataset: { tabId: "stale" } })
  }, zotero), null);
  assert.equal(resolveReaderAttachmentID({
    closest: () => ({ tabID: "reader" })
  }, { Reader: { getByTabID: () => ({ itemID: 0 }) } }), null);
});

test("restricted Markdown creates text and safe links but never HTML or remote images", () => {
  const doc = new Document();
  const container = new Node("div");
  renderSafeMarkdown(
    doc,
    container,
    '<img src="https://tracker.invalid/pixel">\n\n[docs](https://example.com)\n\n```html\n<script>alert(1)</script>\n```'
  );
  const nodes = descendants(container);
  assert.equal(nodes.some((node) => node.localName === "img" || node.localName === "script"), false);
  const link = nodes.find((node) => node.localName === "a");
  assert.equal(link.href, "https://example.com");
  assert.equal(link.rel, "noopener noreferrer");
  assert.ok(nodes.some((node) => node.textContent.includes("<img src=")));
  assert.ok(nodes.some((node) => node.textContent.includes("<script>")));
});

test("source contains no innerHTML sink and the only configured ACP mode is agent", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../plugin/content/codex-chat-ui.js"),
    "utf8"
  );
  assert.doesNotMatch(source, /\.innerHTML\s*=/u);
  assert.equal(Constants.ACP_MODE, "agent");
  assert.notEqual(Constants.ACP_MODE, "agent-full-access");
});

test("Item Pane Fluent messages localize attributes without replacing the section body", () => {
  for (const locale of ["en-US", "zh-CN"]) {
    const source = fs.readFileSync(
      path.join(__dirname, `../plugin/locale/${locale}/${CODEX_L10N_RESOURCE}`),
      "utf8"
    );
    assert.match(
      source,
      /^smart-paper-translator-codex-chat-pane-header[ \t]*=[ \t]*$\n[ \t]+\.label[ \t]*=[ \t]*\S/mu
    );
    assert.match(
      source,
      /^smart-paper-translator-codex-chat-pane-sidenav[ \t]*=[ \t]*$\n[ \t]+\.tooltiptext[ \t]*=[ \t]*\S/mu
    );
    assert.doesNotMatch(
      source,
      /^smart-paper-translator-codex-chat-pane-(?:header|sidenav)[ \t]*=[ \t]*\S/mu
    );
  }
});

test("Codex localization replaces the legacy hot-update resource", () => {
  const links = [];
  const makeLink = (href) => ({
    getAttribute(name) { return name === "href" ? href : "localization"; },
    remove() {
      const index = links.indexOf(this);
      if (index >= 0) links.splice(index, 1);
    }
  });
  links.push(makeLink("smart-paper-translator.ftl"));
  const inserted = [];
  const win = {
    document: {
      querySelectorAll() { return links; }
    },
    MozXULElement: {
      insertFTLIfNeeded(resource) {
        inserted.push(resource);
        if (!links.some((link) => link.getAttribute("href") === resource)) {
          links.push(makeLink(resource));
        }
      }
    }
  };

  const link = ensureCodexLocalization(win);
  assert.deepEqual(inserted, [CODEX_L10N_RESOURCE]);
  assert.equal(links.some((item) => item.getAttribute("href") === "smart-paper-translator.ftl"), false);
  assert.equal(link.getAttribute("href"), CODEX_L10N_RESOURCE);
});

test("Codex localization is available before Item Pane registration", () => {
  const originalZotero = global.Zotero;
  const order = [];
  let registration;
  const win = {
    document: { querySelectorAll: () => [] },
    MozXULElement: {
      insertFTLIfNeeded(resource) { order.push(`localize:${resource}`); }
    }
  };
  global.Zotero = {
    getMainWindows: () => [win],
    ItemPaneManager: {
      registerSection(options) {
        order.push("register");
        registration = options;
        return "qualified-codex-pane";
      },
      unregisterSection(paneID) { order.push(`unregister:${paneID}`); }
    }
  };

  try {
    const ui = new CodexChatUI({ rootURI: "jar:test!/" });
    ui.init("smart-paper-translator@zotero.local");
    assert.deepEqual(order.slice(0, 2), [
      `localize:${CODEX_L10N_RESOURCE}`,
      "register"
    ]);
    assert.equal(registration.header.l10nID, CODEX_HEADER_L10N_ID);
    assert.equal(registration.sidenav.l10nID, CODEX_SIDENAV_L10N_ID);
    ui.shutdown();
    assert.equal(order.at(-1), "unregister:qualified-codex-pane");
  }
  finally {
    global.Zotero = originalZotero;
  }
});

test("sidebar renders per-PDF model controls before the first session is created", () => {
  const doc = new Document();
  const configuration = new Node("div");
  const body = { ownerDocument: doc };
  const ui = new CodexChatUI({ service: { setSessionConfig: async () => {} } });
  ui._renderConfig({
    body,
    attachmentID: 10,
    elements: { configuration, notices: new Node("div") }
  }, {
    status: "idle",
    record: {
      session: {
        id: null,
        config: { model: null, reasoningEffort: null }
      }
    },
    configOptions: [
      {
        id: "model",
        currentValue: "model-a",
        options: [{ value: "model-a", name: "Model A" }, { value: "model-b", name: "Model B" }]
      },
      {
        id: "reasoning_effort",
        currentValue: "high",
        options: [{ value: "high", name: "High" }]
      }
    ]
  });
  const nodes = descendants(configuration);
  assert.equal(nodes.filter((node) => node.localName === "select").length, 2);
  assert.ok(nodes.some((node) => /设置页只提供默认值/u.test(node.textContent)));
});
