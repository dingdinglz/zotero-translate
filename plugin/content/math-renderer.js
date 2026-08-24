(function (global) {
  "use strict";

  const modules = global.SmartPaperTranslatorModules = global.SmartPaperTranslatorModules || {};
  const KaTeX = modules.KaTeX || global.katex || (
    typeof require === "function" ? require("./vendor/katex/katex.min.js") : null
  );

  const MATHML_NS = "http://www.w3.org/1998/Math/MathML";
  const XMLNS_NS = "http://www.w3.org/2000/xmlns/";
  const MAX_TEX_SOURCE_LENGTH = 32000;
  const KATEX_VERSION = String(KaTeX?.version || "");

  function normalizeTexSource(source) {
    const value = String(source || "").trim();
    if (value.length > MAX_TEX_SOURCE_LENGTH) {
      throw new Error(`公式内容超过 ${MAX_TEX_SOURCE_LENGTH} 个字符`);
    }
    return value;
  }

  function renderTexToMathML(source, displayMode = false) {
    if (typeof KaTeX?.renderToString !== "function") {
      throw new Error("KaTeX 渲染器不可用");
    }
    return KaTeX.renderToString(normalizeTexSource(source), {
      displayMode: Boolean(displayMode),
      output: "mathml",
      throwOnError: true,
      strict: "ignore",
      trust: false,
      maxExpand: 1000,
      maxSize: 20,
      macros: {},
      globalGroup: false
    });
  }

  function isSafeMathMLTree(math) {
    if (!math || math.namespaceURI !== MATHML_NS) return false;
    const elements = [math, ...Array.from(math.getElementsByTagName?.("*") || [])];
    for (const element of elements) {
      if (element.namespaceURI !== MATHML_NS) return false;
      const localName = String(element.localName || "").toLowerCase();
      if (localName === "annotation-xml" || localName === "maction") return false;
      for (const attribute of Array.from(element.attributes || [])) {
        const name = String(attribute.localName || attribute.name || "").toLowerCase();
        if (attribute.namespaceURI && attribute.namespaceURI !== XMLNS_NS) return false;
        if (
          name.startsWith("on") ||
          ["href", "src", "style", "class", "id", "actiontype", "formaction"].includes(name)
        ) {
          return false;
        }
      }
    }
    return true;
  }

  function importRenderedMathML(doc, markup) {
    const DOMParserClass = doc?.defaultView?.DOMParser || global.DOMParser;
    if (typeof DOMParserClass !== "function" || typeof doc?.importNode !== "function") {
      return null;
    }
    const parsed = new DOMParserClass().parseFromString(String(markup || ""), "application/xml");
    if (parsed.getElementsByTagName?.("parsererror")?.length) return null;
    const math = parsed.getElementsByTagNameNS?.(MATHML_NS, "math")?.[0] || null;
    if (!isSafeMathMLTree(math)) return null;
    return doc.importNode(math, true);
  }

  function createMathElement(doc, name, text = null) {
    const element = typeof doc.createElementNS === "function"
      ? doc.createElementNS(MATHML_NS, name)
      : doc.createElement(name);
    if (text !== null) element.textContent = text;
    return element;
  }

  function decorateMath(math, source, displayMode, fallback = false) {
    math.setAttribute(
      "class",
      `spt-codex-math${displayMode ? " spt-codex-math-block" : ""}${fallback ? " spt-codex-math-fallback" : ""}`
    );
    math.setAttribute("display", displayMode ? "block" : "inline");
    math.setAttribute("aria-label", String(source || ""));
    if (fallback) {
      math.setAttribute("title", "公式语法无法完整解析，已保留原始 TeX");
      math.setAttribute("data-math-renderer", "fallback");
    }
    else {
      math.setAttribute("data-math-renderer", `katex-${KATEX_VERSION}`);
    }
    return math;
  }

  function appendMath(doc, parent, source, displayMode = false) {
    try {
      const markup = renderTexToMathML(source, displayMode);
      const math = importRenderedMathML(doc, markup);
      if (!math) throw new Error("无法安全导入 MathML");
      parent.append(decorateMath(math, source, displayMode));
      return true;
    }
    catch (_error) {
      const math = decorateMath(createMathElement(doc, "math"), source, displayMode, true);
      math.append(createMathElement(doc, "mtext", String(source || "")));
      parent.append(math);
      return false;
    }
  }

  modules.MathRenderer = {
    MATHML_NS,
    MAX_TEX_SOURCE_LENGTH,
    KATEX_VERSION,
    renderTexToMathML,
    importRenderedMathML,
    appendMath
  };
  if (typeof module !== "undefined" && module.exports) module.exports = modules.MathRenderer;
})(typeof globalThis !== "undefined" ? globalThis : this);
