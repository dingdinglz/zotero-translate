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
  openExternalURL,
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
    this.hidden = false;
    this.disabled = false;
    this.value = "";
    this.ownerDocument = null;
  }
  append(...children) {
    for (const child of children) {
      child.parentNode = this;
      child.ownerDocument ||= this.ownerDocument;
      this.children.push(child);
    }
  }
  replaceChildren(...children) {
    this.children = [];
    this.append(...children);
  }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  removeEventListener(name) { this.listeners.delete(name); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  focus() { this.focused = true; }
  closest(selector) { return this.closestValues?.[selector] || null; }
  dispatchEvent(event) {
    event.target ||= this;
    event.currentTarget ||= this;
    return this.listeners.get(event.type)?.(event);
  }
  get lastElementChild() { return [...this.children].reverse().find((child) => child.localName) || null; }
}

class Document {
  constructor() {
    this.defaultView = {
      navigator: { clipboard: { writeText: async () => {} } },
      MouseEvent: class {
        constructor(type, init = {}) { Object.assign(this, init, { type }); }
      }
    };
  }
  createElement(name) {
    const node = new Node(name);
    node.ownerDocument = this;
    return node;
  }
  createElementNS(_namespace, name) { return this.createElement(name); }
  createTextNode(text) {
    const node = new Node(null, text);
    node.ownerDocument = this;
    return node;
  }
}

function descendants(node) {
  return [node, ...node.children.flatMap(descendants)];
}

function makeSelection({ text = "Selected paper text", pageIndex = 2 } = {}) {
  return {
    schemaVersion: 1,
    source: "source.pdf",
    text,
    location: {
      coordinateSystem: "pdf-points",
      pageIndex,
      pageNumber: pageIndex + 1,
      pageLabel: String(pageIndex + 1),
      rects: [[10, 20, 30, 40]],
      nextPage: null
    }
  };
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

test("PDF selections accumulate in the matching in-memory draft without calling ACP", async () => {
  const originalZotero = global.Zotero;
  global.Zotero = {
    Reader: {
      getByTabID(tabID) {
        return tabID === "reader-tab-10" ? { itemID: 10 } : null;
      }
    }
  };
  let serviceCalls = 0;
  const ui = new CodexChatUI({
    service: {
      async send() { serviceCalls += 1; }
    }
  });
  const doc = new Document();
  const body = doc.createElement("section");
  body.closestValues = { "item-details": { tabID: "reader-tab-10" } };
  ui._renderShell({ doc, body, setSectionSummary() {} });
  const view = ui.views.get(body);
  view.attachmentID = 10;
  view.state = { status: "ready", sourceChanged: false, historyReadOnly: false };
  ui._revealCodexPane = async (tabID) => tabID === "reader-tab-10";
  view.elements.input.value = "保留我已经写好的问题";
  view.elements.input.listeners.get("input")();

  try {
    const selection = makeSelection();
    assert.deepEqual(await ui.addSelectionContext({
      tabID: "reader-tab-10",
      attachmentID: 10,
      selection
    }), { added: true, revealed: true });
    assert.deepEqual(await ui.addSelectionContext({
      tabID: "reader-tab-10",
      attachmentID: 10,
      selection
    }), { added: false, revealed: true });

    assert.equal(serviceCalls, 0);
    assert.equal(ui.drafts.get(10).question, "保留我已经写好的问题");
    assert.equal(ui.drafts.get(10).selections.length, 1);
    assert.equal(view.elements.draftContexts.children.length, 1);
    assert.equal(view.elements.input.focused, true);

    const remove = descendants(view.elements.draftContexts).find(
      (node) => node.localName === "button" && node.textContent === "移除"
    );
    remove.listeners.get("click")();
    assert.equal(ui.drafts.get(10).selections.length, 0);
    assert.equal(ui.drafts.get(10).question, "保留我已经写好的问题");
  }
  finally {
    global.Zotero = originalZotero;
  }
});

test("selection drafts stay isolated by PDF when automatic pane reveal is unavailable", async () => {
  const originalZotero = global.Zotero;
  global.Zotero = {
    Reader: {
      getByTabID(tabID) {
        return {
          "reader-tab-10": { itemID: 10 },
          "reader-tab-11": { itemID: 11 }
        }[tabID] || null;
      }
    }
  };
  const ui = new CodexChatUI();
  ui._revealCodexPane = async () => false;

  try {
    const first = await ui.addSelectionContext({
      tabID: "reader-tab-10",
      attachmentID: 10,
      selection: makeSelection({ text: "Paper ten" })
    });
    const second = await ui.addSelectionContext({
      tabID: "reader-tab-11",
      attachmentID: 11,
      selection: makeSelection({ text: "Paper eleven", pageIndex: 7 })
    });
    assert.equal(first.revealed, false);
    assert.equal(second.revealed, false);
    assert.deepEqual(ui.drafts.get(10).selections.map((entry) => entry.text), ["Paper ten"]);
    assert.deepEqual(ui.drafts.get(11).selections.map((entry) => entry.text), ["Paper eleven"]);
  }
  finally {
    global.Zotero = originalZotero;
  }
});

test("Codex pane reveal dispatches only to the exact Reader tab's sidenav button", async () => {
  const originalZotero = global.Zotero;
  const doc = new Document();
  const events = [];
  const makeDetails = (tabID) => {
    const button = doc.createElement("button");
    button.dataset.pane = "qualified-codex-pane";
    button.dispatchEvent = (event) => events.push({ tabID, type: event.type });
    return {
      tabID,
      ownerDocument: doc,
      sidenav: { querySelectorAll: () => [button] }
    };
  };
  const wrong = makeDetails("reader-tab-wrong");
  const right = makeDetails("reader-tab-right");
  global.Zotero = {
    getMainWindows: () => [{
      document: { querySelectorAll: () => [wrong, right] }
    }]
  };
  const ui = new CodexChatUI();
  ui.paneID = "qualified-codex-pane";

  try {
    assert.equal(await ui._revealCodexPane("reader-tab-right"), true);
    assert.deepEqual(events, [{ tabID: "reader-tab-right", type: "click" }]);
    assert.equal(await ui._revealCodexPane("missing-tab"), false);
  }
  finally {
    global.Zotero = originalZotero;
  }
});

test("sending clears a selection draft on success and restores it intact on failure", async () => {
  const doc = new Document();
  const body = doc.createElement("section");
  body.closestValues = { "item-details": { tabID: "reader-tab-10" } };
  const sent = [];
  let fail = false;
  const ui = new CodexChatUI({
    service: {
      async send(attachmentID, question, options) {
        sent.push({ attachmentID, question, options });
        if (fail) throw new Error("simulated send failure");
      }
    }
  });
  ui._renderShell({ doc, body, setSectionSummary() {} });
  const view = ui.views.get(body);
  view.attachmentID = 10;
  view.state = { status: "ready", sourceChanged: false, historyReadOnly: false };

  ui.drafts.set(10, { question: "First question", selections: [makeSelection()] });
  ui._syncDraftViews(10);
  await ui._run(body, "send");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].question, "First question");
  assert.equal(sent[0].options.selections[0].location.rects[0][3], 40);
  assert.deepEqual(ui.drafts.get(10), { question: "", selections: [] });

  fail = true;
  ui.drafts.set(10, {
    question: "Retry question",
    selections: [makeSelection({ text: "Retry selection", pageIndex: 4 })]
  });
  ui._syncDraftViews(10);
  await ui._run(body, "send");
  assert.equal(view.elements.notices.textContent, "simulated send failure");
  assert.equal(ui.drafts.get(10).question, "Retry question");
  assert.equal(ui.drafts.get(10).selections[0].text, "Retry selection");
});

test("selection cards render hostile markup as text and never expose precise coordinates", () => {
  const doc = new Document();
  const messages = doc.createElement("div");
  const ui = new CodexChatUI({ service: { revealCitation: async () => {} } });
  const view = {
    body: { ownerDocument: doc },
    attachmentID: 10,
    transcriptRendered: false,
    elements: { messages, notices: doc.createElement("div") }
  };
  ui._renderTranscript(view, {
    record: {
      session: { workspacePath: "/workspace" },
      transcript: [{
        kind: "message",
        role: "user",
        text: "Question with <script>bad()</script>",
        selections: [makeSelection({
          text: '<img src="https://tracker.invalid/pixel"> **not Markdown**'
        })]
      }]
    }
  });

  const nodes = descendants(messages);
  assert.equal(nodes.some((node) => node.localName === "script" || node.localName === "img"), false);
  const selectionText = nodes.find((node) => node.className === "spt-codex-selection-text");
  assert.equal(selectionText.textContent, '<img src="https://tracker.invalid/pixel"> **not Markdown**');
  assert.equal(nodes.some((node) => /10,20,30,40/u.test(node.textContent)), false);
});

test("restricted Markdown creates text and safe links but never HTML or remote images", () => {
  const doc = new Document();
  const container = new Node("div");
  let opened = null;
  renderSafeMarkdown(
    doc,
    container,
    '<img src="https://tracker.invalid/pixel">\n\n[docs](https://example.com)\n\n```html\n<script>alert(1)</script>\n```',
    { onExternalLink(url) { opened = url; } }
  );
  const nodes = descendants(container);
  assert.equal(nodes.some((node) => node.localName === "img" || node.localName === "script"), false);
  const link = nodes.find((node) => node.localName === "a");
  assert.equal(link.href, "https://example.com");
  assert.equal(link.rel, "noopener noreferrer");
  let prevented = false;
  link.listeners.get("click")({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(opened, "https://example.com");
  assert.ok(nodes.some((node) => node.textContent.includes("<img src=")));
  assert.ok(nodes.some((node) => node.textContent.includes("<script>")));
});

test("external URLs use Zotero's system-browser launcher and reject unsafe schemes", () => {
  const launched = [];
  assert.equal(
    openExternalURL("https://example.com/paper", { launchURL: (url) => launched.push(url) }),
    "https://example.com/paper"
  );
  assert.deepEqual(launched, ["https://example.com/paper"]);
  assert.throws(
    () => openExternalURL("javascript:alert(1)", { launchURL() {} }),
    /HTTP 或 HTTPS/u
  );
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
    "原文：:codex-file-citation{path=\"/workspace/source.pdf\" purpose=\"source\"}",
    "",
    "行号：::codex-file-citation{path=\"/workspace/notes.md\" line=12}"
  ].join("\n"), {
    onFileCitation(citation) { opened = citation; }
  });

  const nodes = descendants(container);
  for (const tag of ["strong", "code", "ol", "table", "math", "msub"]) {
    assert.ok(nodes.some((node) => node.localName === tag), `missing ${tag}`);
  }
  assert.ok(nodes.some((node) => node.localName === "mo" && node.textContent === "∨"));
  const citations = nodes.filter((node) => node.className === "spt-codex-file-citation");
  assert.equal(citations.length, 2);
  assert.equal(citations[0].localName, "button");
  assert.equal(citations[0].textContent, "▧ source.pdf");
  citations[0].listeners.get("click")();
  assert.deepEqual(opened, { path: "/workspace/source.pdf", start: undefined, end: undefined });
  assert.equal(citations[1].textContent, "▧ notes.md:12");
  assert.equal(nodes.some((node) => /:?codex-file-citation/u.test(node.textContent)), false);
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

test("Codex web-search actions render full queries, page operations, and returned links", () => {
  const searchEntry = {
    kind: "tool",
    toolKind: "search",
    title: "Web search: first query, second query",
    status: "completed",
    rawInput: {
      type: "webSearch",
      query: "first query ...",
      action: { type: "search", queries: ["first query", "second query"] }
    }
  };
  const search = describeToolEntry(searchEntry);
  assert.equal(search.category, "web-search");
  assert.equal(search.label, "网页搜索");
  assert.equal(search.subject, "2 个查询");
  assert.deepEqual(search.web.queries, ["first query", "second query"]);
  assert.match(search.emptyMessage, /ACP 事件未携带结果摘要/u);

  const doc = new Document();
  const searchCard = new Node("div");
  appendToolDetails(doc, searchCard, searchEntry);
  const searchText = descendants(searchCard).map((node) => node.textContent).join("\n");
  assert.match(searchText, /搜索请求（2）/u);
  assert.match(searchText, /first query/u);
  assert.match(searchText, /second query/u);

  let opened = null;
  const openPageEntry = {
    kind: "tool",
    toolKind: "search",
    title: "Open page: https://arxiv.org/html/2608.13316",
    status: "completed",
    rawInput: {
      type: "webSearch",
      query: "https://arxiv.org/html/2608.13316",
      action: { type: "openPage", url: "https://arxiv.org/html/2608.13316" }
    },
    rawOutput: {
      results: [{
        title: "A paper",
        url: "https://arxiv.org/abs/2608.13316",
        snippet: "A returned result summary."
      }]
    }
  };
  const openPage = describeToolEntry(openPageEntry);
  assert.equal(openPage.label, "打开网页");
  assert.equal(openPage.web.queries.length, 0);
  assert.equal(openPage.web.results.length, 1);
  const pageCard = new Node("div");
  appendToolDetails(doc, pageCard, openPageEntry, "", {
    onExternalLink(url) { opened = url; }
  });
  const links = descendants(pageCard).filter((node) => node.localName === "a");
  assert.equal(links.length, 2);
  links[0].listeners.get("click")({ preventDefault() {} });
  assert.equal(opened, "https://arxiv.org/html/2608.13316");
  links[1].listeners.get("click")({ preventDefault() {} });
  assert.equal(opened, "https://arxiv.org/abs/2608.13316");
  const pageText = descendants(pageCard).map((node) => node.textContent).join("\n");
  assert.match(pageText, /返回内容（1）|A returned result summary/u);

  const find = describeToolEntry({
    kind: "tool",
    toolKind: "search",
    title: "Find in page for 'LSM-2'",
    status: "completed",
    rawInput: {
      type: "webSearch",
      action: { type: "findInPage", url: null, pattern: "LSM-2" }
    }
  });
  assert.equal(find.label, "页内查找");
  assert.equal(find.web.pattern, "LSM-2");
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
      reset: makeElement("button"),
      copyLog: makeElement("button")
    }
  };
  const state = {
    status: "generating",
    activityText: "Extracting and inspecting PDF text for sections",
    developerMode: false,
    diagnosticEventCount: 0,
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
  assert.equal(view.elements.copyLog.hidden, true);
  assert.equal(view.elements.messages.children.length, 1);
  assert.equal(view.elements.messages.children[0].localName, "article");

  state.status = "ready";
  state.developerMode = true;
  state.diagnosticEventCount = 7;
  ui._updateView(view, state);
  assert.equal(view.elements.activity.hidden, true);
  assert.equal(view.elements.copyLog.hidden, false);
  assert.equal(view.elements.copyLog.textContent, "复制日志 (7)");
});

test("copy log action writes the developer report to the clipboard", async () => {
  const doc = new Document();
  let copied = "";
  doc.defaultView.navigator.clipboard.writeText = async (value) => { copied = value; };
  const body = { ownerDocument: doc };
  const copyLog = new Node("button");
  const ui = new CodexChatUI({
    service: {
      async getDiagnosticReport(attachmentID) {
        assert.equal(attachmentID, 10);
        return { schemaVersion: 1, eventCount: 2, events: [{ sessionUpdate: "tool_call" }] };
      }
    }
  });
  ui.views.set(body, {
    body,
    attachmentID: 10,
    elements: {
      input: new Node("textarea"),
      notices: new Node("div"),
      copyLog
    }
  });

  await ui._run(body, "copy-log");
  assert.equal(JSON.parse(copied).eventCount, 2);
  assert.equal(copyLog.textContent, "已复制 2 条");
  assert.equal(copyLog.dataset.copiedCount, "2");
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
