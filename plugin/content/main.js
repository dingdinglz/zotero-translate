var SmartPaperTranslatorPlugin = {
  id: null,
  version: null,
  rootURI: null,
  initialized: false,
  windowStates: new Map(),
  preferenceObservers: [],
  notifierID: null,
  preferenceRefreshTimer: null,
  bridge: null,

  async init({ id, version, rootURI }) {
    if (this.initialized) return;
    this.id = id;
    this.version = version;
    this.rootURI = rootURI;

    const modules = SmartPaperTranslatorModules;
    const Constants = modules.Constants;
    const getPreference = (name) => this._getPreference(name);
    const setPreference = (name, value) => this._setPreference(name, value);
    const [readerStylesheet, itemTreeStylesheet, codexChatStylesheet] = await Promise.all([
      Zotero.File.getResourceAsync(rootURI + "content/reader.css"),
      Zotero.File.getResourceAsync(rootURI + "content/item-tree.css"),
      Zotero.File.getResourceAsync(rootURI + "content/codex-chat.css")
    ]);

    this.credentials = new modules.Credentials.CredentialStore();
    this.cache = modules.Cache.createZoteroCache({
      onError: (message, error) => this.log(message, error)
    });
    this.apiClient = new modules.API.OpenAIChatClient({
      request: (...args) => Zotero.HTTP.request(...args)
    });
    this.paperRepository = new modules.Service.ZoteroPaperRepository();
    this.service = new modules.Service.TranslationService({
      getPreference,
      paperRepository: this.paperRepository,
      cache: this.cache,
      credentials: this.credentials,
      apiClient: this.apiClient
    });
    this.readerUI = new modules.ReaderUI.ReaderUI({
      service: this.service,
      getPreference,
      setPreference,
      canAddSelectionToCodex: (context) =>
        this.codexChatUI?.canAddSelectionContext(context) || false,
      addSelectionToCodex: (context) => {
        if (!this.codexChatUI) throw new Error("Codex 对话尚未初始化");
        return this.codexChatUI.addSelectionContext(context);
      },
      canAddScreenshotToCodex: (context) =>
        this.codexChatUI?.canAddScreenshotContext(context) || false,
      addScreenshotsToCodex: (context) => {
        if (!this.codexChatUI) throw new Error("Codex 对话尚未初始化");
        return this.codexChatUI.addScreenshotContexts(context);
      },
      getScreenshotAgent: (attachmentID) => this.agentsChatService?.getActiveAgent(attachmentID) || "codex",
      onScreenshotStateChanged: () => this.codexChatUI?.refreshAvailability(),
      stylesheetText: readerStylesheet,
      log: (message, error) => this.log(message, error)
    });
    this.itemTreeUI = new modules.ItemTreeUI.ItemTreeUI({
      cache: this.cache,
      service: this.service,
      getPreference,
      stylesheetText: itemTreeStylesheet,
      log: (message, error) => this.log(message, error)
    });
    this.acpClient = modules.ACP.createZoteroACPClient({
      getPreference,
      setPreference,
      log: (message, error) => this.log(message, error)
    });
    this.chatCache = modules.ChatCache.createZoteroChatCache({
      onError: (message, error) => this.log(message, error)
    });
    this.codexChatService = new modules.CodexChat.CodexChatService({
      getPreference,
      paperRepository: this.paperRepository,
      cache: this.chatCache,
      acpClient: this.acpClient,
      fileSystem: modules.CodexChat.createZoteroFileSystem(),
      log: (message, error) => this.log(message, error)
    });
    await this.codexChatService.initialize();
    this.piChatCache = modules.ChatCache.createZoteroChatCache({
      agentId: "pi", onError: (message, error) => this.log(message, error)
    });
    const createPiService = () => new modules.CodexChat.CodexChatService({
      agentId: "pi", getPreference, paperRepository: this.paperRepository,
      cache: this.piChatCache,
      acpClient: modules.ACP.createZoteroACPClient({ agentId: "pi", getPreference, setPreference, log: (message, error) => this.log(message, error) }),
      fileSystem: modules.CodexChat.createZoteroFileSystem(), log: (message, error) => this.log(message, error)
    });
    this.piProbeService = createPiService();
    await this.piProbeService.initialize();
    this.opencodeChatCache = modules.ChatCache.createZoteroChatCache({
      agentId: "opencode", onError: (message, error) => this.log(message, error)
    });
    const createOpenCodeService = (_attachmentID, probe = false) => new modules.CodexChat.CodexChatService({
      agentId: "opencode", getPreference, paperRepository: this.paperRepository,
      cache: this.opencodeChatCache,
      acpClient: modules.ACP.createZoteroACPClient({ agentId: "opencode", probe, getPreference, setPreference, log: (message, error) => this.log(message, error) }),
      fileSystem: modules.CodexChat.createZoteroFileSystem(), log: (message, error) => this.log(message, error)
    });
    this.opencodeProbeService = createOpenCodeService(null, true);
    await this.opencodeProbeService.initialize();
    this.agentsChatService = new modules.AgentsChat.AgentsChatService({
      codexService: this.codexChatService, piProbeService: this.piProbeService, createPiService,
      opencodeProbeService: this.opencodeProbeService, createOpenCodeService,
      paperRepository: this.paperRepository, getPreference, setPreference
    });
    this.codexChatUI = new modules.CodexChatUI.CodexChatUI({
      service: this.agentsChatService,
      isScreenshotPending: (attachmentID) => this.readerUI.isScreenshotPending(attachmentID),
      stylesheetText: codexChatStylesheet,
      rootURI,
      canStartScreenshotCapture: (context) =>
        this.readerUI?.canStartScreenshotCapture(context) || false,
      requestScreenshotCapture: (context) => {
        if (!this.readerUI) throw new Error("Reader 截图入口尚未初始化");
        return this.readerUI.startScreenshotCapture(context);
      },
      log: (message, error) => this.log(message, error)
    });

    await Zotero.PreferencePanes.register({
      pluginID: id,
      id: "smart-paper-translator-preferences",
      src: rootURI + "content/preferences.xhtml",
      scripts: [rootURI + "content/preferences.js"],
      stylesheets: [rootURI + "content/preferences.css"],
      label: "Smart Paper Translator"
    });

    this._installPreferenceBridge();
    this._observePreferences();
    this._observeItems();
    this.itemTreeUI.init(id);
    this.readerUI.init(id);
    this.codexChatUI.init(id);
    this.initialized = true;
    this.log(`Started ${version}`);
  },

  _installPreferenceBridge() {
    const modules = SmartPaperTranslatorModules;
    const runCodexAction = async (fallback, action) => {
      try {
        return await action();
      }
      catch (error) {
        const publicError = new Error(modules.ACP.formatACPError(error, fallback));
        publicError.name = "CodexACPError";
        throw publicError;
      }
    };
    this.bridge = Object.freeze({
      hasAPIKey: (provider) => this.credentials.has(provider),
      setAPIKey: async (provider, apiKey) => {
        await this.credentials.set(provider, apiKey);
        this._schedulePreferenceRefresh();
      },
      removeAPIKey: async (provider) => {
        await this.credentials.remove(provider);
        this._schedulePreferenceRefresh();
      },
      testConnection: () => this.service.testConnection(),
      validateTemplates: (selectionPrompt, abstractPrompt) => {
        modules.Logic.validateTemplate(
          selectionPrompt,
          modules.Constants.SELECTION_TEMPLATE_VARIABLES,
          ["text"]
        );
        modules.Logic.validateTemplate(
          abstractPrompt,
          modules.Constants.ABSTRACT_TEMPLATE_VARIABLES,
          ["abstract"]
        );
        return true;
      },
      formatCodexError: (error, fallback) => modules.ACP.formatACPError(error, fallback),
      getACPPaths: () => this._sharedACPPaths(),
      listACPPathCandidates: () => runCodexAction("Local path discovery failed", () =>
        modules.ACP.listRuntimePathCandidates({ ...this._codexPaths(), piPath: this._piPaths().piPath, opencodePath: this._opencodePaths().opencodePath })),
      setACPPaths: (paths) => {
        const prefs = modules.Constants.PREFS;
        this._setPreference(prefs.codexNodePath, String(paths?.nodePath || "").trim());
        this._setPreference(prefs.codexNpxCliPath, String(paths?.npxCliPath || "").trim());
        return this._sharedACPPaths();
      },
      detectACPPaths: () => runCodexAction("Node / npx path detection failed", async () => {
        const paths = await modules.ACP.detectSharedPaths(this._sharedACPPaths());
        this.bridge.setACPPaths(paths);
        return { paths };
      }),
      inspectACPRuntime: () => runCodexAction("Node / npx inspection failed", () =>
        modules.ACP.inspectSharedRuntime(this._sharedACPPaths())),
      setCodexPaths: (paths) => {
        const prefs = modules.Constants.PREFS;
        const normalized = {
          nodePath: String(paths?.nodePath || "").trim(),
          npxCliPath: String(paths?.npxCliPath || "").trim(),
          codexPath: String(paths?.codexPath || "").trim()
        };
        this._setPreference(prefs.codexNodePath, normalized.nodePath);
        this._setPreference(prefs.codexNpxCliPath, normalized.npxCliPath);
        this._setPreference(prefs.codexExecutablePath, normalized.codexPath);
        return normalized;
      },
      detectCodexPaths: () => runCodexAction("自动探测失败", async () => {
        const prefs = modules.Constants.PREFS;
        const paths = await modules.ACP.detectLocalPaths({
          nodePath: this._getPreference(prefs.codexNodePath),
          npxCliPath: this._getPreference(prefs.codexNpxCliPath),
          codexPath: this._getPreference(prefs.codexExecutablePath)
        });
        this._setPreference(prefs.codexExecutablePath, paths.codexPath);
        return this.bridge.getCodexStatus();
      }),
      inspectCodexRuntime: () => runCodexAction("检测本地 Codex 失败", async () => {
        const paths = this._codexPaths();
        const runtime = await this._inspectCodex(paths);
        if (this.acpClient.getStatus().preparedVersion === modules.Constants.ACP_PACKAGE_VERSION) {
          try {
            const refreshed = await this.codexChatService.refreshConfigurationCatalog();
            if (refreshed.cleanupWarning) {
              runtime.lastError = modules.ACP.formatACPError(
                refreshed.cleanupWarning,
                "ACP 临时 session 关闭失败"
              );
            }
          }
          catch (error) {
            runtime.lastError = modules.ACP.formatACPError(error, "ACP 健康检查失败");
          }
        }
        return {
          ...runtime,
          adapter: this._publicACPStatus(),
          ...this.codexChatService.getConfigurationCatalog()
        };
      }),
      prepareCodexACP: () => runCodexAction("ACP 准备失败", async () => {
        const runtime = await this._inspectCodex(this._codexPaths());
        if (!runtime.healthy) throw new Error(runtime.lastError || "本地 Node/Codex 检测失败");
        await this.acpClient.prepare();
        const refreshed = await this.codexChatService.refreshConfigurationCatalog();
        const { cleanupWarning, ...catalog } = refreshed;
        if (cleanupWarning) {
          runtime.lastError = modules.ACP.formatACPError(
            cleanupWarning,
            "ACP 临时 session 关闭失败"
          );
        }
        return { ...runtime, adapter: this._publicACPStatus(), ...catalog };
      }),
      getCodexStatus: () => ({
        paths: this._codexPaths(),
        adapter: this._publicACPStatus(),
        ...this.codexChatService.getConfigurationCatalog()
      }),
      pickCodexPath: (kind, parentWindow) => runCodexAction("选择文件失败", () => this._pickCodexPath(kind, parentWindow)),
      getPiStatus: () => ({
        paths: this._piPaths(), adapter: this._publicACPStatus(this.piProbeService.acp),
        ...this.piProbeService.getConfigurationCatalog()
      }),
      setPiPaths: (paths) => {
        this._setPreference(modules.Constants.PREFS.piExecutablePath, String(paths?.piPath || "").trim());
        return this._piPaths();
      },
      detectPiPaths: () => runCodexAction("Pi path detection failed", async () => {
        const paths = await modules.ACP.detectLocalPaths(this._piPaths(), "pi");
        this._setPreference(modules.Constants.PREFS.piExecutablePath, paths.piPath);
        return this.bridge.getPiStatus();
      }),
      inspectPiRuntime: () => runCodexAction("Pi inspection failed", () => this._inspectPi(false)),
      preparePiACP: () => runCodexAction("Pi ACP preparation failed", () => this._inspectPi(true)),
      getOpenCodeStatus: () => ({
        paths: this._opencodePaths(), adapter: this._publicACPStatus(this.opencodeProbeService.acp),
        ...this.opencodeProbeService.getConfigurationCatalog()
      }),
      setOpenCodePaths: (paths) => {
        this._setPreference(modules.Constants.PREFS.opencodeExecutablePath, String(paths?.opencodePath || "").trim());
        return this._opencodePaths();
      },
      inspectOpenCodeRuntime: () => runCodexAction("OpenCode inspection failed", async () => {
        try {
          const catalog = await this.agentsChatService.refreshAgentCatalog("opencode", { prepare: true });
          return { paths: this._opencodePaths(), adapter: this._publicACPStatus(this.opencodeProbeService.acp), ...catalog };
        }
        catch (error) {
          this._setPreference(modules.Constants.PREFS.opencodePreparedVersion, "");
          throw error;
        }
      }),
      defaults: Object.freeze({
        deepseekBaseURL: modules.Constants.PROVIDERS.deepseek.baseURL,
        deepseekModel: modules.Constants.PROVIDERS.deepseek.model,
        selectionPrompt: modules.Constants.DEFAULT_SELECTION_PROMPT,
        abstractPrompt: modules.Constants.DEFAULT_ABSTRACT_PROMPT
      })
    });
    Zotero.SmartPaperTranslator = this.bridge;
  },

  _getPreference(name) {
    return Zotero.Prefs.get(name, true);
  },

  _setPreference(name, value) {
    return Zotero.Prefs.set(name, value, true);
  },

  _sharedACPPaths() {
    const prefs = SmartPaperTranslatorModules.Constants.PREFS;
    return {
      nodePath: String(this._getPreference(prefs.codexNodePath) || "").trim(),
      npxCliPath: String(this._getPreference(prefs.codexNpxCliPath) || "").trim()
    };
  },

  _codexPaths() {
    const prefs = SmartPaperTranslatorModules.Constants.PREFS;
    return {
      ...this._sharedACPPaths(),
      codexPath: String(this._getPreference(prefs.codexExecutablePath) || "").trim()
    };
  },

  async _inspectCodex(paths) {
    const runtime = await SmartPaperTranslatorModules.ACP.inspectLocalRuntime(paths);
    runtime.versions.codexACP = this.acpClient.getStatus().preparedVersion;
    return runtime;
  },

  _opencodePaths() {
    return { opencodePath: String(this._getPreference(SmartPaperTranslatorModules.Constants.PREFS.opencodeExecutablePath) || "").trim() };
  },

  _piPaths() {
    const prefs = SmartPaperTranslatorModules.Constants.PREFS;
    return {
      ...this._sharedACPPaths(),
      piPath: String(this._getPreference(prefs.piExecutablePath) || "").trim()
    };
  },

  async _inspectPi(prepare) {
    const runtime = await SmartPaperTranslatorModules.ACP.inspectLocalRuntime(this._piPaths(), "pi");
    if (!runtime.healthy) throw new Error(runtime.lastError || "Pi runtime is unavailable");
    let catalog = this.piProbeService.getConfigurationCatalog();
    if (prepare || this.piProbeService.acp.getStatus().preparedVersion) {
      catalog = await this.agentsChatService.refreshPiCatalog({ prepare });
    }
    return { ...runtime, adapter: this._publicACPStatus(this.piProbeService.acp), ...catalog };
  },

  _publicACPStatus(client = this.acpClient) {
    const status = client.getStatus();
    const sanitize = (value) => {
      if (Array.isArray(value)) return value.map(sanitize);
      if (!value || typeof value !== "object") return value;
      const result = {};
      for (const [key, nested] of Object.entries(value)) {
        if (/(?:token|secret|credential|apiKey)/iu.test(key)) continue;
        result[key] = sanitize(nested);
      }
      return result;
    };
    return sanitize(status);
  },

  async _pickCodexPath(kind, parentWindow) {
    const title = { node: "Node", npx: "npx-cli.js", codex: "Codex", pi: "Pi", opencode: "OpenCode" }[kind];
    if (!title) throw new Error("未知路径类型");
    const { FilePicker } = ChromeUtils.importESModule("chrome://zotero/content/modules/filePicker.mjs");
    const picker = new FilePicker();
    picker.init(parentWindow || Zotero.getMainWindow(), title, picker.modeOpen);
    picker.appendFilters(picker.filterAll);
    const result = await picker.show();
    // The live preferences view commits the result after its own lifetime check.
    return result === picker.returnOK ? picker.file : "";
  },

  _observePreferences() {
    const prefs = SmartPaperTranslatorModules.Constants.PREFS;
    const names = [
      prefs.provider,
      prefs.deepseekBaseURL,
      prefs.deepseekModel,
      prefs.customBaseURL,
      prefs.customModel,
      prefs.targetLanguage,
      prefs.autoTranslateSelection,
      prefs.autoOpen,
      prefs.selectionPrompt,
      prefs.abstractPrompt,
      prefs.codexNodePath,
      prefs.codexNpxCliPath,
      prefs.codexExecutablePath,
      prefs.codexDefaultModel,
      prefs.codexDefaultReasoningEffort,
      prefs.codexDeveloperMode,
      prefs.piExecutablePath,
      prefs.piDefaultModel,
      prefs.piDefaultReasoningEffort,
      prefs.opencodeExecutablePath, prefs.opencodeDefaultModel, prefs.opencodeDefaultReasoningEffort
    ];
    for (const name of names) {
      const symbol = Zotero.Prefs.registerObserver(
        name,
        () => this._schedulePreferenceRefresh(),
        true
      );
      this.preferenceObservers.push(symbol);
    }
  },

  _schedulePreferenceRefresh() {
    if (this.preferenceRefreshTimer) clearTimeout(this.preferenceRefreshTimer);
    this.preferenceRefreshTimer = setTimeout(() => {
      this.preferenceRefreshTimer = null;
      this.readerUI?.onPreferencesChanged();
      this.itemTreeUI?.onPreferencesChanged();
      (this.agentsChatService || this.codexChatService)?.notifyDeveloperModeChanged();
      (this.agentsChatService || this.codexChatService)?.notifyDefaultConfigurationChanged();
    }, 150);
  },

  _observeItems() {
    this.notifierID = Zotero.Notifier.registerObserver(
      {
        notify: (event, type, ids) => {
          if (event !== "modify" || type !== "item") return;
          const flattened = ids.flat ? ids.flat(Infinity) : ids;
          this.readerUI?.refreshModifiedItems(flattened);
          this.itemTreeUI?.invalidateModifiedItems(flattened);
        }
      },
      ["item"],
      this.id
    );
  },

  addToAllWindows() {
    for (const win of Zotero.getMainWindows()) {
      if (win.ZoteroPane) this.addToWindow(win);
    }
  },

  addToWindow(win) {
    if (!this.initialized || !win?.ZoteroPane || this.windowStates.has(win)) return;
    const state = { cleanups: [] };
    this.windowStates.set(win, state);
    const removeItemTreeUI = this.itemTreeUI?.addToWindow(win);
    if (removeItemTreeUI) state.cleanups.push(removeItemTreeUI);
    const removeCodexChatUI = this.codexChatUI?.addToWindow(win);
    if (removeCodexChatUI) state.cleanups.push(removeCodexChatUI);
  },

  removeFromWindow(win) {
    const state = this.windowStates.get(win);
    if (!state) return;
    for (const cleanup of state.cleanups) {
      try {
        cleanup();
      }
      catch (error) {
        this.log("Window cleanup failed", error);
      }
    }
    this.windowStates.delete(win);
  },

  log(message, error) {
    Zotero.debug("Smart Paper Translator: " + message);
    if (error) Zotero.logError(error);
  },

  async shutdown() {
    if (!this.initialized) return;
    if (this.preferenceRefreshTimer) clearTimeout(this.preferenceRefreshTimer);
    this.preferenceRefreshTimer = null;
    this.readerUI?.shutdown();
    this.itemTreeUI?.shutdown();
    await this.codexChatUI?.shutdown().catch((error) => this.log("Codex UI shutdown failed", error));
    await (this.agentsChatService || this.codexChatService)?.shutdown().catch((error) => this.log("Codex shutdown failed", error));
    this.service?.shutdown();
    if (this.notifierID != null) Zotero.Notifier.unregisterObserver(this.notifierID);
    this.notifierID = null;
    for (const symbol of this.preferenceObservers) Zotero.Prefs.unregisterObserver(symbol);
    this.preferenceObservers = [];
    for (const win of Array.from(this.windowStates.keys())) this.removeFromWindow(win);
    if (Zotero.SmartPaperTranslator === this.bridge) delete Zotero.SmartPaperTranslator;
    this.bridge = null;
    this.initialized = false;
  }
};
