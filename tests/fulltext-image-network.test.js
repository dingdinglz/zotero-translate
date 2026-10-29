"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { createFetch, isPublicAddress } = require("../plugin/content/fulltext-image-network.js");
const MAX = 12 * 1024 * 1024;
const URL = "https://images.example.test/any/api/image?signature=SECRET";
const TARGET = "https://cdn.example.test/arbitrary/path?signature=SECOND_SECRET";
const FAILURE = "Image network request failed";
const ABORTED = "Image network request cancelled";
const options = signal => ({ method: "GET", credentials: "omit", redirect: "manual",
  referrerPolicy: "no-referrer", cache: "no-store", ...(signal ? { signal } : {}) });

function fixture(settings = {}) {
  const state = { dns: [], channels: [], channelArgs: [], readSizes: [], setHeaders: [], log: [] };
  const Ci = {};
  for (const name of ["nsIHttpChannel", "nsIHttpChannelInternal", "nsIBinaryInputStream", "nsIDNSAddrRecord", "nsIChannelEventSink",
    "nsIAuthPrompt", "nsIAuthPrompt2", "nsIAuthPromptProvider", "nsIBadCertListener2", "nsILoadContext"]) {
    Ci[name] = { name, equals(other) { return this === other; } };
  }
  Ci.nsIRequest = { LOAD_ANONYMOUS: 1, LOAD_BYPASS_CACHE: 2, INHIBIT_CACHING: 4, LOAD_BACKGROUND: 8 };
  Ci.nsILoadInfo = { SEC_ALLOW_CROSS_ORIGIN_SEC_CONTEXT_IS_NULL: 32, SEC_DISALLOW_SCRIPT: 256 };
  Ci.nsIContentPolicy = { TYPE_OTHER: 64 };
  Ci.nsIDNSService = { RESOLVE_TYPE_DEFAULT: 0, RESOLVE_BYPASS_CACHE: 128 };
  const Cr = { NS_BINDING_ABORTED: 0x804b0002, NS_ERROR_NO_INTERFACE: 0x80004002 };
  const principal = {};
  const Components = { isSuccessCode(status) { return status === 0; } };
  const ChromeUtils = { generateQI(names) { return function () { state.qi = names; return this; }; } };
  const Cc = { "@mozilla.org/binaryinputstream;1": { createInstance(iid) {
    assert.equal(iid, Ci.nsIBinaryInputStream);
    let stream;
    return { setInputStream(value) { stream = value; }, readByteArray(size) {
      state.readSizes.push(size);
      if (settings.readFailure) throw new Error(URL);
      if (stream.onRead) stream.onRead();
      return stream.read(size);
    } };
  } } };
  function uri(spec) {
    if (settings.uriFailure) throw new Error(URL);
    const parsed = new globalThis.URL(spec);
    return { spec: parsed.href, scheme: parsed.protocol.slice(0, -1),
      asciiHost: parsed.hostname, userPass: parsed.username + parsed.password };
  }
  function makeChannel(value) {
    const ch = { URI: value, status: 0, responseStatus: 200, loadInfo: {}, loadFlags: 0,
      loadGroup: "inherited", referrerInfo: "inherited", notificationCallbacks: null,
      responseHeaders: { "content-type": "image/png" }, opens: 0, cancellations: [],
      QueryInterface(iid) {
        assert.ok(iid === Ci.nsIHttpChannel || iid === Ci.nsIHttpChannelInternal); return this;
      },
      getResponseHeader(name) {
        if (!(name in this.responseHeaders)) throw new Error("missing " + URL);
        return this.responseHeaders[name];
      },
      setRequestHeader(...args) { state.setHeaders.push(args); },
      asyncOpen(listener) {
        this.opens++; this.savedListener = listener;
        if (settings.openFailure) throw new Error(URL);
        if (settings.onOpen) settings.onOpen(this);
      },
      cancel(status) {
        this.cancellations.push(status);
        if (settings.synchronousStop) this.savedListener?.onStopRequest(this, status);
      },
    };
    return ch;
  }
  const Services = {
    scriptSecurityManager: { getSystemPrincipal() { return principal; } },
    io: { newURI: uri, newChannelFromURI(...args) {
      state.channelArgs.push(args);
      if (settings.channelFailure) throw new Error(URL);
      const channel = makeChannel(args[0]); state.channels.push(channel); return channel;
    } },
    dns: { asyncResolve(...args) {
      if (settings.dnsFailure) throw new Error(URL);
      const request = { cancellations: [], cancel(status) { this.cancellations.push(status); } };
      state.dns.push({ args, request });
      if (settings.onDNS) settings.onDNS();
      return request;
    } },
  };
  function lookup(addresses = ["93.184.216.34"], status = 0, index = 0) {
    const call = state.dns[index];
    let cursor = 0;
    const record = { QueryInterface(iid) { assert.equal(iid, Ci.nsIDNSAddrRecord); return this; },
      hasMore() { return cursor < addresses.length; }, getNextAddrAsString() { return addresses[cursor++]; } };
    call.args[4].onLookupComplete(call.request, addresses === null ? null : record, status);
    return state.channels[state.channels.length - 1];
  }
  function start(channel, status = 200, headers = {}) {
    channel.responseStatus = status;
    Object.assign(channel.responseHeaders, headers);
    channel.savedListener.onStartRequest(channel);
  }
  function data(channel, bytes, declaredCount) {
    const buffer = typeof bytes === "number" ? null : Uint8Array.from(bytes);
    const size = typeof bytes === "number" ? bytes : buffer.length;
    let offset = 0;
    channel.savedListener.onDataAvailable(channel, { read(count) {
      const result = buffer ? buffer.subarray(offset, offset + count) : new Uint8Array(count).fill(7);
      offset += count; return result;
    } }, 0, declaredCount ?? size);
  }
  function stop(channel, status = 0) { channel.savedListener.onStopRequest(channel, status); }
  function redirect(channel, status = 307, target = TARGET, flags = 0) {
    channel.responseStatus = status; channel.responseHeaders.location = target;
    const next = makeChannel(uri(target)); let verified;
    channel.savedListener.asyncOnChannelRedirect(channel, next, flags, {
      onRedirectVerifyCallback(statusCode) { verified = statusCode; },
    });
    assert.equal(next.opens, 0, "redirect target must never be opened");
    assert.equal(verified, Cr.NS_BINDING_ABORTED);
    return next;
  }
  return { state, Ci, Cr, principal, lookup, start, data, stop, redirect,
    fetch: createFetch({ Services, ChromeUtils, Cc, Ci, Cr, Components }) };
}

for (const address of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "100.63.255.255", "100.128.0.0",
  "172.15.255.255", "172.32.0.0", "223.255.255.255", "2606:4700:4700::1111", "2001:4860:4860::8888",
  "[2606:4700::1111]", "::ffff:8.8.8.8", "::ffff:0808:0808", "2003:1:2:3:4:5:6:7"]) {
  test(`public DNS address accepted: ${address}`, () => assert.equal(isPublicAddress(address), true));
}
for (const address of ["0.0.0.0", "0.1.2.3", "10.1.2.3", "127.0.0.1", "100.64.0.1", "100.127.255.255",
  "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.168.0.1", "192.0.0.9", "192.0.2.1",
  "192.88.99.1", "198.18.0.1", "198.19.255.255", "198.51.100.2", "203.0.113.1", "224.0.0.1",
  "255.255.255.255", "::", "::1", "fc00::1", "fdff::1", "fe80::1", "ff02::1", "::ffff:127.0.0.1",
  "::ffff:0a00:0001", "::ffff:169.254.169.254", "::8.8.8.8", "64:ff9b::808:808", "2001::1",
  "2001:2::1", "2001:20::1", "2001:db8::1", "2002:0808:0808::1", "3fff::1", "3fff:fff::1",
  "fe80::1%en0", "2606:::1", "2606::1::1", "2606:1:2", "2606:1:2:3:4:5:6:7:8", "2606:00000::1",
  "256.1.1.1", "01.1.1.1", "1.2.3", "2130706433", "0x7f000001", "example.test", "", null]) {
  test(`private/special/malformed DNS address rejected: ${address}`, () => assert.equal(isPublicAddress(address), false));
}

for (const address of ["198.18.0.0", "198.18.0.103", "198.18.255.255", "198.19.0.0", "198.19.255.255"]) {
  test(`domain DNS accepts proxy Fake-IP without changing URL or public-IP classification: ${address}`, async () => {
    const env = fixture(), outcome = env.fetch(URL, options()).then(response => ({ response }), error => ({ error }));
    assert.equal(isPublicAddress(address), false);
    const ch = env.lookup([address]);
    assert.equal(env.state.channels.length, 1);
    assert.equal(ch.URI.spec, URL); assert.equal(ch.loadFlags, 15);
    env.start(ch); const result = await outcome; assert.ifError(result.error);
    assert.equal(result.response.url, URL); env.stop(ch);
  });
}

test("mixed public and proxy DNS results pass, but any ordinary private address still blocks", async () => {
  const env = fixture(), outcome = env.fetch(URL, options()).then(response => ({ response }), error => ({ error }));
  const ch = env.lookup(["93.184.216.34", "198.18.0.103", "2606:4700::1111"]);
  assert.equal(env.state.channels.length, 1); env.start(ch); assert.ifError((await outcome).error); env.stop(ch);
  for (const blocked of ["127.0.0.1", "10.0.0.1", "192.168.1.1", "169.254.169.254", "198.51.100.1", "::ffff:198.18.0.103", "fc00::1"]) {
    const rejected = fixture(), pending = rejected.fetch(URL, options());
    rejected.lookup(["198.18.0.103", blocked]);
    await assert.rejects(pending, { message: FAILURE }); assert.equal(rejected.state.channels.length, 0);
  }
});

test("proxy exception never applies to IP literals or local/internal hostnames", async () => {
  for (const target of ["http://198.18.0.103/image", "https://198.19.255.255/image", "http://0xc6120067/image", "http://[::ffff:c612:67]/image"]) {
    const env = fixture(); await assert.rejects(env.fetch(target, options()), { message: FAILURE });
    assert.equal(env.state.dns.length, 0); assert.equal(env.state.channels.length, 0);
  }
  for (const host of ["8.8.8.8", "[2606:4700::1111]", "localhost", "localhost.", "host.localhost", "host.local", "host.internal", "host.lan", "host.home.arpa"]) {
    const env = fixture(), promise = env.fetch(`https://${host}/image`, options());
    env.lookup(["198.18.0.103"]);
    await assert.rejects(promise, { message: FAILURE }); assert.equal(env.state.channels.length, 0);
  }
});

test("redirect targets cannot turn the domain Fake-IP exception into direct private-IP access", async () => {
  const env = fixture(), promise = env.fetch(URL, options()), ch = env.lookup();
  env.redirect(ch, 307, "https://198.18.0.103/image");
  await assert.rejects(promise, { message: FAILURE });
  assert.equal(env.state.channels.length, 1); assert.ok(ch.cancellations.length);
});

test("ImageCache and native adapter complete a 307 image chain through proxy DNS on both hosts", async () => {
  const { ImageCache } = require("../plugin/content/fulltext-images.js"), crypto = require("node:crypto");
  const { imageInfo } = require("../plugin/content/fulltext-markdown.js");
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0S8AAAAASUVORK5CYII=";
  const bytes = Buffer.from(png.split(",")[1], "base64"), env = fixture(), records = new Map();
  const cache = new ImageCache({ baseURL: "https://images.example.test/api", fetch: env.fetch, AbortController,
    hash: value => crypto.createHash("sha256").update(value).digest("hex"), validateImage: imageInfo,
    storage: { read: async key => records.get(key), write: async (key, value) => records.set(key, value) } });
  const outcome = cache.resolve(URL).then(data => ({ data }), error => ({ error }));
  await new Promise(resolve => setImmediate(resolve));
  const first = env.lookup(["198.18.0.103"]); assert.equal(env.state.channels.length, 1);
  env.redirect(first);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(env.state.dns.length, 2);
  const second = env.lookup(["198.19.0.7"], 0, 1);
  env.start(second, 200, { "content-length": String(bytes.length) }); env.data(second, bytes); env.stop(second);
  const result = await outcome; assert.ifError(result.error); assert.equal(result.data, png);
  assert.equal(env.state.channels[0].URI.spec, URL); assert.equal(env.state.channels[1].URI.spec, TARGET);
  assert.equal(records.size, 1); assert.equal(JSON.stringify([...records.values()]).includes("SECOND_SECRET"), false);
  cache.dispose();
});

test("DNS uses Gecko140 seven-argument signature; no channel before all addresses pass", async () => {
  const env = fixture(), promise = env.fetch(URL, options());
  assert.equal(env.state.channels.length, 0);
  const args = env.state.dns[0].args;
  assert.equal(args.length, 7);
  assert.equal(args[0], "images.example.test");
  assert.equal(args[1], env.Ci.nsIDNSService.RESOLVE_TYPE_DEFAULT);
  assert.equal(args[2], env.Ci.nsIDNSService.RESOLVE_BYPASS_CACHE);
  assert.equal(args[3], null); assert.equal(args[5], null); assert.deepEqual(args[6], {});
  const ch = env.lookup(["93.184.216.34", "2606:4700::1111"]);
  env.start(ch); const response = await promise;
  assert.equal(response.status, 200); assert.equal(response.redirected, false); assert.equal(response.url, URL);
  assert.equal(response.headers.get("Content-Type"), "image/png");
  assert.equal(response.headers.get("not-present"), null);
  assert.equal(response.headers.get("constructor"), null);
  const args2 = env.state.channelArgs[0];
  assert.equal(args2.length, 6); assert.equal(args2[1], null); assert.equal(args2[2], env.principal);
  assert.equal(args2[3], null);
  assert.equal(args2[4], env.Ci.nsILoadInfo.SEC_ALLOW_CROSS_ORIGIN_SEC_CONTEXT_IS_NULL | env.Ci.nsILoadInfo.SEC_DISALLOW_SCRIPT);
  assert.equal(args2[5], env.Ci.nsIContentPolicy.TYPE_OTHER);
  assert.equal(ch.loadFlags, 15); assert.equal(ch.loadInfo.allowDeprecatedSystemRequests, true);
  assert.equal(ch.requestMethod, "GET"); assert.equal(ch.referrerInfo, null); assert.equal(ch.loadGroup, null);
  assert.equal(ch.blockAuthPrompt, true);
  assert.deepEqual(env.state.setHeaders, []);
  env.stop(ch); assert.equal(ch.notificationCallbacks, null);
});

test("200 resolves at metadata, delivers Uint8Array chunks and drains queued data after stop", async () => {
  const env = fixture(), promise = env.fetch(URL, options()), ch = env.lookup();
  env.start(ch); const response = await promise, reader = response.body.getReader();
  const first = reader.read(); env.data(ch, [0, 255, 128]);
  assert.deepEqual(await first, { done: false, value: Uint8Array.of(0, 255, 128) });
  env.data(ch, [4, 5]); env.data(ch, [6]); env.stop(ch);
  assert.deepEqual(await reader.read(), { done: false, value: Uint8Array.of(4, 5, 6) });
  assert.deepEqual(await reader.read(), { done: true, value: undefined });
  reader.releaseLock(); await assert.rejects(reader.read(), { message: FAILURE });
  assert.equal((await response.body.getReader().read()).done, true);
});

test("queue coalesces tiny callbacks and each native binary read is at most 64KiB", async () => {
  const env = fixture(), promise = env.fetch(URL, options()), ch = env.lookup();
  env.start(ch); const response = await promise;
  for (let i = 0; i < 10000; i++) env.data(ch, [i & 255]);
  env.data(ch, 128 * 1024); env.stop(ch);
  const reader = response.body.getReader(); let count = 0, bytes = 0;
  for (;;) { const result = await reader.read(); if (result.done) break; count++; bytes += result.value.length; }
  assert.equal(bytes, 10000 + 128 * 1024); assert.equal(count, 3);
  assert.ok(env.state.readSizes.every(size => size <= 64 * 1024));
});

test("exact 12MiB allowed, over-limit callback refused before any byte read", async () => {
  const env = fixture(), promise = env.fetch(URL, options()), ch = env.lookup();
  env.start(ch, 200, { "content-length": String(MAX) }); const response = await promise;
  env.data(ch, MAX); assert.equal(env.state.readSizes.length, 192);
  const reads = env.state.readSizes.length;
  env.data(ch, 1); assert.equal(env.state.readSizes.length, reads);
  await assert.rejects(response.body.getReader().read(), { message: FAILURE });
  assert.ok(ch.cancellations.length); assert.equal(ch.notificationCallbacks, null);
});

test("total-byte bound remains enforced even after consumer drains the queue", async () => {
  const env = fixture(), promise = env.fetch(URL, options()), ch = env.lookup();
  env.start(ch); const reader = (await promise).body.getReader();
  for (let i = 0; i < 192; i++) { env.data(ch, 65536); assert.equal((await reader.read()).value.length, 65536); }
  const pending = reader.read(); env.data(ch, 1);
  await assert.rejects(pending, { message: FAILURE });
  assert.equal(env.state.readSizes.length, 192);
});

for (const length of [String(MAX + 1), "99999999999999999999999", "-1", "12bytes", "12\r\nSECRET"]) {
  test(`invalid/excess Content-Length is refused without reading: ${JSON.stringify(length)}`, async () => {
    const env = fixture(), promise = env.fetch(URL, options()), ch = env.lookup();
    env.start(ch, 200, { "content-length": length });
    await assert.rejects(promise, { message: FAILURE });
    env.data(ch, MAX + 1); assert.equal(env.state.readSizes.length, 0);
  });
}

test("compressed Content-Length is prechecked but not exposed as decoded stream size", async () => {
  for (const encoding of ["gzip", "br", " GZip ", "gzip, br"]) {
    const env = fixture(), promise = env.fetch(URL, options()), ch = env.lookup();
    env.start(ch, 200, { "content-length": "3", "content-encoding": encoding });
    const response = await promise;
    assert.equal(response.headers.get("content-length"), null);
    env.data(ch, 100); env.stop(ch);
    const reader = response.body.getReader();
    assert.equal((await reader.read()).value.length, 100); assert.equal((await reader.read()).done, true);
  }
  for (const encoding of ["identity", " IDENTITY ", ""]) {
    const env = fixture(), promise = env.fetch(URL, options()), ch = env.lookup();
    env.start(ch, 200, { "content-length": "3", "content-encoding": encoding });
    assert.equal((await promise).headers.get("content-length"), "3"); env.stop(ch);
  }
  const env = fixture(), promise = env.fetch(URL, options()), ch = env.lookup();
  env.start(ch, 200, { "content-length": String(MAX + 1), "content-encoding": "gzip" });
  await assert.rejects(promise, { message: FAILURE }); assert.equal(env.state.readSizes.length, 0);
});

test("decoded compressed stream still has the 12MiB pre-read bound", async () => {
  const env = fixture(), promise = env.fetch(URL, options()), ch = env.lookup();
  env.start(ch, 200, { "content-length": "3", "content-encoding": "gzip" });
  const reader = (await promise).body.getReader(), pending = reader.read();
  env.data(ch, MAX + 1); await assert.rejects(pending, { message: FAILURE });
  assert.equal(env.state.readSizes.length, 0);
});

test("network or stream errors after metadata reject pending and future reads with fixed errors", async () => {
  for (const readFailure of [false, true]) {
    const env = fixture({ readFailure }), promise = env.fetch(URL, options()), ch = env.lookup();
    env.start(ch); const reader = (await promise).body.getReader(), pending = reader.read();
    if (readFailure) env.data(ch, [1]); else env.stop(ch, 0x80004005);
    await assert.rejects(pending, { message: FAILURE });
    await assert.rejects(reader.read(), { message: FAILURE });
  }
});

test("non200 responses expose metadata and cancel before downloading any body", async () => {
  for (const status of [204, 304, 401, 403, 404, 500]) {
    const env = fixture({ synchronousStop: true }), promise = env.fetch(URL, options()), ch = env.lookup();
    env.start(ch, status, { "content-length": String(MAX * 100) });
    const response = await promise; assert.equal(response.status, status); assert.equal(response.body, null);
    env.data(ch, MAX * 100); env.stop(ch, 1);
    assert.equal(env.state.readSizes.length, 0); assert.ok(ch.cancellations.length);
    assert.equal(ch.notificationCallbacks, null);
  }
});

for (const status of [301, 302, 303, 307, 308]) {
  test(`HTTP ${status} redirect exposes resolved cross-origin target but never opens new channel`, async () => {
    const env = fixture({ synchronousStop: true }), promise = env.fetch(URL, options()), ch = env.lookup();
    env.redirect(ch, status);
    const response = await promise;
    assert.equal(response.status, status); assert.equal(response.body, null); assert.equal(response.redirected, false);
    assert.equal(response.headers.get("LOCATION"), TARGET); assert.equal(response.url, URL);
    assert.equal(env.state.channels.length, 1); assert.equal(ch.notificationCallbacks, null);
    env.start(ch); env.data(ch, MAX + 1); env.stop(ch, 1);
    assert.equal(env.state.readSizes.length, 0);
  });
}

test("internal nonHTTP redirect and unsafe targets fail closed", async () => {
  for (const [status, target] of [[200, TARGET], [0, TARGET], [307, "file:///tmp/a"],
    [307, "javascript:alert(1)"], [307, "https://user:pass@cdn.example.test/a"], [307, "http://127.0.0.1/a"]]) {
    const env = fixture(), promise = env.fetch(URL, options()), ch = env.lookup();
    env.redirect(ch, status, target, 4);
    await assert.rejects(promise, { message: FAILURE });
    assert.ok(ch.cancellations.length);
  }
});

test("cancellation before DNS prevents lookup; cancellation during DNS cancels exact request and ignores late results", async () => {
  const controller = new AbortController(); controller.abort(URL);
  const env = fixture(); await assert.rejects(env.fetch(URL, options(controller.signal)), { message: ABORTED });
  assert.equal(env.state.dns.length, 0);
  const active = new AbortController(), promise = env.fetch(URL, options(active.signal));
  active.abort(URL); await assert.rejects(promise, { message: ABORTED });
  assert.deepEqual(env.state.dns[0].request.cancellations, [env.Cr.NS_BINDING_ABORTED]);
  env.lookup(); assert.equal(env.state.channels.length, 0);
});

test("abort during asyncResolve return race still cancels returned request", async () => {
  const controller = new AbortController();
  const env = fixture({ onDNS: () => controller.abort() });
  await assert.rejects(env.fetch(URL, options(controller.signal)), { message: ABORTED });
  assert.deepEqual(env.state.dns[0].request.cancellations, [env.Cr.NS_BINDING_ABORTED]);
  env.lookup(); assert.equal(env.state.channels.length, 0);
});

test("abort before metadata rejects fetch and cancels immediately, with late callbacks inert", async () => {
  const controller = new AbortController(), env = fixture({ synchronousStop: true });
  const promise = env.fetch(URL, options(controller.signal)), ch = env.lookup();
  controller.abort(URL); assert.ok(ch.cancellations.length);
  await assert.rejects(promise, { message: ABORTED });
  env.start(ch); env.data(ch, 99); env.stop(ch); env.redirect(ch);
  assert.equal(env.state.readSizes.length, 0); assert.equal(ch.notificationCallbacks, null);
});

test("abort/timeout signal after metadata rejects pending body read and clears queued data", async () => {
  for (const pendingRead of [false, true]) {
    const controller = new AbortController(), env = fixture({ synchronousStop: true });
    const promise = env.fetch(URL, options(controller.signal)), ch = env.lookup(); env.start(ch);
    const reader = (await promise).body.getReader();
    const pending = pendingRead ? reader.read() : null;
    if (!pendingRead) env.data(ch, [1, 2]);
    controller.abort(new Error(URL));
    await assert.rejects(pending || reader.read(), { message: ABORTED });
    env.data(ch, 99); await assert.rejects(reader.read(), { message: ABORTED });
    assert.equal(ch.notificationCallbacks, null); assert.ok(ch.cancellations.length);
  }
});

test("reader cancellation resolves waiting read, cancels network, ignores late data and releases lock", async () => {
  const env = fixture(), promise = env.fetch(URL, options()), ch = env.lookup(); env.start(ch);
  const response = await promise, reader = response.body.getReader();
  assert.throws(() => response.body.getReader(), { message: FAILURE });
  const pending = reader.read(); assert.throws(() => reader.releaseLock(), { message: FAILURE });
  await assert.rejects(reader.read(), { message: FAILURE });
  await reader.cancel(); assert.equal((await pending).done, true);
  env.data(ch, 99); env.stop(ch); assert.equal(env.state.readSizes.length, 0);
  assert.equal((await reader.read()).done, true); reader.releaseLock(); reader.releaseLock();
  await assert.rejects(reader.cancel(), { message: FAILURE });
});

test("empty, failed, private, mixed and oversized DNS results never create channel", async () => {
  for (const [addresses, status] of [[[], 0], [null, 0], [["8.8.8.8"], 1], [["127.0.0.1"], 0],
    [["8.8.8.8", "10.0.0.1"], 0], [["2606:4700::1111", "fe80::1"], 0], [Array(65).fill("8.8.8.8"), 0]]) {
    const env = fixture(), promise = env.fetch(URL, options()); env.lookup(addresses, status);
    await assert.rejects(promise, { message: FAILURE }); assert.equal(env.state.channels.length, 0);
  }
  const env = fixture(), promise = env.fetch(URL, options()); const ch = env.lookup(Array(64).fill("8.8.8.8"));
  env.start(ch); await promise; env.stop(ch);
});

test("protocol, embedded credentials, raw control characters and numeric loopback are rejected before DNS", async () => {
  for (const url of ["file:///tmp/private", "javascript:alert(1)", "data:image/png,a", "ftp://example.test/a",
    "https://user:password@example.test/a", "https://@example.test/a", "https://example.test/\n?a", "https://example.test\\a",
    "http://127.0.0.1/a", "http://2130706433/a", "http://0x7f000001/a", "http://[::1]/a"]) {
    const env = fixture(); await assert.rejects(env.fetch(url, options()), { message: FAILURE });
    assert.equal(env.state.dns.length, 0); assert.equal(env.state.channels.length, 0);
  }
});

test("public HTTP and arbitrary API/domain paths are accepted without origin allowlist", async () => {
  const env = fixture(), promise = env.fetch("http://different.example.test/v9/signed/arbitrary?token=x", options());
  const ch = env.lookup(); env.start(ch); assert.equal((await promise).status, 200); env.stop(ch);
});

test("unsupported options cannot introduce credentials, headers, referrer or redirect following", async () => {
  for (const delta of [{ method: "POST" }, { credentials: "include" }, { redirect: "follow" },
    { cache: "default" }, { referrerPolicy: "unsafe-url" }, { headers: { Authorization: "SECRET" } },
    { referrer: URL }, { body: "secret" }]) {
    const env = fixture(); await assert.rejects(env.fetch(URL, { ...options(), ...delta }), { message: FAILURE });
    assert.equal(env.state.dns.length, 0);
  }
});

test("notification callbacks supply only redirect sink, never auth/certificate prompts", async () => {
  for (const name of ["nsIAuthPrompt", "nsIAuthPrompt2", "nsIAuthPromptProvider", "nsIBadCertListener2"]) {
    const env = fixture(), promise = env.fetch(URL, options()), ch = env.lookup(), listener = ch.savedListener;
    assert.equal(listener.getInterface(env.Ci.nsIChannelEventSink), listener);
    assert.throws(() => listener.getInterface(env.Ci.nsILoadContext), value => value === env.Cr.NS_ERROR_NO_INTERFACE);
    assert.equal(ch.cancellations.length, 0);
    assert.throws(() => listener.getInterface(env.Ci[name]), value => value === env.Cr.NS_ERROR_NO_INTERFACE);
    await assert.rejects(promise, { message: FAILURE }); assert.ok(ch.cancellations.length);
  }
});

test("native exception messages and signed URLs never escape through fixed errors", async () => {
  for (const fault of ["uriFailure", "dnsFailure", "channelFailure", "openFailure"]) {
    const env = fixture({ [fault]: true }), promise = env.fetch(URL, options());
    if (fault === "channelFailure" || fault === "openFailure") env.lookup();
    await assert.rejects(promise, err => {
      assert.equal(err.message, FAILURE); assert.equal(err.cause, undefined);
      assert.doesNotMatch(err.stack, /SECRET|images\.example|signature=/u); return true;
    });
  }
  const source = fs.readFileSync(require.resolve("../plugin/content/fulltext-image-network.js"), "utf8");
  assert.doesNotMatch(source, /Zotero\.(?:HTTP|debug|logError)|console\.|XMLHttpRequest|arrayBuffer\(/u);
});
