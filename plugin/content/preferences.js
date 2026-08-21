(function (scope) {
  "use strict";

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
      this._listen("spt-codex-auto-detect", "click", () => this.detectCodexPaths());
      this._listen("spt-codex-inspect", "click", () => this.inspectCodex());
      this._listen("spt-codex-prepare", "click", () => this.prepareCodex());
      this._listen("spt-codex-default-model", "change", () => {
        this._updateCodexReasoningOptions(true);
      });
      for (const button of this.doc.querySelectorAll("[data-codex-browse]")) {
        const handler = () => this.pickCodexPath(button.dataset.codexBrowse);
        button.addEventListener("click", handler);
        this.cleanups.push(() => button.removeEventListener("click", handler));
      }

      this.win.setTimeout(() => {
        this.updateProviderVisibility();
        this.updateKeyStatus();
        this.renderCodexStatus(this.bridge.getCodexStatus());
      }, 0);
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
      element.value = value;
      element.dispatchEvent(new this.win.Event("input", { bubbles: true }));
      element.dispatchEvent(new this.win.Event("change", { bubbles: true }));
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
      try {
        const hasKey = await this.bridge.hasAPIKey(this._provider());
        this._status("spt-connection-status", hasKey ? "已安全保存 API Key" : "未保存 API Key", hasKey ? "success" : "normal");
      }
      catch (_error) {
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

    _codexPathsFromInputs() {
      return {
        nodePath: this.doc.getElementById("spt-codex-node-path").value.trim(),
        npxCliPath: this.doc.getElementById("spt-codex-npx-path").value.trim(),
        codexPath: this.doc.getElementById("spt-codex-executable-path").value.trim()
      };
    },

    _saveCodexPaths() {
      return this.bridge.setCodexPaths(this._codexPathsFromInputs());
    },

    _setCodexButtons(disabled) {
      for (const id of ["spt-codex-auto-detect", "spt-codex-inspect", "spt-codex-prepare"]) {
        this.doc.getElementById(id).disabled = disabled;
      }
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

    _populateCodexSelect(id, option, savedValue) {
      const select = this.doc.getElementById(id);
      select.replaceChildren();
      const inherited = this.doc.createElement("option");
      inherited.value = "";
      inherited.textContent = option?.currentValue
        ? `跟随 Codex 当前值（${option.currentValue}）`
        : "尚未读取选项，请准备或重新检测 ACP";
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
      select.disabled = !values.length;
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
      if (paths.nodePath) this._setBoundValue("spt-codex-node-path", paths.nodePath);
      if (paths.npxCliPath) this._setBoundValue("spt-codex-npx-path", paths.npxCliPath);
      if (paths.codexPath) this._setBoundValue("spt-codex-executable-path", paths.codexPath);
      const versions = result.versions || {};
      const adapter = result.adapter || {};
      this._codexStatus("node", versions.node || (paths.nodePath ? "路径已保存，尚未检测" : "未选择"));
      this._codexStatus("npx", versions.npx || (paths.npxCliPath ? "路径已保存，尚未检测" : "未选择"));
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

    async detectCodexPaths() {
      this._setCodexButtons(true);
      this._codexStatus("health", "正在探测本地路径…");
      try {
        this.renderCodexStatus(await this.bridge.detectCodexPaths());
      }
      catch (error) {
        this._codexStatus("error", this._formatCodexError(error, "自动探测失败"), "error");
      }
      finally {
        this._setCodexButtons(false);
      }
    },

    async inspectCodex() {
      this._saveCodexPaths();
      this._setCodexButtons(true);
      this._codexStatus("health", "正在检测本地运行时和模型选项…");
      try {
        this.renderCodexStatus(await this.bridge.inspectCodexRuntime());
      }
      catch (error) {
        this._codexStatus("error", this._formatCodexError(error, "检测失败"), "error");
      }
      finally {
        this._setCodexButtons(false);
      }
    },

    async prepareCodex() {
      this._saveCodexPaths();
      this._setCodexButtons(true);
      this._codexStatus("health", "正在准备固定版本并读取模型选项；首次可能需要下载…");
      try {
        this.renderCodexStatus(await this.bridge.prepareCodexACP());
      }
      catch (error) {
        this._codexStatus("error", this._formatCodexError(error, "ACP 准备失败"), "error");
        this._codexStatus("health", "未就绪", "error");
      }
      finally {
        this._setCodexButtons(false);
      }
    },

    async pickCodexPath(kind) {
      try {
        const path = await this.bridge.pickCodexPath(kind);
        if (!path) return;
        const id = kind === "node" ? "spt-codex-node-path" :
          kind === "npx" ? "spt-codex-npx-path" : "spt-codex-executable-path";
        this._setBoundValue(id, path);
        this._saveCodexPaths();
      }
      catch (error) {
        this._codexStatus("error", this._formatCodexError(error, "选择文件失败"), "error");
      }
    },

    destroy() {
      for (const cleanup of this.cleanups.splice(0)) cleanup();
      this.initialized = false;
      this.win = null;
      this.doc = null;
      this.bridge = null;
      this.codexCatalog = { configOptions: [], configOptionsByModel: {}, updatedAt: null };
    }
  };

  scope.SmartPaperTranslatorPreferences = manager;
})(window);
