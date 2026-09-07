"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Constants = require("../plugin/content/constants.js");
const {
  CodexChatCache,
  validateChatRecord,
  validateConfigurationCatalog
} = require("../plugin/content/chat-cache.js");
const { MemoryIO, makePaper } = require("./helpers.js");

function makeHarness() {
  const io = new MemoryIO();
  let id = 0;
  let time = 0;
  const cache = new CodexChatCache({
    rootPath: "/chat",
    io,
    joinPath: (...parts) => parts.join("/"),
    randomID: () => `local-${++id}`,
    now: () => `2026-08-20T00:00:0${time++}.000Z`
  });
  return { cache, io };
}

test("chat records are isolated per PDF attachment and written atomically", async () => {
  const { cache, io } = makeHarness();
  const first = makePaper();
  const second = makePaper({
    storageKey: "1--IJKLMNOP",
    attachmentKey: "PONMLKJI",
    attachmentID: 11
  });
  const firstRecord = await cache.load(first);
  const secondRecord = await cache.load(second);
  assert.notEqual(firstRecord.session.localID, secondRecord.session.localID);
  assert.match(firstRecord.session.workspacePath, /1--ABCDEFGH\/local-1$/u);
  assert.match(secondRecord.session.workspacePath, /1--IJKLMNOP\/local-2$/u);

  firstRecord.transcript.push({ id: "m1", kind: "message", role: "user", text: "hello" });
  await cache.save(first, firstRecord);
  assert.deepEqual(io.writeJSONCalls.at(-1).options, {
    tmpPath: "/chat/records/1--ABCDEFGH.json.tmp"
  });
  assert.equal((await cache.load(second)).transcript.length, 0);
});

test("corrupt chat mirrors are backed up before a clean record is rebuilt", async () => {
  const { cache, io } = makeHarness();
  const paper = makePaper();
  io.setText("/chat/records/1--ABCDEFGH.json", "{broken");
  const record = await cache.load(paper);
  assert.equal(validateChatRecord(record, paper), true);
  assert.ok([...io.files.keys()].some((path) => path.includes(".corrupt-")));
  assert.equal((await io.readJSON("/chat/records/1--ABCDEFGH.json")).transcript.length, 0);
});

test("reset archives the mapping, retains the workspace, and deletes session images", async () => {
  const { cache, io } = makeHarness();
  const paper = makePaper();
  const record = await cache.load(paper);
  record.session.id = "thread-old";
  record.transcript.push({ id: "m1", kind: "message", role: "user", text: "old" });
  await cache.ensureWorkspace(paper, record);
  const toolImages = await cache.ensureToolImageDirectory(paper, record);
  const screenshots = await cache.ensureScreenshotDirectory(paper, record);
  io.setText(`${record.session.workspacePath}/generated.md`, "retained output");
  io.setText(`${toolImages}/tool-1.png`, "image bytes");
  io.setText(`${screenshots}/capture-shot-1.png`, "screenshot bytes");
  await cache.save(paper, record);
  const result = await cache.archiveAndReset(paper, "source-changed");
  assert.equal(result.record.session.id, null);
  assert.notEqual(result.record.session.localID, record.session.localID);
  const archived = await io.readJSON(result.archivePath);
  assert.equal(archived.session.id, "thread-old");
  assert.notEqual(archived.session.workspacePath, record.session.workspacePath);
  assert.equal(archived.archive.workspaceRetained, true);
  assert.equal(archived.archive.toolImagesDeleted, true);
  assert.equal(archived.archive.screenshotsDeleted, true);
  assert.equal(archived.archive.reason, "source-changed");
  assert.equal(await io.exists(record.session.workspacePath), false);
  assert.equal(await io.exists(`${archived.session.workspacePath}/generated.md`), true);
  assert.equal(await io.exists(toolImages), false);
  assert.equal(await io.exists(`${toolImages}/tool-1.png`), false);
  assert.equal(await io.exists(screenshots), false);
  assert.equal(await io.exists(`${screenshots}/capture-shot-1.png`), false);
});

test("tool image paths are paper and session isolated outside the ACP workspace", async () => {
  const { cache } = makeHarness();
  const paper = makePaper();
  const record = await cache.load(paper);
  const directory = await cache.ensureToolImageDirectory(paper, record);
  assert.equal(directory, "/chat/tool-images/1--ABCDEFGH/local-1");
  assert.equal(cache.toolImagePath(paper, record, "message-1.png"), `${directory}/message-1.png`);
  assert.notEqual(directory, record.session.workspacePath);
  assert.throws(
    () => cache.toolImagePath(paper, record, "../source.pdf"),
    { code: "TOOL_IMAGE_NAME" }
  );
});

test("PDF screenshot paths are paper and session isolated outside the ACP workspace", async () => {
  const { cache } = makeHarness();
  const paper = makePaper();
  const record = await cache.load(paper);
  const directory = await cache.ensureScreenshotDirectory(paper, record);
  assert.equal(directory, "/chat/screenshots/1--ABCDEFGH/local-1");
  assert.equal(
    cache.screenshotPath(paper, record, "capture-shot-1.png"),
    `${directory}/capture-shot-1.png`
  );
  assert.notEqual(directory, record.session.workspacePath);
  assert.throws(
    () => cache.screenshotPath(paper, record, "../capture-shot-1.png"),
    { code: "SCREENSHOT_NAME" }
  );
});

test("per-paper update queue does not lose concurrent transcript changes", async () => {
  const { cache } = makeHarness();
  const paper = makePaper();
  await Promise.all([
    cache.update(paper, async (record) => {
      await new Promise((resolve) => setImmediate(resolve));
      record.transcript.push({ id: "a" });
    }),
    cache.update(paper, (record) => {
      record.transcript.push({ id: "b" });
    })
  ]);
  assert.deepEqual((await cache.load(paper)).transcript.map((entry) => entry.id), ["a", "b"]);
});

test("dynamic ACP configuration catalog is persisted atomically outside paper records", async () => {
  const { cache, io } = makeHarness();
  const catalog = await cache.saveConfigurationCatalog({
    runtimeFingerprint: "runtime-a",
    updatedAt: "2026-08-20T00:00:00.000Z",
    configOptions: [{ id: "model", currentValue: "model-a", options: [{ value: "model-a" }] }],
    configOptionsByModel: {
      "model-a": [
        { id: "model", currentValue: "model-a", options: [{ value: "model-a" }] },
        { id: "reasoning_effort", currentValue: "high", options: [{ value: "high" }] }
      ]
    }
  });
  assert.equal(validateConfigurationCatalog(catalog), true);
  assert.equal(catalog.adapterVersion, Constants.ACP_PACKAGE_VERSION);
  assert.deepEqual(io.writeJSONCalls.at(-1), {
    path: "/chat/configuration-catalog.json",
    options: { tmpPath: "/chat/configuration-catalog.json.tmp" }
  });
  assert.deepEqual(await cache.loadConfigurationCatalog(), catalog);
  assert.equal(await cache.ensureConfigurationWorkspace(), "/chat/configuration-workspace");
});

test("corrupt ACP configuration catalog is backed up and ignored", async () => {
  const { cache, io } = makeHarness();
  io.setText("/chat/configuration-catalog.json", "{broken");
  const catalog = await cache.loadConfigurationCatalog();
  assert.deepEqual(catalog.configOptions, []);
  assert.ok([...io.files.keys()].some((path) =>
    path.startsWith("/chat/configuration-catalog.json.corrupt-")
  ));
});

test("legacy Codex records keep their original session and paths while Pi resets independently", async () => {
  const { cache, io } = makeHarness();
  const paper = makePaper();
  const legacy = await cache.load(paper);
  delete legacy.agentId;
  legacy.session.id = "original-codex-session";
  const screenshotDir = await cache.ensureScreenshotDirectory(paper, legacy);
  io.setText(`${screenshotDir}/capture-shot-1.png`, "kept");
  await io.writeJSON("/chat/records/1--ABCDEFGH.json", legacy);
  assert.equal(validateChatRecord(legacy, paper), true);
  assert.equal(validateChatRecord(legacy, paper, "pi"), false);
  const loaded = await cache.load(paper);
  assert.equal(loaded.session.id, legacy.session.id);
  assert.equal(loaded.session.workspacePath, legacy.session.workspacePath);
  loaded.session.config.mode = "agent-full-access";
  await cache.save(paper, loaded);
  assert.equal((await cache.load(paper)).session.config.mode, "agent-full-access");
  const pi = new CodexChatCache({ rootPath: "/pi-chat", agentId: "pi", io, joinPath: (...parts) => parts.join("/"), randomID: () => "pi-local" });
  const record = await pi.load(paper);
  assert.equal(record.agentId, "pi");
  assert.equal(record.session.config.mode, null);
  assert.match(record.session.workspacePath, /^\/pi-chat\//u);
  await pi.archiveAndReset(paper, "test");
  assert.equal((await cache.load(paper)).session.id, legacy.session.id);
  assert.equal(await io.exists(`${screenshotDir}/capture-shot-1.png`), true);
});
