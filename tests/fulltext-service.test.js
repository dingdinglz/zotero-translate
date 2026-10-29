"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { FulltextService, parseAnswer, publicConfig } = require("../plugin/content/fulltext-service.js");
const hash = value => createHash("sha256").update(value).digest("hex");
const { validateSource, editableBlocks } = require("../plugin/content/fulltext-markdown.js");
function setup(overrides = {}) {
  const files = new Map(); const calls = []; let imports = 0;
  const config = { provider: "deepseek", endpoint: "https://api.deepseek.com/chat/completions", model: "test", oxrBaseURL: "https://example.test/api/v1" };
  const codec = {
    validateSource, editableBlocks,
    createPlan: source => ({ segments: source.split(/(?<=\n)/u).map((text, i) => ({ id: String(i + 1), source: text, translatable: Boolean(text.trim()) && !text.startsWith("[1]") })), referenceCount: 1 }),
    prepareSegment: s => ({ text: s.source }),
    restoreTranslation: (_p, value) => { if (value === "BAD") throw new Error("invalid format"); return value; },
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
    complete: async options => { calls.push(JSON.parse(options.prompt)); return JSON.stringify({ translation: JSON.parse(options.prompt).source }); },
    createPDF: async () => calls.push("pdf"), importPDF: async () => { imports++; return 9; },
    exportMarkdown: async () => true, markdown: codec, ...overrides };
  const service = new FulltextService(args);
  return { service, args, files, calls, config, imports: () => imports };
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
test("each paragraph translates then reviews, references remain byte-identical; completion imports only once", async () => {
  const x = setup(); await prepared(x); await x.service.translate({ consent: true });
  assert.equal(x.calls.length, 5); assert.ok(!x.calls.slice(1).some(call => call.source.includes("Author")));
  assert.equal(x.files.get("translated.md"), x.service.source);
  await x.service.finish({}); await x.service.finish({}); assert.equal(x.imports(), 1);
  assert.equal(x.service.snapshot().stage, "complete");
});
test("failed formatting is bounded, checkpointed, editable and resumable", async () => {
  let bad = true;
  const x = setup({ complete: async options => JSON.stringify({ translation: bad ? "BAD" : JSON.parse(options.prompt).source }) });
  await prepared(x); await assert.rejects(x.service.translate({ consent: true }), /校对/u);
  assert.equal(x.service.snapshot().stage, "paused"); assert.equal(x.service.snapshot().completed, 0);
  await assert.rejects(x.service.finish({}), /尚未/u);
  await assert.rejects(x.service.setDraft("BAD"), /invalid/u);
  bad = false; await x.service.setDraft("手动修正\n"); await x.service.translate({ consent: true });
  assert.equal(x.service.snapshot().completed, 2);
});
test("API failures do not trigger repeated model calls", async () => {
  let requests = 0;
  const x = setup({ complete: async () => { requests++; const error = new Error("unauthorized"); error.code = "API_AUTH"; throw error; } });
  await prepared(x); await assert.rejects(x.service.translate({ consent: true })); assert.equal(requests, 1);
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
  const x = setup({ complete: options => new Promise(r => { resolve = r; options.registerCancel(() => { cancelled = true; r('{"translation":"late"}'); }); }) });
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
});
test("real Markdown codec survives translation, proofreading and restart without changing references", async () => {
  const markdown = { validateSource, editableBlocks, ...require("../plugin/content/fulltext-markdown.js") };
  const x = setup({ markdown, complete: async options => {
    const input = JSON.parse(options.prompt);
    return JSON.stringify({ translation: input.draft || input.source.replace(/Test/gu, "测试").replace(/Text/gu, "文本").replace(/and/gu, "和") });
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
  for (const value of ['```json\n{}\n```', '{"translation":"x","explanation":"y"}', '{"translation":""}', '[]', '{}']) assert.throws(() => parseAnswer(value));
  assert.equal(parseAnswer('{"translation":"中文"}'), "中文");
  assert.throws(() => publicConfig({ provider: "custom" }), /DeepSeek/u);
});
