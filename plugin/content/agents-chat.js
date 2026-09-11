(function (global) {
  "use strict";
  const modules = global.SmartPaperTranslatorModules = global.SmartPaperTranslatorModules || {};
  const Constants = modules.Constants || (typeof require === "function" ? require("./constants.js") : null);
  const Agents = modules.AgentProviders || (typeof require === "function" ? require("./agent-providers.js") : null);

  class AgentsChatService {
    constructor({ codexService, piProbeService, createPiService, opencodeProbeService, createOpenCodeService, paperRepository, getPreference, setPreference } = {}) {
      Object.assign(this, { codexService, piProbeService, createPiService, opencodeProbeService, createOpenCodeService, paperRepository, getPreference, setPreference });
      this.piServices = new Map();
      this.opencodeServices = new Map();
      this.paperServices = new Map([["pi", this.piServices], ["opencode", this.opencodeServices]]);
      this.probeServices = new Map([["pi", piProbeService], ["opencode", opencodeProbeService]]);
      this.factories = new Map([["pi", createPiService], ["opencode", createOpenCodeService]]);
      this.references = new Map();
      this.listeners = new Set();
      this.switching = new Set();
      this.releasing = new Set();
      this.closed = false;
      this.detections = new Set();
    }

    _selections() {
      const result = Object.create(null);
      try {
        const raw = String(this.getPreference(Constants.PREFS.agentsByPaper) || "{}");
        if (raw.length > 1024 * 1024) return result;
        const saved = JSON.parse(raw);
        for (const [key, value] of Object.entries(saved || {})) {
          if (/^[0-9]+--[A-Z0-9]{8}$/u.test(key) && Object.hasOwn(Agents.providers, value)) result[key] = value;
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
      const pool = this.paperServices.get(agentId);
      const reference = `${agentId}:${id}`;
      if (!pool.has(id)) {
        const service = this.factories.get(agentId)(id);
        service.configurationCatalog = this.probeServices.get(agentId).configurationCatalog;
        service.subscribe(id, () => {
          if (!this.references.get(reference) && !Agents.busy(service) && service.acp.getStatus().healthy) {
            this._releasePaper(agentId, id);
          }
        });
        pool.set(id, service);
      }
      return pool.get(id);
    }

    retain(agentId, attachmentID) {
      if (agentId === "codex") return;
      const key = `${agentId}:${attachmentID}`;
      this.references.set(key, (this.references.get(key) || 0) + 1);
    }

    release(agentId, attachmentID) {
      if (agentId === "codex") return;
      const key = `${agentId}:${attachmentID}`;
      const count = Math.max(0, (this.references.get(key) || 0) - 1);
      this.references.set(key, count);
      if (!count) this._releasePaper(agentId, attachmentID);
    }

    _releasePaper(agentId, id) {
      const key = `${agentId}:${id}`;
      if (this.releasing.has(key) || this.closed) return;
      const service = this.paperServices.get(agentId)?.get(id);
      if (!service || Agents.busy(service)) return;
      this.releasing.add(key);
      void service.releaseIdle().catch(() => {}).finally(() => this.releasing.delete(key));
    }

    _services() {
      return [...new Set([this.codexService, ...this.probeServices.values(),
        ...[...this.paperServices.values()].flatMap(pool => [...pool.values()])].filter(Boolean))];
    }

    async setActiveAgent(attachmentID, agentId) {
      Agents.getProvider(agentId);
      if (this.switching.has(attachmentID)) throw new Error("Agent switch in progress");
      this.switching.add(attachmentID);
      try {
        const { paper } = await this.paperRepository.get(attachmentID);
        for (const service of [this.codexService, ...[...this.paperServices.values()].map(pool => pool.get(attachmentID))]) {
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

    refreshPiCatalog(options) { return this.refreshAgentCatalog("pi", options); }

    async refreshAgentCatalog(agentId, { prepare = false } = {}) {
      const probe = this.probeServices.get(agentId);
      if (!probe || this.detections.has(agentId) || Agents.busy(probe)) throw new Error(`${agentId} detection is already running`);
      this.detections.add(agentId);
      try {
        if (prepare) await probe.acp.prepare();
        const result = await probe.refreshConfigurationCatalog();
        if (this.closed) throw new Error("Agents service is closed");
        for (const service of this.paperServices.get(agentId).values()) {
          await service.initialize();
          service.configurationCatalog = probe.configurationCatalog;
          service.notifyDefaultConfigurationChanged();
        }
        return result;
      }
      finally {
        this.detections.delete(agentId);
        if (agentId === "opencode") await probe.acp.stop();
      }
    }

    notifyDeveloperModeChanged() {
      for (const service of this._services()) service.notifyDeveloperModeChanged();
    }

    notifyDefaultConfigurationChanged() {
      for (const service of this._services()) service.notifyDefaultConfigurationChanged();
    }

    async shutdown() {
      this.closed = true;
      this.listeners.clear();
      const services = this._services();
      await Promise.allSettled(services.map((service) => service.shutdown()));
      for (const pool of this.paperServices.values()) pool.clear();
      this.references.clear();
    }
  }

  modules.AgentsChat = { AgentsChatService };
  if (typeof module !== "undefined" && module.exports) module.exports = modules.AgentsChat;
})(typeof globalThis !== "undefined" ? globalThis : this);
