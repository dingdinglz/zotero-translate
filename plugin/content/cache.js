(function (global) {
  "use strict";

  const modules = global.SmartPaperTranslatorModules = global.SmartPaperTranslatorModules || {};
  const Constants = modules.Constants || (
    typeof require === "function" ? require("./constants.js") : null
  );
  const Logic = modules.Logic || (
    typeof require === "function" ? require("./logic.js") : null
  );

  function createEmptyRecord(paper, now) {
    return {
      schemaVersion: Constants.STORAGE_SCHEMA_VERSION,
      paper: {
        storageKey: paper.storageKey,
        libraryID: paper.libraryID,
        itemKey: paper.itemKey,
        attachmentKey: paper.attachmentKey,
        title: paper.title || ""
      },
      createdAt: now(),
      updatedAt: now(),
      entries: []
    };
  }

  function validateRecord(record, paper) {
    return Boolean(
      record &&
      record.schemaVersion === Constants.STORAGE_SCHEMA_VERSION &&
      record.paper?.storageKey === paper.storageKey &&
      Array.isArray(record.entries)
    );
  }

  class TranslationCache {
    constructor({ rootPath, io, joinPath, now, randomID, onError } = {}) {
      this.rootPath = rootPath;
      this.io = io;
      this.joinPath = joinPath || ((...parts) => parts.join("/"));
      this.now = now || (() => new Date().toISOString());
      this.randomID = randomID || (() => `${Date.now()}-${Math.random().toString(36).slice(2)}`);
      this.onError = onError || (() => {});
      this.queues = new Map();
      this.rootReady = null;
    }

    _pathForPaper(paper) {
      if (!/^[0-9]+--[A-Z0-9]{8}$/u.test(paper.storageKey)) {
        throw new Logic.SmartTranslatorError("PAPER_IDENTITY", "论文缓存标识无效");
      }
      return this.joinPath(this.rootPath, `${paper.storageKey}.json`);
    }

    async _ensureRoot() {
      if (!this.rootReady) {
        this.rootReady = this.io.makeDirectory(this.rootPath).catch((error) => {
          this.rootReady = null;
          throw error;
        });
      }
      await this.rootReady;
    }

    async _nextBackupPath(path) {
      const base = `${path}.corrupt-${Date.now()}`;
      let candidate = base;
      let suffix = 1;
      while (await this.io.exists(candidate)) candidate = `${base}-${suffix++}`;
      return candidate;
    }

    async _backupCorrupt(path, error) {
      const backupPath = await this._nextBackupPath(path);
      const bytes = await this.io.read(path);
      await this.io.write(backupPath, bytes);
      this.onError("已备份损坏的翻译缓存：" + backupPath, error);
      return backupPath;
    }

    async _loadUnsafe(paper) {
      await this._ensureRoot();
      const path = this._pathForPaper(paper);
      if (!(await this.io.exists(path))) return createEmptyRecord(paper, this.now);
      try {
        const record = await this.io.readJSON(path);
        if (!validateRecord(record, paper)) {
          throw new Logic.SmartTranslatorError("CACHE_SCHEMA", "翻译缓存结构无效");
        }
        return record;
      }
      catch (error) {
        await this._backupCorrupt(path, error);
        const cleanRecord = createEmptyRecord(paper, this.now);
        await this._writeUnsafe(paper, cleanRecord);
        return cleanRecord;
      }
    }

    async _writeUnsafe(paper, record) {
      await this._ensureRoot();
      record.paper = {
        storageKey: paper.storageKey,
        libraryID: paper.libraryID,
        itemKey: paper.itemKey,
        attachmentKey: paper.attachmentKey,
        title: paper.title || ""
      };
      record.updatedAt = this.now();
      const path = this._pathForPaper(paper);
      await this.io.writeJSON(path, record, { tmpPath: `${path}.tmp` });
    }

    _enqueue(storageKey, operation) {
      const previous = this.queues.get(storageKey) || Promise.resolve();
      const next = previous.catch(() => {}).then(operation);
      this.queues.set(storageKey, next);
      const cleanup = () => {
        if (this.queues.get(storageKey) === next) this.queues.delete(storageKey);
      };
      next.then(cleanup, cleanup);
      return next;
    }

    async getCached(paper, { kind, normalizedSource, configSignature }) {
      const record = await this._loadUnsafe(paper);
      return record.entries.find((entry) =>
        entry.kind === kind &&
        entry.normalizedSource === normalizedSource &&
        entry.configSignature === configSignature
      ) || null;
    }

    async append(paper, entry) {
      return this._enqueue(paper.storageKey, async () => {
        const record = await this._loadUnsafe(paper);
        const existing = record.entries.find((candidate) =>
          candidate.kind === entry.kind &&
          candidate.normalizedSource === entry.normalizedSource &&
          candidate.configSignature === entry.configSignature
        );
        if (existing) return existing;
        const stored = { id: this.randomID(), ...entry };
        record.entries.push(stored);
        await this._writeUnsafe(paper, record);
        return stored;
      });
    }

    async touch(paper, entryID) {
      return this._enqueue(paper.storageKey, async () => {
        const record = await this._loadUnsafe(paper);
        const entry = record.entries.find((candidate) => candidate.id === entryID);
        if (!entry) return null;
        entry.lastUsedAt = this.now();
        entry.cacheHits = Number(entry.cacheHits || 0) + 1;
        await this._writeUnsafe(paper, record);
        return entry;
      });
    }

    async getGlossary(paper) {
      const record = await this._loadUnsafe(paper);
      const latest = new Map();
      for (const entry of record.entries) {
        if (entry.kind !== "selection" || !entry.isTerm) continue;
        const previous = latest.get(entry.normalizedSource);
        const timestamp = entry.lastUsedAt || entry.createdAt || "";
        const previousTimestamp = previous?.lastUsedAt || previous?.createdAt || "";
        if (!previous || timestamp >= previousTimestamp) latest.set(entry.normalizedSource, entry);
      }
      return [...latest.values()].sort((a, b) =>
        String(b.lastUsedAt || b.createdAt).localeCompare(String(a.lastUsedAt || a.createdAt))
      );
    }

    async getAllEntries(paper) {
      const record = await this._loadUnsafe(paper);
      return record.entries.slice();
    }
  }

  function createZoteroCache({ onError } = {}) {
    const rootPath = global.PathUtils.join(
      global.Zotero.DataDirectory.dir,
      Constants.STORAGE_DIRECTORY,
      Constants.STORAGE_RECORDS_DIRECTORY
    );
    const io = {
      exists: (path) => global.IOUtils.exists(path),
      makeDirectory: (path) => global.IOUtils.makeDirectory(path, { ignoreExisting: true }),
      readJSON: (path) => global.IOUtils.readJSON(path),
      read: (path) => global.IOUtils.read(path),
      write: (path, bytes) => global.IOUtils.write(path, bytes),
      writeJSON: (path, value, options) => global.IOUtils.writeJSON(path, value, options)
    };
    return new TranslationCache({
      rootPath,
      io,
      joinPath: (...parts) => global.PathUtils.join(...parts),
      onError
    });
  }

  modules.Cache = { TranslationCache, createZoteroCache, createEmptyRecord, validateRecord };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { TranslationCache, createZoteroCache, createEmptyRecord, validateRecord };
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
