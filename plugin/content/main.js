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
    const getPreference = (name) => Zotero.Prefs.get(name, true);
    const setPreference = (name, value) => Zotero.Prefs.set(name, value, true);
    const readerStylesheet = await Zotero.File.getResourceAsync(
      rootURI + "content/reader.css"
    );

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
      stylesheetText: readerStylesheet,
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
    this.readerUI.init(id);
    this.initialized = true;
    this.log(`Started ${version}`);
  },

  _installPreferenceBridge() {
    const modules = SmartPaperTranslatorModules;
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
      defaults: Object.freeze({
        deepseekBaseURL: modules.Constants.PROVIDERS.deepseek.baseURL,
        deepseekModel: modules.Constants.PROVIDERS.deepseek.model,
        selectionPrompt: modules.Constants.DEFAULT_SELECTION_PROMPT,
        abstractPrompt: modules.Constants.DEFAULT_ABSTRACT_PROMPT
      })
    });
    Zotero.SmartPaperTranslator = this.bridge;
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
      prefs.autoOpen,
      prefs.selectionPrompt,
      prefs.abstractPrompt
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
    }, 150);
  },

  _observeItems() {
    this.notifierID = Zotero.Notifier.registerObserver(
      {
        notify: (event, type, ids) => {
          if (event !== "modify" || type !== "item") return;
          const flattened = ids.flat ? ids.flat(Infinity) : ids;
          this.readerUI?.refreshModifiedItems(flattened);
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
    this.windowStates.set(win, { cleanups: [] });
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

  shutdown() {
    if (!this.initialized) return;
    if (this.preferenceRefreshTimer) clearTimeout(this.preferenceRefreshTimer);
    this.preferenceRefreshTimer = null;
    this.readerUI?.shutdown();
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
