"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function preferencesFixture() {
  const markup = fs.readFileSync(path.join(__dirname, "../plugin/content/preferences.xhtml"), "utf8");
  const elements = [], byID = new Map(), timers = new Map();
  const makeElement = (tag, attrs = {}) => ({
    tag, attrs, dataset: {}, value: "", textContent: "", disabled: false,
    hidden: "hidden" in attrs, children: [], listeners: new Map(),
    setAttribute(name, value) { this.attrs[name] = value; },
    removeAttribute(name) { delete this.attrs[name]; },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    addEventListener(name, handler) { this.listeners.set(name, handler); },
    removeEventListener(name) { this.listeners.delete(name); },
    dispatchEvent(event) { return this.listeners.get(event.type)?.(event); },
    focus() { this.focused = true; }
  });
  const acpStart = markup.indexOf('<groupbox id="spt-acp-settings"');
  const acpEnd = markup.indexOf("</groupbox>", acpStart);
  for (const match of markup.matchAll(/<([\w:]+)\b([^<>]*)>/gu)) {
    const attrs = Object.fromEntries([...match[2].matchAll(/([\w-]+)="([^"]*)"/gu)].map(entry => entry.slice(1)));
    const element = makeElement(match[1].replace("html:", ""), attrs);
    element.inACP = match.index > acpStart && match.index < acpEnd;
    for (const [name, value] of Object.entries(attrs)) {
      if (name.startsWith("data-")) element.dataset[name.slice(5).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase())] = value;
    }
    elements.push(element);
    if (attrs.id) byID.set(attrs.id, element);
  }
  const doc = {
    getElementById: id => byID.get(id),
    createElement: tag => makeElement(tag),
    querySelector: selector => elements.find(element => element.attrs["data-codex-status"] === selector.match(/"([^"]+)"/u)[1]),
    querySelectorAll: selector => selector.startsWith("#spt-acp-settings")
      ? elements.filter(element => element.inACP && ["input", "select", "button"].includes(element.tag) && element.attrs.role !== "tab")
      : elements.filter(element => selector.slice(1, -1) in element.attrs)
  };
  const paths = { nodePath: "/selected/node", npxCliPath: "/selected/npx-cli.js", codexPath: "/selected/codex", piPath: "/selected/pi" };
  const calls = [];
  const status = () => ({ paths: { ...paths }, configOptions: [], configOptionsByModel: {}, adapter: {} });
  const bridge = {
    getCodexStatus: status, getPiStatus: status,
    listACPPathCandidates: async () => ({ node: [], npx: [], codex: [], pi: [] }),
    hasAPIKey: async () => false,
    setACPPaths(value) { calls.push(["shared", { ...value }]); Object.assign(paths, value); },
    setCodexPaths(value) { calls.push(["codex", { ...value }]); Object.assign(paths, value); },
    setPiPaths(value) { calls.push(["pi", { ...value }]); Object.assign(paths, value); },
    formatCodexError: error => error.message
  };
  const win = {
    document: doc, Zotero: { SmartPaperTranslator: bridge },
    Event: class { constructor(type) { this.type = type; } },
    setTimeout(fn) { const id = Symbol(); timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); }
  };
  const context = vm.createContext({ window: win });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../plugin/content/preferences.js"), "utf8"), context);
  const manager = win.SmartPaperTranslatorPreferences;
  manager.init(win);
  for (const fn of timers.values()) fn();
  timers.clear();
  return { manager, bridge, calls, paths, byID, doc, win };
}

test("Pi default reasoning clears max when the newly chosen model does not support it", () => {
  const { manager, byID } = preferencesFixture();
  const reasoning = byID.get("spt-pi-default-reasoning"), model = byID.get("spt-pi-default-model");
  manager.piCatalog = { configOptionsByModel: {
    a: [{ id: "reasoning_effort", currentValue: "max", options: [{ value: "high" }, { value: "max" }] }],
    b: [{ id: "reasoning_effort", currentValue: "off", options: [{ value: "off" }] }]
  } };
  model.value = "a"; reasoning.value = "max";
  manager.renderPiReasoning();
  assert.ok(reasoning.children.some(option => option.value === "max"));
  model.value = "b";
  model.dispatchEvent({ type: "change" });
  assert.equal(reasoning.value, "");
  assert.ok(!reasoning.children.some(option => option.value === "max"));
  assert.ok(reasoning.children.some(option => option.value === "off"));
  manager.destroy();
});

test("settings tabs preserve each agent's fields and keep one shared Node / npx outside both panels", () => {
  const { manager, byID, calls } = preferencesFixture();
  byID.get("spt-codex-default-model").value = "codex-model";
  byID.get("spt-pi-default-model").value = "pi-model";
  byID.get("spt-pi-default-reasoning").value = "high";
  const tab = byID.get("spt-agent-tab-pi");
  tab.dispatchEvent({ type: "click" });
  assert.equal(tab.attrs["aria-selected"], "true");
  assert.equal(tab.tabIndex, 0);
  assert.equal(byID.get("spt-agent-panel-pi").hidden, false);
  assert.equal(byID.get("spt-agent-panel-codex").hidden, true);
  let prevented = false;
  tab.dispatchEvent({ type: "keydown", key: "ArrowLeft", preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(byID.get("spt-agent-tab-codex").focused, true);
  assert.equal(byID.get("spt-codex-default-model").value, "codex-model");
  assert.equal(byID.get("spt-pi-default-model").value, "pi-model");
  assert.equal(byID.get("spt-pi-default-reasoning").value, "high");
  assert.equal(byID.get("spt-acp-node-path").hidden, false);
  assert.equal(byID.get("spt-acp-npx-path").hidden, false);
  assert.deepEqual(calls, []);
  manager.destroy();
});

test("Pi inspection uses shared inputs without saving Codex fields and locks mutations across tabs", async () => {
  const { manager, bridge, byID, calls } = preferencesFixture();
  let resolve;
  bridge.inspectPiRuntime = () => new Promise(done => { resolve = done; });
  byID.get("spt-acp-node-path").value = "/chosen/node";
  byID.get("spt-codex-executable-path").value = "/unsaved/codex";
  const inspecting = manager.runPiAction("inspect");
  assert.equal(byID.get("spt-acp-node-path").disabled, true);
  assert.equal(byID.get("spt-codex-prepare").disabled, true);
  assert.equal(byID.get("spt-agent-tab-codex").disabled, false);
  manager.selectAgentTab("codex");
  await manager.runSharedAction("detect");
  assert.deepEqual(calls, [
    ["shared", { nodePath: "/chosen/node", npxCliPath: "/selected/npx-cli.js" }],
    ["pi", { piPath: "/selected/pi" }]
  ]);
  resolve({ versions: { node: "v24.14.0", npx: "11", pi: "0.85.1" }, adapter: { preparedVersion: "0.0.33" },
    configOptions: [{ id: "model", currentValue: "pi-model", options: ["pi-model"] }] });
  await inspecting;
  assert.equal(byID.get("spt-acp-node-path").disabled, false);
  assert.equal(byID.get("spt-pi-default-model").disabled, false);
  assert.equal(byID.get("spt-pi-default-reasoning").disabled, true);
  assert.equal(byID.get("spt-codex-executable-path").value, "/unsaved/codex");
  assert.equal(byID.get("spt-agent-panel-codex").hidden, false);
  assert.equal(byID.get("spt-acp-node-version").textContent, "v24.14.0");
  manager.destroy();
});

test("closing preferences discards late path selections and runtime responses", async () => {
  for (const action of ["browse", "inspect", "codex-inspect", "shared-inspect"]) {
    const { manager, bridge, calls } = preferencesFixture();
    let resolve;
    const pending = () => new Promise(done => { resolve = done; });
    bridge.pickCodexPath = pending;
    bridge.inspectPiRuntime = pending;
    bridge.inspectCodexRuntime = pending;
    bridge.inspectACPRuntime = pending;
    const task = action === "browse" ? manager.pickCodexPath("node") : action === "codex-inspect"
      ? manager.inspectCodex() : action === "shared-inspect" ? manager.runSharedAction("inspect") : manager.runPiAction("inspect");
    const savedCalls = calls.length;
    manager.destroy();
    resolve(action === "browse" ? "/late/node" : { paths: { nodePath: "/late/node" } });
    await task;
    assert.equal(manager.doc, null);
    assert.equal(calls.length, savedCalls);
  }
});

test("failed runtime checks retain configuration, show detailed errors, and release the controls", async () => {
  const { manager, bridge, byID } = preferencesFixture();
  bridge.inspectPiRuntime = async () => { throw new Error("PI_RUNTIME_VERSION: Node 22.13.0; requires 22.19.0"); };
  await manager.runPiAction("inspect");
  assert.match(byID.get("spt-pi-status").textContent, /22\.13\.0/u);
  assert.equal(byID.get("spt-acp-node-path").value, "/selected/node");
  assert.equal(byID.get("spt-acp-inspect").disabled, false);
  assert.equal(byID.get("spt-pi-inspect").disabled, false);
  assert.equal(byID.get("spt-pi-status").attrs["data-l10n-id"], undefined);
  manager.destroy();
});

test("discovered dropdown choices and manual paths stay synchronized without starting an agent", async () => {
  const { manager, bridge, byID, paths, calls } = preferencesFixture();
  bridge.listACPPathCandidates = async () => ({
    node: [{ path: "/nvm/v24/bin/node", source: "nvm", version: "v24" }],
    npx: [{ path: "/nvm/v24/npm/npx-cli.js", source: "nvm", version: "v24" }],
    codex: [], pi: [{ path: "/bin/pi", source: "path" }]
  });
  await manager.refreshPathCandidates();
  assert.deepEqual(calls, []);
  assert.equal(byID.get("spt-acp-node-path").value, "/selected/node");
  const nodeSelect = byID.get("spt-path-options-node");
  nodeSelect.value = "/nvm/v24/bin/node";
  nodeSelect.dispatchEvent({ type: "change" });
  assert.equal(paths.nodePath, "/nvm/v24/bin/node");
  assert.equal(byID.get("spt-acp-node-path").value, paths.nodePath);
  assert.equal(paths.npxCliPath, "/selected/npx-cli.js");
  byID.get("spt-acp-node-path").value = "/manual/custom-node";
  byID.get("spt-acp-node-path").dispatchEvent({ type: "input" });
  byID.get("spt-acp-node-path").dispatchEvent({ type: "change" });
  assert.equal(nodeSelect.value, "");
  assert.equal(paths.nodePath, "/manual/custom-node");
  await manager.runSharedAction("detect");
  assert.equal(paths.nodePath, "/manual/custom-node");
  assert.equal(byID.get("spt-acp-node-path").value, "/manual/custom-node");
  manager.selectAgentTab("pi");
  byID.get("spt-path-options-pi").value = "/bin/pi";
  byID.get("spt-path-options-pi").dispatchEvent({ type: "change" });
  assert.equal(paths.piPath, "/bin/pi");
  assert.equal(paths.codexPath, "/selected/codex");
  manager.destroy();
});

test("path discovery ignores older results and survives closing the preferences window", async () => {
  const { manager, bridge, byID } = preferencesFixture();
  const pending = [];
  bridge.listACPPathCandidates = () => new Promise(resolve => pending.push(resolve));
  const first = manager.refreshPathCandidates();
  const second = manager.refreshPathCandidates();
  pending[1]({ node: [{ path: "/new/node", source: "path" }] });
  await second;
  pending[0]({ node: [{ path: "/old/node", source: "path" }] });
  await first;
  assert.deepEqual(byID.get("spt-path-options-node").children.map(option => option.value), ["", "/new/node"]);
  const last = manager.refreshPathCandidates();
  manager.destroy();
  pending[2]({ node: [{ path: "/late/node", source: "path" }] });
  await last;
  assert.equal(manager.pathCandidates, null);
});

test("OpenCode tab navigates all three tabs and detects without changing Node/npx or another agent", async () => {
  const { manager, bridge, byID, calls } = preferencesFixture();
  bridge.getOpenCodeStatus = () => ({ paths: { opencodePath: "/local/opencode" }, adapter: {} });
  bridge.setOpenCodePaths = value => { calls.push(["opencode", { ...value }]); };
  let finish;
  bridge.inspectOpenCodeRuntime = () => new Promise(resolve => { finish = resolve; });
  byID.get("spt-opencode-executable-path").value = "/local/opencode";
  byID.get("spt-acp-node-path").value = "";
  byID.get("spt-acp-npx-path").value = "";
  manager.selectAgentTab("opencode");
  byID.get("spt-agent-tab-opencode").dispatchEvent({ type: "keydown", key: "ArrowRight", preventDefault() {} });
  assert.equal(byID.get("spt-agent-tab-codex").focused, true);
  const pending = manager.runOpenCodeAction("inspect");
  assert.equal(byID.get("spt-pi-inspect").disabled, true);
  assert.equal(byID.get("spt-opencode-inspect").disabled, true);
  assert.deepEqual(calls, [["opencode", { opencodePath: "/local/opencode" }]]);
  finish({ adapter: { preparedVersion: "1.18.30" }, configOptions: [{ id: "model", currentValue: "p/m", options: ["p/m"] }] });
  await pending;
  assert.equal(byID.get("spt-opencode-runtime").textContent, "1.18.30");
  assert.equal(byID.get("spt-opencode-status").attrs["data-l10n-id"], "smart-paper-translator-agents-ready");
  assert.equal(byID.get("spt-acp-node-path").value, "");
  manager.destroy();
});

test("OpenCode file picker cancellation and closed views never commit a path", async () => {
  for (const close of [false, true]) {
    const { manager, bridge, calls } = preferencesFixture();
    bridge.setOpenCodePaths = value => calls.push(value);
    bridge.getOpenCodeStatus = () => ({});
    let finish;
    bridge.pickCodexPath = () => new Promise(resolve => { finish = resolve; });
    const pending = manager.runOpenCodeAction("browse");
    if (close) manager.destroy();
    finish(close ? "/late/opencode" : "");
    await pending;
    assert.deepEqual(calls, []);
    if (!close) manager.destroy();
  }
});

test("OpenCode inspection discovers an empty path without requiring Node or npx", async () => {
  const { manager, bridge, byID, calls } = preferencesFixture();
  let selected = "", inspected = 0;
  bridge.getOpenCodeStatus = () => ({ paths: { opencodePath: selected }, adapter: {} });
  bridge.setOpenCodePaths = value => { selected = value.opencodePath; calls.push(["opencode", selected]); };
  bridge.listACPPathCandidates = async () => ({ opencode: [{ path: "/home/.opencode/bin/opencode", source: "opencode" }] });
  bridge.inspectOpenCodeRuntime = async () => {
    inspected++;
    assert.equal(selected, "/home/.opencode/bin/opencode");
    return bridge.getOpenCodeStatus();
  };
  byID.get("spt-acp-node-path").value = "";
  byID.get("spt-acp-npx-path").value = "";
  await manager.runOpenCodeAction("inspect");
  assert.equal(inspected, 1);
  assert.equal(byID.get("spt-opencode-executable-path").value, selected);
  assert.equal(byID.get("spt-path-options-opencode").value, selected);
  assert.ok(calls.every(call => call[0] === "opencode"));
  assert.equal(byID.get("spt-acp-node-path").value, "");
  assert.equal(byID.get("spt-acp-npx-path").value, "");
  manager.destroy();
});

test("OpenCode explicit path discovery fills only blank fields and never starts ACP", async () => {
  for (const manual of ["", "/custom/opencode"]) {
    const { manager, bridge, byID, calls } = preferencesFixture();
    let selected = manual;
    bridge.getOpenCodeStatus = () => ({ paths: { opencodePath: selected }, adapter: {} });
    bridge.setOpenCodePaths = value => { selected = value.opencodePath; calls.push(selected); };
    bridge.listACPPathCandidates = async () => ({ opencode: [{ path: "/home/.opencode/bin/opencode", source: "opencode" }] });
    bridge.inspectOpenCodeRuntime = () => assert.fail("Path discovery must not start ACP");
    byID.get("spt-opencode-executable-path").value = manual;
    await manager.runOpenCodeAction("detect");
    assert.equal(selected, manual || "/home/.opencode/bin/opencode");
    assert.equal(calls.length, manual ? 0 : 1);
    manager.destroy();
  }
});

test("OpenCode auto-discovery discards results after preferences close", async () => {
  const { manager, bridge, calls } = preferencesFixture();
  let finish;
  bridge.listACPPathCandidates = () => new Promise(resolve => { finish = resolve; });
  bridge.setOpenCodePaths = value => calls.push(value);
  bridge.inspectOpenCodeRuntime = () => assert.fail("Closed view must not start ACP");
  const detecting = manager.runOpenCodeAction("inspect");
  manager.destroy();
  finish({ opencode: [{ path: "/late/opencode", source: "path" }] });
  await detecting;
  assert.deepEqual(calls, []);
});
