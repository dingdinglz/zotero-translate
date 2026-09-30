(function (global) {
  "use strict";

  const modules = global.SmartPaperTranslatorModules = global.SmartPaperTranslatorModules || {};
  const Constants = modules.Constants || (
    typeof require === "function" ? require("./constants.js") : null
  );
  const Logic = modules.Logic || (
    typeof require === "function" ? require("./logic.js") : null
  );
  const TAG_RESULTS_PAGE_SIZE = 50;
  const TAG_READ_BATCH_SIZE = 8;

  function tagMatchKey(tag) {
    return Logic.normalizeText(tag).toLocaleLowerCase("en-US");
  }

  function decodeTags(data) {
    if (!data) return [];
    try {
      const parsed = JSON.parse(data);
      const tags = Array.isArray(parsed) ? parsed : parsed?.tags;
      return Array.isArray(tags)
        ? tags.filter((tag) => typeof tag === "string").slice(0, Constants.SMART_TAGS_MANUAL_MAX_COUNT)
        : [];
    }
    catch (_error) {
      return [];
    }
  }

  function tagTone(tag) {
    const normalized = String(tag || "").trim().toLowerCase();
    let hash = 2166136261;
    for (let index = 0; index < normalized.length; index++) {
      hash ^= normalized.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0) % 5;
  }

  function assignTagTones(tags) {
    const used = new Set();
    return tags.map((tag) => {
      let tone = tagTone(tag);
      while (used.size < 5 && used.has(tone)) tone = (tone + 1) % 5;
      used.add(tone);
      return tone;
    });
  }

  class ItemTreeUI {
    constructor({
      cache,
      service,
      getPreference,
      itemTreeManager,
      items,
      stylesheetText,
      setTimer,
      clearTimer,
      log
    } = {}) {
      this.cache = cache;
      this.service = service;
      this.getPreference = getPreference;
      this.itemTreeManager = itemTreeManager || global.Zotero?.ItemTreeManager;
      this.items = items || global.Zotero?.Items;
      this.stylesheetText = stylesheetText || "";
      this.setTimer = setTimer || ((callback, delay) => global.setTimeout(callback, delay));
      this.clearTimer = clearTimer || ((timerID) => global.clearTimeout(timerID));
      this.log = log || (() => {});
      this.values = new Map();
      this.manualValues = new Map();
      this.loaded = new Set();
      this.pending = new Map();
      this.revisions = new Map();
      this.windowStyles = new Map();
      this.editors = new Map();
      this.tagResults = new Map();
      this.globalRevision = 0;
      this.refreshTimer = null;
      this.registeredDataKey = null;
      this.unsubscribeService = null;
      this.initialized = false;
      this.destroyed = false;
    }

    init(pluginID) {
      if (this.initialized) return this.registeredDataKey;
      this.destroyed = false;
      this.unsubscribeService = this.service.subscribe((event) => this._handleServiceEvent(event));
      try {
        this.registeredDataKey = this.itemTreeManager.registerColumn({
          dataKey: "smart-tags",
          label: "智能标签",
          pluginID,
          enabledTreeIDs: ["main"],
          // Zotero 9.0.6 still uses defaultIn for the initial visible state.
          defaultIn: ["default"],
          width: "360",
          minWidth: 180,
          flex: 1,
          ordinal: 0.5,
          showInColumnPicker: true,
          columnPickerSubMenu: false,
          zoteroPersist: ["width", "hidden", "sortDirection"],
          dataProvider: (item) => this.dataProvider(item),
          renderCell: (index, data, column, isFirstColumn, doc) =>
            this.renderCell(index, data, column, isFirstColumn, doc)
        });
      }
      catch (error) {
        this.unsubscribeService?.();
        this.unsubscribeService = null;
        throw error;
      }
      if (!this.registeredDataKey) {
        this.unsubscribeService?.();
        this.unsubscribeService = null;
        throw new Logic.SmartTranslatorError("ITEM_TREE_COLUMN", "无法注册智能标签列");
      }
      this.initialized = true;
      return this.registeredDataKey;
    }

    _isDisplayItem(item) {
      if (!item || item.deleted) return false;
      if (item.isRegularItem?.()) return true;
      return Boolean(item.isPDFAttachment?.() && !item.parentItemID);
    }

    _paperForItem(item) {
      if (!this._isDisplayItem(item)) return null;
      const libraryID = Number(item.libraryID);
      const itemKey = item.key;
      const title = Logic.normalizeText(item.getField?.("title")) || "未命名论文";
      const abstract = item.isRegularItem?.() ? String(item.getField?.("abstractNote") || "").trim() : "";
      const storageKey = Logic.makePaperIdentity({
        libraryID,
        itemKey,
        attachmentKey: item.key
      });
      const sourceSignature = Logic.makeSmartTagsSourceSignature({ title, abstract });
      let configSignature = "";
      try {
        const config = Logic.getProviderConfig(this.getPreference);
        configSignature = Logic.makeSmartTagsConfigSignature({ sourceSignature, config });
      }
      catch (_error) {
        // Manual tags work without a configured translation provider.
      }
      return {
        paper: {
          storageKey,
          libraryID,
          itemKey,
          attachmentKey: item.key,
          title
        },
        sourceSignature,
        configSignature
      };
    }

    _descriptor(item) {
      try {
        return this._paperForItem(item);
      }
      catch (error) {
        this.log("无法确定智能标签缓存标识", error);
        return null;
      }
    }

    _valueKey(storageKey, configSignature) {
      return `${storageKey}|${configSignature}`;
    }

    dataProvider(item) {
      const descriptor = this._descriptor(item);
      if (!descriptor) return "";
      const key = this._valueKey(descriptor.paper.storageKey, descriptor.configSignature);
      const value = this.manualValues.get(descriptor.paper.storageKey) || this.values.get(key);
      if (!value && !this.loaded.has(key) && !this.pending.has(key)) this._loadDescriptor(descriptor, key);
      // Keep the tags first for column sorting. Bind controls to an item identity,
      // never a virtual row index or whichever item happens to be selected later.
      return JSON.stringify({ tags: value?.tags || [], itemID: item.id, paperStorageKey: descriptor.paper.storageKey });
    }

    _loadDescriptor(descriptor, key) {
      const storageKey = descriptor.paper.storageKey;
      const revision = this.revisions.get(storageKey) || 0;
      const globalRevision = this.globalRevision;
      const operation = Promise.resolve(this.cache.peekSmartTags(descriptor.paper, {
        sourceSignature: descriptor.sourceSignature,
        configSignature: descriptor.configSignature
      })).then((entry) => {
        if (
          this.destroyed ||
          globalRevision !== this.globalRevision ||
          revision !== (this.revisions.get(storageKey) || 0)
        ) return;
        this.loaded.add(key);
        if (entry) {
          if (entry.manual) this.manualValues.set(storageKey, { tags: entry.tags.slice() });
          this.values.set(key, {
            sourceSignature: entry.sourceSignature,
            configSignature: entry.configSignature,
            tags: entry.tags.slice()
          });
        }
        this._scheduleRefresh();
      }).catch((error) => {
        if (!this.destroyed) this.log("读取智能标签缓存失败", error);
      }).finally(() => {
        if (this.pending.get(key) === operation) this.pending.delete(key);
      });
      this.pending.set(key, operation);
    }

    renderCell(_index, data, column, _isFirstColumn, doc) {
      const classNames = ["cell", column?.className, "spt-smart-tags-cell"].filter(Boolean);
      const cell = doc.createElement("span");
      cell.className = classNames.join(" ");
      // Zotero otherwise rebuilds first-column children through innerHTML and
      // drops their listeners when the user moves this column to the first slot.
      const content = doc.createElement("span");
      content.className = "cell-text spt-smart-tags-content";
      cell.append(content);
      const chips = doc.createElement("span");
      chips.className = "spt-smart-tags-chips";
      content.append(chips);
      const tags = decodeTags(data);
      if (!tags.length) {
        cell.setAttribute("aria-label", "无智能标签");
      }
      const description = tags.join(" · ");
      cell.title = description;
      if (tags.length) cell.setAttribute("aria-label", `智能标签：${description}`);
      const tones = assignTagTones(tags);
      let identity;
      try { identity = JSON.parse(data); }
      catch (_error) {}
      const editable = Boolean(this._editableDescriptor(identity));
      for (let index = 0; index < tags.length; index++) {
        const tag = tags[index];
        const chip = doc.createElementNS("http://www.w3.org/1999/xhtml", editable ? "button" : "span");
        chip.className = `spt-smart-tag spt-smart-tag--tone-${tones[index]}`;
        chip.textContent = tag;
        chip.title = editable ? `查看同标签文章：${tag}` : tag;
        if (editable) {
          chip.type = "button";
          chip.setAttribute("aria-label", chip.title);
          chip.setAttribute("aria-haspopup", "dialog");
          for (const type of ["mousedown", "mouseup", "dblclick", "keydown", "keyup"]) {
            chip.addEventListener(type, (event) => event.stopPropagation());
          }
          chip.addEventListener("click", (event) => {
            event.stopPropagation();
            this.openTagResults(doc, identity, tag, chip);
          });
        }
        chips.append(chip);
      }
      if (editable) {
        const button = doc.createElementNS("http://www.w3.org/1999/xhtml", "button");
        button.type = "button";
        button.className = `spt-smart-tags-edit${tags.length ? "" : " spt-smart-tags-edit--empty"}`;
        button.textContent = tags.length ? "编辑" : "+ 标签";
        button.title = "编辑智能标签";
        button.setAttribute("aria-label", "编辑智能标签");
        for (const type of ["mousedown", "mouseup", "dblclick", "keydown", "keyup"]) {
          button.addEventListener(type, (event) => event.stopPropagation());
        }
        button.addEventListener("click", (event) => {
          event.stopPropagation();
          this.openEditor(doc, identity, button);
        });
        content.addEventListener("dblclick", (event) => {
          event.stopPropagation();
          event.preventDefault();
          this.openEditor(doc, identity, button);
        });
        content.append(button);
      }
      return cell;
    }

    _editableDescriptor(identity) {
      if (!Number.isInteger(identity?.itemID) || identity.itemID <= 0) return null;
      try {
        const descriptor = this._descriptor(this.items.get(identity.itemID));
        return descriptor?.paper.storageKey === identity.paperStorageKey ? descriptor : null;
      }
      catch (_error) { return null; }
    }

    _editorCurrent(state) {
      return !this.destroyed && !state.win.closed && this.editors.get(state.win) === state &&
        state.panel.isConnected && state.view === state.win.ZoteroPane?.itemsView &&
        state.tabID === state.win.Zotero_Tabs?.selectedID && Boolean(this._editableDescriptor(state.identity));
    }

    _tagResultsCurrent(state) {
      return !this.destroyed && !state.win.closed && this.tagResults.get(state.win) === state &&
        state.panel.isConnected && state.view === state.win.ZoteroPane?.itemsView &&
        state.tabID === state.win.Zotero_Tabs?.selectedID &&
        this._editableDescriptor(state.identity)?.paper.libraryID === state.libraryID;
    }

    closeTagResults(win) {
      const state = this.tagResults.get(win);
      if (!state) return;
      this.tagResults.delete(win);
      state.serial++;
      state.panel.hidePopup?.();
      state.panel.remove();
    }

    invalidateTagResults() {
      for (const state of this.tagResults.values()) {
        state.serial++;
        state.results = [];
        state.list.replaceChildren();
        state.loading = false;
        state.busy = false;
        state.list.setAttribute("aria-busy", "false");
        state.refresh.disabled = false;
        state.previous.disabled = true;
        state.next.disabled = true;
        state.status.textContent = "标签或文库内容已更新，请刷新。";
      }
    }

    async openTagResults(doc, identity, tag, anchor) {
      const win = doc.defaultView;
      const descriptor = this._editableDescriptor(identity);
      const matchKey = tagMatchKey(tag);
      if (this.destroyed || !descriptor || !matchKey || !anchor.isConnected || !this.windowStyles.has(win)) return;
      this.closeEditor(win);
      this.closeTagResults(win);
      const create = (name, className = "") => {
        const element = doc.createElementNS("http://www.w3.org/1999/xhtml", name);
        element.className = className;
        return element;
      };
      const panel = doc.createXULElement("panel");
      panel.setAttribute("class", "spt-smart-tags-popup");
      panel.setAttribute("type", "arrow");
      panel.setAttribute("consumeoutsideclicks", "true");
      panel.setAttribute("role", "dialog");
      panel.setAttribute("aria-label", `同标签文章：${tag}`);
      const content = create("div", "spt-smart-tags-editor spt-smart-tag-results");
      const heading = create("h3");
      heading.textContent = `同标签文章：${tag}`;
      const hint = create("p", "spt-smart-tags-editor-hint");
      hint.textContent = "此条目所在文库的全部分类 · 点击标题在文库中定位";
      const status = create("div", "spt-smart-tags-editor-status");
      status.setAttribute("role", "status");
      const list = create("ol", "spt-smart-tag-results-list");
      const actions = create("div", "spt-smart-tags-editor-actions spt-smart-tag-results-actions");
      const previous = create("button");
      previous.textContent = "上一页";
      const next = create("button");
      next.textContent = "下一页";
      const refresh = create("button");
      refresh.textContent = "刷新";
      const close = create("button");
      close.textContent = "关闭";
      for (const button of [previous, next, refresh, close]) button.type = "button";
      actions.append(previous, next, refresh, close);
      content.append(heading, hint, status, list, actions);
      panel.append(content);
      const state = {
        win, panel, create, list, status, previous, next, refresh, close,
        identity: { itemID: identity.itemID, paperStorageKey: identity.paperStorageKey },
        libraryID: descriptor.paper.libraryID, matchKey,
        view: win.ZoteroPane?.itemsView, tabID: win.Zotero_Tabs?.selectedID,
        serial: 0, results: [], page: 0, failures: 0, loading: false, busy: false
      };
      this.tagResults.set(win, state);
      panel.addEventListener("popuphidden", (event) => {
        if (event.target === panel && this.tagResults.get(win) === state) this.closeTagResults(win);
      });
      panel.addEventListener("popupshown", () => {
        if (this._tagResultsCurrent(state)) close.focus();
      });
      panel.addEventListener("keydown", (event) => {
        event.stopPropagation();
        if (event.key === "Escape" && this.tagResults.get(win) === state) {
          event.preventDefault();
          this.closeTagResults(win);
        }
      });
      close.addEventListener("click", () => {
        if (this.tagResults.get(win) === state) this.closeTagResults(win);
      });
      refresh.addEventListener("click", () => {
        if (!refresh.disabled) this._loadTagResults(state);
      });
      for (const [button, direction] of [[previous, -1], [next, 1]]) {
        button.addEventListener("click", () => {
          if (button.disabled || !this._tagResultsCurrent(state)) return;
          state.page += direction;
          this._renderTagResults(state);
          (state.list.firstElementChild?.lastElementChild || close).focus();
        });
      }
      doc.documentElement.append(panel);
      try {
        panel.openPopup(anchor, "after_start", 0, 0, false, false);
        await this._loadTagResults(state);
      }
      catch (error) {
        if (this.tagResults.get(win) === state) this.closeTagResults(win);
        this.log("打开同标签文章失败", error);
      }
    }

    async _loadTagResults(state) {
      if (!this._tagResultsCurrent(state) || state.loading || state.busy) return;
      const serial = ++state.serial;
      const current = () => serial === state.serial && this._tagResultsCurrent(state);
      state.loading = true;
      state.results = [];
      state.list.replaceChildren();
      state.list.setAttribute("aria-busy", "true");
      state.previous.disabled = true;
      state.next.disabled = true;
      state.refresh.disabled = true;
      state.status.textContent = "正在查找同标签文章…";
      try {
        // Query the clicked item's library, including other collections. Never
        // infer the library from a selection (Zotero 10 supports multiple libraries).
        const items = await this.items.getAll(state.libraryID, true, false);
        if (!current()) return;
        const results = [];
        let failures = 0;
        const seen = new Set();
        for (let offset = 0; offset < items.length; offset += TAG_READ_BATCH_SIZE) {
          const batch = await Promise.all(items.slice(offset, offset + TAG_READ_BATCH_SIZE).map(async (item) => {
            if (!current() || item.libraryID !== state.libraryID) return null;
            const descriptor = this._descriptor(item);
            if (!descriptor) return null;
            try {
              const entry = await this.cache.peekSmartTags(descriptor.paper, { ...descriptor, strict: true });
              if (!current() || !entry?.tags.some((value) => typeof value === "string" && tagMatchKey(value) === state.matchKey)) return null;
              return {
                itemID: item.id, paperStorageKey: descriptor.paper.storageKey,
                title: descriptor.paper.title
              };
            }
            catch (error) {
              failures++;
              this.log("读取同标签文章缓存失败", error);
              return null;
            }
          }));
          if (!current()) return;
          for (const result of batch) {
            if (!result || seen.has(result.itemID)) continue;
            seen.add(result.itemID);
            results.push(result);
          }
        }
        results.sort((a, b) => a.title.localeCompare(b.title) || a.itemID - b.itemID);
        state.results = results;
        state.failures = failures;
        state.page = 0;
        this._renderTagResults(state);
      }
      catch (error) {
        if (current()) {
          state.status.textContent = "无法读取同标签文章，请点击刷新重试。";
          this.log("查询同标签文章失败", error);
        }
      }
      finally {
        if (current()) {
          state.loading = false;
          state.refresh.disabled = false;
          state.list.setAttribute("aria-busy", "false");
        }
        else if (this.tagResults.get(state.win) === state && !this._tagResultsCurrent(state)) {
          this.closeTagResults(state.win);
        }
      }
    }

    _renderTagResults(state) {
      state.list.replaceChildren();
      const start = state.page * TAG_RESULTS_PAGE_SIZE;
      state.list.setAttribute("start", String(start + 1));
      state.list.scrollTop = 0;
      for (const [index, result] of state.results.slice(start, start + TAG_RESULTS_PAGE_SIZE).entries()) {
        const row = state.create("li");
        const number = state.create("span", "spt-smart-tag-result-number");
        number.textContent = `${start + index + 1}.`;
        number.setAttribute("aria-hidden", "true");
        const button = state.create("button", "spt-smart-tag-result-title");
        button.type = "button";
        button.textContent = result.title;
        button.title = "在文库中定位此文章";
        button.addEventListener("click", () => this._locateTagResult(state, result));
        row.append(number, button);
        state.list.append(row);
      }
      state.previous.disabled = state.page === 0;
      state.next.disabled = start + TAG_RESULTS_PAGE_SIZE >= state.results.length;
      const pages = Math.max(1, Math.ceil(state.results.length / TAG_RESULTS_PAGE_SIZE));
      state.status.textContent = state.results.length
        ? `共 ${state.results.length} 篇 · 第 ${state.page + 1} / ${pages} 页`
        : "没有找到同标签文章。仅匹配已有智能标签。";
      if (state.failures) state.status.textContent += `（${state.failures} 篇标签读取失败，结果可能不完整，请刷新重试。）`;
    }

    async _locateTagResult(state, result) {
      if (!this._tagResultsCurrent(state) || state.loading || state.busy || !state.results.includes(result)) return;
      const descriptor = this._editableDescriptor(result);
      if (descriptor?.paper.libraryID !== state.libraryID) {
        this.invalidateTagResults();
        return;
      }
      const serial = state.serial;
      state.busy = true;
      state.refresh.disabled = true;
      state.status.textContent = "正在定位文章…";
      try {
        const entry = await this.cache.peekSmartTags(descriptor.paper, { ...descriptor, strict: true });
        if (!this._tagResultsCurrent(state) || serial !== state.serial) return;
        const latest = this._editableDescriptor(result);
        if (!latest || latest.sourceSignature !== descriptor.sourceSignature ||
          latest.configSignature !== descriptor.configSignature ||
          !entry?.tags.some((tag) => typeof tag === "string" && tagMatchKey(tag) === state.matchKey)) {
          this.invalidateTagResults();
          return;
        }
        const selected = await state.win.ZoteroPane.selectItem(result.itemID, { inLibraryRoot: true });
        if (selected === false) throw new Error("Item is no longer available");
        if (this.tagResults.get(state.win) === state && serial === state.serial) this.closeTagResults(state.win);
      }
      catch (error) {
        if (this._tagResultsCurrent(state) && serial === state.serial) {
          state.status.textContent = "定位失败，请重试或刷新文章列表。";
          this.log("定位同标签文章失败", error);
        }
      }
      finally {
        if (this._tagResultsCurrent(state) && serial === state.serial) {
          state.busy = false;
          state.refresh.disabled = false;
        }
        else if (this.tagResults.get(state.win) === state && !this._tagResultsCurrent(state)) {
          this.closeTagResults(state.win);
        }
      }
    }

    closeEditor(win) {
      const state = this.editors.get(win);
      if (!state) return;
      this.editors.delete(win);
      state.panel.hidePopup?.();
      state.panel.remove();
    }

    _editorControls(state) {
      const disabled = state.loading || state.busy;
      state.save.disabled = disabled || state.loadFailed;
      state.add.disabled = disabled || state.loadFailed || state.rows.length >= Constants.SMART_TAGS_MANUAL_MAX_COUNT;
      for (const row of state.rows) {
        row.input.disabled = disabled;
        row.remove.disabled = disabled;
      }
    }

    _addEditorRow(state, value = "", focus = false) {
      if (state.rows.length >= Constants.SMART_TAGS_MANUAL_MAX_COUNT) return;
      const row = state.create("div", "spt-smart-tags-editor-row");
      const input = state.create("input");
      input.type = "text";
      input.value = value;
      input.setAttribute("aria-label", "标签名称");
      input.placeholder = "输入标签名称";
      const remove = state.create("button");
      remove.type = "button";
      remove.textContent = "删除";
      remove.setAttribute("aria-label", "删除此标签");
      const entry = { row, input, remove };
      remove.addEventListener("click", () => {
        if (!this._editorCurrent(state) || state.busy || state.loading) return;
        const index = state.rows.indexOf(entry);
        if (index < 0) return;
        state.rows.splice(index, 1);
        row.remove();
        this._editorControls(state);
        (state.rows[index]?.input || state.rows[index - 1]?.input || state.add).focus();
      });
      row.append(input, remove);
      state.list.append(row);
      state.rows.push(entry);
      this._editorControls(state);
      if (focus) input.focus();
    }

    async openEditor(doc, identity, anchor) {
      const win = doc.defaultView;
      const descriptor = this._editableDescriptor(identity);
      if (this.destroyed || !descriptor || !anchor.isConnected || !this.windowStyles.has(win)) return;
      this.closeTagResults(win);
      this.closeEditor(win);
      const panel = doc.createXULElement("panel");
      panel.setAttribute("class", "spt-smart-tags-popup");
      panel.setAttribute("type", "arrow");
      panel.setAttribute("consumeoutsideclicks", "true");
      panel.setAttribute("aria-label", "编辑智能标签");
      const create = (tag, className = "") => {
        const element = doc.createElementNS("http://www.w3.org/1999/xhtml", tag);
        element.className = className;
        return element;
      };
      const content = create("div", "spt-smart-tags-editor");
      const heading = create("h3");
      heading.textContent = "编辑智能标签";
      const title = create("div", "spt-smart-tags-editor-title");
      title.textContent = descriptor.paper.title;
      const hint = create("p", "spt-smart-tags-editor-hint");
      hint.textContent = `最多 ${Constants.SMART_TAGS_MANUAL_MAX_COUNT} 个标签，每个 ${Constants.SMART_TAG_MAX_LENGTH} 字符。保存后优先使用手动标签，可删除全部标签。`;
      const list = create("div", "spt-smart-tags-editor-list");
      const add = create("button", "spt-smart-tags-editor-add");
      add.type = "button";
      add.textContent = "+ 添加标签";
      const status = create("div", "spt-smart-tags-editor-status");
      status.setAttribute("role", "status");
      status.textContent = "正在读取本地标签…";
      const actions = create("div", "spt-smart-tags-editor-actions");
      const footer = create("div", "spt-smart-tags-editor-footer");
      const cancel = create("button");
      cancel.type = "button";
      cancel.textContent = "取消";
      const save = create("button");
      save.type = "button";
      save.className = "spt-smart-tags-save";
      save.textContent = "保存";
      actions.append(cancel, save);
      footer.append(status, actions);
      content.append(heading, title, hint, list, add, footer);
      panel.append(content);
      const state = {
        win, panel, identity: { itemID: identity.itemID, paperStorageKey: identity.paperStorageKey },
        view: win.ZoteroPane?.itemsView, tabID: win.Zotero_Tabs?.selectedID,
        create, list, add, save, status, rows: [], loading: true, busy: false, loadFailed: false,
        expectedRevision: null
      };
      this.editors.set(win, state);
      this._editorControls(state);
      panel.addEventListener("popuphidden", (event) => {
        if (event.target === panel && this.editors.get(win) === state) this.closeEditor(win);
      });
      panel.addEventListener("popupshown", () => {
        if (this._editorCurrent(state)) (state.rows[0]?.input || cancel).focus();
      });
      panel.addEventListener("keydown", (event) => {
        event.stopPropagation();
        if (this.editors.get(win) !== state) return;
        if (event.key === "Escape") {
          event.preventDefault();
          this.closeEditor(win);
        }
        else if (event.key === "Enter" && !event.isComposing && event.target?.localName === "input") {
          event.preventDefault();
          this._saveEditor(state);
        }
      });
      cancel.addEventListener("click", () => {
        if (this.editors.get(win) === state) this.closeEditor(win);
      });
      add.addEventListener("click", () => {
        if (this._editorCurrent(state) && !add.disabled) this._addEditorRow(state, "", true);
      });
      save.addEventListener("click", () => this._saveEditor(state));
      doc.documentElement.append(panel);
      try {
        panel.openPopup(anchor, "after_start", 0, 0, false, false);
        const entry = await this.cache.peekSmartTags(descriptor.paper, { ...descriptor, strict: true });
        if (!this._editorCurrent(state)) {
          if (this.editors.get(win) === state) this.closeEditor(win);
          return;
        }
        state.expectedRevision = entry?.manual ? entry.revision || null : null;
        state.loading = false;
        for (const tag of decodeTags(JSON.stringify(entry?.tags || []))) this._addEditorRow(state, tag);
        if (!state.rows.length) this._addEditorRow(state);
        status.textContent = "仅保存在插件本机缓存中。";
        this._editorControls(state);
        state.rows[0].input.focus();
      }
      catch (error) {
        if (!this._editorCurrent(state)) {
          if (this.editors.get(win) === state) this.closeEditor(win);
          return;
        }
        state.loading = false;
        state.loadFailed = true;
        status.textContent = "无法读取标签，请关闭后重试。";
        this._editorControls(state);
        this.log("读取待编辑智能标签失败", error);
      }
    }

    async _saveEditor(state) {
      if (!this._editorCurrent(state)) {
        if (this.editors.get(state.win) === state) this.closeEditor(state.win);
        return;
      }
      if (state.loading || state.busy || state.loadFailed) return;
      const descriptor = this._editableDescriptor(state.identity);
      state.busy = true;
      state.status.textContent = "正在保存…";
      this._editorControls(state);
      try {
        const tags = Logic.normalizeManualSmartTags(state.rows.map((row) => row.input.value));
        await this.service.saveSmartTags(descriptor.paper, tags, { expectedRevision: state.expectedRevision });
        if (this.editors.get(state.win) === state) this.closeEditor(state.win);
      }
      catch (error) {
        if (!this._editorCurrent(state)) {
          if (this.editors.get(state.win) === state) this.closeEditor(state.win);
          return;
        }
        state.busy = false;
        state.status.textContent = error instanceof Logic.SmartTranslatorError
          ? error.message : "保存失败，输入已保留，请重试。";
        this._editorControls(state);
        this.log("保存智能标签失败", error);
      }
    }

    _handleServiceEvent(event) {
      if (event.type !== "smart-tags" || !event.paper?.storageKey || !event.entry) return;
      this.invalidateTagResults();
      const storageKey = event.paper.storageKey;
      if (event.entry.manual) {
        this._invalidateStorageKey(storageKey);
        this.manualValues.set(storageKey, { tags: event.tags.slice() });
        this._scheduleRefresh();
        return;
      }
      if (this.manualValues.has(storageKey)) return;
      const key = this._valueKey(storageKey, event.entry.configSignature);
      this.revisions.set(storageKey, (this.revisions.get(storageKey) || 0) + 1);
      this.values.set(key, {
        sourceSignature: event.entry.sourceSignature,
        configSignature: event.entry.configSignature,
        tags: event.tags.slice()
      });
      this.loaded.add(key);
      this._scheduleRefresh();
    }

    _storageKeyForModifiedItem(item) {
      if (!item) return null;
      let displayItem = item;
      if (!this._isDisplayItem(displayItem) && item.parentItemID) {
        try {
          displayItem = this.items.get(item.parentItemID);
        }
        catch (_error) {
          return null;
        }
      }
      if (!this._isDisplayItem(displayItem)) return null;
      try {
        return Logic.makePaperIdentity({
          libraryID: displayItem.libraryID,
          itemKey: displayItem.key,
          attachmentKey: displayItem.key
        });
      }
      catch (_error) {
        return null;
      }
    }

    _invalidateStorageKey(storageKey) {
      this.manualValues.delete(storageKey);
      this.revisions.set(storageKey, (this.revisions.get(storageKey) || 0) + 1);
      const prefix = `${storageKey}|`;
      for (const key of this.values.keys()) {
        if (key.startsWith(prefix)) this.values.delete(key);
      }
      for (const key of this.loaded) {
        if (key.startsWith(prefix)) this.loaded.delete(key);
      }
      for (const key of this.pending.keys()) {
        if (key.startsWith(prefix)) this.pending.delete(key);
      }
    }

    invalidateModifiedItems(itemIDs) {
      this.invalidateTagResults();
      let changed = false;
      for (const itemID of itemIDs.map(Number).filter(Number.isFinite)) {
        let item;
        try {
          item = this.items.get(itemID);
        }
        catch (error) {
          this.log("读取已修改条目失败", error);
          continue;
        }
        const storageKey = this._storageKeyForModifiedItem(item);
        if (!storageKey) continue;
        this._invalidateStorageKey(storageKey);
        changed = true;
      }
      if (changed) this._scheduleRefresh();
    }

    onPreferencesChanged() {
      this.invalidateTagResults();
      this.globalRevision++;
      this.values.clear();
      this.manualValues.clear();
      this.loaded.clear();
      this.pending.clear();
      this._scheduleRefresh();
    }

    _scheduleRefresh() {
      if (this.destroyed || this.refreshTimer != null) return;
      this.refreshTimer = this.setTimer(() => {
        this.refreshTimer = null;
        if (!this.destroyed) this.itemTreeManager.refreshColumns();
      }, 50);
    }

    addToWindow(win) {
      if (!win?.document || this.windowStyles.has(win)) return () => this.removeFromWindow(win);
      const doc = win.document;
      let style = doc.querySelector?.('style[data-smart-paper-translator="item-tree-style"]');
      if (!style) {
        style = doc.createElementNS
          ? doc.createElementNS("http://www.w3.org/1999/xhtml", "style")
          : doc.createElement("style");
        style.dataset.smartPaperTranslator = "item-tree-style";
        style.textContent = this.stylesheetText;
        (doc.head || doc.documentElement).append(style);
      }
      this.windowStyles.set(win, style);
      return () => this.removeFromWindow(win);
    }

    removeFromWindow(win) {
      this.closeEditor(win);
      this.closeTagResults(win);
      const style = this.windowStyles.get(win);
      if (!style) return;
      style.remove();
      this.windowStyles.delete(win);
    }

    shutdown() {
      if (this.destroyed) return;
      this.destroyed = true;
      if (this.refreshTimer != null) this.clearTimer(this.refreshTimer);
      this.refreshTimer = null;
      this.unsubscribeService?.();
      this.unsubscribeService = null;
      if (this.registeredDataKey) {
        this.itemTreeManager.unregisterColumn(this.registeredDataKey);
      }
      this.registeredDataKey = null;
      for (const win of Array.from(this.windowStyles.keys())) this.removeFromWindow(win);
      this.values.clear();
      this.manualValues.clear();
      this.loaded.clear();
      this.pending.clear();
      this.initialized = false;
    }
  }

  modules.ItemTreeUI = { ItemTreeUI, assignTagTones, decodeTags, tagTone };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { ItemTreeUI, assignTagTones, decodeTags, tagTone };
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
