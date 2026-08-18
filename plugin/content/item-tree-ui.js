(function (global) {
  "use strict";

  const modules = global.SmartPaperTranslatorModules = global.SmartPaperTranslatorModules || {};
  const Constants = modules.Constants || (
    typeof require === "function" ? require("./constants.js") : null
  );
  const Logic = modules.Logic || (
    typeof require === "function" ? require("./logic.js") : null
  );

  function decodeTags(data) {
    if (!data) return [];
    try {
      const tags = JSON.parse(data);
      return Array.isArray(tags)
        ? tags.filter((tag) => typeof tag === "string").slice(0, Constants.SMART_TAGS_MAX_COUNT)
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
      while (used.has(tone)) tone = (tone + 1) % 5;
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
      this.loaded = new Set();
      this.pending = new Map();
      this.revisions = new Map();
      this.windowStyles = new Map();
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
      if (!item) return false;
      if (item.isRegularItem?.()) return true;
      return Boolean(item.isPDFAttachment?.() && !item.parentItemID);
    }

    _paperForItem(item) {
      if (!this._isDisplayItem(item)) return null;
      const libraryID = Number(item.libraryID);
      const itemKey = item.key;
      const title = Logic.normalizeText(item.getField?.("title")) || "未命名论文";
      const abstract = String(item.getField?.("abstractNote") || "").trim();
      if (!Logic.normalizeText(abstract)) return null;
      const storageKey = Logic.makePaperIdentity({
        libraryID,
        itemKey,
        attachmentKey: item.key
      });
      const sourceSignature = Logic.makeSmartTagsSourceSignature({ title, abstract });
      const config = Logic.getProviderConfig(this.getPreference);
      const configSignature = Logic.makeSmartTagsConfigSignature({ sourceSignature, config });
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
      const value = this.values.get(key);
      if (value) return JSON.stringify(value.tags);
      if (!this.loaded.has(key) && !this.pending.has(key)) this._loadDescriptor(descriptor, key);
      return "";
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
      const tags = decodeTags(data);
      if (!tags.length) {
        cell.setAttribute("aria-label", "无智能标签");
        return cell;
      }
      const description = tags.join(" · ");
      cell.title = description;
      cell.setAttribute("aria-label", `智能标签：${description}`);
      const tones = assignTagTones(tags);
      for (let index = 0; index < tags.length; index++) {
        const tag = tags[index];
        const chip = doc.createElement("span");
        chip.className = `spt-smart-tag spt-smart-tag--tone-${tones[index]}`;
        chip.textContent = tag;
        chip.title = tag;
        cell.append(chip);
      }
      return cell;
    }

    _handleServiceEvent(event) {
      if (event.type !== "smart-tags" || !event.paper?.storageKey || !event.entry) return;
      const storageKey = event.paper.storageKey;
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
      this.globalRevision++;
      this.values.clear();
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
