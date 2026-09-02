"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  SVG_NS,
  XMLNS_NS,
  MERMAID_VERSION,
  MERMAID_CONFIG,
  MAX_MERMAID_SOURCE_LENGTH,
  MAX_MERMAID_IMAGE_EDGE,
  isMermaidLanguage,
  normalizeMermaidSource,
  isLocalRuntimeURI,
  hasUnsafeResourceReference,
  isSafeSVGTree,
  serializeMermaidSVG,
  createMermaidRenderer
} = require("../plugin/content/mermaid-renderer.js");

function attribute(name, value, namespaceURI = null, localName = name) {
  return { name, localName, value, namespaceURI };
}

class SVGElementMock {
  constructor(localName, { attributes = [], textContent = "", descendants = [] } = {}) {
    this.localName = localName;
    this.namespaceURI = SVG_NS;
    this.attributes = attributes;
    this.textContent = textContent;
    this.descendants = descendants;
  }
  getElementsByTagName(name) {
    if (name === "*") return this.descendants;
    return this.descendants.filter((element) => element.localName === name);
  }
  getAttribute(name) {
    return this.attributes.find((entry) => entry.name === name)?.value ?? null;
  }
  setAttribute(name, value) {
    const existing = this.attributes.find((entry) => entry.name === name);
    if (existing) existing.value = String(value);
    else this.attributes.push(attribute(name, String(value)));
  }
}

function safeSVGTree() {
  const title = new SVGElementMock("title", { textContent: "一天 CGM 特征学习" });
  const style = new SVGElementMock("style", {
    textContent: "#sptMermaid1 .edge{stroke:#333}#sptMermaid1 .arrow{fill:url(#arrow)}"
  });
  const marker = new SVGElementMock("marker", {
    attributes: [attribute("id", "arrow"), attribute("orient", "auto")]
  });
  const dropShadow = new SVGElementMock("feDropShadow", {
    attributes: [
      attribute("dx", "4"),
      attribute("dy", "4"),
      attribute("stdDeviation", "0", null, "stdDeviation"),
      attribute("flood-opacity", "0.06"),
      attribute("flood-color", "#000000")
    ]
  });
  const filter = new SVGElementMock("filter", {
    attributes: [
      attribute("id", "sptMermaid1-drop-shadow"),
      attribute("height", "130%"),
      attribute("width", "130%")
    ],
    descendants: [dropShadow]
  });
  const defs = new SVGElementMock("defs", { descendants: [marker, filter, dropShadow] });
  const path = new SVGElementMock("path", {
    attributes: [
      attribute("d", "M0 0 L20 20"),
      attribute("marker-end", "url(#arrow)"),
      attribute("filter", "url(#sptMermaid1-drop-shadow)"),
      attribute("class", "edge")
    ]
  });
  const text = new SVGElementMock("text", {
    attributes: [attribute("text-anchor", "middle")]
  });
  const group = new SVGElementMock("g", { descendants: [path, text] });
  return new SVGElementMock("svg", {
    attributes: [
      attribute("xmlns", SVG_NS, XMLNS_NS, "xmlns"),
      attribute("viewBox", "0 0 640 320", null, "viewBox"),
      attribute("aria-roledescription", "flowchart-v2")
    ],
    descendants: [title, style, defs, marker, filter, dropShadow, group, path, text]
  });
}

test("Mermaid fences and source bounds are explicit", () => {
  assert.equal(MERMAID_VERSION, "11.16.1");
  assert.equal(isMermaidLanguage("mermaid"), true);
  assert.equal(isMermaidLanguage(" Mermaid diagram"), true);
  assert.equal(isMermaidLanguage("javascript"), false);
  assert.equal(normalizeMermaidSource("\nflowchart LR\n A --> B\n"), "flowchart LR\n A --> B");
  assert.throws(() => normalizeMermaidSource(""), /为空/u);
  assert.throws(() => normalizeMermaidSource("x".repeat(MAX_MERMAID_SOURCE_LENGTH + 1)), /超过/u);
  assert.throws(() => normalizeMermaidSource("flowchart LR\u0000A"), /无效字符/u);
});

test("Mermaid configuration keeps untrusted diagrams inert and bounded", () => {
  assert.equal(MERMAID_CONFIG.securityLevel, "strict");
  assert.equal(MERMAID_CONFIG.startOnLoad, false);
  assert.equal(MERMAID_CONFIG.htmlLabels, false);
  assert.equal(MERMAID_CONFIG.suppressErrorRendering, true);
  assert.equal(MERMAID_CONFIG.maxTextSize, MAX_MERMAID_SOURCE_LENGTH);
  assert.equal(MERMAID_CONFIG.maxEdges, 200);
  for (const protectedSetting of [
    "securityLevel", "maxTextSize", "maxEdges", "htmlLabels", "themeCSS", "flowchart"
  ]) {
    assert.ok(MERMAID_CONFIG.secure.includes(protectedSetting));
  }
});

test("only local fragment references are accepted in generated SVG", () => {
  assert.equal(hasUnsafeResourceReference("fill:url(#arrow)"), false);
  assert.equal(hasUnsafeResourceReference("stroke: #333"), false);
  for (const value of [
    "fill:url(https://tracker.invalid/a.svg)",
    "background: url(data:image/png;base64,AA)",
    "@import 'https://tracker.invalid/style.css'",
    "-moz-binding:url(#payload)",
    "behavior: url(#payload)",
    "width: expression(alert(1))"
  ]) {
    assert.equal(hasUnsafeResourceReference(value), true, value);
  }
});

test("Mermaid runtime accepts only fixed local script schemes", () => {
  for (const uri of [
    "resource://smart-paper-translator/mermaid.min.js",
    "chrome://smart-paper-translator/content/mermaid.min.js",
    "file:///tmp/mermaid.min.js",
    "jar:file:///tmp/plugin.xpi!/content/vendor/mermaid/mermaid.min.js"
  ]) {
    assert.equal(isLocalRuntimeURI(uri), true, uri);
  }
  for (const uri of [
    "", "about:blank", "https://cdn.invalid/mermaid.min.js",
    "data:text/javascript,unsafe", "javascript:alert(1)", "jar:https://cdn.invalid/plugin.xpi!/mermaid.min.js"
  ]) {
    assert.equal(isLocalRuntimeURI(uri), false, uri);
  }
});

test("SVG safety validation accepts inert Mermaid output and rejects active content", () => {
  assert.equal(isSafeSVGTree(safeSVGTree()), true);

  for (const dangerous of [
    new SVGElementMock("script"),
    new SVGElementMock("foreignObject"),
    new SVGElementMock("image", { attributes: [attribute("href", "https://tracker.invalid/x")] }),
    new SVGElementMock("feImage", { attributes: [attribute("href", "https://tracker.invalid/x")] }),
    new SVGElementMock("feGaussianBlur", { attributes: [attribute("stdDeviation", "20")] }),
    new SVGElementMock("a", { attributes: [attribute("href", "https://tracker.invalid/")] }),
    new SVGElementMock("path", { attributes: [attribute("onclick", "alert(1)")] }),
    new SVGElementMock("path", { attributes: [attribute("filter", "url(https://tracker.invalid/f.svg)")] }),
    new SVGElementMock("style", { textContent: "@import url(https://tracker.invalid/x.css)" })
  ]) {
    const svg = safeSVGTree();
    svg.descendants.push(dangerous);
    assert.equal(isSafeSVGTree(svg), false, dangerous.localName);
  }
});

test("safe SVG is serialized only as an isolated data image", () => {
  const svg = safeSVGTree();
  class DOMParserMock {
    parseFromString() {
      return {
        documentElement: svg,
        getElementsByTagName: () => []
      };
    }
  }
  class XMLSerializerMock {
    serializeToString() {
      return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 320"><title>一天 CGM 特征学习</title></svg>';
    }
  }
  const result = serializeMermaidSVG({
    defaultView: { DOMParser: DOMParserMock, XMLSerializer: XMLSerializerMock }
  }, "<ignored/>");
  assert.match(result.dataURI, /^data:image\/svg\+xml;charset=UTF-8,/u);
  assert.equal(result.width, 640);
  assert.equal(result.height, 320);
  assert.equal(result.title, "一天 CGM 特征学习");
  assert.doesNotMatch(result.dataURI, /https%3A/iu);
  assert.equal(svg.getAttribute("width"), "640", "SVG image must have an explicit intrinsic width");
  assert.equal(svg.getAttribute("height"), "320", "SVG image must have an explicit intrinsic height");

  svg.setAttribute("viewBox", "0 0 20000 10000");
  serializeMermaidSVG({
    defaultView: { DOMParser: DOMParserMock, XMLSerializer: XMLSerializerMock }
  }, "<ignored/>");
  assert.equal(Number(svg.getAttribute("width")), MAX_MERMAID_IMAGE_EDGE);
  assert.equal(Number(svg.getAttribute("height")), MAX_MERMAID_IMAGE_EDGE / 2);
});

function makeRuntimeDocument({ bodyless = false } = {}) {
  const makeMount = () => ({
    children: [],
    append(node) {
      node.parentNode = this;
      this.children.push(node);
    }
  });
  const makeNode = () => ({
    attributes: new Map(),
    setAttribute(name, value) { this.attributes.set(name, String(value)); },
    remove() {
      if (!this.parentNode) return;
      this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
      this.parentNode = null;
    }
  });
  const hostMount = makeMount();
  const renderMount = makeMount();
  const renderWin = {
    setTimeout,
    clearTimeout
  };
  const renderDoc = {
    body: renderMount,
    documentElement: renderMount,
    defaultView: renderWin,
    createElement: makeNode
  };
  renderWin.document = renderDoc;
  const hostWin = { setTimeout, clearTimeout };
  const doc = {
    body: bodyless ? null : hostMount,
    documentElement: hostMount,
    defaultView: hostWin,
    renderDocument: renderDoc,
    renderWindow: renderWin,
    createElement: makeNode,
    createElementNS(namespaceURI, localName) {
      assert.equal(namespaceURI, "http://www.w3.org/1999/xhtml");
      assert.equal(localName, "iframe");
      return {
        ...makeNode(),
        namespaceURI,
        localName,
        contentDocument: renderDoc,
        contentWindow: renderWin
      };
    }
  };
  return doc;
}

test("renderer binds one sandbox to a local HTML realm, serializes calls, and caches output", async () => {
  const calls = { sandbox: 0, load: 0, initialize: [], render: [], serialize: [] };
  let active = 0;
  const runtime = {
    initialize(config) { calls.initialize.push(config); },
    async render(id, source, staging) {
      assert.equal(active, 0, "Mermaid renders must be serialized per window");
      active++;
      await Promise.resolve();
      calls.render.push({ id, source, staging });
      active--;
      return { svg: `<svg data-source="${source}"/>` };
    }
  };
  const doc = makeRuntimeDocument();
  let sandbox;
  const renderer = createMermaidRenderer({
    runtimeURI: "resource://smart-paper-translator/mermaid.min.js",
    createSandbox(win, renderDoc) {
      calls.sandbox++;
      sandbox = { window: win, self: win, document: renderDoc };
      return sandbox;
    },
    loadSubScript(uri, target) {
      calls.load++;
      assert.equal(uri, "resource://smart-paper-translator/mermaid.min.js");
      assert.equal(target, sandbox);
      target.mermaid = runtime;
    },
    serializeSVG(renderDoc, svg) {
      assert.equal(renderDoc, doc.renderDocument);
      calls.serialize.push(svg);
      return { dataURI: `data:image/svg+xml,${encodeURIComponent(svg)}`, width: 300, height: 100 };
    }
  });

  const source = "flowchart LR\n A --> B";
  const first = renderer.render(doc, source);
  const repeated = renderer.render(doc, source);
  assert.equal(first, repeated, "an in-flight render should be shared");
  const firstResult = await first;
  assert.match(firstResult.dataURI, /^data:image\/svg\+xml,/u);
  assert.equal(calls.sandbox, 1);
  assert.equal(calls.load, 1);
  assert.equal(calls.initialize.length, 1);
  assert.equal(calls.render.length, 1);
  assert.equal(calls.serialize.length, 1);
  assert.equal(calls.initialize[0].securityLevel, "strict");
  assert.equal(sandbox.document, doc.renderDocument);
  assert.equal(sandbox.window, doc.renderWindow);
  assert.equal(sandbox.mermaid, runtime, "runtime must remain inside its dedicated sandbox");
  assert.equal(doc.renderWindow.mermaid, undefined, "HTML window global must stay untouched");
  assert.equal(doc.defaultView.mermaid, undefined, "XUL host global must stay untouched");
  assert.equal(doc.body.children.length, 1, "one isolated HTML frame should be retained");
  assert.equal(doc.body.children[0].attributes.has("src"), false, "about:blank frame must not navigate");
  assert.equal(doc.renderDocument.body.children.length, 0, "off-screen staging DOM must be removed");

  await renderer.render(doc, "sequenceDiagram\n A->>B: hello");
  assert.equal(calls.sandbox, 1);
  assert.equal(calls.load, 1);
  assert.equal(calls.initialize.length, 1);
  assert.equal(calls.render.length, 2);
  assert.notEqual(calls.render[0].id, calls.render[1].id);
  assert.equal(doc.body.children.length, 1, "the same frame should be reused");
  assert.equal(doc.renderDocument.body.children.length, 0);
  renderer.shutdown();
  assert.equal(doc.body.children.length, 0, "shutdown must remove the isolated frame");
});

test("renderer supports Zotero's bodyless XUL Item Pane document", async () => {
  const runtime = {
    initialize() {},
    async render() {
      return { svg: "<svg/>" };
    }
  };
  const doc = makeRuntimeDocument({ bodyless: true });
  const renderer = createMermaidRenderer({
    runtimeURI: "resource://smart-paper-translator/mermaid.min.js",
    createSandbox(win, renderDoc) {
      return { window: win, self: win, document: renderDoc };
    },
    loadSubScript(_uri, sandbox) {
      sandbox.mermaid = runtime;
    },
    serializeSVG() {
      return { dataURI: "data:image/svg+xml,%3Csvg%2F%3E", width: 100, height: 50 };
    }
  });

  const result = await renderer.render(doc, "flowchart LR\n A --> B");
  assert.match(result.dataURI, /^data:image\/svg\+xml,/u);
  assert.equal(doc.documentElement.children.length, 1, "XUL document should host only the isolated frame");
  assert.equal(doc.renderDocument.body.children.length, 0, "HTML staging DOM must be removed");
  renderer.shutdown();
  assert.equal(doc.documentElement.children.length, 0, "shutdown must remove the XUL-hosted frame");
});

test("default Gecko sandbox preserves inherited getter-only window bindings", async () => {
  const previousCu = global.Cu;
  const previousServices = global.Services;
  const doc = makeRuntimeDocument({ bodyless: true });
  const renderWin = doc.renderWindow;
  Object.defineProperties(renderWin, {
    window: { configurable: true, get: () => renderWin },
    self: { configurable: true, get: () => renderWin },
    document: { configurable: true, get: () => doc.renderDocument }
  });
  const runtime = {
    initialize() {},
    async render() { return { svg: "<svg/>" }; }
  };
  try {
    global.Cu = {
      Sandbox(principal, options) {
        assert.equal(principal, renderWin);
        assert.equal(options.sandboxPrototype, renderWin);
        assert.equal(options.wantXrays, false);
        return Object.create(principal);
      }
    };
    global.Services = {
      scriptloader: {
        loadSubScript(uri, sandbox) {
          assert.equal(uri, "resource://smart-paper-translator/mermaid.min.js");
          sandbox.mermaid = runtime;
        }
      }
    };
    const renderer = createMermaidRenderer({
      runtimeURI: "resource://smart-paper-translator/mermaid.min.js",
      serializeSVG() {
        return { dataURI: "data:image/svg+xml,%3Csvg%2F%3E", width: 100, height: 50 };
      }
    });
    const result = await renderer.render(doc, "flowchart LR\n A --> B");
    assert.match(result.dataURI, /^data:image\/svg\+xml,/u);
    renderer.shutdown();
  }
  finally {
    if (previousCu === undefined) delete global.Cu;
    else global.Cu = previousCu;
    if (previousServices === undefined) delete global.Services;
    else global.Services = previousServices;
  }
});

test("renderer fails closed when the sandbox has no Mermaid runtime", async () => {
  const doc = makeRuntimeDocument();
  const renderer = createMermaidRenderer({
    runtimeURI: "resource://smart-paper-translator/mermaid.min.js",
    createSandbox(win, renderDoc) {
      return { window: win, self: win, document: renderDoc };
    },
    loadSubScript() {}
  });
  await assert.rejects(
    renderer.render(doc, "flowchart LR\n A --> B"),
    /接口不完整/u
  );
  assert.equal(doc.body.children.length, 1, "failed source remains isolated from the host document");
  renderer.shutdown();
  assert.equal(doc.body.children.length, 0, "shutdown must remove a failed runtime frame");
});
