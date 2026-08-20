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
  const apiArguments = [];
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
        apiArguments.push(args);
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
    getAPIArguments: () => apiArguments.slice(),
    setAbstract: (value) => { currentAbstract = value; }
  };
}

test("missing metadata abstract never calls the API", async () => {
  const { service, getAPICalls } = createService({ abstract: "" });
  const [abstractResult, tagsResult] = await Promise.all([
    service.ensureAbstract(10),
    service.ensureSmartTags(10)
  ]);
  assert.equal(abstractResult.status, "missing");
  assert.equal(tagsResult.status, "missing");
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

test("new papers translate the abstract and generate independent bounded smart tags", async () => {
  const { service, getAPICalls, getAPIArguments } = createService({
    apiComplete: ({ systemMessage }) => systemMessage
      ? '["World Model","Planning","Model-Based RL"]'
      : "摘要译文"
  });
  const [abstractResult, tagResult] = await Promise.all([
    service.ensureAbstract(10),
    service.ensureSmartTags(10)
  ]);
  assert.equal(abstractResult.translation, "摘要译文");
  assert.deepEqual(tagResult.tags, ["World Model", "Planning", "Model-Based RL"]);
  assert.equal(getAPICalls(), 2);
  const tagCall = getAPIArguments().find((args) => args.systemMessage);
  assert.equal(tagCall.systemMessage, Constants.SMART_TAGS_SYSTEM_MESSAGE);
  assert.equal(tagCall.maxTokens, 128);
  assert.match(tagCall.prompt, /untrusted JSON/u);
});

test("legacy abstract cache is reused while smart tags are progressively backfilled", async () => {
  const { service, getAPICalls } = createService({
    apiComplete: ({ systemMessage }) => systemMessage
      ? '["World Model","Planning","Reinforcement Learning"]'
      : "已有摘要译文"
  });
  await service.ensureAbstract(10);
  const cachedAbstract = await service.ensureAbstract(10);
  const tags = await service.ensureSmartTags(10);
  assert.equal(cachedAbstract.fromCache, true);
  assert.deepEqual(tags.tags, ["World Model", "Planning", "Reinforcement Learning"]);
  assert.equal(getAPICalls(), 2);
});

test("smart tags are cached, emitted, and invalidated by model changes", async () => {
  const { service, prefs, getAPICalls } = createService({
    apiComplete: () => '["World Model","Planning","Reinforcement Learning"]'
  });
  const events = [];
  service.subscribe((event) => events.push(event));
  const first = await service.ensureSmartTags(10);
  const second = await service.ensureSmartTags(10);
  assert.equal(first.fromCache, false);
  assert.equal(second.fromCache, true);
  assert.equal(getAPICalls(), 1);
  assert.equal(events.filter((event) => event.type === "smart-tags").length, 2);

  prefs.set(Constants.PREFS.deepseekModel, "deepseek-v4-pro");
  await service.ensureSmartTags(10);
  assert.equal(getAPICalls(), 2);
});

test("changing the paper abstract invalidates smart tags", async () => {
  const { service, setAbstract, getAPICalls } = createService({
    apiComplete: () => '["World Model","Planning","Reinforcement Learning"]'
  });
  await service.ensureSmartTags(10);
  setAbstract("A revised abstract about policy optimization.");
  await service.ensureSmartTags(10);
  assert.equal(getAPICalls(), 2);
});

test("concurrent duplicate smart-tag requests share one API request", async () => {
  let resolveAPI;
  const response = new Promise((resolve) => { resolveAPI = resolve; });
  const { service, getAPICalls } = createService({ apiComplete: () => response });
  const first = service.ensureSmartTags(10);
  const second = service.ensureSmartTags(10);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(getAPICalls(), 1);
  resolveAPI('["World Model","Planning","Reinforcement Learning"]');
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a.tags, b.tags);
});

test("invalid smart-tag output does not affect abstract translation", async () => {
  const { service } = createService({
    apiComplete: ({ systemMessage }) => systemMessage ? "not-json" : "摘要译文"
  });
  const [abstractResult, tagsResult] = await Promise.allSettled([
    service.ensureAbstract(10),
    service.ensureSmartTags(10)
  ]);
  assert.equal(abstractResult.status, "fulfilled");
  assert.equal(abstractResult.value.translation, "摘要译文");
  assert.equal(tagsResult.status, "rejected");
  assert.equal(tagsResult.reason.code, "API_TAG_FORMAT");
});

test("selection cache probe is local-only and returns a matching cached translation", async () => {
  const { service, prefs, getAPICalls } = createService();
  const miss = await service.getCachedSelection(10, "model", 1);
  assert.equal(miss, null);
  assert.equal(getAPICalls(), 0);

  await service.translateSelection(10, "model", 1);
  const hit = await service.getCachedSelection(10, "model", 1);
  assert.equal(hit.fromCache, true);
  assert.equal(hit.translation, "译文-1");
  assert.equal(getAPICalls(), 1);

  prefs.set(Constants.PREFS.deepseekModel, "deepseek-v4-pro");
  assert.equal(await service.getCachedSelection(10, "model", 1), null);
  assert.equal(getAPICalls(), 1);
});

test("forced selection refresh bypasses and atomically replaces the matching cache entry", async () => {
  const { service, cache, getAPICalls } = createService();
  const first = await service.translateSelection(10, "model", 1);
  const refreshed = await service.translateSelection(10, "model", 1, {
    forceRefresh: true
  });
  const cached = await service.getCachedSelection(10, "model", 1);

  assert.equal(first.translation, "译文-1");
  assert.equal(refreshed.translation, "译文-2");
  assert.equal(refreshed.fromCache, false);
  assert.equal(cached.translation, "译文-2");
  assert.equal(getAPICalls(), 2);
  assert.equal((await cache.getAllEntries(makePaper())).length, 1);
});

test("failed forced selection refresh leaves the previous cached translation intact", async () => {
  const { service, cache, getAPICalls } = createService({
    apiComplete(_args, callNumber) {
      if (callNumber === 2) throw new Error("temporary failure");
      return "已有译文";
    }
  });
  await service.translateSelection(10, "model", 1);

  await assert.rejects(
    service.translateSelection(10, "model", 1, { forceRefresh: true }),
    /temporary failure/u
  );
  const cached = await service.getCachedSelection(10, "model", 1);

  assert.equal(cached.translation, "已有译文");
  assert.equal(getAPICalls(), 2);
  assert.equal((await cache.getAllEntries(makePaper())).length, 1);
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

test("shutdown also cancels smart-tag requests and blocks late tag writes", async () => {
  let finishRequest;
  let cancelCalled = false;
  const request = new Promise((resolve) => { finishRequest = resolve; });
  const { service, cache } = createService({
    apiComplete: async ({ registerCancel }) => {
      registerCancel(() => {
        cancelCalled = true;
        finishRequest('["World Model","Planning","Reinforcement Learning"]');
      });
      return request;
    }
  });
  const pending = service.ensureSmartTags(10);
  await new Promise((resolve) => setImmediate(resolve));
  service.shutdown();

  await assert.rejects(pending, { code: "PLUGIN_STOPPED" });
  assert.equal(cancelCalled, true);
  assert.equal((await cache.getAllEntries(makePaper())).length, 0);
});
