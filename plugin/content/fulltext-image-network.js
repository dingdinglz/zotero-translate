(function (global) {
  "use strict";

  const modules = global.SmartPaperTranslatorModules = global.SmartPaperTranslatorModules || {};
  const MAX_BYTES = 12 * 1024 * 1024;
  const MAX_ADDRESSES = 64;
  const BLOCK_BYTES = 64 * 1024;
  const FAILURE = "Image network request failed";
  const ABORTED = "Image network request cancelled";

  // Gecko channel adapter; caller owns the shared timeout and redirect loop.
  // DNS preflight is not pinning: rebinding/proxies remain a host limitation.

  function ipv4(value) {
    if (!/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/u.test(value)) return null;
    const bytes = value.split(".").map(Number);
    return bytes.every(byte => byte <= 255) ? bytes : null;
  }

  function publicIPv4(bytes) {
    const [a, b, c] = bytes;
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && ((b === 0 && (c === 0 || c === 2))
        || (b === 88 && c === 99) || b === 168))
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
      || (a === 203 && b === 0 && c === 113));
  }

  function isPublicAddress(value) {
    if (typeof value !== "string" || value.length > 64) return false;
    const v4 = ipv4(value);
    if (v4) return publicIPv4(v4);
    let text = value.toLowerCase();
    if (text.startsWith("[") && text.endsWith("]")) text = text.slice(1, -1);
    if (!text.includes(":") || /[^0-9a-f:.]/u.test(text)) return false;
    if (text.includes(".")) {
      const colon = text.lastIndexOf(":");
      const embedded = ipv4(text.slice(colon + 1));
      if (!embedded) return false;
      text = text.slice(0, colon + 1)
        + ((embedded[0] << 8) | embedded[1]).toString(16) + ":"
        + ((embedded[2] << 8) | embedded[3]).toString(16);
    }
    const parts = text.split("::");
    if (parts.length > 2) return false;
    const left = parts[0] ? parts[0].split(":") : [];
    const right = parts.length === 2 && parts[1] ? parts[1].split(":") : [];
    const count = left.length + right.length;
    if ((parts.length === 1 && count !== 8) || (parts.length === 2 && count >= 8)
      || !left.concat(right).every(part => /^[0-9a-f]{1,4}$/u.test(part))) return false;
    const words = left.concat(Array(parts.length === 2 ? 8 - count : 0).fill("0"), right)
      .map(part => parseInt(part, 16));
    if (words.slice(0, 5).every(word => word === 0) && words[5] === 0xffff) {
      return publicIPv4([words[6] >> 8, words[6] & 255, words[7] >> 8, words[7] & 255]);
    }
    // Allow only global unicast 2000::/3, excluding protocol/transition and
    // documentation allocations. Other reserved/multicast/ULA/link-local fail.
    return (words[0] & 0xe000) === 0x2000
      && !(words[0] === 0x2001 && (words[1] < 0x200 || words[1] === 0xdb8))
      && words[0] !== 0x2002
      && !(words[0] === 0x3fff && words[1] < 0x1000);
  }

  function isAllowedDNSAddress(value, hostname) {
    if (isPublicAddress(value)) return true;
    const bytes = typeof value === "string" ? ipv4(value) : null;
    const host = hostname.toLowerCase().replace(/\.$/u, "");
    // Domain-only proxy exception; literal-IP policy remains in isPublicAddress().
    return Boolean(bytes && bytes[0] === 198 && (bytes[1] === 18 || bytes[1] === 19)
      && host.includes(".") && !host.includes(":") && !/^[\d.]+$/u.test(host)
      && !/(?:^|\.)(?:localhost|local|internal|lan|home\.arpa)$/u.test(host));
  }

  function createFetch({ Services, ChromeUtils, Cc, Ci, Cr, Components }) {
    const success = status => Components.isSuccessCode(status);
    const error = cancelled => new Error(cancelled ? ABORTED : FAILURE);

    function checkedURI(value) {
      if (typeof value !== "string" || value.length > 32768 || /[\u0000-\u0020\u007f\\]/u.test(value)
        || !/^https?:\/\//iu.test(value) || /^https?:\/\/[^/?#]*@/iu.test(value)) throw error(false);
      const uri = Services.io.newURI(value);
      if (!['http', 'https'].includes(uri.scheme) || uri.userPass || !uri.asciiHost) throw error(false);
      // URI parsing canonicalizes alternate numeric IPv4 forms before this check.
      const host = uri.asciiHost.replace(/^\[|\]$/gu, "");
      if ((host.includes(":") || /^[0-9.]+$/u.test(host)) && !isPublicAddress(host)) throw error(false);
      return uri;
    }

    return async function fetch(url, options = {}) {
      // This is deliberately not a general-purpose fetch implementation.
      const allowed = new Set(["method", "credentials", "redirect", "referrerPolicy", "cache", "signal"]);
      if (Object.keys(options).some(key => !allowed.has(key))
        || options.method !== "GET" || options.credentials !== "omit" || options.redirect !== "manual"
        || options.referrerPolicy !== "no-referrer" || options.cache !== "no-store") throw error(false);
      const signal = options.signal;
      if (signal && signal.aborted) throw error(true);
      let uri;
      try { uri = checkedURI(url); } catch (_) { throw error(false); }
      const responseURL = uri.spec;

      return new Promise((resolve, reject) => {
        let channel = null, dnsRequest = null, listener = null, dnsListener = null;
        let closed = false, responded = false, started = false, bodyError = null;
        let total = 0, queued = 0, queue = [], pending = null, locked = false;

        function cancelRequest(request) {
          try { request?.cancel(Cr.NS_BINDING_ABORTED); } catch (_) {}
        }
        function detach(cancel) {
          const oldChannel = channel, oldDNS = dnsRequest;
          channel = dnsRequest = listener = dnsListener = null;
          try { signal?.removeEventListener("abort", onAbort); } catch (_) {}
          try { if (oldChannel) oldChannel.notificationCallbacks = null; } catch (_) {}
          if (cancel) { cancelRequest(oldDNS); cancelRequest(oldChannel); }
        }
        function drain() {
          if (!pending) return;
          const waiter = pending;
          if (bodyError) { pending = null; waiter.reject(bodyError); }
          else if (queue.length) {
            const block = queue.shift(); queued -= block.used;
            pending = null;
            waiter.resolve({ done: false, value: block.bytes.subarray(0, block.used) });
          } else if (closed) { pending = null; waiter.resolve({ done: true, value: undefined }); }
        }
        function fail(cancelled = false) {
          if (closed) return;
          closed = true; bodyError = error(cancelled); queue = []; queued = 0;
          detach(true);
          if (!responded) { responded = true; reject(bodyError); }
          drain();
        }
        function onAbort() { fail(true); }
        function headers(values) {
          return { get(name) {
            const key = String(name).toLowerCase();
            return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : null;
          } };
        }
        function header(http, name, maxLength) {
          let value;
          try { value = http.getResponseHeader(name); } catch (_) { return null; }
          if (typeof value !== "string" || value.length > maxLength || /[\r\n\u0000]/u.test(value)) throw error(false);
          return value;
        }
        function respond(status, values, body) {
          responded = true;
          resolve({ status, redirected: false, url: responseURL, headers: headers(values), body });
        }
        function metadataOnly(status, values) {
          // Close before cancel: Gecko can deliver onStopRequest synchronously.
          closed = true;
          respond(status, values, null);
          detach(true);
        }
        const body = {
          getReader() {
            if (locked) throw error(false);
            locked = true;
            let released = false;
            return {
              read() {
                if (released || pending) return Promise.reject(error(false));
                return new Promise((res, rej) => { pending = { resolve: res, reject: rej }; drain(); });
              },
              async cancel() {
                if (released) throw error(false);
                if (!closed) {
                  closed = true; queue = []; queued = 0; detach(true); drain();
                } else { queue = []; queued = 0; }
              },
              releaseLock() {
                if (pending) throw error(false);
                if (!released) { released = true; locked = false; }
              },
            };
          },
        };

        function openChannel() {
          if (closed) return;
          try {
            const principal = Services.scriptSecurityManager.getSystemPrincipal();
            channel = Services.io.newChannelFromURI(uri, null, principal, null,
              Ci.nsILoadInfo.SEC_ALLOW_CROSS_ORIGIN_SEC_CONTEXT_IS_NULL | Ci.nsILoadInfo.SEC_DISALLOW_SCRIPT,
              Ci.nsIContentPolicy.TYPE_OTHER);
            channel.loadInfo.allowDeprecatedSystemRequests = true;
            channel = channel.QueryInterface(Ci.nsIHttpChannel);
            channel.loadFlags |= Ci.nsIRequest.LOAD_ANONYMOUS | Ci.nsIRequest.LOAD_BYPASS_CACHE
              | Ci.nsIRequest.INHIBIT_CACHING | Ci.nsIRequest.LOAD_BACKGROUND;
            channel.loadGroup = null;
            channel.requestMethod = "GET";
            channel.referrerInfo = null;
            channel.QueryInterface(Ci.nsIHttpChannelInternal).blockAuthPrompt = true;
            listener = {
              QueryInterface: ChromeUtils.generateQI(["nsIStreamListener", "nsIRequestObserver",
                "nsIInterfaceRequestor", "nsIChannelEventSink"]),
              getInterface(iid) {
                if (!closed && iid.equals(Ci.nsIChannelEventSink)) return this;
                // No auth/certificate UI, no forwarding to a window or load group.
                for (const name of ["nsIAuthPrompt", "nsIAuthPrompt2", "nsIAuthPromptProvider", "nsIBadCertListener2"]) {
                  if (Ci[name] && iid.equals(Ci[name])) { fail(); break; }
                }
                throw Cr.NS_ERROR_NO_INTERFACE;
              },
              asyncOnChannelRedirect(oldChannel, newChannel, flags, callback) {
                try {
                  if (closed || responded || oldChannel !== channel) throw error(false);
                  const http = oldChannel.QueryInterface(Ci.nsIHttpChannel);
                  const status = http.responseStatus;
                  if (!Number.isInteger(status) || status < 300 || status > 399
                    || !header(http, "location", 32768)) throw error(false);
                  // Only surface the resolved target, never open/follow this channel.
                  const target = checkedURI(newChannel.URI.spec).spec;
                  metadataOnly(status, { location: target });
                } catch (_) { fail(); }
                finally {
                  cancelRequest(oldChannel);
                  try { callback.onRedirectVerifyCallback(Cr.NS_BINDING_ABORTED); } catch (_) {}
                }
              },
              onStartRequest(request) {
                if (closed) return;
                try {
                  if (request !== channel || started) throw error(false);
                  started = true;
                  if (!success(request.status)) throw error(false);
                  const http = request.QueryInterface(Ci.nsIHttpChannel), status = http.responseStatus;
                  if (!Number.isInteger(status) || status < 100 || status > 599) throw error(false);
                  const values = {
                    "content-type": header(http, "content-type", 256),
                    "content-length": header(http, "content-length", 32),
                  };
                  if (status !== 200) {
                    if (status >= 300 && status < 400) values.location = header(http, "location", 32768);
                    metadataOnly(status, values); return;
                  }
                  const length = values["content-length"];
                  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > MAX_BYTES)) throw error(false);
                  const encoding = header(http, "content-encoding", 256)?.trim().toLowerCase();
                  // Gecko may decode the stream; compressed length is not its exact size.
                  if (encoding && encoding !== "identity") values["content-length"] = null;
                  respond(status, values, body);
                } catch (_) { fail(); }
              },
              onDataAvailable(request, inputStream, offset, count) {
                if (closed) return;
                try {
                  if (request !== channel || !started || !responded || !Number.isSafeInteger(count)
                    || count < 0 || count > MAX_BYTES - total || count > MAX_BYTES - queued) throw error(false);
                  // Refuse excess bytes BEFORE constructing a stream or reading any data.
                  total += count;
                  const binary = Cc["@mozilla.org/binaryinputstream;1"].createInstance(Ci.nsIBinaryInputStream);
                  binary.setInputStream(inputStream);
                  let remaining = count;
                  while (remaining && !closed) {
                    let block = queue[queue.length - 1];
                    if (!block || block.used === BLOCK_BYTES) {
                      block = { bytes: new Uint8Array(BLOCK_BYTES), used: 0 }; queue.push(block);
                    }
                    const size = Math.min(remaining, BLOCK_BYTES - block.used);
                    const bytes = binary.readByteArray(size);
                    if (closed) return;
                    if (bytes.length !== size) throw error(false);
                    block.bytes.set(bytes, block.used); block.used += size;
                    queued += size; remaining -= size;
                    drain();
                  }
                  // Do not close binary: the input stream belongs to the channel.
                } catch (_) { fail(); }
              },
              onStopRequest(request, status) {
                if (closed) return;
                try {
                  if (request !== channel || !responded || !success(status)) throw error(false);
                  closed = true; detach(false); drain();
                } catch (_) { fail(); }
              },
            };
            channel.notificationCallbacks = listener;
            channel.asyncOpen(listener);
          } catch (_) { fail(); }
        }

        try {
          signal?.addEventListener("abort", onAbort, { once: true });
          if (signal?.aborted) { fail(true); return; }
          dnsListener = {
            QueryInterface: ChromeUtils.generateQI(["nsIDNSListener"]),
            onLookupComplete(request, record, status) {
              if (closed || request !== dnsRequest) return;
              dnsRequest = dnsListener = null;
              try {
                if (!success(status) || !record) throw error(false);
                record = record.QueryInterface(Ci.nsIDNSAddrRecord);
                let count = 0;
                while (record.hasMore()) {
                  if (++count > MAX_ADDRESSES || !isAllowedDNSAddress(record.getNextAddrAsString(), uri.asciiHost)) throw error(false);
                }
                if (!count) throw error(false);
                openChannel();
              } catch (_) { fail(); }
            },
          };
          const request = Services.dns.asyncResolve(uri.asciiHost.replace(/^\[|\]$/gu, ""),
            Ci.nsIDNSService.RESOLVE_TYPE_DEFAULT, Ci.nsIDNSService.RESOLVE_BYPASS_CACHE,
            null, dnsListener, null, {});
          if (closed) cancelRequest(request); else dnsRequest = request;
        } catch (_) { fail(); }
      });
    };
  }

  modules.FulltextImageNetwork = { createFetch, isPublicAddress };
  if (typeof module !== "undefined" && module.exports) module.exports = modules.FulltextImageNetwork;
})(typeof globalThis !== "undefined" ? globalThis : this);
