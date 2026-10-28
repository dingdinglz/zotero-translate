"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { validateOXRURL, collectProcess } = require("../plugin/content/fulltext-runtime.js");
function pipe(parts) { return { async readString() { return parts.shift() || ""; } }; }
function processMock(stdout = '{"ok":true}', exitCode = 0) {
  return { stdout: pipe([stdout]), stderr: pipe([]), killed: false,
    kill() { this.killed = true; }, async wait() { return { exitCode }; } };
}
test("OXR endpoint rejects credentials, insecure nonlocal HTTP and ambiguous URLs", () => {
  assert.equal(validateOXRURL("https://example.org/api/v1/"), "https://example.org/api/v1");
  assert.equal(validateOXRURL("http://127.0.0.1:1234/api/v1"), "http://127.0.0.1:1234/api/v1");
  for (const url of ["file:///tmp/a", "https://user:password@example.org", "https://example.org?key=x", "https://example.org#x", "http://example.org/api", "javascript:alert(1)", "bad"]) {
    assert.throws(() => validateOXRURL(url));
  }
});
test("Python collector accepts exactly one successful JSON result and checks exit status", async () => {
  assert.deepEqual(await collectProcess(processMock(), { timeoutMS: 1000 }), { ok: true });
  await assert.rejects(collectProcess(processMock('{"ok":true}', 1), { timeoutMS: 1000 }), /失败/u);
  await assert.rejects(collectProcess(processMock("log\n{\"ok\":true}"), { timeoutMS: 1000 }), /有效结果/u);
});
test("Python collector bounds output and kills on cancellation", async () => {
  const oversized = processMock("x".repeat(65537));
  await assert.rejects(collectProcess(oversized, { timeoutMS: 1000 }), /超限/u); assert.ok(oversized.killed);
  const cancelled = processMock();
  await assert.rejects(collectProcess(cancelled, { timeoutMS: 1000, registerCancel: cancel => { cancel(); return () => {}; } }), /暂停/u);
  assert.ok(cancelled.killed);
});
test("Python diagnostic stderr is not leaked into public errors", async () => {
  const process = processMock("not json", 1); process.stderr = pipe(["PRIVATE_PAPER_CONTENT secret-key"]);
  await assert.rejects(collectProcess(process, { timeoutMS: 1000 }), error => !error.message.includes("PRIVATE") && !error.message.includes("secret"));
});
