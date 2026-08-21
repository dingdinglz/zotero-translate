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
  renderSafeMarkdown,
  captureTranscriptViewport,
  restoreTranscriptViewport,
  describeToolEntry,
  appendToolDetails
} = require("../plugin/content/codex-chat-ui.js");

class Node {
  constructor(localName, text = "") {
    this.localName = localName;
    this.tagName = localName;
    this.children = [];
    this.listeners = new Map();
    this.attributes = new Map();
    this.textContent = text;
    this.className = "";
    this.style = {};
    this.dataset = {};
    this.open = false;
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.clientHeight = 0;
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = [...children]; }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  removeEventListener(name) { this.listeners.delete(name); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  get lastElementChild() { return [...this.children].reverse().find((child) => child.localName) || null; }
}

class Document {
  constructor() {
    this.defaultView = { navigator: { clipboard: { writeText: async () => {} } } };
  }
  createElement(name) { return new Node(name); }
  createElementNS(_namespace, name) { return new Node(name); }
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

test("academic Markdown renders emphasis, lists, tables, MathML, and Codex file citations", () => {
  const doc = new Document();
  const container = new Node("div");
  let opened = null;
  renderSafeMarkdown(doc, container, [
    "### 核心方法：**AIM** 与 `attention mask`",
    "",
    "1. 保留真实缺失",
    "2. 注入人工掩码",
    "",
    "| 模式 | 比例 |",
    "|:---|---:|",
    "| random | 80% |",
    "",
    "\\[",
    "M = M_{\\text{inherited}} \\lor M_{\\text{artificial}}",
    "\\]",
    "",
    "证据：::codex-file-citation{path=\"/workspace/source.pdf\" line=12}"
  ].join("\n"), {
    onFileCitation(citation) { opened = citation; }
  });

  const nodes = descendants(container);
  for (const tag of ["strong", "code", "ol", "table", "math", "msub"]) {
    assert.ok(nodes.some((node) => node.localName === tag), `missing ${tag}`);
  }
  assert.ok(nodes.some((node) => node.localName === "mo" && node.textContent === "∨"));
  const citation = nodes.find((node) => node.className === "spt-codex-file-citation");
  assert.equal(citation.localName, "button");
  assert.equal(citation.textContent, "▧ source.pdf:12");
  citation.listeners.get("click")();
  assert.deepEqual(opened, { path: "/workspace/source.pdf", start: "12", end: undefined });
  assert.equal(nodes.some((node) => node.textContent.includes("::codex-file-citation")), false);
});

test("tool and thought rows retain a fixed flex basis in long transcripts", () => {
  const css = fs.readFileSync(
    path.join(__dirname, "../plugin/content/codex-chat.css"),
    "utf8"
  );
  assert.match(css, /\.spt-codex-messages\s*>\s*\*\s*\{[^}]*flex:\s*0\s+0\s+auto/isu);
  assert.match(css, /\.spt-codex-event\s*\{[^}]*min-height:\s*36px/isu);
  assert.match(css, /\.spt-codex-chat\s*\{[^}]*width:\s*100%[^}]*max-width:\s*100%/isu);
  assert.match(css, /\.spt-codex-messages\s*>\s*\*\s*\{[^}]*max-width:\s*100%/isu);
  assert.match(css, /\.spt-codex-event\s+pre[\s\S]*?word-break:\s*break-word/isu);
});

test("streaming rerenders preserve expanded events and a reader's scroll position", () => {
  const doc = new Document();
  const messages = new Node("div");
  messages.scrollHeight = 600;
  messages.clientHeight = 200;
  const view = {
    body: { ownerDocument: doc },
    elements: { messages, notices: new Node("div") },
    transcriptRendered: false,
    attachmentID: 10
  };
  const state = {
    record: {
      session: { workspacePath: "/workspace" },
      transcript: [{
        id: "tool-1",
        kind: "tool",
        toolKind: "execute",
        title: "printf first",
        rawInput: { command: "printf first", cwd: "/workspace" },
        rawOutput: { formatted_output: "first", exit_code: 0 },
        status: "in_progress"
      }]
    }
  };
  const ui = new CodexChatUI({ service: { revealCitation: async () => {} } });

  ui._renderTranscript(view, state);
  const firstDetails = messages.children[0];
  const firstContent = firstDetails.children[1];
  firstDetails.open = true;
  firstContent.scrollTop = 17;
  messages.scrollTop = 140;

  state.record.transcript[0].rawOutput.formatted_output += "\nsecond";
  state.record.transcript[0].status = "completed";
  ui._renderTranscript(view, state);
  const updatedDetails = messages.children[0];
  assert.equal(updatedDetails.open, true);
  assert.equal(updatedDetails.children[1].scrollTop, 17);
  assert.equal(messages.scrollTop, 140);
});

test("common ACP tools become semantic cards without raw transcript metadata", () => {
  const workspace = "/Users/alice/Zotero/workspaces/paper-1";
  const execute = describeToolEntry({
    kind: "tool",
    remoteID: "must-not-render",
    toolKind: "execute",
    title: "pwd && pdfinfo source.pdf",
    status: "completed",
    rawInput: { command: "pwd && pdfinfo source.pdf", cwd: workspace },
    rawOutput: { formatted_output: "Pages: 32", exit_code: 0 }
  }, workspace);
  assert.equal(execute.label, "运行命令");
  assert.equal(execute.fields[0].value, "当前论文工作区");
  assert.equal(execute.output, "Pages: 32");
  assert.equal(execute.exitCode, 0);

  const image = describeToolEntry({
    kind: "tool",
    toolKind: "read",
    title: "View Image /tmp/pages/page-06.png",
    rawInput: { path: "/tmp/pages/page-06.png" },
    locations: [{ path: "/tmp/pages/page-06.png" }],
    status: "completed"
  });
  assert.equal(image.label, "查看图片");
  assert.equal(image.subject, "page-06.png");
  assert.equal(image.emptyMessage, "图片已读取");

  const search = describeToolEntry({
    kind: "tool",
    toolKind: "search",
    title: "Search for 'masking|optimizer' in source-layout.txt",
    rawOutput: { formatted_output: "42: masking", exit_code: 0 },
    status: "completed"
  });
  assert.equal(search.label, "搜索内容");
  assert.deepEqual(search.fields.map((field) => field.label), ["关键词", "范围"]);

  const doc = new Document();
  const container = new Node("div");
  appendToolDetails(doc, container, {
    kind: "tool",
    remoteID: "must-not-render",
    createdAt: "2026-08-21",
    toolKind: "execute",
    title: "echo ok",
    rawInput: { command: "echo ok", cwd: workspace },
    rawOutput: { formatted_output: "ok", exit_code: 0 }
  }, workspace);
  const renderedText = descendants(container).map((node) => node.textContent).join("\n");
  assert.doesNotMatch(renderedText, /remoteID|createdAt|must-not-render/u);
  assert.match(renderedText, /命令|echo ok|命令输出|退出码 0/u);
});

test("transcript viewport follows only when the reader was already at the bottom", () => {
  const container = new Node("div");
  container.scrollTop = 380;
  container.scrollHeight = 600;
  container.clientHeight = 200;
  const snapshot = captureTranscriptViewport(container, true);
  assert.equal(snapshot.pinnedToBottom, true);
  container.scrollHeight = 720;
  restoreTranscriptViewport(container, snapshot, true);
  assert.equal(container.scrollTop, 720);

  container.scrollTop = 100;
  container.scrollHeight = 720;
  const reading = captureTranscriptViewport(container, true);
  assert.equal(reading.pinnedToBottom, false);
  container.scrollHeight = 900;
  restoreTranscriptViewport(container, reading, true);
  assert.equal(container.scrollTop, 100);
});

test("live thought text appears as a loading status and historical thought cards stay hidden", () => {
  const doc = new Document();
  const makeElement = (name = "div") => new Node(name);
  const view = {
    body: { ownerDocument: doc },
    root: makeElement(),
    attachmentID: 10,
    transcriptRendered: false,
    setSectionSummary() {},
    elements: {
      status: makeElement("span"),
      configuration: makeElement(),
      notices: makeElement(),
      messages: makeElement(),
      activity: makeElement(),
      activityText: makeElement("span"),
      input: makeElement("textarea"),
      send: makeElement("button"),
      stop: makeElement("button"),
      reset: makeElement("button")
    }
  };
  const state = {
    status: "generating",
    activityText: "Extracting and inspecting PDF text for sections",
    error: null,
    sourceChanged: false,
    historyReadOnly: false,
    configOptions: [],
    pendingInteractions: [],
    adapter: { preparedVersion: "1.6.2", requiredVersion: "1.6.2" },
    record: {
      session: { id: "thread-1", workspacePath: "/workspace", config: {} },
      transcript: [
        { id: "thought-1", kind: "thought", text: "**Old status**", status: "streaming" },
        { id: "message-1", kind: "message", role: "agent", text: "Visible answer" }
      ]
    }
  };
  const ui = new CodexChatUI({ service: { revealCitation: async () => {} } });

  ui._updateView(view, state);
  assert.equal(view.elements.activity.hidden, false);
  assert.equal(view.elements.activityText.textContent, state.activityText);
  assert.equal(view.elements.messages.children.length, 1);
  assert.equal(view.elements.messages.children[0].localName, "article");

  state.status = "ready";
  ui._updateView(view, state);
  assert.equal(view.elements.activity.hidden, true);
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
