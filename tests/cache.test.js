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

test("replacing a matching cache entry preserves its identity and other variants", async () => {
  const { cache, io } = makeCache();
  const paper = makePaper();
  const original = await cache.append(paper, entry({ translation: "模型（旧）" }));
  await cache.append(paper, entry({
    translation: "模型（另一配置）",
    configSignature: "signature-b"
  }));

  const replacement = await cache.replaceMatching(paper, entry({
    translation: "模型（新）",
    createdAt: "2026-08-20T00:00:00.000Z",
    lastUsedAt: "2026-08-20T00:00:00.000Z"
  }));
  const entries = await cache.getAllEntries(paper);

  assert.equal(replacement.id, original.id);
  assert.equal(replacement.translation, "模型（新）");
  assert.equal(entries.length, 2);
  assert.equal(entries.find((candidate) => candidate.configSignature === "signature-a").translation, "模型（新）");
  assert.equal(entries.find((candidate) => candidate.configSignature === "signature-b").translation, "模型（另一配置）");
  assert.deepEqual(io.writeJSONCalls.at(-1).options, {
    tmpPath: "/records/1--ABCDEFGH.json.tmp"
  });
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

test("deleting a glossary term removes every configuration variant only in its paper", async () => {
  const { cache, io } = makeCache();
  const paper = makePaper();
  const otherPaper = makePaper({ storageKey: "1--OTHERKEY", itemKey: "OTHERKEY" });
  await cache.append(paper, entry());
  await cache.append(paper, entry({ configSignature: "signature-b" }));
  const policy = await cache.append(paper, entry({ source: "policy", normalizedSource: "policy" }));
  const abstract = await cache.append(paper, entry({ kind: "abstract", isTerm: false }));
  const tags = await cache.append(paper, entry({ kind: "smart-tags", isTerm: false, tags: ["model"] }));
  const other = await cache.append(otherPaper, entry());

  assert.equal(await cache.deleteTerm(paper, "  model  "), 2);
  const reloaded = makeCache({ io }).cache;
  assert.deepEqual(await reloaded.getAllEntries(paper), [policy, abstract, tags]);
  assert.deepEqual(await reloaded.getGlossary(paper), [policy]);
  assert.deepEqual(await reloaded.getAllEntries(otherPaper), [other]);
  assert.deepEqual(io.writeJSONCalls.at(-1).options, { tmpPath: "/records/1--ABCDEFGH.json.tmp" });
  const writeCount = io.writeJSONCalls.length;
  assert.equal(await cache.deleteTerm(paper, "model"), 0);
  assert.equal(io.writeJSONCalls.length, writeCount);
  await assert.rejects(cache.deleteTerm(paper, " "), { code: "SOURCE_EMPTY" });
});

test("term deletion serializes with writes and a late cache touch cannot restore it", async () => {
  const { cache } = makeCache();
  const paper = makePaper();
  const first = await cache.append(paper, entry());
  const [, count, touched] = await Promise.all([
    cache.replaceMatching(paper, entry({ translation: "新模型" })),
    cache.deleteTerm(paper, "model"),
    cache.touch(paper, first.id),
    cache.append(paper, entry({ source: "policy", normalizedSource: "policy" }))
  ]);
  assert.equal(count, 1);
  assert.equal(touched, null);
  assert.deepEqual((await cache.getGlossary(paper)).map((term) => term.source), ["policy"]);
});

test("failed term deletion preserves the saved entry and permits a retry", async () => {
  const { cache, io } = makeCache();
  const paper = makePaper();
  const original = await cache.append(paper, entry());
  const writeJSON = io.writeJSON.bind(io);
  io.writeJSON = async () => { throw new Error("disk full"); };
  await assert.rejects(cache.deleteTerm(paper, "model"), /disk full/u);
  assert.deepEqual(await cache.getAllEntries(paper), [original]);
  io.writeJSON = writeJSON;
  assert.equal(await cache.deleteTerm(paper, "model"), 1);
  assert.deepEqual(await cache.getGlossary(paper), []);
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
