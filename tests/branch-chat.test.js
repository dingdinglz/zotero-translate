"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { MemoryIO, makePaper, makePreferenceStore } = require("./helpers.js");
const { normalizeContext, contextFromTranscript, MemoryBranchCache, BranchChatService, createZoteroBranchService } = require("../plugin/content/branch-chat.js");
const Agents = require("../plugin/content/agent-providers.js");
const clone = value => JSON.parse(JSON.stringify(value));
const context = agentId => ({
  agentId, attachmentID: 10, paper: makePaper(), selectionText: "self attention",
  answerText: "The paper uses self attention.", questionText: "Explain this paper",
  config: { model: "model-b", reasoningEffort: "high" }
});

function fixture(agentId = "codex", overrides = {}) {
  const io = new MemoryIO();
  const prefs = makePreferenceStore();
  const provider = Agents.getProvider(agentId);
  const calls = [];
  const options = [
    { id: "mode", currentValue: agentId === "codex" ? "agent-full-access" : "build", options: [{ value: "agent" }, { value: "agent-full-access" }, { value: "build" }] },
    { id: "model", currentValue: "model-a", options: [{ value: "model-a" }, { value: "model-b" }] },
    { id: provider.reasoningID, currentValue: "medium", options: [{ value: "medium" }, { value: "high" }] }
  ];
  const listeners = new Set();
  const handlers = new Map();
  let healthy = false;
  let pending = null;
  const acp = {
    calls, listeners, handlers,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    onRequest(method, fn) { handlers.set(method, fn); return () => handlers.delete(method); },
    getStatus: () => ({ healthy, preparedVersion: provider.version, requiredVersion: provider.version }),
    start: async opts => { calls.push(["start", opts]); healthy = true; },
    request: async (method, params, settings) => {
      calls.push([method, clone(params), settings]);
      if (method === "session/new") return { sessionId: "branch-session", configOptions: clone(options) };
      if (method === "session/set_config_option") {
        options.find(option => option.id === params.configId).currentValue = params.value;
        return { configOptions: clone(options) };
      }
      if (method === "session/prompt") {
        if (overrides.prompt) return overrides.prompt(params, emit);
        if (overrides.pending) return new Promise((resolve, reject) => { pending = { resolve, reject }; });
        emit({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "An explanation." } });
        return { stopReason: "end_turn" };
      }
      if (method === "session/close") return {};
      throw new Error(`Unexpected method: ${method}`);
    },
    cancelSession: async id => { calls.push(["cancel", id]); },
    shutdown: async () => { calls.push(["shutdown"]); healthy = false; pending?.reject(new Error("closed")); }
  };
  function emit(update) {
    for (const listener of listeners) listener({ type: "notification", method: "session/update", params: { sessionId: "branch-session", update } });
  }
  const cache = new MemoryBranchCache({ context: context(agentId), rootPath: `/tmp/branch-${agentId}`,
    localID: "unique", io, joinPath: (...parts) => parts.join("/") });
  const fileCalls = [];
  const fileSystem = {
    join: (...parts) => parts.join("/"),
    getAttachmentPath: async id => { fileCalls.push(["attachment", id]); return "/library/paper.pdf"; },
    stat: async () => ({ size: 100, lastModified: 42, type: "regular" }),
    copyAtomic: async (source, target) => { fileCalls.push(["copy", source, target]); io.setText(target, "PDF"); },
    hasPDFToText: async () => true,
    extractPDFText: async () => "paper text",
    writeUTF8Atomic: async (path, text) => io.setText(path, text),
    toFileURI: path => `file://${path}`,
    remove: path => io.remove(path, { ignoreAbsent: true })
  };
  const service = new BranchChatService({ context: context(agentId), cache, acpClient: acp, getPreference: prefs.get, fileSystem });
  return { service, cache, io, acp, emit, fileSystem, fileCalls, options };
}

function sourceState() {
  return {
    agentId: "pi", attachmentID: 10, paper: makePaper(), configOptions: [{ id: "model", currentValue: "selected-model" }],
    record: { session: { id: "MAIN-SESSION", localID: "MAIN-LOCAL", workspacePath: "/MAIN", config: { mode: "agent-full-access", reasoningEffort: "high" } },
      transcript: [
        { kind: "message", role: "user", text: "old question", id: "old-u" },
        { kind: "message", role: "agent", text: "old answer", id: "old-a", status: "complete" },
        { kind: "message", role: "user", text: "current question", id: "u", screenshots: [{ data: "secret screenshot" }] },
        { kind: "thought", text: "private thought", id: "t" },
        { kind: "message", role: "agent", text: "first half", id: "a1", status: "complete" },
        { kind: "tool", rawOutput: "secret output", id: "tool" },
        { kind: "message", role: "agent", text: "second half", id: "a2", status: "complete" },
        { kind: "message", role: "user", text: "next question", id: "next" },
        { kind: "message", role: "agent", text: "stream", id: "new", status: "streaming" }
      ] }
  };
}

test("branch context copies exactly the selected completed turn and effective configuration", () => {
  const state = sourceState();
  const result = contextFromTranscript(state, "a2", "second");
  assert.equal(result.answerText, "first half\n\nsecond half");
  assert.equal(result.questionText, "current question");
  assert.deepEqual(result.config, { model: "selected-model", reasoningEffort: "high" });
  assert.doesNotMatch(JSON.stringify(result), /MAIN|old question|old answer|next question|private thought|secret/);
  state.paper.title = "changed";
  state.configOptions[0].currentValue = "changed";
  assert.equal(result.paper.title, "A Test Paper");
  assert.equal(result.config.model, "selected-model");
});

test("branch rejects nonreply, incomplete, orphaned, empty, oversize and mismatched contexts", () => {
  const state = sourceState();
  for (const key of ["u", "t", "tool", "new", "missing"]) assert.throws(() => contextFromTranscript(state, key, "text"));
  assert.throws(() => contextFromTranscript(state, "a1", " "));
  state.record.transcript[6].status = "streaming";
  assert.throws(() => contextFromTranscript(state, "a1", "text"));
  assert.throws(() => normalizeContext({ ...context("codex"), attachmentID: 20 }));
  assert.throws(() => normalizeContext({ ...context("codex"), selectionText: "x".repeat(16385) }));
  assert.throws(() => normalizeContext({ ...context("codex"), answerText: "中".repeat(100000) }));
});

for (const agentId of ["codex", "pi", "opencode"]) {
  test(`${agentId} opening is local-only; sends use isolated session/cwd, inherited config and one-time context`, async () => {
    const { service, cache, io, acp, fileCalls } = fixture(agentId);
    try {
      const initial = await service.load(10);
      assert.equal(initial.record.transcript.length, 0);
      assert.equal(acp.calls.length, 0);
      assert.equal(fileCalls.length, 0);
      assert.equal(io.directories.size, 0);
      initial.record.session.config.model = "mutated snapshot";
      await service.send(10, "Explain this term");
      await service.send(10, "Give an example");
      const state = await service.load(10);
      assert.equal(state.record.session.config.model, "model-b");
      assert.equal(state.record.session.config.reasoningEffort, "high");
      assert.equal(state.record.session.config.mode, agentId === "codex" ? "agent" : null);
      const cwd = `/tmp/branch-${agentId}/workspaces/1--ABCDEFGH/unique`;
      assert.equal(acp.calls.find(([method]) => method === "start")[1].cwd, cwd);
      assert.equal(acp.calls.find(([method]) => method === "session/new")[1].cwd, cwd);
      assert.equal(acp.calls.filter(([method]) => method === "session/new").length, 1);
      const prompts = acp.calls.filter(([method]) => method === "session/prompt");
      assert.match(JSON.stringify(prompts[0]), /self attention.*sourceReply.*sourceQuestion/);
      assert.doesNotMatch(JSON.stringify(prompts[1]), /BRANCH_CONTEXT|sourceReply|sourceQuestion|resource_link/);
      assert.equal(fileCalls.filter(([method]) => method === "copy").length, 1);
      assert.equal(fileCalls.filter(([method]) => method === "attachment").length, 1);
      assert.equal(io.writeJSONCalls.length, 0);
      assert.deepEqual(state.record.transcript.filter(entry => entry.role === "user").map(entry => entry.text), ["Explain this term", "Give an example"]);
      assert.equal(cache.record.session.id, "branch-session");
    }
    finally { await service.shutdown(); }
    assert.equal(io.files.size, 0);
    assert.equal(io.directories.size, 0);
    assert.equal(cache.record, null);
    assert.equal(service.states.size, 0);
    assert.equal(service.context, null);
    assert.equal(acp.handlers.size, 0);
    assert.equal(acp.listeners.size, 0);
    assert.equal(acp.calls.some(([method]) => method === "session/close"), agentId !== "pi");
    assert.equal(acp.calls.some(([method]) => ["session/delete", "session/load"].includes(method)), false);
  });
}

test("close without sending creates no directory/process/session and rejects future sends", async () => {
  const { service, acp, io } = fixture();
  await service.load(10);
  await service.shutdown();
  assert.deepEqual(acp.calls, [["shutdown"]]);
  assert.equal(io.directories.size, 0);
  await assert.rejects(service.send(10, "late"));
});

test("permissions and elicitation stay in branch; persistent permission rules are not offered", async () => {
  let resolvePrompt;
  const { service, acp, io } = fixture("pi", { prompt: () => new Promise(resolve => { resolvePrompt = resolve; }) });
  const sending = service.send(10, "Question");
  while (!resolvePrompt) await new Promise(resolve => setImmediate(resolve));
  const permission = acp.handlers.get("session/request_permission")({ sessionId: "branch-session", toolCall: { title: "Read source" }, options: [
    { optionId: "yes", kind: "allow_once", name: "Yes" },
    { optionId: "no", kind: "reject_once", name: "No" },
    { optionId: "always", kind: "allow_always", name: "Always" }
  ] });
  const state = await service.load(10);
  assert.equal(state.status, "waiting-approval");
  assert.deepEqual(state.pendingInteractions[0].options.map(option => option.optionId), ["yes", "no"]);
  await assert.rejects(service.respondPermission(10, state.pendingInteractions[0].id, "always"));
  await service.respondPermission(10, state.pendingInteractions[0].id, "yes");
  assert.deepEqual(await permission, { outcome: { outcome: "selected", optionId: "yes" } });
  const elicitation = acp.handlers.get("elicitation/create")({ sessionId: "branch-session", mode: "form", message: "Which?", requestedSchema: {} });
  const interaction = (await service.load(10)).pendingInteractions[0];
  await service.respondElicitation(10, interaction.id, "accept", { result: "one" });
  assert.deepEqual(await elicitation, { action: "accept", content: { result: "one" } });
  resolvePrompt({ stopReason: "end_turn" });
  await sending;
  await service.shutdown();
  assert.equal(io.writeJSONCalls.length, 0);
});

test("shutdown cancels active turn/approval, waits for settling and removes only owned temporary data", async () => {
  const { service, acp, io } = fixture("codex", { pending: true });
  io.setText("/main/history.json", "KEEP");
  const sending = service.send(10, "Question");
  const rejected = assert.rejects(sending);
  while (!acp.calls.some(([method]) => method === "session/prompt")) await new Promise(resolve => setImmediate(resolve));
  const permission = acp.handlers.get("session/request_permission")({ sessionId: "branch-session", options: [{ optionId: "once", kind: "allow_once" }] });
  await Promise.all([service.shutdown(), service.shutdown()]);
  await rejected;
  assert.deepEqual(await permission, { outcome: { outcome: "cancelled" } });
  assert.equal(acp.calls.filter(([method]) => method === "shutdown").length, 1);
  assert.deepEqual([...io.files.keys()], ["/main/history.json"]);
});

test("close during slow PDF copy waits and prevents late prompt or temporary-file resurrection", async () => {
  const { service, fileSystem, acp, io } = fixture();
  let finishCopy;
  fileSystem.copyAtomic = async (_source, target) => {
    await new Promise(resolve => { finishCopy = resolve; });
    io.setText(target, "PDF");
  };
  const sending = service.send(10, "Question");
  const rejected = assert.rejects(sending);
  while (!finishCopy) await new Promise(resolve => setImmediate(resolve));
  const closing = service.shutdown();
  finishCopy();
  await closing;
  await rejected;
  assert.equal(acp.calls.some(([method]) => method === "session/prompt"), false);
  assert.equal(io.files.size, 0);
  assert.equal(io.directories.size, 0);
});

for (const blocked of ["cancel", "close"]) {
  test(`branch shutdown bounds a blocked ${blocked} write before forcing process exit`, async () => {
    const { service, acp, io } = fixture();
    await service.send(10, "question");
    service.closeTimeoutMs = 5;
    if (blocked === "cancel") acp.cancelSession = () => new Promise(() => {});
    else {
      const request = acp.request;
      acp.request = (method, ...args) => method === "session/close" ? new Promise(() => {}) : request(method, ...args);
    }
    await service.shutdown();
    assert.equal(acp.calls.some(([method]) => method === "shutdown"), true);
    assert.equal(io.files.size, 0);
    assert.equal(io.directories.size, 0);
  });
}

test("failed process cleanup still waits for a slow source copy and retains files rather than racing deletion", async () => {
  const { service, fileSystem, acp, io, cache } = fixture("opencode");
  let finishCopy, copying = false, disposed = false;
  fileSystem.copyAtomic = async (_source, target) => {
    copying = true;
    await new Promise(resolve => { finishCopy = resolve; });
    io.setText(target, "PDF");
    copying = false;
  };
  const dispose = cache.dispose.bind(cache);
  cache.dispose = async () => { assert.equal(copying, false); disposed = true; await dispose(); };
  const stop = acp.shutdown;
  acp.shutdown = async () => { await stop(); throw new Error("native cleanup failed"); };
  const sent = assert.rejects(service.send(10, "question"));
  while (!finishCopy) await new Promise(resolve => setImmediate(resolve));
  let closed = false;
  const closing = assert.rejects(service.shutdown(), /native cleanup failed/).then(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, false);
  assert.equal(disposed, false);
  finishCopy();
  await Promise.all([closing, sent]);
  assert.equal(disposed, false);
  assert.ok(io.files.size > 0);
  assert.equal(cache.record, null);
  assert.equal(service.states.size, 0);
  assert.equal(acp.listeners.size, 0);
});

test("close also waits for a send paused before turn creation, without creating a workspace afterwards", async () => {
  const { service, io, acp } = fixture();
  let resume;
  service._refreshSourceState = () => new Promise(resolve => { resume = resolve; });
  const sending = assert.rejects(service.send(10, "question"));
  while (!resume) await new Promise(resolve => setImmediate(resolve));
  let closed = false;
  const closing = service.shutdown().then(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, false);
  resume();
  await Promise.all([closing, sending]);
  assert.equal(io.directories.size, 0);
  assert.equal(acp.calls.some(([method]) => method === "start"), false);
  assert.equal(service.states.size, 0);
});

test("branch refuses config upgrades, source drafts, cross-paper operations, and silent model fallback", async () => {
  const { service, options, acp } = fixture();
  await assert.rejects(service.setAccessMode(10, "agent-full-access"));
  await assert.rejects(service.setSessionConfig(10, "model", "other"));
  await assert.rejects(service.load(11));
  await assert.rejects(service.send(10, "question", { screenshots: [{}] }));
  options.splice(options.findIndex(option => option.id === "model"), 1);
  await assert.rejects(service.send(10, "question"), /未确认/);
  assert.equal(acp.calls.some(([method]) => method === "session/prompt"), false);
  await service.shutdown();
});

test("native branch factory uses distinct clients, pinned runtime paths and no preference writes", async () => {
  const ACP = require("../plugin/content/acp-client.js");
  const Chat = require("../plugin/content/codex-chat.js");
  const savedClient = ACP.createZoteroACPClient, savedFS = Chat.createZoteroFileSystem;
  const names = ["Services", "Ci", "PathUtils", "IOUtils"];
  const saved = Object.fromEntries(names.map(name => [name, global[name]]));
  const calls = [];
  let sequence = 0;
  global.Services = { uuid: { generateUUID: () => `{branch-${++sequence}}` }, dirsvc: { get: () => ({ path: "/tmp" }) } };
  global.Ci = { nsIFile: {} };
  global.PathUtils = { join: (...parts) => parts.join("/") };
  global.IOUtils = { makeDirectory: () => { throw new Error("must not write on open"); } };
  ACP.createZoteroACPClient = options => { calls.push(options); return fixture(options.agentId).acp; };
  Chat.createZoteroFileSystem = () => fixture().fileSystem;
  let path = "/configured/original";
  let first, second;
  try {
    first = createZoteroBranchService({ context: context("pi"), getPreference: () => path });
    second = createZoteroBranchService({ context: context("pi"), getPreference: () => path });
    assert.notEqual(first.acp, second.acp);
    assert.notEqual(first.cache.rootPath, second.cache.rootPath);
    assert.equal(calls[0].temporary, true);
    path = "/later/change";
    assert.equal(calls[0].getPreference(Agents.getProvider("pi").executablePref), "/configured/original");
    calls[0].setPreference("unused", "new value");
    await first.load(10);
    await second.load(10);
    assert.equal(first.acp.calls.length, 0);
    assert.equal(second.acp.calls.length, 0);
  }
  finally {
    await first?.shutdown(); await second?.shutdown();
    ACP.createZoteroACPClient = savedClient; Chat.createZoteroFileSystem = savedFS;
    Object.assign(global, saved);
  }
});

test("temporary cache cannot save other session or workspace and never removes a colliding root", async () => {
  const { cache, io } = fixture();
  const record = await cache.load(makePaper());
  record.session.workspacePath = "/main";
  await assert.rejects(cache.save(makePaper(), record));
  record.session.workspacePath = cache.record.session.workspacePath;
  record.session.localID = "main-session";
  await assert.rejects(cache.save(makePaper(), record));
  io.makeDirectory = async () => { throw new Error("exists"); };
  io.setText(cache.rootPath + "/untouched", "KEEP");
  await assert.rejects(cache.ensureWorkspace(makePaper(), cache.record));
  await cache.dispose();
  assert.equal(io.files.size, 1);
});
