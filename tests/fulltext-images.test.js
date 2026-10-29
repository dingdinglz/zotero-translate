"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const vm = require("node:vm");
const { ImageCache, validateURL } = require("../plugin/content/fulltext-images.js");
const CN = "https://free-oxr.somark.cn";
const AI = "https://free-oxr.somark.ai";
const BASE = CN + "/api/v1";
const path = n => `/api/v1/files/${"a".repeat(32)}/${n.toString(16).padStart(64, "0")}.png`;
const url = (n = 1) => CN + path(n);
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0S8AAAAASUVORK5CYII=", "base64");
const URI = "data:image/png;base64," + PNG.toString("base64");
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
// A strict fake validator implements the host contract; no image decoder/network needed.
function validateImage(uri) {
  const bytes = Buffer.from(uri.split(",")[1], "base64");
  if (!bytes.subarray(0, 8).equals(PNG.subarray(0, 8))) throw new Error("secret signature diagnostic");
  return { size: bytes.length, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}
function response(target, { bytes = PNG, mime = "image/png", length = null, chunks, ...overrides } = {}) {
  let index = 0;
  const parts = chunks || [bytes];
  const reader = {
    cancelled: 0, released: 0,
    async read() { return index < parts.length ? { value: parts[index++], done: false } : { done: true }; },
    async cancel() { this.cancelled++; }, releaseLock() { this.released++; }
  };
  return {
    status: 200, redirected: false, url: target,
    headers: { get: key => key === "content-type" ? mime : length },
    body: { getReader: () => reader }, reader, ...overrides
  };
}
function fixture(overrides = {}) {
  const calls = [], writes = [], records = new Map();
  const options = {
    baseURL: BASE, AbortController, hash, validateImage,
    fetch: async (target, options) => { calls.push({ target, options }); return response(target); },
    storage: { async read(key) { return records.get(key); }, async write(key, value) { writes.push({ key, value }); records.set(key, value); } },
    ...overrides
  };
  return { cache: new ImageCache(options), calls, writes, records, options };
}
function validRecord() { return { schema: 1, urlHash: hash(url()), contentHash: hash(URI), mime: "image/png", dataURI: URI }; }

test("IIFE has no startup effects and registers the pure API", () => {
  const scope = {};
  vm.runInNewContext(fs.readFileSync(require.resolve("../plugin/content/fulltext-images.js"), "utf8"), scope);
  assert.equal(typeof scope.SmartPaperTranslatorModules.FulltextImages.ImageCache, "function");
  assert.equal(typeof scope.SmartPaperTranslatorModules.FulltextImages.validateURL, "function");
});

test("official cn/ai cross-suffix compatibility is granted only by an official base", () => {
  for (const base of [CN, AI, BASE, AI + "/api/v1/"]) {
    for (const host of [CN, AI]) assert.equal(validateURL(host + path(1), base), host + path(1));
  }
  assert.equal(validateURL(url().replace("https:", "HTTPS:").replace(".cn/", ".cn:443/"), BASE), url());
  assert.throws(() => validateURL(url(), "https://custom.example/api/v1"), /地址不受信任/);
  assert.throws(() => validateURL(AI + path(1), "https://custom.example/api/v1"), /地址不受信任/);
});

test("custom base permits only its exact HTTPS origin and directory files path", () => {
  const custom = "https://images.example:8443/oxr/v2";
  const target = custom + path(1).replace("/api/v1", "");
  assert.equal(validateURL(target, custom + "/"), target);
  for (const bad of [target.replace(":8443", ""), target.replace("/oxr/v2", "/oxr"), target.replace("images.example", "other.example"), target.replace("https", "http")]) {
    assert.throws(() => validateURL(bad, custom), /地址不受信任/);
  }
  for (const badBase of ["http://images.example/api/v1", "https://localhost/api/v1", "https://x.localhost/api/v1", "https://127.0.0.1/api/v1", "https://2130706433/api/v1", "https://0x7f000001/api/v1", "https://[::1]/api/v1", "https://images.example/a/../api/v1"]) {
    assert.throws(() => validateURL(url(), badBase), /地址不受信任/);
  }
});

test("URL variants are rejected without reflecting the input", () => {
  const bad = [null, "", path(1), "//free-oxr.somark.cn" + path(1), url() + "?secret=abc", url() + "#", url() + "?",
    url().replace("https://", "https://secret@"), url().replace("https://", "https://@"), url().replace(".cn/", ".cn:444/"),
    url().replace("/api/", "/%61pi/"), url().replace("/api/", "\\api/"), "\n" + url(), url() + " ", url() + "\u0085",
    url().replace("/api/", "/x/../api/"), url().replace("/api/", "/./api/"), url().replace(".png", ".svg"),
    url().replace(".png", ".PNG"), url().replace(".cn", ".cn.evil.example"), url().replace(".cn", ".cn."),
    url().replace("https://", "https:///"), url().replace("https://", "https:////"),
    url().replace("a".repeat(32), "a".repeat(31)), url().replace(".png", ".png/extra")];
  for (const value of bad) assert.throws(() => validateURL(value, BASE), error => error.message === "全文图片：地址不受信任");
});

test("get never fetches; resolve uses credential-free GET and persists only validated hashes/data", async () => {
  const f = fixture();
  assert.equal(f.cache.get(url()), null);
  assert.equal(f.calls.length, 0);
  assert.equal(await f.cache.resolve(url()), URI);
  assert.equal(f.cache.get(url()), URI);
  assert.equal(await f.cache.resolve(url()), URI);
  assert.equal(f.calls.length, 1);
  const { signal, ...options } = f.calls[0].options;
  assert.deepEqual(options, { method: "GET", credentials: "omit", redirect: "error", referrerPolicy: "no-referrer", cache: "no-store" });
  assert.equal(signal.aborted, false);
  assert.deepEqual(f.writes, [{ key: hash(url()), value: validRecord() }]);
  assert.equal(JSON.stringify(f.writes).includes(CN), false);
  f.cache.dispose();
  assert.equal(f.cache.get(url()), null);
  await assert.rejects(f.cache.resolve(url()), /请求已失效/);
});

test("stream bytes from Gecko's shared fetch realm are accepted without weakening typed-array checks", async () => {
  const foreign = vm.runInNewContext(`new Uint8Array(${JSON.stringify([...PNG])})`);
  assert.equal(foreign instanceof Uint8Array, false);
  const good = fixture({ fetch: async target => response(target, { chunks: [foreign] }) });
  assert.equal(await good.cache.resolve(url()), URI);
  for (const chunk of [[...PNG], new Uint16Array(PNG.length), { [Symbol.toStringTag]: "Uint8Array", byteLength: PNG.length }]) {
    const bad = fixture({ fetch: async target => response(target, { chunks: [chunk] }) });
    await assert.rejects(bad.cache.resolve(url()), /下载失败/u);
  }
});

test("hash adapters must return canonical SHA-256 keys before storage access", async () => {
  const f = fixture({ hash: () => "short-key" });
  await assert.rejects(f.cache.resolve(url()), /校验失败/u);
  assert.equal(f.calls.length, 0); assert.equal(f.writes.length, 0);
});

test("duplicate URLs share one request; stale duplicate cannot cancel a current consumer", async () => {
  const gate = deferred(); let calls = 0, current = true;
  const f = fixture({ fetch: async target => { calls++; await gate.promise; return response(target); } });
  const stale = assert.rejects(f.cache.resolve(url(), { isCurrent: () => current }), /请求已失效/);
  const live = f.cache.resolve(url());
  await tick(); current = false; gate.resolve();
  assert.equal(await live, URI); await stale;
  assert.equal(calls, 1);
});

test("cancel invalidates fetch and queued resolves promptly; new generation can retry", async () => {
  const gate = deferred(); let calls = 0, signal;
  const f = fixture({ fetch: async (target, options) => { calls++; signal = options.signal; if (calls === 1) await gate.promise; return response(target); } });
  const first = assert.rejects(f.cache.resolve(url()), /请求已失效/);
  const queued = assert.rejects(f.cache.resolve(url(2)), /请求已失效/);
  await tick(); f.cache.cancel(); await Promise.all([first, queued]);
  assert.equal(signal.aborted, true); assert.equal(calls, 1); assert.equal(f.writes.length, 0);
  assert.equal(await f.cache.resolve(url()), URI);
  gate.resolve(); await tick(); assert.equal(f.writes.length, 1);
});

test("cancel during stream read aborts and cancels reader without delivering/writing", async () => {
  const gate = deferred(); const r = response(url()); let signal;
  r.reader.read = () => gate.promise;
  const f = fixture({ fetch: async (_, options) => { signal = options.signal; return r; } });
  const result = assert.rejects(f.cache.resolve(url()), /请求已失效/);
  await tick(); f.cache.cancel(); await result;
  assert.equal(signal.aborted, true); assert.ok(r.reader.cancelled > 0);
  gate.resolve({ value: PNG, done: false }); await tick();
  assert.equal(f.writes.length, 0); assert.equal(f.cache.get(url()), null);
});

test("cancel during atomic write allows valid disk result but never returns late URI", async () => {
  const gate = deferred(), entered = deferred(); let record;
  const f = fixture({ storage: { async read() { return record; }, async write(_, value) { entered.resolve(); await gate.promise; record = value; } } });
  const result = assert.rejects(f.cache.resolve(url()), /请求已失效/);
  await entered.promise; f.cache.cancel(); await result;
  gate.resolve(); await tick();
  assert.deepEqual(record, validRecord()); assert.equal(f.cache.get(url()), null);
  assert.equal(await f.cache.resolve(url()), URI); assert.equal(f.calls.length, 1);
});

test("cancel during hashing or disk read discards late data before any network or write", async () => {
  for (const phase of ["hash", "read"]) {
    const gate = deferred(), entered = deferred();
    const f = fixture({
      hash: async value => { if (phase === "hash") { entered.resolve(); await gate.promise; } return hash(value); },
      storage: { async read() { entered.resolve(); await gate.promise; return validRecord(); }, async write() { assert.fail("late write"); } }
    });
    const result = assert.rejects(f.cache.resolve(url()), /请求已失效/);
    await entered.promise; f.cache.cancel(); await result;
    gate.resolve(); await tick();
    assert.equal(f.calls.length, 0); assert.equal(f.cache.get(url()), null);
  }
});

test("dispose aborts active and queued work, clears memory, and permanently forbids resolve", async () => {
  const gate = deferred(); let signal;
  const f = fixture({ fetch: async (target, options) => {
    if (target !== url()) { signal = options.signal; await gate.promise; }
    return response(target);
  } });
  await f.cache.resolve(url());
  const active = assert.rejects(f.cache.resolve(url(2)), /请求已失效/);
  const queued = assert.rejects(f.cache.resolve(url(3)), /请求已失效/);
  await tick(); f.cache.dispose(); await Promise.all([active, queued]);
  assert.equal(signal.aborted, true); assert.equal(f.cache.get(url()), null);
  await assert.rejects(f.cache.resolve(url()), /请求已失效/);
  gate.resolve(); await tick(); assert.equal(f.writes.length, 1);
});

test("isCurrent is rechecked after hash, storage read, fetch, read, digest and write", async () => {
  for (const phase of ["urlHash", "storageRead", "fetch", "stream", "contentHash", "write"]) {
    let current = true;
    const f = fixture({
      hash: async value => { if ((phase === "urlHash" && value === url()) || (phase === "contentHash" && value === URI)) current = false; return hash(value); },
      storage: { async read() { if (phase === "storageRead") current = false; }, async write() { if (phase === "write") current = false; } },
      fetch: async target => {
        if (phase === "fetch") current = false;
        const r = response(target);
        if (phase === "stream") r.reader.read = async () => { current = false; return { value: PNG, done: false }; };
        return r;
      }
    });
    await assert.rejects(f.cache.resolve(url(), { isCurrent: () => current }), /请求已失效/, phase);
    assert.equal(f.cache.get(url()), null);
  }
});

test("stale queued or initially stale requests never start a download", async () => {
  const gate = deferred(); let current = true;
  const f = fixture({ fetch: async target => { await gate.promise; return response(target); } });
  const first = f.cache.resolve(url());
  const queued = assert.rejects(f.cache.resolve(url(2), { isCurrent: () => current }), /请求已失效/);
  await tick(); current = false; gate.resolve(); await first; await queued;
  assert.equal(f.writes.length, 1);
  await assert.rejects(f.cache.resolve(url(3), { isCurrent: () => false }), /请求已失效/);
  await assert.rejects(f.cache.resolve(url(3), { isCurrent: () => { throw new Error("secret"); } }), /请求已失效/);
});

test("redirects, final URL differences, non-200, wrong or parameterized MIME fail closed", async () => {
  for (const overrides of [{ redirected: true }, { url: AI + path(1) }, { url: "" }, { status: 201 }, { status: 302 },
    { mime: "image/jpeg" }, { mime: "image/png; charset=utf-8" }, { mime: "image/svg+xml" }, { mime: "IMAGE/PNG" }, { body: null }]) {
    const f = fixture({ fetch: async target => response(target, overrides) });
    await assert.rejects(f.cache.resolve(url()), /下载失败/);
    assert.equal(f.writes.length, 0);
  }
});

test("each allowed URL extension requires its exact raster MIME", async () => {
  for (const [ext, mime] of Object.entries({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" })) {
    const target = url().replace(/png$/, ext);
    const f = fixture({ fetch: async value => response(value, { mime }), validateImage: () => ({ size: PNG.length, width: 1, height: 1 }) });
    assert.equal(await f.cache.resolve(target), `data:${mime};base64,${PNG.toString("base64")}`);
    const wrong = fixture({ fetch: async value => response(value, { mime: "application/octet-stream" }) });
    await assert.rejects(wrong.cache.resolve(target), /下载失败/);
  }
});

test("signature, pixel dimensions and validator size mismatch never enter cache", async () => {
  const badSignature = Buffer.from(PNG); badSignature[0] = 0;
  const badSize = Buffer.from(PNG); badSize.writeUInt32BE(100000, 16); badSize.writeUInt32BE(100000, 20);
  const zero = Buffer.from(PNG); zero.writeUInt32BE(0, 16);
  for (const bytes of [badSignature, badSize, zero]) {
    const f = fixture({ fetch: async target => response(target, { bytes }) });
    await assert.rejects(f.cache.resolve(url()), /校验失败/); assert.equal(f.writes.length, 0);
  }
  const f = fixture({ validateImage: () => ({ size: 1, width: 1, height: 1 }) });
  await assert.rejects(f.cache.resolve(url()), /校验失败/);
});

test("host FulltextMarkdown.imageInfo validates the returned URI and rejects forged PNG dimensions/signature", async () => {
  const validator = require("../plugin/content/fulltext-markdown.js").imageInfo;
  assert.equal(typeof validator, "function");
  const good = fixture({ validateImage: validator });
  assert.equal(await good.cache.resolve(url()), URI);
  const wrongSignature = Buffer.from(PNG); wrongSignature[0] = 0;
  const huge = Buffer.from(PNG); huge.writeUInt32BE(100000, 16);
  for (const bytes of [wrongSignature, huge]) {
    const bad = fixture({ validateImage: validator, fetch: async target => response(target, { bytes }) });
    await assert.rejects(bad.cache.resolve(url()), /校验失败/);
    assert.equal(bad.writes.length, 0);
  }
});

test("Content-Length pre-rejects oversize and malformed values before reading", async () => {
  for (const length of [String(12 * 1024 * 1024 + 1), "999999999999999999999999", "-1", "abc", "1.5", " 68"]) {
    let reads = 0;
    const f = fixture({ fetch: async target => { const r = response(target, { length }); r.reader.read = async () => { reads++; return { done: true }; }; return r; } });
    await assert.rejects(f.cache.resolve(url())); assert.equal(reads, 0); assert.equal(f.writes.length, 0);
  }
  const wrong = fixture({ fetch: async target => response(target, { length: String(PNG.length + 1) }) });
  await assert.rejects(wrong.cache.resolve(url()), /下载失败/);
});

test("stream cumulative cap cancels immediately, including deceptive Content-Length", async () => {
  for (const length of [null, "1"]) {
    const r = response(url(), { length, chunks: [new Uint8Array(12 * 1024 * 1024), new Uint8Array(1)] });
    let signal;
    const f = fixture({ fetch: async (_, options) => { signal = options.signal; return r; } });
    await assert.rejects(f.cache.resolve(url()), /资源超过上限/);
    assert.ok(r.reader.cancelled); assert.equal(signal.aborted, true); assert.equal(f.writes.length, 0);
  }
});

test("15s timeout covers both uncooperative fetch and stalled body; timers are cleaned", async () => {
  for (const phase of ["fetch", "body"]) {
    let callback, delay, signal, clears = 0;
    const gate = deferred(); const r = response(url());
    r.reader.read = () => gate.promise;
    const f = fixture({
      timers: { setTimeout(fn, ms) { callback = fn; delay = ms; return 1; }, clearTimeout(id) { assert.equal(id, 1); clears++; } },
      fetch: async (_, options) => { signal = options.signal; return phase === "fetch" ? gate.promise : r; }
    });
    const result = assert.rejects(f.cache.resolve(url()), /下载超时/);
    await tick(); assert.equal(delay, 15000); callback(); await result; await tick();
    assert.equal(signal.aborted, true); assert.equal(clears, 1); assert.equal(f.writes.length, 0);
    gate.resolve(phase === "fetch" ? r : { done: true }); await tick(); assert.equal(f.cache.get(url()), null);
  }
});

test("disk hit revalidates content hash and image; corrupt records fail with no network fallback and may retry", async () => {
  const mutations = [r => { r.contentHash = "wrong"; }, r => { r.urlHash = "wrong"; }, r => { r.mime = "image/jpeg"; },
    r => { r.schema = 2; }, r => { r.dataURI = "data:image/png;base64,AAAA"; }, r => { r.extra = "secret"; }];
  for (const mutate of mutations) {
    const f = fixture(); const record = validRecord(); mutate(record); f.records.set(hash(url()), record);
    await assert.rejects(f.cache.resolve(url()), /校验失败/);
    assert.equal(f.calls.length, 0); assert.equal(f.cache.get(url()), null);
    f.records.set(hash(url()), validRecord()); assert.equal(await f.cache.resolve(url()), URI);
    assert.equal(f.calls.length, 0);
  }
  let validations = 0;
  const f = fixture({ validateImage: uri => { validations++; return validateImage(uri); } });
  f.records.set(hash(url()), validRecord()); await f.cache.resolve(url());
  assert.equal(validations, 1); assert.equal(f.writes.length, 0);
});

test("concurrent requests cannot bypass 128-entry budget; duplicate does not consume a slot", async () => {
  const f = fixture();
  const results = await Promise.allSettled(Array.from({ length: 129 }, (_, i) => f.cache.resolve(url(i))));
  assert.equal(results.filter(r => r.status === "fulfilled").length, 128);
  assert.match(results[128].reason.message, /资源超过上限/);
  assert.equal(f.calls.length, 128); assert.equal(f.writes.length, 128);
  assert.equal(await f.cache.resolve(url(0)), URI);
});

test("concurrent requests cannot bypass 64MiB total byte budget (network or disk)", async () => {
  const bytes = Buffer.alloc(12 * 1024 * 1024); PNG.copy(bytes);
  const largeURI = "data:image/png;base64," + bytes.toString("base64");
  for (const disk of [false, true]) {
    const f = fixture({ fetch: async target => response(target, { bytes }) });
    if (disk) for (let i = 0; i < 6; i++) f.records.set(hash(url(i)), { ...validRecord(), urlHash: hash(url(i)), dataURI: largeURI, contentHash: hash(largeURI) });
    const results = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => f.cache.resolve(url(i))));
    assert.equal(results.filter(r => r.status === "fulfilled").length, 5);
    assert.match(results[5].reason.message, /资源超过上限/);
    assert.equal(f.writes.length, disk ? 0 : 5);
    f.cache.dispose();
  }
});

test("external diagnostics never escape and failures remain retryable", async () => {
  let bad = true;
  const f = fixture({ fetch: async target => { if (bad) throw new Error("secret token " + target); return response(target); } });
  await assert.rejects(f.cache.resolve(url()), error => error.message === "全文图片：下载失败");
  bad = false; assert.equal(await f.cache.resolve(url()), URI);
  const failedStorage = fixture({ storage: { async read() { throw new Error("secret disk path"); }, async write() {} } });
  await assert.rejects(failedStorage.cache.resolve(url()), error => error.message === "全文图片：图片或缓存校验失败");
});
