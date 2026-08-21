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

test("Codex path detection bridge reads and persists global preferences", async () => {
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
  assert.deepEqual(result.paths, detected);
  assert.equal(values.get(Constants.PREFS.codexNodePath), detected.nodePath);
  assert.equal(values.get(Constants.PREFS.codexNpxCliPath), detected.npxCliPath);
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
