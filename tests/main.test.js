"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const Constants = require("../plugin/content/constants.js");

function loadMainPlugin() {
  const values = new Map([
    [Constants.PREFS.codexNodePath, "/configured/node"],
    [Constants.PREFS.codexNpxCliPath, "/configured/npx-cli.js"],
    [Constants.PREFS.codexExecutablePath, "/configured/codex"]
  ]);
  const preferenceCalls = [];
  const detectCalls = [];
  const detected = {
    nodePath: "/detected/node",
    npxCliPath: "/detected/npx-cli.js",
    codexPath: "/detected/codex"
  };
  const context = vm.createContext({
    SmartPaperTranslatorModules: {
      Constants,
      Logic: {},
      ACP: {
        formatACPError(error, fallback) {
          return [error?.message || fallback, error?.code ? `错误代码：${error.code}` : ""]
            .filter(Boolean).join("\n");
        },
        async detectLocalPaths(configured) {
          detectCalls.push({ ...configured });
          return { ...detected };
        },
        async inspectLocalRuntime(paths) {
          return {
            paths: { ...paths },
            versions: { node: "v22", npx: "10", codex: "codex 0.148.0", codexACP: "" },
            login: "Logged in",
            healthy: true,
            lastError: ""
          };
        }
      }
    },
    Zotero: {
      Prefs: {
        get(name, global) {
          preferenceCalls.push({ operation: "get", name, global });
          return values.get(name);
        },
        set(name, value, global) {
          preferenceCalls.push({ operation: "set", name, value, global });
          values.set(name, value);
        }
      }
    },
    Cc: {},
    Ci: {},
    setTimeout,
    clearTimeout
  });
  const source = fs.readFileSync(
    path.join(__dirname, "../plugin/content/main.js"),
    "utf8"
  );
  vm.runInContext(source, context, { filename: "plugin/content/main.js" });
  return { plugin: context.SmartPaperTranslatorPlugin, context, values, preferenceCalls, detectCalls, detected };
}

function loadPreferencesManager() {
  const elements = new Map();
  const makeElement = () => ({
    value: "",
    textContent: "",
    disabled: false,
    children: [],
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = [...children]; },
    dispatchEvent() {}
  });
  for (const id of ["spt-codex-default-model", "spt-codex-default-reasoning"]) {
    elements.set(id, makeElement());
  }
  const document = {
    getElementById(id) { return elements.get(id); },
    createElement() { return makeElement(); }
  };
  const context = vm.createContext({ window: {} });
  const source = fs.readFileSync(
    path.join(__dirname, "../plugin/content/preferences.js"),
    "utf8"
  );
  vm.runInContext(source, context, { filename: "plugin/content/preferences.js" });
  const manager = context.window.SmartPaperTranslatorPreferences;
  manager.doc = document;
  manager.win = { Event: class {} };
  return { manager, elements };
}

test("Codex path detection leaves the shared runtime preferences unchanged", async () => {
  const { plugin, context, values, preferenceCalls, detectCalls, detected } = loadMainPlugin();
  plugin.acpClient = { getStatus: () => ({ preparedVersion: "" }) };
  plugin.codexChatService = { getConfigurationCatalog: () => [] };
  plugin.credentials = {};
  plugin.service = {};
  plugin._installPreferenceBridge();

  const result = await context.Zotero.SmartPaperTranslator.detectCodexPaths();

  assert.deepEqual(detectCalls, [{
    nodePath: "/configured/node",
    npxCliPath: "/configured/npx-cli.js",
    codexPath: "/configured/codex"
  }]);
  assert.equal(result.paths.codexPath, detected.codexPath);
  assert.equal(result.paths.nodePath, "/configured/node");
  assert.equal(values.get(Constants.PREFS.codexNodePath), "/configured/node");
  assert.equal(values.get(Constants.PREFS.codexNpxCliPath), "/configured/npx-cli.js");
  assert.equal(values.get(Constants.PREFS.codexExecutablePath), detected.codexPath);
  assert.ok(preferenceCalls.length >= 6);
  assert.equal(preferenceCalls.every((call) => call.global === true), true);
});

test("Codex settings bridge formats error codes for the preferences UI", () => {
  const { plugin, context } = loadMainPlugin();
  plugin.acpClient = { getStatus: () => ({ preparedVersion: "" }) };
  plugin.codexChatService = { getConfigurationCatalog: () => [] };
  plugin.credentials = {};
  plugin.service = {};
  plugin._installPreferenceBridge();

  const display = context.Zotero.SmartPaperTranslator.formatCodexError({
    message: "codex-acp 准备失败",
    code: "ACP_PREPARE_FAILED"
  });
  assert.match(display, /codex-acp 准备失败/u);
  assert.match(display, /ACP_PREPARE_FAILED/u);
});

test("Codex settings bridge serializes diagnostics before crossing into the preferences window", async () => {
  const { plugin, context } = loadMainPlugin();
  plugin.acpClient = { getStatus: () => ({ preparedVersion: "" }) };
  plugin.codexChatService = { getConfigurationCatalog: () => [] };
  plugin.credentials = {};
  plugin.service = {};
  context.SmartPaperTranslatorModules.ACP.detectLocalPaths = async () => {
    const error = new Error("无法探测路径");
    error.code = "ACP_PATH_DETECTION_FAILED";
    throw error;
  };
  plugin._installPreferenceBridge();

  await assert.rejects(
    context.Zotero.SmartPaperTranslator.detectCodexPaths(),
    (error) => {
      assert.equal(error.name, "CodexACPError");
      assert.match(error.message, /无法探测路径/u);
      assert.match(error.message, /ACP_PATH_DETECTION_FAILED/u);
      return true;
    }
  );
});

test("Codex developer mode is default-off and wired to preference refresh", () => {
  const prefs = fs.readFileSync(
    path.join(__dirname, "../plugin/prefs.js"),
    "utf8"
  );
  const xhtml = fs.readFileSync(
    path.join(__dirname, "../plugin/content/preferences.xhtml"),
    "utf8"
  );
  const main = fs.readFileSync(
    path.join(__dirname, "../plugin/content/main.js"),
    "utf8"
  );
  assert.equal(
    Constants.PREFS.codexDeveloperMode,
    "extensions.smart-paper-translator.codexDeveloperMode"
  );
  assert.match(prefs, /codexDeveloperMode", false/u);
  assert.match(xhtml, /preference="extensions\.smart-paper-translator\.codexDeveloperMode"/u);
  assert.match(main, /prefs\.codexDeveloperMode/u);
  assert.match(main, /notifyDeveloperModeChanged\(\)/u);
});

test("Codex settings enable cached defaults and use model-specific reasoning choices", () => {
  const { manager, elements } = loadPreferencesManager();
  manager.codexCatalog = {
    configOptions: [{
      id: "model",
      currentValue: "model-a",
      options: [{ value: "model-a" }, { value: "model-b" }]
    }],
    configOptionsByModel: {
      "model-b": [{
        id: "reasoning_effort",
        currentValue: "low",
        options: [{ value: "low", name: "Low" }, { value: "minimal", name: "Minimal" }]
      }]
    },
    updatedAt: "2026-08-20T00:00:00.000Z"
  };
  const model = elements.get("spt-codex-default-model");
  model.value = "model-b";
  manager._populateCodexSelect("spt-codex-default-model", manager.codexCatalog.configOptions[0], "model-b");
  manager._updateCodexReasoningOptions(false);

  const reasoning = elements.get("spt-codex-default-reasoning");
  assert.equal(model.disabled, false);
  assert.equal(reasoning.disabled, false);
  assert.deepEqual(Array.from(reasoning.children, (option) => option.value), ["", "low", "minimal"]);

  manager._populateCodexSelect("spt-codex-default-model", null, "");
  assert.equal(model.disabled, true);
  assert.match(model.children[0].textContent, /准备或重新检测 ACP/u);
});

test("explicit runtime inspection refreshes and exposes the persisted configuration catalog", async () => {
  const { plugin, context } = loadMainPlugin();
  let refreshes = 0;
  const catalog = {
    configOptions: [{ id: "model", currentValue: "model-a", options: [{ value: "model-a" }] }],
    configOptionsByModel: { "model-a": [] },
    updatedAt: "2026-08-20T00:00:00.000Z"
  };
  plugin.acpClient = {
    getStatus: () => ({
      preparedVersion: Constants.ACP_PACKAGE_VERSION,
      requiredVersion: Constants.ACP_PACKAGE_VERSION,
      healthy: true
    })
  };
  plugin.codexChatService = {
    async refreshConfigurationCatalog() { refreshes += 1; return catalog; },
    getConfigurationCatalog: () => catalog
  };
  plugin.credentials = {};
  plugin.service = {};
  plugin._installPreferenceBridge();

  const result = await context.Zotero.SmartPaperTranslator.inspectCodexRuntime();
  assert.equal(refreshes, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(result.configOptions)), catalog.configOptions);
  assert.equal(result.updatedAt, catalog.updatedAt);
});

test("configuration close warnings retain selectable options and detailed diagnostics", async () => {
  const { plugin, context } = loadMainPlugin();
  const catalog = {
    configOptions: [{ id: "model", currentValue: "model-a", options: [{ value: "model-a" }] }],
    configOptionsByModel: { "model-a": [] },
    updatedAt: "2026-08-20T00:00:00.000Z"
  };
  plugin.acpClient = {
    getStatus: () => ({
      preparedVersion: Constants.ACP_PACKAGE_VERSION,
      requiredVersion: Constants.ACP_PACKAGE_VERSION,
      healthy: true
    })
  };
  plugin.codexChatService = {
    async refreshConfigurationCatalog() {
      return {
        ...catalog,
        cleanupWarning: {
          message: "配置选项已读取，但临时空 session 关闭失败",
          code: "CONFIG_CATALOG_CLOSE_FAILED",
          details: { cause: "Internal error" }
        }
      };
    },
    getConfigurationCatalog: () => catalog
  };
  plugin.credentials = {};
  plugin.service = {};
  plugin._installPreferenceBridge();

  const result = await context.Zotero.SmartPaperTranslator.inspectCodexRuntime();
  assert.deepEqual(JSON.parse(JSON.stringify(result.configOptions)), catalog.configOptions);
  assert.match(result.lastError, /CONFIG_CATALOG_CLOSE_FAILED/u);
});

test("Pi settings bridge uses the separate probe and stores only its own executable preference", async () => {
  const { plugin, context, values } = loadMainPlugin();
  const inspected = [], refreshes = [];
  context.SmartPaperTranslatorModules.ACP.inspectLocalRuntime = async (paths, agentId) => {
    inspected.push({ ...paths, agentId }); return { paths, healthy: true, versions: { node: "24.14.0", pi: "0.85.1" } };
  };
  plugin.piProbeService = {
    acp: { getStatus: () => ({ preparedVersion: "0.0.33", requiredVersion: "0.0.33" }) },
    getConfigurationCatalog: () => ({ configOptions: [] })
  };
  plugin.agentsChatService = { async refreshPiCatalog(options) { refreshes.push({ ...options }); return { configOptions: [{ id: "model" }] }; } };
  plugin.credentials = {}; plugin.service = {};
  plugin._installPreferenceBridge();
  plugin.bridge.setPiPaths({ piPath: "/local/bin/pi" });
  assert.equal(values.get(Constants.PREFS.codexExecutablePath), "/configured/codex");
  assert.equal(values.get(Constants.PREFS.piExecutablePath), "/local/bin/pi");
  const result = await plugin.bridge.preparePiACP();
  assert.equal(inspected[0].agentId, "pi");
  assert.equal(inspected[0].piPath, "/local/bin/pi");
  assert.deepEqual(refreshes, [{ prepare: true }]);
  assert.equal(result.adapter.preparedVersion, "0.0.33");
  await plugin.bridge.inspectPiRuntime();
  assert.deepEqual(refreshes.at(-1), { prepare: false });
});

test("shared Node / npx settings are used by both agents without changing either executable", async () => {
  const { plugin, context, values, preferenceCalls } = loadMainPlugin();
  const inspected = [];
  context.SmartPaperTranslatorModules.ACP.inspectSharedRuntime = async (paths) => {
    inspected.push({ ...paths }); return { paths, healthy: true };
  };
  context.SmartPaperTranslatorModules.ACP.detectSharedPaths = async () => ({ nodePath: "/new/node", npxCliPath: "/new/npx-cli.js" });
  plugin.acpClient = { getStatus: () => ({}) };
  plugin.codexChatService = { getConfigurationCatalog: () => ({}) };
  plugin.piProbeService = { acp: plugin.acpClient, getConfigurationCatalog: () => ({}) };
  plugin._installPreferenceBridge();
  plugin.bridge.setPiPaths({ piPath: "/local/pi" });
  await plugin.bridge.detectACPPaths();
  await plugin.bridge.inspectACPRuntime();
  assert.deepEqual(inspected, [{ nodePath: "/new/node", npxCliPath: "/new/npx-cli.js" }]);
  for (const status of [plugin.bridge.getCodexStatus(), plugin.bridge.getPiStatus()]) {
    assert.equal(status.paths.nodePath, "/new/node");
    assert.equal(status.paths.npxCliPath, "/new/npx-cli.js");
  }
  assert.equal(values.get(Constants.PREFS.codexExecutablePath), "/configured/codex");
  assert.equal(values.get(Constants.PREFS.piExecutablePath), "/local/pi");
  assert.ok(preferenceCalls.every(call => call.global === true));
});

test("Pi path detection does not silently replace shared Node / npx", async () => {
  const { plugin, context, values } = loadMainPlugin();
  context.SmartPaperTranslatorModules.ACP.detectLocalPaths = async () => ({ nodePath: "/other/node", npxCliPath: "/other/npx.js", piPath: "/detected/pi" });
  plugin.piProbeService = { acp: { getStatus: () => ({}) }, getConfigurationCatalog: () => ({}) };
  plugin._installPreferenceBridge();
  const result = await plugin.bridge.detectPiPaths();
  assert.equal(result.paths.piPath, "/detected/pi");
  assert.equal(result.paths.nodePath, "/configured/node");
  assert.equal(values.get(Constants.PREFS.codexNpxCliPath), "/configured/npx-cli.js");
});

test("file selection uses Zotero FilePicker and only returns the result to the live preferences view", async () => {
  const { plugin, context, preferenceCalls } = loadMainPlugin();
  const parent = { browsingContext: { id: "preferences" } };
  const opened = [];
  let cancelled = false;
  context.ChromeUtils = { importESModule(uri) {
    assert.equal(uri, "chrome://zotero/content/modules/filePicker.mjs");
    return { FilePicker: class {
      modeOpen = 0; filterAll = 1; returnOK = 0;
      init(win, title, mode) { opened.push({ win, title, mode }); }
      appendFilters(filter) { assert.equal(filter, 1); }
      async show() { return cancelled ? 1 : 0; }
      get file() { assert.equal(cancelled, false); return "/chosen/executable"; }
    } };
  } };
  for (const kind of ["node", "npx", "codex", "pi"]) {
    assert.equal(await plugin._pickCodexPath(kind, parent), "/chosen/executable");
    assert.equal(opened.at(-1).win, parent);
  }
  cancelled = true;
  assert.equal(await plugin._pickCodexPath("node", parent), "");
  assert.equal(preferenceCalls.length, 0);
  await assert.rejects(plugin._pickCodexPath("unknown", parent));
});

test("candidate discovery bridge reads both agent configurations without writing preferences or inspecting a runtime", async () => {
  const { plugin, context, preferenceCalls } = loadMainPlugin();
  let inputs;
  context.SmartPaperTranslatorModules.ACP.listRuntimePathCandidates = async configured => {
    inputs = { ...configured }; return { node: [{ path: "/new/node" }] };
  };
  context.SmartPaperTranslatorModules.ACP.inspectLocalRuntime = () => { throw new Error("must not inspect"); };
  plugin._installPreferenceBridge();
  const result = await plugin.bridge.listACPPathCandidates();
  assert.equal(result.node[0].path, "/new/node");
  assert.equal(inputs.nodePath, "/configured/node");
  assert.equal(inputs.codexPath, "/configured/codex");
  assert.equal(preferenceCalls.some(call => call.operation === "set"), false);
});
