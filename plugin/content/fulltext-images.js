(function (global) {
  "use strict";

  const modules = global.SmartPaperTranslatorModules = global.SmartPaperTranslatorModules || {};
  const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
  const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
  const MAX_ENTRIES = 128;
  const TIMEOUT_MS = 15000;
  const Network = modules.FulltextImageNetwork || (typeof require === "function" ? require("./fulltext-image-network.js") : null);
  const TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
  const REDIRECTS = new Set([301, 302, 303, 307, 308]);
  const MESSAGES = {
    url: "全文图片：地址不受信任", invalid: "全文图片：图片或缓存校验失败",
    network: "全文图片：下载失败", limit: "全文图片：资源超过上限",
    stale: "全文图片：请求已失效", timeout: "全文图片：下载超时",
    adapter: "全文图片：适配器无效"
  };
  function fail(kind) { throw new Error(MESSAGES[kind]); }

  function parseURL(value, base) {
    if (typeof value !== "string" || !value || value.length > 8192 || /[\s\u0000-\u001f\u007f-\u009f\\]/u.test(value)) fail("url");
    let url;
    try { url = new URL(value, base); } catch (_) { fail("url"); }
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) fail("url");
    url.hash = "";
    return url;
  }
  function validateURL(value, baseURL) {
    const url = parseURL(value, baseURL), host = url.hostname.toLowerCase().replace(/\.$/u, "");
    if (host === "localhost" || /\.(?:localhost|local|internal|lan|home\.arpa)$/u.test(host)) fail("url");
    if (host.includes(":") || /^[\d.]+$/u.test(host)) {
      if (!Network?.isPublicAddress(host.replace(/^\[|\]$/gu, ""))) fail("url");
    } else if (!host.includes(".")) fail("url");
    return url.href;
  }
  function sniffMime(bytes) {
    if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b)) return "image/png";
    if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
    const ascii = (start, length) => String.fromCharCode(...bytes.subarray(start, start + length));
    if (["GIF87a", "GIF89a"].includes(ascii(0, 6))) return "image/gif";
    if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return "image/webp";
    fail("invalid");
  }
  function ignore(promise) { Promise.resolve(promise).catch(() => {}); }
  function toBase64(bytes) {
    // No DOM, Buffer, binary-string copy or privileged runtime dependency.
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const pieces = [];
    let part = "";
    for (let i = 0; i < bytes.length; i += 3) {
      const value = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
      part += alphabet[value >>> 18] + alphabet[(value >>> 12) & 63]
        + (i + 1 < bytes.length ? alphabet[(value >>> 6) & 63] : "=")
        + (i + 2 < bytes.length ? alphabet[value & 63] : "=");
      if (part.length >= 16384) { pieces.push(part); part = ""; }
    }
    pieces.push(part);
    return pieces.join("");
  }

  class ImageCache {
    #base; #fetch; #Controller; #hash; #storage; #validate; #timers;
    #memory = new Map(); #pending = new Map(); #tail = Promise.resolve();
    #bytes = 0; #generation = 0; #disposed = false;

    constructor({ baseURL, fetch, AbortController, hash, storage, validateImage, timers } = {}) {
      parseURL(baseURL);
      if (typeof fetch !== "function" || typeof AbortController !== "function" || typeof hash !== "function"
        || typeof validateImage !== "function" || !storage || typeof storage.read !== "function"
        || typeof storage.write !== "function") fail("adapter");
      this.#base = parseURL(baseURL).href.replace(/\/+$/u, "") + "/"; this.#fetch = fetch; this.#Controller = AbortController;
      this.#hash = hash; this.#storage = storage; this.#validate = validateImage;
      this.#timers = timers || { setTimeout: (...args) => global.setTimeout(...args), clearTimeout: id => global.clearTimeout(id) };
      if (typeof this.#timers.setTimeout !== "function" || typeof this.#timers.clearTimeout !== "function") fail("adapter");
    }

    get(url) {
      const normalized = validateURL(url, this.#base);
      return this.#disposed ? null : this.#memory.get(normalized)?.dataURI || null;
    }

    async resolve(url, { isCurrent = () => true } = {}) {
      const normalized = validateURL(url, this.#base);
      const current = () => {
        try { return typeof isCurrent === "function" && isCurrent() === true; } catch (_) { return false; }
      };
      if (this.#disposed || !current()) fail("stale");
      const generation = this.#generation;
      const cached = this.#memory.get(normalized);
      if (cached) return cached.dataURI;
      let job = this.#pending.get(normalized);
      if (!job) {
        let reject;
        const cancelled = new Promise((_, rejectPromise) => { reject = rejectPromise; });
        // Queued cancellation must not produce an unhandled rejection.
        ignore(cancelled);
        job = { generation, waiters: new Set(), cancelled, reject, error: null, controller: null, reader: null };
        job.promise = this.#tail.then(() => this.#load(normalized, job)).finally(() => {
          if (this.#pending.get(normalized) === job) this.#pending.delete(normalized);
        });
        this.#tail = job.promise.catch(() => {});
        this.#pending.set(normalized, job);
      }
      job.waiters.add(current);
      try {
        const dataURI = await Promise.race([job.promise, job.cancelled]);
        if (this.#disposed || generation !== this.#generation || !current()) fail("stale");
        return dataURI;
      }
      finally { job.waiters.delete(current); }
    }

    cancel() {
      this.#generation++;
      for (const job of this.#pending.values()) this.#stop(job, "stale");
      this.#pending.clear();
    }
    dispose() { this.#disposed = true; this.cancel(); this.#memory.clear(); this.#bytes = 0; }

    #stop(job, kind) {
      if (!job.error) { job.error = new Error(MESSAGES[kind]); job.reject(job.error); }
      try { job.controller?.abort(); } catch (_) { /* No adapter diagnostics escape. */ }
      try { if (job.reader) ignore(job.reader.cancel()); } catch (_) { /* Best effort. */ }
    }
    #check(job) {
      if (job.error) throw job.error;
      if (this.#disposed || job.generation !== this.#generation || ![...job.waiters].some(current => current())) {
        this.#stop(job, "stale");
        throw job.error;
      }
    }
    async #wait(job, operation) {
      this.#check(job);
      const value = await Promise.race([Promise.resolve().then(() => {
        this.#check(job);
        return operation();
      }), job.cancelled]);
      this.#check(job);
      return value;
    }
    async #digest(job, value) {
      const digest = await this.#wait(job, () => this.#hash(value));
      // Safe opaque storage keys. The host should inject SHA-256; no URL is persisted.
      if (typeof digest !== "string" || !/^[a-f0-9]{64}$/u.test(digest)) fail("invalid");
      return digest;
    }
    #image(dataURI, mime) {
      if (typeof dataURI !== "string" || dataURI.length > 4 * Math.ceil(MAX_IMAGE_BYTES / 3) + 64) fail("limit");
      const prefix = `data:${mime};base64,`;
      if (!dataURI.startsWith(prefix)) fail("invalid");
      const encoded = dataURI.slice(prefix.length);
      if (!encoded.length || encoded.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded)) fail("invalid");
      const size = encoded.length / 4 * 3 - (encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0);
      if (size > MAX_IMAGE_BYTES) fail("limit");
      this.#budget(size);
      let info;
      try { info = this.#validate(dataURI); } catch (_) { fail("invalid"); }
      if (!info || info.size !== size || !Number.isSafeInteger(info.width) || !Number.isSafeInteger(info.height)
        || info.width <= 0 || info.height <= 0 || info.width > 16384 || info.height > 16384
        || info.width * info.height > 40 * 1024 * 1024) fail("invalid");
      return size;
    }
    #budget(size) {
      if (this.#memory.size >= MAX_ENTRIES || this.#bytes + size > MAX_TOTAL_BYTES) fail("limit");
    }
    async #load(url, job) {
      try {
        this.#check(job);
        this.#budget(0);
        const urlHash = await this.#digest(job, url);
        const record = await this.#wait(job, () => this.#storage.read(urlHash));
        let mime, dataURI, contentHash, size;
        if (record !== null && record !== undefined) {
          if (!record || typeof record !== "object" || Array.isArray(record)
            || Object.keys(record).sort().join(",") !== "contentHash,dataURI,mime,schema,urlHash"
            || record.schema !== 1 || record.urlHash !== urlHash || !TYPES.has(record.mime)) fail("invalid");
          mime = record.mime; dataURI = record.dataURI;
          size = this.#image(dataURI, mime);
          contentHash = await this.#digest(job, dataURI);
          if (contentHash !== record.contentHash) fail("invalid");
        }
        else {
          ({ dataURI, mime } = await this.#download(url, job));
          this.#check(job);
          size = this.#image(dataURI, mime);
          contentHash = await this.#digest(job, dataURI);
          this.#budget(size);
          await this.#wait(job, () => this.#storage.write(urlHash, { schema: 1, urlHash, contentHash, mime, dataURI }));
        }
        this.#check(job);
        this.#budget(size);
        this.#memory.set(url, { dataURI, size });
        this.#bytes += size;
        return dataURI;
      }
      catch (error) {
        this.#stop(job, Object.keys(MESSAGES).find(key => error instanceof Error && MESSAGES[key] === error.message) || "invalid");
        if (error instanceof Error && Object.values(MESSAGES).includes(error.message)) throw error;
        fail("invalid");
      }
    }
    async #download(url, job) {
      this.#check(job);
      job.controller = new this.#Controller();
      const timer = this.#timers.setTimeout(() => this.#stop(job, "timeout"), TIMEOUT_MS);
      try {
        let response, target = url;
        const seen = new Set([target]);
        for (let hop = 0; ; hop++) {
          response = await this.#wait(job, () => this.#fetch(target, {
            method: "GET", credentials: "omit", redirect: "manual", referrerPolicy: "no-referrer",
            cache: "no-store", signal: job.controller.signal
          }));
          if (!response || response.redirected !== false || response.url !== target) fail("network");
          if (!REDIRECTS.has(response.status)) break;
          if (hop >= 5) fail("limit");
          const next = validateURL(response.headers?.get("location"), target);
          if (seen.has(next)) fail("network");
          if (response.body?.cancel) await this.#wait(job, () => response.body.cancel());
          seen.add(next); target = next;
        }
        const declaredMime = String(response.headers?.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
        if (response.status !== 200 || (!TYPES.has(declaredMime) && !["", "application/octet-stream", "binary/octet-stream"].includes(declaredMime))
          || !response.body || typeof response.body.getReader !== "function") fail("network");
        const declared = response.headers.get("content-length");
        if (declared !== null && declared !== undefined) {
          if (!/^(?:0|[1-9]\d*)$/u.test(declared)) fail("network");
          if (!Number.isSafeInteger(Number(declared)) || Number(declared) > MAX_IMAGE_BYTES) fail("limit");
          this.#budget(Number(declared));
        }
        job.reader = response.body.getReader();
        const chunks = [];
        let size = 0;
        while (true) {
          const chunk = await this.#wait(job, () => job.reader.read());
          if (!chunk || typeof chunk.done !== "boolean") fail("network");
          if (chunk.done) break;
          // fetch is imported from Gecko's shared system global, not this script's realm.
          if (!ArrayBuffer.isView(chunk.value) || Object.prototype.toString.call(chunk.value) !== "[object Uint8Array]") fail("network");
          size += chunk.value.byteLength;
          if (size > MAX_IMAGE_BYTES) fail("limit");
          this.#budget(size);
          // Bound chunk bookkeeping too (a hostile stream can emit empty/tiny chunks).
          if (!chunk.value.byteLength) fail("network");
          if (chunks.length >= 65536) fail("limit");
          chunks.push(chunk.value.slice());
        }
        if (!size || (declared !== null && declared !== undefined && Number(declared) !== size)) fail("network");
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        const mime = sniffMime(bytes);
        if (TYPES.has(declaredMime) && declaredMime !== mime) fail("invalid");
        return { mime, dataURI: `data:${mime};base64,${toBase64(bytes)}` };
      }
      catch (error) {
        this.#stop(job, Object.keys(MESSAGES).find(key => error instanceof Error && MESSAGES[key] === error.message) || "network");
        if (job.error?.message === MESSAGES.timeout || job.error?.message === MESSAGES.stale) throw job.error;
        if (error instanceof Error && Object.values(MESSAGES).includes(error.message)) throw error;
        fail("network");
      }
      finally {
        this.#timers.clearTimeout(timer);
        try { job.reader?.releaseLock(); } catch (_) { /* Pending reads can retain a lock. */ }
        job.reader = null;
      }
    }
  }

  modules.FulltextImages = { validateURL, ImageCache };
  if (typeof module !== "undefined" && module.exports) module.exports = modules.FulltextImages;
})(typeof globalThis !== "undefined" ? globalThis : this);
