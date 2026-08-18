"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Constants = require("../plugin/content/constants.js");
const Logic = require("../plugin/content/logic.js");

test("default templates validate and render paper context", () => {
  assert.equal(Logic.validateTemplate(
    Constants.DEFAULT_SELECTION_PROMPT,
    Constants.SELECTION_TEMPLATE_VARIABLES,
    ["text"]
  ), true);
  const rendered = Logic.renderTemplate(
    Constants.DEFAULT_SELECTION_PROMPT,
    {
      text: "representation learning",
      abstract: "We study representations.",
      title: "A Paper",
      targetLanguage: "简体中文",
      pageNumber: "3"
    },
    Constants.SELECTION_TEMPLATE_VARIABLES,
    ["text"]
  );
  assert.match(rendered, /representation learning/u);
  assert.match(rendered, /We study representations\./u);
  assert.match(rendered, /简体中文/u);
});

test("template validation rejects unknown, malformed, and missing variables", () => {
  assert.throws(
    () => Logic.validateTemplate("{{text}} {{secret}}", ["text"], ["text"]),
    { code: "TEMPLATE_UNKNOWN_VARIABLE" }
  );
  assert.throws(
    () => Logic.validateTemplate("translate this", ["text"], ["text"]),
    { code: "TEMPLATE_REQUIRED_VARIABLE" }
  );
  assert.throws(
    () => Logic.validateTemplate("{{bad-name}}", ["text"], []),
    { code: "TEMPLATE_SYNTAX" }
  );
  for (const malformed of ["{{{text}}}", "{{text", "text}}", "{{text}}}"]) {
    assert.throws(
      () => Logic.validateTemplate(malformed, ["text"], []),
      { code: "TEMPLATE_SYNTAX" }
    );
  }
});

test("short-term classifier accepts academic terms but excludes sentences", () => {
  for (const value of ["model", "deep learning", "state-of-the-art model", "表征学习", "深度强化学习"]) {
    assert.equal(Logic.isShortTerm(value), true, value);
  }
  for (const value of [
    "This is a complete sentence.",
    "one two three four five six",
    "这是一个超过十个汉字的完整句子。",
    "line one\nline two"
  ]) {
    assert.equal(Logic.isShortTerm(value), false, value);
  }
});

test("OpenAI-compatible endpoint validation enforces secure URLs", () => {
  assert.equal(
    Logic.buildChatCompletionsURL("https://api.deepseek.com"),
    "https://api.deepseek.com/chat/completions"
  );
  assert.equal(
    Logic.buildChatCompletionsURL("https://example.com/v1/"),
    "https://example.com/v1/chat/completions"
  );
  assert.equal(
    Logic.buildChatCompletionsURL("http://127.0.0.1:11434/v1"),
    "http://127.0.0.1:11434/v1/chat/completions"
  );
  assert.equal(
    Logic.buildChatCompletionsURL("http://127.0.0.2:11434/v1"),
    "http://127.0.0.2:11434/v1/chat/completions"
  );
  assert.throws(() => Logic.buildChatCompletionsURL("http://example.com/v1"), { code: "CONFIG_BASE_URL" });
  assert.throws(() => Logic.buildChatCompletionsURL("https://example.com/v1?key=secret"), { code: "CONFIG_BASE_URL" });
});

test("cache signature hash is deterministic SHA-256", () => {
  assert.equal(
    Logic.sha256Hex("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
  );
  assert.equal(
    Logic.stableSerialize({ b: 2, a: 1 }),
    Logic.stableSerialize({ a: 1, b: 2 })
  );
});

test("paper identity and async render guards are stable", () => {
  assert.equal(
    Logic.makePaperIdentity({ libraryID: 2, itemKey: "abcd1234" }),
    "2--ABCD1234"
  );
  assert.throws(() => Logic.makePaperIdentity({ libraryID: 2, itemKey: "bad" }), { code: "PAPER_IDENTITY" });
  const state = { destroyed: false, requestSerial: 4, itemID: 10 };
  assert.equal(Logic.isRenderCurrent(state, 4, 10), true);
  state.requestSerial++;
  assert.equal(Logic.isRenderCurrent(state, 4, 10), false);
});

test("smart-tag responses accept strict JSON, code fences, and safe deduplication", () => {
  assert.deepEqual(
    Logic.parseSmartTagsResponse('["World Model", "Model-Based RL", "Planning"]'),
    ["World Model", "Model-Based RL", "Planning"]
  );
  assert.deepEqual(
    Logic.parseSmartTagsResponse(
      '```json\n{"tags":["World Model","world model","Reinforcement Learning","Latent Dynamics","Control","Extra"]}\n```'
    ),
    ["World Model", "Reinforcement Learning", "Latent Dynamics", "Control", "Extra"]
  );
  assert.deepEqual(
    Logic.parseSmartTagsResponse(
      '["<img src=x onerror=alert(1)>","World Model","Planning","Reinforcement Learning"]'
    ),
    ["World Model", "Planning", "Reinforcement Learning"]
  );
});

test("smart-tag responses reject invalid JSON and fewer than three valid English terms", () => {
  assert.throws(() => Logic.parseSmartTagsResponse("World Model, Planning"), {
    code: "API_TAG_FORMAT"
  });
  assert.throws(() => Logic.parseSmartTagsResponse('["World Model", "世界模型", "Planning"]'), {
    code: "API_TAG_FORMAT"
  });
});

test("smart-tag source and model configuration both participate in signatures", () => {
  const source = Logic.makeSmartTagsSourceSignature({ title: "Paper", abstract: "Abstract" });
  const changedSource = Logic.makeSmartTagsSourceSignature({ title: "Paper", abstract: "Revised" });
  assert.notEqual(source, changedSource);
  const baseConfig = {
    provider: "deepseek",
    endpoint: "https://api.deepseek.com/chat/completions",
    model: "deepseek-v4-flash"
  };
  assert.notEqual(
    Logic.makeSmartTagsConfigSignature({ sourceSignature: source, config: baseConfig }),
    Logic.makeSmartTagsConfigSignature({
      sourceSignature: source,
      config: { ...baseConfig, model: "deepseek-v4-pro" }
    })
  );
});
