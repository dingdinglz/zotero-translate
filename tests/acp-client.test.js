"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  ACPClient,
  JSONLineDecoder,
  sanitizeDiagnostic,
  formatACPError,
  validateRuntimePaths,
  createEnvironment
} = require("../plugin/content/acp-client.js");

class AsyncPipe {
  constructor() {
    this.values = [];
    this.waiters = [];
    this.closed = false;
  }
  push(value) {
    const waiter = this.waiters.shift();
    if (waiter) waiter(value);
    else this.values.push(value);
  }
  close() {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter("");
  }
  async readString() {
    if (this.values.length) return this.values.shift();
    if (this.closed) return "";
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

class FakeProcess {
  constructor(onMessage = () => {}) {
    this.stdout = new AsyncPipe();
    this.stderr = new AsyncPipe();
    this.messages = [];
    this.onMessage = onMessage;
    this.waiters = [];
    this.exited = false;
    this.stdin = {
      write: async (line) => {
        const message = JSON.parse(line);
        this.messages.push(message);
        await this.onMessage(message, this);
      },
      close: async () => { this.stdinClosed = true; }
    };
  }
  respond(id, result) {
    this.stdout.push(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
  }
  fail(id, message) {
    this.stdout.push(JSON.stringify({
      jsonrpc: "2.0", id, error: { code: -32000, message }
    }) + "\n");
  }
  notify(method, params) {
    this.stdout.push(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }
  incoming(id, method, params) {
    this.stdout.push(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  }
  exit(exitCode = 0) {
    if (this.exited) return;
    this.exited = true;
    this.stdout.close();
    this.stderr.close();
    for (const resolve of this.waiters.splice(0)) resolve({ exitCode });
  }
  wait() {
    if (this.exited) return Promise.resolve({ exitCode: this.exitCode || 0 });
    return new Promise((resolve) => this.waiters.push(resolve));
  }
  async kill() {
    this.killed = true;
    this.exit(0);
  }
}

function serveProcess() {
  return new FakeProcess((message, process) => {
    if (message.method === "initialize") {
      process.respond(message.id, {
        protocolVersion: 1,
        agentInfo: { name: "codex-acp", version: "1.6.2" },
        agentCapabilities: { loadSession: true }
      });
    }
    if (message.method === "authentication/status") {
      process.respond(message.id, { status: "chat-gpt" });
    }
  });
}

test("JSONL decoder handles split and coalesced frames", () => {
  const decoder = new JSONLineDecoder();
  assert.deepEqual(decoder.push('{"jsonrpc":"2.0","id":1'), []);
  assert.deepEqual(decoder.push(',"result":{}}\n\n{"jsonrpc":"2.0","method":"x"}\r\n'), [
    { jsonrpc: "2.0", id: 1, result: {} },
    { jsonrpc: "2.0", method: "x" }
  ]);
  assert.throws(() => decoder.push("{bad}\n"), { code: "ACP_INVALID_JSON" });
});

test("client correlates concurrent requests and routes streaming notifications", async () => {
  const process = serveProcess();
  const client = new ACPClient({
    processFactory: async () => process,
    getPreparedVersion: () => "1.6.2"
  });
  const notifications = [];
  client.subscribe((event) => {
    if (event.type === "notification") notifications.push(event);
  });
  await client.start();
  const first = client.request("first", {});
  const second = client.request("second", {});
  await new Promise((resolve) => setImmediate(resolve));
  const requests = process.messages.filter((message) => ["first", "second"].includes(message.method));
  process.respond(requests[1].id, { value: 2 });
  process.notify("session/update", { sessionId: "s", update: { sessionUpdate: "agent_message_chunk" } });
  process.respond(requests[0].id, { value: 1 });
  assert.deepEqual(await Promise.all([first, second]), [{ value: 1 }, { value: 2 }]);
  assert.equal(notifications[0].method, "session/update");
  await client.shutdown();
  assert.equal(process.killed, true);
});

test("cancelling a session cancels its pending permission request", async () => {
  const process = serveProcess();
  const client = new ACPClient({
    processFactory: async () => process,
    getPreparedVersion: () => "1.6.2"
  });
  let resolvePermission;
  client.onRequest("session/request_permission", () => new Promise((resolve) => {
    resolvePermission = resolve;
  }));
  await client.start();
  process.incoming(77, "session/request_permission", {
    sessionId: "paper-session",
    toolCall: { title: "run command" },
    options: []
  });
  await new Promise((resolve) => setImmediate(resolve));
  await client.cancelSession("paper-session");
  const cancel = process.messages.find((message) => message.method === "session/cancel");
  const response = process.messages.find((message) => message.id === 77 && !message.method);
  assert.deepEqual(cancel.params, { sessionId: "paper-session" });
  assert.deepEqual(response.result, { outcome: { outcome: "cancelled" } });
  resolvePermission({ outcome: { outcome: "selected", optionId: "once" } });
  await client.shutdown();
});

test("process crashes reject pending requests and retain redacted stderr diagnostics", async () => {
  const process = serveProcess();
  const client = new ACPClient({
    processFactory: async () => process,
    getPreparedVersion: () => "1.6.2"
  });
  await client.start();
  process.stderr.push("token=super-secret-value\n");
  const pending = client.request("never-returns", {}, { timeoutMs: 0 });
  process.exitCode = 9;
  process.exit(9);
  await assert.rejects(pending, { code: "ACP_PROCESS_EXIT" });
  assert.doesNotMatch(client.stderr, /super-secret-value/u);
  assert.match(client.stderr, /REDACTED/u);
});

test("request timeout removes the pending request", async () => {
  const process = serveProcess();
  const client = new ACPClient({
    processFactory: async () => process,
    getPreparedVersion: () => "1.6.2",
    requestTimeoutMs: 15
  });
  await client.start();
  await assert.rejects(client.request("timeout", {}), { code: "ACP_REQUEST_TIMEOUT" });
  assert.equal(client.pending.size, 0);
  await client.shutdown();
});

test("prepare is the only path that permits package download and validates exact version", async () => {
  const calls = [];
  let prepared = "";
  const client = new ACPClient({
    processFactory: async (options) => {
      calls.push(options);
      if (options.purpose === "version") {
        const process = new FakeProcess();
        process.stdout.push("codex-acp 1.6.2\n");
        process.exit(0);
        return process;
      }
      return serveProcess();
    },
    getPreparedVersion: () => prepared,
    setPreparedVersion: (value) => { prepared = value; }
  });
  await client.prepare();
  assert.deepEqual(calls, [
    { purpose: "version", allowDownload: true },
    { purpose: "serve", allowDownload: false }
  ]);
  assert.equal(prepared, "1.6.2");
  assert.equal(client.getStatus().healthy, true);
  await client.shutdown();
});

test("prepare does not mark an unauthenticated Codex runtime as ready", async () => {
  let prepared = "";
  let serve;
  const client = new ACPClient({
    processFactory: async (options) => {
      if (options.purpose === "version") {
        const process = new FakeProcess();
        process.stdout.push("1.6.2\n");
        process.exit(0);
        return process;
      }
      serve = new FakeProcess((message, process) => {
        if (message.method === "initialize") {
          process.respond(message.id, {
            protocolVersion: 1,
            agentInfo: { name: "codex-acp", version: "1.6.2" },
            agentCapabilities: {}
          });
        }
        if (message.method === "authentication/status") {
          process.respond(message.id, { type: "unauthenticated" });
        }
      });
      return serve;
    },
    getPreparedVersion: () => prepared,
    setPreparedVersion: (value) => { prepared = value; }
  });
  await assert.rejects(client.prepare(), { code: "ACP_NOT_AUTHENTICATED" });
  assert.equal(prepared, "");
  assert.equal(serve.killed, true);
});

test("diagnostic sanitizer removes common credential forms", () => {
  const value = sanitizeDiagnostic(
    "Authorization: Bearer abc token=def api_key:ghi https://user:password@example.com sk-abcdefghijklmnop"
  );
  assert.doesNotMatch(value, /\b(?:abc|def|ghi|password|abcdefghijklmnop)\b/u);
});

test("prepare failure exposes actionable redacted npm diagnostics", async () => {
  const client = new ACPClient({
    processFactory: async () => {
      const process = new FakeProcess();
      process.stderr.push(
        "npm error code ETARGET\n" +
        "npm error No matching version found for @agentclientprotocol/codex-acp@1.6.2\n" +
        "token=super-secret-value\n"
      );
      process.exitCode = 1;
      process.exit(1);
      return process;
    }
  });
  await assert.rejects(client.prepare(), (error) => {
    assert.equal(error.code, "ACP_PREPARE_FAILED");
    assert.equal(error.details.stage, "npm 下载与版本检查");
    assert.equal(error.details.exitCode, 1);
    const display = formatACPError(error);
    assert.match(display, /错误代码：ACP_PREPARE_FAILED/u);
    assert.match(display, /目标包：@agentclientprotocol\/codex-acp@1\.6\.2/u);
    assert.match(display, /退出码：1/u);
    assert.match(display, /ETARGET/u);
    assert.match(display, /请升级插件/u);
    assert.doesNotMatch(display, /super-secret-value/u);
    assert.match(display, /REDACTED/u);
    return true;
  });
});

test("prepare spawn failure identifies the startup stage", async () => {
  const client = new ACPClient({
    processFactory: async () => {
      throw new Error("Subprocess unavailable token=private-value");
    }
  });
  await assert.rejects(client.prepare(), (error) => {
    assert.equal(error.code, "ACP_PREPARE_SPAWN_FAILED");
    const display = formatACPError(error);
    assert.match(display, /阶段：启动 npm\/npx/u);
    assert.doesNotMatch(display, /private-value/u);
    return true;
  });
});

test("ordinary start fails before spawning when the pinned adapter was not prepared", async () => {
  let spawned = false;
  const client = new ACPClient({
    processFactory: async () => { spawned = true; return serveProcess(); },
    getPreparedVersion: () => ""
  });
  await assert.rejects(client.start(), { code: "ACP_NOT_PREPARED" });
  assert.equal(spawned, false);
});

test("runtime path and environment policy requires absolutes and forces offline agent mode", () => {
  assert.throws(() => validateRuntimePaths({
    nodePath: "node",
    npxCliPath: "/npm/npx-cli.js",
    codexPath: "/codex"
  }), { code: "ACP_PATH_INVALID" });
  const previous = global.PathUtils;
  global.PathUtils = { parent: (value) => value.slice(0, value.lastIndexOf("/")) || "/" };
  try {
    const environment = createEnvironment({
      nodePath: "/node/bin/node",
      npxCliPath: "/node/lib/npm/npx-cli.js",
      codexPath: "/codex/bin/codex"
    }, { allowDownload: false });
    assert.equal(environment.INITIAL_AGENT_MODE, "agent");
    assert.equal(environment.CODEX_PATH, "/codex/bin/codex");
    assert.equal(environment.npm_config_offline, "true");
    assert.doesNotMatch(environment.INITIAL_AGENT_MODE, /full-access/u);
  }
  finally {
    global.PathUtils = previous;
  }
});
