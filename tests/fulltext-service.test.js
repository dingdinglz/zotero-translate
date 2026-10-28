"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { FulltextService, parseAnswer, publicConfig } = require("../plugin/content/fulltext-service.js");
const hash = value => createHash("sha256").update(value).digest("hex");
function setup(overrides = {}) {
  const files = new Map(); const calls = []; let imports = 0;
  const config = { provider: "deepseek", endpoint: "https://api.deepseek.com/chat/completions", model: "test", oxrBaseURL: "https://example.test/api/v1" };
  const codec = {
    createPlan: source => ({ segments: source.split(/(?<=\n)/u).map((text, i) => ({ id: String(i + 1), source: text, translatable: !text.startsWith("[1]") })), referenceCount: 1 }),
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
test("an uncertain import is never repeated automatically", async () => {
  const x = setup({ importPDF: async () => { throw new Error("transaction result unavailable"); } });
  await prepared(x); await x.service.translate({ consent: true }); await assert.rejects(x.service.finish({}));
  await assert.rejects(x.service.finish({}), /未确认/u);
  const restored = new FulltextService(x.args); await restored.load();
  assert.match(restored.snapshot().error, /导入/u); await assert.rejects(restored.finish({}), /未确认/u);
});
test("real Markdown codec survives translation, proofreading and restart without changing references", async () => {
  const markdown = require("../plugin/content/fulltext-markdown.js");
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

test("strict response parsing rejects wrappers, extra fields and empty text", () => {
  for (const value of ['```json\n{}\n```', '{"translation":"x","explanation":"y"}', '{"translation":""}', '[]', '{}']) assert.throws(() => parseAnswer(value));
  assert.equal(parseAnswer('{"translation":"中文"}'), "中文");
  assert.throws(() => publicConfig({ provider: "custom" }), /DeepSeek/u);
});
