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

  function createSVGElement(doc, tag, attributes = {}) {
    const element = doc.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [name, value] of Object.entries(attributes)) {
      element.setAttribute(name, value);
    }
    return element;
  }

  function createTranslationIcon(doc, className = "spt-toolbar-icon") {
    const icon = createSVGElement(doc, "svg", {
      class: className,
      viewBox: "0 0 20 20",
      fill: "none",
      "aria-hidden": "true"
    });
    icon.append(
      createSVGElement(doc, "path", {
        d: "M3.25 3.5h8.5v7H7.4l-2.65 2.25V10.5h-1.5z",
        stroke: "currentColor",
        "stroke-width": "1.4",
        "stroke-linejoin": "round"
      }),
      createSVGElement(doc, "path", {
        d: "M8.25 7.75h8.5v7H15.2v2l-2.55-2h-4.4z",
        stroke: "currentColor",
        "stroke-width": "1.4",
        "stroke-linejoin": "round"
      }),
      createSVGElement(doc, "path", {
        d: "M5.4 6.1h4.1M12.05 11.35h2.9",
        stroke: "currentColor",
        "stroke-width": "1.4",
        "stroke-linecap": "round"
      })
    );
    return icon;
  }

  function createCloseIcon(doc) {
    const icon = createSVGElement(doc, "svg", {
      class: "spt-close-icon",
      viewBox: "0 0 16 16",
      fill: "none",
      "aria-hidden": "true"
    });
    icon.append(createSVGElement(doc, "path", {
      d: "m4 4 8 8m0-8-8 8",
      stroke: "currentColor",
      "stroke-width": "1.5",
      "stroke-linecap": "round"
    }));
    return icon;
  }

  function createCacheTag(doc, extraClass = "") {
    const className = ["spt-status-tag", "spt-cache-tag", extraClass]
      .filter(Boolean)
      .join(" ");
    const tag = createElement(doc, "span", className, "缓存");
    tag.hidden = true;
    tag.setAttribute("aria-label", "内容来自本地缓存");
    return tag;
  }

  class ReaderUI {
    constructor({ service, getPreference, setPreference, stylesheetText, log } = {}) {
      this.service = service;
      this.getPreference = getPreference;
      this.setPreference = setPreference;
      this.stylesheetText = stylesheetText || "";
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
      let style = doc.querySelector('style[data-smart-paper-translator="reader-style"]');
      if (style) return style;
      style = doc.createElement("style");
      style.dataset.smartPaperTranslator = "reader-style";
      style.textContent = this.stylesheetText;
      (doc.head || doc.documentElement).append(style);
      this.stylesheets.add(style);
      return style;
    }

    _createPanel(doc, state) {
      const panel = createElement(doc, "aside", "spt-panel");
      panel.setAttribute("role", "complementary");
      panel.setAttribute("aria-label", "论文智译面板");

      const header = createElement(doc, "header", "spt-panel-header");
      header.title = "拖动面板";
      const brand = createElement(doc, "div", "spt-panel-brand");
      const brandMark = createElement(doc, "span", "spt-brand-mark");
      brandMark.append(createTranslationIcon(doc, "spt-brand-icon"));
      const headingGroup = createElement(doc, "div", "spt-panel-heading-group");
      const heading = createElement(doc, "h2", "spt-panel-heading", "论文智译");
      const subheading = createElement(doc, "div", "spt-panel-subheading", "摘要与术语");
      headingGroup.append(heading, subheading);
      brand.append(brandMark, headingGroup);
      const close = createElement(doc, "button", "spt-icon-button");
      close.type = "button";
      close.title = "关闭悬浮窗";
      close.setAttribute("aria-label", "关闭论文智译悬浮窗");
      close.append(createCloseIcon(doc));
      header.append(brand, close);

      const panelBody = createElement(doc, "div", "spt-panel-body");
      const paperMeta = createElement(doc, "div", "spt-paper-meta");
      const paperLabel = createElement(doc, "div", "spt-paper-label", "当前论文");
      const title = createElement(doc, "div", "spt-paper-title", "正在读取论文…");
      paperMeta.append(paperLabel, title);

      const tabList = createElement(doc, "div", "spt-tab-list");
      tabList.setAttribute("role", "tablist");
      tabList.setAttribute("aria-label", "翻译内容");
      const summaryTab = createElement(doc, "button", "spt-tab", "摘要译文");
      summaryTab.type = "button";
      summaryTab.id = "smart-paper-translator-summary-tab";
      summaryTab.setAttribute("role", "tab");
      summaryTab.setAttribute("aria-controls", "smart-paper-translator-summary-panel");
      const glossaryTab = createElement(doc, "button", "spt-tab");
      glossaryTab.type = "button";
      glossaryTab.id = "smart-paper-translator-glossary-tab";
      glossaryTab.setAttribute("role", "tab");
      glossaryTab.setAttribute("aria-controls", "smart-paper-translator-glossary-panel");
      const glossaryLabel = createElement(doc, "span", "", "术语");
      const glossaryCount = createElement(doc, "span", "spt-tab-count", "0");
      glossaryTab.append(glossaryLabel, glossaryCount);
      tabList.append(summaryTab, glossaryTab);

      const tabContent = createElement(doc, "div", "spt-tab-content");
      const abstractSection = createElement(doc, "section", "spt-tab-panel");
      abstractSection.id = "smart-paper-translator-summary-panel";
      abstractSection.setAttribute("role", "tabpanel");
      abstractSection.setAttribute("aria-labelledby", summaryTab.id);
      abstractSection.tabIndex = 0;
      const summaryCacheTag = createCacheTag(doc, "spt-summary-cache-tag");
      const abstractBody = createElement(doc, "div", "spt-summary spt-muted", "正在读取摘要…");
      abstractSection.append(summaryCacheTag, abstractBody);

      const glossarySection = createElement(doc, "section", "spt-tab-panel");
      glossarySection.id = "smart-paper-translator-glossary-panel";
      glossarySection.setAttribute("role", "tabpanel");
      glossarySection.setAttribute("aria-labelledby", glossaryTab.id);
      glossarySection.tabIndex = 0;
      const glossaryBody = createElement(doc, "div", "spt-glossary spt-muted", "尚无已翻译术语");
      glossarySection.append(glossaryBody);

      tabContent.append(abstractSection, glossarySection);
      panelBody.append(paperMeta, tabList, tabContent);
      const resizeHandle = createElement(doc, "button", "spt-resize-handle");
      resizeHandle.type = "button";
      resizeHandle.title = "拖动或使用方向键调整悬浮窗大小";
      resizeHandle.setAttribute("aria-label", "调整论文智译悬浮窗大小");
      panel.append(header, panelBody, resizeHandle);
      state.panel = panel;
      state.panelHeader = header;
      state.closeButton = close;
      state.resizeHandle = resizeHandle;
      state.titleNode = title;
      state.summaryNode = abstractBody;
      state.summaryCacheTag = summaryCacheTag;
      state.glossaryNode = glossaryBody;
      state.glossaryCountNode = glossaryCount;
      state.tabButtons = { summary: summaryTab, glossary: glossaryTab };
      state.tabPanels = { summary: abstractSection, glossary: glossarySection };
      this._setActiveTab(state, state.activeTab || "summary");
      return panel;
    }

    _setActiveTab(state, tabName, { focus = false } = {}) {
      const selected = tabName === "glossary" ? "glossary" : "summary";
      state.activeTab = selected;
      for (const name of ["summary", "glossary"]) {
        const active = name === selected;
        const button = state.tabButtons?.[name];
        const panel = state.tabPanels?.[name];
        if (button) {
          button.setAttribute("aria-selected", String(active));
          button.tabIndex = active ? 0 : -1;
        }
        if (panel) panel.hidden = !active;
      }
      if (focus) state.tabButtons?.[selected]?.focus?.();
    }

    _createToolbarButton(doc, state) {
      const button = createElement(doc, "button", "toolbar-button spt-toolbar-button");
      button.type = "button";
      button.tabIndex = -1;
      button.title = "显示或隐藏论文智译";
      button.setAttribute("aria-label", "显示或隐藏论文智译悬浮窗");
      button.setAttribute("aria-controls", "smart-paper-translator-panel");
      button.append(createTranslationIcon(doc));
      state.toolbarButton = button;
      return button;
    }

    _mountPanel(doc, state) {
      const panel = this._createPanel(doc, state);
      panel.id = "smart-paper-translator-panel";
      (doc.body || doc.documentElement).append(panel);
      return panel;
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
          activeTab: "summary",
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
      const toolbarButton = this._createToolbarButton(doc, state);
      append(toolbarButton);
      this._mountPanel(doc, state);
      this._bindPanelEvents(state);
      this._applyStoredGeometry(state);
      this._updateVisibility(state);
      this.refreshState(state);
    }

    _bindPanelEvents(state) {
      const {
        doc,
        panelHeader,
        closeButton,
        resizeHandle,
        toolbarButton,
        tabButtons
      } = state;
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
        toolbarButton.focus?.();
      };
      toolbarButton.addEventListener("click", toggle);
      closeButton.addEventListener("click", close);
      state.domCleanups.push(
        () => toolbarButton.removeEventListener("click", toggle),
        () => closeButton.removeEventListener("click", close)
      );

      const selectSummary = () => this._setActiveTab(state, "summary");
      const selectGlossary = () => this._setActiveTab(state, "glossary");
      const onTabKeyDown = (event) => {
        let nextTab = null;
        if (event.key === "Home") {
          nextTab = "summary";
        }
        else if (event.key === "End") {
          nextTab = "glossary";
        }
        else if (["ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown"].includes(event.key)) {
          nextTab = event.currentTarget === tabButtons.summary ? "glossary" : "summary";
        }
        if (!nextTab) return;
        event.preventDefault();
        this._setActiveTab(state, nextTab, { focus: true });
      };
      tabButtons.summary.addEventListener("click", selectSummary);
      tabButtons.glossary.addEventListener("click", selectGlossary);
      tabButtons.summary.addEventListener("keydown", onTabKeyDown);
      tabButtons.glossary.addEventListener("keydown", onTabKeyDown);
      state.domCleanups.push(
        () => tabButtons.summary.removeEventListener("click", selectSummary),
        () => tabButtons.glossary.removeEventListener("click", selectGlossary),
        () => tabButtons.summary.removeEventListener("keydown", onTabKeyDown),
        () => tabButtons.glossary.removeEventListener("keydown", onTabKeyDown)
      );

      const finishDrag = (event, persist) => {
        const drag = state.activeDrag;
        if (!drag || (event && event.pointerId !== drag.pointerId)) return;
        state.activeDrag = null;
        state.panel.classList.remove("spt-dragging");
        try {
          panelHeader.releasePointerCapture?.(drag.pointerId);
        }
        catch (_error) {}
        if (!persist || !state.panel?.isConnected) return;
        const rectNow = state.panel.getBoundingClientRect();
        this.setPreference(Constants.PREFS.panelX, Math.round(rectNow.left));
        this.setPreference(Constants.PREFS.panelY, Math.round(rectNow.top));
      };
      const finishResize = (event, persist) => {
        const resize = state.activeResize;
        if (!resize || (event && event.pointerId !== resize.pointerId)) return;
        state.activeResize = null;
        state.panel.classList.remove("spt-resizing");
        try {
          resizeHandle.releasePointerCapture?.(resize.pointerId);
        }
        catch (_error) {}
        if (persist && state.panel?.isConnected) this._persistPanelSize(state);
      };
      const onPointerDown = (event) => {
        if (event.button !== 0 || event.target.closest?.("button")) return;
        event.preventDefault();
        const rect = state.panel.getBoundingClientRect();
        state.activeDrag = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          originX: rect.left,
          originY: rect.top
        };
        state.panel.classList.add("spt-dragging");
        try {
          panelHeader.setPointerCapture?.(event.pointerId);
        }
        catch (_error) {}
      };
      const onResizePointerDown = (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation?.();
        const rect = state.panel.getBoundingClientRect();
        state.activeResize = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          originWidth: rect.width,
          originHeight: rect.height
        };
        state.panel.classList.add("spt-resizing");
        try {
          resizeHandle.setPointerCapture?.(event.pointerId);
        }
        catch (_error) {}
      };
      const onPointerMove = (event) => {
        const resize = state.activeResize;
        if (resize && event.pointerId === resize.pointerId) {
          this._setPanelSize(
            state,
            resize.originWidth + event.clientX - resize.startX,
            resize.originHeight + event.clientY - resize.startY
          );
          this._clampPanel(state, { keepFullyVisible: true });
          return;
        }
        const drag = state.activeDrag;
        if (!drag || event.pointerId !== drag.pointerId) return;
        this._setPanelPosition(
          state,
          drag.originX + event.clientX - drag.startX,
          drag.originY + event.clientY - drag.startY
        );
      };
      const onPointerUp = (event) => {
        finishDrag(event, true);
        finishResize(event, true);
      };
      const onPointerCancel = (event) => {
        finishDrag(event, false);
        finishResize(event, false);
      };
      const onResizeKeyDown = (event) => {
        const increments = {
          ArrowLeft: [-1, 0],
          ArrowRight: [1, 0],
          ArrowUp: [0, -1],
          ArrowDown: [0, 1]
        };
        const direction = increments[event.key];
        if (!direction) return;
        event.preventDefault();
        const step = event.shiftKey ? 32 : 16;
        const rect = state.panel.getBoundingClientRect();
        this._setPanelSize(
          state,
          rect.width + direction[0] * step,
          rect.height + direction[1] * step
        );
        this._clampPanel(state, { keepFullyVisible: true });
        this._persistPanelSize(state);
      };
      panelHeader.addEventListener("pointerdown", onPointerDown);
      resizeHandle.addEventListener("pointerdown", onResizePointerDown);
      resizeHandle.addEventListener("keydown", onResizeKeyDown);
      doc.addEventListener("pointermove", onPointerMove);
      doc.addEventListener("pointerup", onPointerUp);
      doc.addEventListener("pointercancel", onPointerCancel);
      state.domCleanups.push(
        () => finishDrag(null, false),
        () => finishResize(null, false),
        () => panelHeader.removeEventListener("pointerdown", onPointerDown),
        () => resizeHandle.removeEventListener("pointerdown", onResizePointerDown),
        () => resizeHandle.removeEventListener("keydown", onResizeKeyDown),
        () => doc.removeEventListener("pointermove", onPointerMove),
        () => doc.removeEventListener("pointerup", onPointerUp),
        () => doc.removeEventListener("pointercancel", onPointerCancel)
      );

      const onResize = () => this._clampPanel(state, { keepFullyVisible: true });
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

    _applyStoredGeometry(state) {
      const x = Number(this.getPreference(Constants.PREFS.panelX));
      const y = Number(this.getPreference(Constants.PREFS.panelY));
      const width = Number(this.getPreference(Constants.PREFS.panelWidth));
      const height = Number(this.getPreference(Constants.PREFS.panelHeight));
      const rect = state.panel.getBoundingClientRect();
      this._setPanelSize(
        state,
        Number.isFinite(width) && width > 0 ? width : rect.width,
        Number.isFinite(height) && height > 0 ? height : rect.height
      );
      if (Number.isFinite(x) && x >= 0) {
        state.panel.style.left = `${x}px`;
        state.panel.style.right = "auto";
      }
      else {
        state.panel.style.left = "auto";
        state.panel.style.right = "16px";
      }
      state.panel.style.top = `${Number.isFinite(y) ? Math.max(8, y) : 56}px`;
      global.setTimeout?.(() => this._clampPanel(state, { keepFullyVisible: true }), 0);
    }

    _setPanelSize(state, requestedWidth, requestedHeight) {
      const viewportWidth = state.doc.documentElement.clientWidth;
      const viewportHeight = state.doc.documentElement.clientHeight;
      const maxWidth = Math.max(160, viewportWidth - 16);
      const maxHeight = Math.max(160, viewportHeight - 16);
      const minWidth = Math.min(280, maxWidth);
      const minHeight = Math.min(240, maxHeight);
      const rect = state.panel.getBoundingClientRect();
      const width = Math.max(
        minWidth,
        Math.min(maxWidth, Number.isFinite(requestedWidth) ? requestedWidth : rect.width)
      );
      const height = Math.max(
        minHeight,
        Math.min(maxHeight, Number.isFinite(requestedHeight) ? requestedHeight : rect.height)
      );
      state.panel.style.width = `${Math.round(width)}px`;
      state.panel.style.height = `${Math.round(height)}px`;
    }

    _persistPanelSize(state) {
      const rect = state.panel.getBoundingClientRect();
      this.setPreference(Constants.PREFS.panelWidth, Math.round(rect.width));
      this.setPreference(Constants.PREFS.panelHeight, Math.round(rect.height));
    }

    _setPanelPosition(state, requestedLeft, requestedTop) {
      const panelWidth = state.panel.getBoundingClientRect().width || state.panel.offsetWidth || 390;
      const headerHeight = state.panelHeader?.offsetHeight || 52;
      const viewportWidth = state.doc.documentElement.clientWidth;
      const viewportHeight = state.doc.documentElement.clientHeight;
      const left = Math.max(8, Math.min(viewportWidth - panelWidth - 8, requestedLeft));
      const top = Math.max(8, Math.min(viewportHeight - headerHeight - 8, requestedTop));
      state.panel.style.left = `${Math.round(left)}px`;
      state.panel.style.top = `${Math.round(top)}px`;
      state.panel.style.right = "auto";
    }

    _clampPanel(state, { keepFullyVisible = false } = {}) {
      if (!state.panel?.isConnected || state.panel.hidden) return;
      const rect = state.panel.getBoundingClientRect();
      this._setPanelSize(state, rect.width, rect.height);
      const resizedRect = state.panel.getBoundingClientRect();
      const maxFullTop = state.doc.documentElement.clientHeight - resizedRect.height - 8;
      const top = keepFullyVisible ? Math.min(resizedRect.top, maxFullTop) : resizedRect.top;
      this._setPanelPosition(state, resizedRect.left, top);
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

    _setSummary(state, text, kind = "normal", { fromCache = false } = {}) {
      if (!state.summaryNode) return;
      state.summaryNode.textContent = text;
      state.summaryNode.classList.toggle("spt-muted", kind === "muted");
      state.summaryNode.classList.toggle("spt-error", kind === "error");
      if (state.summaryCacheTag) state.summaryCacheTag.hidden = !fromCache;
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

      if (typeof this.service.ensureSmartTags === "function") {
        this.service.ensureSmartTags(itemID).catch((error) => {
          if (!Logic.isRenderCurrent(state, serial, itemID)) return;
          this.log("智能标签生成失败", error);
        });
      }

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
          this._setSummary(state, result.translation, "normal", {
            fromCache: result.fromCache
          });
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
      const cacheTag = createCacheTag(doc, "spt-selection-cache-tag");
      const status = createElement(doc, "div", "spt-selection-status");
      status.setAttribute("role", "status");
      const resultNode = createElement(doc, "div", "spt-selection-result");
      const text = String(params?.annotation?.text || "").trim();
      const itemID = reader.itemID;
      const pageIndex = params?.annotation?.position?.pageIndex;
      const pageNumber = Number.isInteger(pageIndex) ? pageIndex + 1 : null;
      button.disabled = true;
      if (text) status.textContent = "检查本地缓存…";
      container.append(button, cacheTag, status, resultNode);
      append(container);

      const isCurrent = () => container.isConnected && reader.itemID === itemID;
      const renderTranslation = (result) => {
        const fromCache = Boolean(result.fromCache);
        cacheTag.hidden = !fromCache;
        status.textContent = fromCache ? "" : "翻译完成";
        resultNode.classList.remove("spt-error");
        resultNode.textContent = result.translation;
        button.disabled = true;
        button.hidden = fromCache;
      };

      if (text) {
        Promise.resolve(this.service.getCachedSelection(itemID, text, pageNumber)).then((cached) => {
          if (!isCurrent()) return;
          if (cached) {
            renderTranslation(cached);
            return;
          }
          status.textContent = "";
          button.disabled = false;
        }).catch((error) => {
          if (!isCurrent()) return;
          this.log("检查划线翻译缓存失败", error);
          status.textContent = "";
          button.disabled = false;
        });
      }

      button.addEventListener("click", async () => {
        if (button.disabled || button.hidden) return;
        button.disabled = true;
        cacheTag.hidden = true;
        status.textContent = "翻译中…";
        resultNode.textContent = "";
        try {
          const result = await this.service.translateSelection(itemID, text, pageNumber);
          if (!isCurrent()) return;
          renderTranslation(result);
        }
        catch (error) {
          if (!isCurrent()) return;
          cacheTag.hidden = true;
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
      state.toolbarButton?.remove();
      state.panel?.remove();
      state.activeDrag = null;
      state.activeResize = null;
      state.panelHeader = null;
      state.closeButton = null;
      state.resizeHandle = null;
      state.summaryCacheTag = null;
      state.tabButtons = null;
      state.tabPanels = null;
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
