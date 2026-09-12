(function (global) {
  "use strict";

  const modules = global.SmartPaperTranslatorModules = global.SmartPaperTranslatorModules || {};
  const HTML_NS = "http://www.w3.org/1999/xhtml";
  const MAX_BYTES = 1024 * 1024;
  const MAX_PREVIEWS = 4;
  const MARKER_START = "\uE200visualize\uE202";
  const MARKER_END = "\uE201";
  const D3_URL = "https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js";
  const STATUS_ATTRIBUTE = "data-spt-visualize-status";
  // The outer document owns this policy. In particular frame-src blocks the
  // untrusted inner document's *own* navigations, which its own CSP cannot do.
  // srcdoc initial documents do not fetch a URL and inherit this policy.
  const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
    "img-src data:; frame-src 'none'; connect-src 'none'; object-src 'none'; " +
    "worker-src 'none'; font-src 'none'; media-src 'none'; form-action 'none'; base-uri 'none'";

  function parseMarkerAt(text, start = 0) {
    if (!text.startsWith(MARKER_START, start)) return null;
    const end = text.indexOf(MARKER_END, start + MARKER_START.length);
    if (end < 0 || end - start > 8192) return null;
    const raw = text.slice(start, end + MARKER_END.length);
    try {
      const value = JSON.parse(text.slice(start + MARKER_START.length, end));
      if (!value || Array.isArray(value) || typeof value.path !== "string" ||
        !value.path.trim() || value.path.length > 4096 || /[\u0000-\u001f]/u.test(value.path)) return null;
      return {
        raw, length: raw.length, path: value.path,
        title: typeof value.title === "string" ? value.title.slice(0, 120) : "交互图表",
        wide: value.mode === "wide"
      };
    }
    catch (_error) { return null; }
  }

  function workspaceFile(workspace, requested) {
    const rawWorkspace = String(workspace || "");
    const windows = /^[A-Za-z]:[\\/]/u.test(rawWorkspace) || /^\\\\[^\\/]+[\\/][^\\/]+/u.test(rawWorkspace);
    const separator = windows ? "\\" : "/";
    const absolute = windows ?
      /^[A-Za-z]:[\\/]/u.test(rawWorkspace) || /^\\\\[^\\/]+[\\/][^\\/]+/u.test(rawWorkspace) :
      rawWorkspace.startsWith("/");
    if (!absolute) throw new Error("当前论文工作区无效");
    const normalize = (path) => {
      if (path.length > 4096 || /[\u0000-\u001f]/u.test(path)) throw new Error("图表路径无效");
      if (!windows && path.includes("\\")) throw new Error("图表路径无效");
      const parts = path.split(/[\\/]/u).filter((part) => part && part !== ".");
      if (parts.includes("..")) throw new Error("图表路径无效");
      return parts;
    };
    const rootParts = normalize(rawWorkspace);
    const root = windows ?
      (/^\\\\/u.test(rawWorkspace) ? "\\\\" : "") + rootParts.join(separator) :
      "/" + rootParts.join("/");
    if (root === "/" || (windows && rootParts.length < 2)) throw new Error("当前论文工作区无效");
    const raw = String(requested || "").trim();
    const requestedWindowsAbsolute = /^[A-Za-z]:[\\/]/u.test(raw) || /^\\\\/u.test(raw);
    if (!raw || (/^[A-Za-z][\w+.-]*:/u.test(raw) && !requestedWindowsAbsolute)) {
      throw new Error("图表必须是工作区内的 HTML 文件");
    }
    const requestedParts = normalize(raw);
    const candidate = raw.startsWith("/") || (windows && /^[A-Za-z]:[\\/]/u.test(raw)) ||
      (windows && /^\\\\/u.test(raw)) ?
      (windows ? (/^\\\\/u.test(raw) ? "\\\\" : "") + requestedParts.join(separator) : "/" + requestedParts.join("/")) :
      root + separator + requestedParts.join(separator);
    const rootPrefix = root + separator;
    const path = windows ? candidate.toLowerCase() : candidate;
    const prefix = windows ? rootPrefix.toLowerCase() : rootPrefix;
    if (!path.startsWith(prefix) || !/\.html?$/iu.test(candidate)) {
      throw new Error("只能预览当前论文工作区内的 HTML 文件");
    }
    return candidate;
  }

  async function readWorkspaceHTML(fileSystem, workspace, requested) {
    const path = workspaceFile(workspace, requested);
    if (typeof fileSystem?.inspectPath !== "function" || typeof fileSystem?.read !== "function") {
      throw new Error("当前环境无法安全读取图表文件");
    }
    const unc = /^\\\\/u.test(path);
    const windows = /^[A-Za-z]:[\\/]/u.test(path) || unc;
    const separator = windows ? "\\" : "/";
    const parts = windows ? path.split(/[\\/]/u).filter(Boolean) : path.slice(1).split("/");
    if (parts.length > 128) throw new Error("图表路径过深");
    const inspect = async () => {
      let item;
      // A UNC root is the complete server/share pair, not a bare server name.
      for (let i = unc ? 1 : 0; i < parts.length; i++) {
        let prefix = parts.slice(0, i + 1).join(separator);
        if (unc) prefix = "\\\\" + prefix;
        else if (!windows) prefix = "/" + prefix;
        else if (i === 0) prefix += separator; // Keep the drive root absolute.
        item = await fileSystem.inspectPath(prefix);
        if (!item || item.symlink || item.type !== (i === parts.length - 1 ? "regular" : "directory")) {
          throw new Error("图表路径包含软链接或非常规文件");
        }
      }
      if (!Number.isSafeInteger(item.size) || item.size < 1 || item.size > MAX_BYTES) {
        throw new Error("图表文件为空或超过 1 MiB 限制");
      }
      return item;
    };
    const before = await inspect();
    const bytes = await fileSystem.read(path, { maxBytes: MAX_BYTES + 1 });
    const after = await inspect();
    if (bytes.length !== before.size || bytes.length !== after.size ||
      before.lastModified !== after.lastModified || bytes.length > MAX_BYTES) {
      throw new Error("图表文件在读取时发生变化，请重试");
    }
    let html;
    try { html = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch (_error) { throw new Error("图表文件不是有效的 UTF-8 HTML"); }
    if (html.includes("\0") || !/<[a-z!]/iu.test(html)) throw new Error("图表文件不是有效的 HTML");
    return { html, name: parts.at(-1) };
  }

  function escapeAttribute(value) {
    return String(value).replace(/&/gu, "&amp;").replace(/"/gu, "&quot;").replace(/</gu, "&lt;");
  }

  function inlineScript(source) {
    // Prevent a script-body terminator in bundled/runtime strings from escaping
    // the trusted document. Model markup is escaped as a srcdoc attribute below.
    return "<script>" + source.replace(/<\/script/giu, "<\\/script") + "</script>";
  }

  function replaceBundledScripts(html) {
    return html.replace(/<script\b([^>]*)>[\s\S]*?<\/script\s*>/giu, (tag, attributes) => {
      const src = attributes.match(/\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/iu);
      if (!src) return tag;
      if ((src[1] ?? src[2] ?? src[3]) !== D3_URL) {
        throw new Error("图表引用了未内置的外部脚本；目前支持离线 D3 7.9.0");
      }
      return "";
    });
  }

  function buildDocument(html, { d3, theme, token, dark = false }) {
    if (typeof html !== "string" || html.length > MAX_BYTES || !/^[a-z0-9-]{8,80}$/iu.test(token)) {
      throw new Error("图表内容或预览标识无效");
    }
    if (!d3 || !theme) throw new Error("图表离线运行时不可用");
    const fragment = replaceBundledScripts(html);
    const head = '<!doctype html><html><head><meta charset="utf-8">' +
      '<meta http-equiv="Content-Security-Policy" content="' + escapeAttribute(CSP) + '">' +
      '<meta name="referrer" content="no-referrer">';
    const bridge = `(() => {
      const send = (type, height) => parent.postMessage({sptVisualize:${JSON.stringify(token)},type,height}, '*');
      let failed = false, pending = false;
      addEventListener('error', () => { failed = true; send('error'); }, true);
      addEventListener('unhandledrejection', () => { failed = true; send('error'); });
      addEventListener('securitypolicyviolation', () => { failed = true; send('blocked'); });
      addEventListener('keydown', event => { if (event.isTrusted && event.key === 'Escape') send('escape'); });
      addEventListener('DOMContentLoaded', () => {
        const report = () => { if (pending) return; pending = true; requestAnimationFrame(() => {
          pending = false; if (!failed) send('ready', Math.min(1600, Math.max(180, document.body.scrollHeight + 8)));
        }); };
        new ResizeObserver(report).observe(document.body); report();
      });
    })();`;
    const inner = head + '<style>' + theme.replace(/<\/style/giu, "") +
      '</style></head><body class="' + (dark ? "dark" : "light") + '">' +
      inlineScript(bridge) + inlineScript(d3) + fragment + '</body></html>';
    const relay = `(() => {
      const publish = (type, height) => {
        const status = {sptVisualize:${JSON.stringify(token)},type,height};
        document.documentElement.setAttribute(${JSON.stringify(STATUS_ATTRIBUTE)}, JSON.stringify(status));
        // Ordinary web previews use postMessage. Gecko's chrome parent may be
        // inaccessible; Zotero observes only this trusted outer status node.
        try { parent.postMessage(status, '*'); } catch (_error) {}
      };
      addEventListener('message', event => {
        const child = document.querySelector('iframe');
        if (!child || event.source !== child.contentWindow || event.data?.sptVisualize !== ${JSON.stringify(token)}) return;
        const type = event.data.type;
        if (!['ready','error','blocked','escape'].includes(type)) return;
        const height = Number.isFinite(event.data.height) ? Math.min(1600, Math.max(180, event.data.height)) : 480;
        if (type === 'ready') child.style.height = height + 'px';
        publish(type, height);
      });
      addEventListener('securitypolicyviolation', () => publish('blocked'));
    })();`;
    // Both frames are opaque origins, so the model cannot change the outer CSP
    // or relay. No callback, Zotero object, path, or privileged capability is sent.
    // Register before the child starts parsing, so synchronous script failures
    // cannot race the relay and turn into an unrelated readiness timeout.
    return head + '<style>html,body{margin:0;padding:0;background:transparent}iframe{display:block;width:100%;height:480px;border:0}</style>' +
      inlineScript(relay) + '</head><body><iframe title="图表内容" sandbox="allow-scripts" referrerpolicy="no-referrer" srcdoc="' +
      escapeAttribute(inner) + '"></iframe></body></html>';
  }

  function createRenderer({ rootURI = "", readResource } = {}) {
    // Zotero 9 getContentsAsync(jarURI) returns an XMLHttpRequest, not text.
    // getResourceAsync reads local packaged resources as UTF-8, including @ in
    // installed XPI paths, without the deprecated URI/request conversion.
    const read = readResource || ((uri) => global.Zotero.File.getResourceAsync(uri));
    let resources;
    let stopped = false;
    const active = new Set();
    const loadResources = () => {
      if (!resources) {
        if (!/^(?:file:\/\/\/|jar:file:\/\/\/|resource:\/\/|chrome:\/\/)/u.test(rootURI)) {
          return Promise.reject(new Error("图表本地资源路径无效"));
        }
        resources = Promise.all([
          read(rootURI + "content/vendor/d3/d3.min.js"),
          read(rootURI + "content/visualize-theme.css")
        ]).then(([d3, theme]) => {
          if (typeof d3 !== "string" || !d3.trim() || typeof theme !== "string" || !theme.trim()) {
            throw new Error("图表离线资源未返回有效文本，请更新插件后重试。");
          }
          return { d3, theme };
        });
        resources.catch(() => { resources = null; });
      }
      return resources;
    };

    function mount(doc, container, { reference, load, current = () => true, registerCleanup = () => {}, expanded = false, onEscape = () => {} }) {
      const win = doc.defaultView;
      const status = doc.createElement("span");
      status.className = "spt-visualize-status";
      status.setAttribute("role", "status");
      status.textContent = "正在加载图表…";
      const stage = doc.createElement("span");
      stage.className = "spt-visualize-stage";
      const retry = doc.createElement("button");
      retry.type = "button"; retry.textContent = "重试"; retry.hidden = true;
      const expand = doc.createElement("button");
      expand.type = "button"; expand.textContent = "展开查看"; expand.hidden = true;
      const toolbar = doc.createElement("span"); toolbar.className = "spt-visualize-toolbar";
      const title = doc.createElement("strong"); title.textContent = reference.title;
      toolbar.append(title, expand, retry);
      container.append(toolbar, status, stage);
      let disposed = false, generation = 0, frame, timer, listener, statusObserver, loadListener, closeOverlay;
      const valid = () => !disposed && !stopped && current();
      const removeFrame = () => {
        if (timer) win.clearTimeout(timer);
        if (listener) win.removeEventListener("message", listener);
        statusObserver?.disconnect(); statusObserver = null;
        if (loadListener) frame?.removeEventListener("load", loadListener, true);
        loadListener = null;
        frame?.remove(); frame = null; listener = null; timer = null;
      };
      const fail = (message) => {
        removeFrame();
        status.hidden = false; status.textContent = message;
        retry.hidden = false; expand.hidden = true;
      };
      const start = async () => {
        if (!valid()) return;
        const serial = ++generation;
        removeFrame(); retry.hidden = true; expand.hidden = true;
        status.hidden = false; status.textContent = "正在加载图表…";
        try {
          const [file, runtime] = await Promise.all([load(reference.path), loadResources()]);
          if (!valid() || serial !== generation) return;
          const token = win.crypto.randomUUID();
          const dark = win.matchMedia?.("(prefers-color-scheme: dark)").matches || false;
          const documentText = buildDocument(file.html, { ...runtime, token, dark });
          frame = doc.createElementNS(HTML_NS, "iframe");
          if (!("srcdoc" in frame) || !("sandbox" in frame)) throw new Error("当前 Zotero 不支持隔离图表预览");
          frame.className = "spt-visualize-frame";
          frame.setAttribute("title", reference.title);
          frame.setAttribute("sandbox", "allow-scripts");
          frame.setAttribute("referrerpolicy", "no-referrer");
          frame.setAttribute("allow", "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'");
          const receive = (data) => {
            if (!valid() || serial !== generation || data?.sptVisualize !== token) return;
            if (data.type === "ready" && Number.isFinite(data.height)) {
              win.clearTimeout(timer); timer = null;
              frame.style.height = Math.min(1600, Math.max(180, data.height)) + "px";
              status.hidden = true; expand.hidden = expanded;
            }
            else if (data.type === "error" || data.type === "blocked") {
              fail(data.type === "blocked" ? "图表尝试访问外部资源，已停止预览。" : "图表脚本运行失败，可重试或查看原标记。");
            }
            else if (data.type === "escape") onEscape();
          };
          listener = (event) => {
            if (event.source !== frame?.contentWindow) return;
            receive(event.data);
          };
          loadListener = () => {
            if (!valid() || serial !== generation || !win.MutationObserver) return;
            try {
              const outer = frame?.contentDocument;
              if (!outer || outer.documentURI !== "about:srcdoc" || !outer.documentElement) return;
              const root = outer.documentElement;
              const readStatus = () => {
                if (!valid() || serial !== generation || frame?.contentDocument !== outer) return;
                const value = root.getAttribute(STATUS_ATTRIBUTE);
                if (!value || value.length > 1024) return;
                try { receive(JSON.parse(value)); } catch (_error) {}
              };
              statusObserver?.disconnect();
              statusObserver = new win.MutationObserver(readStatus);
              statusObserver.observe(root, { attributes: true, attributeFilter: [STATUS_ATTRIBUTE] });
              // Also consume a status published before the frame's load event.
              readStatus();
            }
            catch (_error) { /* Cross-origin web hosts use the message listener. */ }
          };
          win.addEventListener("message", listener);
          // Content load events cross the XUL embedding boundary. Opt in only
          // on this owned frame; status still requires its exact document/token.
          frame.addEventListener("load", loadListener, true, true);
          timer = win.setTimeout(() => { if (valid() && serial === generation) fail("图表加载超时，请重试。"); }, 10000);
          frame.srcdoc = documentText;
          stage.append(frame);
        }
        catch (error) { if (valid() && serial === generation) fail(error.message || "无法加载图表"); }
      };
      retry.addEventListener("click", () => { if (valid()) void start(); });
      expand.addEventListener("click", () => {
        if (!valid() || closeOverlay) return;
        const overlay = doc.createElement("div"); overlay.className = "spt-visualize-overlay";
        overlay.setAttribute("role", "dialog"); overlay.setAttribute("aria-modal", "true");
        overlay.setAttribute("aria-label", reference.title);
        const panel = doc.createElement("div"); panel.className = "spt-visualize-panel";
        const close = doc.createElement("button"); close.type = "button"; close.textContent = "关闭";
        const enlarged = doc.createElement("div"); enlarged.className = "spt-visualize";
        panel.append(close, enlarged); overlay.append(panel); (doc.body || doc.documentElement).append(overlay);
        let childCleanup;
        const key = (event) => { if (event.key === "Escape") { event.preventDefault(); closeOverlay?.(); } };
        const keepFocus = (event) => { if (!panel.contains(event.target)) close.focus(); };
        closeOverlay = () => {
          childCleanup?.(); doc.removeEventListener("keydown", key, true); doc.removeEventListener("focusin", keepFocus, true); overlay.remove(); closeOverlay = null;
          if (valid()) expand.focus();
        };
        doc.addEventListener("keydown", key, true);
        doc.addEventListener("focusin", keepFocus, true);
        close.addEventListener("click", () => closeOverlay?.());
        overlay.addEventListener("click", (event) => { if (event.target === overlay) closeOverlay?.(); });
        mount(doc, enlarged, { reference, load, expanded: true, onEscape: () => closeOverlay?.(), current: () => valid() && Boolean(closeOverlay), registerCleanup: fn => { childCleanup = fn; } });
        close.focus();
      });
      const cleanup = () => {
        disposed = true; generation++; closeOverlay?.(); removeFrame(); active.delete(cleanup);
      };
      active.add(cleanup); registerCleanup(cleanup);
      void start();
      return cleanup;
    }

    return {
      mount,
      shutdown() { stopped = true; for (const cleanup of [...active]) cleanup(); resources = null; }
    };
  }

  modules.VisualizeRenderer = { MAX_BYTES, MAX_PREVIEWS, MARKER_START, CSP, D3_URL,
    parseMarkerAt, workspaceFile, readWorkspaceHTML, replaceBundledScripts, buildDocument, createRenderer };
  if (typeof module !== "undefined" && module.exports) module.exports = modules.VisualizeRenderer;
})(typeof globalThis !== "undefined" ? globalThis : this);
