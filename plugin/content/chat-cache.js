(function (global) {
  "use strict";

  const modules = global.SmartPaperTranslatorModules = global.SmartPaperTranslatorModules || {};
  const Constants = modules.Constants || (
    typeof require === "function" ? require("./constants.js") : null
  );
  const Logic = modules.Logic || (
    typeof require === "function" ? require("./logic.js") : null
  );

  function createChatRecord(paper, now, localID, workspacePath) {
    const timestamp = now();
    return {
      schemaVersion: Constants.ACP_SCHEMA_VERSION,
      paper: {
        storageKey: paper.storageKey,
        libraryID: paper.libraryID,
        itemKey: paper.itemKey,
        attachmentKey: paper.attachmentKey,
        attachmentID: paper.attachmentID,
        title: paper.title || ""
      },
      session: {
        id: null,
        localID,
        workspacePath,
        pdfAttached: false,
        source: null,
        sourceChangeAcknowledged: false,
        config: {
          mode: Constants.ACP_MODE,
          model: null,
          reasoningEffort: null
        }
      },
      draft: {
        screenshots: []
      },
      transcript: [],
      sync: {
        state: "local-only",
        lastSyncedAt: null,
        lastError: null
      },
      createdAt: timestamp,
      updatedAt: timestamp
    };
  }

  function validateChatRecord(record, paper) {
    return Boolean(
      record &&
      record.schemaVersion === Constants.ACP_SCHEMA_VERSION &&
      record.paper?.storageKey === paper.storageKey &&
      record.paper?.attachmentKey === paper.attachmentKey &&
      record.session &&
      typeof record.session.localID === "string" &&
      typeof record.session.workspacePath === "string" &&
      record.session.config?.mode === Constants.ACP_MODE &&
      (
        record.draft == null ||
        (record.draft && Array.isArray(record.draft.screenshots))
      ) &&
      Array.isArray(record.transcript) &&
      record.sync
    );
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function emptyConfigurationCatalog() {
    return {
      schemaVersion: Constants.ACP_SCHEMA_VERSION,
      adapterVersion: Constants.ACP_PACKAGE_VERSION,
      runtimeFingerprint: "",
      updatedAt: null,
      configOptions: [],
      configOptionsByModel: {}
    };
  }

  function validateConfigurationCatalog(catalog) {
    return Boolean(
      catalog &&
      catalog.schemaVersion === Constants.ACP_SCHEMA_VERSION &&
      catalog.adapterVersion === Constants.ACP_PACKAGE_VERSION &&
      typeof catalog.runtimeFingerprint === "string" &&
      (catalog.updatedAt === null || typeof catalog.updatedAt === "string") &&
      Array.isArray(catalog.configOptions) &&
      catalog.configOptionsByModel &&
      typeof catalog.configOptionsByModel === "object" &&
      !Array.isArray(catalog.configOptionsByModel) &&
      Object.values(catalog.configOptionsByModel).every(Array.isArray)
    );
  }

  class CodexChatCache {
    constructor({ rootPath, io, joinPath, now, randomID, onError } = {}) {
      this.rootPath = rootPath;
      this.io = io;
      this.joinPath = joinPath || ((...parts) => parts.join("/"));
      this.recordsPath = this.joinPath(rootPath, Constants.ACP_RECORDS_DIRECTORY);
      this.workspacesPath = this.joinPath(rootPath, Constants.ACP_WORKSPACES_DIRECTORY);
      this.toolImagesPath = this.joinPath(rootPath, Constants.ACP_TOOL_IMAGES_DIRECTORY);
      this.screenshotsPath = this.joinPath(rootPath, Constants.ACP_SCREENSHOTS_DIRECTORY);
      this.archivesPath = this.joinPath(rootPath, Constants.ACP_ARCHIVES_DIRECTORY);
      this.configurationCatalogPath = this.joinPath(
        rootPath,
        Constants.ACP_CONFIGURATION_CATALOG_FILE
      );
      this.configurationWorkspacePath = this.joinPath(
        rootPath,
        Constants.ACP_CONFIGURATION_WORKSPACE_DIRECTORY
      );
      this.now = now || (() => new Date().toISOString());
      this.randomID = randomID || (() => `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`);
      this.onError = onError || (() => {});
      this.queues = new Map();
      this.rootReady = null;
    }

    _validatePaper(paper) {
      if (!/^[0-9]+--[A-Z0-9]{8}$/u.test(paper?.storageKey || "")) {
        throw new Logic.SmartTranslatorError("PAPER_IDENTITY", "论文对话缓存标识无效");
      }
    }

    _recordPath(paper) {
      this._validatePaper(paper);
      return this.joinPath(this.recordsPath, `${paper.storageKey}.json`);
    }

    _validateLocalID(localID) {
      if (!/^[0-9A-Za-z._-]+$/u.test(localID)) {
        throw new Logic.SmartTranslatorError("SESSION_IDENTITY", "本地会话标识无效");
      }
    }

    _sessionPath(root, paper, localID) {
      this._validatePaper(paper);
      this._validateLocalID(localID);
      return this.joinPath(root, paper.storageKey, localID);
    }

    _workspacePath(paper, localID) {
      return this._sessionPath(this.workspacesPath, paper, localID);
    }

    toolImageDirectoryPath(paper, record) {
      return this._sessionPath(this.toolImagesPath, paper, record?.session?.localID || "");
    }

    toolImagePath(paper, record, fileName) {
      if (!/^[0-9A-Za-z][0-9A-Za-z._-]{0,119}\.(?:avif|gif|jpe?g|png|webp)$/u.test(fileName || "")) {
        throw new Logic.SmartTranslatorError("TOOL_IMAGE_NAME", "工具图片副本名称无效");
      }
      return this.joinPath(this.toolImageDirectoryPath(paper, record), fileName);
    }

    screenshotDirectoryPath(paper, record) {
      return this._sessionPath(this.screenshotsPath, paper, record?.session?.localID || "");
    }

    screenshotPath(paper, record, fileName) {
      if (!/^capture-[0-9A-Za-z][0-9A-Za-z._-]{0,119}\.png$/u.test(fileName || "")) {
        throw new Logic.SmartTranslatorError("SCREENSHOT_NAME", "PDF 截图副本名称无效");
      }
      return this.joinPath(this.screenshotDirectoryPath(paper, record), fileName);
    }

    async _ensureRoots() {
      if (!this.rootReady) {
        this.rootReady = (async () => {
          await this.io.makeDirectory(this.rootPath);
          await Promise.all([
            this.io.makeDirectory(this.recordsPath),
            this.io.makeDirectory(this.workspacesPath),
            this.io.makeDirectory(this.toolImagesPath),
            this.io.makeDirectory(this.screenshotsPath),
            this.io.makeDirectory(this.archivesPath),
            this.io.makeDirectory(this.configurationWorkspacePath)
          ]);
        })().catch((error) => {
          this.rootReady = null;
          throw error;
        });
      }
      await this.rootReady;
    }

    _enqueue(storageKey, operation) {
      const prior = this.queues.get(storageKey) || Promise.resolve();
      const next = prior.catch(() => {}).then(operation);
      this.queues.set(storageKey, next);
      const cleanup = () => {
        if (this.queues.get(storageKey) === next) this.queues.delete(storageKey);
      };
      next.then(cleanup, cleanup);
      return next;
    }

    async _nextAvailable(path) {
      let candidate = path;
      let index = 1;
      while (await this.io.exists(candidate)) candidate = `${path}-${index++}`;
      return candidate;
    }

    async _backupCorrupt(path, error) {
      const target = await this._nextAvailable(`${path}.corrupt-${Date.now()}`);
      const bytes = await this.io.read(path);
      await this.io.write(target, bytes);
      this.onError("已备份损坏的 Codex 对话镜像：" + target, error);
      return target;
    }

    async _newRecord(paper) {
      const localID = this.randomID();
      const workspacePath = this._workspacePath(paper, localID);
      return createChatRecord(paper, this.now, localID, workspacePath);
    }

    async _loadUnsafe(paper) {
      await this._ensureRoots();
      const path = this._recordPath(paper);
      if (!(await this.io.exists(path))) return this._newRecord(paper);
      try {
        const record = await this.io.readJSON(path);
        if (!validateChatRecord(record, paper)) {
          throw new Logic.SmartTranslatorError("CHAT_CACHE_SCHEMA", "Codex 对话镜像结构无效");
        }
        return record;
      }
      catch (error) {
        await this._backupCorrupt(path, error);
        const record = await this._newRecord(paper);
        await this._writeUnsafe(paper, record);
        return record;
      }
    }

    async _writeUnsafe(paper, record) {
      await this._ensureRoots();
      record.schemaVersion = Constants.ACP_SCHEMA_VERSION;
      record.paper = {
        storageKey: paper.storageKey,
        libraryID: paper.libraryID,
        itemKey: paper.itemKey,
        attachmentKey: paper.attachmentKey,
        attachmentID: paper.attachmentID,
        title: paper.title || ""
      };
      record.session.config.mode = Constants.ACP_MODE;
      record.draft = {
        screenshots: Array.isArray(record.draft?.screenshots)
          ? record.draft.screenshots
          : []
      };
      record.updatedAt = this.now();
      const path = this._recordPath(paper);
      await this.io.writeJSON(path, record, { tmpPath: `${path}.tmp` });
      return record;
    }

    async load(paper) {
      const record = await this._loadUnsafe(paper);
      return clone(record);
    }

    async save(paper, record) {
      return this._enqueue(paper.storageKey, async () => {
        if (!validateChatRecord(record, paper)) {
          throw new Logic.SmartTranslatorError("CHAT_CACHE_SCHEMA", "拒绝保存无效的 Codex 对话镜像");
        }
        await this._writeUnsafe(paper, clone(record));
        return clone(record);
      });
    }

    async update(paper, mutator) {
      return this._enqueue(paper.storageKey, async () => {
        const record = await this._loadUnsafe(paper);
        const result = await mutator(record);
        await this._writeUnsafe(paper, record);
        return result === undefined ? clone(record) : result;
      });
    }

    async ensureWorkspace(paper, record) {
      const expected = this._workspacePath(paper, record.session.localID);
      if (record.session.workspacePath !== expected) {
        throw new Logic.SmartTranslatorError("WORKSPACE_PATH", "Codex 工作区路径与论文会话不匹配");
      }
      await this.io.makeDirectory(this.joinPath(this.workspacesPath, paper.storageKey));
      await this.io.makeDirectory(expected);
      return expected;
    }

    async ensureToolImageDirectory(paper, record) {
      const expected = this.toolImageDirectoryPath(paper, record);
      await this._ensureRoots();
      await this.io.makeDirectory(this.joinPath(this.toolImagesPath, paper.storageKey));
      await this.io.makeDirectory(expected);
      return expected;
    }

    async deleteToolImageDirectory(paper, record) {
      const path = this.toolImageDirectoryPath(paper, record);
      if (!(await this.io.exists(path))) return false;
      await this.io.remove(path, { recursive: true, ignoreAbsent: true });
      return true;
    }

    async ensureScreenshotDirectory(paper, record) {
      const expected = this.screenshotDirectoryPath(paper, record);
      await this._ensureRoots();
      await this.io.makeDirectory(this.joinPath(this.screenshotsPath, paper.storageKey));
      await this.io.makeDirectory(expected);
      return expected;
    }

    async deleteScreenshotDirectory(paper, record) {
      const path = this.screenshotDirectoryPath(paper, record);
      if (!(await this.io.exists(path))) return false;
      await this.io.remove(path, { recursive: true, ignoreAbsent: true });
      return true;
    }

    async ensureConfigurationWorkspace() {
      await this._ensureRoots();
      await this.io.makeDirectory(this.configurationWorkspacePath);
      return this.configurationWorkspacePath;
    }

    async loadConfigurationCatalog() {
      await this._ensureRoots();
      if (!(await this.io.exists(this.configurationCatalogPath))) {
        return emptyConfigurationCatalog();
      }
      try {
        const catalog = await this.io.readJSON(this.configurationCatalogPath);
        if (!validateConfigurationCatalog(catalog)) {
          throw new Logic.SmartTranslatorError(
            "CONFIG_CATALOG_SCHEMA",
            "Codex 配置选项目录结构无效"
          );
        }
        return clone(catalog);
      }
      catch (error) {
        await this._backupCorrupt(this.configurationCatalogPath, error);
        const catalog = emptyConfigurationCatalog();
        await this.io.writeJSON(this.configurationCatalogPath, catalog, {
          tmpPath: `${this.configurationCatalogPath}.tmp`
        });
        return catalog;
      }
    }

    async saveConfigurationCatalog(catalog) {
      return this._enqueue("__configuration_catalog__", async () => {
        const normalized = {
          ...clone(catalog),
          schemaVersion: Constants.ACP_SCHEMA_VERSION,
          adapterVersion: Constants.ACP_PACKAGE_VERSION,
          updatedAt: catalog.updatedAt || this.now()
        };
        if (!validateConfigurationCatalog(normalized)) {
          throw new Logic.SmartTranslatorError(
            "CONFIG_CATALOG_SCHEMA",
            "拒绝保存无效的 Codex 配置选项目录"
          );
        }
        await this._ensureRoots();
        await this.io.writeJSON(this.configurationCatalogPath, normalized, {
          tmpPath: `${this.configurationCatalogPath}.tmp`
        });
        return clone(normalized);
      });
    }

    async archiveAndReset(paper, reason = "user-reset") {
      return this._enqueue(paper.storageKey, async () => {
        const oldRecord = await this._loadUnsafe(paper);
        const toolImagesDeleted = await this.deleteToolImageDirectory(paper, oldRecord);
        const screenshotsDeleted = await this.deleteScreenshotDirectory(paper, oldRecord);
        const archiveStamp = Date.now();
        const paperArchivePath = this.joinPath(this.archivesPath, paper.storageKey);
        await this.io.makeDirectory(paperArchivePath);
        const oldWorkspacePath = oldRecord.session.workspacePath;
        let archivedWorkspacePath = oldWorkspacePath;
        let workspaceRetained = false;
        if (await this.io.exists(oldWorkspacePath)) {
          archivedWorkspacePath = await this._nextAvailable(this.joinPath(
            paperArchivePath,
            `${oldRecord.session.localID}-${archiveStamp}`
          ));
          await this.io.move(oldWorkspacePath, archivedWorkspacePath);
          workspaceRetained = true;
        }
        const archivedRecord = clone(oldRecord);
        archivedRecord.session.workspacePath = archivedWorkspacePath;
        const archiveBase = this.joinPath(
          this.archivesPath,
          `${paper.storageKey}-${oldRecord.session.localID}-${archiveStamp}.json`
        );
        const archivePath = await this._nextAvailable(archiveBase);
        await this.io.writeJSON(archivePath, {
          ...archivedRecord,
          archive: {
            reason,
            archivedAt: this.now(),
            workspaceRetained,
            toolImagesDeleted,
            screenshotsDeleted,
            originalWorkspacePath: oldWorkspacePath
          }
        }, { tmpPath: `${archivePath}.tmp` });
        const newRecord = await this._newRecord(paper);
        await this._writeUnsafe(paper, newRecord);
        return { record: clone(newRecord), archivePath };
      });
    }
  }

  function createZoteroChatCache({ onError } = {}) {
    const rootPath = global.PathUtils.join(
      global.Zotero.DataDirectory.dir,
      Constants.STORAGE_DIRECTORY,
      Constants.ACP_DIRECTORY
    );
    const io = {
      exists: (path) => global.IOUtils.exists(path),
      makeDirectory: (path) => global.IOUtils.makeDirectory(path, { ignoreExisting: true }),
      readJSON: (path) => global.IOUtils.readJSON(path),
      read: (path) => global.IOUtils.read(path),
      write: (path, bytes) => global.IOUtils.write(path, bytes),
      move: (source, target) => global.IOUtils.move(source, target, { noOverwrite: true }),
      remove: (path, options) => global.IOUtils.remove(path, options),
      writeJSON: (path, value, options) => global.IOUtils.writeJSON(path, value, options)
    };
    return new CodexChatCache({
      rootPath,
      io,
      joinPath: (...parts) => global.PathUtils.join(...parts),
      onError
    });
  }

  modules.ChatCache = {
    CodexChatCache,
    createChatRecord,
    validateChatRecord,
    emptyConfigurationCatalog,
    validateConfigurationCatalog,
    createZoteroChatCache
  };
  if (typeof module !== "undefined" && module.exports) module.exports = modules.ChatCache;
})(typeof globalThis !== "undefined" ? globalThis : this);
