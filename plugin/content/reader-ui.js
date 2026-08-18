(function (global) {
  "use strict";

  const modules = global.SmartPaperTranslatorModules = global.SmartPaperTranslatorModules || {};
  const Constants = modules.Constants || (
    typeof require === "function" ? require("./constants.js") : null
  );
  const Logic = modules.Logic || (
    typeof require === "function" ? require("./logic.js") : null
  );

  function createElement(doc, tag, className, text) {
    const element = doc.createElement(tag);
    if (className) element.className = className;
    if (text != null) element.textContent = text;
    return element;
  }

  class ReaderUI {
    constructor({ service, getPreference, setPreference, rootURI, log } = {}) {
      this.service = service;
      this.getPreference = getPreference;
      this.setPreference = setPreference;
      this.rootURI = rootURI;
      this.log = log || (() => {});
      this.states = new Map();
      this.stylesheets = new Set();
      this.unsubscribeService = null;
      this.toolbarHandler = (event) => this.handleToolbar(event);
      this.selectionHandler = (event) => this.handleSelectionPopup(event);
    }

    init(pluginID) {
      global.Zotero.Reader.registerEventListener(
        "renderToolbar",
        this.toolbarHandler,
        pluginID
      );
      global.Zotero.Reader.registerEventListener(
        "renderTextSelectionPopup",
        this.selectionHandler,
        pluginID
      );
      this.unsubscribeService = this.service.subscribe((event) => this._handleServiceEvent(event));
    }

    _ensureStylesheet(doc) {
      let link = doc.querySelector('link[data-smart-paper-translator="reader-style"]');
      if (link) return link;
      link = doc.createElement("link");
      link.rel = "stylesheet";
      link.href = this.rootURI + "content/reader.css";
      link.dataset.smartPaperTranslator = "reader-style";
      (doc.head || doc.documentElement).append(link);
      this.stylesheets.add(link);
      return link;
    }

    _createPanel(doc, state) {
      const panel = createElement(doc, "aside", "spt-panel");
      panel.setAttribute("role", "complementary");
      panel.setAttribute("aria-label", "论文智译面板");

      const header = createElement(doc, "header", "spt-panel-header");
      header.title = "拖动面板";
      const heading = createElement(doc, "h2", "spt-panel-heading", "论文智译");
      const close = createElement(doc, "button", "spt-icon-button", "×");
      close.type = "button";
      close.title = "关闭悬浮窗";
      close.setAttribute("aria-label", "关闭论文智译悬浮窗");
      header.append(heading, close);

      const title = createElement(doc, "div", "spt-paper-title", "正在读取论文…");

      const abstractSection = createElement(doc, "section", "spt-section");
      const abstractHeading = createElement(doc, "h3", "spt-section-heading", "摘要译文");
      const abstractBody = createElement(doc, "div", "spt-summary spt-muted", "正在读取摘要…");
      abstractSection.append(abstractHeading, abstractBody);

      const glossarySection = createElement(doc, "section", "spt-section spt-glossary-section");
      const glossaryHeading = createElement(doc, "h3", "spt-section-heading");
      const glossaryLabel = createElement(doc, "span", "", "已译术语");
      const glossaryCount = createElement(doc, "span", "spt-count", "0");
      glossaryHeading.append(glossaryLabel, glossaryCount);
      const glossaryBody = createElement(doc, "div", "spt-glossary spt-muted", "尚无已翻译术语");
      glossarySection.append(glossaryHeading, glossaryBody);

      panel.append(header, title, abstractSection, glossarySection);
      state.panel = panel;
      state.panelHeader = header;
      state.closeButton = close;
      state.titleNode = title;
      state.summaryNode = abstractBody;
      state.glossaryNode = glossaryBody;
      state.glossaryCountNode = glossaryCount;
      return panel;
    }

    _createToolbarRoot(doc, state) {
      const root = createElement(doc, "div", "spt-toolbar-root");
      const button = createElement(doc, "button", "toolbar-button spt-toolbar-button");
      button.type = "button";
      button.tabIndex = -1;
      button.title = "显示或隐藏论文智译";
      button.setAttribute("aria-label", "显示或隐藏论文智译悬浮窗");
      const icon = createElement(doc, "span", "spt-toolbar-icon", "译");
      icon.setAttribute("aria-hidden", "true");
      button.append(icon);
      root.append(button, this._createPanel(doc, state));
      state.root = root;
      state.toolbarButton = button;
      return root;
    }

    handleToolbar({ reader, doc, append }) {
      let state = this.states.get(reader);
      if (!state) {
        state = {
          reader,
          dismissed: false,
          manualOpen: false,
          requestSerial: 0,
          itemID: reader.itemID,
          paperStorageKey: null,
          attachmentID: null,
          parentItemID: null,
          domCleanups: [],
          destroyed: false
        };
        this.states.set(reader, state);
      }
      else {
        const documentChanged = state.doc && state.doc !== doc;
        const previousStylesheet = state.stylesheet;
        this._disposeDOM(state);
        if (documentChanged && previousStylesheet) {
          previousStylesheet.remove();
          this.stylesheets.delete(previousStylesheet);
        }
        state.destroyed = false;
        state.itemID = reader.itemID;
      }

      state.doc = doc;
      state.stylesheet = this._ensureStylesheet(doc);
      const root = this._createToolbarRoot(doc, state);
      append(root);
      this._bindPanelEvents(state);
      this._applyStoredPosition(state);
      this._updateVisibility(state);
      this.refreshState(state);
    }

    _bindPanelEvents(state) {
      const { doc, panelHeader, closeButton, toolbarButton } = state;
      const toggle = () => {
        const visible = !state.panel.hidden;
        if (visible) {
          state.dismissed = true;
          state.manualOpen = false;
        }
        else {
          state.dismissed = false;
          state.manualOpen = true;
        }
        this._updateVisibility(state);
        if (!visible) this.refreshState(state);
      };
      const close = () => {
        state.dismissed = true;
        state.manualOpen = false;
        state.requestSerial++;
        this._updateVisibility(state);
      };
      toolbarButton.addEventListener("click", toggle);
      closeButton.addEventListener("click", close);
      state.domCleanups.push(
        () => toolbarButton.removeEventListener("click", toggle),
        () => closeButton.removeEventListener("click", close)
      );

      const onMouseDown = (event) => {
        if (event.button !== 0 || event.target.closest("button")) return;
        event.preventDefault();
        const rect = state.panel.getBoundingClientRect();
        const startX = event.clientX;
        const startY = event.clientY;
        const originX = rect.left;
        const originY = rect.top;
        state.panel.classList.add("spt-dragging");

        const onMove = (moveEvent) => {
          const width = state.panel.offsetWidth || 360;
          const height = state.panel.offsetHeight || 300;
          const viewportWidth = doc.documentElement.clientWidth;
          const viewportHeight = doc.documentElement.clientHeight;
          const left = Math.max(8, Math.min(viewportWidth - width - 8, originX + moveEvent.clientX - startX));
          const top = Math.max(49, Math.min(viewportHeight - Math.min(height, 120) - 8, originY + moveEvent.clientY - startY));
          state.panel.style.left = `${Math.round(left)}px`;
          state.panel.style.top = `${Math.round(top)}px`;
          state.panel.style.right = "auto";
        };
        const onUp = () => {
          state.panel.classList.remove("spt-dragging");
          doc.removeEventListener("mousemove", onMove);
          doc.removeEventListener("mouseup", onUp);
          const rectNow = state.panel.getBoundingClientRect();
          this.setPreference(Constants.PREFS.panelX, Math.round(rectNow.left));
          this.setPreference(Constants.PREFS.panelY, Math.round(rectNow.top));
        };
        doc.addEventListener("mousemove", onMove);
        doc.addEventListener("mouseup", onUp);
      };
      panelHeader.addEventListener("mousedown", onMouseDown);
      state.domCleanups.push(() => panelHeader.removeEventListener("mousedown", onMouseDown));

      const onResize = () => this._clampPanel(state);
      doc.defaultView?.addEventListener("resize", onResize);
      state.domCleanups.push(() => doc.defaultView?.removeEventListener("resize", onResize));

      const onUnload = () => {
        state.destroyed = true;
        this._disposeDOM(state);
        state.stylesheet?.remove();
        this.stylesheets.delete(state.stylesheet);
        state.stylesheet = null;
        this.states.delete(state.reader);
      };
      doc.defaultView?.addEventListener("unload", onUnload, { once: true });
      state.domCleanups.push(() => doc.defaultView?.removeEventListener("unload", onUnload));
    }

    _applyStoredPosition(state) {
      const x = Number(this.getPreference(Constants.PREFS.panelX));
      const y = Number(this.getPreference(Constants.PREFS.panelY));
      if (Number.isFinite(x) && x >= 0) {
        state.panel.style.left = `${x}px`;
        state.panel.style.right = "auto";
      }
      else {
        state.panel.style.left = "auto";
        state.panel.style.right = "16px";
      }
      state.panel.style.top = `${Number.isFinite(y) ? Math.max(49, y) : 56}px`;
      global.setTimeout?.(() => this._clampPanel(state), 0);
    }

    _clampPanel(state) {
      if (!state.panel?.isConnected || state.panel.hidden) return;
      const rect = state.panel.getBoundingClientRect();
      const viewportWidth = state.doc.documentElement.clientWidth;
      const viewportHeight = state.doc.documentElement.clientHeight;
      const left = Math.max(8, Math.min(viewportWidth - rect.width - 8, rect.left));
      const top = Math.max(49, Math.min(viewportHeight - Math.min(rect.height, 120) - 8, rect.top));
      state.panel.style.left = `${Math.round(left)}px`;
      state.panel.style.top = `${Math.round(top)}px`;
      state.panel.style.right = "auto";
    }

    _updateVisibility(state) {
      if (!state.panel || !state.toolbarButton) return;
      const autoOpen = Boolean(this.getPreference(Constants.PREFS.autoOpen));
      const visible = !state.dismissed && (autoOpen || state.manualOpen);
      state.panel.hidden = !visible;
      state.toolbarButton.classList.toggle("active", visible);
      state.toolbarButton.setAttribute("aria-pressed", String(visible));
      if (visible) this._clampPanel(state);
    }

    _setSummary(state, text, kind = "normal") {
      if (!state.summaryNode) return;
      state.summaryNode.textContent = text;
      state.summaryNode.classList.toggle("spt-muted", kind === "muted");
      state.summaryNode.classList.toggle("spt-error", kind === "error");
    }

    _renderGlossary(state, entries) {
      if (!state.glossaryNode) return;
      state.glossaryCountNode.textContent = String(entries.length);
      state.glossaryNode.replaceChildren();
      state.glossaryNode.classList.toggle("spt-muted", entries.length === 0);
      if (!entries.length) {
        state.glossaryNode.textContent = "尚无已翻译术语";
        return;
      }
      const list = createElement(state.doc, "dl", "spt-term-list");
      for (const entry of entries) {
        const row = createElement(state.doc, "div", "spt-term-row");
        const term = createElement(state.doc, "dt", "spt-term-source", entry.source);
        const translation = createElement(state.doc, "dd", "spt-term-translation", entry.translation);
        row.append(term, translation);
        list.append(row);
      }
      state.glossaryNode.append(list);
    }

    refreshState(state) {
      if (!state || state.destroyed) return;
      const itemID = state.reader.itemID;
      state.itemID = itemID;
      const serial = ++state.requestSerial;
      state.titleNode.textContent = "正在读取论文…";
      this._setSummary(state, "正在翻译或读取摘要缓存…", "muted");

      this.service.getGlossaryForItem(itemID).then(({ paper, entries }) => {
        if (!Logic.isRenderCurrent(state, serial, itemID)) return;
        state.paperStorageKey = paper.storageKey;
        state.attachmentID = paper.attachmentID;
        state.parentItemID = paper.parentItemID;
        state.titleNode.textContent = paper.title;
        this._renderGlossary(state, entries);
      }).catch((error) => {
        if (!Logic.isRenderCurrent(state, serial, itemID)) return;
        this.log("读取术语缓存失败", error);
        this._renderGlossary(state, []);
      });

      this.service.ensureAbstract(itemID).then((result) => {
        if (!Logic.isRenderCurrent(state, serial, itemID)) return;
        state.paperStorageKey = result.paper.storageKey;
        state.attachmentID = result.paper.attachmentID;
        state.parentItemID = result.paper.parentItemID;
        state.titleNode.textContent = result.paper.title;
        if (result.status === "missing") {
          this._setSummary(state, "摘要缺失：Zotero 父条目未提供摘要，插件不会猜测或生成摘要。", "muted");
        }
        else {
          this._setSummary(
            state,
            result.translation + (result.fromCache ? "\n\n（来自缓存）" : "")
          );
        }
      }).catch((error) => {
        if (!Logic.isRenderCurrent(state, serial, itemID)) return;
        this.log("摘要翻译失败", error);
        this._setSummary(state, error.message || "摘要翻译失败", "error");
      });
    }

    async _refreshGlossaryForState(state) {
      const itemID = state.itemID;
      const serial = state.requestSerial;
      try {
        const { paper, entries } = await this.service.getGlossaryForItem(itemID);
        if (!Logic.isRenderCurrent(state, serial, itemID)) return;
        state.paperStorageKey = paper.storageKey;
        this._renderGlossary(state, entries);
      }
      catch (error) {
        this.log("刷新术语列表失败", error);
      }
    }

    _handleServiceEvent(event) {
      if (event.type !== "translation") return;
      for (const state of this.states.values()) {
        const samePaper = state.paperStorageKey === event.paper.storageKey ||
          state.itemID === event.paper.attachmentID;
        if (state.destroyed || !samePaper) continue;
        // Abstract rendering is owned by refreshState's request serial guard. Handling
        // abstract events here would let an older request bypass that guard.
        if (event.entry.kind === "selection" && event.entry.isTerm) {
          this._refreshGlossaryForState(state);
        }
      }
    }

    handleSelectionPopup({ reader, doc, params, append }) {
      this._ensureStylesheet(doc);
      const container = createElement(doc, "div", "spt-selection-translation");
      const button = createElement(doc, "button", "spt-translate-button", "翻译");
      button.type = "button";
      button.setAttribute("aria-label", "翻译选中文本");
      const status = createElement(doc, "div", "spt-selection-status");
      status.setAttribute("role", "status");
      const resultNode = createElement(doc, "div", "spt-selection-result");
      const text = String(params?.annotation?.text || "").trim();
      if (!text) button.disabled = true;
      container.append(button, status, resultNode);
      append(container);

      button.addEventListener("click", async () => {
        if (button.disabled) return;
        button.disabled = true;
        status.textContent = "翻译中…";
        resultNode.textContent = "";
        const itemID = reader.itemID;
        const pageIndex = params?.annotation?.position?.pageIndex;
        const pageNumber = Number.isInteger(pageIndex) ? pageIndex + 1 : null;
        try {
          const result = await this.service.translateSelection(itemID, text, pageNumber);
          if (!container.isConnected || reader.itemID !== itemID) return;
          status.textContent = result.fromCache ? "来自缓存" : "翻译完成";
          resultNode.textContent = result.translation;
        }
        catch (error) {
          if (!container.isConnected || reader.itemID !== itemID) return;
          status.textContent = "翻译失败";
          resultNode.textContent = error.message || "无法翻译所选内容";
          resultNode.classList.add("spt-error");
          button.disabled = false;
          button.textContent = "重试";
        }
      });
    }

    onPreferencesChanged() {
      for (const state of this.states.values()) {
        if (state.destroyed) continue;
        if (!this.getPreference(Constants.PREFS.autoOpen) && !state.manualOpen) {
          state.panel.hidden = true;
        }
        this._updateVisibility(state);
        this.refreshState(state);
      }
    }

    refreshModifiedItems(itemIDs) {
      const ids = new Set(itemIDs.map(Number).filter(Number.isFinite));
      for (const state of this.states.values()) {
        if (ids.has(state.attachmentID) || ids.has(state.parentItemID)) this.refreshState(state);
      }
    }

    _disposeDOM(state) {
      state.requestSerial++;
      for (const cleanup of state.domCleanups || []) {
        try {
          cleanup();
        }
        catch (_error) {}
      }
      state.domCleanups = [];
      state.root?.remove();
      state.root = null;
      state.panel = null;
      state.toolbarButton = null;
    }

    shutdown() {
      this.unsubscribeService?.();
      this.unsubscribeService = null;
      for (const state of this.states.values()) {
        state.destroyed = true;
        this._disposeDOM(state);
      }
      this.states.clear();
      for (const stylesheet of this.stylesheets) stylesheet.remove();
      this.stylesheets.clear();
      // Reader listeners are registered with pluginID and Zotero removes them during plugin shutdown.
    }
  }

  modules.ReaderUI = { ReaderUI, createElement };
  if (typeof module !== "undefined" && module.exports) module.exports = { ReaderUI, createElement };
})(typeof globalThis !== "undefined" ? globalThis : this);
