"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { OpenAIChatClient, mapAPIError, extractTranslation } = require("../plugin/content/api.js");

function config(overrides = {}) {
  return {
    provider: "deepseek",
    endpoint: "https://api.deepseek.com/chat/completions",
    baseURL: "https://api.deepseek.com",
    model: "deepseek-v4-flash",
    targetLanguage: "简体中文",
    ...overrides
  };
}

test("DeepSeek request disables thinking and never logs request content", async () => {
  let captured;
  const client = new OpenAIChatClient({
    request: async (...args) => {
      captured = args;
      return { response: { choices: [{ message: { content: "译文" } }] } };
    }
  });
  const output = await client.complete({
    config: config(),
    apiKey: "sk-secret",
    prompt: "private paper text",
    maxTokens: 8
  });
  assert.equal(output, "译文");
  const [method, endpoint, options] = captured;
  assert.equal(method, "POST");
  assert.equal(endpoint, config().endpoint);
  assert.equal(options.logBodyLength, 0);
  assert.equal(options.debug, false);
  assert.equal(options.errorDelayMax, 0);
  assert.equal(options.anon, true);
  assert.equal(options.headers.Authorization, "Bearer sk-secret");
  const body = JSON.parse(options.body);
  assert.deepEqual(body.thinking, { type: "disabled" });
  assert.equal(body.max_tokens, 8);
  assert.equal(options.body.includes("sk-secret"), false);
});

test("custom local providers may omit API key and do not receive DeepSeek fields", async () => {
  let options;
  const client = new OpenAIChatClient({
    request: async (_method, _url, requestOptions) => {
      options = requestOptions;
      return { response: { choices: [{ message: { content: "OK" } }] } };
    }
  });
  await client.complete({
    config: config({ provider: "custom", endpoint: "http://127.0.0.1:11434/v1/chat/completions" }),
    apiKey: "",
    prompt: "test"
  });
  assert.equal("Authorization" in options.headers, false);
  assert.equal("thinking" in JSON.parse(options.body), false);
});

test("callers may override the system message for bounded classifier requests", async () => {
  let options;
  const client = new OpenAIChatClient({
    request: async (_method, _url, requestOptions) => {
      options = requestOptions;
      return { response: { choices: [{ message: { content: '["A","B","C"]' } }] } };
    }
  });
  await client.complete({
    config: config(),
    apiKey: "sk-test",
    prompt: "paper data",
    systemMessage: "classifier contract",
    maxTokens: 128
  });
  const body = JSON.parse(options.body);
  assert.equal(body.messages[0].content, "classifier contract");
  assert.equal(body.max_tokens, 128);
});

test("API response and status failures become safe actionable errors", () => {
  assert.equal(
    extractTranslation({ responseText: JSON.stringify({ choices: [{ message: { content: "  translated  " } }] }) }),
    "translated"
  );
  assert.throws(() => extractTranslation({ response: {} }), { code: "API_RESPONSE_FORMAT" });
  const authError = mapAPIError({ xmlhttp: { status: 401, response: { secret: "body" } } });
  assert.equal(authError.code, "API_AUTH");
  assert.equal(authError.cause, undefined);
  assert.equal(mapAPIError({ xmlhttp: { status: 429 } }).code, "API_RATE_LIMIT");
  assert.equal(mapAPIError({ xmlhttp: { status: 503 } }).code, "API_SERVER");
});

test("DeepSeek requires a key before any request is made", async () => {
  let calls = 0;
  const client = new OpenAIChatClient({ request: async () => { calls++; } });
  await assert.rejects(
    () => client.complete({ config: config(), apiKey: "", prompt: "test" }),
    { code: "CONFIG_API_KEY" }
  );
  assert.equal(calls, 0);
});
