"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { FulltextService, parseAnswer, publicConfig } = require("../plugin/content/fulltext-service.js");
const hash = value => createHash("sha256").update(value).digest("hex");
const Markdown = require("../plugin/content/fulltext-markdown.js");
const { validateSource, editableBlocks } = Markdown;
const { OpenAIChatClient } = require("../plugin/content/api.js");
const units = text => [{ id: "t0", text }];
const encode = value => JSON.stringify({ translations: Array.isArray(value) ? value : units(value) });
const plain = value => value.map(part => part.text).join("");
function setup(overrides = {}) {
  const files = new Map(); const calls = []; let imports = 0;
  const config = { provider: "deepseek", endpoint: "https://api.deepseek.com/chat/completions", model: "test", oxrBaseURL: "https://example.test/api/v1" };
  const codec = {
    validateSource, editableBlocks,
    createPlan: source => ({ segments: source.split(/(?<=\n)/u).map((text, i) => ({ id: String(i + 1), source: text, translatable: Boolean(text.trim()) && !text.startsWith("[1]") })), referenceCount: 1 }),
    prepareSegment: s => ({ version: 2, id: s.id, source: s.source, parts: [], units: units(s.source), context: [{ id: "t0" }] }),
    restoreTranslation: (prepared, value) => {
      assert.deepEqual(value.map(part => part.id), prepared.units.map(part => part.id));
      const text = plain(value); if (text === "BAD") throw new Error("invalid format"); return text;
    },
    validateRestored: (_s, value) => { if (value === "BAD") throw new Error("bad checkpoint"); return value; },
    assemble: (plan, translations) => plan.segments.map(s => s.translatable ? translations[s.id] : s.source).join("")
  };
  const storage = {
    readJSON: async name => files.has(name) ? JSON.parse(files.get(name)) : null,
    writeJSON: async (name, value) => files.set(name, JSON.stringify(value)),
    readText: async name => files.get(name) ?? null,
    writeText: async (name, value) => files.set(name, value)
  };
  const args = { identity: "source-identity", storage, hash, verifySource: async () => {}, getConfig: () => config,
    convert: async () => { calls.push("convert"); files.set("source.md", "First paragraph.\n[1] Author. Title. 2020.\nSecond paragraph."); return { pageCount: 2 }; },
    preview: async ({ page }) => ({ page }),
    complete: async options => { calls.push(JSON.parse(options.prompt)); return encode(JSON.parse(options.prompt).source); },
    createPDF: async () => calls.push("pdf"), importPDF: async () => { imports++; return 9; },
    exportMarkdown: async () => true, markdown: codec, ...overrides };
  const service = new FulltextService(args);
  return { service, args, files, calls, config, imports: () => imports };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function until(predicate, description) {
  for (let turn = 0; turn < 100; turn++) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail(`Did not observe ${description}`);
}
async function flushJobs() { await new Promise(resolve => setImmediate(resolve)); }
function controlledCompletions() {
  const requests = []; let active = 0, maximum = 0;
  const complete = options => {
    const input = JSON.parse(options.prompt), gate = deferred();
    const request = { input, phase: Object.hasOwn(input, "draft") ? "reviewing" : "translating",
      cancelled: 0, settled: false,
      succeed: (translation = input.source) => gate.resolve(encode(translation)),
      fail: (message = "offline") => gate.reject(Object.assign(new Error(message), { code: "API_NETWORK" })) };
    requests.push(request); active++; maximum = Math.max(maximum, active);
    const unregister = options.registerCancel(() => { request.cancelled++; });
    return gate.promise.finally(() => { request.settled = true; active--; unregister(); });
  };
  return { complete, requests, get active() { return active; }, get maximum() { return maximum; } };
}
async function preparedParagraphs(x, count) {
  await x.service.parse({ consent: true });
  await x.service.confirm(Array.from({ length: count }, (_, index) => `Paragraph ${index + 1}.\n`).join(""));
}
async function prepared(setupResult) {
  await setupResult.service.parse({ consent: true });
  await setupResult.service.confirm(setupResult.service.source);
}
function withPageMap(x, pages = ["# Page one", "Second $x$"]) {
  x.service.sourceHash = "a".repeat(64);
  const convert = x.service.convert;
  x.service.convert = async options => {
    const result = await convert(options);
    const raw = JSON.stringify({ schema: 1, sourceHash: x.service.sourceHash, markdownHash: hash(x.files.get("source.md")), pageCount: result.pageCount, pages });
    const pageMapFile = `pages-${hash(raw)}.json`; x.files.set(pageMapFile, raw);
    return { ...result, pageMapFile };
  };
  return x;
}

async function repairPages(pages) {
  const x = setup({ markdown: Markdown });
  x.service.convert = async () => { x.files.set("source.md", "Independent OCR source."); return { pageCount: pages.length }; };
  withPageMap(x, pages); await prepared(x);
  const segments = x.service.plan.segments.filter(segment => segment.translatable);
  // Persist in reverse order to ensure callers receive plan order, not dictionary order.
  for (const segment of segments.slice().reverse()) {
    x.service.state.pendingSegments[segment.id] = { draft: "PRIVATE DRAFT", error: "PRIVATE ERROR" };
  }
  await x.service.save();
  return { ...x, segments };
}

test("repair summaries locate duplicate paragraphs in exact plan order across protected and blank blocks", async () => {
  const x = await repairPages(["Same paragraph.\n\n```text\nProtected\n```", "Same paragraph."]);
  const expected = x.segments.map((segment, index) => ({ id: segment.id, excerpt: "Same paragraph.", page: index + 1, endPage: index + 1 }));
  assert.deepEqual(x.service.getRepairSummaries(), expected);
  const loaded = new FulltextService({ ...x.args, sourceHash: x.service.sourceHash }); await loaded.load();
  assert.deepEqual(loaded.getRepairSummaries(), expected);
  assert.deepEqual(loaded.snapshot().repairSegments, x.segments.map(segment => ({ id: segment.id, error: "PRIVATE ERROR" })));
});

test("repair summary ranges include true cross-page blocks and exclude trailing separators", async () => {
  const x = await repairPages(["<table><tr><td>Across", "pages</td></tr></table>\n\nLast paragraph.", "Next page."]);
  assert.deepEqual(x.service.getRepairSummaries().map(({ page, endPage }) => [page, endPage]), [[1, 2], [2, 2], [3, 3]]);
  assert.equal(x.service.getRepairSummaries()[0].excerpt, "<table><tr><td>Across pages</td></tr></table>");
});

test("repair locations account for exact two-LF separators, empty pages and page-owned trailing whitespace", async () => {
  const x = await repairPages(["", "One.\n", "", "Two.\n\n", ""]);
  assert.deepEqual(x.service.getRepairSummaries().map(({ excerpt, page, endPage }) => ({ excerpt, page, endPage })), [
    { excerpt: "One.", page: 2, endPage: 2 }, { excerpt: "Two.", page: 4, endPage: 4 }
  ]);
  const cross = await repairPages(["<table><tr><td>Before", "", "After</td></tr></table>"]);
  assert.deepEqual(cross.service.getRepairSummaries().map(({ page, endPage }) => [page, endPage]), [[1, 3]]);
});

test("repair summaries only expose current pending translatable unfinished segments as isolated read-only objects", async () => {
  const x = await repairPages(["First.\n\nSecond.\n\n```text\nCode\n```", "Third."]);
  const [first, second, third] = x.segments;
  x.service.state.translations[first.id] = "Completed.";
  delete x.service.state.pendingSegments[second.id];
  x.service.state.pendingSegments.orphan = { draft: "ORPHAN DRAFT", error: "orphan" };
  const protectedSegment = x.service.plan.segments.find(segment => !segment.translatable);
  x.service.state.pendingSegments[protectedSegment.id] = { draft: "PROTECTED DRAFT", error: "protected" };
  const before = JSON.stringify({ state: x.service.state, plan: x.service.plan, source: x.service.source, pages: x.service.documentPages });
  const files = [...x.files], calls = x.calls.slice();
  const forbidden = () => assert.fail("summary lookup must not read/write storage, hash, verify, emit, or request anything");
  for (const name of ["readJSON", "writeJSON", "readText", "writeText"]) x.service.storage[name] = forbidden;
  for (const name of ["hash", "verifySource", "getConfig", "convert", "complete", "createPDF", "importPDF", "exportMarkdown", "emit"]) x.service[name] = forbidden;
  const firstRead = x.service.getRepairSummaries();
  assert.deepEqual(firstRead, [{ id: third.id, excerpt: "Third.", page: 2, endPage: 2 }]);
  firstRead[0].excerpt = "changed"; firstRead[0].page = 99; firstRead.push({ id: "extra" });
  const secondRead = x.service.getRepairSummaries();
  assert.deepEqual(secondRead, [{ id: third.id, excerpt: "Third.", page: 2, endPage: 2 }]);
  assert.notEqual(firstRead[0], secondRead[0]);
  assert.doesNotMatch(JSON.stringify(secondRead), /DRAFT|ERROR|draft|error/u);
  assert.equal(JSON.stringify({ state: x.service.state, plan: x.service.plan, source: x.service.source, pages: x.service.documentPages }), before);
  assert.deepEqual([...x.files], files); assert.deepEqual(x.calls, calls); assert.equal(x.imports(), 0);
});

test("repair excerpts normalize a bounded Unicode prefix and never exceed 80 code points or split surrogates", () => {
  for (const [source, expected] of [
    ["  Alpha\t\u3000Beta\n Gamma  ", "Alpha Beta Gamma"],
    ["😀".repeat(80), "😀".repeat(80)],
    ["😀".repeat(81), "😀".repeat(79) + "…"],
    ["中".repeat(100000), "中".repeat(79) + "…"],
    [" ".repeat(100000) + "Hidden tail", "…"],
    ["e\u0301".repeat(41), ("e\u0301".repeat(40)).slice(0, 79) + "…"]
  ]) {
    const x = setup();
    x.service.plan = { segments: [{ id: "one", source, translatable: true }] };
    x.service.state.pendingSegments.one = { draft: "not source", error: "" };
    const original = String.prototype.codePointAt; let scanned = 0, summaries;
    try {
      String.prototype.codePointAt = function (...args) { scanned++; return original.apply(this, args); };
      summaries = x.service.getRepairSummaries();
    } finally { String.prototype.codePointAt = original; }
    assert.ok(scanned <= 160, `scanned ${scanned} code points`);
    assert.equal(summaries[0].excerpt, expected);
    assert.ok(Array.from(summaries[0].excerpt).length <= 80);
    assert.doesNotMatch(summaries[0].excerpt, /[\uD800-\uDFFF]/u);
    assert.equal(summaries[0].page, null); assert.equal(summaries[0].endPage, null);
  }
});

test("repair locations fail closed for changed, invalid or unverified bindings while excerpts remain available", async () => {
  for (const mutate of [
    service => { service.documentError = "corrupt"; },
    service => { service.state.documentSourceHash = "b".repeat(64); },
    service => { service.state.translationProtocol = 1; },
    service => { service.state.approvedHash = "invalid"; service.state.documentSourceHash = "invalid"; },
    service => { service.state.approvedHash = "b".repeat(64); service.state.documentSourceHash = "b".repeat(64); },
    service => { service.approvedSourceBinding = null; },
    service => { service.source += "changed"; },
    service => { service.documentPages = ["First.", "Incorrect."]; },
    service => { service.documentPages = ["First.", null]; },
    service => { service.state.pageCount = 3; },
    service => { service.plan.segments.at(-1).source += "changed"; },
    service => { service.plan.segments.push({ id: "bad", source: null }); },
    service => { service.plan.segments.pop(); },
    service => { service.documentPages = null; } // The valid independent pageMap is never used.
  ]) {
    const x = await repairPages(["First.", "Second."]); mutate(x.service);
    const summaries = x.service.getRepairSummaries();
    assert.ok(summaries.length > 0);
    assert.ok(summaries.every(summary => summary.excerpt && summary.page === null && summary.endPage === null));
  }
});

test("reloaded changed, legacy and corrupt unified documents preserve excerpts without invented page locations", async () => {
  for (const kind of ["changed", "legacy", "corrupt"]) {
    const x = await repairPages(["First.", "Second."]);
    if (kind === "changed") await x.service.editBlock({ page: 1, index: 0, revision: x.service.state.documentFile, text: "Edited source." });
    else if (kind === "legacy") {
      delete x.service.state.documentFile; delete x.service.state.documentSourceHash; await x.service.save();
    } else x.files.set(x.service.state.documentFile, "{}");
    const files = [...x.files];
    const loaded = new FulltextService({ ...x.args, sourceHash: x.service.sourceHash }); await loaded.load();
    assert.deepEqual(loaded.getRepairSummaries(), x.segments.map(segment => ({ id: segment.id, excerpt: segment.source.trim(), page: null, endPage: null })), kind);
    assert.deepEqual([...x.files], files);
  }
});

test("no-plan, legacy protocol and corrupt approved records do not expose stale draft summaries", async () => {
  const fresh = setup(); fresh.service.state.pendingSegments.orphan = { draft: "stale", error: "failure" };
  assert.deepEqual(fresh.service.getRepairSummaries(), []);
  for (const kind of ["protocol", "approved"]) {
    const x = await repairPages(["First.", "Second."]);
    if (kind === "protocol") { x.service.state.translationProtocol = 1; await x.service.save(); }
    else x.files.set(`approved-${x.service.state.approvedHash}.md`, "corrupt");
    const loaded = new FulltextService({ ...x.args, sourceHash: x.service.sourceHash });
    if (kind === "approved") await assert.rejects(loaded.load(), /检查点/u);
    else await loaded.load();
    assert.deepEqual(loaded.getRepairSummaries(), []);
  }
});

test("cancelPreview rejects a late preview without cancelling active model work or changing checkpoints", async () => {
  const model = controlledCompletions(), image = deferred(); let cancelled = 0;
  const x = setup({ complete: model.complete, preview: options => {
    const unregister = options.registerCancel(() => { cancelled++; });
    return image.promise.finally(unregister);
  } });
  await preparedParagraphs(x, 1);
  const translation = x.service.translate({ consent: true });
  await until(() => model.requests.length === 1, "active translation");
  const preview = x.service.preview(1), rejected = assert.rejects(preview, /预览已取消/u);
  const before = { state: JSON.stringify(x.service.state), files: [...x.files], serial: x.service.serial,
    cancelled: x.service.cancelled, operation: x.service.operation, previewSerial: x.service.previewSerial };
  assert.equal(x.service.cancelPreview(), undefined);
  assert.equal(cancelled, 1); assert.equal(model.requests[0].cancelled, 0);
  assert.equal(x.service.previewSerial, before.previewSerial + 1);
  assert.equal(x.service.serial, before.serial); assert.equal(x.service.cancelled, before.cancelled);
  assert.equal(x.service.operation, before.operation); assert.equal(JSON.stringify(x.service.state), before.state);
  assert.deepEqual([...x.files], before.files);
  image.resolve({ page: 1, image: "late" }); await rejected;
  assert.equal(x.service.previews.size, 0); assert.equal(x.service.previewCancellers.size, 0);
  model.requests[0].succeed(); await until(() => model.requests.length === 2, "review after preview cancellation");
  model.requests[1].succeed(); await translation;
  assert.equal(x.service.snapshot().completed, 1);
  assert.ok(model.requests.every(request => request.cancelled === 0));
});

test("preview cancellation safely copies callbacks; replacing previews and pausing reuse it and pause awaits cleanup", async () => {
  const x = setup(), called = [];
  const second = () => called.push("second");
  x.service.previewCancellers.add(() => { called.push("first"); x.service.previewCancellers.delete(second); throw new Error("cancel failed"); });
  x.service.previewCancellers.add(second);
  x.service.cancellers.add(() => assert.fail("preview cancellation must not cancel model work"));
  x.service.cancelPreview(); assert.deepEqual(called, ["first", "second"]);
  x.service.previewCancellers.clear(); x.service.cancellers.clear();
  const images = [], cancelled = [];
  x.service.previewPage = options => {
    const image = deferred(), index = images.length; images.push(image);
    const unregister = options.registerCancel(() => cancelled.push(index));
    return image.promise.finally(unregister);
  };
  let invocations = 0; const cancelPreview = x.service.cancelPreview.bind(x.service);
  x.service.cancelPreview = () => { invocations++; cancelPreview(); };
  const first = x.service.preview(1), firstRejected = assert.rejects(first, /预览已取消/u);
  const next = x.service.preview(2), nextRejected = assert.rejects(next, /预览已取消/u);
  assert.deepEqual(cancelled, [0]);
  let paused = false; const pausing = x.service.pause().then(() => { paused = true; });
  assert.equal(invocations, 3); assert.deepEqual(cancelled, [0, 0, 1]);
  images[0].resolve({ page: 1 }); await firstRejected; await flushJobs(); assert.equal(paused, false);
  images[1].resolve({ page: 2 }); await nextRejected; await pausing;
  assert.equal(paused, true); assert.equal(x.service.previews.size, 0);
});

test("both passes accept Chinese formula word order and prompts require whole-paragraph proofreading", async () => {
  const requests = [], response = [{ id: "t0", text: "。" }, { id: "t1", text: "的采样遵循多尺度分块协议。" }];
  const x = setup({ markdown: Markdown, complete: async options => { requests.push(options); return encode(response); } });
  await x.service.parse({ consent: true }); await x.service.confirm(". The sampling of $C$ follows a multi-scale patching protocol.\n");
  const signature = x.service.state.signature;
  await x.service.translate({ consent: true });
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.match(request.systemMessage, /punctuation-only/u);
    assert.match(request.systemMessage, /whole paragraph/u);
    assert.doesNotMatch(request.systemMessage, /or move meaning between parts/u);
  }
  assert.deepEqual(JSON.parse(requests[1].prompt).draft, response);
  assert.equal(x.service.translated, "。 $C$ 的采样遵循多尺度分块协议。\n");
  const loaded = new FulltextService(x.args); await loaded.load();
  assert.equal(loaded.state.signature, signature); assert.equal(loaded.state.translationProtocol, 2);
  assert.equal(loaded.snapshot().completed, 1); assert.equal(loaded.translated, x.service.translated);
  await loaded.translate({ consent: true }); assert.equal(requests.length, 2);
});

test("a saved protocol2 punctuation draft can be repaired locally then reviewed without retranslating completed paragraphs", async () => {
  const requests = [], response = [{ id: "t0", text: "。" }, { id: "t1", text: "的采样遵循协议。" }];
  const x = setup({ markdown: Markdown, complete: async options => { const input = JSON.parse(options.prompt); requests.push(input); return encode(response); } });
  await x.service.parse({ consent: true }); await x.service.confirm("Completed paragraph.\n\n. The sampling of $C$ follows a protocol.\n");
  const [first, second] = x.service.plan.segments.filter(s => s.translatable);
  const state = JSON.parse(x.files.get("state.json"));
  state.translations[first.id] = "已完成段落。\n";
  state.pendingSegments[second.id] = { draft: encode(response), error: "全文 Markdown：正文内容缺失" };
  state.stage = "paused"; x.files.set("state.json", JSON.stringify(state));
  const loaded = new FulltextService(x.args); await loaded.load();
  assert.equal(loaded.snapshot().completed, 1); assert.equal(loaded.state.signature, state.signature);
  await loaded.setDraft(encode(response)); assert.equal(requests.length, 0);
  assert.equal(loaded.snapshot().completed, 1);
  await loaded.translate({ consent: true });
  assert.equal(requests.length, 1); assert.deepEqual(requests[0].draft, response);
  assert.equal(loaded.state.translations[first.id], state.translations[first.id]);
  assert.equal(loaded.snapshot().completed, 2);
});

test("Unicode whitespace is locally retained through both structured model passes", async () => {
  const seen = [];
  const x = setup({ markdown: Markdown, complete: async options => {
    const input = JSON.parse(options.prompt); seen.push(input);
    assert.deepEqual(input.source, [{ id: "t0", text: "A" }, { id: "t1", text: "B" }]);
    return JSON.stringify({ translations: [{ id: "t0", text: "甲" }, { id: "t1", text: "乙" }] });
  } });
  await x.service.parse({ consent: true }); await x.service.confirm("\u3000A $x$\u00a0$y$ B\u2009");
  await x.service.translate({ consent: true });
  assert.equal(seen.length, 2);
  assert.equal(x.service.translated, "\u3000甲 $x$\u00a0$y$ 乙\u2009");
});

test("large segments traverse real protection, both model passes and checkpoint reload", async () => {
  const requests = [], source = "原".repeat(128000), translation = "译".repeat(256000);
  const client = new OpenAIChatClient({ request: async (_method, _url, options) => {
    requests.push(options);
    return { response: { choices: [{ finish_reason: "stop", message: { content: encode(translation) } }] } };
  } });
  const x = setup({ markdown: Markdown, complete: options => client.complete({ ...options, apiKey: "sk-test" }) });
  await x.service.parse({ consent: true }); await x.service.confirm(source);
  await x.service.translate({ consent: true });
  assert.equal(x.service.translated, translation);
  assert.equal(x.files.get("translated.md"), translation);
  assert.equal(requests.length, 2);
  for (const options of requests) {
    assert.equal(options.timeout, 900000);
    const payload = JSON.parse(options.body);
    assert.equal(payload.max_tokens, 131072);
    assert.deepEqual(payload.thinking, { type: "disabled" });
    assert.deepEqual(JSON.parse(payload.messages[1].content).source, units(source));
  }
  assert.deepEqual(JSON.parse(JSON.parse(requests[1].body).messages[1].content).draft, units(translation));
  const loaded = new FulltextService(x.args); await loaded.load();
  assert.equal(loaded.translated, translation);
  await loaded.translate({ consent: true }); assert.equal(requests.length, 2);
});

test("JSON response permits full escaped translations but independently rejects oversized envelope or text", () => {
  const limit = Markdown.MAX_TRANSLATION_LENGTH;
  const escaped = '{"translations":[{"id":"t0","text":"' + "\\u4e2d".repeat(limit) + '"}]}';
  assert.ok(escaped.length > 96000);
  assert.deepEqual(parseAnswer(escaped), units("中".repeat(limit)));
  assert.deepEqual(parseAnswer(encode("中".repeat(limit))), units("中".repeat(limit)));
  assert.throws(() => parseAnswer(encode("中".repeat(limit + 1))), /输出上限/u);
  assert.equal(Markdown.MAX_RESPONSE_LENGTH, 6 * limit + 128 * 4096 + 64);
  assert.throws(() => parseAnswer(encode("a") + " ".repeat(Markdown.MAX_RESPONSE_LENGTH)), /上限/u);
});

test("server truncation pauses either model pass without accepting a checkpoint or automatic retries", async () => {
  for (const truncatedPass of [1, 2]) {
    let requests = 0;
    const client = new OpenAIChatClient({ request: async (_method, _url, options) => {
      requests++;
      const source = JSON.parse(JSON.parse(options.body).messages[1].content).source;
      return { response: { choices: [{ finish_reason: requests === truncatedPass ? "length" : "stop",
        message: { content: encode(source) } }] } };
    } });
    const x = setup({ markdown: Markdown, complete: options => client.complete({ ...options, apiKey: "sk-test" }) });
    await x.service.parse({ consent: true }); await x.service.confirm("a".repeat(20000));
    await assert.rejects(x.service.translate({ consent: true }), /截断/u);
    assert.equal(requests, truncatedPass);
    assert.equal(x.service.snapshot().stage, "paused");
    assert.deepEqual(x.service.state.translations, {});
    assert.equal(x.files.has("translated.md"), false);
  }
});

test("long-timeout fulltext requests remain immediately cancellable and ignore late success", async () => {
  let entered, release, cancelled = 0, requests = 0;
  const waiting = new Promise(resolve => { entered = resolve; });
  const client = new OpenAIChatClient({ request: async (_method, _url, options) => {
    requests++; assert.equal(options.timeout, 900000);
    options.cancellerReceiver(() => { cancelled++; release(); });
    await new Promise(resolve => { release = resolve; entered(); });
    return { response: { choices: [{ finish_reason: "stop", message: { content: encode("late") } }] } };
  } });
  const x = setup({ markdown: Markdown, complete: options => client.complete({ ...options, apiKey: "sk-test" }) });
  await x.service.parse({ consent: true }); await x.service.confirm("a".repeat(20000));
  const translation = x.service.translate({ consent: true });
  const rejection = assert.rejects(translation, /暂停/u);
  await waiting; await x.service.pause(); await rejection;
  assert.equal(cancelled, 1); assert.equal(requests, 1);
  assert.equal(x.service.cancellers.size, 0);
  assert.deepEqual(x.service.state.translations, {});
  assert.equal(x.files.has("translated.md"), false);
});

test("new parses unify complete OCR pages without overwriting raw source or its backup", async () => {
  const x = withPageMap(setup()); await x.service.parse({ consent: true });
  const rawSource = x.files.get("source.md");
  // Approved boundary change: complete reconstructed pages now own all editable/translated source.
  assert.equal(x.service.source, "# Page one\n\nSecond $x$");
  assert.notEqual(x.service.source, rawSource);
  assert.equal(x.service.state.originalHash, hash(rawSource));
  assert.equal(x.files.get(`original-${hash(rawSource)}.md`), rawSource);
  assert.equal(x.service.getPageMarkdown(1), "# Page one");
  assert.equal(x.service.getPageMarkdown(2), "Second $x$");
  assert.equal(x.service.getPageMarkdown(0), null);
  assert.equal(x.service.getPageMarkdown(3), null);
  assert.ok(!Object.hasOwn(x.service.snapshot(), "documentPages"));
  assert.ok(!Object.hasOwn(x.service.snapshot(), "pageMap"));
  assert.equal(x.service.snapshot().editingReady, true);
  await assert.rejects(x.service.confirm("Detached entire source"), /统一编辑稿/u);
  await x.service.confirm(x.service.source);
  const loaded = new FulltextService({ ...x.args, sourceHash: x.service.sourceHash }); await loaded.load();
  assert.equal(loaded.source, x.service.source);
  assert.equal(loaded.getPageMarkdown(2), "Second $x$");
  x.files.set(loaded.state.pageMapFile, "{}");
  await loaded.load();
  assert.equal(loaded.getPageMarkdown(1), null);
  assert.match(loaded.snapshot().pagePreviewError, /逐页/u);
  assert.match(loaded.snapshot().documentError, /编辑稿/u);
  assert.equal(loaded.source, x.service.source); // Corrupt page data cannot replace the approved source.
  assert.equal(loaded.snapshot().editingReady, false);
});

test("page maps reject wrong hashes, PDF identity, count and malformed page entries before switching source", async () => {
  for (const corrupt of [map => { map.sourceHash = "b".repeat(64); }, map => { map.markdownHash = "b".repeat(64); },
    map => { map.pageCount = 3; }, map => { map.pages = ["only one"]; }, map => { map.pages[0] = {}; }]) {
    const x = withPageMap(setup()), convert = x.service.convert;
    x.service.source = "Old source";
    x.service.convert = async options => {
      const result = await convert(options), map = JSON.parse(x.files.get(result.pageMapFile)); corrupt(map);
      const raw = JSON.stringify(map); result.pageMapFile = `pages-${hash(raw)}.json`; x.files.set(result.pageMapFile, raw);
      return result;
    };
    await assert.rejects(x.service.parse({ consent: true }), /逐页/u);
    assert.equal(x.service.source, "Old source");
  }
  const x = withPageMap(setup(), [null, ""]); await x.service.parse({ consent: true });
  assert.equal(x.service.getPageMarkdown(1), null); assert.equal(x.service.getPageMarkdown(2), "");
});

test("reparse needs explicit reset consent, archives approved checkpoint, and only switches after success", async () => {
  const x = withPageMap(setup()); await prepared(x); await x.service.translate({ consent: true });
  const previous = x.service.snapshot(), approvedHash = x.service.state.approvedHash;
  await assert.rejects(x.service.parse({ consent: true }), /确认稿/u);
  x.service.convert = async () => { throw new Error("offline"); };
  await assert.rejects(x.service.parse({ consent: true, replaceApproved: true }), /offline/u);
  assert.equal(x.service.source, previous.source); assert.equal(x.service.translated, previous.translated);
  assert.equal(x.service.state.approvedHash, approvedHash); assert.equal(x.service.getPageMarkdown(1), "# Page one");
  const archives = [...x.files.keys()].filter(name => /^history-[a-f0-9]{64}\.json$/u.test(name));
  assert.equal(archives.length, 1);
  assert.equal(JSON.parse(x.files.get(archives[0])).approvedHash, approvedHash);
  x.service.convert = async () => { x.files.set("source.md", "Fresh source"); return { pageCount: 1 }; };
  await x.service.parse({ consent: true, replaceApproved: true });
  assert.equal(x.service.source, "Fresh source"); assert.equal(x.service.translated, "");
  assert.equal(x.service.state.approvedHash, undefined); assert.deepEqual(x.service.state.translations, {});
  assert.equal(x.files.get(`approved-${approvedHash}.md`), previous.source);
  assert.equal(x.service.getPageMarkdown(1), null); assert.equal(x.imports(), 0);
});

test("uncertain imports and failed archival/commit block destructive reparse", async () => {
  const x = withPageMap(setup()); await prepared(x);
  x.service.state.importIntent = true;
  await assert.rejects(x.service.parse({ consent: true, replaceApproved: true }), /导入/u);
  x.service.state.importIntent = false;
  const convert = x.service.convert, write = x.service.storage.writeJSON;
  let conversions = 0; x.service.convert = async options => { conversions++; return convert(options); };
  x.service.storage.writeJSON = async (name, value) => {
    if (name.startsWith("history-")) throw new Error("archive failed"); return write(name, value);
  };
  await assert.rejects(x.service.parse({ consent: true, replaceApproved: true }), /archive/u);
  assert.equal(conversions, 0); assert.ok(x.service.state.approvedHash);
  x.service.storage.writeJSON = async (name, value) => {
    if (name === "state.json" && value.stage === "review") throw new Error("commit failed"); return write(name, value);
  };
  const before = x.service.source;
  await assert.rejects(x.service.parse({ consent: true, replaceApproved: true }), /commit/u);
  assert.equal(x.service.source, before); assert.ok(x.service.state.approvedHash);
  assert.equal(x.service.getPageMarkdown(1), "# Page one");
});

test("cancelled page-map reads cannot switch an approved task or expose late page data", async () => {
  const x = withPageMap(setup()); await prepared(x);
  const before = x.service.source, map = x.service.pageMap;
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const read = x.service.storage.readText;
  x.service.storage.readText = async name => {
    if (name.startsWith("pages-")) { entered(); await new Promise(resolve => { release = resolve; }); }
    return read(name);
  };
  const parsing = x.service.parse({ consent: true, replaceApproved: true });
  await waiting;
  const rejected = assert.rejects(parsing, /暂停/u), pausing = x.service.pause(); release();
  await pausing; await rejected;
  assert.equal(x.service.source, before); assert.equal(x.service.pageMap, map); assert.ok(x.service.state.approvedHash);
  await assert.rejects(x.service.readPageMap("../secret.json", 2, hash(before)), /逐页/u);
});

test("pause during final reparse commit restores old state on disk without publishing new review", async () => {
  const x = withPageMap(setup()); await prepared(x); await x.service.translate({ consent: true });
  const approvedHash = x.service.state.approvedHash, translated = x.service.translated;
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const write = x.service.storage.writeJSON;
  x.service.storage.writeJSON = async (name, value) => {
    if (name === "state.json" && value.stage === "review") { entered(); await new Promise(resolve => { release = resolve; }); }
    return write(name, value);
  };
  const snapshots = [], unsubscribe = x.service.subscribe(value => snapshots.push(value));
  const parsing = x.service.parse({ consent: true, replaceApproved: true }); await waiting;
  assert.equal(x.service.state.approvedHash, approvedHash);
  const rejected = assert.rejects(parsing, /暂停/u), pausing = x.service.pause(); release();
  await pausing; await rejected;
  assert.equal(x.service.state.approvedHash, approvedHash); assert.equal(x.service.translated, translated);
  assert.equal(JSON.parse(x.files.get("state.json")).approvedHash, approvedHash);
  assert.ok(snapshots.every(value => value.approvedHash === approvedHash));
  assert.equal(x.service.snapshot().parseProgress.phase, "paused"); unsubscribe();
});

test("parse progress tracks real ranges, isolates snapshots and is not persisted as live remote state", async () => {
  const x = setup(); const convert = x.service.convert; let late;
  x.service.convert = async options => {
    late = options.onProgress;
    late({ phase: "planning", pageCount: 21 });
    late({ phase: "chunk", start: 1, end: 20, status: "pending" });
    late({ phase: "chunk", start: 21, end: 21, status: "pending" });
    late({ phase: "parsing" });
    for (const status of ["uploading", "submitted", "queuing", "processing", "complete"]) late({ phase: "chunk", start: 1, end: 20, status });
    const snapshot = x.service.snapshot();
    assert.equal(snapshot.parseProgress.chunks[0].status, "complete");
    snapshot.parseProgress.chunks[1].status = "bad";
    assert.equal(x.service.snapshot().parseProgress.chunks[1].status, "pending");
    late({ phase: "chunk", start: 21, end: 21, status: "complete" });
    late({ phase: "assembling" });
    assert.equal(x.service.snapshot().parseProgress.phase, "assembling");
    await convert(); return { pageCount: 21 };
  };
  await x.service.parse({ consent: true });
  const before = x.service.snapshot().parseProgress;
  assert.equal(before.phase, "complete"); assert.ok(before.elapsedMS >= 0);
  late({ phase: "planning", pageCount: 99 });
  assert.deepEqual(x.service.snapshot().parseProgress, before);
  assert.ok(!x.files.get("state.json").includes("parseProgress"));
});
test("pause preserves completed chunks, freezes elapsed time and ignores late parse events", async () => {
  const x = setup(); let report, finish;
  x.service.convert = options => new Promise(resolve => {
    report = options.onProgress; finish = resolve;
    report({ phase: "planning", pageCount: 2 });
    for (const start of [1, 2]) report({ phase: "chunk", start, end: start, status: "pending" });
    report({ phase: "parsing" });
    report({ phase: "chunk", start: 1, end: 1, status: "complete" });
    report({ phase: "chunk", start: 2, end: 2, status: "processing" });
    options.registerCancel(() => finish({ pageCount: 2 }));
  });
  const parsing = x.service.parse({ consent: true });
  while (!report) await new Promise(resolve => setImmediate(resolve));
  const rejection = assert.rejects(parsing, /暂停/u);
  await x.service.pause(); await rejection;
  const snapshot = x.service.snapshot().parseProgress;
  assert.equal(snapshot.phase, "paused");
  assert.deepEqual(snapshot.chunks.map(c => c.status), ["complete", "paused"]);
  assert.deepEqual(snapshot.chunks[1].observed, ["processing"]);
  assert.equal(x.service.parseNotifyTimer, null);
  report({ phase: "chunk", start: 2, end: 2, status: "complete" });
  assert.deepEqual(x.service.snapshot().parseProgress, snapshot);
});
test("parse errors retain completed rows and reject out-of-order plans", async () => {
  for (const invalid of [true, false]) {
    const x = setup({ convert: async ({ onProgress }) => {
      onProgress({ phase: "planning", pageCount: 2 });
      onProgress({ phase: "chunk", start: 1, end: 2, status: "pending" });
      if (invalid) onProgress({ phase: "assembling" });
      onProgress({ phase: "parsing" });
      onProgress({ phase: "chunk", start: 1, end: 2, status: "uploading" });
      throw new Error("network failure");
    } });
    await assert.rejects(x.service.parse({ consent: true }), invalid ? /顺序/u : /network/u);
    assert.equal(x.service.snapshot().parseProgress.phase, "failed");
    assert.equal(x.service.snapshot().parseProgress.chunks[0].status, invalid ? "pending" : "failed");
  }
});
test("large cached plans coalesce progress snapshots and keep constant-time chunk lookup", async () => {
  const x = setup(); let updates = 0;
  const unsubscribe = x.service.subscribe(() => updates++);
  x.service.convert = async ({ onProgress }) => {
    onProgress({ phase: "planning", pageCount: 10000 });
    for (let start = 1; start <= 10000; start++) onProgress({ phase: "chunk", start, end: start, status: "pending" });
    onProgress({ phase: "parsing" });
    for (let start = 1; start <= 10000; start++) onProgress({ phase: "chunk", start, end: start, status: "complete" });
    onProgress({ phase: "assembling" });
    x.files.set("source.md", "Paper"); return { pageCount: 10000 };
  };
  await x.service.parse({ consent: true });
  assert.ok(updates < 15, `unexpected full snapshot count: ${updates}`);
  assert.equal(x.service.snapshot().parseProgress.completed, 10000);
  assert.equal(x.service.parseNotifyTimer, null);
  assert.deepEqual(x.service.snapshot().parseProgress.chunks[0].observed, ["complete"]);
  unsubscribe();
});
test("opening is local; upload and translation each require consent", async () => {
  const x = setup(); await x.service.load(); assert.deepEqual(x.calls, []);
  await assert.rejects(x.service.parse(), /确认/u); assert.deepEqual(x.calls, []);
  await prepared(x); await assert.rejects(x.service.translate(), /确认/u);
  assert.deepEqual(x.calls, ["convert"]);
});
test("explicit regeneration only creates a new PDF attachment; default finish stays idempotent", async () => {
  const x = setup(); await prepared(x); await x.service.translate({ consent: true });
  await x.service.finish({});
  const translations = { ...x.service.state.translations }, text = x.service.translated, calls = x.calls.length;
  x.service.complete = async () => assert.fail("regeneration must not request a model");
  x.service.importPDF = async () => {
    const saved = JSON.parse(x.files.get("state.json"));
    assert.equal(saved.importIntent, true); assert.equal(saved.chineseAttachmentID, null);
    return 10;
  };
  assert.equal(await x.service.finish({}), 9); assert.equal(x.calls.length, calls);
  assert.equal(await x.service.finish({}, { regenerate: true }), 10);
  assert.deepEqual(x.calls.slice(calls), ["pdf"]);
  assert.equal(x.service.translated, text); assert.deepEqual(x.service.state.translations, translations);
  assert.equal(await x.service.finish({}), 10); assert.equal(x.calls.length, calls + 1);
  const restored = new FulltextService(x.args); await restored.load();
  assert.equal(await restored.finish({}), 10); assert.equal(restored.translated, text);
});

test("regeneration print, verification and pre-import save failures preserve the previous mapping", async () => {
  for (const phase of ["print", "verify-before", "verify-after", "save"]) {
    const x = setup(); await prepared(x); await x.service.translate({ consent: true }); await x.service.finish({});
    const text = x.service.translated, translations = { ...x.service.state.translations };
    const write = x.service.storage.writeJSON; let failed = false, verifications = 0;
    if (phase === "print") x.service.createPDF = async () => { throw new Error(phase); };
    if (phase.startsWith("verify")) x.service.verifySource = async () => {
      if (++verifications === (phase === "verify-before" ? 1 : 2)) throw new Error(phase);
    };
    if (phase === "save") x.service.storage.writeJSON = async (name, value) => {
      await write(name, value);
      if (value.importIntent && !failed) { failed = true; throw new Error(phase); }
    };
    await assert.rejects(x.service.finish({}, { regenerate: true }), new RegExp(phase));
    const saved = JSON.parse(x.files.get("state.json"));
    assert.equal(saved.chineseAttachmentID, 9, phase); assert.equal(saved.importIntent, false, phase);
    assert.equal(x.service.state.chineseAttachmentID, 9); assert.equal(x.imports(), 1);
    assert.equal(x.service.translated, text); assert.deepEqual(x.service.state.translations, translations);
  }
});

test("regeneration cancelled during print or source verification preserves the old mapping", async () => {
  for (const phase of ["print", "verify"]) {
    const x = setup(); await prepared(x); await x.service.translate({ consent: true }); await x.service.finish({});
    const gate = deferred(); let entered = false, verifications = 0;
    if (phase === "print") x.service.createPDF = async () => { entered = true; await gate.promise; };
    else x.service.verifySource = async () => { if (++verifications === 2) { entered = true; await gate.promise; } };
    const finishing = x.service.finish({}, { regenerate: true }), rejected = assert.rejects(finishing, /暂停/u);
    await until(() => entered, phase);
    const pausing = x.service.pause(); gate.resolve(); await pausing; await rejected;
    const saved = JSON.parse(x.files.get("state.json"));
    assert.equal(saved.chineseAttachmentID, 9); assert.equal(saved.importIntent, false); assert.equal(x.imports(), 1);
    assert.equal(await x.service.finish({}), 9);
  }
});

test("cancelled regeneration intent save restores the old ID before any new import", async () => {
  const x = setup(); await prepared(x); await x.service.translate({ consent: true }); await x.service.finish({});
  const write = x.service.storage.writeJSON, gate = deferred(); let entered = false;
  x.service.storage.writeJSON = async (name, value) => {
    await write(name, value);
    if (value.importIntent) { entered = true; await gate.promise; }
  };
  const finishing = x.service.finish({}, { regenerate: true }), rejected = assert.rejects(finishing, /暂停/u);
  await until(() => entered, "new import intent save");
  const pausing = x.service.pause(); gate.resolve(); await pausing; await rejected;
  assert.equal(x.imports(), 1); assert.equal(x.service.state.chineseAttachmentID, 9);
  const restored = new FulltextService(x.args); await restored.load();
  assert.equal(restored.state.importIntent, false); assert.equal(await restored.finish({}), 9);
});

test("uncertain regeneration persists a null mapping and blocks repeat, reload and reset", async () => {
  const x = setup(); await prepared(x); await x.service.translate({ consent: true }); await x.service.finish({});
  let imports = 0;
  x.service.importPDF = async () => { imports++; throw new Error("uncertain new import"); };
  await assert.rejects(x.service.finish({}, { regenerate: true }), /uncertain/u);
  const saved = JSON.parse(x.files.get("state.json"));
  assert.equal(saved.importIntent, true); assert.equal(saved.chineseAttachmentID, null);
  const restored = new FulltextService(x.args); await restored.load();
  for (const service of [x.service, restored]) {
    await assert.rejects(service.finish({}), /未确认/u);
    await assert.rejects(service.finish({}, { regenerate: true }), /未确认/u);
    await assert.rejects(service.confirm(service.source), /导入/u);
    await assert.rejects(service.parse({ consent: true, replaceApproved: true }), /导入/u);
    await assert.rejects(service.enableEditing({ consent: true }), /导入/u);
  }
  assert.equal(imports, 1); assert.equal(x.files.get("state.json"), JSON.stringify(saved));
});

test("even malformed records with an old ID and import intent cannot finish idempotently", async () => {
  const x = setup(); await prepared(x); await x.service.translate({ consent: true }); await x.service.finish({});
  x.service.state.importIntent = true; await x.service.save();
  const restored = new FulltextService(x.args); await restored.load();
  for (const service of [x.service, restored]) {
    await assert.rejects(service.finish({}), /未确认/u);
    await assert.rejects(service.finish({}, { regenerate: true }), /未确认/u);
  }
  assert.equal(x.imports(), 1);
});

test("a regeneration import completed after owner close persists the new mapping", async () => {
  const x = setup(); await prepared(x); await x.service.translate({ consent: true }); await x.service.finish({});
  const gate = deferred(); let entered = false;
  x.service.importPDF = async () => { entered = true; return gate.promise; };
  const owner = { closed: false }, finishing = x.service.finish(owner, { regenerate: true });
  await until(() => entered, "new import started");
  owner.closed = true; const closing = x.service.shutdown(); gate.resolve(10);
  assert.equal(await finishing, 10); await closing;
  const restored = new FulltextService(x.args); await restored.load();
  assert.equal(restored.state.chineseAttachmentID, 10); assert.equal(restored.state.importIntent, false);
  assert.equal(restored.state.stage, "complete"); assert.equal(await restored.finish({}), 10);
});

test("each paragraph translates then reviews, references remain byte-identical; completion imports only once", async () => {
  const x = setup(); await prepared(x); await x.service.translate({ consent: true });
  assert.equal(x.calls.length, 5); assert.ok(!x.calls.slice(1).some(call => plain(call.source).includes("Author")));
  assert.equal(x.files.get("translated.md"), x.service.source);
  await x.service.finish({}); await x.service.finish({}); assert.equal(x.imports(), 1);
  assert.equal(x.service.snapshot().stage, "complete");
});
test("failed formatting is bounded, checkpointed, editable and resumable", async () => {
  let bad = true;
  const x = setup({ complete: async options => encode(bad ? "BAD" : JSON.parse(options.prompt).source) });
  await prepared(x); await x.service.setConcurrency(1);
  await assert.rejects(x.service.translate({ consent: true }), /校对/u);
  assert.equal(x.service.snapshot().stage, "paused"); assert.equal(x.service.snapshot().completed, 0);
  await assert.rejects(x.service.finish({}), /尚未/u);
  await assert.rejects(x.service.setDraft(encode("BAD")), /invalid/u);
  bad = false; await x.service.setDraft(encode("手动修正\n")); await x.service.translate({ consent: true });
  assert.equal(x.service.snapshot().completed, 2);
});
test("API failures do not trigger repeated model calls", async () => {
  let requests = 0;
  const x = setup({ complete: async () => { requests++; const error = new Error("unauthorized"); error.code = "API_AUTH"; throw error; } });
  await prepared(x); await x.service.setConcurrency(1);
  await assert.rejects(x.service.translate({ consent: true })); assert.equal(requests, 1);
});
test("default five and configured worker limits bound requests while each segment translates before review", async () => {
  for (const configured of [undefined, 1, 3, 8]) {
    const remote = controlledCompletions(), x = setup({ complete: remote.complete });
    await preparedParagraphs(x, 11);
    if (configured !== undefined) await x.service.setConcurrency(configured);
    const limit = configured ?? 5, translating = x.service.translate({ consent: true });
    await until(() => remote.requests.length === limit, `initial ${limit} workers`);
    await flushJobs();
    assert.equal(remote.active, limit);
    assert.deepEqual(x.service.snapshot().translationProgress, { concurrency: limit, completed: 0, total: 11,
      translating: limit, reviewing: 0, saving: 0, failed: 0, pending: 11 - limit, draining: false });
    const finishedTranslations = new Set(), finishedReviews = new Set();
    while (finishedReviews.size < 11) {
      await until(() => remote.requests.some(request => !request.settled), "next model pass");
      const request = remote.requests.find(request => !request.settled), source = plain(request.input.source);
      if (request.phase === "translating") {
        assert.ok(!finishedTranslations.has(source)); finishedTranslations.add(source);
        assert.ok(!Object.hasOwn(request.input, "draft"));
        request.succeed(`Draft: ${source}`);
      } else {
        assert.ok(finishedTranslations.has(source)); assert.ok(!finishedReviews.has(source));
        assert.deepEqual(request.input.draft, units(`Draft: ${source}`)); finishedReviews.add(source);
        request.succeed(`Reviewed: ${source}`);
      }
      await until(() => request.settled, "released model pass");
      assert.ok(remote.active <= limit);
    }
    await translating;
    assert.equal(remote.maximum, limit); assert.equal(remote.requests.length, 22);
    assert.equal(x.service.snapshot().translationProgress.completed, 11);
    assert.equal(x.files.get("translated.md"), x.service.source.replaceAll("Paragraph", "Reviewed: Paragraph"));
    const loaded = new FulltextService(x.args); await loaded.load();
    assert.equal(loaded.snapshot().translationProgress.concurrency, limit);
    assert.equal(loaded.snapshot().completed, 11);
  }
});

test("out-of-order reviews persist independently but final assembly retains source and reference order", async () => {
  const remote = controlledCompletions(), x = setup({ complete: remote.complete }); await prepared(x);
  const translating = x.service.translate({ consent: true });
  await until(() => remote.requests.length === 2, "both translation requests");
  remote.requests[1].succeed("Second draft.");
  await until(() => remote.requests.length === 3, "second paragraph review");
  assert.deepEqual(remote.requests[2].input.draft, units("Second draft."));
  remote.requests[2].succeed("第二段。");
  await until(() => x.service.snapshot().completed === 1, "out-of-order checkpoint");
  assert.deepEqual(JSON.parse(x.files.get("state.json")).translations, { "3": "第二段。" });
  assert.equal(remote.requests[0].settled, false);
  remote.requests[0].succeed("First draft.\n");
  await until(() => remote.requests.length === 4, "first paragraph review");
  remote.requests[3].succeed("第一段。\n"); await translating;
  assert.equal(x.files.get("translated.md"), "第一段。\n[1] Author. Title. 2020.\n第二段。");
});

test("checkpoint writes never overlap and completed counts only successfully persisted segments", async () => {
  const remote = controlledCompletions(), x = setup({ complete: remote.complete }); await preparedParagraphs(x, 3);
  const write = x.service.storage.writeJSON, writes = []; let active = 0, maximum = 0;
  x.service.storage.writeJSON = async (name, value) => {
    active++; maximum = Math.max(maximum, active);
    try {
      if (name === "state.json" && Object.keys(value.translations).length > Object.keys(JSON.parse(x.files.get(name)).translations).length) {
        const gate = deferred(); writes.push({ gate, value: JSON.parse(JSON.stringify(value)) }); await gate.promise;
      }
      return await write(name, value);
    } finally { active--; }
  };
  const translating = x.service.translate({ consent: true });
  await until(() => remote.requests.length === 3, "translations");
  remote.requests.slice().forEach(request => request.succeed());
  await until(() => remote.requests.length === 6, "reviews");
  remote.requests.slice(3).reverse().forEach(request => request.succeed());
  await until(() => writes.length === 1 && x.service.snapshot().translationProgress.saving === 3, "queued checkpoints");
  assert.equal(x.service.snapshot().completed, 0);
  assert.deepEqual(JSON.parse(x.files.get("state.json")).translations, {});
  await flushJobs(); assert.equal(writes.length, 1);
  for (let index = 0; index < 3; index++) {
    await until(() => writes.length === index + 1, `checkpoint ${index + 1}`);
    assert.equal(x.service.snapshot().completed, index);
    assert.equal(Object.keys(JSON.parse(x.files.get("state.json")).translations).length, index);
    assert.equal(Object.keys(writes[index].value.translations).length, index + 1);
    writes[index].gate.resolve();
    await until(() => x.service.snapshot().completed === index + 1, "checkpoint publication");
  }
  await translating; assert.equal(maximum, 1);
  assert.equal(x.service.snapshot().translationProgress.saving, 0);
  assert.equal(x.files.get("translated.md"), x.service.source);
});

test("first final failure stops dispatch while already-issued segments drain and persist", async () => {
  const remote = controlledCompletions(), x = setup({ complete: remote.complete }); await preparedParagraphs(x, 8);
  const write = x.service.storage.writeJSON, failureSave = deferred(); let failureSaving = false;
  x.service.storage.writeJSON = async (name, value) => {
    if (!failureSaving && value.pendingSegments["1"]?.error) {
      failureSaving = true; await failureSave.promise;
    }
    return write(name, value);
  };
  const translating = x.service.translate({ consent: true }), rejected = assert.rejects(translating, /first failure/u);
  let finished = false; translating.then(() => { finished = true; }, () => { finished = true; });
  await until(() => remote.requests.length === 5, "five issued translations");
  remote.requests[0].fail("first failure");
  await until(() => failureSaving, "blocked failure checkpoint");
  assert.equal(x.service.snapshot().translationProgress.draining, true);
  assert.equal(x.service.snapshot().translationProgress.pending, 3);
  assert.equal(x.service.snapshot().busy, true); assert.equal(finished, false);
  assert.ok(remote.requests.every(request => request.cancelled === 0));
  remote.requests.slice(1).forEach(request => request.succeed());
  await until(() => remote.requests.length === 9, "four in-flight reviews");
  remote.requests.slice(5).forEach(request => request.succeed());
  await until(() => x.service.snapshot().translationProgress.saving === 4, "in-flight success queued behind failure");
  await flushJobs(); assert.equal(remote.requests.length, 9); assert.equal(finished, false);
  assert.deepEqual(x.service.state.translations, {});
  failureSave.resolve(); await rejected;
  assert.equal(remote.requests.length, 9);
  assert.deepEqual(Object.keys(x.service.state.translations).sort(), ["2", "3", "4", "5"]);
  assert.deepEqual(JSON.parse(x.files.get("state.json")).translations, x.service.state.translations);
  assert.deepEqual(x.service.snapshot().translationProgress, { concurrency: 5, completed: 4, total: 8,
    translating: 0, reviewing: 0, saving: 0, failed: 1, pending: 3, draining: false });
  assert.equal(x.service.snapshot().stage, "paused"); assert.equal(x.files.has("translated.md"), false);
});

test("reviewed formatting must pass validation, retries stay serial and the third failure drains other workers", async () => {
  const remote = controlledCompletions(), x = setup({ complete: remote.complete }); await preparedParagraphs(x, 2);
  const validations = [], restore = x.service.markdown.restoreTranslation;
  x.service.markdown.restoreTranslation = (prepared, value) => { validations.push(plain(value)); return restore(prepared, value); };
  const translating = x.service.translate({ consent: true }), rejected = assert.rejects(translating, /invalid format/u);
  await until(() => remote.requests.length === 2, "initial translations");
  let request = remote.requests[0];
  for (let attempt = 1; attempt <= 3; attempt++) {
    assert.equal(request.phase, "translating"); assert.deepEqual(request.input.source, units("Paragraph 1.\n"));
    if (attempt === 1) assert.equal(Object.hasOwn(request.input, "feedback"), false);
    else assert.equal(request.input.feedback, remote.requests[3].input.feedback);
    const beforeReview = remote.requests.length;
    request.succeed(`Draft attempt ${attempt}`);
    await until(() => remote.requests.length === beforeReview + 1, "review after translation validation");
    const review = remote.requests.at(-1);
    assert.equal(review.phase, "reviewing"); assert.deepEqual(review.input.draft, units(`Draft attempt ${attempt}`));
    if (attempt > 1) { assert.ok(request.input.feedback); assert.equal(review.input.feedback, request.input.feedback); }
    assert.equal(validations.at(-1), `Draft attempt ${attempt}`);
    review.succeed("BAD");
    if (attempt < 3) {
      await until(() => remote.requests.length === beforeReview + 2, "next serial retry");
      request = remote.requests.at(-1);
    } else await until(() => x.service.snapshot().translationProgress.failed === 1, "bounded final formatting failure");
    assert.equal(x.service.snapshot().completed, 0);
    assert.deepEqual(JSON.parse(x.files.get("state.json")).translations, {});
  }
  assert.equal(remote.requests.length, 7); assert.equal(x.service.snapshot().translationProgress.draining, true);
  assert.equal(remote.requests[1].cancelled, 0); assert.equal(remote.requests[1].settled, false);
  remote.requests[1].succeed("Other draft");
  await until(() => remote.requests.length === 8, "other worker review");
  remote.requests[7].succeed("Other reviewed\n"); await rejected;
  assert.deepEqual(validations, ["Draft attempt 1", "BAD", "Draft attempt 2", "BAD", "Draft attempt 3", "BAD", "Other draft", "Other reviewed\n"]);
  assert.equal(x.service.state.pendingSegments["1"].draft, encode("Draft attempt 3"));
  assert.deepEqual(x.service.state.translations, { "2": "Other reviewed\n" });
  assert.equal(x.service.snapshot().completed, 1); assert.equal(x.files.has("translated.md"), false);
});

test("multiple failed drafts survive reopen, select and repair independently without exposing all drafts", async () => {
  const remote = controlledCompletions(), x = setup({ complete: remote.complete }); await preparedParagraphs(x, 3);
  const translating = x.service.translate({ consent: true }), rejected = assert.rejects(translating, /review failed/u);
  await until(() => remote.requests.length === 3, "translations");
  remote.requests.slice().forEach((request, index) => request.succeed(`Private draft ${index + 1}`));
  await until(() => remote.requests.length === 6, "reviews");
  remote.requests[3].fail("review failed one"); remote.requests[4].fail("review failed two"); remote.requests[5].succeed();
  await rejected;
  const loaded = new FulltextService(x.args); await loaded.load();
  assert.deepEqual(loaded.state.pendingSegments, {
    "1": { draft: encode("Private draft 1"), error: "review failed one" },
    "2": { draft: encode("Private draft 2"), error: "review failed two" }
  });
  const snapshot = loaded.snapshot();
  assert.deepEqual(snapshot.repairSegments, [{ id: "1", error: "review failed one" }, { id: "2", error: "review failed two" }]);
  assert.ok(!Object.hasOwn(snapshot, "pendingSegments"));
  assert.ok(snapshot.repairSegments.every(segment => !Object.hasOwn(segment, "draft")));
  assert.ok(!JSON.stringify(snapshot).includes("Private draft 2"));
  snapshot.repairSegments[0].error = "mutated"; snapshot.translationProgress.completed = 99;
  assert.equal(loaded.snapshot().repairSegments[0].error, "review failed one"); assert.equal(loaded.snapshot().completed, 1);
  await loaded.selectRepairSegment("2"); assert.equal(loaded.snapshot().draft, encode("Private draft 2"));
  await loaded.setDraft(encode("Repaired two")); await loaded.selectRepairSegment("1"); await loaded.setDraft(encode("Repaired one"));
  await assert.rejects(loaded.selectRepairSegment("3"), /待修正/u);
  await assert.rejects(loaded.setDraft(encode("BAD")), /invalid/u);
  const again = new FulltextService(x.args); await again.load();
  assert.equal(again.state.pendingSegments["1"].draft, encode("Repaired one"));
  assert.equal(again.state.pendingSegments["2"].draft, encode("Repaired two"));
  assert.equal(again.snapshot().completed, 1); assert.equal(remote.requests.length, 6);
  await assert.rejects(again.translate(), /确认/u); assert.equal(remote.requests.length, 6);
  const resuming = again.translate({ consent: true });
  await until(() => remote.requests.length === 8, "only two repaired reviews");
  assert.deepEqual(remote.requests.slice(6).map(request => request.phase), ["reviewing", "reviewing"]);
  assert.deepEqual(remote.requests.slice(6).map(request => request.input.draft), [units("Repaired one"), units("Repaired two")]);
  remote.requests[7].succeed("Fixed two\n"); remote.requests[6].succeed("Fixed one\n"); await resuming;
  assert.deepEqual(again.state.pendingSegments, {}); assert.deepEqual(again.snapshot().repairSegments, []);
  assert.equal(again.state.currentID, ""); assert.equal(again.state.draft, "");
  assert.equal(x.files.get("translated.md"), "Fixed one\nFixed two\nParagraph 3.\n");
});

test("pause and shutdown immediately cancel every active pass, ignore late success and hold the operation lock", async () => {
  for (const action of ["pause", "shutdown"]) {
    const remote = controlledCompletions(), x = setup({ complete: remote.complete }); await preparedParagraphs(x, 7);
    const translating = x.service.translate({ consent: true }), rejected = assert.rejects(translating, /暂停/u);
    await until(() => remote.requests.length === 5, "five translations");
    remote.requests[0].succeed("Saved draft");
    await until(() => remote.requests.length === 6, "one review and four translations");
    let stopped = false; const stopping = x.service[action]().then(() => { stopped = true; });
    assert.ok(remote.requests.filter(request => !request.settled).every(request => request.cancelled === 1));
    assert.equal(remote.requests[0].cancelled, 0);
    await flushJobs(); assert.equal(stopped, false); assert.equal(x.service.snapshot().busy, true);
    await assert.rejects(x.service.translate({ consent: true }), /运行|回收/u);
    await assert.rejects(x.service.setConcurrency(2), /运行|回收/u);
    remote.requests.filter(request => !request.settled).forEach(request => request.succeed("Late success"));
    await stopping; await rejected;
    assert.equal(remote.requests.length, 6); assert.equal(x.service.snapshot().completed, 0);
    assert.deepEqual(JSON.parse(x.files.get("state.json")).translations, {});
    assert.equal(x.service.state.pendingSegments["1"].draft, encode("Saved draft"));
    assert.equal(x.service.operation, null); assert.equal(x.service.cancellers.size, 0);
    assert.equal(x.service.translationNotifyTimer, null); assert.equal(x.files.has("translated.md"), false);
    assert.equal(x.service.snapshot().translationProgress.translating, 0);
    assert.equal(x.service.snapshot().translationProgress.reviewing, 0);
  }
});

test("pause during a checkpoint restores disk and blocks restart until rollback and cleanup finish", async () => {
  const remote = controlledCompletions(), x = setup({ complete: remote.complete }); await preparedParagraphs(x, 2);
  const write = x.service.storage.writeJSON, commit = deferred(), rollback = deferred();
  let committed = false, rollingBack = false, active = 0, maximum = 0;
  x.service.storage.writeJSON = async (name, value) => {
    active++; maximum = Math.max(maximum, active);
    try {
      if (!committed && Object.keys(value.translations).length) {
        await write(name, value); committed = true; await commit.promise;
      } else if (committed && !rollingBack && !Object.keys(value.translations).length) {
        rollingBack = true; await rollback.promise; await write(name, value);
      } else await write(name, value);
    } finally { active--; }
  };
  const translating = x.service.translate({ consent: true }), rejected = assert.rejects(translating, /暂停/u);
  await until(() => remote.requests.length === 2, "translations");
  remote.requests.forEach(request => request.succeed());
  await until(() => remote.requests.length === 4, "reviews");
  remote.requests.slice(2).forEach(request => request.succeed());
  await until(() => committed && x.service.snapshot().translationProgress.saving === 2, "blocked durable checkpoint");
  assert.equal(x.service.snapshot().completed, 0); assert.equal(Object.keys(JSON.parse(x.files.get("state.json")).translations).length, 1);
  let stopped = false; const stopping = x.service.pause().then(() => { stopped = true; });
  await assert.rejects(x.service.translate({ consent: true }), /运行|回收/u);
  commit.resolve(); await until(() => rollingBack, "rollback write");
  assert.equal(stopped, false); assert.equal(x.service.snapshot().busy, true);
  await assert.rejects(x.service.translate({ consent: true }), /运行|回收/u);
  await assert.rejects(x.service.setConcurrency(1), /运行|回收/u);
  rollback.resolve(); await stopping; await rejected;
  assert.equal(maximum, 1); assert.equal(x.service.operation, null);
  assert.equal(x.service.snapshot().completed, 0); assert.deepEqual(JSON.parse(x.files.get("state.json")).translations, {});
  assert.equal(x.files.has("translated.md"), false); assert.equal(remote.requests.length, 4);
  const resumed = x.service.translate({ consent: true });
  await until(() => remote.requests.length === 6, "resumed saved-draft reviews after cleanup");
  assert.ok(remote.requests.slice(4).every(request => request.phase === "reviewing"));
  remote.requests.slice(4).forEach(request => request.succeed()); await resumed;
  assert.equal(x.service.snapshot().completed, 2);
});

test("old protocols invalidate every completed result and draft read-only until explicit reconfirmation", async () => {
  for (const protocol of [undefined, 1]) {
    const x = withPageMap(setup()); await prepared(x); await x.service.translate({ consent: true });
    const legacy = JSON.parse(x.files.get("state.json")), originalSource = x.service.source;
    if (protocol === undefined) delete legacy.translationProtocol; else legacy.translationProtocol = protocol;
    delete legacy.concurrency;
    Object.assign(legacy, { stage: protocol === undefined ? "translating" : "complete", currentID: "1", draft: "Old draft", error: "Old review failure",
      pendingSegments: { "1": { draft: "Old pending draft", error: "Old failure" } } });
    if (protocol === undefined) delete legacy.pendingSegments; // Older single-draft records are not upgraded either.
    x.files.set("state.json", JSON.stringify(legacy));
    const before = new Map(x.files), calls = x.calls.length;
    let writes = 0;
    const storage = { ...x.args.storage,
      writeJSON: async (...args) => { writes++; return x.args.storage.writeJSON(...args); },
      writeText: async (...args) => { writes++; return x.args.storage.writeText(...args); } };
    const loaded = new FulltextService({ ...x.args, sourceHash: x.service.sourceHash, storage }); await loaded.load();
    assert.equal(loaded.snapshot().stage, "review"); assert.equal(loaded.snapshot().protocolChanged, true);
    assert.equal(loaded.snapshot().translationProgress.concurrency, 5);
    assert.deepEqual(loaded.state.translations, {}); assert.deepEqual(loaded.state.pendingSegments, {});
    assert.equal(loaded.snapshot().currentID, ""); assert.equal(loaded.snapshot().draft, "");
    assert.equal(loaded.snapshot().completed, 0); assert.equal(loaded.translated, "");
    assert.equal(loaded.source, originalSource); assert.equal(loaded.getPageMarkdown(1), "# Page one");
    assert.equal(loaded.state.pageCount, legacy.pageCount); assert.equal(loaded.state.approvedHash, legacy.approvedHash);
    await assert.rejects(loaded.translate({ consent: true }), /协议.*重新确认/u);
    await assert.rejects(loaded.finish({}), /协议.*重新确认/u); await assert.rejects(loaded.export({}), /协议.*重新确认/u);
    assert.equal(writes, 0); assert.equal(x.calls.length, calls); assert.deepEqual(x.files, before);
    await loaded.confirm(loaded.source);
    assert.equal(loaded.state.translationProtocol, 2); assert.equal(loaded.state.config.revision, 2);
    assert.equal(loaded.snapshot().protocolChanged, false); assert.deepEqual(loaded.state.translations, {});
    assert.deepEqual(loaded.state.pendingSegments, {}); assert.equal(loaded.state.draft, "");
    assert.equal(JSON.parse(x.files.get("state.json")).translationProtocol, 2);
    assert.equal(x.calls.length, calls); // Confirmation is local and does not grant model consent.
    await assert.rejects(loaded.translate(), /确认/u);
    await loaded.translate({ consent: true });
    assert.equal(loaded.translated, originalSource);
    assert.ok(x.calls.slice(calls).some(call => !Object.hasOwn(call, "draft")));
    assert.equal(x.files.get("source.md"), before.get("source.md"));
    assert.equal(x.files.get(legacy.pageMapFile), before.get(legacy.pageMapFile));
  }
});

test("concurrency settings validate 1-8, persist per task atomically and never clear approved output or grant consent", async () => {
  const x = setup(); await prepared(x); await x.service.translate({ consent: true });
  const translations = { ...x.service.state.translations }, output = x.service.translated, signature = x.service.state.signature;
  const beforeCalls = x.calls.length;
  for (const value of [1, 8, 4]) {
    await x.service.setConcurrency(value);
    assert.equal(JSON.parse(x.files.get("state.json")).concurrency, value);
    assert.deepEqual(x.service.state.translations, translations); assert.equal(x.service.translated, output);
    assert.equal(x.service.state.signature, signature);
  }
  const before = x.files.get("state.json");
  for (const value of [0, 9, -1, 1.5, NaN, Infinity, "5", null, undefined]) await assert.rejects(x.service.setConcurrency(value), /1–8/u);
  assert.equal(x.files.get("state.json"), before);
  const write = x.service.storage.writeJSON; let fail = true;
  x.service.storage.writeJSON = async (name, value) => {
    await write(name, value);
    if (fail) { fail = false; throw new Error("late settings failure"); }
  };
  await assert.rejects(x.service.setConcurrency(2), /settings failure/u);
  assert.equal(x.files.get("state.json"), before); assert.equal(x.service.state.concurrency, 4);
  assert.deepEqual(x.service.state.translations, translations); assert.equal(x.service.translated, output);
  const loaded = new FulltextService(x.args); await loaded.load();
  await assert.rejects(loaded.translate(), /确认/u); assert.equal(x.calls.length, beforeCalls);
  const independent = setup(); await independent.service.load(); assert.equal(independent.service.state.concurrency, 5);
  await independent.service.setConcurrency(2);
  await assert.rejects(independent.service.parse(), /确认/u);
  await assert.rejects(independent.service.translate(), /确认/u); assert.deepEqual(independent.calls, []);
});

test("a process interrupted during failure drain can reopen the saved draft before any global error", async () => {
  const remote = controlledCompletions(), x = setup({ complete: remote.complete }); await preparedParagraphs(x, 2);
  const translating = x.service.translate({ consent: true }), rejected = assert.rejects(translating, /review failed/u);
  await until(() => remote.requests.length === 2, "initial requests");
  remote.requests[0].succeed("Preserved draft");
  await until(() => remote.requests.length === 3, "review"); remote.requests[2].fail("review failed");
  await until(() => x.service.snapshot().translationProgress.failed === 1, "failure checkpoint");
  const disk = new Map(x.files);
  const restarted = new FulltextService({ ...x.args, storage: {
    ...x.args.storage, readJSON: async name => JSON.parse(disk.get(name)), readText: async name => disk.get(name) || null
  } });
  await restarted.load();
  assert.equal(restarted.snapshot().stage, "paused"); assert.equal(restarted.snapshot().error, "");
  assert.equal(restarted.snapshot().currentID, "1"); assert.equal(restarted.snapshot().draft, encode("Preserved draft"));
  assert.deepEqual(restarted.snapshot().repairSegments, [{ id: "1", error: "review failed" }]);
  remote.requests[1].succeed(); await until(() => remote.requests.length === 4, "other review");
  remote.requests[3].succeed(); await rejected;
});

test("a late checkpoint disk failure preserves other workers and does not publish the failed segment", async () => {
  const remote = controlledCompletions(), x = setup({ complete: remote.complete }); await preparedParagraphs(x, 2);
  const write = x.service.storage.writeJSON; let fail = true;
  x.service.storage.writeJSON = async (name, value) => {
    await write(name, value);
    if (fail && Object.hasOwn(value.translations, "1")) { fail = false; throw new Error("late disk failure"); }
  };
  const translating = x.service.translate({ consent: true }), rejected = assert.rejects(translating, /disk failure/u);
  await until(() => remote.requests.length === 2, "translations"); remote.requests.slice().forEach(r => r.succeed());
  await until(() => remote.requests.length === 4, "reviews"); remote.requests.slice(2).forEach(r => r.succeed());
  await rejected;
  assert.equal(x.service.snapshot().completed, 1); assert.deepEqual(Object.keys(x.service.state.translations), ["2"]);
  assert.deepEqual(JSON.parse(x.files.get("state.json")).translations, x.service.state.translations);
  assert.ok(x.service.state.pendingSegments["1"].draft); assert.equal(x.files.has("translated.md"), false);
  const loaded = new FulltextService(x.args); await loaded.load(); assert.equal(loaded.snapshot().completed, 1);
});

test("corrupt concurrency and cross-segment drafts fail closed without writing or starting requests", async () => {
  const x = setup(); await prepared(x); const original = x.files.get("state.json"), calls = x.calls.length;
  for (const corrupt of [
    state => { state.concurrency = 9; }, state => { state.concurrency = "5"; },
    state => { state.pendingSegments = []; },
    state => { state.pendingSegments = { missing: { draft: "x", error: "failed" } }; },
    state => { state.pendingSegments = { "1": { draft: "x".repeat(Markdown.MAX_RESPONSE_LENGTH + 1), error: "failed" } }; },
    state => { state.pendingSegments = { "1": { draft: "x", error: "e".repeat(1201) } }; }
  ]) {
    const state = JSON.parse(original); corrupt(state); const raw = JSON.stringify(state); x.files.set("state.json", raw);
    await assert.rejects(new FulltextService(x.args).load(), /并发|草稿/u);
    assert.equal(x.files.get("state.json"), raw); assert.equal(x.calls.length, calls);
  }
});

test("pause during the configuration signature await prevents any new worker from starting", async () => {
  const x = setup(); await prepared(x); const gate = deferred(), entered = deferred(), hash = x.service.hash;
  x.service.hash = async value => { entered.resolve(); await gate.promise; return hash(value); };
  const calls = x.calls.length, translating = x.service.translate({ consent: true });
  const rejected = assert.rejects(translating, /暂停/u);
  await entered.promise; await x.service.pause(); gate.resolve(); await rejected;
  assert.equal(x.calls.length, calls); assert.equal(x.service.operation, null);
});

test("explicit single-segment retry starts from original source and preserves other pending drafts", async () => {
  const x = setup({ complete: async () => { throw Object.assign(new Error("offline"), { code: "API_NETWORK" }); } });
  await preparedParagraphs(x, 3); await assert.rejects(x.service.translate({ consent: true }), /offline/u);
  await x.service.selectRepairSegment("2"); await x.service.setDraft(encode("Saved manual draft"));
  const other1 = { ...x.service.state.pendingSegments["1"] }, other3 = { ...x.service.state.pendingSegments["3"] }, calls = [];
  x.service.complete = async options => { const input = JSON.parse(options.prompt); calls.push(input); return encode(input.source); };
  await x.service.retrySegment("2", { consent: true });
  assert.equal(calls.length, 2); assert.deepEqual(calls[0].source, units("Paragraph 2.\n"));
  assert.equal(Object.hasOwn(calls[0], "draft"), false); assert.deepEqual(calls[1].draft, units("Paragraph 2.\n"));
  assert.deepEqual(x.service.state.pendingSegments["1"], other1); assert.deepEqual(x.service.state.pendingSegments["3"], other3);
  assert.deepEqual(Object.keys(x.service.state.translations), ["2"]); assert.equal(x.service.snapshot().completed, 1);
  assert.equal(x.service.snapshot().stage, "paused"); assert.equal(x.files.has("translated.md"), false);
  await assert.rejects(x.service.export({}), /尚未|先完成/u);
  const count = calls.length;
  await assert.rejects(x.service.retrySegment("1"), /确认/u);
  await assert.rejects(x.service.retrySegment("2", { consent: true }), /待处理|未完成/u);
  await assert.rejects(x.service.retrySegment("missing", { consent: true }), /待处理|未完成/u);
  assert.equal(calls.length, count);
});

test("an invalid persisted draft does not consume one of three fresh translation attempts", async () => {
  let requests = 0;
  const x = setup({ complete: async () => { requests++; return encode("BAD"); } });
  await preparedParagraphs(x, 1); await assert.rejects(x.service.translate({ consent: true }), /invalid/u);
  assert.equal(requests, 3); assert.equal(x.service.state.pendingSegments["1"].draft, encode("BAD"));
  requests = 0; await assert.rejects(x.service.translate({ consent: true }), /invalid/u);
  assert.equal(requests, 3);
});

test("last failed segment retry checks configuration and assembles only after preserving completed paragraphs", async () => {
  const x = setup({ complete: async options => {
    const input = JSON.parse(options.prompt);
    if (plain(input.source).startsWith("First")) throw Object.assign(new Error("offline"), { code: "API_NETWORK" });
    return encode(input.source);
  } });
  await prepared(x); await assert.rejects(x.service.translate({ consent: true }), /offline/u);
  const completed = { ...x.service.state.translations };
  await x.service.setDraft(encode("User saved draft")); const disk = x.files.get("state.json");
  let requests = 0; x.service.complete = async options => { requests++; return encode(JSON.parse(options.prompt).source); };
  x.config.model = "changed";
  await assert.rejects(x.service.retrySegment("1", { consent: true }), /改变/u);
  assert.equal(requests, 0); assert.equal(x.files.get("state.json"), disk);
  x.config.model = "test";
  await x.service.retrySegment("1", { consent: true });
  assert.equal(requests, 2); assert.equal(x.service.state.translations["3"], completed["3"]);
  assert.equal(x.service.translated, x.service.source); assert.equal(x.files.get("translated.md"), x.service.source);
  assert.equal(x.service.snapshot().stage, "translated"); assert.deepEqual(x.service.state.pendingSegments, {});
});

test("repair context is selected bounded masked input, not raw protected resources or a public snapshot field", async () => {
  const x = setup({ markdown: Markdown, complete: async () => { throw Object.assign(new Error("offline"), { code: "API_NETWORK" }); } });
  await x.service.parse({ consent: true }); await x.service.confirm("1. Hello $x$ [link](https://example.invalid/private)\n");
  await assert.rejects(x.service.translate({ consent: true }), /offline/u);
  const id = x.service.state.currentID, context = x.service.getRepairContext(id);
  assert.deepEqual(Object.keys(context).sort(), ["id", "source"]);
  assert.equal(context.source, JSON.stringify({ translations: Markdown.prepareSegment(x.service.plan.segments[0]).units }, null, 2));
  assert.doesNotMatch(context.source, /⟦SPT_|example.invalid|\$x\$/u);
  assert.ok(context.source.length <= Markdown.MAX_RESPONSE_LENGTH);
  assert.equal(Object.hasOwn(x.service.snapshot(), "protectedSource"), false);
  assert.throws(() => x.service.getRepairContext("missing"), /待处理/u);
  context.source = "tampered"; assert.notEqual(x.service.getRepairContext(id).source, "tampered");
});

test("cancelling a forced retry keeps the stored draft and rejects its late model result", async () => {
  const x = setup({ complete: async () => { throw Object.assign(new Error("offline"), { code: "API_NETWORK" }); } });
  await preparedParagraphs(x, 1); await assert.rejects(x.service.translate({ consent: true }), /offline/u);
  await x.service.setDraft(encode("Saved draft before retry"));
  const stored = { ...x.service.state.pendingSegments["1"] }, remote = controlledCompletions(); x.service.complete = remote.complete;
  const retry = x.service.retrySegment("1", { consent: true }), rejected = assert.rejects(retry, /暂停/u);
  await until(() => remote.requests.length === 1, "forced translation");
  assert.equal(Object.hasOwn(remote.requests[0].input, "draft"), false);
  assert.throws(() => x.service.getRepairContext("1"), /暂停/u);
  const pausing = x.service.pause(); assert.equal(remote.requests[0].cancelled, 1);
  remote.requests[0].succeed("Late result"); await pausing; await rejected;
  assert.deepEqual(x.service.state.pendingSegments["1"], stored);
  assert.equal(x.service.snapshot().completed, 0); assert.equal(x.files.has("translated.md"), false);
});

test("configuration changes during async retry preparation stop requests before sending", async () => {
  const x = setup({ complete: async () => { throw Object.assign(new Error("offline"), { code: "API_NETWORK" }); } });
  await preparedParagraphs(x, 1); await assert.rejects(x.service.translate({ consent: true }), /offline/u);
  const entered = deferred(), gate = deferred(); let requests = 0;
  x.service.verifySource = async () => { entered.resolve(); await gate.promise; };
  x.service.complete = async () => { requests++; return encode("unexpected"); };
  const retry = x.service.retrySegment("1", { consent: true }), rejected = assert.rejects(retry, /配置.*改变|改变.*配置/u);
  await entered.promise; x.config.model = "changed-after-approval"; gate.resolve(); await rejected;
  assert.equal(requests, 0); assert.equal(x.service.snapshot().completed, 0);
});

test("the completion guard rejects configuration changes during credential preparation without format retries", async () => {
  const entered = deferred(), gate = deferred(); let completions = 0, sent = 0;
  const x = setup({ complete: async options => {
    completions++; entered.resolve(); await gate.promise;
    if (!options.isCurrent()) throw new Error("任务已暂停，未发送模型请求。");
    sent++; return encode(JSON.parse(options.prompt).source);
  } });
  await preparedParagraphs(x, 1);
  const translating = x.service.translate({ consent: true }), rejected = assert.rejects(translating, /配置.*改变/u);
  await entered.promise; x.config.endpoint = "https://changed.example/chat/completions"; gate.resolve(); await rejected;
  assert.equal(completions, 1); assert.equal(sent, 0); assert.equal(x.service.snapshot().completed, 0);
});

test("changed model or prompt blocks resuming until explicit reconfirmation", async () => {
  const x = setup(); await prepared(x); x.config.model = "new-model";
  await assert.rejects(x.service.translate({ consent: true }), /改变/u);
  assert.equal(x.calls.length, 1);
  await x.service.confirm(x.service.source); await x.service.translate({ consent: true });
});
test("confirmed state uses content-addressed Markdown, no key persisted", async () => {
  const x = setup(); x.config.apiKey = "not-to-be-stored"; await prepared(x);
  assert.ok(x.files.has(`approved-${hash(x.service.source)}.md`));
  assert.ok(!x.files.get("state.json").includes("not-to-be-stored"));
  const restored = new FulltextService(x.args); await restored.load(); assert.equal(restored.source, x.service.source);
});
test("resume does not resend completed paragraphs and detects tampered checkpoints", async () => {
  const x = setup(); await prepared(x); await x.service.translate({ consent: true });
  const restored = new FulltextService(x.args); await restored.load();
  const count = x.calls.length; await restored.translate({ consent: true }); assert.equal(x.calls.length, count);
  const state = JSON.parse(x.files.get("state.json")); state.translations["1"] = "BAD";
  x.files.set("state.json", JSON.stringify(state));
  await assert.rejects(new FulltextService(x.args).load(), /checkpoint/u);
});
test("source mismatch blocks requests; snapshots cannot mutate internal state", async () => {
  const x = setup(); await prepared(x); x.service.verifySource = async () => { throw new Error("changed source"); };
  await assert.rejects(x.service.translate({ consent: true }), /changed source/u); assert.equal(x.calls.length, 1);
  const snapshot = x.service.snapshot(); snapshot.config.model = "mutated";
  assert.equal(x.service.state.config.model, "test");
});
test("pause cancels in-flight completion and ignores late success", async () => {
  let resolve, cancelled = false;
  const x = setup({ complete: options => new Promise(r => { resolve = r; options.registerCancel(() => { cancelled = true; r(encode("late")); }); }) });
  await prepared(x);
  const translating = x.service.translate({ consent: true });
  while (!resolve) await new Promise(r => setImmediate(r));
  const rejection = assert.rejects(translating, /暂停/u); await x.service.pause(); await rejection;
  assert.equal(cancelled, true); assert.equal(x.service.snapshot().completed, 0);
});
test("late cancellation registration is immediately cancelled", async () => {
  const x = setup(); await x.service.pause(); let cancelled = false;
  x.service.registerCancel(() => { cancelled = true; }); assert.ok(cancelled);
});
test("pause before the import callback clears its intent and permits a later save", async () => {
  const x = setup(); await prepared(x); await x.service.translate({ consent: true });
  const write = x.args.storage.writeJSON; let release, entered;
  const entering = new Promise(resolve => { entered = resolve; });
  let intercepted = false;
  x.args.storage.writeJSON = async (name, value) => {
    await write(name, value);
    if (value.importIntent && !intercepted) {
      intercepted = true; entered(); await new Promise(resolve => { release = resolve; });
    }
  };
  const finishing = x.service.finish({}); const rejection = assert.rejects(finishing, /暂停/u);
  await entering; const pausing = x.service.pause(); release(); await pausing; await rejection;
  assert.equal(x.imports(), 0); assert.equal(JSON.parse(x.files.get("state.json")).importIntent, false);
  const restored = new FulltextService(x.args); await restored.load(); await restored.finish({}); assert.equal(x.imports(), 1);
});

test("an uncertain import is never repeated automatically", async () => {
  const x = setup({ importPDF: async () => { throw new Error("transaction result unavailable"); } });
  await prepared(x); await x.service.translate({ consent: true }); await assert.rejects(x.service.finish({}));
  await assert.rejects(x.service.finish({}), /未确认/u);
  const restored = new FulltextService(x.args); await restored.load();
  assert.match(restored.snapshot().error, /导入/u); await assert.rejects(restored.finish({}), /未确认/u);
  const before = new Map(x.files);
  await assert.rejects(restored.confirm(restored.source), /导入/u);
  assert.deepEqual(x.files, before);
});
test("real Markdown codec survives translation, proofreading and restart without changing references", async () => {
  const markdown = { validateSource, editableBlocks, ...require("../plugin/content/fulltext-markdown.js") };
  const x = setup({ markdown, complete: async options => {
    const input = JSON.parse(options.prompt);
    return encode(input.draft || input.source.map(part => ({ ...part, text: part.text.replace(/Test/gu, "测试").replace(/Text/gu, "文本").replace(/and/gu, "和") })));
  } });
  await x.service.parse({ consent: true });
  const source = "# Test\n\nText [1] and $x$.\n\n## References\n[1] Author. Title. 2020.\n";
  await x.service.confirm(source); await x.service.translate({ consent: true });
  assert.equal(x.files.get("translated.md"), "# 测试\n\n文本 [1] 和 $x$.\n\n## References\n[1] Author. Title. 2020.\n");
  const restored = new FulltextService(x.args); await restored.load();
  assert.equal(restored.translated, x.service.translated);
});

async function legacyTask(pages = ["# Page one", "Second $x$"]) {
  const x = withPageMap(setup(), pages); await x.service.parse({ consent: true });
  const state = JSON.parse(x.files.get("state.json"));
  delete state.documentFile; delete state.documentSourceHash; delete state.originalHash;
  x.files.set("state.json", JSON.stringify(state));
  x.service = new FulltextService({ ...x.args, sourceHash: x.service.sourceHash }); await x.service.load();
  return x;
}
function editFirst(service, text, extra = {}) {
  return service.editBlock({ page: 1, index: 0, revision: service.state.documentFile, text, ...extra });
}

test("legacy load stays read-only until explicit migration and archives the exact approved manual source", async () => {
  const x = await legacyTask();
  assert.equal(x.service.documentPages, null);
  assert.equal(x.service.source, x.files.get("source.md"));
  assert.equal(x.service.getPageBlocks(1)[0].source, "# Page one");
  await assert.rejects(editFirst(x.service, "Oops"), /迁移/u);
  await assert.rejects(x.service.enableEditing(), /确认/u);
  const manual = "Manually corrected approved source";
  await x.service.confirm(manual); await x.service.translate({ consent: true });
  const plan = x.service.plan, translated = x.service.translated, translations = { ...x.service.state.translations };
  const sourceFile = x.files.get("source.md"), pagesFile = x.files.get(x.service.state.pageMapFile);
  await x.service.enableEditing({ consent: true });
  assert.equal(x.service.source, "# Page one\n\nSecond $x$");
  assert.equal(x.service.plan, plan); assert.equal(x.service.translated, translated);
  assert.deepEqual(x.service.state.translations, translations);
  assert.equal(x.service.state.approvedHash, hash(manual));
  assert.equal(x.service.snapshot().sourceChanged, true);
  const archives = [...x.files.keys()].filter(name => name.startsWith("history-"));
  assert.equal(archives.length, 1);
  const archive = JSON.parse(x.files.get(archives[0]));
  assert.equal(archives[0], `history-${hash(JSON.stringify(archive))}.json`);
  assert.equal(archive.archivedSourceFile, `original-${hash(manual)}.md`);
  assert.equal(archive.archivedSourceHash, hash(manual));
  assert.equal(x.files.get(archive.archivedSourceFile), manual);
  assert.equal(x.files.get(`approved-${archive.approvedHash}.md`), manual);
  assert.equal(x.files.get("source.md"), sourceFile); assert.equal(x.files.get(x.service.state.pageMapFile), pagesFile);
  const loaded = new FulltextService({ ...x.args, sourceHash: x.service.sourceHash }); await loaded.load();
  assert.equal(loaded.source, x.service.source); assert.equal(loaded.translated, manual);
  assert.equal(loaded.plan.segments[0].source, manual);
  for (const action of [() => loaded.translate({ consent: true }), () => loaded.finish({}), () => loaded.export({})]) {
    await assert.rejects(action(), /重新确认/u);
  }
  await loaded.confirm(loaded.source);
  assert.deepEqual(loaded.state.translations, {}); assert.equal(loaded.translated, "");
  assert.equal(loaded.snapshot().sourceChanged, false);
  await loaded.translate({ consent: true }); await loaded.finish({});
  assert.equal(x.imports(), 1);
});

test("migration also backs up an unapproved legacy edit, without clearing an existing checkpoint", async () => {
  const x = await legacyTask(); x.service.source = "Unsaved old manual draft";
  await x.service.enableEditing({ consent: true });
  const archiveName = [...x.files.keys()].find(name => name.startsWith("history-"));
  const archive = JSON.parse(x.files.get(archiveName));
  assert.equal(x.files.get(archive.archivedSourceFile), "Unsaved old manual draft");
  assert.equal(x.service.snapshot().sourceChanged, false); // No approval exists to compare against.
});

test("block edits use offsets, leave repeated text and raw pages intact, and survive reopen", async () => {
  const x = withPageMap(setup(), ["Same\n\nSame\n\nLast", ""]); await x.service.parse({ consent: true });
  await x.service.confirm(x.service.source); await x.service.translate({ consent: true });
  const approved = x.service.state.approvedHash, translated = x.service.translated;
  const originalPage = x.service.pageMap[0], originalPages = x.files.get(x.service.state.pageMapFile);
  const blocks = x.service.getPageBlocks(1), target = blocks[1], revision = x.service.state.documentFile;
  assert.equal(blocks.length, 3); assert.deepEqual(x.service.getPageBlocks(2), []);
  assert.deepEqual(x.service.getPageBlocks(99), []);
  await x.service.editBlock({ page: 1, index: 1, revision, text: "Changed\n" });
  assert.equal(x.service.getPageMarkdown(1), originalPage.slice(0, target.start) + "Changed\n" + originalPage.slice(target.end));
  assert.equal(x.service.getPageBlocks(1)[0].source, blocks[0].source);
  assert.equal(x.service.pageMap[0], originalPage); assert.equal(x.files.get(x.service.state.pageMapFile), originalPages);
  assert.equal(x.service.translated, translated); assert.equal(x.service.state.approvedHash, approved);
  assert.equal(x.service.state.documentSourceHash, hash(x.service.documentPages.join("\n\n")));
  assert.notEqual(x.service.state.documentFile, revision);
  await assert.rejects(x.service.editBlock({ page: 1, index: 1, revision, text: "Stale" }), /版本/u);
  for (const action of [() => x.service.translate({ consent: true }), () => x.service.finish({}), () => x.service.export({})]) {
    await assert.rejects(action(), /重新确认/u);
  }
  const loaded = new FulltextService({ ...x.args, sourceHash: x.service.sourceHash }); await loaded.load();
  assert.equal(loaded.source, x.service.source); assert.equal(loaded.getPageMarkdown(1), x.service.getPageMarkdown(1));
  assert.equal(loaded.translated, translated); assert.equal(loaded.snapshot().sourceChanged, true);
  const oldPage = loaded.getPageMarkdown(1), last = loaded.getPageBlocks(1).at(-1);
  await loaded.editBlock({ page: 1, index: last.index, revision: loaded.state.documentFile, text: "" });
  assert.equal(loaded.getPageMarkdown(1), oldPage.slice(0, last.start) + oldPage.slice(last.end));
  await loaded.confirm(loaded.source);
  assert.equal(loaded.translated, ""); assert.deepEqual(loaded.state.translations, {});
});

test("editing a document back to its approved content restores sourceChanged=false without clearing translations", async () => {
  const x = withPageMap(setup(), ["Original", ""]); await prepared(x); await x.service.translate({ consent: true });
  const translated = x.service.translated;
  await editFirst(x.service, "Changed"); assert.equal(x.service.snapshot().sourceChanged, true);
  await editFirst(x.service, "Original"); assert.equal(x.service.snapshot().sourceChanged, false);
  assert.equal(x.service.translated, translated); await x.service.export({});
});

test("edits reject invalid indices, Unicode and broken structure; fallback source blocks can be repaired", async () => {
  const x = withPageMap(setup()); await x.service.parse({ consent: true });
  const before = x.service.source, revision = x.service.state.documentFile;
  for (const extra of [{ page: 0 }, { page: 3 }, { page: 1.5 }, { index: -1 }, { index: 99 }, { index: "0" }]) {
    await assert.rejects(editFirst(x.service, "New", extra), /下标|页码/u);
  }
  for (const text of ["\uD800", "\uDC00", "\u0000", "```js\nunclosed", null]) await assert.rejects(editFirst(x.service, text));
  assert.equal(x.service.source, before); assert.equal(x.service.state.documentFile, revision);
  const repair = withPageMap(setup(), ["```js\nunclosed", ""]); await repair.service.parse({ consent: true });
  assert.equal(repair.service.getPageBlocks(1)[0].kind, "source");
  await editFirst(repair.service, "```js\nclosed\n```");
  assert.equal(repair.service.getPageBlocks(1)[0].kind, "code");
  await editFirst(repair.service, ""); assert.deepEqual(repair.service.getPageBlocks(1), []);
});

test("missing pages, busy operations, uncertain import and source verification block local writes", async () => {
  const missing = withPageMap(setup(), [null, ""]); await missing.service.parse({ consent: true });
  assert.equal(missing.service.snapshot().editingReady, false);
  assert.equal(missing.service.snapshot().canEnableEditing, false);
  assert.equal(missing.service.source, missing.files.get("source.md"));
  await assert.rejects(missing.service.enableEditing({ consent: true }), /不完整/u);
  const x = await legacyTask(), before = x.files.get("state.json");
  x.service.state.importIntent = true;
  await assert.rejects(x.service.enableEditing({ consent: true }), /导入/u);
  await assert.rejects(editFirst(x.service, "New"), /导入/u);
  x.service.state.importIntent = false;
  x.service.verifySource = async () => { throw new Error("PDF identity changed"); };
  await assert.rejects(x.service.enableEditing({ consent: true }), /identity/u);
  assert.equal(x.files.get("state.json"), before);
  let release, entered;
  const entering = new Promise(resolve => { entered = resolve; });
  x.service.verifySource = async () => { entered(); await new Promise(resolve => { release = resolve; }); };
  const migrating = x.service.enableEditing({ consent: true }); await entering;
  assert.equal(x.service.snapshot().busy, true);
  await assert.rejects(editFirst(x.service, "New"), /运行/u);
  await assert.rejects(x.service.enableEditing({ consent: true }), /运行/u);
  const rejection = assert.rejects(migrating, /暂停/u), pausing = x.service.pause();
  assert.ok(x.service.operation); release(); await pausing; await rejection;
  assert.equal(x.service.operation, null); assert.equal(x.files.get("state.json"), before);
});

test("failed or cancelled local document writes never publish a new revision and restore a late state commit", async () => {
  for (const migrate of [false, true]) for (const point of ["document", "state"]) for (const cancel of [false, true]) {
    const x = migrate ? await legacyTask() : withPageMap(setup());
    if (!migrate) await prepared(x);
    const before = x.files.get("state.json"), source = x.service.source, revision = x.service.state.documentFile;
    const snapshots = [], unsubscribe = x.service.subscribe(snapshot => snapshots.push(snapshot));
    let release, entered, intercepted = false;
    const entering = new Promise(resolve => { entered = resolve; });
    const method = point === "document" ? "writeText" : "writeJSON", write = x.service.storage[method];
    x.service.storage[method] = async (name, value) => {
      const match = point === "document" ? name.startsWith("document-") : name === "state.json";
      if (match && !intercepted) {
        intercepted = true;
        // Simulate both cancellation and failure AFTER a write reached disk.
        await write(name, value); entered();
        if (cancel) await new Promise(resolve => { release = resolve; });
        else throw new Error("late disk failure");
      } else await write(name, value);
    };
    const writing = migrate ? x.service.enableEditing({ consent: true }) : editFirst(x.service, "Changed");
    const rejection = assert.rejects(writing, cancel ? /暂停/u : /disk failure/u);
    await entering;
    if (cancel) { const pausing = x.service.pause(); release(); await pausing; }
    await rejection;
    assert.equal(x.files.get("state.json"), before, `${migrate}/${point}/${cancel}`);
    assert.equal(x.service.source, source); assert.equal(x.service.state.documentFile, revision);
    assert.ok(snapshots.every(snapshot => snapshot.documentRevision === (revision || "") && snapshot.source === source));
    assert.equal(x.service.operation, null); unsubscribe();
  }
});

test("migration archival failures and cancellation do not alter persistent approval or grant model permission", async () => {
  for (const point of ["original-", "history-"]) {
    const x = await legacyTask(); await x.service.confirm("Old manual source");
    const before = x.files.get("state.json"), writeText = x.service.storage.writeText, writeJSON = x.service.storage.writeJSON;
    x.service.storage.writeText = async (name, value) => { if (name.startsWith(point)) throw new Error("archive failure"); return writeText(name, value); };
    x.service.storage.writeJSON = async (name, value) => { if (name.startsWith(point)) throw new Error("archive failure"); return writeJSON(name, value); };
    await assert.rejects(x.service.enableEditing({ consent: true }), /archive failure/u);
    assert.equal(x.files.get("state.json"), before); assert.equal(x.service.source, "Old manual source");
    assert.equal(x.service.documentPages, null); assert.deepEqual(x.calls, ["convert"]);
    assert.equal(x.service.state.stage, "ready");
  }
});

test("document loading rejects corrupt hashes, identities, bindings, page counts and source hashes without fake editable fallback", async () => {
  const mutations = [
    (_record, _state, x) => { x.files.set(x.service.state.documentFile, "{}"); return false; },
    record => { record.schema = 2; }, record => { record.identity = "another-task"; },
    record => { record.sourceHash = "b".repeat(64); }, record => { record.pageMapFile = `pages-${"b".repeat(64)}.json`; },
    record => { record.parsedMarkdownHash = "b".repeat(64); }, record => { record.pages = ["Only one"]; },
    record => { record.pages[0] = null; }, record => { record.pages[0] = "\uD800"; },
    (_record, state) => { state.documentSourceHash = "b".repeat(64); },
    (_record, state) => { state.pageCount = 1; }, (_record, state) => { state.pageCount = 10001; }
  ];
  for (const mutate of mutations) {
    const x = withPageMap(setup()); await prepared(x); await x.service.translate({ consent: true });
    const state = JSON.parse(x.files.get("state.json")), record = JSON.parse(x.files.get(state.documentFile));
    if (mutate(record, state, x) !== false) {
      const raw = JSON.stringify(record); state.documentFile = `document-${hash(raw)}.json`; x.files.set(state.documentFile, raw);
    }
    x.files.set("state.json", JSON.stringify(state));
    const loaded = new FulltextService({ ...x.args, sourceHash: x.service.sourceHash }); await loaded.load();
    assert.ok(loaded.snapshot().documentError); assert.equal(loaded.snapshot().editingReady, false);
    assert.equal(loaded.source, x.service.source); assert.equal(loaded.translated, x.service.translated);
    await assert.rejects(editFirst(loaded, "Changed"));
    await assert.rejects(loaded.enableEditing({ consent: true }));
    assert.equal(x.files.get("state.json"), JSON.stringify(state));
    if (!loaded.sourceChanged()) assert.equal(await loaded.export({}), true); // Approved output remains usable, not a repaired draft.
  }
});

test("document UTF-8 source and serialized JSON limits are independent and never truncate", async () => {
  const x = withPageMap(setup()); await x.service.parse({ consent: true });
  const before = x.files.get("state.json"), revision = x.service.state.documentFile;
  // UTF-16 length is below the cap, but UTF-8 is over it.
  assert.throws(() => x.service.documentSource(["界".repeat(Math.floor(128 * 1024 * 1024 / 3)), "x"], 2), /128 MiB/u);
  // Backslash escaping makes JSON exceed 128 MiB while the original text remains within it.
  await assert.rejects(x.service.writeDocument(["\\".repeat(64 * 1024 * 1024), ""], x.service.state, x.service.serial), /JSON.*128 MiB/u);
  assert.equal(x.files.get("state.json"), before); assert.equal(x.service.state.documentFile, revision);
});

test("failed reparsing restores raw source on disk as well as the previous document and checkpoints", async () => {
  const x = withPageMap(setup()); await prepared(x); await x.service.translate({ consent: true });
  const raw = x.files.get("source.md"), revision = x.service.state.documentFile, source = x.service.source;
  x.service.convert = async () => { x.files.set("source.md", "Partially replaced raw source"); throw new Error("conversion failed"); };
  await assert.rejects(x.service.parse({ consent: true, replaceApproved: true }), /conversion/u);
  assert.equal(x.files.get("source.md"), raw); assert.equal(x.service.state.documentFile, revision);
  const loaded = new FulltextService({ ...x.args, sourceHash: x.service.sourceHash }); await loaded.load();
  assert.equal(loaded.source, source); assert.equal(loaded.translated, x.service.translated);
});

test("strict response parsing rejects wrappers, extra fields and empty text", () => {
  for (const value of ['```json\n{}\n```', '{"translation":"x"}', '{"translation":"x","explanation":"y"}', '{"translation":""}', '[]', '{}',
    JSON.stringify({ translations: units("x"), explanation: "extra" }), encode(""), encode(" \n "),
    JSON.stringify({ translations: [] }), JSON.stringify({ translations: [{ id: "t0", text: "x", extra: true }] }),
    JSON.stringify({ translations: [{ id: "t0" }] }), JSON.stringify({ translations: [{ text: "x" }] }),
    JSON.stringify({ translations: [{ id: "t0", text: 42 }] }), encode("\uD800"), encode("\uDC00"), encode("\u0000")]) {
    assert.throws(() => parseAnswer(value), value.slice(0, 100));
  }
  assert.deepEqual(parseAnswer(encode("中文")), units("中文"));
  assert.throws(() => publicConfig({ provider: "custom" }), /DeepSeek/u);
  assert.equal(publicConfig({ provider: "deepseek", endpoint: "https://example.test", model: "test" }).revision, 2);
});

test("structured response IDs, counts and aggregate text limits are exact", () => {
  for (const ids of [["t1"], ["t0", "t0"], ["t1", "t0"], ["t0", "t2"], ["T0"], ["t00"], [0]]) {
    assert.throws(() => parseAnswer(encode(ids.map(id => ({ id, text: "正文" })))), /ID|顺序/u);
  }
  const maximum = Array.from({ length: Markdown.MAX_TEXT_PARTS }, (_, index) => ({ id: `t${index}`, text: "x" }));
  assert.deepEqual(parseAnswer(encode(maximum)), maximum);
  assert.throws(() => parseAnswer(encode([...maximum, { id: `t${maximum.length}`, text: "x" }])), /数量/u);
  const half = "中".repeat(Markdown.MAX_TRANSLATION_LENGTH / 2);
  assert.deepEqual(parseAnswer(encode([{ id: "t0", text: half }, { id: "t1", text: half }])),
    [{ id: "t0", text: half }, { id: "t1", text: half }]);
  assert.throws(() => parseAnswer(encode([{ id: "t0", text: half }, { id: "t1", text: half + "超" }])), /输出上限/u);
});

test("both structured model passes disclose identical prose and context for different protected resources", async () => {
  const prompts = [];
  for (const suffix of ["privateAlpha", "privateBeta"]) {
    const requests = [], source = `Hello $${suffix}$ [link](https://example.invalid/${suffix}) ![image](https://example.invalid/${suffix}.png)\n`;
    const x = setup({ markdown: Markdown, complete: async options => {
      const input = JSON.parse(options.prompt); requests.push(input);
      assert.doesNotMatch(options.prompt + options.systemMessage, new RegExp(suffix));
      assert.doesNotMatch(options.prompt, /example\.invalid|⟦SPT_/u);
      assert.ok(Array.isArray(input.source)); assert.ok(Array.isArray(input.context));
      assert.ok(input.context.every(part => Object.keys(part).length === 1 && (Object.hasOwn(part, "id") || Object.hasOwn(part, "protected"))));
      return encode(input.draft || input.source);
    } });
    await x.service.parse({ consent: true }); await x.service.confirm(source);
    await x.service.translate({ consent: true });
    assert.equal(requests.length, 2); assert.equal(Object.hasOwn(requests[0], "draft"), false);
    assert.deepEqual(requests[1].draft, requests[0].source);
    assert.deepEqual(requests[1].source, requests[0].source); assert.deepEqual(requests[1].context, requests[0].context);
    assert.equal(x.service.translated, source); assert.equal(x.files.get("translated.md"), source);
    prompts.push(requests);
  }
  assert.deepEqual(prompts[0], prompts[1]);
});

test("missing, extra and reordered structured responses never checkpoint either model pass", async () => {
  const mutations = [parts => parts.slice(0, -1), parts => [...parts, { id: `t${parts.length}`, text: "extra" }],
    parts => [...parts].reverse(), parts => parts.map((part, index) => index === 1 ? { ...part, id: "t0" } : part)];
  for (const corrupt of mutations) for (const failedPhase of ["translating", "reviewing"]) {
    const requests = [];
    const x = setup({ markdown: Markdown, complete: async options => {
      const input = JSON.parse(options.prompt); requests.push(input);
      assert.ok(input.source.length > 1);
      const phase = Object.hasOwn(input, "draft") ? "reviewing" : "translating";
      return encode(phase === failedPhase ? corrupt(input.source) : input.source);
    } });
    await x.service.parse({ consent: true }); await x.service.confirm("First $secret$ second.\n");
    await assert.rejects(x.service.translate({ consent: true }), /未完成/u);
    assert.equal(requests.length, failedPhase === "translating" ? 3 : 6);
    const attempts = requests.filter(input => !Object.hasOwn(input, "draft"));
    assert.equal(attempts.length, 3); assert.equal(Object.hasOwn(attempts[0], "feedback"), false);
    assert.ok(attempts[1].feedback); assert.equal(attempts[1].feedback, attempts[2].feedback);
    assert.doesNotMatch(attempts[1].feedback, /secret|⟦SPT_/u);
    assert.deepEqual(x.service.state.translations, {});
    assert.deepEqual(JSON.parse(x.files.get("state.json")).translations, {});
    assert.equal(x.service.snapshot().completed, 0); assert.equal(x.service.snapshot().stage, "paused");
    assert.equal(x.files.has("translated.md"), false);
  }
});

test("source changes during credential preparation invalidate the approval before either model pass", async () => {
  for (const blockedPass of [1, 2]) {
    const entered = deferred(), gate = deferred(); let calls = 0, sent = 0;
    const x = withPageMap(setup({ complete: async options => {
      calls++;
      if (calls === blockedPass) { entered.resolve(); await gate.promise; }
      if (!options.isCurrent()) throw new Error("任务已暂停，未发送模型请求。");
      sent++; return encode(JSON.parse(options.prompt).source);
    } }));
    await prepared(x); await x.service.setConcurrency(1);
    const approvedHash = x.service.state.approvedHash;
    const translating = x.service.translate({ consent: true }), rejected = assert.rejects(translating, /原文.*改变/u);
    await entered.promise;
    x.service.state.documentSourceHash = hash("Changed working source"); gate.resolve(); await rejected;
    assert.equal(x.service.state.approvedHash, approvedHash);
    assert.equal(calls, blockedPass); assert.equal(sent, blockedPass - 1);
    assert.deepEqual(x.service.state.translations, {}); assert.equal(x.files.has("translated.md"), false);
  }
});

test("native print exceptions retain readable diagnostics and completed text remains exportable and retryable", async () => {
  const failure = { result: 0x80070057, toString: () => 'NS_ERROR_ILLEGAL_VALUE (0x80070057)' };
  const x = setup({ createPDF: async () => { throw failure; } });
  await prepared(x); await x.service.translate({ consent: true });
  const completed = { ...x.service.state.translations }, text = x.service.translated, calls = x.calls.length;
  await assert.rejects(x.service.finish({}), error => error === failure);
  assert.match(x.service.state.error, /NS_ERROR_ILLEGAL_VALUE.*0x80070057/u);
  assert.match(JSON.parse(x.files.get("state.json")).error, /NS_ERROR_ILLEGAL_VALUE/u);
  assert.deepEqual(x.service.state.translations, completed); assert.equal(x.service.translated, text);
  assert.equal(x.service.state.importIntent, false); assert.equal(x.imports(), 0);
  assert.equal(await x.service.export({}), true); assert.equal(x.calls.length, calls);
  x.service.createPDF = async () => {};
  await x.service.finish({});
  assert.equal(x.calls.length, calls); assert.equal(x.imports(), 1);
  assert.deepEqual(x.service.state.translations, completed);
});

test("old protocol with uncertain import cannot be reconfirmed or silently reset", async () => {
  const x = setup(); await prepared(x);
  const old = JSON.parse(x.files.get("state.json")); delete old.translationProtocol;
  old.importIntent = true; old.translations = { "1": "Old completed text" };
  x.files.set("state.json", JSON.stringify(old)); const before = new Map(x.files), calls = x.calls.length;
  const loaded = new FulltextService(x.args); await loaded.load();
  assert.equal(loaded.snapshot().protocolChanged, true); assert.match(loaded.snapshot().error, /导入/u);
  await assert.rejects(loaded.confirm(loaded.source), /导入/u);
  await assert.rejects(loaded.translate({ consent: true }), /协议/u);
  assert.deepEqual(x.files, before); assert.equal(x.calls.length, calls);
});
