"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  MATHML_NS,
  MAX_TEX_SOURCE_LENGTH,
  KATEX_VERSION,
  renderTexToMathML,
  importRenderedMathML,
  appendMath
} = require("../plugin/content/math-renderer.js");

function visibleMath(markup) {
  const mathStart = markup.indexOf("<math");
  const annotationStart = markup.indexOf("<annotation", mathStart);
  return markup.slice(mathStart, annotationStart === -1 ? undefined : annotationStart);
}

class ElementMock {
  constructor(localName, { namespaceURI = MATHML_NS, attributes = [], descendants = [] } = {}) {
    this.localName = localName;
    this.namespaceURI = namespaceURI;
    this.attributes = attributes;
    this.descendants = descendants;
    this.children = [];
    this.values = new Map();
    this.textContent = "";
  }
  getElementsByTagName() { return this.descendants; }
  setAttribute(name, value) { this.values.set(name, String(value)); }
  getAttribute(name) { return this.values.get(name) ?? null; }
  append(...children) { this.children.push(...children); }
}

function parserFor(math, { parserError = false } = {}) {
  return class {
    parseFromString() {
      return {
        getElementsByTagName(name) {
          return name === "parsererror" && parserError ? [{}] : [];
        },
        getElementsByTagNameNS(namespace, name) {
          return namespace === MATHML_NS && name === "math" ? [math] : [];
        }
      };
    }
  };
}

test("KaTeX renders the reported academic formulas to semantic MathML", () => {
  assert.equal(KATEX_VERSION, "0.18.4");

  const setDifference = visibleMath(renderTexToMathML(String.raw`Q = M \setminus R`, true));
  assert.match(setDifference, /<mo>∖<\/mo>/u);
  assert.doesNotMatch(setDifference, /\\setminus/u);

  const braces = visibleMath(renderTexToMathML(
    String.raw`\underbrace{固定数量、物理删除获得效率}_{效率} + \underbrace{剩余部分，attention mask适应可变缺失}_{适应可变缺失}`,
    true
  ));
  assert.match(braces, /<munder><munder>/u);
  assert.match(braces, /<mo stretchy="true">⏟<\/mo>/u);
  assert.match(braces, /<mtext>固定数量、物理删除获得效率<\/mtext>/u);
  assert.doesNotMatch(braces, /\\underbrace/u);

  const loss = visibleMath(renderTexToMathML(
    String.raw`\mathcal{L} = \frac{1}{|A|}\sum_{j \in A} |\hat{x}_j - x_j|^2`,
    true
  ));
  assert.match(loss, /<mi mathvariant="script">L<\/mi>/u);
  assert.match(loss, /<mfrac>/u);
  assert.match(loss, /<mover accent="true"><mi>x<\/mi><mo>\^<\/mo><\/mover>/u);
  assert.match(loss, /<msub>/u);
  assert.doesNotMatch(loss, /\\hat/u);
});

test("KaTeX input stays untrusted and resource-loading commands create no links or images", () => {
  for (const source of [
    String.raw`\href{https://tracker.invalid/}{x}`,
    String.raw`\includegraphics{https://tracker.invalid/pixel.png}`,
    String.raw`\htmlClass{unsafe}{x}`
  ]) {
    const output = visibleMath(renderTexToMathML(source));
    assert.doesNotMatch(output, /<(?:a|img)\b|\b(?:href|src|class|id)=/iu);
    assert.match(output, /<mtext>\\(?:href|includegraphics|htmlClass)<\/mtext>/u);
  }
  assert.throws(
    () => renderTexToMathML(String.raw`\def\loop{\loop}\loop`),
    /Too many expansions/u
  );
  assert.throws(
    () => renderTexToMathML("x".repeat(MAX_TEX_SOURCE_LENGTH + 1)),
    /超过/u
  );
});

test("only inert MathML trees are imported into the Zotero document", () => {
  const row = new ElementMock("mrow");
  const math = new ElementMock("math", { descendants: [row] });
  const doc = {
    defaultView: { DOMParser: parserFor(math) },
    importNode(node) { return node; }
  };
  assert.equal(importRenderedMathML(doc, "<ignored/>"), math);

  const foreign = new ElementMock("script", { namespaceURI: "http://www.w3.org/1999/xhtml" });
  const foreignMath = new ElementMock("math", { descendants: [foreign] });
  const foreignDoc = {
    defaultView: { DOMParser: parserFor(foreignMath) },
    importNode(node) { return node; }
  };
  assert.equal(importRenderedMathML(foreignDoc, "<ignored/>"), null);

  const linked = new ElementMock("mi", {
    attributes: [{ localName: "href", namespaceURI: null }]
  });
  const linkedMath = new ElementMock("math", { descendants: [linked] });
  const linkedDoc = {
    defaultView: { DOMParser: parserFor(linkedMath) },
    importNode(node) { return node; }
  };
  assert.equal(importRenderedMathML(linkedDoc, "<ignored/>"), null);
});

test("appendMath marks KaTeX output and preserves raw TeX on a safe fallback", () => {
  const importedMath = new ElementMock("math");
  const realLikeDoc = {
    defaultView: { DOMParser: parserFor(importedMath) },
    importNode(node) { return node; }
  };
  const renderedParent = new ElementMock("div", { namespaceURI: null });
  assert.equal(appendMath(realLikeDoc, renderedParent, String.raw`x^2`, true), true);
  assert.equal(renderedParent.children[0].getAttribute("data-math-renderer"), "katex-0.18.4");
  assert.equal(renderedParent.children[0].getAttribute("display"), "block");

  const fallbackDoc = {
    defaultView: {},
    createElementNS(namespaceURI, name) { return new ElementMock(name, { namespaceURI }); },
    createElement(name) { return new ElementMock(name); }
  };
  const fallbackParent = new ElementMock("div", { namespaceURI: null });
  const source = String.raw`\unsupported{x}`;
  assert.equal(appendMath(fallbackDoc, fallbackParent, source), false);
  const fallback = fallbackParent.children[0];
  assert.equal(fallback.getAttribute("data-math-renderer"), "fallback");
  assert.equal(fallback.getAttribute("aria-label"), source);
  assert.equal(fallback.children[0].textContent, source);
});
