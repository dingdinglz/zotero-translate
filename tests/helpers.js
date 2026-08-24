"use strict";

const Constants = require("../plugin/content/constants.js");

class MemoryIO {
  constructor() {
    this.files = new Map();
    this.directories = new Set();
    this.writeJSONCalls = [];
  }

  async exists(path) {
    return this.files.has(path) || this.directories.has(path);
  }

  async makeDirectory(path) {
    this.directories.add(path);
  }

  async getChildren(path) {
    const prefix = path.endsWith("/") ? path : `${path}/`;
    return [...this.directories].filter((candidate) => candidate.startsWith(prefix));
  }

  async readJSON(path) {
    if (!this.files.has(path)) throw new Error("ENOENT");
    return JSON.parse(new TextDecoder().decode(this.files.get(path)));
  }

  async read(path) {
    if (!this.files.has(path)) throw new Error("ENOENT");
    return this.files.get(path).slice();
  }

  async write(path, bytes) {
    this.files.set(path, new Uint8Array(bytes));
  }

  async writeJSON(path, value, options = {}) {
    this.writeJSONCalls.push({ path, options: { ...options } });
    this.files.set(path, new TextEncoder().encode(JSON.stringify(value)));
  }

  async copy(source, target) {
    if (!this.files.has(source)) throw new Error("ENOENT");
    this.files.set(target, this.files.get(source).slice());
  }

  async move(source, target) {
    if (this.files.has(source)) {
      this.files.set(target, this.files.get(source));
      this.files.delete(source);
      return;
    }
    if (!this.directories.has(source)) throw new Error("ENOENT");
    const sourcePrefix = `${source}/`;
    const directoryMoves = [...this.directories]
      .filter((path) => path === source || path.startsWith(sourcePrefix));
    const fileMoves = [...this.files.entries()]
      .filter(([path]) => path.startsWith(sourcePrefix));
    for (const path of directoryMoves) this.directories.delete(path);
    for (const path of directoryMoves) {
      this.directories.add(target + path.slice(source.length));
    }
    for (const [path, bytes] of fileMoves) {
      this.files.delete(path);
      this.files.set(target + path.slice(source.length), bytes);
    }
  }

  async remove(path, { recursive = false, ignoreAbsent = false } = {}) {
    if (this.files.delete(path)) return;
    if (!this.directories.has(path)) {
      if (ignoreAbsent) return;
      throw new Error("ENOENT");
    }
    const prefix = `${path}/`;
    const hasChildren = [...this.directories].some((candidate) => candidate.startsWith(prefix)) ||
      [...this.files.keys()].some((candidate) => candidate.startsWith(prefix));
    if (hasChildren && !recursive) throw new Error("ENOTEMPTY");
    for (const candidate of [...this.directories]) {
      if (candidate === path || candidate.startsWith(prefix)) this.directories.delete(candidate);
    }
    for (const candidate of [...this.files.keys()]) {
      if (candidate.startsWith(prefix)) this.files.delete(candidate);
    }
  }

  setText(path, text) {
    this.files.set(path, new TextEncoder().encode(text));
  }

  setBytes(path, bytes) {
    this.files.set(path, new Uint8Array(bytes));
  }
}

function makePaper(overrides = {}) {
  return {
    storageKey: "1--ABCDEFGH",
    libraryID: 1,
    itemKey: "ABCDEFGH",
    attachmentKey: "HGFEDCBA",
    attachmentID: 10,
    parentItemID: 20,
    title: "A Test Paper",
    ...overrides
  };
}

function makePreferenceStore(overrides = {}) {
  const values = new Map([
    [Constants.PREFS.provider, "deepseek"],
    [Constants.PREFS.deepseekBaseURL, "https://api.deepseek.com"],
    [Constants.PREFS.deepseekModel, "deepseek-v4-flash"],
    [Constants.PREFS.customBaseURL, ""],
    [Constants.PREFS.customModel, ""],
    [Constants.PREFS.targetLanguage, "简体中文"],
    [Constants.PREFS.autoTranslateSelection, false],
    [Constants.PREFS.selectionTranslationDisabledItems, "[]"],
    [Constants.PREFS.autoOpen, true],
    [Constants.PREFS.panelX, -1],
    [Constants.PREFS.panelY, 56],
    [Constants.PREFS.panelWidth, 390],
    [Constants.PREFS.panelHeight, 540],
    [Constants.PREFS.selectionPrompt, Constants.DEFAULT_SELECTION_PROMPT],
    [Constants.PREFS.abstractPrompt, Constants.DEFAULT_ABSTRACT_PROMPT],
    [Constants.PREFS.codexNodePath, ""],
    [Constants.PREFS.codexNpxCliPath, ""],
    [Constants.PREFS.codexExecutablePath, ""],
    [Constants.PREFS.codexPreparedVersion, ""],
    [Constants.PREFS.codexPreparedFingerprint, ""],
    [Constants.PREFS.codexDefaultModel, ""],
    [Constants.PREFS.codexDefaultReasoningEffort, ""],
    [Constants.PREFS.codexDeveloperMode, false]
  ]);
  for (const [key, value] of Object.entries(overrides)) values.set(key, value);
  return {
    values,
    get: (key) => values.get(key),
    set: (key, value) => values.set(key, value)
  };
}

function makeCache(options = {}) {
  const { TranslationCache } = require("../plugin/content/cache.js");
  const io = options.io || new MemoryIO();
  let id = 0;
  const cache = new TranslationCache({
    rootPath: "/records",
    io,
    joinPath: (...parts) => parts.join("/"),
    now: options.now || (() => "2026-08-18T00:00:00.000Z"),
    randomID: () => `entry-${++id}`,
    onError: options.onError
  });
  return { cache, io };
}

module.exports = { MemoryIO, makePaper, makePreferenceStore, makeCache };
