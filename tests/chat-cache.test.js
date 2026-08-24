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

test("reset archives the mapping, retains the workspace, and deletes session tool images", async () => {
  const { cache, io } = makeHarness();
  const paper = makePaper();
  const record = await cache.load(paper);
  record.session.id = "thread-old";
  record.transcript.push({ id: "m1", kind: "message", role: "user", text: "old" });
  await cache.ensureWorkspace(paper, record);
  const toolImages = await cache.ensureToolImageDirectory(paper, record);
  io.setText(`${record.session.workspacePath}/generated.md`, "retained output");
  io.setText(`${toolImages}/tool-1.png`, "image bytes");
  await cache.save(paper, record);
  const result = await cache.archiveAndReset(paper, "source-changed");
  assert.equal(result.record.session.id, null);
  assert.notEqual(result.record.session.localID, record.session.localID);
  const archived = await io.readJSON(result.archivePath);
  assert.equal(archived.session.id, "thread-old");
  assert.notEqual(archived.session.workspacePath, record.session.workspacePath);
  assert.equal(archived.archive.workspaceRetained, true);
  assert.equal(archived.archive.toolImagesDeleted, true);
  assert.equal(archived.archive.reason, "source-changed");
  assert.equal(await io.exists(record.session.workspacePath), false);
  assert.equal(await io.exists(`${archived.session.workspacePath}/generated.md`), true);
  assert.equal(await io.exists(toolImages), false);
  assert.equal(await io.exists(`${toolImages}/tool-1.png`), false);
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
