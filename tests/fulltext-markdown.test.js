"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const M = require("../plugin/content/fulltext-markdown.js");

test("PDF typography defaults to local sans fonts and explicit readable print sizes", () => {
  assert.equal(M.getPrintCSS(), M.PRINT_CSS);
  assert.match(M.PRINT_CSS, /font-family: "PingFang SC", "Microsoft YaHei"/u);
  assert.match(M.PRINT_CSS, /font-size: 12pt; font-weight: 400; line-height: 1\.75/u);
  assert.match(M.PRINT_CSS, /math \{ font-family: math; \}/u);
  assert.match(M.PRINT_CSS, /code,pre \{ font-family: "Noto Sans Mono", Menlo, monospace/u);
  assert.doesNotMatch(M.PRINT_CSS, /@font-face|@import|url\(/iu);
  assert.match(M.getPrintCSS("serif"), /body \{ font-family: "Source Han Serif SC", "Noto Serif CJK SC", "Songti SC"/u);
  assert.equal(M.getPrintCSS("unknown", "invalid;"), M.PRINT_CSS);
  assert.equal(M.getPrintCSS("custom", "   "), M.PRINT_CSS);
  for (const font of ["PingFang SC", "思源黑体", "Noto Sans CJK SC", "字体-123_Regular"]) {
    assert.ok(M.getPrintCSS("custom", ` ${font} `).endsWith(`body { font-family: "${font}", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", "Source Han Sans SC", sans-serif; }\n`));
  }
});

test("PDF font names cannot inject CSS, resources, lists, controls or unbounded text", () => {
  for (const font of ['a";color:red', "a,b", "url(https://x)", "a\\b", "</style>", "a\nb", "a\u0000", "a\u202e", "\ud800", "x".repeat(129), {}, 42]) {
    assert.throws(() => M.getPrintCSS("custom", font), /PDF 自定义字体无效/u);
  }
  assert.ok(M.getPrintCSS("custom", "x".repeat(128)).includes('"' + "x".repeat(128) + '"'));
  assert.equal(M.getPrintCSS("sans", 'ignored"'), M.PRINT_CSS);
});

function roundtrip(source) {
  const plan = M.createPlan(source);
  assert.equal(plan.segments.map(segment => segment.source).join(""), source);
  const translations = {};
  for (const segment of plan.segments) {
    if (!segment.translatable) continue;
    const prepared = JSON.parse(JSON.stringify(M.prepareSegment(segment)));
    translations[segment.id] = M.restoreTranslation(prepared, prepared.units);
    assert.equal(M.validateRestored(segment, translations[segment.id]), segment.source);
  }
  assert.equal(M.assemble(plan, translations), source);
  return plan;
}
function request(prepared) { return JSON.stringify({ source: prepared.units, context: prepared.context }); }
function translate(prepared, change) { return prepared.units.map(({ id, text }) => ({ id, text: change(text) })); }
function segment(source) {
  const plan = M.createPlan(source);
  assert.equal(plan.segments.length, 1);
  assert.equal(plan.segments[0].translatable, true);
  return plan.segments[0];
}
class Node {
  constructor(name, value = "") { this.localName = name; this.value = value; this.children = []; this.attributes = new Map(); }
  get childNodes() { return this.children; }
  get textContent() { return this.value + this.children.map(child => child.textContent).join(""); }
  set textContent(value) { this.value = value; this.children = []; }
  append(...children) {
    for (const child of children) {
      if (child.parentNode) child.parentNode.children = child.parentNode.children.filter(item => item !== child);
      child.parentNode = this;
      this.children.push(child);
    }
  }
  replaceChildren(...children) { this.children.forEach(child => { child.parentNode = null; }); this.children = []; this.append(...children); }
  setAttribute(name, value) { this.attributes.set(name, value); }
  getAttribute(name) { return this.attributes.get(name); }
  set innerHTML(_value) { throw new Error("Forbidden HTML injection"); }
}
class Document {
  constructor() { this.defaultView = {}; }
  createElement(name) { return new Node(name); }
  createElementNS(namespace, name) { const node = new Node(name); node.namespaceURI = namespace; return node; }
  createTextNode(value) { return new Node(null, value); }
}
function descendants(node) { return [node, ...node.children.flatMap(descendants)]; }
function render(source, doc = new Document()) {
  const root = doc.createElement("div");
  M.renderMarkdown(doc, root, source);
  return { root, nodes: descendants(root), doc };
}
const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0S8AAAAASUVORK5CYII=";

test("IIFE registers FulltextMarkdown without startup, DOM or network side effects", () => {
  const source = fs.readFileSync(require.resolve("../plugin/content/fulltext-markdown.js"), "utf8");
  const scope = {};
  vm.runInNewContext(source, scope);
  assert.equal(typeof scope.SmartPaperTranslatorModules.FulltextMarkdown.createPlan, "function");
  for (const name of ["createPlan", "prepareSegment", "restoreTranslation", "validateRestored", "assemble", "renderMarkdown"]) assert.equal(typeof M[name], "function");
});

test("diagnostics report one first inline syntax error per exact block with CRLF-aware lines", () => {
  const source = "# Broken [title\r\n\r\n😀 Same [open $also\r\n\r\n😀 Same [open $also\r\n\r\nLast `code\r\n";
  const blocks = M.editableBlocks(source), result = M.diagnose(source);
  assert.equal(result.limited, false);
  assert.equal(result.issues.length, 4);
  result.issues.forEach((issue, index) => {
    assert.equal(issue.start, blocks[index].start);
    assert.equal(issue.end, blocks[index].end);
    assert.equal(issue.line, index * 2 + 1);
    assert.equal(issue.endLine, index * 2 + 1);
    assert.match(issue.message, index === 3 ? /行内代码未闭合/u : /括号未闭合/u);
    assert.equal(issue.excerpt, blocks[index].source.trim());
    assert.deepEqual(Object.keys(issue).sort(), ["start", "end", "message", "excerpt", "line", "endLine"].sort());
  });
  assert.notEqual(result.issues[1].start, result.issues[2].start);
  const mixed = M.diagnose("ok\r\r[bad\nnext\r\n\r\n$bad");
  assert.deepEqual(mixed.issues.map(({ line, endLine }) => [line, endLine]), [[3, 4], [6, 6]]);
});

test("diagnostics retain valid prefixes then one uncertain structural tail without changing strict or editable parsing", () => {
  for (const tail of ["```js\n[unclosed\n\nLater $bad", "$$\nmath\n\nLater [bad",
    "<table><tr><td>Text\n\nLater [bad", "<pre>code\n\nLater [bad", "<!-- comment\n\nLater [bad",
    "| A | B |\n| --- | --- |\n| one |\n\nLater [bad",
    "<table><tr><td>ok</td></tr></table> trailing\n\nLater [bad"]) {
    const prefix = "# Valid\n\nFirst [bad\n\nGood.\n\n", source = prefix + tail;
    const result = M.diagnose(source);
    assert.equal(result.limited, false);
    assert.equal(result.issues.length, 2, tail);
    assert.equal(result.issues[0].start, "# Valid\n\n".length);
    assert.equal(result.issues[1].start, prefix.length);
    assert.equal(result.issues[1].end, source.length);
    assert.equal(source.slice(result.issues[1].start), tail);
    assert.equal(result.issues[1].line, 7);
    assert.throws(() => M.editableBlocks(source, { strict: true }));
    assert.deepEqual(M.editableBlocks(source), [{ index: 0, start: 0, end: source.length, kind: "source", source }]);
    assert.throws(() => M.createPlan(source));
  }
  const source = "<!-- safe -->```\nnot closed";
  const issue = M.diagnose(source).issues[0];
  assert.equal(issue.start, "<!-- safe -->".length);
  assert.equal(issue.end, source.length);
});

test("diagnostics skip protected literal blocks and allow escaped brackets, valid math and inert HTML fallback", () => {
  const source = String.raw`# Valid \] and \$ text

Inline \[literal\] and \![literal], \$5, \`[code $\`.

Math $x$ and \(y\), [label](https://example.test), [1].

$$z$$

\begin{align}x &= y\end{align}

~~~algorithm
[unterminated $literal
~~~

    [unterminated $literal

<!-- [unterminated $literal -->

<pre>[unterminated $literal</pre>

<widget>Unsupported but inert.</widget>

<b>Unbalanced safe HTML uses literal fallback.

<table><tr><td onclick="no()">Unsupported inert attributes</td></tr></table>`;
  assert.deepEqual(M.diagnose(source.replace(/\\`/gu, "`")), { issues: [], limited: false });
  assert.deepEqual(M.diagnose(""), { issues: [], limited: false });
  assert.deepEqual(M.diagnose("正文".repeat(128001)), { issues: [], limited: false });
  assert.throws(() => M.prepareSegment({ id: "large", source: "正文".repeat(128001), translatable: true }), /单块输入/u);
  assert.equal(M.diagnose("## [bad\n\n$x\n\n<p title=\"open").issues.length, 3);
});

test("diagnostics follow actual inline render boundaries without MathML, DOM, image decoding or requests", () => {
  for (const source of ['<pre title="unterminated>text</pre>', '<code title="unterminated>text</code>',
    '- First $unclosed\n- Second $also', '- First [unclosed\n- Second ](https://example.test)',
    'Before *inside $unclosed* after $also', '> - First $unclosed\n> - Second $also']) {
    let failure;
    try { render(source); } catch (error) { failure = error; }
    assert.ok(failure, source);
    const result = M.diagnose(source);
    assert.equal(result.issues.length, 1, source);
    assert.equal(result.issues[0].message, failure.message, source);
    assert.equal(result.issues[0].start, 0); assert.equal(result.issues[0].end, source.length);
  }
  const code = fs.readFileSync(require.resolve("../plugin/content/fulltext-markdown.js"), "utf8");
  const unavailable = () => assert.fail("syntax checks must not invoke DOM, MathML, decoding, requests or require");
  const registry = {};
  Object.defineProperty(registry, "MathRenderer", { get: unavailable });
  const scope = { SmartPaperTranslatorModules: registry, require: unavailable, document: { createElementNS: unavailable }, fetch: unavailable, atob: unavailable };
  vm.runInNewContext(code, scope);
  const result = registry.FulltextMarkdown.diagnose('- Valid $x$\n- Valid [link](https://example.test)\n\n![image](data:image/png;base64,invalid)\n\n![remote](https://example.test/a.png)');
  assert.equal(result.issues.length, 0); assert.equal(result.limited, false);
});

test("diagnostics bound issue count and Unicode excerpts and catch source validation failures locally", () => {
  const source = Array.from({ length: 202 }, () => "😀".repeat(200) + "[bad").join("\n\n");
  let scanned = 0;
  const original = String.prototype.codePointAt;
  let result;
  try {
    String.prototype.codePointAt = function (...args) { scanned++; return original.apply(this, args); };
    result = M.diagnose(source);
  } finally { String.prototype.codePointAt = original; }
  assert.equal(result.issues.length, 200);
  assert.equal(result.limited, true);
  assert.ok(scanned <= 200 * 160);
  for (const issue of result.issues) {
    assert.equal(issue.excerpt, "😀".repeat(159) + "…");
    assert.equal(Array.from(issue.excerpt).length, 160);
    assert.doesNotMatch(issue.excerpt, /[\uD800-\uDFFF]/u);
  }
  assert.equal(M.diagnose("[one\n\n[two", { limit: 2 }).limited, false);
  assert.equal(M.diagnose("[one\n\n[two\n\n[three", { limit: 2 }).limited, true);
  assert.deepEqual(M.diagnose("[one", { limit: 0 }), { issues: [], limited: true });
  assert.deepEqual(M.diagnose("valid", { limit: 0 }), { issues: [], limited: false });
  assert.equal(M.diagnose(source, { limit: -1 }).issues.length, 200);
  for (const invalid of [null, "\uD800", "\u0000PRIVATE"]) {
    const result = M.diagnose(invalid);
    assert.equal(result.issues.length, 1);
    assert.match(result.issues[0].message, /^全文 Markdown：/u);
    assert.doesNotMatch(result.issues[0].message, /PRIVATE/u);
    assert.equal(result.limited, false);
  }
});

test("editable blocks carry exact offsets without swallowing whitespace or repeated text", () => {
  const source = "# Title\r\n\r\nSame\r\n\r\nSame\r\n\r\n$$x$$\r\n\r\n| A | B |\r\n| --- | --- |\r\n| x | y |\r\n";
  const blocks = M.editableBlocks(source);
  assert.equal(blocks.length, 5);
  blocks.forEach((b, i) => { assert.equal(b.index, i); assert.equal(source.slice(b.start, b.end), b.source); });
  assert.notEqual(blocks[1].start, blocks[2].start);
  assert.deepEqual(M.editableBlocks("\n<!-- comment -->\n\n"), []);
  assert.equal(M.editableBlocks("$$unclosed")[0].kind, "source");
  assert.throws(() => M.editableBlocks("$$unclosed", { strict: true }), /未闭合/u);
  assert.throws(() => M.validateSource("bad\ud800"), /Unicode/u);
});

test("block rendering callbacks retain algorithm heading context and exact edit indexes", () => {
  const source = "### Algorithm 1\n\n```pseudocode\nRequire: $x$\n```\n\nText\n";
  const doc = new Document(), root = doc.createElement("div"), records = [];
  M.renderMarkdown(doc, root, source, { onBlock: (node, block) => records.push({ node, block }) });
  assert.equal(records.length, 3);
  assert.deepEqual(records.map(r => r.block.index), [0, 1, 2]);
  assert.equal(records[1].block.source, M.editableBlocks(source)[1].source);
  assert.equal(descendants(records[1].node).filter(n => n.localName === "math").length, 1);
  assert.equal(root.children.length, 3);
});

test("remote image resolver cannot bypass data-only signature or aggregate limits", () => {
  const doc = new Document(), root = doc.createElement("div"), urls = [];
  M.renderMarkdown(doc, root, "![figure](https://example.invalid/a.png)", { imageResolver: url => { urls.push(url); return png; } });
  assert.deepEqual(urls, ["https://example.invalid/a.png"]);
  assert.equal(descendants(root).find(n => n.localName === "img").getAttribute("src"), png);
  for (const value of ["https://example.invalid/a.png", "file:///private/a.png", "data:image/svg+xml;base64,PHN2Zy8+"]) {
    assert.throws(() => M.renderMarkdown(doc, root, "![figure](https://example.invalid/a.png)", { imageResolver: () => value }));
  }
  const lookedUp = [];
  M.renderMarkdown(doc, root, "```\n![x](https://example.invalid/a.png)\n```", { imageResolver: uri => lookedUp.push(uri) });
  assert.deepEqual(lookedUp, []);
});

test("asynchronous image commits update only the placeholder and enforce data validation", () => {
  const doc = new Document(), root = doc.createElement("div"); let commit;
  M.renderMarkdown(doc, root, "Intro\n\n![figure](https://example.invalid/a.png)\n\nEnd", {
    onRemoteImage: (uri, update) => { assert.equal(uri, "https://example.invalid/a.png"); commit = update; }
  });
  const first = root.children[0], last = root.children.at(-1);
  assert.equal(descendants(root).some(n => n.localName === "img"), false);
  assert.throws(() => commit("https://example.invalid/a.png"), /本地/u);
  assert.throws(() => commit("data:image/svg+xml;base64,PHN2Zy8+"));
  commit(png); commit(png);
  assert.equal(descendants(root).filter(n => n.localName === "img").length, 1);
  assert.equal(root.children[0], first); assert.equal(root.children.at(-1), last);
  assert.equal(root.textContent.includes("https://"), false);
});

test("lossless plan and assembly preserve CRLF, Unicode, headings, paragraphs and blank lines", () => {
  roundtrip("\uFEFF# Paper α 😀\r\n\r\nEnglish e\u0301 and 中文。\r\nLine two.  \r\n\r\n## Methods\r\nBody\r\n\r\n");
  roundtrip(""); roundtrip("\r\n\t \n"); roundtrip("# Heading\nText without trailing newline");
  const plan = roundtrip("Title\n=====\n\nSection\n-----\n\nBody\n");
  assert.equal(plan.segments.filter(s => s.reason === "heading").length, 2);
});

test("multiline code, mathematical blocks and HTML tables are not split at blank lines", () => {
  const source = "```js\nconst x = 1;\n\nconst y = `<script>`;\n```\n\n$$\nx = 1\n\n+y\n$$\n\n<table>\n<tr><td rowspan=\"2\">Alpha</td><td>Beta</td></tr>\n\n<tr><td>Gamma</td></tr>\n</table>\n";
  const plan = roundtrip(source);
  assert.equal(plan.segments.filter(s => s.reason === "code").length, 1);
  assert.equal(plan.segments.filter(s => s.reason === "math").length, 1);
  assert.equal(plan.segments.filter(s => s.reason === "html-table").length, 1);
  assert.equal(plan.segments.find(s => s.reason === "html-table").translatable, true);
  roundtrip("~~~~python\n``` not closing\n\nprint('hello')\n~~~~~\n");
  roundtrip("\\[\nx^2\n\n+y\n\\]\n");
  roundtrip("\\begin{align}\nx &= 1 \\\\\n\ny &= 2\n\\end{align}\n");
});

test("headings, lists and body blockquotes translate; code, citations, formulas, URLs do not", () => {
  const source = "> Evidence [1], [2–4], [7, 9-11] with $x<y$ and \\(z_1\\).\n> **Quoted English** is body text.\n";
  const s = segment(source);
  const p = M.prepareSegment(s);
  for (const literal of ["[1]", "[2–4]", "[7, 9-11]", "$x<y$", "\\(z_1\\)", "**", "> "]) assert.ok(!request(p).includes(literal));
  const translated = M.restoreTranslation(p, translate(p, text => text.replace("Evidence", "证据").replace("Quoted English", "引用的英文")));
  assert.match(translated, /^> 证据 \[1\]/u);
  assert.match(translated, /\*\*引用的英文\*\*/u);
  roundtrip("1. First **bold** point\n2. Second `const a = \"<script>\";` point\n  - Nested point\n- [x] Complete\n");
  const links = segment("See [the paper](https://example.invalid/a_(b) \"Title\"), https://example.invalid/q?a=1 and <https://example.invalid/>.\n");
  assert.doesNotMatch(request(M.prepareSegment(links)), /https:|Title/u);
  roundtrip(links.source);
});

test("numeric and multilingual reference sections preserve complete entries until same/higher heading", () => {
  for (const title of ["## 7 References", "## 7. References", "## 7.1 Bibliography", "## 参考文献", "## **References**", "## IV. REFERENCES"]) {
    const source = `Introduction\n\n${title}\n[1] Smith, J. English title. Journal (2024).\n\n[2] Li. Another title. 2020.\n\n### Supplemental entries\n[3] Author. Title. 2021.\n\n## Appendix\nText to translate\n`;
    const plan = roundtrip(source);
    assert.equal(plan.referenceCount, 3);
    assert.ok(plan.segments.filter(s => s.source.includes("Smith") || s.source.includes("Another title") || s.source.includes("2021")).every(s => !s.translatable));
    assert.equal(plan.segments.find(s => s.source.includes("Text to translate")).translatable, true);
  }
  const setext = roundtrip("References\n==========\n\nSmith. Title. 2023.\n\nLi. Title. 2024.\n\nAppendix\n========\nBody\n");
  assert.equal(setext.referenceCount, 2);
});

test("images and arbitrarily large base64 payload never enter model request", () => {
  const large = `data:image/png;base64,${"A".repeat(200000)}`;
  const source = `Figure description ![plot](${large}) and conclusion.\n`;
  const s = segment(source), p = M.prepareSegment(s);
  assert.ok(request(p).length < 500);
  assert.doesNotMatch(request(p), /data:image|AAAA|plot/u);
  assert.equal(M.restoreTranslation(p, p.units), source);
  const html = segment(`<table><tr><td>Image</td><td><img src="${png}" alt="plot"></td></tr></table>\n`);
  assert.doesNotMatch(request(M.prepareSegment(html)), /base64|iVBOR|plot/u);
  roundtrip(`![plot](${png})\n`);
});

test("model input cap counts prose, not raw resources; Unicode UTF-8 cap is explicit", () => {
  assert.equal(M.MAX_SOURCE_BYTES, 128 * 1024 * 1024);
  assert.throws(() => M.createPlan("a".repeat(M.MAX_SEGMENT_LENGTH + 1)), /上限/u);
  assert.throws(() => M.createPlan("汉".repeat(Math.floor(M.MAX_SOURCE_BYTES / 3) + 1)), /128 MiB/u);
  assert.throws(() => M.createPlan("bad\ud800text"), /Unicode/u);
  assert.throws(() => M.createPlan("bad\u0000text"), /控制字符/u);
});

test("128000-unit input boundary counts summed prose UTF-16 without truncation", () => {
  assert.equal(M.MAX_SEGMENT_LENGTH, 128000);
  for (const source of ["a".repeat(128000), "汉".repeat(128000), "𠮷".repeat(64000)]) {
    const plan = M.createPlan(source);
    assert.equal(plan.segments.length, 1);
    const prepared = M.prepareSegment(plan.segments[0]);
    assert.equal(prepared.units[0].text.length, 128000);
    assert.equal(M.restoreTranslation(prepared, prepared.units), source);
    assert.throws(() => M.createPlan(source + "a"), /插件单块输入上限 128000.*未截断/u);
    roundtrip(source + " \r\n"); // Protected whitespace does not consume the prose budget.
  }
  const source = "a".repeat(64000) + "$x$" + "b".repeat(64000);
  roundtrip(source);
  assert.throws(() => M.createPlan(source + "c"), /输入上限/u);
});

test("large internal whitespace and ASCII runs complete without quadratic backtracking", () => {
  const { spawnSync } = require("node:child_process");
  const child = spawnSync(process.execPath, ["-e", `
    const assert = require("node:assert/strict");
    const M = require(${JSON.stringify(require.resolve("../plugin/content/fulltext-markdown.js"))});
    for (const source of ["a".repeat(128000), "a" + " ".repeat(127998) + "b", "a" + "\\t".repeat(127998) + "b"]) {
      const plan = M.createPlan(source);
      const prepared = M.prepareSegment(plan.segments[0]);
      assert.equal(prepared.units[0].text, source);
      assert.equal(M.restoreTranslation(prepared, prepared.units), source);
    }
    const source = "a" + " ".repeat(100000) + "b \\t";
    const prepared = M.prepareSegment(M.createPlan(source).segments[0]);
    assert.equal(prepared.parts.at(-1).value, " \\t");
    assert.equal(M.restoreTranslation(prepared, prepared.units), source);
  `], { timeout: 8000, encoding: "utf8" });
  assert.equal(child.error, undefined, String(child.error));
  assert.equal(child.status, 0, child.stderr);
});

test("linear URL search preserves embedded scheme and special-prefix protection", () => {
  for (const [body, url] of [
    ["before custom+v1.2://host/path", "custom+v1.2://host/path"],
    ["前文HTTPS://host/path", "HTTPS://host/path"],
    ["123abc://host/path", "abc://host/path"],
    ["before prefixdata:image/png;base64,AAAA", "data:image/png;base64,AAAA"],
    ["before prefixmailto:user@example.test", "mailto:user@example.test"],
    ["before prefixfile:local", "file:local"],
    ["before prefixwww.example.test", "www.example.test"],
    ["before www.example://host", "www.example://host"],
    ["before a://host/path www.example.test", "a://host/path"]
  ]) {
    const source = `Prose ${body}`, prepared = M.prepareSegment(segment(source));
    assert.equal(prepared.parts.find(part => part.kind === "url").value, url);
    assert.ok(!request(prepared).includes(url));
    assert.equal(M.restoreTranslation(prepared, prepared.units), source);
  }
});

test("large HTML tables keep their full skeleton and stable segment identities", () => {
  const source = `<table>${"<tr><td>Long cell content [1] $x$</td><td>Value</td></tr>".repeat(120)}</table>`;
  const plan = M.createPlan(source), s = plan.segments[0], prepared = M.prepareSegment(s);
  assert.equal(prepared.units.length, 240);
  assert.ok(request(prepared).length > 16000);
  assert.equal(plan.segments.length, 1);
  assert.equal(s.id, "s000001");
  const translated = translate(prepared, text => text.replaceAll("Long cell content", "长单元格正文"));
  assert.equal(M.restoreTranslation(prepared, translated), source.replaceAll("Long cell content", "长单元格正文"));
  assert.throws(() => M.restoreTranslation(prepared, translated.slice(1)), /单元/u);
});

test("expanded translations have an independent 256000-unit bound including on checkpoint reload", () => {
  assert.equal(M.MAX_TRANSLATION_LENGTH, 256000);
  const s = segment("a".repeat(128000)), prepared = M.prepareSegment(s), translation = "译".repeat(256000);
  assert.equal(M.restoreTranslation(prepared, [{ id: "t0", text: translation }]), translation);
  assert.equal(M.validateRestored(s, translation), translation);
  assert.throws(() => M.restoreTranslation(prepared, [{ id: "t0", text: translation + "文" }]), /输出上限/u);
  assert.throws(() => M.validateRestored(s, translation + "文"), /输出上限/u);
  const split = segment("First $x$ second\r\n"), p = M.prepareSegment(split);
  const units = [{ id: "t0", text: "𠮷".repeat(64000) }, { id: "t1", text: "译".repeat(128000) }];
  const restored = units[0].text + " $x$ " + units[1].text + "\r\n";
  assert.equal(M.restoreTranslation(p, units), restored);
  assert.equal(M.validateRestored(split, restored), restored);
  units[1].text += "文";
  assert.throws(() => M.restoreTranslation(p, units), /输出上限/u);
  assert.throws(() => M.validateRestored(split, restored.replace("\r\n", "文\r\n")), /输出上限/u);
});

test("text and context count limits are inclusive and never silently split", () => {
  assert.equal(M.MAX_TEXT_PARTS, 4096);
  assert.equal(M.MAX_CONTEXT_PARTS, 16384);
  const source = "a$x$".repeat(M.MAX_TEXT_PARTS);
  const p = M.prepareSegment(segment(source));
  assert.equal(p.units.length, M.MAX_TEXT_PARTS);
  assert.equal(p.units.at(-1).id, "t4095");
  assert.equal(M.restoreTranslation(p, p.units), source);
  assert.throws(() => M.createPlan(source + "a"), /正文单元数量.*未拆分或截断/u);
  const structures = "*".repeat(M.MAX_CONTEXT_PARTS - 1) + "Text";
  const q = M.prepareSegment({ id: "context-limit", source: structures, translatable: true });
  assert.equal(q.context.length, M.MAX_CONTEXT_PARTS);
  assert.equal(M.restoreTranslation(q, q.units), structures);
  assert.throws(() => M.prepareSegment({ id: "context-limit", source: "*" + structures, translatable: true }), /上下文数量.*未拆分或截断/u);
});

test("request and response envelopes cover escaped prose and bounded metadata only", () => {
  assert.equal(M.MAX_RESPONSE_LENGTH, 6 * M.MAX_TRANSLATION_LENGTH + 128 * M.MAX_TEXT_PARTS + 64);
  const inputLimit = 6 * M.MAX_SEGMENT_LENGTH + 128 * M.MAX_CONTEXT_PARTS + 64;
  const escapeUnicode = value => JSON.stringify(value).replace(/[\u0080-\uffff]/gu, ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
  const texts = Array.from({ length: 4096 }, (_, i) => "汉".repeat(i < 1024 ? 32 : 31));
  const p = M.prepareSegment(segment(texts.join("$secret$")));
  assert.equal(p.units.reduce((sum, unit) => sum + unit.text.length, 0), M.MAX_SEGMENT_LENGTH);
  const encodedRequest = escapeUnicode({ source: p.units, context: p.context });
  assert.ok(encodedRequest.length > 6 * M.MAX_SEGMENT_LENGTH);
  assert.ok(encodedRequest.length <= inputLimit);
  assert.doesNotMatch(encodedRequest, /secret/u);
  const translations = translate(p, text => text.repeat(2));
  const encodedResponse = escapeUnicode({ translations });
  assert.ok(encodedResponse.length > 6 * M.MAX_TRANSLATION_LENGTH);
  assert.ok(encodedResponse.length <= M.MAX_RESPONSE_LENGTH);
  assert.equal(M.restoreTranslation(p, JSON.parse(encodedResponse).translations), texts.map(text => text.repeat(2)).join("$secret$"));
  const quoted = M.prepareSegment(segment('A"B\tC'.repeat(20000)));
  assert.ok(request(quoted).includes('\\"'));
  assert.ok(request(quoted).includes('\\t'));
  assert.ok(request(quoted).length <= inputLimit);
});

test("all protected kinds stay local while request context carries only ordered types", () => {
  const source = '# Heading\r\nText [42] $secretFormula$ `secretCode` \\* &amp; ![secretAlt](https://secret-image.invalid/x) [Label](https://secret-link.invalid/x) https://secret-url.invalid/x <span title="secretTitle">Body</span> <code>secretHTMLCode</code> <!-- secretComment -->\r\n[ref]: https://secret-definition.invalid/x\r\n';
  const p = M.prepareSegment({ id: "all-kinds", source, translatable: true });
  const kinds = new Set(p.parts.filter(part => part.kind !== "text").map(part => part.kind));
  assert.deepEqual([...kinds].sort(), ["structure", "newline", "space", "citation", "math", "code", "escape", "entity", "image", "destination", "url", "html", "html-code", "comment", "definition"].sort());
  let index = 0;
  assert.deepEqual(p.context, p.parts.map(part => part.kind === "text" ? { id: `t${index++}` } : { protected: part.kind }));
  assert.deepEqual(p.units.map(unit => unit.text), p.parts.filter(part => part.kind === "text").map(part => part.value));
  assert.doesNotMatch(request(p), /secret|\[42\]|&amp;|https:/u);
  assert.equal(p.parts.map(part => part.value).join(""), source);
  assert.equal(M.restoreTranslation(p, p.units), source);
});

test("formula between phrases supplies positional context but no formula value to the model", () => {
  const p = M.prepareSegment(segment("Given $secret_x=7$ we obtain a result.\r\n"));
  assert.deepEqual(p.units, [{ id: "t0", text: "Given" }, { id: "t1", text: "we obtain a result." }]);
  assert.deepEqual(p.context, [{ id: "t0" }, { protected: "space" }, { protected: "math" },
    { protected: "space" }, { id: "t1" }, { protected: "newline" }]);
  assert.doesNotMatch(request(p), /secret|=7|\$/u);
  assert.equal(M.restoreTranslation(p, [{ id: "t0", text: "给定" }, { id: "t1", text: "我们得到一个结果。" }]), "给定 $secret_x=7$ 我们得到一个结果。\r\n");
});

test("numbered screenshot-style paragraphs accept marker-free Chinese and restore exact prefixes and CRLF", () => {
  const source = "435. This approach preserves the structure of the original document.\r\n436) The next paragraph describes the experimental results.\r\n";
  const p = M.prepareSegment(segment(source));
  const response = [{ id: "t0", text: "此方法保留原始文档的结构。" }, { id: "t1", text: "下一段介绍实验结果。" }];
  assert.deepEqual(p.context, [{ protected: "structure" }, { id: "t0" }, { protected: "newline" },
    { protected: "structure" }, { id: "t1" }, { protected: "newline" }]);
  assert.doesNotMatch(request(p), /435|436|SPT_|\\r|\\n/u);
  assert.doesNotMatch(JSON.stringify(response), /435|436|SPT_|\\r|\\n/u);
  const expected = "435. 此方法保留原始文档的结构。\r\n436) 下一段介绍实验结果。\r\n";
  assert.equal(M.restoreTranslation(p, response), expected);
  assert.equal(M.validateRestored(segment(source), expected), expected);
});

test("uncertain or unclosed structure fails explicitly and never truncates", () => {
  for (const source of ["```js\ntext", "~~~\ntext", "$$x\n\ny", "\\[x", "Text $x", "<table><tr><td>Cell</td></tr>", "[link](https://x", "Text `code", "<!-- missing"]) {
    assert.throws(() => M.createPlan(source), /未闭合/u, source);
  }
  assert.throws(() => M.createPlan("<table><tr><td>A</td></tr></table> trailing prose"), /先分行/u);
});

test("version 2 units are deterministic, contiguous and serializable without marker metadata", () => {
  const s = segment("Text [1] and $x$.\n");
  const a = M.prepareSegment(s), b = M.prepareSegment(s);
  assert.deepEqual(a, b);
  assert.equal(a.version, 2);
  assert.deepEqual(Object.keys(a), ["version", "id", "source", "parts", "units", "context"]);
  assert.deepEqual(a.units.map(unit => unit.id), ["t0", "t1", "t2"]);
  assert.deepEqual(a.units, M.prepareSegment({ ...s, id: "another-id" }).units);
  assert.equal(M.restoreTranslation(JSON.parse(JSON.stringify(a)), a.units), s.source);
  assert.throws(() => M.restoreTranslation({ ...a, version: 1 }, a.units), /元数据/u);
});

test("Chinese word order around a formula can leave one prose part as punctuation", () => {
  const s = segment(". The sampling of $C$ follows a multi-scale patching protocol.\n");
  const p = M.prepareSegment(s);
  const translated = [{ id: "t0", text: "。" }, { id: "t1", text: "的采样遵循多尺度分块协议。" }];
  const expected = "。 $C$ 的采样遵循多尺度分块协议。\n";
  assert.equal(M.restoreTranslation(p, translated), expected);
  assert.equal(M.validateRestored(s, expected), expected);
  assert.equal(M.assemble(M.createPlan(s.source), { [s.id]: expected }), expected);
});

test("the reported twelve-part masking example accepts punctuation-only t5 without changing synthetic formulas", () => {
  const source = [
    "Multi-scale masking. To break the interpolation shortcuts inherent in autocorrelated longitudinal sequences, we employ an aggressive masking strategy. From the full sequence of",
    "embeddings, we sample a sparse context set", "of size", "approximately 12.5% of the weekly horizon",
    "to serve as input to the temporal encoder", ". The sampling of",
    "follows a multi-scale patching protocol designed to capture dynamics across different temporal reslutions. For each training sample, we randomly draw a patch size",
    ", corresponding to random patches of 5, 20, 60-minutes, respectively. We then partition the index set",
    "into", "non-overlapping contiguous patches; and randomly sample", "patches to form the context set. The target set is then", ". This"
  ];
  const translated = [
    "多尺度掩码。为打破自相关纵向序列中固有的插值捷径，我们采用一种激进的掩码策略。从完整的",
    "嵌入序列中，我们采样一个稀疏上下文集", "其大小为", "约为每周时间范围的12.5%",
    "作为时间编码器的输入", "。",
    "的采样遵循多尺度分块协议，旨在捕捉不同时间分辨率下的动态。对于每个训练样本，我们随机抽取一个块大小",
    "，分别对应5、20、60分钟的随机块。随后我们将索引集", "划分为", "个不重叠的连续块；并随机采样",
    "个块以构成上下文集。目标集则为", "。这一"
  ];
  const assemble = texts => texts.map((text, i) => text + (i < texts.length - 1 ? ` $p_{${i}}$ ` : "\n")).join("");
  const s = segment(assemble(source)), p = M.prepareSegment(s);
  assert.deepEqual(p.units.map(unit => unit.text), source);
  assert.equal(M.restoreTranslation(p, translated.map((text, i) => ({ id: `t${i}`, text }))), assemble(translated));
});

test("punctuation-only parts never excuse missing IDs, empty text, new structures or a wholly nontextual translation", () => {
  const s = segment("The sampling of $C$ follows a protocol.\n"), p = M.prepareSegment(s);
  const parts = text => [{ id: "t0", text }, { id: "t1", text: "的采样遵循协议。" }];
  for (const text of ["", " ", "\u00a0", "$new$", "[1]", "https://example.invalid", "<b>正文</b>"]) {
    assert.throws(() => M.restoreTranslation(p, parts(text)), text);
  }
  assert.throws(() => M.restoreTranslation(p, parts("。").slice(1)), /单元/u);
  assert.throws(() => M.restoreTranslation(p, parts("。").reverse()), /单元/u);
  const punctuation = [{ id: "t0", text: "。" }, { id: "t1", text: "！" }];
  assert.throws(() => M.restoreTranslation(p, punctuation), /正文内容缺失/u);
  assert.throws(() => M.validateRestored(s, "。 $C$ ！\n"), /正文内容缺失/u);
});

test("missing, duplicated, extra and reordered unit IDs are rejected", () => {
  const p = M.prepareSegment(segment("Text [1] and $x$.\n"));
  for (const response of [
    p.units.slice(1), [...p.units, p.units[0]], [...p.units, { id: "t99", text: "extra" }],
    [p.units[1], p.units[0], p.units[2]], [p.units[0], p.units[0], p.units[2]],
    p.units.map((unit, index) => index ? unit : { ...unit, id: "t01" }),
    p.units.map((unit, index) => index ? unit : { ...unit, id: "t99" })
  ]) assert.throws(() => M.restoreTranslation(p, response), /单元/u);
});

test("restoration rejects explanation, code wrappers, active HTML, extra resources and line damage", () => {
  const p = M.prepareSegment(segment("A paragraph [1].\n"));
  for (const text of [
    "Here is the translation: A paragraph", "译文：一段正文", "```markdown\n一段正文\n```",
    "<script>alert(1)</script>", "![x](https://tracking.invalid/image.png)",
    "<img src=x onerror=alert(1)>", "line\nline", "line\rline", "https://unexpected.invalid",
    "www.example.invalid", "file:///secret", "data:image/png;base64,AAAA", "mailto:a@example.invalid",
    "$new$", "[999]", "`code`", "# Heading", "1. List", "<b>New</b>", "&amp;", "**bold**",
    "", "   ", "...", "😀"
  ]) assert.throws(() => M.restoreTranslation(p, [{ id: "t0", text }, ...p.units.slice(1)]), text);
  assert.throws(() => M.restoreTranslation(p, [{ id: "t0", text: "x".repeat(M.MAX_TRANSLATION_LENGTH + 1) }, ...p.units.slice(1)]), /上限/u);
});

test("unit response types, exact keys and Unicode are checked before reconstruction", () => {
  const p = M.prepareSegment(segment("Text"));
  for (const response of [null, {}, "Text", { translations: p.units }, [null], [[]], ["Text"],
    [{ text: "正文" }], [{ id: "t0" }], [{ id: 0, text: "正文" }], [{ id: "t0", text: null }],
    [{ id: "t0", text: 1 }], [{ id: "t0", text: ["正文"] }], [{ id: "t0", text: {} }],
    [{ id: "t0", text: "正文", protected: "math" }], [{ id: "t0", text: "正文", value: "$changed$" }],
    [{ id: "t0", text: "正文", [Symbol("extra")]: true }], new Array(1)]) {
    assert.throws(() => M.restoreTranslation(p, response), /单元/u);
  }
  for (const text of ["bad\ud800", "\udfffbad", "\ud800x\udc00", "正文\u0000", "正文\u000b"]) {
    assert.throws(() => M.restoreTranslation(p, [{ id: "t0", text }]), /Unicode|控制字符/u);
  }
  assert.equal(M.restoreTranslation(p, [{ text: "正文𠮷😀e\u0301", id: "t0" }]), "正文𠮷😀e\u0301");
});

test("checkpoint validation rechecks protected content and exact table/list/heading skeleton", () => {
  const fixtures = [
    ["# Heading\n", "## 标题\n"], ["1. First\n2. Second\n", "2. 第一\n1. 第二\n"],
    ["Text [2–4] $x^2$\n", "译文 [2-4] $x^2$\n"], ["Text [1] $x^2$\n", "译文 [1] $x^3$\n"],
    ["| Name | Value |\n| --- | --- |\n| A | B |\n", "| 名称 | 数值 |\n| --- | --- |\n| A | B | C |\n"],
    ["| Name | Value |\n| --- | --- |\n| A | B |\n", "| 名称 | 数值 |\n| xxx | --- |\n| A | B |\n"],
    ["<table><tr><td colspan=\"2\">Hello</td></tr></table>\n", "<table><tr><td colspan=\"3\">你好</td></tr></table>\n"],
    ["Text\r\nNext\r\n", "译文\n后文\n"]
  ];
  for (const [source, damaged] of fixtures) assert.throws(() => M.validateRestored(segment(source), damaged));
  const source = "<table><tr><td colspan=\"2\">Hello</td></tr></table>\n";
  assert.equal(M.validateRestored(segment(source), source.replace("Hello", "你好")), source.replace("Hello", "你好"));
});

test("assemble requires every translatable segment and ignores injected protected translations", () => {
  const plan = M.createPlan("# Title\n\nText\n\n```\ncode\n```\n");
  const translations = {};
  assert.throws(() => M.assemble(plan, translations), /缺少/u);
  for (const s of plan.segments) translations[s.id] = s.translatable ? s.source : "INJECTED";
  assert.equal(M.assemble(plan, translations), plan.segments.map(s => s.source).join(""));
  const first = plan.segments.find(s => s.translatable);
  translations[first.id] = "## Changed heading\n";
  assert.throws(() => M.assemble(plan, translations));
  const protectedSegment = plan.segments.find(s => !s.translatable);
  assert.throws(() => M.validateRestored(protectedSegment, "different"), /逐字保留/u);
  assert.throws(() => M.assemble({ segments: [first, first] }, { [first.id]: first.source }), /重复/u);
});

test("tampered serializable preparation does not bypass validation", () => {
  const original = M.prepareSegment(segment("Text [1]\n"));
  for (const tamper of [
    p => { p.parts.find(part => part.kind === "citation").value = "[999]"; },
    p => { p.parts[0].kind = "image"; },
    p => { p.units[0].text = "different"; },
    p => { p.units[0].id = "t99"; },
    p => { p.context[0] = { protected: "image" }; },
    p => { p.context.push({ protected: "newline" }); }
  ]) {
    const p = JSON.parse(JSON.stringify(original)); tamper(p);
    assert.throws(() => M.restoreTranslation(p, original.units), /保护内容/u);
  }
});

test("safe DOM has normal heading levels, lists, nested list, code, quote and hard line break", () => {
  const { nodes, root } = render("# Title\n\nParagraph **bold** and *italic*.  \nNext line.\n\n- First\n  - Nested\n- Second\n\n3. Third\n4. Fourth\n\n> A quotation\n\n```js\n<script>alert(1)</script>\n```\n");
  for (const tag of ["h1", "p", "strong", "em", "ul", "ol", "li", "blockquote", "pre", "code", "br"]) assert.ok(nodes.some(n => n.localName === tag), tag);
  assert.equal(nodes.find(n => n.localName === "ol").getAttribute("start"), "3");
  assert.ok(!nodes.some(n => n.localName === "script"));
  assert.match(root.textContent, /<script>alert\(1\)<\/script>/u);
});

test("algorithm pseudocode preserves indentation while rendering only math fragments", () => {
  const code = "Require: Graph $\\mathcal{G}^{0}$, Metrics $\\mathcal{M}_{D}$\nfor each $m_i \\in \\mathcal{M}_{D}$ do\n    $v_i \\gets \\text{NODEGEN}(m_i)$\nend for\nreturn Updated graph $\\mathcal{G}$";
  for (const source of [`### Algorithm 1 PKG Update\n\n\`\`\`\n${code}\n\`\`\`\n`,
    `\`\`\`pseudocode\n${code}\n\`\`\``, `### Algorithm 1\n\n${code.split("\n").map(line => "    " + line).join("\n")}\n`,
    `### Algorithm 1\n\n<pre><code>${code}</code></pre>\n`]) {
    const { root, nodes } = render(source);
    assert.equal(nodes.filter(node => node.localName === "math").length, 5, source);
    assert.ok(nodes.some(node => node.localName === "pre" && node.getAttribute("class") === "spt-fulltext-algorithm"));
    assert.match(root.textContent, /\n    /u);
    roundtrip(source);
  }
});

test("PKG algorithm formula samples compile with the bundled KaTeX MathML renderer", () => {
  const { renderTexToMathML } = require("../plugin/content/math-renderer.js");
  for (const tex of [String.raw`\mathcal{G}^{0} = (\mathcal{V}^{0}, \mathcal{E}^{0})`,
    String.raw`\mathcal{M}_{D} = \{m_1, \dots, m_{|\mathcal{M}_{D}|}\}`,
    String.raw`\{NodeGen, EdgeGen, Merge, UpdateNode\}`,
    String.raw`\exists v_k \in \mathcal{V}^{0} : \text{MERGE}(m_i, v_k)`,
    String.raw`v_k \gets \text{UPDATENode}(m_i, v_k)`,
    String.raw`\mathcal{E}^{0} \gets \mathcal{E}^{0} \cup \{e_{i,j}\}`]) {
    const markup = renderTexToMathML(tex);
    assert.match(markup, /<math[ >]/u); assert.doesNotMatch(markup, /katex-error/u);
  }
});

test("real code and ambiguous blocks remain literal even below algorithm headings", () => {
  for (const source of ["```python\nx = '$x$'\n```", "```\n$x$\n```", "    $x$\n",
    "### Algorithm 1\n\n```python\nRequire: $x$\nfor each $y$ do\nend for\n```",
    "### Algorithm 1\n\nExplanation first.\n\n```\nRequire: $x$\nfor each $y$ do\nend for\n```",
    "### Algorithm 1\n\n```\nx = '$x$'\n```", "<pre>$x$</pre>",
    '### Algorithm 1\n\n```\nInput: str = "$x$"\ndef solve(values):\n    for value in values:\n        if value:\n            return "$y$"\n```',
    '### Algorithm 1\n\n```\ntext = """\nRequire: $x$\nfor each $y$ do\nend for\n"""\n```']) {
    const { root, nodes } = render(source);
    assert.equal(nodes.filter(node => node.localName === "math").length, 0, source);
    assert.ok(root.textContent.includes("$x$"));
  }
});

test("algorithm math never activates HTML, images or links and malformed math stays visible", () => {
  const source = '```algorithm\nRequire: $x$\n    <script>evil()</script> ![x](https://example.org/x) `code`\n    \\$literal \\{keep\\} $unclosed\n```';
  const { root, nodes } = render(source);
  assert.equal(nodes.filter(node => node.localName === "math").length, 1);
  assert.ok(!nodes.some(node => ["script", "img", "a"].includes(node.localName)));
  assert.match(root.textContent, /<script>evil\(\)<\/script>/u);
  assert.ok(root.textContent.includes("\\$literal \\{keep\\} $unclosed"));
});

test("Markdown tables retain column counts, escaped pipes and code cells", () => {
  const { nodes } = render("| Name | Value |\n| :--- | ---: |\n| a\\|b | `x|y` |\n");
  assert.equal(nodes.filter(n => n.localName === "table").length, 1);
  assert.equal(nodes.filter(n => n.localName === "th").length, 2);
  assert.equal(nodes.filter(n => n.localName === "td").length, 2);
  assert.equal(nodes.find(n => n.localName === "code").textContent, "x|y");
  assert.throws(() => render("| A | B |\n| --- | --- |\n| Only one |\n"), /列数/u);
});

test("HTML table renderer copies only safe nodes and preserves rowspan/colspan and inline math", () => {
  const { nodes, root } = render("<table><caption>Results</caption><tbody><tr><th rowspan=\"2\">Name</th><td colspan=\"2\"><b>Value</b> &amp; $x<y$</td></tr><tr><td>One</td><td>Two</td></tr></tbody></table>\n");
  assert.equal(nodes.filter(n => n.localName === "table").length, 1);
  assert.equal(nodes.find(n => n.localName === "th").getAttribute("rowspan"), "2");
  assert.equal(nodes.find(n => n.localName === "td").getAttribute("colspan"), "2");
  assert.ok(nodes.some(n => n.localName === "math"));
  assert.match(root.textContent, /Value &/u);
});

test("KaTeX MathML is imported using existing safety primitive when parser is available", () => {
  const doc = new Document();
  let markup = "";
  const math = doc.createElementNS("http://www.w3.org/1998/Math/MathML", "math");
  math.getElementsByTagName = () => [];
  doc.defaultView.DOMParser = class {
    parseFromString(value, type) {
      assert.equal(type, "application/xml"); markup += value;
      return { getElementsByTagName: () => [], getElementsByTagNameNS: () => [math] };
    }
  };
  doc.importNode = node => node;
  const { nodes } = render("A formula $x^2$.\n", doc);
  assert.match(markup, /<msup>/u);
  assert.ok(nodes.some(node => node.getAttribute("data-math-renderer") === "katex-0.18.4"));
});

test("bare LaTeX environments remain intact when sent to MathRenderer", () => {
  const received = [];
  const scope = { SmartPaperTranslatorModules: { MathRenderer: {
    appendMath: (doc, parent, source, display) => { received.push([source, display]); parent.append(doc.createElementNS("http://www.w3.org/1998/Math/MathML", "math")); }
  } } };
  vm.runInNewContext(fs.readFileSync(require.resolve("../plugin/content/fulltext-markdown.js"), "utf8"), scope);
  const doc = new Document(), root = doc.createElement("div");
  const matrix = String.raw`\begin{pmatrix}a & b \\ c & d\end{pmatrix}`;
  scope.SmartPaperTranslatorModules.FulltextMarkdown.renderMarkdown(doc, root, matrix);
  assert.equal(received[0][0], matrix); assert.equal(received[0][1], true);
  scope.SmartPaperTranslatorModules.FulltextMarkdown.renderMarkdown(doc, root, `$x$ and \\(y\\)`);
  assert.deepEqual(received.slice(1), [["x", false], ["y", false]]);
});

test("PNG, JPEG, GIF and WebP MIME/magic/dimensions are checked before assigning src", () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 8, 8, 0, 1, 0, 1, 0, 0xff, 0xd9]);
  const gif = Buffer.from("GIF89a\x01\x00\x01\x00\x80\x00\x00\x00\x00\x00\xff\xff\xff\x3b", "latin1");
  const webp = Buffer.alloc(30); webp.write("RIFF"); webp.writeUInt32LE(22, 4); webp.write("WEBPVP8X", 8); webp.writeUInt32LE(10, 16);
  const uris = [png, `data:image/jpeg;base64,${jpeg.toString("base64")}`, `data:image/gif;base64,${gif.toString("base64")}`, `data:image/webp;base64,${webp.toString("base64")}`];
  const { nodes } = render(uris.map(uri => `![plot](${uri})`).join("\n\n"));
  const images = nodes.filter(n => n.localName === "img");
  assert.equal(images.length, 4);
  assert.deepEqual(images.map(n => n.getAttribute("src")), uris);
  for (const image of images) assert.equal(image.getAttribute("width"), "1");
  const html = render(`<table><tr><td><img src="${png}" alt="plot"></td></tr></table>`);
  assert.equal(html.nodes.filter(n => n.localName === "img").length, 1);
});

test("unsafe HTML, remote/file images, scripts and local links never create active nodes or requests", () => {
  for (const source of [
    "<script>alert(1)</script>", "<iframe src=\"https://tracker.invalid\"></iframe>",
    "<table onclick=\"alert(1)\"><tr><td>Hello</td></tr></table>",
    "<table style=\"background:url(https://tracker.invalid)\"><tr><td>Hello</td></tr></table>",
    "<svg><image href=\"file:///secret\"></image></svg>",
    "<img src=\"https://tracker.invalid/x.png\">", "<img src=\"file:///secret.png\">",
    "![remote](https://tracker.invalid/x.png) ![local](file:///secret.png) [link](javascript:alert(1))"
  ]) {
    const { nodes, root } = render(source);
    assert.ok(!nodes.some(n => ["img", "script", "iframe", "svg", "a"].includes(n.localName)), source);
    assert.ok(root.textContent.length);
    for (const node of nodes) for (const key of node.attributes.keys()) assert.ok(!/^(?:on|src|href|style)/u.test(key));
  }
  const plan = roundtrip("<table onclick=\"alert(1)\"><tr><td>English</td></tr></table>\n");
  assert.equal(plan.segments[0].reason, "unsupported-html");
});

test("invalid, SVG, oversized and decompression-bomb data images fail before preview commit", () => {
  const hugeDimensions = Buffer.from(png.split(",")[1], "base64");
  hugeDimensions.writeUInt32BE(20000, 16);
  for (const uri of [
    "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=", png.replace("image/png", "image/jpeg"),
    "data:image/png;base64,AAAA", "data:image/png;base64,AB==", "data:image/png;base64,A===",
    `data:image/png;base64,${hugeDimensions.toString("base64")}`,
    `data:image/png;base64,${"A".repeat((M.MAX_IMAGE_BYTES / 3 + 1) * 4)}`
  ]) {
    const doc = new Document(), root = doc.createElement("div"), old = doc.createElement("p");
    old.textContent = "Previous preview"; root.append(old);
    assert.throws(() => M.renderMarkdown(doc, root, `![bad](${uri})`));
    assert.equal(root.children[0], old);
  }
});

test("table boundaries separate following prose without losing bytes; malformed tables are explicit", () => {
  const source = "Before table\n| A | B |\n| :--- | ---: |\n| X | Y |\nAfter table\n";
  const plan = roundtrip(source);
  assert.equal(plan.segments.filter(s => s.reason === "markdown-table").length, 1);
  const { nodes, root } = render(source);
  assert.equal(nodes.filter(n => n.localName === "p").length, 2);
  assert.match(root.textContent, /After table/u);
  assert.deepEqual(nodes.filter(n => n.localName === "th").map(n => n.getAttribute("align")), ["left", "right"]);
  assert.throws(() => M.createPlan("| A | B |\n| --- | --- |\n| X | Y | Z |\n"), /列数/u);
  for (const invalid of ["<table><td>Wrong parent</td></table>", "<table>Unwrapped text<tr><td>Cell</td></tr></table>"]) {
    const result = render(invalid);
    assert.ok(!result.nodes.some(n => n.localName === "table"));
    assert.equal(result.root.textContent, invalid);
  }
});

test("excessive lines, nested links and HTML depth fail with bounded errors", () => {
  assert.throws(() => M.createPlan("\n".repeat(100001)), /结构上限/u);
  let nested = "Label";
  for (let i = 0; i < 70; i++) nested = `[${nested}](https://example.invalid)`;
  assert.throws(() => M.createPlan(nested), /嵌套超过上限/u);
  assert.throws(() => render("<span>".repeat(70) + "Text" + "</span>".repeat(70)), /嵌套超过上限/u);
});

test("backslash hard breaks and HTML entities remain inert text", () => {
  const { nodes, root } = render("Line one\\\nLine two &lt;script&gt; &#x4e2d;&#25991; &amp; text\n");
  assert.equal(nodes.filter(n => n.localName === "br").length, 1);
  assert.match(root.textContent, /<script> 中文 & text/u);
  assert.ok(!nodes.some(n => n.localName === "script"));
  roundtrip("Plain \\$5, escaped \\*asterisk\\*, &amp; entity.\n");
});

test("OXR page comments are protected independently and do not swallow following body", () => {
  const source = "<!-- PDF pages 1-20 -->\nBody to translate.\n<!-- PDF pages 21-40 -->Same-line body\n\n<!-- long\n\npage comment -->\nMore body.\nInline <!-- comment --> body.\n";
  const plan = roundtrip(source);
  assert.equal(plan.segments.filter(s => s.reason === "comment").length, 3);
  for (const phrase of ["Body to translate", "Same-line body", "More body", "Inline"]) assert.ok(plan.segments.some(s => s.translatable && s.source.includes(phrase)));
  const translated = {};
  for (const s of plan.segments.filter(s => s.translatable)) {
    const p = M.prepareSegment(s);
    translated[s.id] = M.restoreTranslation(p, translate(p, text => text.replaceAll("body", "正文").replaceAll("Body", "正文")));
  }
  assert.match(M.assemble(plan, translated), /<!-- PDF pages 1-20 -->\n正文 to translate/u);
  assert.doesNotMatch(render(source).root.textContent, /PDF pages|page comment/u);
});

test("HTML code is protected and remote image/link destinations do not prevent cell translation", () => {
  roundtrip("<pre>const x = 1;\n\nconst y = 2;</pre>\n\nBody\n");
  const source = '<table><tr><td>English <code>x = "$x";</code></td><td><img src="https://example.invalid/x.png"><a href="file:///private">Link label</a></td></tr></table>\n';
  const s = segment(source), p = M.prepareSegment(s);
  assert.doesNotMatch(request(p), /\$x|https:|file:/u);
  const translated = M.restoreTranslation(p, translate(p, text => text.replace("English", "中文").replace("Link label", "链接标签")));
  assert.match(translated, /<code>x = "\$x";<\/code>/u);
  const { nodes, root } = render(translated);
  assert.ok(nodes.some(n => n.localName === "table"));
  assert.ok(!nodes.some(n => n.localName === "img" || n.localName === "a"));
  assert.match(root.textContent, /<img src="https:/u);
});

test("ordinary marker-like source roundtrips without reserved protocol syntax or hashing", () => {
  const code = fs.readFileSync(require.resolve("../plugin/content/fulltext-markdown.js"), "utf8");
  const scope = {};
  vm.runInNewContext(code, scope);
  const api = scope.SmartPaperTranslatorModules.FulltextMarkdown;
  for (const source of ["Text ⟦SPT_deadbeef_0⟧ [1]", "Text ⟦SPT_broken", "Text t0 t1"]) {
    const s = { id: "test", source, translatable: true };
    const a = api.prepareSegment(s), b = api.prepareSegment(s);
    assert.equal(JSON.stringify(a), JSON.stringify(b));
    assert.equal(api.restoreTranslation(a, a.units), source);
  }
});

test("Unicode whitespace around protected structures remains local, never an empty prose unit", () => {
  for (const space of ["\u00a0", "\u2009", "\u3000", "\ufeff"]) {
    const source = `${space}A $x$${space}$y$ B${space}`;
    const prepared = M.prepareSegment(segment(source));
    assert.deepEqual(prepared.units, [{ id: "t0", text: "A" }, { id: "t1", text: "B" }]);
    assert.equal(M.restoreTranslation(prepared, prepared.units), source);
    assert.equal(M.restoreTranslation(prepared, [{ id: "t0", text: "甲" }, { id: "t1", text: "乙" }]),
      `${space}甲 $x$${space}$y$ 乙${space}`);
  }
});

test("print CSS is static A4 Chinese typography without external resources", () => {
  assert.match(M.PRINT_CSS, /size: A4/u);
  assert.match(M.PRINT_CSS, /PingFang SC/u);
  assert.match(M.PRINT_CSS, /table-header-group/u);
  assert.doesNotMatch(M.PRINT_CSS, /url\(|@import|javascript:/iu);
});
