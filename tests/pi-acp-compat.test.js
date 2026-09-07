"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { spawn, spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { pathToFileURL } = require("node:url");
const { registerHooks } = require("node:module");
const Compat = require("../plugin/content/pi-acp-compat.js");

// Only the replacement boundaries are needed to exercise the actual serialized
// functions; all Pi RPC calls below are controlled fixtures, never a model.
const boundaryFixture = `class Proc {
  async setThinkingLevel(level) { throw new Error("old setter"); }
  async setFollowUpMode(mode) {}
}
function isThinkingLevel(x) { return x === "high"; }
async function getThinkingState(proc, pre) { throw new Error("old state"); }
async function getSessionConfiguration(proc, pre) {}
`;

function thinkingFixture() {
  const context = vm.createContext({});
  vm.runInContext(Compat.patchAdapterSource(boundaryFixture) + "globalThis.api = { Proc, getThinkingState };", context);
  const proc = new context.api.Proc();
  proc.calls = [];
  proc.levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  proc.level = "max";
  proc.request = async command => {
    proc.calls.push(command.type);
    if (command.type === "get_available_thinking_levels") return { success: true, data: { levels: proc.levels } };
    if (command.type === "set_thinking_level") { if (!proc.clamp) proc.level = command.level; return { success: true }; }
    throw new Error(`Unexpected RPC: ${command.type}`);
  };
  proc.getState = async () => ({ thinkingLevel: proc.level });
  return { proc, getState: () => context.api.getThinkingState(proc) };
}

test("Pi thinking options preserve max and follow current model capabilities", async () => {
  const { proc, getState } = thinkingFixture();
  assert.equal((await getState()).currentModeId, "max");
  assert.deepEqual(Array.from((await getState()).availableModes, mode => mode.id), proc.levels);
  proc.levels = ["off"];
  proc.level = "off";
  assert.deepEqual(Array.from((await getState()).availableModes, mode => mode.id), ["off"]);
  await assert.rejects(proc.setThinkingLevel("max"), /SPT_PI_THINKING_UNSUPPORTED/u);
  assert.ok(!proc.calls.includes("set_thinking_level"));
});

test("Pi thinking setter accepts max only after capability validation and actual readback", async () => {
  const { proc, getState } = thinkingFixture();
  proc.level = "high";
  await proc.setThinkingLevel("max");
  assert.equal((await getState()).currentModeId, "max");
  await proc.setThinkingLevel("high");
  proc.clamp = true;
  await assert.rejects(proc.setThinkingLevel("max"), /SPT_PI_THINKING_NOT_APPLIED/u);
  assert.equal((await getState()).currentModeId, "high");
});

test("Pi capability errors and invalid current state fail instead of inventing a medium default", async () => {
  const { proc, getState } = thinkingFixture();
  for (const levels of [[], ["high", "unknown"], "max", null]) {
    proc.levels = levels;
    await assert.rejects(getState(), /SPT_PI_THINKING_OPTIONS/u);
  }
  proc.levels = ["high"];
  await assert.rejects(getState(), /SPT_PI_THINKING_STATE/u);
  proc.request = async () => ({ success: false, error: "Unknown command" });
  await assert.rejects(proc.setThinkingLevel("max"), /SPT_PI_THINKING_OPTIONS/u);
  assert.throws(() => Compat.patchAdapterSource("changed adapter"), /SPT_PI_COMPAT_LAYOUT/u);
});

test("Pi launcher refuses altered pinned code without executing it or rewriting the cache", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "spt-pi-compat-"));
  try {
    const dist = path.join(directory, "pi-acp", "dist"), bin = path.join(directory, "bin");
    fs.mkdirSync(dist, { recursive: true }); fs.mkdirSync(bin);
    fs.writeFileSync(path.join(dist, "..", "package.json"), JSON.stringify({ name: "pi-acp", version: "0.0.33", type: "module" }));
    const source = 'process.stdout.write("SHOULD_NOT_EXECUTE");';
    fs.writeFileSync(path.join(dist, "index.js"), source);
    fs.symlinkSync(path.join(dist, "index.js"), path.join(bin, "pi-acp"));
    const result = spawnSync(process.execPath, ["--input-type=commonjs", "--eval", Compat.createLauncherSource()], {
      env: { PATH: bin }, encoding: "utf8", timeout: 5000
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /SPT_PI_COMPAT_HASH/u);
    assert.equal(result.stdout, "");
    assert.equal(fs.readFileSync(path.join(dist, "index.js"), "utf8"), source);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

// Opt in with an already-prepared local adapter. This never downloads anything,
// starts Pi, creates a session, or reads credentials or a user's session map.
if (process.env.SPT_TEST_PI_ACP_ENTRY) {
  const entry = fs.realpathSync(process.env.SPT_TEST_PI_ACP_ENTRY);
  test("cached pi-acp 0.0.33 executes the compatibility launcher and exits on EOF", async () => {
    const bytes = fs.readFileSync(entry);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), Compat.ADAPTER_SHA256);
    const bin = path.resolve(path.dirname(entry), "../../.bin");
    const child = spawn(process.execPath, ["--input-type=commonjs", "--eval", Compat.createLauncherSource()], {
      env: { PATH: bin, PI_OFFLINE: "1", npm_config_offline: "true" }, stdio: ["pipe", "pipe", "pipe"]
    });
    let output = "", stderr = "";
    const exited = new Promise(resolve => child.once("close", resolve));
    child.stderr.on("data", chunk => { stderr += chunk; });
    const timer = setTimeout(() => child.kill(), 5000);
    try {
      const response = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", () => reject(new Error(stderr || "Adapter exited before initialize")));
        child.stdout.on("data", chunk => {
          output += chunk;
          for (const line of output.split("\n").slice(0, -1)) {
            const message = JSON.parse(line);
            if (message.id === 1) resolve(message);
          }
        });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } }) + "\n");
      });
      assert.equal(response.result.agentInfo.version, "0.0.33");
      child.stdin.end();
      assert.equal(await exited, 0, stderr);
      assert.deepEqual(fs.readFileSync(entry), bytes);
    } finally { clearTimeout(timer); if (child.exitCode === null) child.kill(); await exited; }
  });

  test("real pinned ACP config methods advertise, apply and restore max with a fake Pi RPC", async () => {
    const source = fs.readFileSync(entry, "utf8");
    assert.equal(createHash("sha256").update(source).digest("hex"), Compat.ADAPTER_SHA256);
    const patched = Compat.patchAdapterSource(source);
    const boot = patched.lastIndexOf("// src/index.ts");
    assert.ok(boot > 0);
    const url = pathToFileURL(entry).href;
    const hook = registerHooks({ load(specifier, context, nextLoad) {
      if (specifier === url) return { format: "module", shortCircuit: true,
        source: patched.slice(0, boot) + "\nexport { PiAcpAgent, PiRpcProcess, getSessionConfiguration };" };
      return nextLoad(specifier, context);
    } });
    let adapter;
    try { adapter = await import(url); } finally { hook.deregister(); }
    const proc = Object.create(adapter.PiRpcProcess.prototype);
    let level = "max", model = "a";
    const calls = [];
    proc.request = async command => {
      calls.push(command.type);
      const models = [{ id: "a", provider: "fixture" }, { id: "b", provider: "fixture" }];
      switch (command.type) {
        case "get_available_thinking_levels": return { success: true, data: { levels: model === "a" ? ["high", "xhigh", "max"] : ["off"] } };
        case "get_state": return { success: true, data: { thinkingLevel: level, model: models.find(item => item.id === model) } };
        case "get_available_models": return { success: true, data: { models } };
        case "set_model": model = command.modelId; level = model === "a" ? "max" : "off"; return { success: true };
        case "set_thinking_level": level = command.level; return { success: true };
        default: throw new Error(`Unexpected RPC: ${command.type}`);
      }
    };
    const updates = [];
    const agent = new adapter.PiAcpAgent({ sessionUpdate: async update => { updates.push(update); } });
    agent.restoreSession = async () => ({ sessionId: "fixture-session", proc });
    const thinking = options => options.find(option => option.id === "thought_level");
    assert.equal(thinking((await adapter.getSessionConfiguration(proc)).configOptions).currentValue, "max");
    const set = (configId, value) => agent.setSessionConfigOption({ sessionId: "fixture-session", configId, value });
    await set("thought_level", "high");
    assert.equal(thinking((await set("thought_level", "max")).configOptions).currentValue, "max");
    assert.equal(thinking((await adapter.getSessionConfiguration(proc)).configOptions).currentValue, "max");
    assert.deepEqual(thinking((await set("model", "fixture/b")).configOptions).options.map(option => option.value), ["off"]);
    await assert.rejects(set("thought_level", "max"), /SPT_PI_THINKING_UNSUPPORTED/u);
    assert.ok(updates.some(update => thinking(update.update.configOptions || [])?.currentValue === "max"));
    assert.ok(!calls.includes("prompt"));
    assert.equal(fs.readFileSync(entry, "utf8"), source);
  });
}
