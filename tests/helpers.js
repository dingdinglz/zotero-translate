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

  setText(path, text) {
    this.files.set(path, new TextEncoder().encode(text));
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
    [Constants.PREFS.autoOpen, true],
    [Constants.PREFS.panelX, -1],
    [Constants.PREFS.panelY, 56],
    [Constants.PREFS.selectionPrompt, Constants.DEFAULT_SELECTION_PROMPT],
    [Constants.PREFS.abstractPrompt, Constants.DEFAULT_ABSTRACT_PROMPT]
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
