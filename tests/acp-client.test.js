"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  ACPClient,
  JSONLineDecoder,
  sanitizeDiagnostic,
  formatACPError,
  isAbsolutePath,
  validateRuntimePaths,
  createEnvironment,
  inspectSharedRuntime,
  inspectLocalRuntime,
  createSubprocess,
  listRuntimePathCandidates
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

test("Windows drive and UNC paths are absolute and use a semicolon PATH", () => {
  assert.equal(isAbsolutePath("C:\\Program Files\\nodejs\\node.exe"), true);
  assert.equal(isAbsolutePath("C:/Program Files/nodejs/node.exe"), true);
  assert.equal(isAbsolutePath("\\\\server\\share\\node.exe"), true);
  assert.equal(isAbsolutePath("C:node.exe"), false);
  assert.equal(isAbsolutePath("\\node.exe"), false);
  assert.doesNotThrow(() => validateRuntimePaths({
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
    npxCliPath: "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js",
    codexPath: "C:\\Users\\test\\codex.exe"
  }));

  const saved = { PathUtils: global.PathUtils, Services: global.Services };
  global.PathUtils = { parent: require("node:path").win32.dirname };
  global.Services = {
    appinfo: { OS: "WINNT" },
    env: { get: name => name === "PATH" ? "C:\\Windows\\System32;D:\\Tools" : "" }
  };
  try {
    const environment = createEnvironment({
      nodePath: "C:\\Program Files\\nodejs\\node.exe",
      npxCliPath: "C:\\Program Files\\nodejs\\npx-cli.js",
      codexPath: "C:\\Users\\test\\AppData\\Roaming\\npm\\codex.exe"
    }, { allowDownload: false });
    assert.equal(environment.PATH.split(";")[0], "C:\\Program Files\\nodejs");
    assert.equal(environment.PATH.split(";")[1], "C:\\Users\\test\\AppData\\Roaming\\npm");
    assert.match(environment.PATH, /C:\\Windows\\System32;D:\\Tools/u);
    assert.equal(environment.PATH.split(";").every(isAbsolutePath), true);
  }
  finally { Object.assign(global, saved); }
});

function piProcess(version = "0.0.33") {
  const process = new FakeProcess((message, process) => {
    if (message.method === "initialize") process.respond(message.id, {
      protocolVersion: 1, agentInfo: { name: "pi-acp", version }, agentCapabilities: { loadSession: true }
    });
  });
  process.stdin.close = async () => { process.stdinClosed = true; process.exit(); };
  return process;
}

test("Pi preparation validates initialize and ordinary startup stays offline without auth methods", async () => {
  const launched = [], processes = [];
  let prepared = "";
  const client = new ACPClient({ agentId: "pi", processFactory: async options => {
    launched.push(options); const process = piProcess(); processes.push(process); return process;
  }, getPreparedVersion: () => prepared, setPreparedVersion: value => { prepared = value; } });
  await assert.rejects(client.start(), { code: "ACP_NOT_PREPARED" });
  await client.prepare();
  assert.equal(prepared, "0.0.33");
  assert.deepEqual(launched, [{ purpose: "serve", allowDownload: true }]);
  assert.equal(processes[0].stdinClosed, true);
  await client.start();
  await client.refreshAuthenticationStatus();
  assert.deepEqual(launched[1], { purpose: "serve", allowDownload: false });
  assert.ok(processes.every(process => process.messages.every(message => message.method === "initialize")));
  await client.shutdown();
  assert.ok(processes.every(process => process.exited));
  assert.ok(processes.every(process => !process.killed), "graceful EOF lets the adapter dispose its Pi child");
});

test("Pi rejects mismatched adapter versions and cleans invalid protocol processes", async () => {
  const wrong = piProcess("0.0.34");
  const client = new ACPClient({ agentId: "pi", processFactory: async () => wrong, getPreparedVersion: () => "0.0.33" });
  await assert.rejects(client.start(), { code: "ACP_VERSION_MISMATCH" });
  assert.equal(wrong.exited, true);
  await client.shutdown();
  const process = piProcess();
  const malformed = new ACPClient({ agentId: "pi", processFactory: async () => process, getPreparedVersion: () => "0.0.33" });
  await malformed.start();
  process.stdout.push("{invalid}\n");
  await new Promise(resolve => setImmediate(resolve));
  await malformed.shutdown();
  assert.equal(process.exited, true);
});

test("shutdown reaps a Pi process that finishes spawning after cancellation", async () => {
  let resolve;
  const process = piProcess();
  const client = new ACPClient({ agentId: "pi", processFactory: () => new Promise(done => { resolve = done; }), getPreparedVersion: () => "0.0.33" });
  const started = assert.rejects(client.start(), { code: "ACP_STOPPED" });
  const stopped = client.shutdown();
  resolve(process);
  await Promise.all([started, stopped]);
  assert.equal(process.exited, true);
  assert.equal(process.messages.length, 0);
});

test("Pi uses its selected executable and offline startup settings with cached npm serving", () => {
  const old = global.PathUtils;
  global.PathUtils = { parent: path => path.slice(0, path.lastIndexOf("/")) };
  try {
    const paths = { nodePath: "/node/bin/node", npxCliPath: "/node/npx.js", piPath: "/local/bin/pi" };
    const environment = createEnvironment(paths, { allowDownload: false }, "pi");
    assert.equal(environment.PI_ACP_PI_COMMAND, paths.piPath);
    assert.equal(environment.PI_OFFLINE, "1");
    assert.equal(environment.PI_SKIP_VERSION_CHECK, "1");
    assert.equal(environment.npm_config_offline, "true");
    assert.equal(environment.INITIAL_AGENT_MODE, undefined);
    assert.equal(environment.PATH.split(":")[0], "/node/bin");
    assert.equal(createEnvironment(paths, { allowDownload: true }, "pi").npm_config_offline, undefined);
  } finally { global.PathUtils = old; }
});

test("only Pi launches the bundled compatibility code through pinned offline npm and the selected Node", async () => {
  const old = { ChromeUtils: global.ChromeUtils, PathUtils: global.PathUtils };
  const calls = [];
  global.PathUtils = { parent: require("node:path").dirname };
  global.ChromeUtils = { importESModule: () => ({ Subprocess: { call: options => { calls.push(options); return options; } } }) };
  const shared = { nodePath: "/chosen node/bin/node", npxCliPath: "/chosen node/npm/npx-cli.js" };
  try {
    await createSubprocess({ ...shared, piPath: "/pi/bin/pi" }, { purpose: "serve", allowDownload: false }, "pi");
    const pi = calls[0];
    assert.equal(pi.command, shared.nodePath);
    assert.deepEqual(pi.arguments.slice(0, -1), [shared.npxCliPath, "--yes", "--package", "pi-acp@0.0.33", "--", shared.nodePath, "--input-type=commonjs", "--eval"]);
    assert.match(pi.arguments.at(-1), /get_available_thinking_levels/u);
    assert.equal(pi.environment.npm_config_offline, "true");
    await createSubprocess({ ...shared, codexPath: "/codex/bin/codex" }, { purpose: "serve", allowDownload: false }, "codex");
    assert.deepEqual(calls[1].arguments, [shared.npxCliPath, "--yes", "--package", "@agentclientprotocol/codex-acp@1.6.2", "codex-acp"]);
  } finally { Object.assign(global, old); }
});

async function withRuntimeProbe(results, callback) {
  const saved = { PathUtils: global.PathUtils, IOUtils: global.IOUtils, ChromeUtils: global.ChromeUtils };
  const calls = [];
  global.PathUtils = { parent: require("node:path").dirname };
  global.IOUtils = { exists: async () => true };
  global.ChromeUtils = { importESModule: () => ({ Subprocess: { async call(options) {
    calls.push(options);
    const name = options.command.endsWith("/pi") ? "pi" : options.arguments.length > 1 ? "npx" : "node";
    const result = { exitCode: 0, stdout: "", stderr: "", ...results[name] };
    const pipe = (text) => ({ async readString() { const chunk = text; text = ""; return chunk; } });
    return { wait: async () => ({ exitCode: result.exitCode }), stdout: pipe(result.stdout), stderr: pipe(result.stderr) };
  } } }) };
  try { await callback(calls); }
  finally { Object.assign(global, saved); }
}

const runtimePaths = { nodePath: "/chosen/bin/node", npxCliPath: "/chosen/npm/npx-cli.js", piPath: "/other/bin/pi" };
const supportedRuntime = { node: { stdout: "v24.14.0\n" }, npx: { stdout: "11.9.0\n" }, pi: { stdout: "0.85.1\n" } };

test("shared runtime inspection only executes local Node and npm version commands", async () => {
  await withRuntimeProbe(supportedRuntime, async (calls) => {
    const result = await inspectSharedRuntime(runtimePaths);
    assert.equal(result.healthy, true);
    assert.deepEqual(result.versions, { node: "v24.14.0", npx: "11.9.0" });
    assert.deepEqual(calls.map(({ command, arguments: args }) => [command, args]), [
      [runtimePaths.nodePath, ["--version"]], [runtimePaths.nodePath, [runtimePaths.npxCliPath, "--version"]]
    ]);
    assert.ok(calls.every(call => call.environment.npm_config_offline === "true"));
    assert.ok(calls.every(call => !Object.values(call.environment).includes(undefined)));
  });
});

test("Pi version inspection uses the shared Node directory and accepts supported versions on either stream", async () => {
  await withRuntimeProbe({ ...supportedRuntime, pi: { stderr: "0.85.1\n" } }, async (calls) => {
    const result = await inspectLocalRuntime(runtimePaths, "pi");
    assert.equal(result.healthy, true);
    assert.equal(result.versions.pi, "0.85.1");
    assert.equal(calls.length, 3);
    assert.ok(calls.every(call => call.environment.PATH.startsWith("/chosen/bin:")));
    assert.ok(calls.every(call => call.environment.PI_OFFLINE === "1"));
    assert.ok(calls.every(call => call.arguments.at(-1) === "--version"));
  });
});

test("Pi requirement failures report the selected paths and both detected versions", async () => {
  for (const [nodeVersion, piVersion] of [["22.13.0", "0.85.1"], ["24.14.0", "0.85.0"]]) {
    await withRuntimeProbe({ ...supportedRuntime, node: { stdout: `v${nodeVersion}` }, pi: { stdout: piVersion } }, async () => {
      await assert.rejects(inspectLocalRuntime(runtimePaths, "pi"), error => {
        assert.equal(error.code, "PI_RUNTIME_VERSION");
        assert.match(error.details.detectedVersion, new RegExp(nodeVersion.replaceAll(".", "\\.")));
        assert.equal(error.details.paths.nodePath, runtimePaths.nodePath);
        assert.match(formatACPError(error), /22\.19\.0/u);
        return true;
      });
    });
  }
});

test("Pi command failure and unknown output are not reported as an old installed version", async () => {
  await withRuntimeProbe({ ...supportedRuntime, pi: { exitCode: 1, stderr: "Pi failed: token=private-value" } }, async () => {
    await assert.rejects(inspectLocalRuntime(runtimePaths, "pi"), error => {
      assert.equal(error.code, "PI_RUNTIME_PROBE_FAILED");
      assert.equal(error.details.exitCode, 1);
      assert.match(error.details.stderr, /Pi failed/u);
      assert.doesNotMatch(formatACPError(error), /private-value/u);
      return true;
    });
  });
  await withRuntimeProbe({ ...supportedRuntime, pi: { stdout: "See /installed/0.85.1/help" } }, async () => {
    await assert.rejects(inspectLocalRuntime(runtimePaths, "pi"), { code: "PI_RUNTIME_VERSION_UNKNOWN" });
  });
});

test("candidate discovery reads PATH, NVM and npm symlinks without executing programs", async () => {
  const names = ["Services", "Ci", "Cc", "IOUtils", "PathUtils", "ChromeUtils"];
  const saved = Object.fromEntries(names.map(name => [name, global[name]]));
  const files = new Set([
    "/usr/local/bin/node", "/home/test/.nvm/versions/node/v24.14.0/bin/node",
    "/home/test/.nvm/versions/node/v9.11.0/bin/node", "/custom-nvm/versions/node/v25.1.0/bin/node",
    "/home/test/.nvm/versions/node/v24.14.0/lib/node_modules/npm/bin/npx-cli.js",
    "/custom-nvm/versions/node/v25.1.0/bin/pi", "/custom-nvm/versions/node/v25.1.0/bin/codex",
    "/path with spaces/bin/pi", "/path with spaces/bin/codex", "/npm-location/bin/npx-cli.js"
  ]);
  const stats = [];
  global.PathUtils = { join: require("node:path").posix.join, parent: require("node:path").posix.dirname };
  global.Services = {
    dirsvc: { get: () => ({ path: "/home/test" }) },
    env: { get: name => ({ PATH: "/path with spaces/bin:/unreadable/bin:/usr/local/bin:relative/bin:/path with spaces/bin", NVM_DIR: "/custom-nvm" })[name] || "" }
  };
  global.Ci = { nsIFile: {} };
  global.Cc = { "@mozilla.org/file/local;1": { createInstance: () => ({
    initWithPath(path) { this.path = path; },
    isSymlink() { return this.path === "/path with spaces/bin/npx"; },
    get target() { return "/npm-location/bin/npx-cli.js"; }
  }) } };
  global.IOUtils = {
    async getChildren(path) {
      if (path === "/home/test/.nvm/versions/node") return ["/home/test/.nvm/versions/node/v9.11.0", "/home/test/.nvm/versions/node/v24.14.0", "/home/test/.nvm/versions/node/unrelated"];
      if (path === "/custom-nvm/versions/node") return ["/custom-nvm/versions/node/v25.1.0"];
      throw new Error("absent");
    },
    async stat(path, options) {
      stats.push(path);
      assert.equal(options.followSymlinks, true);
      if (path === "/unreadable/bin/node") throw new Error("permission denied");
      if (path === "/path with spaces/bin/node") return { type: "directory" };
      if (files.has(path)) return { type: "regular" };
      throw new Error("missing");
    }
  };
  global.ChromeUtils = { importESModule() { throw new Error("discovery must not launch a process"); } };
  try {
    const candidates = await listRuntimePathCandidates({ nodePath: "/usr/local/bin/node", piPath: "/missing/pi" });
    assert.equal(candidates.node[0].source, "configured");
    assert.deepEqual(candidates.node.slice(1).map(entry => entry.version), ["v25.1.0", "v24.14.0", "v9.11.0"]);
    for (const kind of ["pi", "codex"]) {
      assert.ok(candidates[kind].some(entry => entry.path === `/path with spaces/bin/${kind}` && entry.source === "path"));
      assert.ok(candidates[kind].some(entry => entry.source === "nvm"));
    }
    assert.ok(candidates.npx.some(entry => entry.path === "/npm-location/bin/npx-cli.js"));
    assert.ok(candidates.npx.some(entry => entry.source === "nvm"));
    assert.equal(candidates.pi.some(entry => entry.path === "/missing/pi"), false);
    assert.equal(stats.filter(path => path === "/path with spaces/bin/pi").length, 1);
    assert.equal(stats.some(path => !path.startsWith("/")), false);
  }
  finally { Object.assign(global, saved); }
});

test("OpenCode native handshake requires version, load and close and never uses Codex auth or npm preparation", async () => {
  let saved = "", version = "1.18.30", cleaned = 0;
  const launches = [];
  const process = new FakeProcess((message, process) => {
    assert.notEqual(message.method, "authentication/status");
    if (message.method === "initialize") process.respond(message.id, {
      protocolVersion: 1, agentInfo: { name: "OpenCode", version },
      agentCapabilities: { loadSession: true, sessionCapabilities: { close: {} } }
    });
  });
  const client = new ACPClient({ agentId: "opencode",
    nativeRuntime: { readVersion: async () => version, cleanup: async () => { cleaned++; } },
    processFactory: async options => { launches.push(options); return process; },
    getPreparedVersion: () => saved, setPreparedVersion: value => { saved = value; }
  });
  await client.prepare();
  assert.equal(saved, "1.18.30");
  assert.equal(launches[0].allowDownload, false);
  assert.equal((await client.refreshAuthenticationStatus()).status, "configured-in-opencode");
  saved = ""; // Changing the executable path invalidates even an existing connection.
  await assert.rejects(client.start({ cwd: "/paper" }), { code: "ACP_NOT_PREPARED" });
  assert.equal(process.killed, true);
  saved = "1.18.30";
  version = "1.18.31";
  await assert.rejects(client.start({ cwd: "/paper" }), { code: "ACP_NOT_PREPARED" });
  assert.equal(saved, "");
  assert.equal(launches.length, 1);
  assert.ok(cleaned);
  await client.shutdown();
});

test("OpenCode accepts title-prefixed long configuration frames while Codex remains strict", async () => {
  const result = { configOptions: [{ id: "model", options: Array.from({ length: 900 }, (_, n) => ({ value: `provider/model-${n}`, name: "中文模型 " + "long name ".repeat(10) })) }] };
  const process = new FakeProcess((message, process) => {
    if (message.method === "initialize") process.respond(message.id, {
      protocolVersion: 1, agentInfo: { name: "OpenCode", version: "1.18.30" },
      agentCapabilities: { loadSession: true, sessionCapabilities: { close: {} } }
    });
    else {
      const wire = "\x1b]0;paper: ready\x07" + JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n";
      for (let offset = 0; offset < wire.length; offset += 32768) process.stdout.push(wire.slice(offset, offset + 32768));
    }
  });
  const client = new ACPClient({ agentId: "opencode", processFactory: async () => process,
    nativeRuntime: { readVersion: async () => "1.18.30", cleanup: async () => {} }, getPreparedVersion: () => "1.18.30"
  });
  await client.start();
  assert.deepEqual(await client.request("session/new", {}), result);
  await client.shutdown();
  const codex = serveProcess();
  const strict = new ACPClient({ processFactory: async () => codex, getPreparedVersion: () => "1.6.2" });
  await strict.start();
  const pending = strict.request("session/new", {});
  codex.stdout.push('\x1b]0;title\x07{"jsonrpc":"2.0","id":3,"result":{}}\n');
  await assert.rejects(pending, { code: "ACP_INVALID_JSON" });
  await strict.shutdown();
});

test("late chunks from a replaced process cannot reach a new connection or its diagnostic buffer", async () => {
  const client = new ACPClient();
  const previous = new FakeProcess(), next = new FakeProcess();
  client.process = previous; client.generation = 1; client.decoder = new JSONLineDecoder();
  const stdout = client._readStdout(previous, 1), stderr = client._readStderr(previous, 1);
  client.process = next; client.generation = 2; client.decoder = new JSONLineDecoder();
  const events = [];
  client.subscribe(event => events.push(event));
  previous.stdout.push('{"jsonrpc":"2.0","method":"session/update","params":{}}\n');
  previous.stderr.push("previous process diagnostic");
  await Promise.all([stdout, stderr]);
  assert.equal(client.decoder.buffer, "");
  assert.equal(client.stderr, "");
  assert.deepEqual(events, []);
  await client.shutdown();
});

test("candidate discovery preserves Windows drive letters and finds Node plus npx-cli.js", async () => {
  const names = ["Services", "Ci", "Cc", "IOUtils", "PathUtils", "Zotero"];
  const saved = Object.fromEntries(names.map(name => [name, global[name]]));
  const path = require("node:path").win32;
  const files = new Set([
    "C:\\Program Files\\nodejs\\node.exe",
    "C:\\Program Files\\nodejs\\npx-cli.js",
    "C:\\Users\\test\\AppData\\Roaming\\npm\\codex.exe",
    "D:\\nvm\\v24.14.0\\node.exe",
    "D:\\nvm\\v24.14.0\\node_modules\\npm\\bin\\npx-cli.js"
  ]);
  const stats = [];
  global.PathUtils = { join: path.join, parent: path.dirname };
  global.Zotero = { isWin: true };
  global.Services = {
    appinfo: { OS: "WINNT" },
    dirsvc: { get: () => ({ path: "C:\\Users\\test" }) },
    env: { get: name => ({
      PATH: "C:\\Program Files\\nodejs;C:\\Users\\test\\AppData\\Roaming\\npm;relative",
      ProgramFiles: "C:\\Program Files",
      APPDATA: "C:\\Users\\test\\AppData\\Roaming",
      NVM_HOME: "D:\\nvm"
    })[name] || "" }
  };
  global.Ci = { nsIFile: {} };
  global.Cc = { "@mozilla.org/file/local;1": { createInstance: () => ({
    initWithPath(value) { this.path = value; },
    isSymlink() { return false; }
  }) } };
  global.IOUtils = {
    async getChildren(value) {
      if (value === "D:\\nvm") return ["D:\\nvm\\v24.14.0", "D:\\nvm\\settings.txt"];
      throw new Error("absent");
    },
    async stat(value) {
      stats.push(value);
      if (files.has(value)) return { type: "regular" };
      throw new Error("missing");
    }
  };
  try {
    const candidates = await listRuntimePathCandidates();
    assert.ok(candidates.node.some(entry => entry.path === "C:\\Program Files\\nodejs\\node.exe"));
    assert.ok(candidates.node.some(entry => entry.path === "D:\\nvm\\v24.14.0\\node.exe" && entry.version === "v24.14.0"));
    assert.ok(candidates.npx.some(entry => entry.path === "C:\\Program Files\\nodejs\\npx-cli.js"));
    assert.ok(candidates.npx.some(entry => entry.path === "D:\\nvm\\v24.14.0\\node_modules\\npm\\bin\\npx-cli.js"));
    assert.ok(candidates.codex.some(entry => entry.path === "C:\\Users\\test\\AppData\\Roaming\\npm\\codex.exe"));
    assert.equal(stats.includes("C"), false);
    assert.equal(stats.some(value => value === "relative" || value.startsWith("relative\\")), false);
  }
  finally { Object.assign(global, saved); }
});
