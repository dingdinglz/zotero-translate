(function (global) {
  "use strict";

  const modules = global.SmartPaperTranslatorModules = global.SmartPaperTranslatorModules || {};

  const SVG_NS = "http://www.w3.org/2000/svg";
  const XHTML_NS = "http://www.w3.org/1999/xhtml";
  const XMLNS_NS = "http://www.w3.org/2000/xmlns/";
  const MERMAID_VERSION = "11.16.1";
  const MAX_MERMAID_SOURCE_LENGTH = 20000;
  const MAX_MERMAID_SVG_LENGTH = 2 * 1024 * 1024;
  const MAX_MERMAID_SVG_ELEMENTS = 6000;
  const MAX_MERMAID_IMAGE_EDGE = 4096;
  const MAX_MERMAID_CACHE_ENTRIES = 12;
  const MERMAID_RENDER_TIMEOUT_MS = 10000;

  // Mermaid 11 flowcharts emit local drop-shadow definitions even for ordinary nodes.
  // Keep only that inert primitive; resource-bearing or general-purpose filter nodes stay blocked.
  const ALLOWED_SVG_ELEMENTS = new Set([
    "svg", "style", "title", "desc", "g", "defs", "marker", "clippath", "mask",
    "pattern", "lineargradient", "radialgradient", "stop", "filter", "fedropshadow",
    "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "tspan"
  ]);
  const ALLOWED_SVG_ATTRIBUTES = new Set([
    "id", "class", "role", "viewbox", "width", "height", "x", "y", "x1", "y1",
    "x2", "y2", "cx", "cy", "r", "rx", "ry", "dx", "dy", "d", "points",
    "transform", "preserveaspectratio", "pathlength", "fill", "fill-opacity", "fill-rule",
    "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "stroke-dasharray",
    "stroke-dashoffset", "stroke-opacity", "opacity", "color", "style", "text-anchor",
    "dominant-baseline", "font-family", "font-size", "font-weight", "font-style",
    "letter-spacing", "textlength", "lengthadjust", "rotate", "marker-start", "marker-mid",
    "marker-end", "markerwidth", "markerheight", "markerunits", "refx", "refy", "orient",
    "gradientunits", "gradienttransform", "spreadmethod", "offset", "stop-color",
    "stop-opacity", "clippathunits", "maskunits", "maskcontentunits", "patternunits",
    "patterncontentunits", "patterntransform", "filter", "filterunits", "primitiveunits",
    "stddeviation", "flood-color", "flood-opacity", "vector-effect", "shape-rendering",
    "paint-order", "focusable", "tabindex"
  ]);
  const MERMAID_CONFIG = Object.freeze({
    startOnLoad: false,
    securityLevel: "strict",
    htmlLabels: false,
    suppressErrorRendering: true,
    maxTextSize: MAX_MERMAID_SOURCE_LENGTH,
    maxEdges: 200,
    logLevel: "fatal",
    deterministicIds: true,
    flowchart: Object.freeze({ useMaxWidth: true }),
    secure: Object.freeze([
      "secure", "securityLevel", "startOnLoad", "maxTextSize", "maxEdges",
      "suppressErrorRendering", "htmlLabels", "theme", "themeVariables", "themeCSS",
      "fontFamily", "altFontFamily", "flowchart", "sequence", "gantt", "class",
      "state", "er", "journey", "timeline", "mindmap", "architecture", "kanban",
      "packet", "xyChart", "pie", "quadrantChart", "requirement"
    ])
  });

  function isMermaidLanguage(language) {
    const token = String(language || "").trim().split(/\s+/u)[0].toLowerCase();
    return token === "mermaid";
  }

  function normalizeMermaidSource(source) {
    const value = String(source || "").trim();
    if (!value) throw new Error("Mermaid 图表内容为空");
    if (value.includes("\u0000")) throw new Error("Mermaid 图表包含无效字符");
    if (value.length > MAX_MERMAID_SOURCE_LENGTH) {
      throw new Error(`Mermaid 图表超过 ${MAX_MERMAID_SOURCE_LENGTH} 个字符`);
    }
    return value;
  }

  function hasUnsafeResourceReference(value) {
    const text = String(value || "");
    if (
      /(?:@import|@font-face|javascript\s*:|data\s*:|https?\s*:|file\s*:|resource\s*:|chrome\s*:|moz-extension\s*:|-moz-binding|\bbehavior\s*:|\bexpression\s*\()/iu.test(text)
    ) {
      return true;
    }
    const pattern = /url\s*\(([^)]*)\)/giu;
    let match;
    while ((match = pattern.exec(text))) {
      const target = match[1].trim().replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/u, "$1$2");
      if (!/^#[A-Za-z_][\w:.-]*$/u.test(target)) return true;
    }
    return false;
  }

  function isSafeSVGTree(svg) {
    if (!svg || svg.namespaceURI !== SVG_NS || String(svg.localName || "").toLowerCase() !== "svg") {
      return false;
    }
    const elements = [svg, ...Array.from(svg.getElementsByTagName?.("*") || [])];
    if (elements.length > MAX_MERMAID_SVG_ELEMENTS) return false;
    for (const element of elements) {
      if (element.namespaceURI !== SVG_NS) return false;
      const localName = String(element.localName || "").toLowerCase();
      if (!ALLOWED_SVG_ELEMENTS.has(localName)) return false;
      if (localName === "style" && hasUnsafeResourceReference(element.textContent)) return false;
      for (const attribute of Array.from(element.attributes || [])) {
        const name = String(attribute.name || attribute.localName || "").toLowerCase();
        const local = String(attribute.localName || attribute.name || "").toLowerCase();
        if (attribute.namespaceURI === XMLNS_NS) {
          if (name !== "xmlns" && name !== "xmlns:xlink") return false;
          continue;
        }
        if (attribute.namespaceURI) return false;
        if (
          local.startsWith("on") ||
          ["href", "src", "srcset", "formaction"].includes(local) ||
          (!ALLOWED_SVG_ATTRIBUTES.has(local) && !/^aria-[\w-]+$/u.test(local) && !/^data-[\w:-]+$/u.test(local))
        ) {
          return false;
        }
        const value = String(attribute.value ?? "");
        if (value.length > MAX_MERMAID_SOURCE_LENGTH || hasUnsafeResourceReference(value)) {
          return false;
        }
      }
    }
    return true;
  }

  function parseViewBox(svg) {
    const values = String(svg?.getAttribute?.("viewBox") || "")
      .trim()
      .split(/[\s,]+/u)
      .map(Number);
    if (values.length !== 4 || values.some((value) => !Number.isFinite(value))) return null;
    const width = Math.abs(values[2]);
    const height = Math.abs(values[3]);
    if (!(width > 0) || !(height > 0) || width > 100000 || height > 100000) return null;
    return { width, height };
  }

  function serializeMermaidSVG(doc, markup) {
    const source = String(markup || "");
    if (!source || source.length > MAX_MERMAID_SVG_LENGTH) {
      throw new Error("Mermaid SVG 输出为空或超过安全上限");
    }
    const DOMParserClass = doc?.defaultView?.DOMParser || global.DOMParser;
    const XMLSerializerClass = doc?.defaultView?.XMLSerializer || global.XMLSerializer;
    if (typeof DOMParserClass !== "function" || typeof XMLSerializerClass !== "function") {
      throw new Error("当前 Zotero 窗口无法解析 Mermaid SVG");
    }
    const parsed = new DOMParserClass().parseFromString(source, "image/svg+xml");
    if (parsed.getElementsByTagName?.("parsererror")?.length) {
      throw new Error("Mermaid SVG 解析失败");
    }
    const svg = parsed.documentElement;
    if (!isSafeSVGTree(svg)) throw new Error("Mermaid SVG 包含不安全内容");
    const viewBox = parseViewBox(svg);
    if (viewBox) {
      // Mermaid's width="100%" has no intrinsic image size: Gecko falls back to
      // 300px and makes wide flowcharts illegible. Keep a bounded native size;
      // the sidebar can scroll horizontally without shrinking every label.
      const scale = Math.min(
        1,
        MAX_MERMAID_IMAGE_EDGE / viewBox.width,
        MAX_MERMAID_IMAGE_EDGE / viewBox.height
      );
      svg.setAttribute("width", String(Math.max(1, Math.round(viewBox.width * scale))));
      svg.setAttribute("height", String(Math.max(1, Math.round(viewBox.height * scale))));
    }
    const serialized = new XMLSerializerClass().serializeToString(svg);
    if (!serialized || serialized.length > MAX_MERMAID_SVG_LENGTH) {
      throw new Error("Mermaid SVG 序列化输出超过安全上限");
    }
    const title = Array.from(svg.getElementsByTagName?.("title") || [])
      .map((node) => String(node.textContent || "").trim())
      .find(Boolean);
    return Object.freeze({
      dataURI: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(serialized)}`,
      width: viewBox?.width || null,
      height: viewBox?.height || null,
      title: title?.slice(0, 240) || ""
    });
  }

  function isLocalRuntimeURI(uri) {
    return /^(?:chrome|file|resource):/iu.test(String(uri || "")) ||
      /^jar:file:/iu.test(String(uri || ""));
  }

  function defaultCreateSandbox(win, doc) {
    if (typeof global.Cu?.Sandbox !== "function") {
      throw new Error("Mermaid 隔离运行环境不可用");
    }
    const sandbox = global.Cu.Sandbox(win, {
      sandboxPrototype: win,
      wantXrays: false
    });
    // window/self/document are getter-only properties inherited from the HTML
    // window prototype in Zotero 9.0.6. Reassigning them throws before Mermaid
    // can load; the inherited bindings already point at this isolated document.
    if (sandbox.document !== doc || sandbox.window !== win || sandbox.self !== win) {
      throw new Error("Mermaid 隔离运行环境绑定失败");
    }
    return sandbox;
  }

  function defaultLoadSubScript(uri, target) {
    const loader = global.Services?.scriptloader?.loadSubScript;
    if (typeof loader !== "function") throw new Error("Mermaid 运行时加载器不可用");
    loader.call(global.Services.scriptloader, uri, target);
  }

  function createMermaidRenderer({
    runtimeURI,
    createSandbox = defaultCreateSandbox,
    loadSubScript = defaultLoadSubScript,
    serializeSVG = serializeMermaidSVG,
    timeoutMs = MERMAID_RENDER_TIMEOUT_MS
  } = {}) {
    const states = new Map();

    function stateFor(doc) {
      const win = doc?.defaultView;
      const mount = doc?.body || doc?.documentElement;
      if (
        !win || !mount || typeof mount.append !== "function" ||
        typeof doc.createElement !== "function" || typeof doc.createElementNS !== "function"
      ) {
        throw new Error("当前 Zotero 文档无法渲染 Mermaid");
      }
      let state = states.get(win);
      if (!state) {
        state = {
          hostDoc: doc,
          hostWin: win,
          hostMount: mount,
          frame: null,
          renderDoc: null,
          renderWin: null,
          sandbox: null,
          contextPromise: null,
          runtimePromise: null,
          queue: Promise.resolve(),
          cache: new Map(),
          nextID: 1
        };
        states.set(win, state);
      }
      return state;
    }

    function ensureRenderContext(state) {
      if (state.contextPromise) return state.contextPromise;
      state.contextPromise = Promise.resolve().then(() => {
        // Flowchart-v3 selects from its global HTML body. Zotero's Item Pane lives
        // in a bodyless XUL document, so retain one inert about:blank HTML document
        // and bind the trusted bundled runtime to it through a dedicated sandbox.
        const frame = state.hostDoc.createElementNS(XHTML_NS, "iframe");
        frame.setAttribute("aria-hidden", "true");
        frame.setAttribute("tabindex", "-1");
        frame.setAttribute(
          "style",
          "position:fixed;left:-100000px;top:0;width:1600px;height:1200px;opacity:0;pointer-events:none;border:0;"
        );
        state.hostMount.append(frame);
        const renderDoc = frame.contentDocument;
        const renderWin = frame.contentWindow || renderDoc?.defaultView;
        if (
          !renderWin || !renderDoc?.body ||
          typeof renderDoc.createElement !== "function"
        ) {
          frame.remove();
          throw new Error("当前 Zotero 窗口无法创建 Mermaid 隔离文档");
        }
        state.frame = frame;
        state.renderDoc = renderDoc;
        state.renderWin = renderWin;
        return state;
      });
      state.contextPromise.catch(() => { state.contextPromise = null; });
      return state.contextPromise;
    }

    async function loadRuntime(state) {
      if (state.runtimePromise) return state.runtimePromise;
      state.runtimePromise = ensureRenderContext(state).then(() => {
        if (!isLocalRuntimeURI(runtimeURI)) {
          throw new Error("Mermaid 本地运行时路径未配置或不安全");
        }
        const sandbox = createSandbox(state.renderWin, state.renderDoc);
        if (!sandbox || sandbox.document !== state.renderDoc || sandbox.window !== state.renderWin) {
          throw new Error("Mermaid 隔离运行环境绑定失败");
        }
        state.sandbox = sandbox;
        loadSubScript(runtimeURI, sandbox);
        const runtime = sandbox.mermaid;
        if (typeof runtime?.initialize !== "function" || typeof runtime?.render !== "function") {
          throw new Error("Mermaid 运行时接口不完整");
        }
        runtime.initialize({
          ...MERMAID_CONFIG,
          flowchart: { ...MERMAID_CONFIG.flowchart },
          secure: [...MERMAID_CONFIG.secure]
        });
        return runtime;
      });
      state.runtimePromise.catch(() => { state.runtimePromise = null; });
      return state.runtimePromise;
    }

    function withTimeout(win, promise) {
      const duration = Number(timeoutMs);
      if (!(duration > 0)) return promise;
      const schedule = typeof win.setTimeout === "function" ? win.setTimeout.bind(win) : setTimeout;
      const cancel = typeof win.clearTimeout === "function" ? win.clearTimeout.bind(win) : clearTimeout;
      let timer;
      return Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = schedule(() => reject(new Error("Mermaid 渲染超时")), duration);
        })
      ]).finally(() => cancel(timer));
    }

    async function renderUncached(state, source) {
      const runtime = await loadRuntime(state);
      const doc = state.renderDoc;
      const win = state.renderWin;
      const id = `sptMermaid${state.nextID++}`;
      const staging = doc.createElement("div");
      staging.setAttribute("aria-hidden", "true");
      staging.setAttribute(
        "style",
        "position:fixed;left:-100000px;top:0;width:1600px;min-height:1200px;opacity:0;pointer-events:none;overflow:hidden;"
      );
      doc.body.append(staging);
      try {
        const result = await withTimeout(win, Promise.resolve(runtime.render(id, source, staging)));
        return serializeSVG(doc, result?.svg);
      }
      finally {
        staging.remove();
      }
    }

    function render(doc, source) {
      const normalized = normalizeMermaidSource(source);
      const state = stateFor(doc);
      if (state.cache.has(normalized)) {
        const cached = state.cache.get(normalized);
        state.cache.delete(normalized);
        state.cache.set(normalized, cached);
        return cached;
      }
      const task = state.queue.catch(() => {}).then(() => renderUncached(state, normalized));
      state.queue = task.then(() => undefined, () => undefined);
      state.cache.set(normalized, task);
      while (state.cache.size > MAX_MERMAID_CACHE_ENTRIES) {
        state.cache.delete(state.cache.keys().next().value);
      }
      // Keep deterministic failures cached as well so a streaming transcript rerender
      // cannot repeatedly parse the same invalid diagram.
      task.catch(() => {});
      return task;
    }

    function shutdown() {
      for (const state of states.values()) {
        state.cache.clear();
        try { state.frame?.remove(); }
        catch (_error) {}
        state.frame = null;
        state.renderDoc = null;
        state.renderWin = null;
        // Dropping the dedicated sandbox reference is sufficient here; Zotero
        // 9.0.6 must not be asked to explicitly destroy this sandbox.
        state.sandbox = null;
      }
      states.clear();
    }

    return Object.freeze({ render, shutdown });
  }

  modules.MermaidRenderer = {
    SVG_NS,
    XMLNS_NS,
    MERMAID_VERSION,
    MERMAID_CONFIG,
    MAX_MERMAID_SOURCE_LENGTH,
    MAX_MERMAID_SVG_LENGTH,
    MAX_MERMAID_SVG_ELEMENTS,
    MAX_MERMAID_IMAGE_EDGE,
    MERMAID_RENDER_TIMEOUT_MS,
    isMermaidLanguage,
    normalizeMermaidSource,
    isLocalRuntimeURI,
    hasUnsafeResourceReference,
    isSafeSVGTree,
    serializeMermaidSVG,
    createMermaidRenderer
  };
  if (typeof module !== "undefined" && module.exports) module.exports = modules.MermaidRenderer;
})(typeof globalThis !== "undefined" ? globalThis : this);
