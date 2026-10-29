"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const M = require("../plugin/content/fulltext-markdown.js");

function roundtrip(source) {
  const plan = M.createPlan(source);
  assert.equal(plan.segments.map(segment => segment.source).join(""), source);
  const translations = {};
  for (const segment of plan.segments) {
    if (!segment.translatable) continue;
    const prepared = JSON.parse(JSON.stringify(M.prepareSegment(segment)));
    translations[segment.id] = M.restoreTranslation(prepared, prepared.text);
    assert.equal(M.validateRestored(segment, translations[segment.id]), segment.source);
  }
  assert.equal(M.assemble(plan, translations), source);
  return plan;
}
function segment(source) {
  const plan = M.createPlan(source);
  assert.equal(plan.segments.length, 1);
  assert.equal(plan.segments[0].translatable, true);
  return plan.segments[0];
}
class Node {
  constructor(name, value = "") { this.localName = name; this.value = value; this.children = []; this.attributes = new Map(); }
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
  for (const literal of ["[1]", "[2–4]", "[7, 9-11]", "$x<y$", "\\(z_1\\)", "**", "> "]) assert.ok(!p.text.includes(literal));
  const translated = M.restoreTranslation(p, p.text.replace("Evidence", "证据").replace("Quoted English", "引用的英文"));
  assert.match(translated, /^> 证据 \[1\]/u);
  assert.match(translated, /\*\*引用的英文\*\*/u);
  roundtrip("1. First **bold** point\n2. Second `const a = \"<script>\";` point\n  - Nested point\n- [x] Complete\n");
  const links = segment("See [the paper](https://example.invalid/a_(b) \"Title\"), https://example.invalid/q?a=1 and <https://example.invalid/>.\n");
  assert.doesNotMatch(M.prepareSegment(links).text, /https:|Title/u);
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

test("images and arbitrarily large base64 payload never enter model text", () => {
  const large = `data:image/png;base64,${"A".repeat(200000)}`;
  const source = `Figure description ![plot](${large}) and conclusion.\n`;
  const s = segment(source), p = M.prepareSegment(s);
  assert.ok(p.text.length < 500);
  assert.doesNotMatch(p.text, /data:image|AAAA/u);
  assert.equal(M.restoreTranslation(p, p.text), source);
  const html = segment(`<table><tr><td>Image</td><td><img src="${png}" alt="plot"></td></tr></table>\n`);
  assert.doesNotMatch(M.prepareSegment(html).text, /base64|iVBOR/u);
  roundtrip(`![plot](${png})\n`);
});

test("model input cap counts masked text, not raw resources; Unicode UTF-8 cap is explicit", () => {
  assert.equal(M.MAX_SOURCE_BYTES, 128 * 1024 * 1024);
  assert.throws(() => M.createPlan("a".repeat(M.MAX_SEGMENT_LENGTH + 1)), /上限/u);
  assert.throws(() => M.createPlan("汉".repeat(Math.floor(M.MAX_SOURCE_BYTES / 3) + 1)), /128 MiB/u);
  assert.throws(() => M.createPlan("bad\ud800text"), /Unicode/u);
  assert.throws(() => M.createPlan("bad\u0000text"), /控制字符/u);
});

test("uncertain or unclosed structure fails explicitly and never truncates", () => {
  for (const source of ["```js\ntext", "~~~\ntext", "$$x\n\ny", "\\[x", "Text $x", "<table><tr><td>Cell</td></tr>", "[link](https://x", "Text `code", "<!-- missing"]) {
    assert.throws(() => M.createPlan(source), /未闭合/u, source);
  }
  assert.throws(() => M.createPlan("<table><tr><td>A</td></tr></table> trailing prose"), /先分行/u);
});

test("protected markers are deterministic across restarts, serializable and collision checked", () => {
  const s = segment("Text ⟦SPT_deadbeef_0⟧ and [1].\n");
  const a = M.prepareSegment(s), b = M.prepareSegment(s);
  assert.equal(a.prefix, b.prefix);
  assert.equal(a.text, b.text);
  assert.equal(a.text, M.prepareSegment({ ...s, id: "another-id" }).text);
  assert.ok(!s.source.includes(a.prefix));
  assert.equal(M.restoreTranslation(JSON.parse(JSON.stringify(a)), a.text), s.source);
  assert.throws(() => M.restoreTranslation(a, a.text + "⟦SPT_broken"), /占位符/u);
});

test("missing, duplicated, extra and reordered tokens are rejected", () => {
  const p = M.prepareSegment(segment("Text [1] and $x$.\n"));
  const first = p.tokens[0].marker, second = p.tokens[1].marker;
  for (const response of [
    p.text.replace(first, ""), p.text + first, p.text + "⟦SPT_ffffffff_999⟧",
    p.text.replace(first, "TEMP").replace(second, first).replace("TEMP", second)
  ]) assert.throws(() => M.restoreTranslation(p, response), /占位符/u);
});

test("restoration rejects explanation, code wrappers, active HTML, extra resources and line damage", () => {
  const p = M.prepareSegment(segment("A paragraph [1].\n"));
  for (const response of [
    `Here is the translation: ${p.text}`, `译文：${p.text}`, `\`\`\`markdown\n${p.text}\n\`\`\``,
    p.text.replace("A paragraph", "<script>alert(1)</script>"),
    p.text.replace("A paragraph", "![x](https://tracking.invalid/image.png)"),
    p.text.replace("A paragraph", "<img src=x onerror=alert(1)>"),
    p.text.replace("A paragraph", "line\nline"),
    p.text.replace("A paragraph", "https://unexpected.invalid"),
    p.text.replace("A paragraph", "")
  ]) assert.throws(() => M.restoreTranslation(p, response));
  assert.throws(() => M.restoreTranslation(p, "x".repeat(M.MAX_SEGMENT_LENGTH + 1)), /上限/u);
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
  const p = M.prepareSegment(segment("Text [1]\n"));
  p.tokens.find(t => t.kind === "citation").value = "[999]";
  assert.throws(() => M.restoreTranslation(p, p.text), /保护内容/u);
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
    translated[s.id] = M.restoreTranslation(p, p.text.replaceAll("body", "正文").replaceAll("Body", "正文"));
  }
  assert.match(M.assemble(plan, translated), /<!-- PDF pages 1-20 -->\n正文 to translate/u);
  assert.doesNotMatch(render(source).root.textContent, /PDF pages|page comment/u);
});

test("HTML code is protected and remote image/link destinations do not prevent cell translation", () => {
  roundtrip("<pre>const x = 1;\n\nconst y = 2;</pre>\n\nBody\n");
  const source = '<table><tr><td>English <code>x = "$x";</code></td><td><img src="https://example.invalid/x.png"><a href="file:///private">Link label</a></td></tr></table>\n';
  const s = segment(source), p = M.prepareSegment(s);
  assert.doesNotMatch(p.text, /\$x|https:|file:/u);
  const translated = M.restoreTranslation(p, p.text.replace("English", "中文").replace("Link label", "链接标签"));
  assert.match(translated, /<code>x = "\$x";<\/code>/u);
  const { nodes, root } = render(translated);
  assert.ok(nodes.some(n => n.localName === "table"));
  assert.ok(!nodes.some(n => n.localName === "img" || n.localName === "a"));
  assert.match(root.textContent, /<img src="https:/u);
});

test("deterministic marker collision is resolved without modifying source", () => {
  const code = fs.readFileSync(require.resolve("../plugin/content/fulltext-markdown.js"), "utf8");
  const scope = { SmartPaperTranslatorModules: { Logic: { sha256Hex: () => "a".repeat(64) } } };
  vm.runInNewContext(code, scope);
  const api = scope.SmartPaperTranslatorModules.FulltextMarkdown;
  const source = `Text ⟦SPT_${"a".repeat(24)}_0⟧ [1]`;
  const s = { id: "test", source, translatable: true };
  const a = api.prepareSegment(s), b = api.prepareSegment(s);
  assert.equal(a.prefix, `⟦SPT_${"a".repeat(24)}_0_`);
  assert.equal(a.text, b.text);
  assert.equal(api.restoreTranslation(a, a.text), source);
});

test("print CSS is static A4 Chinese typography without external resources", () => {
  assert.match(M.PRINT_CSS, /size: A4/u);
  assert.match(M.PRINT_CSS, /Songti SC/u);
  assert.match(M.PRINT_CSS, /table-header-group/u);
  assert.doesNotMatch(M.PRINT_CSS, /url\(|@import|javascript:/iu);
});
