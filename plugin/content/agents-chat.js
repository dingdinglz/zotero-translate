(function (global) {
  "use strict";
  const modules = global.SmartPaperTranslatorModules = global.SmartPaperTranslatorModules || {};
  const Constants = modules.Constants || (typeof require === "function" ? require("./constants.js") : null);
  const Agents = modules.AgentProviders || (typeof require === "function" ? require("./agent-providers.js") : null);

  class AgentsChatService {
    constructor({ codexService, piProbeService, createPiService, paperRepository, getPreference, setPreference } = {}) {
      Object.assign(this, { codexService, piProbeService, createPiService, paperRepository, getPreference, setPreference });
      this.piServices = new Map();
      this.references = new Map();
      this.listeners = new Set();
      this.switching = new Set();
      this.releasing = new Set();
      this.closed = false;
      this.piDetection = false;
    }

    _selections() {
      const result = Object.create(null);
      try {
        const raw = String(this.getPreference(Constants.PREFS.agentsByPaper) || "{}");
        if (raw.length > 1024 * 1024) return result;
        const saved = JSON.parse(raw);
        for (const [key, value] of Object.entries(saved || {})) {
          if (/^[0-9]+--[A-Z0-9]{8}$/u.test(key) && ["codex", "pi"].includes(value)) result[key] = value;
        }
      }
      catch (_error) {}
      return result;
    }

    async getActiveAgent(attachmentID) {
      const { paper } = await this.paperRepository.get(attachmentID);
      return this._selections()[paper.storageKey] || "codex";
    }

    forAgent(agentId, attachmentID) {
      Agents.getProvider(agentId);
      if (this.closed) throw new Error("Agents service is closed");
      if (agentId === "codex") return this.codexService;
      const id = Number(attachmentID);
      if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Invalid PDF attachment ID");
      if (!this.piServices.has(id)) {
        const service = this.createPiService(id);
        service.configurationCatalog = this.piProbeService.configurationCatalog;
        service.subscribe(id, () => {
          if (!this.references.get(id) && !Agents.busy(service) && service.acp.getStatus().healthy) {
            this._releasePi(id);
          }
        });
        this.piServices.set(id, service);
      }
      return this.piServices.get(id);
    }

    retain(agentId, attachmentID) {
      if (agentId === "pi") this.references.set(attachmentID, (this.references.get(attachmentID) || 0) + 1);
    }

    release(agentId, attachmentID) {
      if (agentId !== "pi") return;
      const count = Math.max(0, (this.references.get(attachmentID) || 0) - 1);
      this.references.set(attachmentID, count);
      if (!count) this._releasePi(attachmentID);
    }

    _releasePi(id) {
      if (this.releasing.has(id) || this.closed) return;
      const service = this.piServices.get(id);
      if (!service || Agents.busy(service)) return;
      this.releasing.add(id);
      void service.releaseIdle().catch(() => {}).finally(() => this.releasing.delete(id));
    }

    async setActiveAgent(attachmentID, agentId) {
      Agents.getProvider(agentId);
      if (this.switching.has(attachmentID)) throw new Error("Agent switch in progress");
      this.switching.add(attachmentID);
      try {
        const { paper } = await this.paperRepository.get(attachmentID);
        for (const service of [this.codexService, this.piServices.get(attachmentID)]) {
          const state = service?.states.get(paper.storageKey);
          if (state && (state.turn || state.interactions.size || ["connecting", "cancelling"].includes(state.status))) {
            throw new Error("Wait for the current operation before switching Agent");
          }
        }
        const selections = this._selections();
        selections[paper.storageKey] = agentId;
        this.setPreference(Constants.PREFS.agentsByPaper, JSON.stringify(selections));
        for (const listener of this.listeners) {
          try { listener({ attachmentID, agentId }); }
          catch (_error) {}
        }
        return agentId;
      }
      finally { this.switching.delete(attachmentID); }
    }

    subscribeSelection(listener) {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    }

    async refreshPiCatalog({ prepare = false } = {}) {
      if (this.piDetection || Agents.busy(this.piProbeService)) throw new Error("Pi detection is already running");
      this.piDetection = true;
      try {
        if (prepare) await this.piProbeService.acp.prepare();
        const result = await this.piProbeService.refreshConfigurationCatalog();
        for (const service of this.piServices.values()) {
          await service.initialize();
          service.configurationCatalog = this.piProbeService.configurationCatalog;
          service.notifyDefaultConfigurationChanged();
        }
        return result;
      }
      finally { this.piDetection = false; }
    }

    notifyDeveloperModeChanged() {
      for (const service of [this.codexService, this.piProbeService, ...this.piServices.values()]) service.notifyDeveloperModeChanged();
    }

    notifyDefaultConfigurationChanged() {
      for (const service of [this.codexService, ...this.piServices.values()]) service.notifyDefaultConfigurationChanged();
    }

    async shutdown() {
      this.closed = true;
      this.listeners.clear();
      const services = [this.codexService, this.piProbeService, ...this.piServices.values()];
      await Promise.allSettled(services.map((service) => service.shutdown()));
      this.piServices.clear();
      this.references.clear();
    }
  }

  modules.AgentsChat = { AgentsChatService };
  if (typeof module !== "undefined" && module.exports) module.exports = modules.AgentsChat;
})(typeof globalThis !== "undefined" ? globalThis : this);
