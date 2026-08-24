(function (global) {
  "use strict";

  const modules = global.SmartPaperTranslatorModules = global.SmartPaperTranslatorModules || {};
  const Constants = modules.Constants || (
    typeof require === "function" ? require("./constants.js") : null
  );
  const CodexChat = modules.CodexChat || (
    typeof require === "function" ? require("./codex-chat.js") : null
  );
  const MathRenderer = modules.MathRenderer || (
    typeof require === "function" ? require("./math-renderer.js") : null
  );
  const PDFScreenshot = modules.PDFScreenshot || (
    typeof require === "function" ? require("./pdf-screenshot.js") : null
  );

  const CODEX_L10N_RESOURCE = "smart-paper-translator-codex-chat.ftl";
  const LEGACY_CODEX_L10N_RESOURCE = "smart-paper-translator.ftl";
  const CODEX_HEADER_L10N_ID = "smart-paper-translator-codex-chat-pane-header";
  const CODEX_SIDENAV_L10N_ID = "smart-paper-translator-codex-chat-pane-sidenav";

  function ensureCodexLocalization(win) {
    const doc = win?.document;
    if (!doc) return null;
    const localizationLinks = () => Array.from(
      doc.querySelectorAll?.('link[rel="localization"]') || []
    );
    for (const link of localizationLinks()) {
      if (link.getAttribute("href") === LEGACY_CODEX_L10N_RESOURCE) link.remove();
    }
    win.MozXULElement?.insertFTLIfNeeded?.(CODEX_L10N_RESOURCE);
    return localizationLinks().find(
      (link) => link.getAttribute("href") === CODEX_L10N_RESOURCE
    ) || null;
  }

  function resolveReaderAttachmentID(body, zotero = global.Zotero) {
    const details = body?.closest?.("item-details");
    const tabID = details?.tabID || details?.dataset?.tabId;
    if (!tabID || typeof zotero?.Reader?.getByTabID !== "function") return null;
    const reader = zotero.Reader.getByTabID(tabID);
    const attachmentID = Number(reader?.itemID);
    return Number.isSafeInteger(attachmentID) && attachmentID > 0 ? attachmentID : null;
  }

  function selectionPageLabel(selection) {
    const location = selection?.location || {};
    const firstPage = location.pageLabel || location.pageNumber || "?";
    if (!location.nextPage) return `第 ${firstPage} 页`;
    return `第 ${firstPage}–${location.nextPage.pageNumber} 页`;
  }

  function screenshotPageLabel(screenshot) {
    const location = screenshot?.location || {};
    return `第 ${location.pageLabel || location.pageNumber || "?"} 页`;
  }

  function screenshotPositionSummary(screenshot) {
    const location = screenshot?.location || {};
    const rect = Array.isArray(location.rect) ? location.rect : [];
    const pixelSize = location.pixelSize || {};
    const coordinates = rect.length === 4
      ? rect.map((value) => Number(value).toFixed(1)).join(", ")
      : "位置不可用";
    return `${pixelSize.width || "?"} × ${pixelSize.height || "?"} px · PDF 坐标 [${coordinates}]`;
  }

  function setAttribute(element, name, value) {
    if (typeof element.setAttribute === "function") element.setAttribute(name, value);
    else element[name] = value;
  }

  function normalizeExternalURL(value) {
    const url = String(value || "").trim();
    if (!/^https?:\/\//iu.test(url)) throw new Error("只允许打开 HTTP 或 HTTPS 链接");
    let parsed;
    try {
      parsed = new URL(url);
    }
    catch (_error) {
      throw new Error("链接地址无效");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("只允许打开 HTTP 或 HTTPS 链接");
    }
    return url;
  }

  function openExternalURL(value, zotero = global.Zotero) {
    const url = normalizeExternalURL(value);
    if (typeof zotero?.launchURL !== "function") {
      throw new Error("当前 Zotero 无法调用系统浏览器");
    }
    zotero.launchURL(url);
    return url;
  }

  function configureExternalLink(link, value, options = {}) {
    const url = normalizeExternalURL(value);
    link.href = url;
    link.rel = "noopener noreferrer";
    link.target = "_blank";
    link.title = url;
    setAttribute(link, "tooltiptext", url);
    const launch = typeof options.onExternalLink === "function"
      ? options.onExternalLink
      : (href) => openExternalURL(href);
    link.addEventListener("click", (event) => {
      event?.preventDefault?.();
      event?.stopPropagation?.();
      try {
        const result = launch(url);
        if (result && typeof result.then === "function") {
          result.catch((error) => options.onExternalLinkError?.(error));
        }
      }
      catch (error) {
        if (typeof options.onExternalLinkError === "function") {
          options.onExternalLinkError(error);
        }
        else global.Zotero?.logError?.(error);
      }
    });
    return link;
  }

  function parseDirectiveAttributes(source) {
    const attributes = {};
    const pattern = /([A-Za-z_][\w-]*)\s*=\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^\s}]+))/gu;
    let match;
    while ((match = pattern.exec(source))) {
      attributes[match[1]] = String(match[2] ?? match[3] ?? match[4] ?? "")
        .replace(/\\([\\"'])/gu, "$1");
    }
    return attributes;
  }

  function parseCodexDirectiveAt(source, start) {
    const heading = source.slice(start).match(/^(?:::([A-Za-z][\w-]*)|:(codex-file-citation))\{/u);
    if (!heading) return null;
    let index = start + heading[0].length;
    const attributesStart = index;
    let quote = null;
    let escaped = false;
    while (index < source.length) {
      const character = source[index];
      if (escaped) escaped = false;
      else if (character === "\\" && quote) escaped = true;
      else if (quote && character === quote) quote = null;
      else if (!quote && (character === '"' || character === "'")) quote = character;
      else if (!quote && character === "}") {
        const raw = source.slice(start, index + 1);
        return {
          raw,
          length: raw.length,
          name: heading[1] || heading[2],
          attributes: parseDirectiveAttributes(source.slice(attributesStart, index))
        };
      }
      index++;
    }
    return null;
  }

  function basename(path) {
    return String(path || "").split(/[\\/]/u).filter(Boolean).at(-1) || "文件";
  }

  function appendCodexDirective(doc, parent, directive, options) {
    const attributes = directive.attributes;
    if (directive.name === "codex-file-citation") {
      const path = attributes.path || attributes.file;
      if (!path) return false;
      const start = attributes.line || attributes.start || attributes.line_range_start;
      const end = attributes.end || attributes.line_range_end;
      const label = `${basename(path)}${start ? `:${start}${end && end !== start ? `–${end}` : ""}` : ""}`;
      const citation = doc.createElement(typeof options.onFileCitation === "function" ? "button" : "span");
      citation.className = "spt-codex-file-citation";
      citation.textContent = `▧ ${label}`;
      citation.title = path;
      if (citation.localName === "button") {
        citation.type = "button";
        citation.addEventListener("click", () => options.onFileCitation({ path, start, end }));
      }
      parent.append(citation);
      return true;
    }
    if (directive.name === "code-comment") {
      const file = attributes.file || attributes.path;
      const start = attributes.start || attributes.line;
      const comment = doc.createElement("span");
      comment.className = "spt-codex-code-comment";
      const location = file ? `${basename(file)}${start ? `:${start}` : ""}` : "代码审查";
      comment.textContent = `${attributes.title || "代码批注"} · ${location}`;
      comment.title = attributes.body || file || "";
      parent.append(comment);
      return true;
    }
    if (directive.name === "created-thread") {
      const badge = doc.createElement("span");
      badge.className = "spt-codex-directive-badge";
      badge.textContent = "已创建 Codex 任务";
      parent.append(badge);
      return true;
    }
    return false;
  }

  function appendSafeInline(doc, parent, source, options = {}, depth = 0) {
    const text = String(source || "");
    if (depth > 12) {
      parent.append(doc.createTextNode(text));
      return;
    }
    let index = 0;
    const appendNested = (element, value) => {
      appendSafeInline(doc, element, value, options, depth + 1);
      parent.append(element);
    };
    while (index < text.length) {
      if (text[index] === "\n") {
        parent.append(doc.createElement("br"));
        index++;
        continue;
      }
      if (text[index] === "\\" && text[index + 1] === "(") {
        const end = text.indexOf("\\)", index + 2);
        if (end !== -1) {
          MathRenderer.appendMath(doc, parent, text.slice(index + 2, end));
          index = end + 2;
          continue;
        }
      }
      if (text[index] === "\\" && /[\\`*_[\]{}()#+.!~-]/u.test(text[index + 1] || "")) {
        parent.append(doc.createTextNode(text[index + 1]));
        index += 2;
        continue;
      }
      if (text[index] === "`" && text[index + 1] !== "`") {
        const end = text.indexOf("`", index + 1);
        if (end !== -1) {
          const code = doc.createElement("code");
          code.className = "spt-codex-inline-code";
          code.textContent = text.slice(index + 1, end);
          parent.append(code);
          index = end + 1;
          continue;
        }
      }
      if (text.startsWith("::", index) || text.startsWith(":codex-file-citation{", index)) {
        const directive = parseCodexDirectiveAt(text, index);
        if (directive && appendCodexDirective(doc, parent, directive, options)) {
          index += directive.length;
          continue;
        }
      }
      if (text.startsWith("![", index)) {
        const image = text.slice(index).match(/^!\[([^\]]*)\]\(([^\s)]+)(?:\s+["'][^"']*["'])?\)/u);
        if (image) {
          const placeholder = doc.createElement("span");
          placeholder.className = "spt-codex-image-placeholder";
          placeholder.textContent = image[1] ? `图片：${image[1]}（未自动加载）` : "图片（未自动加载）";
          parent.append(placeholder);
          index += image[0].length;
          continue;
        }
      }
      if (text[index] === "[") {
        const linkMatch = text.slice(index).match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)(?:\s+["'][^"']*["'])?\)/iu);
        if (linkMatch) {
          const link = configureExternalLink(doc.createElement("a"), linkMatch[2], options);
          appendSafeInline(doc, link, linkMatch[1], options, depth + 1);
          parent.append(link);
          index += linkMatch[0].length;
          continue;
        }
      }
      if (text.startsWith("**", index) || text.startsWith("__", index)) {
        const marker = text.slice(index, index + 2);
        const end = text.indexOf(marker, index + 2);
        if (end > index + 2) {
          appendNested(doc.createElement("strong"), text.slice(index + 2, end));
          index = end + 2;
          continue;
        }
      }
      if (text.startsWith("~~", index)) {
        const end = text.indexOf("~~", index + 2);
        if (end > index + 2) {
          appendNested(doc.createElement("del"), text.slice(index + 2, end));
          index = end + 2;
          continue;
        }
      }
      if (text[index] === "*" || text[index] === "_") {
        const marker = text[index];
        const end = text.indexOf(marker, index + 1);
        const previous = text[index - 1] || " ";
        const next = text[index + 1] || " ";
        if (end > index + 1 && (!/\w/u.test(previous) || marker === "*") && !/\s/u.test(next)) {
          appendNested(doc.createElement("em"), text.slice(index + 1, end));
          index = end + 1;
          continue;
        }
      }
      if (text[index] === "<") {
        const autolink = text.slice(index).match(/^<(https?:\/\/[^>\s]+)>/iu);
        if (autolink) {
          const link = configureExternalLink(doc.createElement("a"), autolink[1], options);
          link.textContent = autolink[1];
          parent.append(link);
          index += autolink[0].length;
          continue;
        }
      }
      if (text[index] === "$" && text[index + 1] !== "$") {
        const end = text.indexOf("$", index + 1);
        if (end > index + 1 && !/\s/u.test(text[index + 1]) && !/\s/u.test(text[end - 1])) {
          MathRenderer.appendMath(doc, parent, text.slice(index + 1, end));
          index = end + 1;
          continue;
        }
      }
      const special = "\n\\`![:*_~<$";
      let end = index + 1;
      while (end < text.length && !special.includes(text[end])) end++;
      parent.append(doc.createTextNode(text.slice(index, end)));
      index = end;
    }
  }

  function appendCodeBlock(doc, container, value, language) {
    const wrapper = doc.createElement("div");
    wrapper.className = "spt-codex-code";
    const header = doc.createElement("div");
    header.className = "spt-codex-code-header";
    const label = doc.createElement("span");
    label.textContent = language || "code";
    const copy = doc.createElement("button");
    copy.type = "button";
    copy.textContent = "复制";
    copy.addEventListener("click", async () => {
      try {
        if (global.Zotero?.Utilities?.Internal?.copyTextToClipboard) {
          global.Zotero.Utilities.Internal.copyTextToClipboard(value);
        }
        else {
          await doc.defaultView.navigator.clipboard.writeText(value);
        }
        copy.textContent = "已复制";
      }
      catch (_error) {
        copy.textContent = "复制失败";
      }
    });
    header.append(label, copy);
    const pre = doc.createElement("pre");
    const code = doc.createElement("code");
    code.textContent = value;
    pre.append(code);
    wrapper.append(header, pre);
    container.append(wrapper);
  }

  function splitTableRow(line) {
    const value = line.trim().replace(/^\|/u, "").replace(/\|$/u, "");
    const cells = [];
    let cell = "";
    let escaped = false;
    for (const character of value) {
      if (escaped) {
        cell += character;
        escaped = false;
      }
      else if (character === "\\") escaped = true;
      else if (character === "|") {
        cells.push(cell.trim());
        cell = "";
      }
      else cell += character;
    }
    cells.push(cell.trim());
    return cells;
  }

  function isTableDelimiter(line) {
    const cells = splitTableRow(line);
    return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/u.test(cell));
  }

  function renderSafeMarkdown(doc, container, source, options = {}) {
    container.replaceChildren();
    const lines = String(source || "").replace(/\r\n?/gu, "\n").split("\n");
    const isBlockStart = (line, next) => Boolean(
      /^\s*(?:#{1,6}\s+|>\s?|[-+*]\s+|\d+[.)]\s+|```|~~~|\\\[|\$\$|(?:-{3,}|\*{3,}|_{3,})\s*$)/u.test(line) ||
      (next !== undefined && line.includes("|") && isTableDelimiter(next))
    );
    let index = 0;
    while (index < lines.length) {
      const line = lines[index];
      if (!line.trim()) {
        index++;
        continue;
      }

      const fence = line.match(/^\s{0,3}(`{3,}|~{3,})\s*([^`]*)$/u);
      if (fence) {
        const marker = fence[1];
        const language = fence[2].trim();
        const code = [];
        index++;
        while (index < lines.length && !new RegExp(`^\\s{0,3}${marker[0]}{${marker.length},}\\s*$`, "u").test(lines[index])) {
          code.push(lines[index++]);
        }
        if (index < lines.length) index++;
        appendCodeBlock(doc, container, code.join("\n"), language);
        continue;
      }

      if (/^\s*(?:\\\[|\$\$)/u.test(line)) {
        const bracket = /^\s*\\\[/u.test(line);
        const opener = bracket ? /\\\[/u : /\$\$/u;
        const closer = bracket ? /\\\]/u : /\$\$/u;
        let math = line.replace(opener, "");
        if (closer.test(math)) {
          math = math.replace(closer, "");
          index++;
        }
        else {
          const parts = [math];
          index++;
          while (index < lines.length && !closer.test(lines[index])) parts.push(lines[index++]);
          if (index < lines.length) {
            parts.push(lines[index].replace(closer, ""));
            index++;
          }
          math = parts.join("\n");
        }
        MathRenderer.appendMath(doc, container, math.trim(), true);
        continue;
      }

      const heading = line.match(/^\s*(#{1,6})\s+(.+?)\s*#*$/u);
      if (heading) {
        const element = doc.createElement(`h${Math.min(heading[1].length + 2, 6)}`);
        appendSafeInline(doc, element, heading[2], options);
        container.append(element);
        index++;
        continue;
      }

      if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/u.test(line)) {
        container.append(doc.createElement("hr"));
        index++;
        continue;
      }

      if (/^\s*>/u.test(line)) {
        const quoteLines = [];
        while (index < lines.length && /^\s*>/u.test(lines[index])) {
          quoteLines.push(lines[index++].replace(/^\s*>\s?/u, ""));
        }
        const quote = doc.createElement("blockquote");
        renderSafeMarkdown(doc, quote, quoteLines.join("\n"), options);
        container.append(quote);
        continue;
      }

      const listStart = line.match(/^\s*([-+*]|\d+[.)])\s+(.+)$/u);
      if (listStart) {
        const ordered = /^\d/u.test(listStart[1]);
        const list = doc.createElement(ordered ? "ol" : "ul");
        while (index < lines.length) {
          const itemMatch = lines[index].match(/^\s*([-+*]|\d+[.)])\s+(.+)$/u);
          if (!itemMatch || /^\d/u.test(itemMatch[1]) !== ordered) break;
          const item = doc.createElement("li");
          const task = itemMatch[2].match(/^\[([ xX])\]\s+(.+)$/u);
          if (task) {
            const checkbox = doc.createElement("input");
            checkbox.type = "checkbox";
            checkbox.checked = task[1].toLowerCase() === "x";
            checkbox.disabled = true;
            item.append(checkbox, doc.createTextNode(" "));
            appendSafeInline(doc, item, task[2], options);
          }
          else appendSafeInline(doc, item, itemMatch[2], options);
          list.append(item);
          index++;
        }
        container.append(list);
        continue;
      }

      if (index + 1 < lines.length && line.includes("|") && isTableDelimiter(lines[index + 1])) {
        const headers = splitTableRow(line);
        const alignments = splitTableRow(lines[index + 1]).map((cell) =>
          cell.startsWith(":") && cell.endsWith(":") ? "center" : cell.endsWith(":") ? "right" : "left"
        );
        const table = doc.createElement("table");
        const head = doc.createElement("thead");
        const headRow = doc.createElement("tr");
        headers.forEach((cell, cellIndex) => {
          const header = doc.createElement("th");
          header.style ||= {};
          header.style.textAlign = alignments[cellIndex] || "left";
          appendSafeInline(doc, header, cell, options);
          headRow.append(header);
        });
        head.append(headRow);
        const body = doc.createElement("tbody");
        index += 2;
        while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
          const row = doc.createElement("tr");
          splitTableRow(lines[index++]).forEach((cell, cellIndex) => {
            const data = doc.createElement("td");
            data.style ||= {};
            data.style.textAlign = alignments[cellIndex] || "left";
            appendSafeInline(doc, data, cell, options);
            row.append(data);
          });
          body.append(row);
        }
        table.append(head, body);
        const scroller = doc.createElement("div");
        scroller.className = "spt-codex-table-wrap";
        scroller.append(table);
        container.append(scroller);
        continue;
      }

      const paragraph = [line];
      index++;
      while (
        index < lines.length && lines[index].trim() &&
        !isBlockStart(lines[index], lines[index + 1])
      ) paragraph.push(lines[index++]);
      const element = doc.createElement("p");
      appendSafeInline(doc, element, paragraph.join("\n"), options);
      container.append(element);
    }
  }

  function stringifyDetails(value) {
    try { return JSON.stringify(value, null, 2); }
    catch (_error) { return String(value || ""); }
  }

  const TRANSCRIPT_BOTTOM_THRESHOLD = 24;

  function transcriptEntryKey(entry, index) {
    return String(entry?.id || entry?.remoteID || `${entry?.kind || "entry"}-${index}`);
  }

  function captureTranscriptViewport(container, renderedBefore) {
    const expanded = new Set();
    const innerScroll = new Map();
    for (const child of Array.from(container.children || [])) {
      const key = child.getAttribute?.("data-entry-key");
      if (!key || String(child.localName || "").toLowerCase() !== "details") continue;
      if (child.open) expanded.add(key);
      const content = Array.from(child.children || []).find((candidate) =>
        String(candidate.className || "").split(/\s+/u).includes("spt-codex-event-content")
      );
      if (content) innerScroll.set(key, Number(content.scrollTop) || 0);
    }
    const scrollTop = Number(container.scrollTop) || 0;
    const scrollHeight = Number(container.scrollHeight) || 0;
    const clientHeight = Number(container.clientHeight) || 0;
    return {
      expanded,
      innerScroll,
      scrollTop,
      pinnedToBottom: Boolean(
        renderedBefore && scrollHeight > 0 &&
        scrollHeight - clientHeight - scrollTop <= TRANSCRIPT_BOTTOM_THRESHOLD
      )
    };
  }

  function restoreTranscriptViewport(container, snapshot, renderedBefore) {
    if (!renderedBefore || snapshot.pinnedToBottom) {
      container.scrollTop = Number(container.scrollHeight) || 0;
      return;
    }
    container.scrollTop = snapshot.scrollTop;
  }

  function truncateLabel(value, limit = 96) {
    const text = String(value || "").replace(/\s+/gu, " ").trim();
    return text.length > limit ? text.slice(0, limit - 1) + "…" : text;
  }

  function fileNameFromPath(path) {
    const parts = String(path || "").replace(/\\/gu, "/").split("/").filter(Boolean);
    return parts[parts.length - 1] || String(path || "");
  }

  function formatToolImageSize(value) {
    const size = Number(value);
    if (!Number.isFinite(size) || size <= 0) return "";
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
    return `${(size / (1024 * 1024)).toFixed(1)} MiB`;
  }

  function describeToolImage(snapshot) {
    if (!snapshot || !["copying", "ready", "error"].includes(snapshot.status)) return null;
    const originalName = fileNameFromPath(snapshot.originalName || "图片").slice(0, 120) || "图片";
    if (snapshot.status === "ready") {
      const localURI = String(snapshot.localURI || "");
      if (!/^file:\/\/\//iu.test(localURI)) {
        return {
          status: "error",
          originalName,
          message: "本地图片副本引用无效，请重新调用 View Image。"
        };
      }
      return {
        status: "ready",
        originalName,
        mimeType: String(snapshot.mimeType || ""),
        size: Number(snapshot.size) || 0,
        localURI
      };
    }
    return {
      status: snapshot.status,
      originalName,
      message: snapshot.status === "error"
        ? String(snapshot.message || "图片副本创建失败，请重新调用 View Image。").slice(0, 240)
        : "正在校验并复制图片…"
    };
  }

  function displayToolPath(path, workspacePath = "") {
    const value = String(path || "").trim();
    if (!value) return "";
    const workspace = String(workspacePath || "").replace(/\/+$/u, "");
    if (workspace && value === workspace) return "当前论文工作区";
    if (workspace && value.startsWith(workspace + "/")) {
      return "工作区/" + value.slice(workspace.length + 1);
    }
    return value.replace(/^\/Users\/[^/]+/u, "/Users/<user>");
  }

  function resourcePathFromContent(content) {
    for (const item of Array.isArray(content) ? content : []) {
      if (item?.type === "resource_link") return item.uri || item.name || "";
      if (item?.content?.type === "resource_link") {
        return item.content.uri || item.content.name || "";
      }
    }
    return "";
  }

  function toolPath(entry) {
    const direct = entry?.rawInput?.path || entry?.locations?.[0]?.path ||
      resourcePathFromContent(entry?.content);
    if (direct) return String(direct);
    const match = String(entry?.title || "").match(/^(?:Read file|View Image)\s+['"]?(.+?)['"]?$/iu);
    return match?.[1] || "";
  }

  function toolOutputText(rawOutput) {
    if (typeof rawOutput === "string") return rawOutput;
    if (typeof rawOutput?.formatted_output === "string") return rawOutput.formatted_output;
    if (typeof rawOutput?.output === "string") return rawOutput.output;
    if (typeof rawOutput?.text === "string") return rawOutput.text;
    return "";
  }

  function toolContentText(content) {
    const values = [];
    for (const item of Array.isArray(content) ? content : []) {
      const block = item?.type === "content" ? item.content : item;
      if (typeof block === "string") values.push(block);
      else if (typeof block?.text === "string") values.push(block.text);
    }
    return values.filter(Boolean).join("\n\n");
  }

  function safeExternalURL(value) {
    try {
      return normalizeExternalURL(value);
    }
    catch (_error) {
      return "";
    }
  }

  function webSearchResults(entry) {
    const results = [];
    const seen = new Set();
    const sources = [
      entry?.rawOutput?.results,
      entry?.rawOutput?.items,
      entry?.rawOutput?.sources,
      entry?.rawOutput?.data?.results,
      entry?.content
    ];
    for (const source of sources) {
      for (const rawItem of Array.isArray(source) ? source : []) {
        const item = rawItem?.type === "content" ? rawItem.content : rawItem;
        if (!item || typeof item !== "object") continue;
        const url = safeExternalURL(item.url || item.uri || item.href || item.link);
        if (!url) continue;
        const title = String(item.title || item.name || url).trim() || url;
        const snippet = String(
          item.snippet || item.description || (item.type === "text" ? item.text : "") || ""
        ).trim();
        const key = `${url}\n${title}`;
        if (seen.has(key)) continue;
        seen.add(key);
        results.push({ title, url, snippet });
      }
    }
    return results;
  }

  function describeWebSearch(entry) {
    const title = String(entry?.title || "").trim();
    const input = entry?.rawInput && typeof entry.rawInput === "object" ? entry.rawInput : {};
    const action = input.action && typeof input.action === "object" ? input.action : null;
    const isWebSearch = input.type === "webSearch" ||
      /^(?:Web search|Open page|Find in page)(?::|\s|$)/iu.test(title);
    if (!isWebSearch) return null;

    let type = String(action?.type || "");
    if (!type) {
      if (/^Open page(?::|\s|$)/iu.test(title)) type = "openPage";
      else if (/^Find in page(?::|\s|$)/iu.test(title)) type = "findInPage";
      else type = "search";
    }
    const queries = [];
    const addQuery = (value) => {
      const query = String(value || "").trim();
      if (query && !queries.includes(query)) queries.push(query);
    };
    if (type === "search") {
      for (const query of Array.isArray(action?.queries) ? action.queries : []) addQuery(query);
      addQuery(action?.query);
      if (!queries.length) addQuery(input.query);
      const titleQuery = title.match(/^Web search:\s*(.+)$/iu)?.[1];
      if (!queries.length) addQuery(titleQuery);
    }

    let url = safeExternalURL(action?.url);
    if (!url && type === "openPage") {
      url = safeExternalURL(input.query) || safeExternalURL(title.replace(/^Open page:\s*/iu, ""));
    }
    let pattern = String(action?.pattern || "").trim();
    if (!pattern && type === "findInPage") {
      pattern = title.match(/^Find in page for\s+['"](.+?)['"](?:\s+in\s+|$)/iu)?.[1] || "";
    }
    return {
      type,
      queries,
      url,
      pattern,
      results: webSearchResults(entry)
    };
  }

  function describeToolEntry(entry, workspacePath = "") {
    const title = String(entry?.title || "").trim();
    const kind = String(entry?.toolKind || "").toLowerCase();
    const path = toolPath(entry);
    const visiblePath = displayToolPath(path, workspacePath);
    const output = toolOutputText(entry?.rawOutput) || toolContentText(entry?.content);
    const web = describeWebSearch(entry);
    const exitCode = Object.prototype.hasOwnProperty.call(entry?.rawOutput || {}, "exit_code")
      ? entry.rawOutput.exit_code
      : null;
    const result = {
      category: "other",
      icon: "⌘",
      label: "工具调用",
      subject: truncateLabel(title || kind || "工具"),
      command: "",
      fields: [],
      output,
      outputLabel: "工具输出",
      exitCode,
      web: null,
      image: null,
      emptyMessage: "工具已完成，未返回文本输出"
    };

    if (kind === "execute" || entry?.rawInput?.command) {
      const command = String(entry?.rawInput?.command || title);
      result.category = "execute";
      result.icon = ">_";
      result.label = "运行命令";
      result.subject = truncateLabel(command);
      result.command = command;
      result.outputLabel = "命令输出";
      result.emptyMessage = "命令尚未返回输出";
      const cwd = displayToolPath(entry?.rawInput?.cwd, workspacePath);
      if (cwd) result.fields.push({ label: "工作目录", value: cwd, code: true });
    }
    else if (web) {
      result.category = "web-search";
      result.icon = "◎";
      result.web = web;
      result.outputLabel = "返回内容";
      if (web.type === "openPage") {
        result.label = "打开网页";
        result.subject = truncateLabel(web.url || "网页");
        result.emptyMessage = "页面读取已完成；当前 ACP 事件未携带页面正文";
      }
      else if (web.type === "findInPage") {
        result.label = "页内查找";
        result.subject = truncateLabel(web.pattern ? `“${web.pattern}”` : "网页");
        result.emptyMessage = "页内查找已完成；当前 ACP 事件未携带匹配片段";
      }
      else if (web.type === "search") {
        result.label = "网页搜索";
        result.subject = web.queries.length > 1
          ? `${web.queries.length} 个查询`
          : truncateLabel(web.queries[0] || "网页");
        result.emptyMessage = "搜索动作已完成；当前 ACP 事件未携带结果摘要，引用链接会随 Codex 回答显示";
      }
      else {
        result.label = "网页操作";
        result.subject = "浏览与检索";
        result.emptyMessage = "网页操作已完成；当前 ACP 事件未携带可展示详情";
      }
    }
    else if (kind === "search" || /^Search for\s+/iu.test(title)) {
      const match = title.match(/^Search for\s+['"](.+)['"]\s+in\s+(.+)$/iu);
      const query = match?.[1] || title.replace(/^Search for\s+/iu, "");
      const target = match?.[2] || path;
      result.category = "search";
      result.icon = "⌕";
      result.label = "搜索内容";
      result.subject = truncateLabel(fileNameFromPath(target) || query);
      result.outputLabel = "搜索结果";
      result.emptyMessage = "搜索已完成，没有文本结果";
      if (query) result.fields.push({ label: "关键词", value: query, code: true });
      if (target) {
        result.fields.push({
          label: "范围",
          value: displayToolPath(target, workspacePath),
          code: true
        });
      }
    }
    else if (kind === "read" || /^(?:Read file|View Image)\s+/iu.test(title)) {
      const isImage = /^View Image\s+/iu.test(title) ||
        /\.(?:avif|gif|jpe?g|png|webp)$/iu.test(path);
      result.category = isImage ? "image" : "read";
      result.icon = isImage ? "▧" : "▤";
      result.label = isImage ? "查看图片" : "读取文件";
      result.subject = truncateLabel(fileNameFromPath(path) || title);
      result.outputLabel = isImage ? "图片信息" : "读取内容";
      result.emptyMessage = isImage ? "图片已读取" : "文件已读取，未返回文本内容";
      if (isImage) {
        result.image = describeToolImage(entry?.imageSnapshot);
        if (result.image) {
          result.subject = truncateLabel(result.image.originalName || result.subject);
          result.fields.push({ label: "文件", value: result.image.originalName, code: false });
          if (result.image.status === "ready") {
            result.fields.push({
              label: "格式",
              value: result.image.mimeType.replace(/^image\//u, "").toUpperCase(),
              code: false
            });
            result.fields.push({
              label: "大小",
              value: formatToolImageSize(result.image.size),
              code: false
            });
            result.fields.push({ label: "副本", value: "会话媒体目录（Codex 不可见）", code: false });
          }
        }
      }
      else if (visiblePath) result.fields.push({ label: "位置", value: visiblePath, code: true });
    }
    else {
      for (const [name, value] of Object.entries(entry?.rawInput || {})) {
        if (!["string", "number", "boolean"].includes(typeof value)) continue;
        result.fields.push({ label: name, value: String(value), code: true });
      }
    }

    if (!result.output) {
      if (entry?.status === "pending") result.emptyMessage = "等待授权或执行";
      else if (entry?.status === "in_progress") result.emptyMessage = "正在执行…";
      else if (entry?.status === "failed") result.emptyMessage = "工具调用失败，未返回文本输出";
    }

    result.summary = result.subject ? `${result.label} · ${result.subject}` : result.label;
    return result;
  }

  function appendWebSearchDetails(doc, container, presentation, options = {}) {
    const web = presentation.web;
    if (!web) return;
    if (web.queries.length) {
      const section = doc.createElement("section");
      section.className = "spt-codex-tool-section spt-codex-web-search-section";
      const heading = doc.createElement("strong");
      heading.textContent = web.queries.length > 1 ? `搜索请求（${web.queries.length}）` : "搜索请求";
      const list = doc.createElement("ol");
      list.className = "spt-codex-web-queries";
      for (const query of web.queries) {
        const item = doc.createElement("li");
        item.textContent = query;
        list.append(item);
      }
      section.append(heading, list);
      container.append(section);
    }
    if (web.url || web.pattern) {
      const section = doc.createElement("section");
      section.className = "spt-codex-tool-section spt-codex-web-search-section";
      const heading = doc.createElement("strong");
      heading.textContent = web.type === "findInPage" ? "页内操作" : "页面";
      section.append(heading);
      if (web.pattern) {
        const pattern = doc.createElement("code");
        pattern.className = "spt-codex-web-pattern";
        pattern.textContent = web.pattern;
        section.append(pattern);
      }
      if (web.url) {
        const link = configureExternalLink(doc.createElement("a"), web.url, options);
        link.className = "spt-codex-web-link";
        link.textContent = web.url;
        section.append(link);
      }
      container.append(section);
    }
    if (web.results.length) {
      const section = doc.createElement("section");
      section.className = "spt-codex-tool-section spt-codex-web-search-section";
      const heading = doc.createElement("strong");
      heading.textContent = `返回内容（${web.results.length}）`;
      const results = doc.createElement("div");
      results.className = "spt-codex-web-results";
      for (const result of web.results) {
        const item = doc.createElement("article");
        item.className = "spt-codex-web-result";
        const link = configureExternalLink(doc.createElement("a"), result.url, options);
        link.className = "spt-codex-web-result-title";
        link.textContent = result.title;
        item.append(link);
        if (result.snippet) {
          const snippet = doc.createElement("p");
          snippet.textContent = result.snippet;
          item.append(snippet);
        }
        results.append(item);
      }
      section.append(heading, results);
      container.append(section);
    }
  }

  function appendToolImageDetails(doc, container, presentation, options = {}) {
    const image = presentation.image;
    if (!image) return null;
    const section = doc.createElement("section");
    section.className = `spt-codex-tool-image spt-codex-tool-image-${image.status}`;
    const status = doc.createElement("p");
    status.className = "spt-codex-tool-image-status";
    status.setAttribute("role", image.status === "error" ? "alert" : "status");
    if (image.status !== "ready") {
      status.textContent = image.message;
      section.append(status);
      container.append(section);
      return null;
    }

    const preview = doc.createElement("button");
    preview.type = "button";
    preview.className = "spt-codex-tool-image-preview";
    preview.disabled = true;
    preview.setAttribute("aria-label", `放大查看 ${image.originalName}`);
    const element = doc.createElement("img");
    element.className = "spt-codex-tool-image-element";
    element.alt = image.originalName;
    element.decoding = "async";
    status.textContent = "展开卡片后加载本地图片副本";
    preview.append(element);
    section.append(preview, status);
    container.append(section);

    let requested = false;
    let loaded = false;
    const load = () => {
      if (requested) return;
      requested = true;
      status.textContent = "正在加载本地图片副本…";
      element.src = image.localURI;
    };
    element.addEventListener("load", () => {
      loaded = true;
      preview.disabled = false;
      status.textContent = "点击图片放大";
    });
    element.addEventListener("error", () => {
      loaded = false;
      preview.disabled = true;
      section.className = "spt-codex-tool-image spt-codex-tool-image-error";
      status.setAttribute("role", "alert");
      status.textContent = "本地图片副本无法解码或已不存在，请重新调用 View Image。";
    });
    preview.addEventListener("click", () => {
      if (loaded && typeof options.onImagePreview === "function") {
        options.onImagePreview(image);
      }
    });
    if (typeof options.registerDeferredImageLoader === "function") {
      options.registerDeferredImageLoader(load);
    }
    else if (!options.deferImageLoad) load();
    return load;
  }

  function appendToolDetails(doc, container, entry, workspacePath = "", options = {}) {
    const presentation = describeToolEntry(entry, workspacePath);
    appendWebSearchDetails(doc, container, presentation, options);
    if (presentation.command) {
      const section = doc.createElement("section");
      section.className = "spt-codex-tool-section";
      const heading = doc.createElement("strong");
      heading.textContent = "命令";
      const command = doc.createElement("pre");
      command.className = "spt-codex-tool-command";
      command.textContent = presentation.command;
      section.append(heading, command);
      container.append(section);
    }
    if (presentation.fields.length) {
      const fields = doc.createElement("dl");
      fields.className = "spt-codex-tool-fields";
      for (const field of presentation.fields) {
        const row = doc.createElement("div");
        const term = doc.createElement("dt");
        term.textContent = field.label;
        const description = doc.createElement("dd");
        description.textContent = field.value;
        if (field.code) description.className = "spt-codex-tool-value-code";
        row.append(term, description);
        fields.append(row);
      }
      container.append(fields);
    }
    appendToolImageDetails(doc, container, presentation, options);
    if (presentation.output) {
      const section = doc.createElement("section");
      section.className = "spt-codex-tool-section";
      const header = doc.createElement("div");
      header.className = "spt-codex-tool-output-header";
      const heading = doc.createElement("strong");
      heading.textContent = presentation.outputLabel;
      header.append(heading);
      if (presentation.exitCode !== null && presentation.exitCode !== undefined) {
        const exit = doc.createElement("span");
        exit.className = Number(presentation.exitCode) === 0
          ? "spt-codex-tool-exit spt-codex-tool-exit-ok"
          : "spt-codex-tool-exit spt-codex-tool-exit-error";
        exit.textContent = `退出码 ${presentation.exitCode}`;
        header.append(exit);
      }
      const output = doc.createElement(presentation.web ? "div" : "pre");
      output.className = presentation.web
        ? "spt-codex-tool-output spt-codex-tool-web-output spt-codex-markdown"
        : "spt-codex-tool-output";
      if (presentation.web) renderSafeMarkdown(doc, output, presentation.output, options);
      else output.textContent = presentation.output;
      section.append(header, output);
      container.append(section);
    }
    else if (!presentation.web?.results.length && !presentation.image) {
      const empty = doc.createElement("p");
      empty.className = "spt-codex-tool-empty";
      empty.textContent = presentation.emptyMessage;
      container.append(empty);
    }
    return presentation;
  }

  function makeButton(doc, label, action, className = "") {
    const button = doc.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.className = ["spt-codex-button", className].filter(Boolean).join(" ");
    button.addEventListener("click", action);
    return button;
  }

  async function copyTextToClipboard(doc, value) {
    if (global.Zotero?.Utilities?.Internal?.copyTextToClipboard) {
      global.Zotero.Utilities.Internal.copyTextToClipboard(value);
      return;
    }
    const clipboard = doc.defaultView?.navigator?.clipboard;
    if (!clipboard?.writeText) throw new Error("当前窗口无法访问剪贴板");
    await clipboard.writeText(value);
  }

  class CodexChatUI {
    constructor({
      service,
      stylesheetText,
      rootURI,
      requestScreenshotCapture,
      canStartScreenshotCapture,
      log
    } = {}) {
      this.service = service;
      this.stylesheetText = stylesheetText || "";
      this.rootURI = rootURI;
      this.requestScreenshotCapture = requestScreenshotCapture;
      this.canStartScreenshotCapture = canStartScreenshotCapture;
      this.log = log || (() => {});
      this.pluginID = null;
      this.paneID = null;
      this.views = new Map();
      this.drafts = new Map();
      this.pendingDraftFocus = new Set();
      this.windowCleanups = new Map();
    }

    _draftFor(attachmentID, create = true) {
      let draft = this.drafts.get(attachmentID);
      if (!draft && create) {
        draft = { question: "", selections: [], screenshots: [] };
        this.drafts.set(attachmentID, draft);
      }
      if (draft) {
        if (!Array.isArray(draft.selections)) draft.selections = [];
        if (!Array.isArray(draft.screenshots)) draft.screenshots = [];
        if (typeof draft.question !== "string") draft.question = "";
      }
      return draft || null;
    }

    _matchingReader({ tabID, attachmentID }, zotero = global.Zotero) {
      if (!tabID || typeof zotero?.Reader?.getByTabID !== "function") return null;
      const reader = zotero.Reader.getByTabID(tabID);
      return Number(reader?.itemID) === Number(attachmentID) ? reader : null;
    }

    canAddSelectionContext({ reader, tabID, attachmentID } = {}) {
      const normalizedAttachmentID = Number(attachmentID ?? reader?.itemID);
      const normalizedTabID = tabID || reader?.tabID;
      return Boolean(
        Number.isSafeInteger(normalizedAttachmentID) &&
        normalizedAttachmentID > 0 &&
        this._matchingReader({
          tabID: normalizedTabID,
          attachmentID: normalizedAttachmentID
        })
      );
    }

    canAddScreenshotContext(context = {}) {
      return this.canAddSelectionContext(context);
    }

    _itemDetailsForTab(tabID) {
      for (const win of global.Zotero?.getMainWindows?.() || []) {
        for (const details of win.document?.querySelectorAll?.("item-details") || []) {
          if (details.tabID === tabID) return details;
        }
      }
      return null;
    }

    async _revealCodexPane(tabID) {
      const details = this._itemDetailsForTab(tabID);
      if (!details || !this.paneID) return false;
      const sidenavButtons = details.sidenav?.querySelectorAll?.("[data-pane]") || [];
      const paneButton = Array.from(sidenavButtons).find(
        (button) => button.dataset?.pane === this.paneID
      );
      const win = details.ownerDocument?.defaultView;
      if (paneButton?.dispatchEvent && typeof win?.MouseEvent === "function") {
        paneButton.dispatchEvent(new win.MouseEvent("click", {
          bubbles: true,
          button: 0,
          detail: 1
        }));
        return true;
      }

      // Zotero 9.0.6 fallback. ItemPaneManager has no public "open section" API,
      // so keep this target-version DOM bridge isolated and capability-guarded.
      if (typeof details.scrollToPane !== "function") return false;
      const parentPane = details.closest?.("item-pane, context-pane");
      await details.scrollToPane(this.paneID, parentPane?.collapsed ? "instant" : "smooth");
      if (parentPane && "collapsed" in parentPane) parentPane.collapsed = false;
      details.sidenav?.render?.();
      return true;
    }

    _viewForTab(tabID, attachmentID) {
      for (const view of this.views.values()) {
        const details = view.body?.closest?.("item-details");
        if (details?.tabID === tabID && view.attachmentID === attachmentID) return view;
      }
      return null;
    }

    _draftFocusKey(tabID, attachmentID) {
      return `${tabID}\u0000${attachmentID}`;
    }

    _focusDraftInput(view) {
      const details = view?.body?.closest?.("item-details");
      const key = this._draftFocusKey(details?.tabID, view?.attachmentID);
      if (!this.pendingDraftFocus.has(key)) return false;
      this.pendingDraftFocus.delete(key);
      view.elements.input.focus?.();
      return true;
    }

    _syncDraftViews(attachmentID) {
      const draft = this._draftFor(attachmentID, false) || {
        question: "",
        selections: [],
        screenshots: []
      };
      for (const view of this.views.values()) {
        if (view.attachmentID !== attachmentID) continue;
        if (view.elements.input.value !== draft.question) {
          view.elements.input.value = draft.question;
        }
        this._renderDraftContexts(view);
        this._updateComposerAvailability(view);
      }
    }

    _restoreScreenshotDrafts(attachmentID, state) {
      const persisted = CodexChat.normalizeStoredScreenshots(state?.record?.draft?.screenshots);
      if (!persisted.length) return false;
      const draft = this._draftFor(attachmentID);
      const known = new Set(draft.screenshots.map((screenshot) => screenshot.id));
      let changed = false;
      for (const screenshot of persisted) {
        if (known.has(screenshot.id)) continue;
        draft.screenshots.push(screenshot);
        known.add(screenshot.id);
        changed = true;
      }
      if (changed) this._syncDraftViews(attachmentID);
      return changed;
    }

    async addSelectionContext({ tabID, attachmentID, selection } = {}) {
      const normalizedAttachmentID = Number(attachmentID);
      if (!this.canAddSelectionContext({ tabID, attachmentID: normalizedAttachmentID })) {
        throw new Error("无法精确匹配当前 Reader PDF，未添加选区");
      }
      const normalizedSelection = CodexChat.normalizeSelectionContext(selection);
      if (!normalizedSelection) throw new Error("选中文本的位置无效，未添加到 Codex");
      const draft = this._draftFor(normalizedAttachmentID);
      const key = CodexChat.selectionContextKey(normalizedSelection);
      const added = !draft.selections.some(
        (candidate) => CodexChat.selectionContextKey(candidate) === key
      );
      if (added) draft.selections.push(normalizedSelection);
      this._syncDraftViews(normalizedAttachmentID);
      const focusKey = this._draftFocusKey(tabID, normalizedAttachmentID);
      this.pendingDraftFocus.add(focusKey);
      const revealed = await this._revealCodexPane(tabID).catch((error) => {
        this.log("展开 Codex Item Pane 失败", error);
        return false;
      });
      const view = this._viewForTab(tabID, normalizedAttachmentID);
      if (view) this._focusDraftInput(view);
      return { added, revealed };
    }

    async addScreenshotContexts({
      tabID,
      attachmentID,
      captures,
      replaceScreenshotID = null
    } = {}) {
      const normalizedAttachmentID = Number(attachmentID);
      if (!this.canAddScreenshotContext({ tabID, attachmentID: normalizedAttachmentID })) {
        throw new Error("无法精确匹配当前 Reader PDF，未添加截图");
      }
      if (!Array.isArray(captures) || !captures.length) {
        throw new Error("没有可加入 Codex 草稿的 PDF 截图");
      }
      const draft = this._draftFor(normalizedAttachmentID);
      const oldIndex = replaceScreenshotID
        ? draft.screenshots.findIndex((screenshot) => screenshot.id === replaceScreenshotID)
        : -1;
      if (replaceScreenshotID && oldIndex < 0) {
        throw new Error("待重新框选的截图已不在当前草稿中");
      }
      const stored = await this.service.saveScreenshotDrafts(normalizedAttachmentID, captures);
      if (replaceScreenshotID) {
        const previous = draft.screenshots[oldIndex];
        try {
          await this.service.deleteScreenshotDrafts(normalizedAttachmentID, [previous]);
        }
        catch (error) {
          await this.service.deleteScreenshotDrafts(normalizedAttachmentID, stored)
            .catch((cleanupError) => this.log("清理未采用的 PDF 截图失败", cleanupError));
          throw error;
        }
        draft.screenshots.splice(oldIndex, 1, ...stored);
      }
      else {
        draft.screenshots.push(...stored);
      }
      this._syncDraftViews(normalizedAttachmentID);
      const focusKey = this._draftFocusKey(tabID, normalizedAttachmentID);
      this.pendingDraftFocus.add(focusKey);
      const revealed = await this._revealCodexPane(tabID).catch((error) => {
        this.log("展开 Codex Item Pane 失败", error);
        return false;
      });
      const view = this._viewForTab(tabID, normalizedAttachmentID);
      if (view) this._focusDraftInput(view);
      return { added: stored.length, revealed };
    }

    _screenshotRequestContext(view, replaceScreenshotID = null) {
      const details = view?.body?.closest?.("item-details");
      return {
        tabID: details?.tabID,
        attachmentID: view?.attachmentID,
        replaceScreenshotID
      };
    }

    _canRequestScreenshot(view) {
      const context = this._screenshotRequestContext(view);
      if (!context.tabID || !context.attachmentID) return false;
      if (!this.canAddScreenshotContext(context)) return false;
      if (typeof this.canStartScreenshotCapture !== "function") return false;
      try { return Boolean(this.canStartScreenshotCapture(context)); }
      catch (_error) { return false; }
    }

    async _requestScreenshot(view, replaceScreenshotID = null) {
      if (typeof this.requestScreenshotCapture !== "function" || !this._canRequestScreenshot(view)) {
        throw new Error("当前 Reader 无法启动 PDF 原页截图");
      }
      return this.requestScreenshotCapture(
        this._screenshotRequestContext(view, replaceScreenshotID)
      );
    }

    _externalLinkOptions(view) {
      return {
        onExternalLink: (url) => openExternalURL(url),
        onExternalLinkError: (error) => {
          const message = error?.message || "无法在系统浏览器中打开链接";
          if (view?.elements?.notices) view.elements.notices.textContent = message;
          this.log("External link failed", error);
        }
      };
    }

    init(pluginID) {
      if (this.paneID) return;
      this.pluginID = pluginID;
      for (const win of global.Zotero.getMainWindows?.() || []) {
        ensureCodexLocalization(win);
      }
      this.paneID = global.Zotero.ItemPaneManager.registerSection({
        paneID: "codex-chat",
        pluginID,
        header: {
          l10nID: CODEX_HEADER_L10N_ID,
          icon: this.rootURI + "content/codex.svg"
        },
        sidenav: {
          l10nID: CODEX_SIDENAV_L10N_ID,
          icon: this.rootURI + "content/codex.svg"
        },
        onInit: ({ doc }) => {
          ensureCodexLocalization(doc.defaultView);
          this._ensureStyles(doc);
        },
        onDestroy: ({ body }) => this._destroyView(body),
        onItemChange: ({ tabType, setEnabled, setSectionSummary }) => {
          setEnabled(tabType === "reader");
          if (tabType !== "reader") setSectionSummary("");
        },
        onRender: (props) => this._renderShell(props),
        onAsyncRender: (props) => this._loadView(props),
        onToggle: (props) => {
          if (props.tabType === "reader" && props.body.childElementCount) this._loadView(props);
        }
      });
      if (!this.paneID) throw new Error("无法注册 Codex Item Pane section");
    }

    addToWindow(win) {
      if (!win?.ZoteroPane || this.windowCleanups.has(win)) return null;
      const localizationLink = ensureCodexLocalization(win);
      const style = win.document.createElement("style");
      style.dataset.smartPaperTranslatorCodex = "true";
      style.textContent = this.stylesheetText;
      win.document.documentElement.append(style);
      const cleanup = () => {
        style.remove();
        localizationLink?.remove();
      };
      this.windowCleanups.set(win, cleanup);
      return () => {
        cleanup();
        this.windowCleanups.delete(win);
      };
    }

    _ensureStyles(doc) {
      if (doc.querySelector("style[data-smart-paper-translator-codex]")) return;
      const style = doc.createElement("style");
      style.dataset.smartPaperTranslatorCodex = "true";
      style.textContent = this.stylesheetText;
      doc.documentElement.append(style);
    }

    _destroyView(body) {
      const view = this.views.get(body);
      if (!view) return;
      view.closeImageLightbox?.();
      view.unsubscribe?.();
      for (const cleanup of view.cleanups) cleanup();
      this.views.delete(body);
    }

    _openImageLightbox(view, image) {
      if (!view || image?.status !== "ready" || !/^file:\/\/\//iu.test(image.localURI || "")) {
        return false;
      }
      view.closeImageLightbox?.();
      const doc = view.body.ownerDocument;
      const host = doc.documentElement || doc.body;
      if (!host) return false;
      const previousFocus = doc.activeElement;
      const overlay = doc.createElement("div");
      overlay.className = "spt-codex-image-lightbox";
      overlay.setAttribute("role", "dialog");
      overlay.setAttribute("aria-modal", "true");
      overlay.setAttribute("aria-label", `图片预览：${image.originalName}`);
      const toolbar = doc.createElement("div");
      toolbar.className = "spt-codex-image-lightbox-toolbar";
      const title = doc.createElement("strong");
      title.textContent = image.originalName;
      const actions = doc.createElement("div");
      let zoom;
      const toggleZoom = () => {
        const actual = overlay.dataset.zoom === "actual";
        overlay.dataset.zoom = actual ? "fit" : "actual";
        zoom.textContent = actual ? "1:1" : "适应窗口";
        zoom.setAttribute("aria-pressed", String(!actual));
      };
      zoom = makeButton(doc, "1:1", toggleZoom, "spt-codex-image-lightbox-button");
      zoom.title = "在适应窗口和原始像素之间切换";
      zoom.setAttribute("aria-pressed", "false");
      const close = makeButton(doc, "关闭", () => cleanup(), "spt-codex-image-lightbox-button");
      actions.append(zoom, close);
      toolbar.append(title, actions);
      const viewport = doc.createElement("div");
      viewport.className = "spt-codex-image-lightbox-viewport";
      const element = doc.createElement("img");
      element.className = "spt-codex-image-lightbox-image";
      element.alt = image.originalName;
      element.decoding = "async";
      element.src = image.localURI;
      const error = doc.createElement("p");
      error.className = "spt-codex-image-lightbox-error";
      error.hidden = true;
      error.setAttribute("role", "alert");
      error.textContent = "本地图片副本无法解码或已不存在。";
      element.addEventListener("error", () => {
        element.hidden = true;
        error.hidden = false;
        zoom.disabled = true;
      });
      element.addEventListener("click", toggleZoom);
      viewport.append(element, error);
      overlay.append(toolbar, viewport);
      overlay.dataset.zoom = "fit";

      let closed = false;
      const keydown = (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          cleanup();
        }
        else if (event.key === "Tab") {
          const controls = [zoom, close].filter((control) => !control.disabled);
          const index = controls.indexOf(doc.activeElement);
          const nextIndex = event.shiftKey
            ? (index <= 0 ? controls.length - 1 : index - 1)
            : (index < 0 || index === controls.length - 1 ? 0 : index + 1);
          event.preventDefault();
          controls[nextIndex]?.focus?.();
        }
      };
      const backdrop = (event) => {
        if (event.target === overlay || event.target === viewport) cleanup();
      };
      const cleanup = () => {
        if (closed) return;
        closed = true;
        doc.removeEventListener("keydown", keydown, true);
        overlay.remove();
        if (view.closeImageLightbox === cleanup) view.closeImageLightbox = null;
        previousFocus?.focus?.();
      };
      overlay.addEventListener("click", backdrop);
      viewport.addEventListener("click", backdrop);
      doc.addEventListener("keydown", keydown, true);
      view.closeImageLightbox = cleanup;
      host.append(overlay);
      close.focus?.();
      return true;
    }

    _renderShell({ doc, body, setSectionSummary }) {
      this._destroyView(body);
      body.replaceChildren();
      const root = doc.createElement("div");
      root.className = "spt-codex-chat";
      const toolbar = doc.createElement("div");
      toolbar.className = "spt-codex-toolbar";
      const statusGroup = doc.createElement("div");
      statusGroup.className = "spt-codex-status-group";
      const statusDot = doc.createElement("span");
      statusDot.className = "spt-codex-status-dot";
      statusDot.setAttribute("aria-hidden", "true");
      const status = doc.createElement("span");
      status.className = "spt-codex-status";
      status.textContent = "本地历史";
      statusGroup.append(statusDot, status);
      const toolbarActions = doc.createElement("div");
      toolbarActions.className = "spt-codex-toolbar-actions";
      const reload = makeButton(doc, "重新加载", () => this._run(body, "reload"), "spt-codex-button-subtle");
      reload.title = "从 Codex thread 重新同步当前论文的对话";
      const workspace = makeButton(doc, "工作区", () => this._run(body, "workspace"), "spt-codex-button-subtle");
      workspace.title = "在 Finder 中显示当前论文的 Codex 工作区";
      const copyLog = makeButton(doc, "复制日志", () => this._run(body, "copy-log"), "spt-codex-button-subtle");
      copyLog.title = "复制当前实时 turn 的脱敏工具与思考事件日志";
      copyLog.hidden = true;
      const reset = makeButton(doc, "新建会话", () => this._run(body, "reset"), "spt-codex-danger-button");
      reset.title = "归档当前映射并为这篇论文新建会话";
      toolbarActions.append(reload, workspace, copyLog, reset);
      toolbar.append(statusGroup, toolbarActions);
      const configuration = doc.createElement("div");
      configuration.className = "spt-codex-config";
      const notices = doc.createElement("div");
      notices.className = "spt-codex-notices";
      const messages = doc.createElement("div");
      messages.className = "spt-codex-messages";
      messages.setAttribute("aria-live", "polite");
      const composer = doc.createElement("div");
      composer.className = "spt-codex-composer";
      const activity = doc.createElement("div");
      activity.className = "spt-codex-activity";
      activity.hidden = true;
      activity.setAttribute("role", "status");
      activity.setAttribute("aria-live", "polite");
      activity.setAttribute("aria-atomic", "true");
      const activitySpinner = doc.createElement("span");
      activitySpinner.className = "spt-codex-activity-spinner";
      activitySpinner.setAttribute("aria-hidden", "true");
      const activityText = doc.createElement("span");
      activityText.className = "spt-codex-activity-text";
      activity.append(activitySpinner, activityText);
      const draftContexts = doc.createElement("div");
      draftContexts.className = "spt-codex-draft-contexts";
      draftContexts.hidden = true;
      draftContexts.setAttribute("aria-label", "待发送的 PDF 选区上下文");
      const input = doc.createElement("textarea");
      input.rows = 3;
      input.placeholder = "围绕当前 PDF 向本机 Codex 提问…";
      input.disabled = true;
      const actions = doc.createElement("div");
      actions.className = "spt-codex-composer-actions";
      const screenshot = makeButton(
        doc,
        "截图",
        () => this._run(body, "screenshot"),
        "spt-codex-screenshot-button"
      );
      screenshot.title = "在当前 PDF 原页中框选区域，并加入本轮草稿";
      const stop = makeButton(doc, "停止", () => this._run(body, "cancel"));
      stop.hidden = true;
      const send = makeButton(doc, "发送", () => this._run(body, "send"), "spt-codex-primary-button");
      send.disabled = true;
      actions.append(screenshot, stop, send);
      composer.append(activity, draftContexts, input, actions);
      root.append(toolbar, configuration, notices, messages, composer);
      body.append(root);
      const view = {
        body,
        root,
        attachmentID: null,
        state: null,
        transcriptRendered: false,
        setSectionSummary,
        elements: {
          status, configuration, notices, messages, activity, activityText, draftContexts,
          input, send, stop, screenshot,
          reload, workspace, copyLog, reset
        },
        cleanups: []
      };
      const keydown = (event) => {
        if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
          event.preventDefault();
          this._run(body, "send");
        }
      };
      const inputChanged = () => {
        if (!view.attachmentID) return;
        this._draftFor(view.attachmentID).question = input.value;
        this._syncDraftViews(view.attachmentID);
      };
      input.addEventListener("keydown", keydown);
      input.addEventListener("input", inputChanged);
      view.cleanups.push(
        () => input.removeEventListener("keydown", keydown),
        () => input.removeEventListener("input", inputChanged)
      );
      this.views.set(body, view);
    }

    _appendSelectionContextCard(container, selection, { onRemove = null } = {}) {
      const doc = container.ownerDocument || container.parentNode?.ownerDocument;
      if (!doc) return;
      const card = doc.createElement("article");
      card.className = "spt-codex-selection-context";
      const header = doc.createElement("header");
      const page = doc.createElement("strong");
      page.textContent = selectionPageLabel(selection);
      header.append(page);
      if (onRemove) {
        const remove = makeButton(doc, "移除", onRemove, "spt-codex-selection-remove");
        remove.title = "从本轮草稿中移除此 PDF 选区";
        remove.setAttribute("aria-label", `移除${selectionPageLabel(selection)}的选区`);
        header.append(remove);
      }
      const text = doc.createElement("div");
      text.className = "spt-codex-selection-text";
      text.textContent = selection.text;
      card.append(header, text);
      container.append(card);
    }

    _screenshotLightboxImage(screenshot) {
      const normalized = PDFScreenshot.normalizeStoredScreenshot(screenshot);
      if (!normalized?.localURI) return null;
      return {
        status: "ready",
        originalName: `${screenshotPageLabel(normalized)} PDF 截图`,
        mimeType: "image/png",
        size: normalized.byteSize,
        localURI: normalized.localURI
      };
    }

    _appendScreenshotContextCard(container, screenshot, {
      view,
      onRemove = null,
      onReselect = null,
      registerDeferredImageLoader = null
    } = {}) {
      const normalized = PDFScreenshot.normalizeStoredScreenshot(screenshot);
      const doc = container.ownerDocument || container.parentNode?.ownerDocument;
      if (!doc || !normalized) return;
      const card = doc.createElement("article");
      card.className = "spt-codex-screenshot-context";
      card.dataset.screenshotId = normalized.id;
      const header = doc.createElement("header");
      const page = doc.createElement("strong");
      page.textContent = screenshotPageLabel(normalized);
      const size = doc.createElement("span");
      size.textContent = formatToolImageSize(normalized.byteSize);
      header.append(page, size);
      const actions = doc.createElement("div");
      actions.className = "spt-codex-screenshot-actions";
      const lightboxImage = this._screenshotLightboxImage(normalized);
      const preview = doc.createElement("button");
      preview.type = "button";
      preview.className = "spt-codex-screenshot-preview";
      preview.title = "放大查看 PDF 截图";
      preview.setAttribute("aria-label", `放大查看${screenshotPageLabel(normalized)}截图`);
      const placeholder = doc.createElement("span");
      placeholder.className = "spt-codex-screenshot-placeholder";
      placeholder.textContent = "展开后加载截图预览";
      preview.append(placeholder);
      let loaded = false;
      const loadImage = () => {
        if (loaded) return;
        loaded = true;
        if (!lightboxImage) {
          placeholder.textContent = "本地截图副本不可用";
          preview.disabled = true;
          return;
        }
        const image = doc.createElement("img");
        image.className = "spt-codex-screenshot-image";
        image.alt = `${screenshotPageLabel(normalized)}截图`;
        image.loading = "lazy";
        image.decoding = "async";
        image.addEventListener("error", () => {
          image.remove();
          placeholder.hidden = false;
          placeholder.textContent = "本地截图副本无法解码";
          preview.disabled = true;
        });
        placeholder.hidden = true;
        image.src = lightboxImage.localURI;
        preview.append(image);
      };
      registerDeferredImageLoader?.(loadImage);
      preview.addEventListener("click", () => {
        loadImage();
        if (lightboxImage) this._openImageLightbox(view, lightboxImage);
      });
      const metadata = doc.createElement("div");
      metadata.className = "spt-codex-screenshot-metadata";
      metadata.textContent = screenshotPositionSummary(normalized);
      if (lightboxImage) {
        const enlarge = makeButton(doc, "放大", () => {
          loadImage();
          this._openImageLightbox(view, lightboxImage);
        }, "spt-codex-screenshot-action");
        actions.append(enlarge);
      }
      if (onReselect) {
        const reselect = makeButton(
          doc,
          "重新框选",
          onReselect,
          "spt-codex-screenshot-action"
        );
        reselect.title = "保留当前截图，成功框选新区域后再替换";
        actions.append(reselect);
      }
      if (onRemove) {
        const remove = makeButton(doc, "移除", onRemove, "spt-codex-screenshot-action");
        remove.title = "从草稿移除并删除未发送的本地截图副本";
        actions.append(remove);
      }
      card.append(header, preview, metadata);
      if (actions.children.length) card.append(actions);
      container.append(card);
    }

    _appendScreenshotGroups(container, screenshots, { view, draft = false } = {}) {
      const normalized = screenshots.map(PDFScreenshot.normalizeStoredScreenshot).filter(Boolean);
      const groups = new Map();
      for (const screenshot of normalized) {
        const key = String(screenshot.location.pageIndex);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(screenshot);
      }
      for (const group of [...groups.values()].sort(
        (left, right) => left[0].location.pageIndex - right[0].location.pageIndex
      )) {
        const doc = container.ownerDocument;
        const details = doc.createElement("details");
        details.className = "spt-codex-screenshot-group";
        const summary = doc.createElement("summary");
        summary.textContent = `${screenshotPageLabel(group[0])} · ${group.length} 张截图`;
        const cards = doc.createElement("div");
        cards.className = "spt-codex-screenshot-group-cards";
        const loaders = [];
        for (const screenshot of group) {
          this._appendScreenshotContextCard(cards, screenshot, {
            view,
            registerDeferredImageLoader: (loader) => loaders.push(loader),
            onRemove: draft ? async () => {
              try {
                await this.service.deleteScreenshotDrafts(view.attachmentID, [screenshot]);
                const current = this._draftFor(view.attachmentID, false);
                if (!current) return;
                current.screenshots = current.screenshots.filter(
                  (candidate) => candidate.id !== screenshot.id
                );
                this._syncDraftViews(view.attachmentID);
              }
              catch (error) {
                view.elements.notices.textContent = error?.message || "无法移除 PDF 截图";
              }
            } : null,
            onReselect: draft ? async () => {
              if (view.screenshotPending) return;
              view.screenshotPending = true;
              this._updateComposerAvailability(view);
              try {
                const result = await this._requestScreenshot(view, screenshot.id);
                view.elements.notices.textContent = result?.cancelled
                  ? "已取消重新框选，原截图仍保留"
                  : `已用 ${Number(result?.added) || 0} 张新截图替换原截图`;
              }
              catch (error) {
                view.elements.notices.textContent = error?.message || "重新框选失败，原截图仍保留";
              }
              finally {
                view.screenshotPending = false;
                this._updateComposerAvailability(view);
              }
            } : null
          });
        }
        let imagesLoaded = false;
        const loadWhenExpanded = () => {
          if (!details.open || imagesLoaded) return;
          imagesLoaded = true;
          for (const loader of loaders) loader();
        };
        details.addEventListener("toggle", loadWhenExpanded);
        details.append(summary, cards);
        container.append(details);
      }
    }

    _renderDraftContexts(view) {
      const container = view?.elements?.draftContexts;
      if (!container) return;
      container.replaceChildren();
      const draft = this._draftFor(view.attachmentID, false);
      const selections = draft?.selections || [];
      const screenshots = draft?.screenshots || [];
      container.hidden = !selections.length && !screenshots.length;
      for (const selection of selections) {
        const key = CodexChat.selectionContextKey(selection);
        this._appendSelectionContextCard(container, selection, {
          onRemove: () => {
            const current = this._draftFor(view.attachmentID, false);
            if (!current) return;
            current.selections = current.selections.filter(
              (candidate) => CodexChat.selectionContextKey(candidate) !== key
            );
            this._syncDraftViews(view.attachmentID);
          }
        });
      }
      if (screenshots.length) {
        this._appendScreenshotGroups(container, screenshots, { view, draft: true });
      }
    }

    _updateComposerAvailability(view) {
      if (!view?.elements?.input || !view.elements.send) return;
      const state = view.state;
      const busy = ["connecting", "generating", "cancelling"].includes(state?.status);
      const waiting = state?.status === "waiting-approval";
      const blocked = !view.attachmentID || !state || busy || waiting ||
        state.sourceChanged || state.historyReadOnly;
      const question = this._draftFor(view.attachmentID, false)?.question ||
        view.elements.input.value || "";
      const screenshots = this._draftFor(view.attachmentID, false)?.screenshots || [];
      view.elements.input.disabled = Boolean(blocked);
      view.elements.send.disabled = Boolean(blocked || (!question.trim() && !screenshots.length));
      if (view.elements.screenshot) {
        view.elements.screenshot.disabled = Boolean(
          blocked || view.screenshotPending || !this._canRequestScreenshot(view)
        );
        view.elements.screenshot.textContent = view.screenshotPending ? "框选中…" : "截图";
      }
    }

    async _loadView({ body, setSectionSummary }) {
      let view = this.views.get(body);
      if (!view) return;
      view.setSectionSummary = setSectionSummary || view.setSectionSummary;
      const attachmentID = resolveReaderAttachmentID(body);
      if (!attachmentID) {
        view.elements.notices.textContent = "无法从当前 Reader tab 精确取得 PDF 附件，Codex 对话已禁用。";
        view.elements.input.disabled = true;
        view.elements.send.disabled = true;
        view.setSectionSummary?.("无法识别 PDF");
        return;
      }
      if (view.attachmentID !== attachmentID) {
        view.unsubscribe?.();
        view.attachmentID = attachmentID;
        view.transcriptRendered = false;
        view.unsubscribe = this.service.subscribe(attachmentID, (state) => this._updateView(view, state));
      }
      const draft = this._draftFor(attachmentID, false);
      view.elements.input.value = draft?.question || "";
      this._renderDraftContexts(view);
      try {
        const state = await this.service.load(attachmentID);
        this._restoreScreenshotDrafts(attachmentID, state);
        this._updateView(view, state);
        this._focusDraftInput(view);
      }
      catch (error) {
        view.elements.notices.textContent = error.message || "无法加载论文对话";
        view.elements.input.disabled = true;
        view.elements.send.disabled = true;
      }
    }

    async _run(body, action) {
      const view = this.views.get(body);
      if (!view?.attachmentID) return;
      let pendingDraft = null;
      try {
        if (action === "send") {
          const draft = this._draftFor(view.attachmentID);
          draft.question = view.elements.input.value;
          const question = draft.question.trim();
          const screenshots = CodexChat.normalizeStoredScreenshots(draft.screenshots);
          if (!question && !screenshots.length) return;
          pendingDraft = {
            question,
            selections: CodexChat.normalizeSelectionContexts(draft.selections),
            screenshots
          };
          this.drafts.set(view.attachmentID, {
            question: "",
            selections: [],
            screenshots: []
          });
          this._syncDraftViews(view.attachmentID);
          await this.service.send(view.attachmentID, question, {
            selections: pendingDraft.selections,
            screenshots: pendingDraft.screenshots
          });
        }
        else if (action === "screenshot") {
          view.screenshotPending = true;
          view.elements.notices.textContent = "请在左侧 PDF 阅读区拖动框选";
          this._updateComposerAvailability(view);
          try {
            const result = await this._requestScreenshot(view);
            view.elements.notices.textContent = result?.cancelled
              ? "已取消截图"
              : `已加入 ${Number(result?.added) || 0} 张 PDF 截图草稿`;
          }
          finally {
            view.screenshotPending = false;
            this._updateComposerAvailability(view);
          }
        }
        else if (action === "reload") await this.service.reload(view.attachmentID);
        else if (action === "cancel") await this.service.cancel(view.attachmentID);
        else if (action === "workspace") await this.service.openWorkspace(view.attachmentID);
        else if (action === "copy-log") {
          const report = await this.service.getDiagnosticReport(view.attachmentID);
          await copyTextToClipboard(
            body.ownerDocument,
            JSON.stringify(report, null, 2)
          );
          view.elements.copyLog.dataset.copiedCount = String(report.eventCount);
          view.elements.copyLog.textContent = `已复制 ${report.eventCount} 条`;
        }
        else if (action === "reset") {
          const confirmed = body.ownerDocument.defaultView.confirm(
            "新建会话会归档当前映射和旧工作区，并删除旧会话的工具图片与 PDF 截图副本；不会删除 Codex thread。继续吗？"
          );
          if (confirmed) {
            await this.service.rebuild(view.attachmentID);
            const draft = this._draftFor(view.attachmentID, false);
            if (draft) draft.screenshots = [];
            this._syncDraftViews(view.attachmentID);
          }
        }
      }
      catch (error) {
        if (action === "send" && pendingDraft) {
          const current = this._draftFor(view.attachmentID);
          const restored = [];
          const seen = new Set();
          for (const selection of [...pendingDraft.selections, ...current.selections]) {
            const key = CodexChat.selectionContextKey(selection);
            if (!key || seen.has(key)) continue;
            seen.add(key);
            restored.push(selection);
          }
          current.question ||= pendingDraft.question;
          current.selections = restored;
          const restoredScreenshots = [];
          const screenshotIDs = new Set();
          for (const screenshot of [...pendingDraft.screenshots, ...current.screenshots]) {
            const normalized = PDFScreenshot.normalizeStoredScreenshot(screenshot);
            if (!normalized || screenshotIDs.has(normalized.id)) continue;
            screenshotIDs.add(normalized.id);
            restoredScreenshots.push(normalized);
          }
          current.screenshots = restoredScreenshots;
          this._syncDraftViews(view.attachmentID);
        }
        view.elements.notices.textContent = error.message || "操作失败";
      }
    }

    _renderConfig(view, state) {
      const doc = view.body.ownerDocument;
      const container = view.elements.configuration;
      container.replaceChildren();
      if (!state.configOptions.length) {
        const unavailable = doc.createElement("p");
        unavailable.className = "spt-codex-config-hint";
        unavailable.textContent = "请先在插件设置中准备或重新检测 ACP，以读取可选模型。";
        container.append(unavailable);
        return;
      }
      const hint = doc.createElement("p");
      hint.className = "spt-codex-config-hint";
      hint.textContent = state.record.session.id
        ? "当前 PDF 已绑定 session；这里的选择只修改该 session。"
        : "设置页只提供默认值；这里的选择将用于当前 PDF 的新 session。";
      container.append(hint);
      for (const [id, label, recordKey] of [
        ["model", "模型", "model"],
        ["reasoning_effort", "推理", "reasoningEffort"]
      ]) {
        const option = state.configOptions.find((entry) => entry.id === id);
        const values = (option?.options || option?.values || []).map((entry) =>
          typeof entry === "string" ? { value: entry, name: entry } : entry
        ).filter((entry) => entry?.value);
        if (!option || !values.length) continue;
        const labelElement = doc.createElement("label");
        labelElement.textContent = label;
        const select = doc.createElement("select");
        for (const entry of values) {
          const choice = doc.createElement("option");
          choice.value = entry.value;
          choice.textContent = entry.name || entry.label || entry.value;
          select.append(choice);
        }
        select.value = state.record.session.config[recordKey] || option.currentValue || "";
        select.disabled = ["connecting", "generating", "cancelling", "waiting-approval"]
          .includes(state.status);
        select.addEventListener("change", async () => {
          const previous = state.record.session.config[recordKey] || option.currentValue || "";
          select.disabled = true;
          try {
            await this.service.setSessionConfig(view.attachmentID, id, select.value);
          }
          catch (error) {
            select.value = previous;
            view.elements.notices.textContent = error.message || "配置失败";
            select.disabled = false;
          }
        });
        labelElement.append(select);
        container.append(labelElement);
      }
    }

    _renderNotices(view, state) {
      const doc = view.body.ownerDocument;
      const container = view.elements.notices;
      container.replaceChildren();
      if (state.error) {
        const error = doc.createElement("div");
        error.className = "spt-codex-notice spt-codex-error";
        error.textContent = state.error;
        container.append(error);
      }
      if (state.sourceChanged) {
        const notice = doc.createElement("div");
        notice.className = "spt-codex-notice";
        const text = doc.createElement("p");
        text.textContent = "PDF 源文件已变化，发送已暂停。";
        notice.append(
          text,
          makeButton(doc, "继续使用旧快照", () => {
            this.service.acknowledgeSourceChange(view.attachmentID).catch((error) => {
              container.textContent = error.message;
            });
          }),
          makeButton(doc, "为新 PDF 新建会话", async () => {
            if (doc.defaultView.confirm("归档旧映射、删除旧会话工具图片副本，并为新 PDF 建立会话？")) {
              await this.service.rebuild(view.attachmentID, "source-changed");
            }
          }, "spt-codex-danger-button")
        );
        container.append(notice);
      }
      if (!state.adapter.preparedVersion || state.adapter.preparedVersion !== state.adapter.requiredVersion) {
        const notice = doc.createElement("div");
        notice.className = "spt-codex-notice";
        notice.textContent = `尚未准备 codex-acp ${state.adapter.requiredVersion}。请先到插件设置执行“准备并检测 ACP”。`;
        container.append(notice);
      }
      for (const interaction of state.pendingInteractions) {
        container.append(this._renderInteraction(view, interaction));
      }
    }

    _renderInteraction(view, interaction) {
      const doc = view.body.ownerDocument;
      const card = doc.createElement("div");
      card.className = "spt-codex-interaction";
      const heading = doc.createElement("strong");
      heading.textContent = interaction.type === "permission" ? interaction.title : interaction.message;
      card.append(heading);
      if (interaction.type === "permission") {
        const details = doc.createElement("div");
        details.className = "spt-codex-permission-tool";
        appendToolDetails(doc, details, {
          kind: "tool",
          title: interaction.title,
          toolKind: interaction.toolCall.kind,
          rawInput: interaction.toolCall.rawInput,
          content: interaction.toolCall.content,
          locations: interaction.toolCall.locations,
          status: "pending"
        }, view.state?.record?.session?.workspacePath || "", this._externalLinkOptions(view));
        card.append(details);
        const actions = doc.createElement("div");
        actions.className = "spt-codex-interaction-actions";
        for (const option of interaction.options) {
          actions.append(makeButton(doc, option.name, () => {
            this.service.respondPermission(view.attachmentID, interaction.id, option.optionId)
              .catch((error) => { view.elements.notices.textContent = error.message; });
          }, /reject|deny|cancel|拒绝/iu.test(`${option.kind} ${option.name}`) ? "spt-codex-danger-button" : ""));
        }
        card.append(actions);
      }
      else {
        const form = doc.createElement("form");
        const schema = interaction.requestedSchema || {};
        const inputs = new Map();
        for (const [name, property] of Object.entries(schema.properties || {})) {
          const label = doc.createElement("label");
          label.textContent = property.title || name;
          let input;
          const choices = property.oneOf || property.enum;
          if (Array.isArray(choices)) {
            input = doc.createElement("select");
            for (const choice of choices) {
              const option = doc.createElement("option");
              option.value = typeof choice === "object" ? choice.const : choice;
              option.textContent = typeof choice === "object" ? (choice.title || choice.const) : choice;
              input.append(option);
            }
          }
          else {
            input = doc.createElement("input");
            input.type = property.type === "boolean" ? "checkbox" :
              (property.isSecret ? "password" : "text");
          }
          input.required = (schema.required || []).includes(name);
          label.append(input);
          form.append(label);
          inputs.set(name, { input, property });
        }
        const accept = makeButton(doc, "提交", (event) => {
          event.preventDefault();
          if (!form.reportValidity()) return;
          const content = {};
          for (const [name, { input, property }] of inputs) {
            let value = property.type === "boolean" ? input.checked : input.value;
            if (property.type === "number" || property.type === "integer") value = Number(value);
            content[name] = value;
          }
          this.service.respondElicitation(view.attachmentID, interaction.id, "accept", content)
            .catch((error) => { view.elements.notices.textContent = error.message; });
        });
        const decline = makeButton(doc, "拒绝", (event) => {
          event.preventDefault();
          this.service.respondElicitation(view.attachmentID, interaction.id, "decline")
            .catch((error) => { view.elements.notices.textContent = error.message; });
        }, "spt-codex-danger-button");
        form.append(accept, decline);
        card.append(form);
      }
      return card;
    }

    _renderTranscript(view, state) {
      const doc = view.body.ownerDocument;
      const container = view.elements.messages;
      const renderedBefore = Boolean(view.transcriptRendered);
      const viewport = captureTranscriptViewport(container, renderedBefore);
      container.replaceChildren();
      if (!state.record.transcript.length) {
        const empty = doc.createElement("p");
        empty.className = "spt-codex-empty";
        empty.textContent = "首条消息会复制当前 PDF 到专用工作区；截图会以内嵌图片和精确 PDF 位置发送，后续不重复附加原 PDF。";
        container.append(empty);
        view.transcriptRendered = true;
        restoreTranscriptViewport(container, viewport, renderedBefore);
        return;
      }
      for (const [index, entry] of state.record.transcript.entries()) {
        if (entry.kind === "thought") continue;
        const entryKey = transcriptEntryKey(entry, index);
        if (entry.kind === "message") {
          const article = doc.createElement("article");
          article.className = `spt-codex-message spt-codex-${entry.role}`;
          article.setAttribute("data-entry-key", entryKey);
          const header = doc.createElement("header");
          header.className = "spt-codex-message-header";
          const avatar = doc.createElement("span");
          avatar.className = "spt-codex-message-avatar";
          avatar.textContent = entry.role === "user" ? "你" : "C";
          avatar.setAttribute("aria-hidden", "true");
          const label = doc.createElement("strong");
          label.textContent = entry.role === "user" ? "你" : "Codex";
          header.append(avatar, label);
          const content = doc.createElement("div");
          content.className = "spt-codex-markdown";
          renderSafeMarkdown(doc, content, entry.text, {
            ...this._externalLinkOptions(view),
            onFileCitation: ({ path }) => {
              this.service.revealCitation(view.attachmentID, path).catch((error) => {
                view.elements.notices.textContent = error.message || "无法打开引用文件";
              });
            }
          });
          article.append(header);
          const selections = entry.role === "user"
            ? CodexChat.normalizeSelectionContexts(entry.selections)
            : [];
          const screenshots = entry.role === "user"
            ? (entry.screenshots || []).map(PDFScreenshot.normalizeStoredScreenshot).filter(Boolean)
            : [];
          if (selections.length || screenshots.length) {
            const contexts = doc.createElement("div");
            contexts.className = "spt-codex-message-contexts";
            for (const selection of selections) {
              this._appendSelectionContextCard(contexts, selection);
            }
            if (screenshots.length) {
              this._appendScreenshotGroups(contexts, screenshots, { view, draft: false });
            }
            article.append(contexts);
          }
          article.append(content);
          container.append(article);
        }
        else {
          const details = doc.createElement("details");
          details.className = `spt-codex-event spt-codex-event-${entry.kind}`;
          details.setAttribute("data-entry-key", entryKey);
          details.open = viewport.expanded.has(entryKey);
          const summary = doc.createElement("summary");
          const toolPresentation = entry.kind === "tool"
            ? describeToolEntry(entry, state.record.session.workspacePath)
            : null;
          const eventIcon = doc.createElement("span");
          eventIcon.className = "spt-codex-event-icon";
          eventIcon.textContent = toolPresentation?.icon || (entry.kind === "plan" ? "☷" : "✦");
          eventIcon.setAttribute("aria-hidden", "true");
          const eventTitle = doc.createElement("span");
          eventTitle.className = "spt-codex-event-title";
          eventTitle.textContent = entry.kind === "tool"
            ? toolPresentation.summary
            : entry.kind === "plan" ? "计划" : "思考过程";
          summary.append(eventIcon, eventTitle);
          if (entry.kind === "tool" && entry.status) {
            const imageStatus = entry.imageSnapshot?.status;
            const visibleStatus = imageStatus === "error"
              ? "failed"
              : imageStatus === "copying" ? "in_progress" : entry.status;
            const eventStatus = doc.createElement("span");
            eventStatus.className = `spt-codex-event-status spt-codex-event-status-${visibleStatus}`;
            eventStatus.textContent = imageStatus === "error"
              ? "图片失败"
              : imageStatus === "copying" ? "复制中" : ({
              completed: "完成", failed: "失败", pending: "等待", in_progress: "进行中"
            }[entry.status] || entry.status);
            summary.append(eventStatus);
          }
          const eventContent = doc.createElement("div");
          eventContent.className = "spt-codex-event-content";
          if (entry.kind === "tool") {
            let loadDeferredImage = null;
            appendToolDetails(
              doc,
              eventContent,
              entry,
              state.record.session.workspacePath,
              {
                ...this._externalLinkOptions(view),
                deferImageLoad: true,
                registerDeferredImageLoader: (loader) => { loadDeferredImage = loader; },
                onImagePreview: (image) => this._openImageLightbox(view, image)
              }
            );
            if (loadDeferredImage) {
              const loadWhenExpanded = () => {
                if (details.open) loadDeferredImage();
              };
              details.addEventListener("toggle", loadWhenExpanded);
              if (details.open) loadWhenExpanded();
            }
          }
          else if (entry.kind === "plan" && Array.isArray(entry.entries)) {
            const list = doc.createElement("ol");
            for (const item of entry.entries) {
              const listItem = doc.createElement("li");
              listItem.textContent = typeof item === "string"
                ? item
                : String(item?.content || item?.text || item?.description || stringifyDetails(item));
              list.append(listItem);
            }
            eventContent.append(list);
          }
          else {
            const pre = doc.createElement("pre");
            pre.textContent = stringifyDetails(entry);
            eventContent.append(pre);
          }
          details.append(summary, eventContent);
          container.append(details);
          eventContent.scrollTop = viewport.innerScroll.get(entryKey) || 0;
        }
      }
      view.transcriptRendered = true;
      restoreTranscriptViewport(container, viewport, renderedBefore);
    }

    _updateView(view, state) {
      view.state = state;
      const busy = ["connecting", "generating", "cancelling"].includes(state.status);
      const waiting = state.status === "waiting-approval";
      view.elements.status.textContent = {
        idle: "本地历史",
        ready: "已连接",
        connecting: "正在连接…",
        generating: "Codex 正在生成…",
        cancelling: "正在停止…",
        cancelled: "已停止",
        error: "连接异常",
        "thread-missing": "thread 缺失",
        "waiting-approval": "等待授权"
      }[state.status] || state.status;
      view.root.dataset.status = state.status;
      view.setSectionSummary?.(waiting ? "等待授权" : (state.record.session.id ? "已绑定会话" : "未创建会话"));
      const activityLabel = {
        connecting: "正在连接本地 Codex…",
        generating: state.activityText || "Codex 正在思考…",
        cancelling: "正在停止当前任务…",
        "waiting-approval": "等待你的授权…"
      }[state.status] || "";
      view.elements.activity.hidden = !activityLabel;
      view.elements.activity.dataset.status = state.status;
      view.elements.activityText.textContent = activityLabel;
      view.elements.stop.hidden = state.status !== "generating" && !waiting;
      view.elements.reset.disabled = busy || waiting;
      if (view.elements.copyLog) {
        const eventCount = Number(state.diagnosticEventCount) || 0;
        view.elements.copyLog.hidden = !state.developerMode;
        view.elements.copyLog.disabled = !state.developerMode;
        if (view.elements.copyLog.dataset.copiedCount !== String(eventCount)) {
          delete view.elements.copyLog.dataset.copiedCount;
          view.elements.copyLog.textContent = eventCount
            ? `复制日志 (${eventCount})`
            : "复制日志";
        }
      }
      this._renderConfig(view, state);
      this._renderNotices(view, state);
      this._renderTranscript(view, state);
      this._renderDraftContexts(view);
      this._updateComposerAvailability(view);
    }

    async shutdown() {
      for (const body of Array.from(this.views.keys())) this._destroyView(body);
      if (this.paneID) global.Zotero.ItemPaneManager.unregisterSection(this.paneID);
      this.paneID = null;
      this.drafts.clear();
      this.pendingDraftFocus.clear();
      for (const cleanup of this.windowCleanups.values()) cleanup();
      this.windowCleanups.clear();
    }
  }

  modules.CodexChatUI = {
    CodexChatUI,
    CODEX_L10N_RESOURCE,
    CODEX_HEADER_L10N_ID,
    CODEX_SIDENAV_L10N_ID,
    ensureCodexLocalization,
    resolveReaderAttachmentID,
    selectionPageLabel,
    screenshotPageLabel,
    screenshotPositionSummary,
    openExternalURL,
    renderSafeMarkdown,
    captureTranscriptViewport,
    restoreTranscriptViewport,
    describeToolEntry,
    describeToolImage,
    appendToolImageDetails,
    appendToolDetails,
    copyTextToClipboard
  };
  if (typeof module !== "undefined" && module.exports) module.exports = modules.CodexChatUI;
})(typeof globalThis !== "undefined" ? globalThis : this);
