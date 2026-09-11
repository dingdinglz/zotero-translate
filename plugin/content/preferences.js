(function (scope) {
  "use strict";

  const pathInputs = { node: "spt-acp-node-path", npx: "spt-acp-npx-path",
    codex: "spt-codex-executable-path", pi: "spt-pi-executable-path", opencode: "spt-opencode-executable-path" };

  const agentTabs = ["codex", "pi", "opencode"];

  const manager = {
    initialized: false,
    cleanups: [],
    codexCatalog: { configOptions: [], configOptionsByModel: {}, updatedAt: null },

    init(win) {
      if (this.initialized) return;
      this.initialized = true;
      this.win = win;
      this.doc = win.document;
      this.bridge = win.Zotero.SmartPaperTranslator;
      win.MozXULElement?.insertFTLIfNeeded?.("smart-paper-translator-codex-chat.ftl");

      this._listen("spt-provider", "change", () => {
        this.updateProviderVisibility();
        this.updateKeyStatus();
      });
      this._listen("spt-save-key", "click", () => this.saveKey());
      this._listen("spt-remove-key", "click", () => this.removeKey());
      this._listen("spt-test-connection", "click", () => this.testConnection());
      this._listen("spt-reset-deepseek", "click", () => this.resetDeepSeek());
      this._listen("spt-reset-prompts", "click", () => this.resetPrompts());
      this._listen("spt-validate-prompts", "click", () => this.validatePrompts());
      for (const agentId of agentTabs) {
        this._listen(`spt-agent-tab-${agentId}`, "click", () => this.selectAgentTab(agentId));
        this._listen(`spt-agent-tab-${agentId}`, "keydown", (event) => {
          const index = agentTabs.indexOf(agentId);
          const target = { ArrowLeft: agentTabs[(index + agentTabs.length - 1) % agentTabs.length],
            ArrowRight: agentTabs[(index + 1) % agentTabs.length], Home: agentTabs[0], End: agentTabs.at(-1) }[event.key];
          if (!target) return;
          event.preventDefault();
          this.selectAgentTab(target, true);
        });
      }
      this.selectAgentTab("codex");
      this._listen("spt-acp-detect", "click", () => this.runSharedAction("detect"));
      this._listen("spt-acp-inspect", "click", () => this.runSharedAction("inspect"));
      for (const [kind, id] of Object.entries(pathInputs)) {
        this._listen(id, "input", () => this._syncPathChoice(kind));
        this._listen(id, "change", () => {
          if (this.writingBoundValue) return;
          this._commitPathInput(kind);
        });
        this._listen(`spt-path-options-${kind}`, "change", () => {
          if (this.acpAction) return;
          const path = this.doc.getElementById(`spt-path-options-${kind}`).value;
          if (path && this.pathCandidates?.[kind]?.some(entry => entry.path === path)) {
            this._setBoundValue(id, path);
            this._commitPathInput(kind);
          }
          else this.doc.getElementById(id).focus();
        });
      }
      this._listen("spt-codex-auto-detect", "click", () => this.detectCodexPaths());
      this._listen("spt-codex-inspect", "click", () => this.inspectCodex());
      this._listen("spt-codex-prepare", "click", () => this.prepareCodex());
      this._listen("spt-codex-default-model", "change", () => {
        this._updateCodexReasoningOptions(true);
      });
      for (const button of this.doc.querySelectorAll("[data-acp-browse]")) {
        const handler = () => this.pickCodexPath(button.dataset.acpBrowse);
        button.addEventListener("click", handler);
        this.cleanups.push(() => button.removeEventListener("click", handler));
      }

      for (const action of ["detect", "inspect", "prepare", "browse"]) {
        this._listen(`spt-pi-${action}`, "click", () => this.runPiAction(action));
      }
      this._listen("spt-pi-default-model", "change", () => this.renderPiReasoning(true));
      for (const action of ["detect", "inspect", "browse"]) {
        this._listen(`spt-opencode-${action}`, "click", () => this.runOpenCodeAction(action));
      }
      this._listen("spt-opencode-default-model", "change", () => this.renderOpenCodeReasoning(true));
      const doc = this.doc;
      const timer = this.win.setTimeout(() => {
        if (this.doc !== doc) return;
        this.updateProviderVisibility();
        this.updateKeyStatus();
        this.renderCodexStatus(this.bridge.getCodexStatus());
        this.renderPiStatus(this.bridge.getPiStatus());
        this.renderOpenCodeStatus(this.bridge.getOpenCodeStatus?.());
        this.refreshPathCandidates();
      }, 0);
      this.cleanups.push(() => win.clearTimeout(timer));
    },

    _listen(id, event, handler) {
      const element = this.doc.getElementById(id);
      element.addEventListener(event, handler);
      this.cleanups.push(() => element.removeEventListener(event, handler));
    },

    _provider() {
      return this.doc.getElementById("spt-provider").value === "custom" ? "custom" : "deepseek";
    },

    _setBoundValue(id, value) {
      const element = this.doc.getElementById(id);
      if (element.value === value) return;
      this.writingBoundValue = true;
      try {
        element.value = value;
        element.dispatchEvent(new this.win.Event("input", { bubbles: true }));
        element.dispatchEvent(new this.win.Event("change", { bubbles: true }));
      }
      finally { this.writingBoundValue = false; }
    },

    _status(id, message, kind = "normal") {
      const element = this.doc.getElementById(id);
      element.textContent = message;
      element.dataset.kind = kind;
    },

    updateProviderVisibility() {
      const provider = this._provider();
      for (const element of this.doc.querySelectorAll("[data-provider]")) {
        element.hidden = element.dataset.provider !== provider;
      }
    },

    async updateKeyStatus() {
      const doc = this.doc;
      const request = this.keyStatusRequest = (this.keyStatusRequest || 0) + 1;
      const current = () => this.doc === doc && this.keyStatusRequest === request;
      try {
        const hasKey = await this.bridge.hasAPIKey(this._provider());
        if (!current()) return;
        this._status("spt-connection-status", hasKey ? "已安全保存 API Key" : "未保存 API Key", hasKey ? "success" : "normal");
      }
      catch (_error) {
        if (!current()) return;
        this._status("spt-connection-status", "无法读取密钥状态", "error");
      }
    },

    async saveKey() {
      const input = this.doc.getElementById("spt-api-key");
      const key = input.value.trim();
      if (!key) {
        this._status("spt-connection-status", "请输入 API Key", "error");
        return;
      }
      try {
        await this.bridge.setAPIKey(this._provider(), key);
        input.value = "";
        this._status("spt-connection-status", "API Key 已安全保存", "success");
      }
      catch (_error) {
        this._status("spt-connection-status", "保存 API Key 失败", "error");
      }
    },

    async removeKey() {
      try {
        await this.bridge.removeAPIKey(this._provider());
        this.doc.getElementById("spt-api-key").value = "";
        this._status("spt-connection-status", "API Key 已移除", "success");
      }
      catch (_error) {
        this._status("spt-connection-status", "移除 API Key 失败", "error");
      }
    },

    async testConnection() {
      const button = this.doc.getElementById("spt-test-connection");
      button.disabled = true;
      this._status("spt-connection-status", "正在测试，会产生极少量 API 用量…");
      try {
        this.validatePrompts();
        const result = await this.bridge.testConnection();
        this._status("spt-connection-status", `连接成功：${result.response}`, "success");
      }
      catch (error) {
        this._status("spt-connection-status", error.message || "连接失败", "error");
      }
      finally {
        button.disabled = false;
      }
    },

    resetDeepSeek() {
      this._setBoundValue("spt-deepseek-base-url", this.bridge.defaults.deepseekBaseURL);
      this._setBoundValue("spt-deepseek-model", this.bridge.defaults.deepseekModel);
      this._status("spt-connection-status", "已恢复 DeepSeek 默认配置", "success");
    },

    resetPrompts() {
      this._setBoundValue("spt-selection-prompt", this.bridge.defaults.selectionPrompt);
      this._setBoundValue("spt-abstract-prompt", this.bridge.defaults.abstractPrompt);
      this._status("spt-template-status", "已恢复默认模板", "success");
    },

    validatePrompts() {
      try {
        this.bridge.validateTemplates(
          this.doc.getElementById("spt-selection-prompt").value,
          this.doc.getElementById("spt-abstract-prompt").value
        );
        this._status("spt-template-status", "模板有效", "success");
        return true;
      }
      catch (error) {
        this._status("spt-template-status", error.message || "模板无效", "error");
        throw error;
      }
    },

    selectAgentTab(agentId, focus = false) {
      if (!agentTabs.includes(agentId)) return;
      for (const id of agentTabs) {
        const active = id === agentId;
        const tab = this.doc.getElementById(`spt-agent-tab-${id}`);
        tab.setAttribute("aria-selected", String(active));
        tab.tabIndex = active ? 0 : -1;
        this.doc.getElementById(`spt-agent-panel-${id}`).hidden = !active;
        if (active && focus) tab.focus();
      }
    },

    _syncPathChoice(kind) {
      const select = this.doc?.getElementById(`spt-path-options-${kind}`);
      if (!select) return;
      const value = this.doc.getElementById(pathInputs[kind]).value.trim();
      select.value = this.pathCandidates?.[kind]?.some(entry => entry.path === value) ? value : "";
    },

    _commitPathInput(kind) {
      if (kind === "node" || kind === "npx") {
        this._saveSharedPaths();
        this.sharedVersions = {};
        this.renderSharedStatus();
        this.renderCodexStatus(this.bridge.getCodexStatus());
        this.renderPiStatus(this.bridge.getPiStatus());
      }
      else if (kind === "codex") {
        this._saveCodexPaths();
        this.renderCodexStatus(this.bridge.getCodexStatus());
      }
      else if (kind === "opencode") {
        this.bridge.setOpenCodePaths({ opencodePath: this.doc.getElementById(pathInputs.opencode).value.trim() });
        this.renderOpenCodeStatus(this.bridge.getOpenCodeStatus());
      }
      else {
        this.bridge.setPiPaths({ piPath: this.doc.getElementById(pathInputs.pi).value.trim() });
        this.renderPiStatus(this.bridge.getPiStatus());
      }
      this._syncPathChoice(kind);
    },

    async refreshPathCandidates() {
      const doc = this.doc;
      const request = this.pathDiscoveryRequest = (this.pathDiscoveryRequest || 0) + 1;
      const current = () => this.doc === doc && request === this.pathDiscoveryRequest;
      const status = doc.getElementById("spt-path-discovery-status");
      this._localize(status, "paths-scanning", "正在查找本机安装…");
      try {
        const candidates = await this.bridge.listACPPathCandidates();
        if (!current()) return;
        this.pathCandidates = candidates;
        let count = 0;
        for (const kind of Object.keys(pathInputs)) {
          const select = doc.getElementById(`spt-path-options-${kind}`);
          const manual = doc.createElement("option");
          manual.value = "";
          this._localize(manual, "path-manual", "手动输入或浏览…");
          select.replaceChildren(manual);
          for (const entry of candidates[kind] || []) {
            const option = doc.createElement("option");
            option.value = entry.path;
            this._localize(option, "path-option", `${entry.source === "nvm" ? `NVM ${entry.version}` : entry.source.toUpperCase()} · ${entry.path}`,
              { source: entry.source, version: entry.version || "", path: entry.path });
            select.append(option);
            count += 1;
          }
          this._setControlDisabled(select, !(candidates[kind]?.length));
          this._syncPathChoice(kind);
        }
        this._localize(status, count ? "paths-found" : "paths-empty",
          count ? `已找到 ${count} 个路径候选；保留当前选择。` : "未找到安装，可手动输入路径或浏览文件。", { count });
      }
      catch (error) {
        if (!current()) return;
        this._localize(status, "paths-error", "无法读取候选路径，仍可手动输入或浏览文件。");
      }
    },

    _sharedPathsFromInputs() {
      return {
        nodePath: this.doc.getElementById("spt-acp-node-path").value.trim(),
        npxCliPath: this.doc.getElementById("spt-acp-npx-path").value.trim()
      };
    },

    _saveSharedPaths() {
      return this.bridge.setACPPaths(this._sharedPathsFromInputs());
    },

    _saveCodexPaths() {
      return this.bridge.setCodexPaths({ ...this._sharedPathsFromInputs(),
        codexPath: this.doc.getElementById("spt-codex-executable-path").value.trim() });
    },

    // A shared path cannot change midway through either provider's inspection.
    // Tabs only switch local panels and remain available while the controls are locked.
    async _runACPAction(action, onError) {
      if (this.acpAction || !this.doc) return;
      const operation = { doc: this.doc, bridge: this.bridge, disabled: new Map() };
      this.acpAction = operation;
      const current = () => this.acpAction === operation && this.doc === operation.doc;
      for (const control of this.doc.querySelectorAll(
        '#spt-acp-settings input, #spt-acp-settings select, #spt-acp-settings button:not([role="tab"])'
      )) {
        operation.disabled.set(control, control.disabled);
        control.disabled = true;
      }
      try { await action(current, operation.bridge); }
      catch (error) { if (current()) onError(error); }
      finally {
        if (current()) {
          for (const [control, disabled] of operation.disabled) control.disabled = disabled;
          this.acpAction = null;
        }
      }
    },

    _setControlDisabled(control, disabled) {
      if (this.acpAction?.disabled.has(control)) this.acpAction.disabled.set(control, disabled);
      control.disabled = this.acpAction ? true : disabled;
    },

    renderSharedStatus(result = {}) {
      if (result.paths?.nodePath) this._setBoundValue("spt-acp-node-path", result.paths.nodePath);
      if (result.paths?.npxCliPath) this._setBoundValue("spt-acp-npx-path", result.paths.npxCliPath);
      if (result.versions) this.sharedVersions = result.versions;
      for (const kind of ["node", "npx"]) {
        const element = this.doc.getElementById(`spt-acp-${kind}-version`);
        if (this.sharedVersions?.[kind]) {
          element.removeAttribute("data-l10n-id");
          element.textContent = this.sharedVersions[kind];
        }
        else this._localize(element, "runtime-unchecked", "尚未检测");
      }
      const status = this.doc.getElementById("spt-acp-status");
      status.dataset.kind = result.healthy === false ? "error" : "normal";
      if (result.lastError) {
        status.removeAttribute("data-l10n-id");
        status.textContent = result.lastError;
      }
      else this._localize(status, this.sharedVersions?.node ? "shared-checked" : "shared-needs-inspect",
        this.sharedVersions?.node ? "已检测所选 Node / npx；Agent 要求在各自 Tab 中检测。" : "请选择或探测路径，然后检测 Node / npx。");
    },

    runSharedAction(action) {
      return this._runACPAction(async (current, bridge) => {
        if (action === "detect") return this.refreshPathCandidates();
        this._saveSharedPaths();
        this._localize(this.doc.getElementById("spt-acp-status"), "working", "正在检测…");
        const result = await bridge.inspectACPRuntime();
        if (!current()) return;
        this.renderSharedStatus(result);
      }, (error) => this.renderSharedStatus({ healthy: false, lastError: this._formatCodexError(error, "Node / npx error") }));
    },

    _codexStatus(name, value, kind = "normal") {
      const element = this.doc.querySelector(`[data-codex-status="${name}"]`);
      element.textContent = String(value || "—");
      element.dataset.kind = kind;
    },

    _formatCodexError(error, fallback) {
      try {
        return this.bridge.formatCodexError(error, fallback) || fallback;
      }
      catch (_formatError) {
        return error?.message || fallback;
      }
    },

    _populateCodexSelect(id, option, savedValue, agent = "Codex") {
      const select = this.doc.getElementById(id);
      select.replaceChildren();
      const inherited = this.doc.createElement("option");
      inherited.value = "";
      inherited.textContent = option?.currentValue
        ? `跟随 ${agent} 当前值（${option.currentValue}）`
        : "尚未读取选项，请准备或重新检测 ACP";
      if (agent !== "Codex") this._localize(inherited,
        option?.currentValue ? "inherit" : "options-unavailable", inherited.textContent,
        { agent, value: option?.currentValue || "" });
      select.append(inherited);
      const values = (option?.options || []).map((entry) =>
        typeof entry === "string" ? { value: entry, name: entry } : entry
      ).filter((entry) => entry?.value);
      for (const entry of values) {
        const item = this.doc.createElement("option");
        item.value = entry.value;
        item.textContent = entry.name || entry.label || entry.value;
        select.append(item);
      }
      if (savedValue && !values.some((entry) => entry.value === savedValue)) {
        const missing = this.doc.createElement("option");
        missing.value = savedValue;
        missing.textContent = `${savedValue}（已不可用）`;
        select.append(missing);
      }
      select.value = savedValue || "";
      this._setControlDisabled(select, !values.length);
    },

    _catalogOptionsForModel(model) {
      const byModel = this.codexCatalog.configOptionsByModel || {};
      if (
        model &&
        Object.prototype.hasOwnProperty.call(byModel, model) &&
        Array.isArray(byModel[model]) &&
        byModel[model].length
      ) {
        return byModel[model];
      }
      return this.codexCatalog.configOptions || [];
    },

    _updateCodexReasoningOptions(resetInvalid = false) {
      const modelSelect = this.doc.getElementById("spt-codex-default-model");
      const reasoningSelect = this.doc.getElementById("spt-codex-default-reasoning");
      const baseModel = (this.codexCatalog.configOptions || []).find(
        (entry) => entry.id === "model"
      );
      const model = modelSelect.value || baseModel?.currentValue || "";
      const reasoning = this._catalogOptionsForModel(model).find(
        (entry) => entry.id === "reasoning_effort"
      );
      const values = (reasoning?.options || []).map((entry) =>
        typeof entry === "string" ? entry : entry?.value
      ).filter(Boolean);
      let savedValue = reasoningSelect.value;
      if (resetInvalid && savedValue && !values.includes(savedValue)) {
        savedValue = "";
        this._setBoundValue("spt-codex-default-reasoning", "");
      }
      this._populateCodexSelect(
        "spt-codex-default-reasoning",
        reasoning,
        savedValue
      );
    },

    renderCodexStatus(result = {}) {
      const paths = result.paths || {};
      this.renderSharedStatus(result);
      if (paths.codexPath) this._setBoundValue("spt-codex-executable-path", paths.codexPath);
      const versions = result.versions || {};
      const adapter = result.adapter || {};
      this._codexStatus("codex", versions.codex || (paths.codexPath ? "路径已保存，尚未检测" : "未选择"));
      this._codexStatus(
        "acp",
        adapter.preparedVersion
          ? `${adapter.preparedVersion}${adapter.healthy ? " · 握手成功" : " · 已准备"}`
          : (versions.codexACP || "未准备")
      );
      const auth = adapter.authentication;
      this._codexStatus("login", result.login || (auth ? JSON.stringify(auth) : "未检测"));
      this._codexStatus("health", adapter.healthy || result.healthy ? "正常" : "未就绪", adapter.healthy || result.healthy ? "success" : "normal");
      const capabilityKeys = adapter.capabilities ? Object.keys(adapter.capabilities) : [];
      this._codexStatus("capabilities", capabilityKeys.length ? capabilityKeys.join("、") : "未握手");
      this._codexStatus("mode", adapter.mode || "agent（受审批）");
      this._codexStatus("error", result.lastError || adapter.lastError || "无", result.lastError || adapter.lastError ? "error" : "normal");

      const fallback = this.bridge.getCodexStatus();
      this.codexCatalog = {
        configOptions: Array.isArray(result.configOptions)
          ? result.configOptions
          : (fallback.configOptions || []),
        configOptionsByModel: result.configOptionsByModel ||
          fallback.configOptionsByModel || {},
        updatedAt: result.updatedAt || fallback.updatedAt || null
      };
      const options = this.codexCatalog.configOptions;
      this._populateCodexSelect(
        "spt-codex-default-model",
        options.find((entry) => entry.id === "model"),
        this.doc.getElementById("spt-codex-default-model").value
      );
      this._updateCodexReasoningOptions(false);
      this._codexStatus(
        "catalog",
        this.codexCatalog.updatedAt
          ? `已读取 · ${new Date(this.codexCatalog.updatedAt).toLocaleString()}`
          : "未读取（请准备或重新检测 ACP）"
      );
    },

    detectCodexPaths() { return this.runSharedAction("detect"); },
    inspectCodex() { return this.runCodexAction("inspect"); },
    prepareCodex() { return this.runCodexAction("prepare"); },

    runCodexAction(action) {
      return this._runACPAction(async (current, bridge) => {
        this._saveCodexPaths();
        this._codexStatus("health", action === "prepare"
          ? "正在准备固定版本并读取模型选项；首次可能需要下载…" : "正在检测…");
        const method = { detect: "detectCodexPaths", inspect: "inspectCodexRuntime", prepare: "prepareCodexACP" }[action];
        const result = await bridge[method]();
        if (current()) this.renderCodexStatus(result);
      }, (error) => {
        this._codexStatus("error", this._formatCodexError(error, "Codex ACP error"), "error");
        this._codexStatus("health", "未就绪", "error");
      });
    },

    pickCodexPath(kind) {
      return this._runACPAction(async (current, bridge) => {
        const path = await bridge.pickCodexPath(kind, this.win);
        if (!current() || !path) return;
        const id = kind === "node" ? "spt-acp-node-path" :
          kind === "npx" ? "spt-acp-npx-path" : "spt-codex-executable-path";
        this._setBoundValue(id, path);
        if (kind === "codex") {
          this._saveCodexPaths();
          this.renderCodexStatus(bridge.getCodexStatus());
        }
        else {
          this._saveSharedPaths();
          this.sharedVersions = {};
          this.renderSharedStatus();
          this.renderCodexStatus(bridge.getCodexStatus());
          this.renderPiStatus(bridge.getPiStatus());
        }
      }, (error) => {
        const message = this._formatCodexError(error, "Path selection failed");
        if (kind === "codex") this._codexStatus("error", message, "error");
        else this.renderSharedStatus({ healthy: false, lastError: message });
      });
    },

    _localize(element, key, fallback, args = null) {
      element.textContent = fallback;
      element.setAttribute("data-l10n-id", `smart-paper-translator-agents-${key}`);
      if (args) element.setAttribute("data-l10n-args", JSON.stringify(args));
      else element.removeAttribute("data-l10n-args");
    },

    renderPiReasoning(resetInvalid = false) {
      const model = this.doc.getElementById("spt-pi-default-model").value;
      const options = this.piCatalog?.configOptionsByModel?.[model] || this.piCatalog?.configOptions || [];
      const reasoning = options.find(entry => entry.id === "reasoning_effort");
      const values = (reasoning?.options || []).map(entry => typeof entry === "string" ? entry : entry?.value);
      let saved = this.doc.getElementById("spt-pi-default-reasoning").value;
      if (resetInvalid && saved && !values.includes(saved)) {
        saved = "";
        this._setBoundValue("spt-pi-default-reasoning", "");
      }
      this._populateCodexSelect("spt-pi-default-reasoning", reasoning, saved, "Pi");
    },

    renderPiStatus(result = {}) {
      if (!this.doc || !this.bridge) return;
      this.renderSharedStatus(result);
      if (result.paths?.piPath) this._setBoundValue("spt-pi-executable-path", result.paths.piPath);
      const fallback = this.bridge.getPiStatus();
      this.piCatalog = {
        configOptions: result.configOptions || fallback.configOptions || [],
        configOptionsByModel: result.configOptionsByModel || fallback.configOptionsByModel || {}
      };
      this._populateCodexSelect("spt-pi-default-model", this.piCatalog.configOptions.find((entry) => entry.id === "model"),
        this.doc.getElementById("spt-pi-default-model").value, "Pi");
      this.renderPiReasoning();
      this.doc.getElementById("spt-pi-runtime").textContent = result.versions
        ? result.versions.pi : result.paths?.piPath || "—";
      this.doc.getElementById("spt-pi-adapter").textContent = result.adapter?.preparedVersion || "—";
      this.doc.getElementById("spt-pi-catalog").textContent = result.updatedAt || fallback.updatedAt || "—";
      this.doc.getElementById("spt-pi-status").dataset.kind = "normal";
      const ready = Boolean(result.adapter?.preparedVersion && this.piCatalog.configOptions.length);
      this._localize(this.doc.getElementById("spt-pi-status"), ready ? "ready" : "pi-needs-setup",
        ready ? "已准备" : "请配置 Pi 并准备适配器");
    },

    runPiAction(action) {
      if (action === "detect") return this.runSharedAction("detect");
      return this._runACPAction(async (current, bridge) => {
        this._saveSharedPaths();
        bridge.setPiPaths({ piPath: this.doc.getElementById("spt-pi-executable-path").value });
        this._localize(this.doc.getElementById("spt-pi-status"), "working", "正在检测…");
        if (action === "browse") {
          const path = await bridge.pickCodexPath("pi", this.win);
          if (!current()) return;
          if (path) {
            this._setBoundValue("spt-pi-executable-path", path);
            bridge.setPiPaths({ piPath: path });
          }
          this.renderPiStatus(bridge.getPiStatus());
        }
        else {
          const method = { detect: "detectPiPaths", inspect: "inspectPiRuntime", prepare: "preparePiACP" }[action];
          const result = await bridge[method]();
          if (current()) this.renderPiStatus(result);
        }
      }, (error) => {
        const status = this.doc.getElementById("spt-pi-status");
        status.removeAttribute("data-l10n-id");
        status.dataset.kind = "error";
        status.textContent = this._formatCodexError(error, "Pi ACP error");
      });
    },

    renderOpenCodeReasoning(resetInvalid = false) {
      const model = this.doc.getElementById("spt-opencode-default-model").value;
      const options = this.opencodeCatalog?.configOptionsByModel?.[model] || this.opencodeCatalog?.configOptions || [];
      const reasoning = options.find(entry => entry.id === "reasoning_effort");
      const values = (reasoning?.options || []).map(entry => typeof entry === "string" ? entry : entry?.value);
      let saved = this.doc.getElementById("spt-opencode-default-reasoning").value;
      if (resetInvalid && saved && !values.includes(saved)) {
        saved = "";
        this._setBoundValue("spt-opencode-default-reasoning", "");
      }
      this._populateCodexSelect("spt-opencode-default-reasoning", reasoning, saved, "OpenCode");
    },

    renderOpenCodeStatus(result = {}) {
      if (!this.doc || !this.bridge) return;
      if (result.paths?.opencodePath) this._setBoundValue("spt-opencode-executable-path", result.paths.opencodePath);
      const fallback = this.bridge.getOpenCodeStatus?.() || {};
      this.opencodeCatalog = {
        configOptions: result.configOptions || fallback.configOptions || [],
        configOptionsByModel: result.configOptionsByModel || fallback.configOptionsByModel || {}
      };
      this._populateCodexSelect("spt-opencode-default-model", this.opencodeCatalog.configOptions.find((entry) => entry.id === "model"),
        this.doc.getElementById("spt-opencode-default-model").value, "OpenCode");
      this.renderOpenCodeReasoning();
      this.doc.getElementById("spt-opencode-runtime").textContent = result.adapter?.preparedVersion || fallback.adapter?.preparedVersion || "—";
      this.doc.getElementById("spt-opencode-adapter").textContent = result.adapter?.preparedVersion ? "ACP 1 · Native" : "—";
      this.doc.getElementById("spt-opencode-catalog").textContent = result.updatedAt || fallback.updatedAt || "—";
      this.doc.getElementById("spt-opencode-status").dataset.kind = "normal";
      const ready = Boolean(result.adapter?.preparedVersion && this.opencodeCatalog.configOptions.length);
      this._localize(this.doc.getElementById("spt-opencode-status"), ready ? "ready" : "opencode-needs-setup",
        ready ? "已准备" : "请在插件设置中选择本机程序并检测 OpenCode。");
    },

    runOpenCodeAction(action) {
      return this._runACPAction(async (current, bridge) => {
        this._localize(this.doc.getElementById("spt-opencode-status"), "working", "正在检测…");
        if (action === "detect" || (action === "inspect" && !this.doc.getElementById(pathInputs.opencode).value.trim())) {
          await this.refreshPathCandidates();
          if (!current()) return;
          const input = this.doc.getElementById(pathInputs.opencode);
          const candidate = this.pathCandidates?.opencode?.[0]?.path;
          if (!input.value.trim() && candidate) {
            this._setBoundValue(pathInputs.opencode, candidate);
            bridge.setOpenCodePaths({ opencodePath: candidate });
            this._syncPathChoice("opencode");
          }
        }
        if (action === "detect") {
          this.renderOpenCodeStatus(bridge.getOpenCodeStatus());
          return;
        }
        if (action === "browse") {
          const path = await bridge.pickCodexPath("opencode", this.win);
          if (!current()) return;
          if (path) {
            this._setBoundValue("spt-opencode-executable-path", path);
            bridge.setOpenCodePaths({ opencodePath: path });
          }
          this.renderOpenCodeStatus(bridge.getOpenCodeStatus());
        }
        else {
          bridge.setOpenCodePaths({ opencodePath: this.doc.getElementById("spt-opencode-executable-path").value });
          const method = { inspect: "inspectOpenCodeRuntime" }[action];
          const result = await bridge[method]();
          if (current()) this.renderOpenCodeStatus(result);
        }
      }, (error) => {
        this.renderOpenCodeStatus(this.bridge.getOpenCodeStatus());
        const status = this.doc.getElementById("spt-opencode-status");
        status.removeAttribute("data-l10n-id");
        status.dataset.kind = "error";
        status.textContent = this._formatCodexError(error, "OpenCode ACP error");
      });
    },

    destroy() {
      for (const cleanup of this.cleanups.splice(0)) cleanup();
      this.initialized = false;
      this.win = null;
      this.doc = null;
      this.bridge = null;
      this.codexCatalog = { configOptions: [], configOptionsByModel: {}, updatedAt: null };
      this.piCatalog = null;
      this.opencodeCatalog = null;
      this.sharedVersions = {};
      this.acpAction = null;
      this.pathCandidates = null;
    }
  };

  scope.SmartPaperTranslatorPreferences = manager;
})(window);
