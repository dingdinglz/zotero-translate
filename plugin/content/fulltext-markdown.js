(function (global) {
  "use strict";

  const modules = global.SmartPaperTranslatorModules = global.SmartPaperTranslatorModules || {};
  const MAX_SOURCE_BYTES = 128 * 1024 * 1024;
  const MAX_SEGMENT_LENGTH = 16000;
  const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
  const MAX_TOTAL_IMAGE_BYTES = 64 * 1024 * 1024;
  const MAX_IMAGE_PIXELS = 40 * 1024 * 1024;
  const MAX_NODES = 100000;
  // Pure, synchronous helpers. The host owns serial requests, checkpoints and printing.
  // Send only prepareSegment(...).text to the model. tokens/source are LOCAL metadata;
  // they intentionally contain the original resources and must not be sent to a provider.
  // This is a conservative Markdown subset, not a repairing CommonMark parser. Unknown
  // HTML stays literal; ambiguous delimiters/oversized structures fail without truncation.
  // Structural validation cannot prove semantic fidelity or identify arbitrary prose
  // commentary; the host must still run its independent translation/proofreading step.
  const HTML_NS = "http://www.w3.org/1999/xhtml";
  const TAGS = new Set("table thead tbody tfoot tr td th caption colgroup col p div span b strong i em sub sup u s del br code pre ul ol li blockquote h1 h2 h3 h4 h5 h6 img a".split(" "));
  const VOID = new Set(["br", "col", "img"]);
  const PRINT_CSS = `@page { size: A4; margin: 18mm 16mm; }
html { color-scheme: light; background: white; color: #111; }
body { font-family: "Noto Serif CJK SC", "Source Han Serif SC", "Songti SC", "SimSun", serif; font-size: 11pt; line-height: 1.65; overflow-wrap: anywhere; }
h1,h2,h3,h4,h5,h6 { break-after: avoid; line-height: 1.3; }
p { orphans: 3; widows: 3; } pre { white-space: pre-wrap; overflow-wrap: anywhere; }
code,pre { font-family: "Noto Sans Mono", Menlo, monospace; font-size: 9pt; }
table { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 9pt; margin: 1em 0; }
th,td { border: 0.3mm solid #aaa; padding: 1.5mm; overflow-wrap: anywhere; }
thead { display: table-header-group; } tr,img { break-inside: avoid; }
img { max-width: 100%; height: auto; } math[display="block"] { margin: 1em 0; overflow-wrap: anywhere; }
blockquote { margin-inline: 1em; padding-inline-start: 1em; border-inline-start: 0.5mm solid #bbb; }
.spt-fulltext-source { white-space: pre-wrap; font-family: monospace; }
`;

  function fail(message) { throw new Error(`全文 Markdown：${message}`); }
  function assertString(value) { if (typeof value !== "string") fail("内容必须是字符串"); }
  function checkSource(source) {
    assertString(source);
    // Count without allocating another 128 MiB buffer; reject malformed UTF-16 too.
    let bytes = 0;
    for (let i = 0; i < source.length; i++) {
      const code = source.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        const low = source.charCodeAt(++i);
        if (!(low >= 0xdc00 && low <= 0xdfff)) fail("存在未配对的 Unicode 代理字符");
        bytes += 4;
      }
      else {
        if (code >= 0xdc00 && code <= 0xdfff) fail("存在未配对的 Unicode 代理字符");
        bytes += code < 128 ? 1 : code < 2048 ? 2 : 3;
      }
      if (bytes > MAX_SOURCE_BYTES) fail("原文超过 128 MiB UTF-8 上限");
    }
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(source)) fail("内容含不支持的控制字符");
  }
  function linesOf(source) {
    const lines = [];
    const pattern = /[^\r\n]*(?:\r\n|\r|\n|$)/gu;
    let match;
    while ((match = pattern.exec(source)) && match[0]) {
      if (lines.length >= MAX_NODES) fail("文档行数超过结构上限");
      lines.push(match[0]);
    }
    return lines;
  }
  function bare(line) { return line.replace(/[\r\n]+$/u, ""); }
  function headingAt(lines, index) {
    const line = bare(lines[index] || "");
    const atx = line.match(/^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/u);
    if (atx) return { level: atx[1].length, title: atx[2], length: 1 };
    if (line.trim() && index + 1 < lines.length && /^ {0,3}(?:=+|-+)[ \t]*$/u.test(bare(lines[index + 1]))) {
      return { level: bare(lines[index + 1]).trim()[0] === "=" ? 1 : 2, title: line.trim(), length: 2 };
    }
    return null;
  }
  function isReferences(title) {
    return /^(?:(?:\d+(?:\.\d+)*[.)]?|[IVX]+[.)]?)[ \t]+)?(?:references|bibliography|参考文献)[ \t]*[:：]?$/iu.test(title.replace(/[*_]/gu, "").trim());
  }
  function readTag(source, start) {
    if (source.startsWith("<!--", start)) {
      const end = source.indexOf("-->", start + 4);
      if (end < 0) fail("HTML 注释未闭合");
      return source.slice(start, end + 3);
    }
    if (!/^<\/?[A-Za-z]|^<!|^<\?/u.test(source.slice(start, start + 3))) return null;
    let quote = "";
    for (let i = start + 1; i < source.length; i++) {
      const ch = source[i];
      if (quote) { if (ch === quote) quote = ""; }
      else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === ">") return source.slice(start, i + 1);
    }
    fail("HTML 标签未闭合");
  }
  function tableEnd(source, start) {
    let depth = 0;
    const pattern = /<\/?table(?=\s|>)/giu;
    pattern.lastIndex = start;
    let match;
    while ((match = pattern.exec(source))) {
      const tag = readTag(source, match.index);
      if (/^<table(?:\s|>)/iu.test(tag)) depth++;
      if (/^<\/table\s*>$/iu.test(tag) && --depth === 0) return match.index + tag.length;
      pattern.lastIndex = match.index + tag.length;
    }
    fail("HTML 表格未闭合，不能按空行拆分");
  }
  function tableCells(line) {
    const value = line.trim().replace(/^\|/u, "").replace(/(?<!\\)\|$/u, "");
    if (/^[\s|:\-]+$/u.test(line)) return value.split("|").map(cell => cell.trim());
    const cells = [];
    let cell = "";
    for (const part of lex(value)) {
      if (part.kind === "structure" && part.value === "|") { cells.push(cell.trim()); cell = ""; }
      else cell += part.value;
    }
    cells.push(cell.trim());
    return cells;
  }
  function tableDelimiter(line) {
    return line.includes("|") && /^[\s|:\-]+$/u.test(line) && tableCells(line).every(cell => /^:?-{3,}:?$/u.test(cell));
  }
  function splitBlocks(source) {
    const lines = linesOf(source);
    const blocks = [];
    let i = 0;
    const push = (start, kind, extra = {}) => blocks.push({ source: lines.slice(start, i).join(""), kind, ...extra });
    while (i < lines.length) {
      const start = i;
      const line = bare(lines[i]);
      if (!line.trim()) { i++; push(start, "blank"); continue; }
      const fence = line.match(/^ {0,3}(`{3,}|~{3,})([^\r\n]*)$/u);
      if (fence) {
        const close = new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}[ \\t]*$`, "u");
        i++;
        while (i < lines.length && !close.test(bare(lines[i]))) i++;
        if (i === lines.length) fail("代码围栏未闭合");
        i++; push(start, "code"); continue;
      }
      if (/^\s*<!--/u.test(line)) {
        const remaining = lines.slice(i).join("");
        const commentStart = remaining.indexOf("<!--");
        const end = commentStart + readTag(remaining, commentStart).length;
        let consumed = 0;
        while (i < lines.length && consumed < end) consumed += lines[i++].length;
        blocks.push({ source: remaining.slice(0, end), kind: "comment" });
        const tail = remaining.slice(end, consumed);
        if (tail) { lines[i - 1] = tail; i--; }
        continue;
      }
      const htmlCode = line.match(/^\s*<(pre|code)(?:\s|>)/iu);
      if (htmlCode) {
        const remaining = lines.slice(i).join("");
        const close = new RegExp(`</${htmlCode[1]}\\s*>`, "iu").exec(remaining);
        if (!close) fail("HTML 代码块未闭合");
        const end = close.index + close[0].length;
        let consumed = 0;
        while (i < lines.length && consumed < end) consumed += lines[i++].length;
        if (remaining.slice(end, consumed).trim()) fail("HTML 代码块后有同一行正文，请先分行");
        push(start, "html-code"); continue;
      }
      if (/^\s*<table(?:\s|>)/iu.test(line)) {
        const remaining = lines.slice(i).join("");
        const end = tableEnd(remaining, remaining.indexOf("<"));
        let consumed = 0;
        while (i < lines.length && consumed < end) consumed += lines[i++].length;
        if (remaining.slice(end, consumed).trim()) fail("HTML 表格结束标签后有同一行正文，请先分行");
        push(start, "html-table"); continue;
      }
      const math = line.trimStart().match(/^(\$\$|\\\[|\\begin\{([A-Za-z*]+)\})/u);
      if (math) {
        const opener = math[1];
        const closer = opener === "$$" ? "$$" : opener === "\\[" ? "\\]" : `\\end{${math[2]}}`;
        const remaining = lines.slice(i).join("");
        const end = remaining.indexOf(closer, remaining.indexOf(opener) + opener.length);
        if (end < 0) fail("数学块未闭合");
        let consumed = 0;
        while (i < lines.length && consumed < end + closer.length) consumed += lines[i++].length;
        if (remaining.slice(end + closer.length, consumed).trim()) fail("数学块后有同一行正文，请先分行");
        push(start, "math"); continue;
      }
      if (line.includes("|") && i + 1 < lines.length && tableDelimiter(bare(lines[i + 1]))) {
        const columns = tableCells(line).length;
        if (tableCells(bare(lines[i + 1])).length !== columns) fail("Markdown 表格分隔行列数不一致");
        i += 2;
        while (i < lines.length && bare(lines[i]).trim() && bare(lines[i]).includes("|")) {
          if (tableCells(bare(lines[i])).length !== columns) fail("Markdown 表格列数不一致");
          i++;
        }
        push(start, "markdown-table"); continue;
      }
      const heading = headingAt(lines, i);
      if (heading) { i += heading.length; push(start, "heading", { heading }); continue; }
      if (/^(?: {4}|\t)/u.test(line) && !/^\s*(?:[-+*]|\d+[.)])[ \t]+/u.test(line)) {
        i++;
        while (i < lines.length && (/^(?: {4}|\t)/u.test(lines[i]) || !bare(lines[i]).trim())) i++;
        push(start, "indented-code"); continue;
      }
      i++;
      while (i < lines.length && bare(lines[i]).trim()) {
        if (headingAt(lines, i) || (bare(lines[i]).includes("|") && i + 1 < lines.length && tableDelimiter(bare(lines[i + 1]))) || /^ {0,3}(?:`{3,}|~{3,}|<(?:table|pre|code)\b|<!--|\$\$|\\\[|\\begin\{)/iu.test(bare(lines[i]))) break;
        i++;
      }
      push(start, "paragraph");
    }
    return blocks;
  }

  function balancedEnd(source, start, open, close) {
    let depth = 1;
    for (let i = start + open.length; i < source.length; i++) {
      if (source[i] === "\\") { i++; continue; }
      if (source[i] === open) depth++;
      else if (source[i] === close && --depth === 0) return i + 1;
    }
    fail("链接或图片括号未闭合");
  }
  function linkAt(source, start) {
    const image = source.startsWith("![", start);
    const opening = start + (image ? 1 : 0);
    if (source[opening] !== "[") return null;
    const end = balancedEnd(source, opening, "[", "]");
    if (source[end] === "(") {
      const finish = balancedEnd(source, end, "(", ")");
      return { image, label: source.slice(opening + 1, end - 1), destination: source.slice(end + 1, finish - 1), end, finish };
    }
    if (source[end] === "[") {
      const finish = balancedEnd(source, end, "[", "]");
      return { image, label: source.slice(opening + 1, end - 1), destination: null, end, finish };
    }
    return null;
  }
  function mathAt(source, i) {
    const start = source.slice(i);
    const environment = start.match(/^\\begin\{([A-Za-z*]+)\}/u);
    const opener = environment ? environment[0] : ["$$", "\\[", "\\(", "$"].find(value => start.startsWith(value));
    if (!opener) return null;
    const closer = environment ? `\\end{${environment[1]}}` : opener === "\\[" ? "\\]" : opener === "\\(" ? "\\)" : opener;
    let end = i + opener.length;
    while ((end = source.indexOf(closer, end)) >= 0) {
      let slashes = 0;
      for (let j = end - 1; j >= 0 && source[j] === "\\"; j--) slashes++;
      if (slashes % 2 === 0) return { end: end + closer.length,
        content: environment ? source.slice(i, end + closer.length) : source.slice(i + opener.length, end),
        display: opener !== "$" && opener !== "\\(" };
      end += closer.length;
    }
    fail("公式定界符未闭合（货币美元符请写为 \\$）");
  }
  function lex(source, depth = 0) {
    if (depth > 64) fail("链接嵌套超过上限");
    const parts = [];
    const add = (kind, value) => {
      if (!value) return;
      if (parts.length >= MAX_NODES) fail("结构节点过多");
      if (kind === "text" && parts.at(-1)?.kind === "text") parts.at(-1).value += value;
      else parts.push({ kind, value });
    };
    let i = 0;
    while (i < source.length) {
      const rest = source.slice(i);
      const lineStart = i === 0 || /[\r\n]/u.test(source[i - 1]);
      if (lineStart) {
        const fence = rest.match(/^ {0,3}(`{3,}|~{3,})[^\r\n]*(?:\r\n|\r|\n)/u);
        if (fence) {
          const lines = linesOf(rest);
          const close = new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}[ \\t]*$`, "u");
          let n = 1;
          while (n < lines.length && !close.test(bare(lines[n]))) n++;
          if (n === lines.length) fail("代码围栏未闭合");
          const value = lines.slice(0, n + 1).join(""); add("code", value); i += value.length; continue;
        }
        const definition = rest.match(/^ {0,3}\[[^\]\r\n]+\]:[^\r\n]*(?:\r\n|\r|\n|$)/u);
        if (definition) { add("definition", definition[0]); i += definition[0].length; continue; }
        const tableDelimiter = rest.match(/^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)+\|?[ \t]*(?=\r|\n|$)/u);
        if (tableDelimiter) { add("structure", tableDelimiter[0]); i += tableDelimiter[0].length; continue; }
        const rule = rest.match(/^ {0,3}(?:=+|-+|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})[ \t]*(?=\r|\n|$)/u);
        if (rule) { add("structure", rule[0]); i += rule[0].length; continue; }
        const prefix = rest.match(/^[ \t]*(?:(?:>[ \t]*)+)?(?:(?:#{1,6}|[-+*]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)?/u)?.[0];
        if (prefix) { add("structure", prefix); i += prefix.length; continue; }
      }
      const literalMarker = rest.match(/^⟦SPT_[^⟧\r\n]*⟧/u);
      if (literalMarker) { add("literal-marker", literalMarker[0]); i += literalMarker[0].length; continue; }
      const newline = rest.match(/^(?:\r\n|\r|\n)/u);
      if (newline) { add("newline", newline[0]); i += newline[0].length; continue; }
      const math = mathAt(source, i);
      if (math) { add("math", source.slice(i, math.end)); i = math.end; continue; }
      if (source[i] === "`") {
        const marker = rest.match(/^`+/u)[0];
        let end = source.indexOf(marker, i + marker.length);
        while (end >= 0 && (source[end - 1] === "`" || source[end + marker.length] === "`")) end = source.indexOf(marker, end + marker.length);
        if (end < 0) fail("行内代码未闭合");
        end += marker.length; add("code", source.slice(i, end)); i = end; continue;
      }
      if (source[i] === "\\" && i + 1 < source.length) { add("escape", source.slice(i, i + 2)); i += 2; continue; }
      if (source[i] === "<") {
        const auto = rest.match(/^<(?:[a-z][a-z\d+.-]*:[^<>\r\n]+|[^<>\s@]+@[^<>\s@]+)>/iu);
        if (auto) { add("url", auto[0]); i += auto[0].length; continue; }
        const tag = readTag(source, i);
        if (tag) {
          const codeTag = tag.match(/^<(pre|code)(?:\s|>)/iu);
          if (codeTag) {
            const closing = new RegExp(`</${codeTag[1]}\\s*>`, "iu").exec(source.slice(i + tag.length));
            if (!closing) fail("HTML 代码块未闭合");
            const end = i + tag.length + closing.index + closing[0].length;
            add("html-code", source.slice(i, end)); i = end; continue;
          }
          add(tag.startsWith("<!--") ? "comment" : "html", tag); i += tag.length; continue;
        }
      }
      const url = rest.match(/^(?:[a-z][a-z\d+.-]*:\/\/|data:|mailto:|file:|www\.)[^\s<>]+/iu);
      if (url) { add("url", url[0]); i += url[0].length; continue; }
      if (source[i] === "[" || source.startsWith("![", i)) {
        const citation = rest.match(/^\[(?:\d+[a-z]?(?:[ \t]*[–—−\-,;][ \t]*\d+[a-z]?)*)(?:[ \t]*)\]/iu);
        const link = linkAt(source, i);
        if (link) {
          if (link.image) { add("image", source.slice(i, link.finish)); }
          else {
            add("structure", "[");
            for (const part of lex(link.label, depth + 1)) add(part.kind, part.value);
            add("destination", source.slice(link.end - 1, link.finish));
          }
          i = link.finish; continue;
        }
        if (citation) { add("citation", citation[0]); i += citation[0].length; continue; }
      }
      const entity = rest.match(/^&(?:#[xX][\da-fA-F]+|#\d+|[A-Za-z][A-Za-z\d]+);/u);
      if (entity) { add("entity", entity[0]); i += entity[0].length; continue; }
      if ("*_~|#[]()<>!".includes(source[i])) { add("structure", source[i++]); continue; }
      // Collect prose in runs rather than quadratic per-character concatenation.
      const text = rest.match(/^[^\r\n\\`$<\[!*_~|#\]()>&⟦]+/u)?.[0];
      if (text) {
        // Stop before URLs even when they occur in the middle of a prose run.
        const urlIndex = text.search(/(?:[a-z][a-z\d+.-]*:\/\/|data:|mailto:|file:|www\.)/iu);
        const value = urlIndex > 0 ? text.slice(0, urlIndex) : text;
        add("text", value); i += value.length;
      }
      else { add("text", source[i++]); }
    }
    const result = [];
    for (const part of parts) {
      if (part.kind !== "text") { result.push(part); continue; }
      const leading = part.value.match(/^[ \t]+/u)?.[0] || "";
      const trailing = part.value.slice(leading.length).match(/[ \t]+$/u)?.[0] || "";
      if (leading) result.push({ kind: "space", value: leading });
      const value = part.value.slice(leading.length, part.value.length - trailing.length);
      if (value) result.push({ kind: "text", value });
      if (trailing) result.push({ kind: "space", value: trailing });
    }
    return result;
  }

  function countReferences(source) {
    const lines = linesOf(source).map(bare);
    const entries = lines.filter(line => /^\s*(?:\[\d+\]|\d+[.)]|[-+*])[ \t]*\S/u.test(line)).length;
    return entries || source.split(/(?:\r\n|\r|\n)[ \t]*(?:\r\n|\r|\n)/u).filter(value => value.trim()).length;
  }
  function createPlan(markdown) {
    checkSource(markdown);
    const blocks = splitBlocks(markdown);
    const segments = [];
    let referenceLevel = 0;
    let referenceText = "";
    let referenceCount = 0;
    const finishReferences = () => { referenceCount += countReferences(referenceText); referenceText = ""; };
    for (const block of blocks) {
      if (block.heading && referenceLevel && block.heading.level <= referenceLevel) { finishReferences(); referenceLevel = 0; }
      const startsReferences = block.heading && isReferences(block.heading.title);
      if (startsReferences) referenceLevel = block.heading.level;
      let reason = referenceLevel ? "references" : block.kind;
      let translatable = !referenceLevel && !["blank", "comment", "code", "html-code", "indented-code", "math"].includes(block.kind);
      if (referenceLevel && !block.heading && block.kind !== "comment") referenceText += block.source;
      if (translatable) {
        // Unsupported HTML is retained, not interpreted or selectively discarded.
        if (/<\/?[A-Za-z!]/u.test(block.source) && !safeHTMLParts(block.source)) {
          translatable = false; reason = "unsupported-html";
        }
        else {
          const parts = lex(block.source);
          translatable = parts.some(part => part.kind === "text" && /[\p{L}\p{N}]/u.test(part.value));
          if (!translatable) reason = "protected";
        }
      }
      const segment = { id: `s${String(segments.length + 1).padStart(6, "0")}`, source: block.source, translatable, reason };
      if (translatable) prepareSegment(segment);
      segments.push(segment);
    }
    finishReferences();
    return { segments, referenceCount };
  }

  function sourceMarker(source) {
    const Logic = modules.Logic || (typeof require === "function" ? require("./logic.js") : null);
    if (typeof Logic?.sha256Hex !== "function") fail("SHA-256 模块不可用，请先加载 Logic");
    const digest = Logic.sha256Hex(source).slice(0, 24);
    let value = digest;
    // Deterministic for resumed masked drafts. No random, process or session state.
    for (let collision = 0; source.includes(`⟦SPT_${value}_`); collision++) value = `${digest}_${collision}`;
    return value;
  }
  function prepareSegment(segment) {
    if (!segment || typeof segment.id !== "string" || !segment.translatable) fail("只能准备可翻译段落");
    checkSource(segment.source);
    const parts = lex(segment.source);
    const prefix = `⟦SPT_${sourceMarker(segment.source)}_`;
    const tokens = [];
    const text = parts.map(part => {
      if (part.kind === "text") return part.value;
      const marker = `${prefix}${tokens.length}⟧`;
      tokens.push({ marker, kind: part.kind, value: part.value });
      return marker;
    }).join("");
    if (text.length > MAX_SEGMENT_LENGTH) fail(`段落 ${segment.id} 超过 ${MAX_SEGMENT_LENGTH} UTF-16 单元的模型输入上限，请手动拆分结构，未截断`);
    return { version: 1, id: segment.id, text, prefix, tokens, source: segment.source };
  }
  function explanation(text) {
    return /^(?:here(?:'s| is| are)\b|(?:the )?(?:translated (?:text|version)|translation|explanation)\s*[:：]|(?:以下是|下面是|这是)(?:翻译|译文|校对)|(?:译文|翻译结果|说明)\s*[:：])/iu.test(text.trim());
  }
  function compareParts(original, translated) {
    const a = lex(original);
    const b = lex(translated);
    if (a.length !== b.length) fail("格式骨架或保护内容数量改变");
    for (let i = 0; i < a.length; i++) {
      if (a[i].kind !== b[i].kind || (a[i].kind !== "text" && a[i].value !== b[i].value)) fail("保护内容或格式骨架改变（标签、链接、公式、引文、列表或换行）");
      if (a[i].kind === "text") {
        if (/[\p{L}\p{N}]/u.test(a[i].value) && !/[\p{L}\p{N}]/u.test(b[i].value)) fail("正文内容缺失");
        if (!explanation(a[i].value) && explanation(b[i].value)) fail("拒绝解释性输出，请仅返回译文");
      }
    }
  }
  function validateRestored(segment, translatedSource) {
    if (!segment || typeof segment.source !== "string") fail("无效段落");
    checkSource(segment.source); checkSource(translatedSource);
    if (!segment.translatable) {
      if (translatedSource !== segment.source) fail("保护段落必须逐字保留");
      return translatedSource;
    }
    const prepared = prepareSegment(segment);
    // Resource-heavy source is permitted; unprotected translated prose remains bounded.
    const originalParts = lex(segment.source);
    const translatedParts = lex(translatedSource);
    const proseLength = translatedParts.reduce((sum, part) => sum + (part.kind === "text" ? part.value.length : 0), 0);
    const protectedLength = prepared.text.length - originalParts.reduce((sum, part) => sum + (part.kind === "text" ? part.value.length : 0), 0);
    if (proseLength + protectedLength > MAX_SEGMENT_LENGTH) fail("译文段落超过模型输出上限");
    compareParts(segment.source, translatedSource);
    return translatedSource;
  }
  function restoreTranslation(prepared, responseText) {
    assertString(responseText);
    if (!prepared || prepared.version !== 1 || !Array.isArray(prepared.tokens) || typeof prepared.prefix !== "string") fail("无效保护元数据");
    if (responseText.length > MAX_SEGMENT_LENGTH) fail("模型输出超过上限");
    checkSource(responseText);
    const expected = prepared.tokens.map(token => token.marker);
    const found = responseText.match(/⟦SPT_[^⟧\r\n]*⟧/gu) || [];
    if (found.length !== expected.length || found.some((marker, index) => marker !== expected[index]) || responseText.replace(/⟦SPT_[^⟧\r\n]*⟧/gu, "").includes("⟦SPT_")) fail("占位符缺失、新增、重复或乱序");
    let result = "";
    let offset = 0;
    for (const token of prepared.tokens) {
      const index = responseText.indexOf(token.marker, offset);
      if (index < 0) fail("占位符缺失");
      result += responseText.slice(offset, index) + token.value;
      offset = index + token.marker.length;
    }
    result += responseText.slice(offset);
    // Verify metadata against source as well; persisted preparation is not a trust boundary.
    return validateRestored({ id: prepared.id, source: prepared.source, translatable: true }, result);
  }
  function assemble(plan, translations) {
    if (!plan || !Array.isArray(plan.segments) || !translations || typeof translations !== "object") fail("无效计划或译文集合");
    const ids = new Set();
    const result = plan.segments.map(segment => {
      if (ids.has(segment.id)) fail("重复段落 ID");
      ids.add(segment.id);
      if (!segment.translatable) return segment.source;
      if (!Object.prototype.hasOwnProperty.call(translations, segment.id)) fail(`段落 ${segment.id} 缺少已验证译文`);
      return validateRestored(segment, translations[segment.id]);
    }).join("");
    checkSource(result);
    return result;
  }

  function decodeEntities(text) {
    const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0", ndash: "–", mdash: "—", times: "×", le: "≤", ge: "≥" };
    return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/giu, (all, value) => {
      if (value[0] !== "#") return named[value] || all;
      const number = value[1].toLowerCase() === "x" ? parseInt(value.slice(2), 16) : Number(value.slice(1));
      return number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff) ? String.fromCodePoint(number) : all;
    });
  }
  function parseTag(raw) {
    const match = raw.match(/^<(\/?)([A-Za-z][A-Za-z\d]*)([\s\S]*?)(\/?)>$/u);
    if (!match || !TAGS.has(match[2].toLowerCase())) return null;
    const name = match[2].toLowerCase();
    const closing = Boolean(match[1]);
    const attributes = {};
    let rest = match[3];
    if (closing) return !rest.trim() && !match[4] && !VOID.has(name) ? { name, closing, attributes } : null;
    while (rest.trim()) {
      const attr = rest.match(/^\s+([A-Za-z][A-Za-z\d-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`=]+))/u);
      if (!attr) return null;
      const key = attr[1].toLowerCase();
      const value = decodeEntities(attr[2] ?? attr[3] ?? attr[4]);
      if (Object.prototype.hasOwnProperty.call(attributes, key)) return null;
      if (["rowspan", "colspan"].includes(key)) {
        if (!["td", "th"].includes(name) || !/^[1-9]\d{0,2}$/u.test(value)) return null;
      }
      else if (["width", "height", "border", "cellpadding", "cellspacing"].includes(key)) {
        if (!/^\d{1,4}%?$/u.test(value)) return null;
      }
      else if (key === "align") { if (!/^(?:left|center|right)$/u.test(value)) return null; }
      else if (key === "valign") { if (!/^(?:top|middle|bottom)$/u.test(value)) return null; }
      // Destinations remain opaque for translation; the renderer never copies href
      // and only assigns src after the separate raster-data validator succeeds.
      else if (key === "src") { if (name !== "img") return null; }
      else if (key === "href") { if (name !== "a") return null; }
      else if (!["alt", "title"].includes(key)) return null;
      attributes[key] = value;
      rest = rest.slice(attr[0].length);
    }
    if (match[4] && !VOID.has(name)) return null;
    return { name, closing: false, attributes, void: VOID.has(name) };
  }
  function safeHTMLParts(source) {
    const parts = [];
    const stack = [];
    for (const part of lex(source)) {
      if (part.kind !== "html") {
        if (part.kind !== "comment" && ["table", "thead", "tbody", "tfoot", "tr", "colgroup"].includes(stack.at(-1)) && part.value.trim()) return null;
        if (parts.at(-1)?.text !== undefined) parts.at(-1).text += part.value;
        else parts.push({ text: part.value });
        continue;
      }
      const tag = parseTag(part.value);
      if (!tag) return null;
      if (tag.closing) { if (stack.pop() !== tag.name) return null; }
      else {
        const parent = stack.at(-1);
        const requiredParents = { thead: ["table"], tbody: ["table"], tfoot: ["table"], caption: ["table"], colgroup: ["table"], col: ["colgroup", "table"], tr: ["table", "thead", "tbody", "tfoot"], td: ["tr"], th: ["tr"] };
        const allowedChildren = { table: ["thead", "tbody", "tfoot", "caption", "colgroup", "col", "tr"], thead: ["tr"], tbody: ["tr"], tfoot: ["tr"], tr: ["td", "th"], colgroup: ["col"] };
        if (requiredParents[tag.name] && !requiredParents[tag.name].includes(parent)) return null;
        if (allowedChildren[parent] && !allowedChildren[parent].includes(tag.name)) return null;
        if (!tag.void) {
          if (stack.length >= 64) fail("HTML 嵌套超过上限");
          stack.push(tag.name);
        }
      }
      parts.push({ tag, raw: part.value });
      if (parts.length > MAX_NODES) fail("HTML 节点过多");
    }
    return stack.length ? null : parts;
  }

  function imageInfo(uri) {
    const match = uri.match(/^data:image\/(png|jpeg|gif|webp);base64,([A-Za-z\d+/]*={0,2})$/u);
    if (!match || !match[2] || match[2].length % 4) fail("图片不是受支持的规范 base64 PNG/JPEG/GIF/WebP");
    const size = match[2].length / 4 * 3 - (match[2].endsWith("==") ? 2 : match[2].endsWith("=") ? 1 : 0);
    if (size > MAX_IMAGE_BYTES) fail("单图超过 12 MiB");
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    if ((match[2].endsWith("==") && (alphabet.indexOf(match[2].at(-3)) & 15)) || (match[2].endsWith("=") && !match[2].endsWith("==") && (alphabet.indexOf(match[2].at(-2)) & 3))) fail("非规范 base64 尾部");
    const binary = typeof global.atob === "function" ? global.atob(match[2]) : typeof require === "function" ? require("node:buffer").Buffer.from(match[2], "base64").toString("latin1") : null;
    if (binary === null) fail("base64 解码器不可用");
    const byte = index => binary.charCodeAt(index);
    const be16 = index => byte(index) * 256 + byte(index + 1);
    const le16 = index => byte(index) + byte(index + 1) * 256;
    const be32 = index => byte(index) * 0x1000000 + byte(index + 1) * 0x10000 + byte(index + 2) * 256 + byte(index + 3);
    const le32 = index => byte(index) + byte(index + 1) * 256 + byte(index + 2) * 0x10000 + byte(index + 3) * 0x1000000;
    let width = 0, height = 0;
    if (match[1] === "png" && binary.startsWith("\x89PNG\r\n\x1a\n") && binary.slice(12, 16) === "IHDR" && binary.length >= 33) {
      width = be32(16); height = be32(20);
    }
    else if (match[1] === "gif" && /^GIF8[79]a/u.test(binary) && binary.length >= 13) {
      width = le16(6); height = le16(8);
    }
    else if (match[1] === "jpeg" && binary.startsWith("\xff\xd8\xff")) {
      let pos = 2;
      while (pos + 4 < binary.length) {
        if (byte(pos++) !== 0xff) break;
        while (byte(pos) === 0xff) pos++;
        const marker = byte(pos++);
        if (marker === 0xd9 || marker === 0xda) break;
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
        const length = be16(pos);
        if (length < 2 || pos + length > binary.length) break;
        if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 8) {
          height = be16(pos + 3); width = be16(pos + 5); break;
        }
        pos += length;
      }
    }
    else if (match[1] === "webp" && binary.startsWith("RIFF") && binary.slice(8, 12) === "WEBP" && le32(4) + 8 === binary.length) {
      const type = binary.slice(12, 16);
      if (type === "VP8X" && binary.length >= 30) {
        width = 1 + byte(24) + byte(25) * 256 + byte(26) * 65536;
        height = 1 + byte(27) + byte(28) * 256 + byte(29) * 65536;
      }
      else if (type === "VP8 " && binary.length >= 30 && binary.slice(23, 26) === "\x9d\x01\x2a") {
        width = le16(26) & 0x3fff; height = le16(28) & 0x3fff;
      }
      else if (type === "VP8L" && binary.length >= 25 && byte(20) === 0x2f) {
        width = 1 + byte(21) + ((byte(22) & 0x3f) << 8);
        height = 1 + (byte(22) >> 6) + (byte(23) << 2) + ((byte(24) & 0x0f) << 10);
      }
    }
    if (!width || !height || !Number.isFinite(width * height) || width > 16384 || height > 16384 || width * height > MAX_IMAGE_PIXELS) fail("图片 MIME、魔数或像素尺寸不匹配/超限");
    return { size, width, height };
  }

  function renderMarkdown(doc, container, source) {
    checkSource(source);
    if (!doc || !container) fail("缺少渲染文档或容器");
    const MathRenderer = modules.MathRenderer || (typeof require === "function" ? require("./math-renderer.js") : null);
    const root = doc.createElementNS(HTML_NS, "div");
    let nodes = 0;
    let imageBytes = 0;
    const element = name => {
      if (++nodes > MAX_NODES) fail("渲染节点超过上限");
      return doc.createElementNS(HTML_NS, name);
    };
    const text = (parent, value) => { if (++nodes > MAX_NODES) fail("渲染节点超过上限"); parent.append(doc.createTextNode(value)); };
    const fallback = (parent, value) => { const pre = element("pre"); pre.setAttribute("class", "spt-fulltext-source"); text(pre, value); parent.append(pre); };
    const appendMath = (parent, value, display) => {
      if (!MathRenderer?.appendMath) fail("MathML 渲染器不可用");
      if (++nodes > MAX_NODES) fail("渲染节点超过上限");
      MathRenderer.appendMath(doc, parent, value, display);
      const math = parent.lastElementChild || parent.children?.[parent.children.length - 1];
      nodes += math?.getElementsByTagName?.("*")?.length || 0;
      if (nodes > MAX_NODES) fail("MathML 节点超过上限");
    };
    const image = (parent, uri, alt, original) => {
      if (!uri.startsWith("data:")) { text(parent, original); return; }
      const info = imageInfo(uri);
      imageBytes += info.size;
      if (imageBytes > MAX_TOTAL_IMAGE_BYTES) fail("文档内嵌图片总量超过 64 MiB");
      const img = element("img");
      img.setAttribute("alt", alt);
      img.setAttribute("width", String(info.width));
      img.setAttribute("height", String(info.height));
      img.setAttribute("src", uri);
      parent.append(img);
    };
    const inline = (parent, value, depth = 0) => {
      if (depth > 64) fail("行内结构嵌套超过上限");
      let i = 0;
      while (i < value.length) {
        const rest = value.slice(i);
        const hardBreak = rest.match(/^(?: {2,}|\\)(?:\r\n|\r|\n)/u);
        if (hardBreak) { parent.append(element("br")); i += hardBreak[0].length; continue; }
        if (rest.startsWith("\\") && !/^\\(?:\[|\(|begin\{)/u.test(rest)) { text(parent, value[i + 1] || "\\"); i += value[i + 1] ? 2 : 1; continue; }
        const math = mathAt(value, i);
        if (math) { appendMath(parent, math.content, math.display); i = math.end; continue; }
        if (value[i] === "`") {
          const marker = rest.match(/^`+/u)[0];
          const end = value.indexOf(marker, i + marker.length);
          if (end < 0) fail("行内代码未闭合");
          const code = element("code"); text(code, value.slice(i + marker.length, end)); parent.append(code); i = end + marker.length; continue;
        }
        if (value[i] === "[" || rest.startsWith("![")) {
          const link = linkAt(value, i);
          if (link) {
            if (link.image) {
              const destination = link.destination?.trim().match(/^(?:<([^<>]+)>|(\S+))(?:\s+["'][\s\S]*["'])?$/u);
              image(parent, destination?.[1] || destination?.[2] || "", link.label, value.slice(i, link.finish));
            }
            else inline(parent, link.label, depth + 1); // No href: neither remote nor local navigation.
            i = link.finish; continue;
          }
        }
        const marker = ["**", "__", "~~", "*", "_"].find(candidate => rest.startsWith(candidate));
        if (marker) {
          const end = value.indexOf(marker, i + marker.length);
          if (end > i + marker.length) {
            const child = element(marker === "~~" ? "del" : marker.length === 2 ? "strong" : "em");
            inline(child, value.slice(i + marker.length, end), depth + 1); parent.append(child); i = end + marker.length; continue;
          }
        }
        if (value[i] === "<") {
          // Parse only our own lexical, non-executing tree; never pass HTML to a live parser.
          const tag = readTag(value, i);
          if (tag) {
            if (tag.startsWith("<!--")) { i += tag.length; continue; }
            const parsed = parseTag(tag);
            if (parsed && !parsed.closing) {
              const close = `</${parsed.name}>`;
              const end = parsed.void ? i + tag.length : value.toLowerCase().indexOf(close, i + tag.length) + close.length;
              if (end > i + tag.length || parsed.void) {
                const fragment = value.slice(i, end);
                if (["code", "pre"].includes(parsed.name)) {
                  const node = element(parsed.name);
                  text(node, decodeEntities(value.slice(i + tag.length, end - close.length)));
                  parent.append(node); i = end; continue;
                }
                if (renderHTML(parent, fragment, depth + 1)) { i = end; continue; }
              }
            }
            text(parent, tag); i += tag.length; continue;
          }
        }
        const run = rest.match(/^[^\\$`\[!*_~<]+/u)?.[0] || value[i];
        const breakIndex = run.search(/ {2,}(?:\r\n|\r|\n)/u);
        const valueText = breakIndex > 0 ? run.slice(0, breakIndex) : run;
        text(parent, decodeEntities(valueText)); i += valueText.length;
      }
    };
    const renderHTML = (parent, value, depth = 0) => {
      const parts = safeHTMLParts(value);
      if (!parts) return false;
      const fragment = element("div");
      const stack = [fragment];
      for (const part of parts) {
        if (part.text !== undefined) { inline(stack.at(-1), part.text, depth + 1); continue; }
        const tag = part.tag;
        if (tag.closing) { stack.pop(); continue; }
        if (tag.name === "img") { image(stack.at(-1), tag.attributes.src || "", tag.attributes.alt || "", part.raw); continue; }
        const node = element(tag.name === "a" ? "span" : tag.name);
        for (const [key, value] of Object.entries(tag.attributes)) {
          if (["rowspan", "colspan", "title", "align", "valign"].includes(key)) node.setAttribute(key, value);
        }
        stack.at(-1).append(node);
        if (!tag.void) stack.push(node);
      }
      for (const child of Array.from(fragment.childNodes || fragment.children)) parent.append(child);
      return true;
    };
    const renderBlocks = (parent, markdown, depth = 0) => {
      if (depth > 64) fail("块嵌套超过上限");
      for (const block of splitBlocks(markdown)) {
        const value = block.source;
        if (block.kind === "blank" || block.kind === "comment") continue;
        if (block.kind === "html-code") { inline(parent, value); continue; }
        if (block.kind === "html-table") { if (!renderHTML(parent, value)) fallback(parent, value); continue; }
        if (block.kind === "code" || block.kind === "indented-code") {
          const pre = element("pre"), code = element("code");
          const lines = linesOf(value);
          text(code, block.kind === "code" ? lines.slice(1, -1).join("") : lines.map(line => line.replace(/^(?: {4}|\t)/u, "")).join(""));
          pre.append(code); parent.append(pre); continue;
        }
        if (block.kind === "math") { const math = mathAt(value, value.search(/\S/u)); appendMath(parent, math.content, true); continue; }
        if (block.heading) { const h = element(`h${block.heading.level}`); inline(h, block.heading.title); parent.append(h); continue; }
        if (/<\/?[A-Za-z!]/u.test(value) && !safeHTMLParts(value)) { fallback(parent, value); continue; }
        const lines = linesOf(value).map(bare);
        if (block.kind === "markdown-table") {
          const header = tableCells(lines[0]);
          const alignment = tableCells(lines[1]).map(cell => cell.endsWith(":") ? cell.startsWith(":") ? "center" : "right" : "left");
          if (alignment.length !== header.length) fail("Markdown 表格分隔行列数不一致");
          const table = element("table"), head = element("thead"), body = element("tbody");
          const rows = [header, ...lines.slice(2).filter(line => line.trim()).map(tableCells)];
          rows.forEach((cells, rowIndex) => {
            if (cells.length !== header.length) fail("Markdown 表格列数不一致");
            const row = element("tr");
            cells.forEach((cell, column) => { const node = element(rowIndex ? "td" : "th"); node.setAttribute("align", alignment[column]); inline(node, cell); row.append(node); });
            (rowIndex ? body : head).append(row);
          });
          table.append(head, body); parent.append(table); continue;
        }
        let index = 0;
        while (index < lines.length) {
          const line = lines[index];
          if (/^ {0,3}>/u.test(line)) {
            const quote = [];
            while (index < lines.length && /^ {0,3}>/u.test(lines[index])) quote.push(lines[index++].replace(/^ {0,3}>[ \t]?/u, ""));
            const node = element("blockquote"); renderBlocks(node, quote.join("\n"), depth + 1); parent.append(node); continue;
          }
          const listMatch = line.match(/^([ \t]*)([-+*]|\d+[.)])[ \t]+(.*)$/u);
          if (listMatch) {
            const list = element(/^\d/u.test(listMatch[2]) ? "ol" : "ul");
            if (/^\d/u.test(listMatch[2])) list.setAttribute("start", String(parseInt(listMatch[2], 10)));
            while (index < lines.length) {
              const item = lines[index].match(/^([ \t]*)([-+*]|\d+[.)])[ \t]+(.*)$/u);
              if (!item || item[1].length !== listMatch[1].length || /^\d/u.test(item[2]) !== /^\d/u.test(listMatch[2])) break;
              const li = element("li"); inline(li, item[3]); index++;
              const continuation = [];
              while (index < lines.length && lines[index].match(/^[ \t]*/u)[0].length > item[1].length) continuation.push(lines[index++].slice(item[1].length + 2));
              if (continuation.length) renderBlocks(li, continuation.join("\n"), depth + 1);
              list.append(li);
            }
            parent.append(list); continue;
          }
          if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/u.test(line)) { parent.append(element("hr")); index++; continue; }
          const p = element("p");
          const paragraph = [lines[index++]];
          while (index < lines.length && !/^\s*(?:>|[-+*][ \t]+|\d+[.)][ \t]+)/u.test(lines[index])) paragraph.push(lines[index++]);
          inline(p, paragraph.join("\n")); parent.append(p);
        }
      }
    };
    renderBlocks(root, source);
    // Commit only a completely rendered document; exceptions keep the old preview intact.
    container.replaceChildren(...Array.from(root.childNodes || root.children));
  }

  modules.FulltextMarkdown = {
    MAX_SOURCE_BYTES, MAX_SEGMENT_LENGTH, MAX_IMAGE_BYTES, MAX_TOTAL_IMAGE_BYTES, MAX_IMAGE_PIXELS,
    PRINT_CSS, createPlan, prepareSegment, restoreTranslation, validateRestored, assemble, renderMarkdown
  };
  if (typeof module !== "undefined" && module.exports) module.exports = modules.FulltextMarkdown;
})(typeof globalThis !== "undefined" ? globalThis : this);
