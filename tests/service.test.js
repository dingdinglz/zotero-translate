"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Constants = require("../plugin/content/constants.js");
const { TranslationService } = require("../plugin/content/service.js");
const { makePaper, makeCache, makePreferenceStore } = require("./helpers.js");

function createService({ abstract = "An abstract.", apiComplete, prefs: suppliedPrefs } = {}) {
  let currentAbstract = abstract;
  const prefs = suppliedPrefs || makePreferenceStore();
  const { cache } = makeCache();
  let apiCalls = 0;
  const service = new TranslationService({
    getPreference: prefs.get,
    paperRepository: {
      async get() {
        return { paper: makePaper(), abstract: currentAbstract };
      }
    },
    cache,
    credentials: { async get() { return "sk-test"; } },
    apiClient: {
      async complete(args) {
        apiCalls++;
        return apiComplete ? apiComplete(args, apiCalls) : `译文-${apiCalls}`;
      }
    },
    now: () => "2026-08-18T00:00:00.000Z"
  });
  return {
    service,
    cache,
    prefs,
    getAPICalls: () => apiCalls,
    setAbstract: (value) => { currentAbstract = value; }
  };
}

test("missing metadata abstract never calls the API", async () => {
  const { service, getAPICalls } = createService({ abstract: "" });
  const result = await service.ensureAbstract(10);
  assert.equal(result.status, "missing");
  assert.equal(getAPICalls(), 0);
});

test("connection test uses a tightly bounded completion", async () => {
  let captured;
  const { service } = createService({
    apiComplete: async (args) => {
      captured = args;
      return "OK";
    }
  });
  const result = await service.testConnection();
  assert.equal(result.ok, true);
  assert.equal(captured.maxTokens, 8);
});

test("abstract is translated on first load and served from per-paper cache afterwards", async () => {
  const { service, getAPICalls } = createService();
  const first = await service.ensureAbstract(10);
  const second = await service.ensureAbstract(10);
  assert.equal(first.fromCache, false);
  assert.equal(second.fromCache, true);
  assert.equal(first.translation, second.translation);
  assert.equal(getAPICalls(), 1);
});

test("changing model invalidates cache without deleting old translation", async () => {
  const { service, cache, prefs, getAPICalls } = createService();
  await service.ensureAbstract(10);
  prefs.set(Constants.PREFS.deepseekModel, "deepseek-v4-pro");
  await service.ensureAbstract(10);
  assert.equal(getAPICalls(), 2);
  assert.equal((await cache.getAllEntries(makePaper())).length, 2);
});

test("changing the paper abstract invalidates contextual translation cache", async () => {
  const { service, setAbstract, getAPICalls } = createService();
  await service.translateSelection(10, "model", 1);
  setAbstract("A substantially revised abstract.");
  await service.translateSelection(10, "model", 1);
  assert.equal(getAPICalls(), 2);
});

test("provider identity is part of the cache signature", async () => {
  const { service, prefs, getAPICalls } = createService();
  await service.translateSelection(10, "model", 1);
  prefs.set(Constants.PREFS.provider, "custom");
  prefs.set(Constants.PREFS.customBaseURL, "https://api.deepseek.com");
  prefs.set(Constants.PREFS.customModel, "deepseek-v4-flash");
  await service.translateSelection(10, "model", 1);
  assert.equal(getAPICalls(), 2);
});

test("terms enter glossary while sentences remain cached but hidden", async () => {
  const { service } = createService();
  await service.translateSelection(10, "representation learning", 2);
  await service.translateSelection(10, "This method learns useful representations.", 2);
  const glossary = await service.getGlossaryForItem(10);
  assert.equal(glossary.entries.length, 1);
  assert.equal(glossary.entries[0].source, "representation learning");
});

test("concurrent duplicate translations share one API request", async () => {
  let resolveAPI;
  const apiPromise = new Promise((resolve) => { resolveAPI = resolve; });
  const { service, getAPICalls } = createService({
    apiComplete: async () => apiPromise
  });
  const first = service.translateSelection(10, "policy", 4);
  const second = service.translateSelection(10, "policy", 4);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(getAPICalls(), 1);
  resolveAPI("策略");
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.translation, "策略");
  assert.equal(b.translation, "策略");
});

test("template changes alter request signature and trigger a fresh translation", async () => {
  const { service, prefs, getAPICalls } = createService();
  await service.translateSelection(10, "model", 1);
  prefs.set(Constants.PREFS.selectionPrompt, "仅翻译为 {{targetLanguage}}：{{text}}；摘要：{{abstract}}");
  await service.translateSelection(10, "model", 1);
  assert.equal(getAPICalls(), 2);
});

test("normalized duplicate source text reuses one cached translation", async () => {
  const { service, getAPICalls } = createService();
  await service.translateSelection(10, "representation   learning", 1);
  const result = await service.translateSelection(10, "representation learning", 7);
  assert.equal(result.fromCache, true);
  assert.equal(getAPICalls(), 1);
});

test("shutdown cancels in-flight work and prevents late cache writes", async () => {
  let finishRequest;
  let cancelCalled = false;
  const request = new Promise((resolve) => { finishRequest = resolve; });
  const { service, cache } = createService({
    apiComplete: async ({ registerCancel }) => {
      registerCancel(() => {
        cancelCalled = true;
        finishRequest("晚到译文");
      });
      return request;
    }
  });
  const pending = service.translateSelection(10, "policy", 1);
  await new Promise((resolve) => setImmediate(resolve));
  service.shutdown();

  await assert.rejects(pending, { code: "PLUGIN_STOPPED" });
  assert.equal(cancelCalled, true);
  assert.equal((await cache.getAllEntries(makePaper())).length, 0);
});
