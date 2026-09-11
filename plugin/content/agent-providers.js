(function (global) {
  "use strict";

  const modules = global.SmartPaperTranslatorModules = global.SmartPaperTranslatorModules || {};
  const Constants = modules.Constants || (typeof require === "function" ? require("./constants.js") : null);
  // AgentId is deliberately closed: commands and environment overrides are not model input.
  const providers = Object.freeze({
    codex: Object.freeze({
      id: "codex", label: "Codex", command: "codex-acp",
      packageSpec: Constants.ACP_PACKAGE_SPEC, version: Constants.ACP_PACKAGE_VERSION,
      directory: "codex-acp", reasoningID: "reasoning_effort",
      executablePref: Constants.PREFS.codexExecutablePath,
      preparedPref: Constants.PREFS.codexPreparedVersion,
      fingerprintPref: Constants.PREFS.codexPreparedFingerprint,
      modelPref: Constants.PREFS.codexDefaultModel,
      reasoningPref: Constants.PREFS.codexDefaultReasoningEffort,
      modes: Object.freeze(["agent", "agent-full-access"]), defaultMode: "agent"
    }),
    pi: Object.freeze({
      id: "pi", label: "Pi", command: "pi-acp",
      packageSpec: "pi-acp@0.0.33", version: "0.0.33",
      directory: "pi-acp", reasoningID: "thought_level",
      executablePref: Constants.PREFS.piExecutablePath,
      preparedPref: Constants.PREFS.piPreparedVersion,
      fingerprintPref: Constants.PREFS.piPreparedFingerprint,
      modelPref: Constants.PREFS.piDefaultModel,
      reasoningPref: Constants.PREFS.piDefaultReasoningEffort,
      modes: Object.freeze([]), defaultMode: null
    }),
    opencode: Object.freeze({
      id: "opencode", label: "OpenCode", command: "opencode acp", runtime: "native",
      packageSpec: null, version: "opencode-native-acp-2", minimumVersion: "1.18.30",
      directory: "opencode-acp", reasoningID: "effort", sessionMode: true,
      executablePref: Constants.PREFS.opencodeExecutablePath,
      preparedPref: Constants.PREFS.opencodePreparedVersion,
      fingerprintPref: Constants.PREFS.opencodePreparedFingerprint,
      modelPref: Constants.PREFS.opencodeDefaultModel,
      reasoningPref: Constants.PREFS.opencodeDefaultReasoningEffort,
      modes: Object.freeze([]), defaultMode: null
    })
  });

  function getProvider(agentId = "codex") {
    if (!Object.prototype.hasOwnProperty.call(providers, agentId)) throw new Error("Unknown Agent ID");
    return providers[agentId];
  }

  function normalizeConfigOptions(options, agentId) {
    const provider = getProvider(agentId);
    return (Array.isArray(options) ? options : []).filter((option) =>
      option && ["model", "reasoning_effort", provider.reasoningID, ...(provider.modes.length || provider.sessionMode ? ["mode"] : [])].includes(option.id)
    ).map((option) => ({ ...option, id: option.id === provider.reasoningID ? "reasoning_effort" : option.id }));
  }

  function validMode(mode, agentId) {
    const provider = getProvider(agentId);
    return provider.modes.length ? provider.modes.includes(mode) : mode === null;
  }

  function busy(service) {
    return Boolean(service?.catalogRefresh || [...(service?.states?.values?.() || [])].some((state) =>
      state.turn || state.interactions.size || ["connecting", "generating", "cancelling", "waiting-approval"].includes(state.status)
    ));
  }

  // Reader HTML documents do not share the main XUL document's Fluent context.
  const readerStrings = {
    add: ["添加到 Agents", "Add to Agents"],
    selection: ["把选中文本及其 PDF 位置加入当前论文的 Agents 草稿", "Add selected text and its PDF position to this paper's Agents draft"],
    manual: ["已加入草稿；请手动打开右侧 Agents 对话", "Added to draft. Open Agents in the sidebar to continue."],
    added: ["已加入右侧 Agents 对话草稿", "Added to the Agents draft"],
    failed: ["无法添加到 Agents 对话", "Could not add to the Agents draft"],
    screenshot: ["截取 PDF 原页区域到 Agents 草稿", "Capture a PDF page region to the Agents draft"],
    cancelScreenshot: ["取消 PDF 截图", "Cancel PDF capture"]
  };

  function readerText(key, locale = global.Zotero?.locale || "zh-CN") {
    const values = readerStrings[key];
    if (!values) throw new Error("Unknown Reader localization key");
    return values[/^zh/iu.test(locale) ? 0 : 1];
  }

  modules.AgentProviders = { providers, getProvider, validMode, normalizeConfigOptions, busy, readerText };
  if (typeof module !== "undefined" && module.exports) module.exports = modules.AgentProviders;
})(typeof globalThis !== "undefined" ? globalThis : this);
