"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { makePaper, makeCache, MemoryIO } = require("./helpers.js");

function entry(overrides = {}) {
  return {
    kind: "selection",
    source: "model",
    normalizedSource: "model",
    translation: "模型",
    isTerm: true,
    pageNumber: 1,
    provider: "deepseek",
    baseURL: "https://api.deepseek.com",
    model: "deepseek-v4-flash",
    targetLanguage: "简体中文",
    configSignature: "signature-a",
    createdAt: "2026-08-18T00:00:00.000Z",
    lastUsedAt: "2026-08-18T00:00:00.000Z",
    cacheHits: 0,
    ...overrides
  };
}

test("cache persists entries, touches hits, and retains configuration variants", async () => {
  let tick = 0;
  const { cache } = makeCache({
    now: () => `2026-08-18T00:00:0${tick++}.000Z`
  });
  const paper = makePaper();
  const first = await cache.append(paper, entry());
  const cached = await cache.getCached(paper, {
    kind: "selection",
    normalizedSource: "model",
    configSignature: "signature-a"
  });
  assert.equal(cached.id, first.id);
  const touched = await cache.touch(paper, first.id);
  assert.equal(touched.cacheHits, 1);

  await cache.append(paper, entry({ translation: "模型（新）", configSignature: "signature-b" }));
  assert.equal((await cache.getAllEntries(paper)).length, 2);
});

test("concurrent appends are serialized without losing records", async () => {
  const { cache, io } = makeCache();
  const paper = makePaper();
  await Promise.all([
    cache.append(paper, entry({ source: "model", normalizedSource: "model" })),
    cache.append(paper, entry({ source: "policy", normalizedSource: "policy", translation: "策略" }))
  ]);
  assert.equal((await cache.getAllEntries(paper)).length, 2);
  assert.equal(io.writeJSONCalls.length, 2);
  assert.deepEqual(io.writeJSONCalls[0].options, {
    tmpPath: "/records/1--ABCDEFGH.json.tmp"
  });
});

test("glossary deduplicates terms and excludes sentences", async () => {
  let tick = 0;
  const { cache } = makeCache({ now: () => `2026-08-18T00:00:0${tick++}.000Z` });
  const paper = makePaper();
  await cache.append(paper, entry({ translation: "模型（旧）", configSignature: "a" }));
  await cache.append(paper, entry({ translation: "模型（新）", configSignature: "b" }));
  await cache.append(paper, entry({
    source: "This is a sentence.",
    normalizedSource: "This is a sentence.",
    translation: "这是一个句子。",
    isTerm: false,
    configSignature: "c"
  }));
  const glossary = await cache.getGlossary(paper);
  assert.equal(glossary.length, 1);
  assert.equal(glossary[0].translation, "模型（新）");
});

test("corrupt JSON is backed up before a clean record is created", async () => {
  const io = new MemoryIO();
  const errors = [];
  const { cache } = makeCache({ io, onError: (message) => errors.push(message) });
  const paper = makePaper();
  io.setText("/records/1--ABCDEFGH.json", "{not-json");

  const result = await cache.getCached(paper, {
    kind: "selection",
    normalizedSource: "model",
    configSignature: "x"
  });
  assert.equal(result, null);
  assert.equal(errors.length, 1);
  assert.equal([...io.files.keys()].some((path) => path.includes(".corrupt-")), true);
  const recovered = await io.readJSON("/records/1--ABCDEFGH.json");
  assert.equal(recovered.paper.storageKey, paper.storageKey);
  assert.deepEqual(recovered.entries, []);
  assert.deepEqual(io.writeJSONCalls[0].options, {
    tmpPath: "/records/1--ABCDEFGH.json.tmp"
  });
});

test("homepage smart-tag probes are exact and never mutate cache files", async () => {
  const { cache, io } = makeCache();
  const paper = makePaper();
  await cache.append(paper, entry({
    kind: "smart-tags",
    normalizedSource: "source-a",
    sourceSignature: "source-a",
    configSignature: "tag-config-a",
    tags: ["World Model", "Planning", "Reinforcement Learning"]
  }));
  const writesBeforeProbe = io.writeJSONCalls.length;
  const hit = await cache.peekSmartTags(paper, {
    sourceSignature: "source-a",
    configSignature: "tag-config-a"
  });
  const miss = await cache.peekSmartTags(paper, {
    sourceSignature: "source-a",
    configSignature: "tag-config-b"
  });
  assert.deepEqual(hit.tags, ["World Model", "Planning", "Reinforcement Learning"]);
  assert.equal(miss, null);
  assert.equal(io.writeJSONCalls.length, writesBeforeProbe);
});

test("homepage smart-tag probes skip corrupt records without recovery writes", async () => {
  const io = new MemoryIO();
  const errors = [];
  const { cache } = makeCache({ io, onError: (message) => errors.push(message) });
  const paper = makePaper();
  io.setText("/records/1--ABCDEFGH.json", "{not-json");
  const result = await cache.peekSmartTags(paper, {
    sourceSignature: "source-a",
    configSignature: "tag-config-a"
  });
  assert.equal(result, null);
  assert.equal(errors.length, 1);
  assert.equal(io.writeJSONCalls.length, 0);
  assert.deepEqual([...io.files.keys()], ["/records/1--ABCDEFGH.json"]);
});
