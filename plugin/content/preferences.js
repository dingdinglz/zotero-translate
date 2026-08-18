(function (scope) {
  "use strict";

  const manager = {
    initialized: false,
    cleanups: [],

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

      this.win.setTimeout(() => {
        this.updateProviderVisibility();
        this.updateKeyStatus();
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

    destroy() {
      for (const cleanup of this.cleanups.splice(0)) cleanup();
      this.initialized = false;
      this.win = null;
      this.doc = null;
      this.bridge = null;
    }
  };

  scope.SmartPaperTranslatorPreferences = manager;
})(window);
