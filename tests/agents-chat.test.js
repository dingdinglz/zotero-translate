"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { AgentsChatService } = require("../plugin/content/agents-chat.js");
const Agents = require("../plugin/content/agent-providers.js");
const Constants = require("../plugin/content/constants.js");

function harness() {
  const prefs = new Map();
  const papers = new Map([[10, "1--ABCDEFGH"], [11, "1--IJKLMNOP"]]);
  const services = [];
  const makeService = () => {
    const service = {
      states: new Map(), configurationCatalog: {}, listeners: [], released: 0, stopped: 0,
      acp: { getStatus: () => ({ healthy: true }), prepare: async () => {} },
      subscribe(_id, listener) { this.listeners.push(listener); },
      async initialize() {},
      async releaseIdle() { this.released++; },
      async refreshConfigurationCatalog() { return this.configurationCatalog; },
      notifyDefaultConfigurationChanged() {}, notifyDeveloperModeChanged() {},
      async shutdown() { this.stopped++; }
    };
    services.push(service); return service;
  };
  const codex = makeService(), probe = makeService();
  const router = new AgentsChatService({
    codexService: codex, piProbeService: probe, createPiService: makeService,
    paperRepository: { async get(id) { return { paper: { storageKey: papers.get(id), attachmentID: id } }; } },
    getPreference: key => prefs.get(key), setPreference: (key, value) => prefs.set(key, value)
  });
  return { router, codex, probe, services, prefs };
}

test("Agent choice defaults to Codex and switching only changes local per-paper preference", async () => {
  const h = harness();
  assert.equal(await h.router.getActiveAgent(10), "codex");
  await h.router.setActiveAgent(10, "pi");
  assert.equal(h.services.length, 2, "switching must not allocate a Pi connection");
  assert.equal(await h.router.getActiveAgent(10), "pi");
  assert.equal(await h.router.getActiveAgent(11), "codex");
  await h.router.setActiveAgent(10, "codex");
  assert.equal(await h.router.getActiveAgent(10), "codex");
  h.prefs.set(Constants.PREFS.agentsByPaper, '{"1--ABCDEFGH":"unknown","__proto__":"pi"}');
  assert.equal(await h.router.getActiveAgent(10), "codex");
  await assert.rejects(h.router.setActiveAgent(10, "unknown"), /Unknown Agent/u);
  await h.router.shutdown();
});

test("Pi uses one connection per PDF and refcounts readers while other papers can generate", async () => {
  const h = harness();
  const first = h.router.forAgent("pi", 10), second = h.router.forAgent("pi", 11);
  assert.notEqual(first, second);
  assert.notEqual(first, h.probe);
  assert.equal(h.router.forAgent("pi", 10), first);
  h.router.retain("pi", 10); h.router.retain("pi", 10);
  h.router.release("pi", 10);
  assert.equal(first.released, 0);
  second.states.set("1--IJKLMNOP", { turn: {}, interactions: new Map(), status: "generating" });
  await h.router.setActiveAgent(10, "pi");
  h.router.release("pi", 10);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(first.released, 1);
  assert.equal(second.released, 0);
  await h.router.shutdown();
  assert.ok(h.services.every(service => service.stopped === 1));
});

test("agent switching waits for connection, permission and cancellation to finish", async () => {
  const h = harness();
  const state = { turn: null, status: "connecting", interactions: new Map() };
  h.codex.states.set("1--ABCDEFGH", state);
  for (const status of ["connecting", "cancelling"]) {
    state.status = status;
    await assert.rejects(h.router.setActiveAgent(10, "pi"), /Wait/u);
  }
  state.status = "ready"; state.interactions.set("approval", {});
  await assert.rejects(h.router.setActiveAgent(10, "pi"), /Wait/u);
  state.interactions.clear(); state.turn = {};
  await assert.rejects(h.router.setActiveAgent(10, "pi"), /Wait/u);
  state.turn = null;
  await h.router.setActiveAgent(10, "pi");
  assert.equal(await h.router.getActiveAgent(10), "pi");
  await h.router.shutdown();
});

test("Pi preparation lock covers initialization and cannot replace a paper connection", async () => {
  const h = harness();
  const paper = h.router.forAgent("pi", 10);
  let finish;
  h.probe.acp.prepare = () => new Promise(resolve => { finish = resolve; });
  const pending = h.router.refreshPiCatalog({ prepare: true });
  await assert.rejects(h.router.refreshPiCatalog({ prepare: true }), /already running/u);
  assert.equal(paper.released, 0);
  finish(); await pending;
  await h.router.shutdown();
});

test("Pi thinking normalization is idempotent and never exposes Pi mode as permissions", () => {
  const raw = [{ id: "mode", currentValue: "high" }, { id: "thought_level", currentValue: "high" }, { id: "model", currentValue: "p/m" }];
  const normalized = Agents.normalizeConfigOptions(raw, "pi");
  assert.deepEqual(normalized.map(option => option.id), ["reasoning_effort", "model"]);
  assert.deepEqual(Agents.normalizeConfigOptions(normalized, "pi"), normalized);
  assert.equal(Agents.validMode("agent-full-access", "pi"), false);
  assert.match(Agents.readerText("add", "en-US"), /Agents/u);
  assert.match(Agents.readerText("add", "zh-CN"), /添加/u);
});
