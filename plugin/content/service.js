(function (global) {
  "use strict";

  const modules = global.SmartPaperTranslatorModules = global.SmartPaperTranslatorModules || {};
  const Constants = modules.Constants || (
    typeof require === "function" ? require("./constants.js") : null
  );
  const Logic = modules.Logic || (
    typeof require === "function" ? require("./logic.js") : null
  );

  class ZoteroPaperRepository {
    constructor(items) {
      this.items = items || global.Zotero.Items;
    }

    async get(itemID) {
      const attachment = await this.items.getAsync(itemID);
      if (!attachment?.isPDFAttachment?.()) {
        throw new Logic.SmartTranslatorError("PAPER_UNSUPPORTED", "当前阅读器内容不是 PDF 附件");
      }
      const parent = attachment.parentItemID
        ? await this.items.getAsync(attachment.parentItemID)
        : null;
      const libraryID = parent?.libraryID ?? attachment.libraryID;
      const itemKey = parent?.key || attachment.key;
      const attachmentKey = attachment.key;
      const title = Logic.normalizeText(parent?.getField("title") || attachment.getField("title"));
      const abstract = String(parent?.getField("abstractNote") || "").trim();
      const paper = {
        storageKey: Logic.makePaperIdentity({ libraryID, itemKey, attachmentKey }),
        libraryID,
        itemKey,
        attachmentKey,
        attachmentID: attachment.id,
        parentItemID: parent?.id || null,
        title: title || "未命名论文"
      };
      return { paper, abstract };
    }
  }

  class TranslationService {
    constructor({ getPreference, paperRepository, cache, credentials, apiClient, now } = {}) {
      this.getPreference = getPreference;
      this.paperRepository = paperRepository;
      this.cache = cache;
      this.credentials = credentials;
      this.apiClient = apiClient;
      this.now = now || (() => new Date().toISOString());
      this.inFlight = new Map();
      this.cancelers = new Set();
      this.listeners = new Set();
      this.stopped = false;
    }

    subscribe(listener) {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    }

    _emit(event) {
      for (const listener of this.listeners) {
        try {
          listener(event);
        }
        catch (_error) {}
      }
    }

    _registerCancel(cancel) {
      this.cancelers.add(cancel);
      return () => this.cancelers.delete(cancel);
    }

    _settings() {
      return Logic.getProviderConfig(this.getPreference);
    }

    _prepare(kind, context, source, pageNumber) {
      const config = this._settings();
      const isAbstract = kind === "abstract";
      const template = this.getPreference(
        isAbstract ? Constants.PREFS.abstractPrompt : Constants.PREFS.selectionPrompt
      );
      const allowed = isAbstract
        ? Constants.ABSTRACT_TEMPLATE_VARIABLES
        : Constants.SELECTION_TEMPLATE_VARIABLES;
      const required = isAbstract ? ["abstract"] : ["text"];
      const abstractContext = context.abstract || "（Zotero 条目未提供摘要）";
      const templateContext = {
        text: source,
        abstract: abstractContext,
        title: context.paper.title,
        targetLanguage: config.targetLanguage,
        pageNumber: pageNumber == null ? "未知" : String(pageNumber)
      };
      const prompt = Logic.renderTemplate(template, templateContext, allowed, required);
      const configSignature = Logic.sha256Hex(Logic.stableSerialize({
        systemMessageVersion: Constants.SYSTEM_MESSAGE_VERSION,
        kind,
        provider: config.provider,
        endpoint: config.endpoint,
        model: config.model,
        targetLanguage: config.targetLanguage,
        template: String(template),
        title: Logic.normalizeText(context.paper.title),
        abstract: Logic.normalizeText(abstractContext),
        normalizedSource: Logic.normalizeText(source)
      }));
      return { config, prompt, configSignature };
    }

    _buildCacheLookup(kind, context, source, pageNumber) {
      if (this.stopped) {
        throw new Logic.SmartTranslatorError("PLUGIN_STOPPED", "插件已停止");
      }
      const normalizedSource = Logic.normalizeText(source);
      if (!normalizedSource) {
        throw new Logic.SmartTranslatorError("SOURCE_EMPTY", "没有可翻译的文本");
      }
      const prepared = this._prepare(kind, context, source, pageNumber);
      return {
        normalizedSource,
        prepared,
        cacheQuery: {
          kind,
          normalizedSource,
          configSignature: prepared.configSignature
        }
      };
    }

    async _readCachedResult(context, lookup) {
      const cached = await this.cache.getCached(context.paper, lookup.cacheQuery);
      if (!cached) return null;
      const touched = await this.cache.touch(context.paper, cached.id);
      const entry = touched || cached;
      return {
        status: "translated",
        fromCache: true,
        paper: context.paper,
        entry,
        translation: entry.translation
      };
    }

    async _translateWithCache({ kind, context, source, pageNumber }) {
      const lookup = this._buildCacheLookup(kind, context, source, pageNumber);
      const cachedResult = await this._readCachedResult(context, lookup);
      if (cachedResult) return cachedResult;
      const { normalizedSource, prepared } = lookup;

      const flightKey = [
        context.paper.storageKey,
        kind,
        normalizedSource,
        prepared.configSignature
      ].join("|");
      if (this.inFlight.has(flightKey)) return this.inFlight.get(flightKey);

      const operation = (async () => {
        const apiKey = await this.credentials.get(prepared.config.provider);
        const translation = await this.apiClient.complete({
          config: prepared.config,
          apiKey,
          prompt: prepared.prompt,
          registerCancel: (cancel) => this._registerCancel(cancel)
        });
        if (this.stopped) {
          throw new Logic.SmartTranslatorError("PLUGIN_STOPPED", "插件已停止");
        }
        const timestamp = this.now();
        const entry = await this.cache.append(context.paper, {
          kind,
          source: String(source).trim(),
          normalizedSource,
          translation,
          isTerm: kind === "selection" && Logic.isShortTerm(source),
          pageNumber: pageNumber == null ? null : Number(pageNumber),
          provider: prepared.config.provider,
          baseURL: prepared.config.baseURL,
          model: prepared.config.model,
          targetLanguage: prepared.config.targetLanguage,
          configSignature: prepared.configSignature,
          createdAt: timestamp,
          lastUsedAt: timestamp,
          cacheHits: 0
        });
        const result = {
          status: "translated",
          fromCache: false,
          paper: context.paper,
          entry,
          translation: entry.translation
        };
        this._emit({ type: "translation", ...result });
        return result;
      })();
      this.inFlight.set(flightKey, operation);
      const cleanup = () => {
        if (this.inFlight.get(flightKey) === operation) this.inFlight.delete(flightKey);
      };
      operation.then(cleanup, cleanup);
      return operation;
    }

    async translateSelection(itemID, text, pageNumber) {
      const context = await this.paperRepository.get(itemID);
      return this._translateWithCache({
        kind: "selection",
        context,
        source: String(text ?? ""),
        pageNumber
      });
    }

    async getCachedSelection(itemID, text, pageNumber) {
      const context = await this.paperRepository.get(itemID);
      const lookup = this._buildCacheLookup(
        "selection",
        context,
        String(text ?? ""),
        pageNumber
      );
      return this._readCachedResult(context, lookup);
    }

    async ensureAbstract(itemID) {
      const context = await this.paperRepository.get(itemID);
      if (!Logic.normalizeText(context.abstract)) {
        return { status: "missing", paper: context.paper, translation: "", entry: null };
      }
      return this._translateWithCache({
        kind: "abstract",
        context,
        source: context.abstract,
        pageNumber: null
      });
    }

    _prepareSmartTags(context) {
      if (this.stopped) {
        throw new Logic.SmartTranslatorError("PLUGIN_STOPPED", "插件已停止");
      }
      const config = this._settings();
      const sourceSignature = Logic.makeSmartTagsSourceSignature({
        title: context.paper.title,
        abstract: context.abstract
      });
      const configSignature = Logic.makeSmartTagsConfigSignature({
        sourceSignature,
        config
      });
      return {
        config,
        sourceSignature,
        configSignature,
        prompt: Logic.createSmartTagsPrompt({
          title: context.paper.title,
          abstract: context.abstract
        }),
        cacheQuery: {
          kind: Constants.SMART_TAGS_KIND,
          normalizedSource: sourceSignature,
          configSignature
        }
      };
    }

    async _readCachedSmartTags(context, prepared) {
      const cached = await this.cache.getCached(context.paper, prepared.cacheQuery);
      if (!cached || !Array.isArray(cached.tags)) return null;
      const touched = await this.cache.touch(context.paper, cached.id);
      const entry = touched || cached;
      const result = {
        status: "ready",
        fromCache: true,
        paper: context.paper,
        entry,
        tags: entry.tags.slice()
      };
      this._emit({ type: "smart-tags", ...result });
      return result;
    }

    async ensureSmartTags(itemID) {
      const context = await this.paperRepository.get(itemID);
      if (!Logic.normalizeText(context.abstract)) {
        return { status: "missing", paper: context.paper, tags: [], entry: null };
      }
      const prepared = this._prepareSmartTags(context);
      const cachedResult = await this._readCachedSmartTags(context, prepared);
      if (cachedResult) return cachedResult;

      const flightKey = [
        context.paper.storageKey,
        Constants.SMART_TAGS_KIND,
        prepared.configSignature
      ].join("|");
      if (this.inFlight.has(flightKey)) return this.inFlight.get(flightKey);

      const operation = (async () => {
        const apiKey = await this.credentials.get(prepared.config.provider);
        const response = await this.apiClient.complete({
          config: prepared.config,
          apiKey,
          prompt: prepared.prompt,
          systemMessage: Constants.SMART_TAGS_SYSTEM_MESSAGE,
          maxTokens: Constants.SMART_TAGS_MAX_TOKENS,
          registerCancel: (cancel) => this._registerCancel(cancel)
        });
        const tags = Logic.parseSmartTagsResponse(response);
        if (this.stopped) {
          throw new Logic.SmartTranslatorError("PLUGIN_STOPPED", "插件已停止");
        }
        const timestamp = this.now();
        const entry = await this.cache.append(context.paper, {
          kind: Constants.SMART_TAGS_KIND,
          normalizedSource: prepared.sourceSignature,
          sourceSignature: prepared.sourceSignature,
          tags,
          provider: prepared.config.provider,
          baseURL: prepared.config.baseURL,
          model: prepared.config.model,
          configSignature: prepared.configSignature,
          createdAt: timestamp,
          lastUsedAt: timestamp,
          cacheHits: 0
        });
        const result = {
          status: "ready",
          fromCache: false,
          paper: context.paper,
          entry,
          tags: entry.tags.slice()
        };
        this._emit({ type: "smart-tags", ...result });
        return result;
      })();
      this.inFlight.set(flightKey, operation);
      const cleanup = () => {
        if (this.inFlight.get(flightKey) === operation) this.inFlight.delete(flightKey);
      };
      operation.then(cleanup, cleanup);
      return operation;
    }

    async getGlossaryForItem(itemID) {
      const context = await this.paperRepository.get(itemID);
      return {
        paper: context.paper,
        entries: await this.cache.getGlossary(context.paper)
      };
    }

    async testConnection() {
      const config = this._settings();
      const apiKey = await this.credentials.get(config.provider);
      const translation = await this.apiClient.complete({
        config,
        apiKey,
        prompt: "这是连接测试。请只回复：OK",
        maxTokens: 8,
        registerCancel: (cancel) => this._registerCancel(cancel)
      });
      return { ok: true, response: translation };
    }

    shutdown() {
      this.stopped = true;
      for (const cancel of this.cancelers) {
        try {
          cancel();
        }
        catch (_error) {}
      }
      this.cancelers.clear();
      this.listeners.clear();
    }
  }

  modules.Service = { TranslationService, ZoteroPaperRepository };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { TranslationService, ZoteroPaperRepository };
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
