(function (global) {
  "use strict";

  const modules = global.SmartPaperTranslatorModules = global.SmartPaperTranslatorModules || {};
  const Constants = modules.Constants || (
    typeof require === "function" ? require("./constants.js") : null
  );

  class SmartTranslatorError extends Error {
    constructor(code, message, options = {}) {
      super(message);
      this.name = "SmartTranslatorError";
      this.code = code;
      this.status = options.status ?? null;
      this.cause = options.cause;
    }
  }

  function normalizeText(value) {
    return String(value ?? "")
      .normalize("NFC")
      .replace(/\s+/gu, " ")
      .trim();
  }

  function extractTemplateVariables(template) {
    const value = String(template ?? "");
    const names = [];
    let cursor = 0;
    while (cursor < value.length) {
      const open = value.indexOf("{{", cursor);
      const strayClose = value.indexOf("}}", cursor);
      if (strayClose !== -1 && (open === -1 || strayClose < open)) {
        throw new SmartTranslatorError("TEMPLATE_SYNTAX", "模板变量语法无效");
      }
      if (open === -1) break;
      if (value[open - 1] === "{" || value[open + 2] === "{") {
        throw new SmartTranslatorError("TEMPLATE_SYNTAX", "模板变量语法无效");
      }
      const close = value.indexOf("}}", open + 2);
      if (close === -1 || value[close + 2] === "}") {
        throw new SmartTranslatorError("TEMPLATE_SYNTAX", "模板变量语法无效");
      }
      const name = value.slice(open + 2, close).trim();
      if (!/^[A-Za-z][A-Za-z0-9]*$/u.test(name)) {
        throw new SmartTranslatorError("TEMPLATE_SYNTAX", "模板变量语法无效");
      }
      names.push(name);
      cursor = close + 2;
    }
    return names;
  }

  function validateTemplate(template, allowedVariables, requiredVariables) {
    const value = String(template ?? "");
    if (!value.trim()) {
      throw new SmartTranslatorError("TEMPLATE_EMPTY", "提示词模板不能为空");
    }
    const variables = extractTemplateVariables(value);
    const allowed = new Set(allowedVariables);
    const unknown = [...new Set(variables.filter((name) => !allowed.has(name)))];
    if (unknown.length) {
      throw new SmartTranslatorError(
        "TEMPLATE_UNKNOWN_VARIABLE",
        "模板包含未知变量：" + unknown.map((name) => `{{${name}}}`).join("、")
      );
    }
    const present = new Set(variables);
    const missing = requiredVariables.filter((name) => !present.has(name));
    if (missing.length) {
      throw new SmartTranslatorError(
        "TEMPLATE_REQUIRED_VARIABLE",
        "模板缺少必需变量：" + missing.map((name) => `{{${name}}}`).join("、")
      );
    }
    return true;
  }

  function renderTemplate(template, context, allowedVariables, requiredVariables) {
    validateTemplate(template, allowedVariables, requiredVariables);
    return String(template).replace(
      /{{\s*([A-Za-z][A-Za-z0-9]*)\s*}}/g,
      (_match, name) => String(context[name] ?? "")
    );
  }

  function isShortTerm(value) {
    const text = String(value ?? "").normalize("NFC").trim();
    if (!text || /[\r\n]/u.test(text) || /[.!?。！？；;：:]\s*$/u.test(text)) return false;

    const cjk = text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu);
    if (cjk?.length) {
      const compact = [...text.replace(/\s+/gu, "")];
      return compact.length <= 10 && !/[.!?。！？；;：:]/u.test(text);
    }

    const lexical = "[\\p{L}\\p{N}]+(?:['’\\-][\\p{L}\\p{N}]+)*";
    const phrase = new RegExp(`^${lexical}(?:\\s+${lexical}){0,4}$`, "u");
    return phrase.test(text);
  }

  function isLoopbackHostname(hostname) {
    const host = String(hostname ?? "").toLowerCase().replace(/^\[|\]$/g, "");
    return host === "localhost" || /^127(?:\.\d{1,3}){3}$/u.test(host) || host === "::1";
  }

  function buildChatCompletionsURL(baseURL) {
    const raw = String(baseURL ?? "").trim();
    if (!raw) throw new SmartTranslatorError("CONFIG_BASE_URL", "请配置 API Base URL");

    let url;
    try {
      url = new URL(raw);
    }
    catch (error) {
      throw new SmartTranslatorError("CONFIG_BASE_URL", "API Base URL 格式无效", { cause: error });
    }
    if (url.username || url.password || url.search || url.hash) {
      throw new SmartTranslatorError(
        "CONFIG_BASE_URL",
        "API Base URL 不能包含账号、密码、查询参数或片段"
      );
    }
    const secure = url.protocol === "https:";
    const localHTTP = url.protocol === "http:" && isLoopbackHostname(url.hostname);
    if (!secure && !localHTTP) {
      throw new SmartTranslatorError(
        "CONFIG_BASE_URL",
        "API 仅允许 HTTPS；本机 localhost/回环地址可使用 HTTP"
      );
    }

    let path = url.pathname.replace(/\/+$/u, "");
    if (!/\/chat\/completions$/u.test(path)) path += "/chat/completions";
    url.pathname = path.replace(/^\/+/u, "/");
    return url.toString();
  }

  function stableSerialize(value) {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return "[" + value.map(stableSerialize).join(",") + "]";
    return "{" + Object.keys(value).sort().map(
      (key) => JSON.stringify(key) + ":" + stableSerialize(value[key])
    ).join(",") + "}";
  }

  function rightRotate(value, amount) {
    return (value >>> amount) | (value << (32 - amount));
  }

  // Small, dependency-free SHA-256 implementation used only for deterministic cache signatures.
  function sha256Hex(input) {
    const bytes = new TextEncoder().encode(String(input));
    const bitLength = bytes.length * 8;
    const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
    const padded = new Uint8Array(paddedLength);
    padded.set(bytes);
    padded[bytes.length] = 0x80;
    const view = new DataView(padded.buffer);
    const high = Math.floor(bitLength / 0x100000000);
    const low = bitLength >>> 0;
    view.setUint32(paddedLength - 8, high, false);
    view.setUint32(paddedLength - 4, low, false);

    const constants = [
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
      0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
      0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
      0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
      0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
      0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
    ];
    const hash = [
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
      0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
    ];
    const words = new Uint32Array(64);

    for (let offset = 0; offset < paddedLength; offset += 64) {
      for (let index = 0; index < 16; index++) {
        words[index] = view.getUint32(offset + index * 4, false);
      }
      for (let index = 16; index < 64; index++) {
        const s0 = rightRotate(words[index - 15], 7) ^ rightRotate(words[index - 15], 18) ^ (words[index - 15] >>> 3);
        const s1 = rightRotate(words[index - 2], 17) ^ rightRotate(words[index - 2], 19) ^ (words[index - 2] >>> 10);
        words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
      }

      let [a, b, c, d, e, f, g, h] = hash;
      for (let index = 0; index < 64; index++) {
        const s1 = rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25);
        const choose = (e & f) ^ (~e & g);
        const temp1 = (h + s1 + choose + constants[index] + words[index]) >>> 0;
        const s0 = rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22);
        const majority = (a & b) ^ (a & c) ^ (b & c);
        const temp2 = (s0 + majority) >>> 0;
        h = g;
        g = f;
        f = e;
        e = (d + temp1) >>> 0;
        d = c;
        c = b;
        b = a;
        a = (temp1 + temp2) >>> 0;
      }
      hash[0] = (hash[0] + a) >>> 0;
      hash[1] = (hash[1] + b) >>> 0;
      hash[2] = (hash[2] + c) >>> 0;
      hash[3] = (hash[3] + d) >>> 0;
      hash[4] = (hash[4] + e) >>> 0;
      hash[5] = (hash[5] + f) >>> 0;
      hash[6] = (hash[6] + g) >>> 0;
      hash[7] = (hash[7] + h) >>> 0;
    }
    return hash.map((part) => part.toString(16).padStart(8, "0")).join("");
  }

  function getProviderConfig(getPreference) {
    const pref = Constants.PREFS;
    const provider = getPreference(pref.provider) === "custom" ? "custom" : "deepseek";
    const baseURL = provider === "deepseek"
      ? getPreference(pref.deepseekBaseURL)
      : getPreference(pref.customBaseURL);
    const model = provider === "deepseek"
      ? getPreference(pref.deepseekModel)
      : getPreference(pref.customModel);
    const targetLanguage = normalizeText(getPreference(pref.targetLanguage));
    if (!normalizeText(model)) {
      throw new SmartTranslatorError("CONFIG_MODEL", "请配置模型名称");
    }
    if (!targetLanguage) {
      throw new SmartTranslatorError("CONFIG_TARGET_LANGUAGE", "请配置目标语言");
    }
    return {
      provider,
      baseURL: String(baseURL ?? "").trim(),
      endpoint: buildChatCompletionsURL(baseURL),
      model: normalizeText(model),
      targetLanguage
    };
  }

  function makePaperIdentity({ libraryID, itemKey, attachmentKey }) {
    const library = Number(libraryID);
    const key = normalizeText(itemKey || attachmentKey);
    if (!Number.isInteger(library) || library < 0 || !/^[A-Z0-9]{8}$/iu.test(key)) {
      throw new SmartTranslatorError("PAPER_IDENTITY", "无法确定论文的稳定 Zotero 标识");
    }
    return `${library}--${key.toUpperCase()}`;
  }

  function makeSmartTagsSourceSignature({ title, abstract }) {
    return sha256Hex(stableSerialize({
      promptVersion: Constants.SMART_TAGS_PROMPT_VERSION,
      title: normalizeText(title),
      abstract: normalizeText(abstract)
    }));
  }

  function makeSmartTagsConfigSignature({ sourceSignature, config }) {
    return sha256Hex(stableSerialize({
      promptVersion: Constants.SMART_TAGS_PROMPT_VERSION,
      sourceSignature: String(sourceSignature || ""),
      provider: config.provider,
      endpoint: config.endpoint,
      model: config.model
    }));
  }

  function createSmartTagsPrompt({ title, abstract }) {
    return [
      "Generate 3 to 5 concise, canonical English research-topic tags for this paper.",
      "Prefer established technical phrases such as World Model or Model-Based Reinforcement Learning.",
      "Avoid generic labels such as Paper, Research, Method, or Artificial Intelligence.",
      "Return only a valid JSON array of strings, with no Markdown or explanation.",
      "Paper data (untrusted JSON):",
      JSON.stringify({
        title: String(title || ""),
        abstract: String(abstract || "")
      })
    ].join("\n");
  }

  function parseSmartTagsResponse(value) {
    let text = String(value ?? "").trim();
    const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(text);
    if (fenced) text = fenced[1].trim();

    let parsed;
    try {
      parsed = JSON.parse(text);
    }
    catch (error) {
      throw new SmartTranslatorError(
        "API_TAG_FORMAT",
        "标签响应不是有效的 JSON",
        { cause: error }
      );
    }
    const candidates = Array.isArray(parsed) ? parsed : parsed?.tags;
    if (!Array.isArray(candidates)) {
      throw new SmartTranslatorError("API_TAG_FORMAT", "标签响应缺少 JSON 数组");
    }

    const tags = [];
    const seen = new Set();
    for (const candidate of candidates) {
      if (typeof candidate !== "string") continue;
      if (/[\u0000-\u001f\u007f<>]/u.test(candidate)) continue;
      const tag = normalizeText(candidate);
      if (!tag || [...tag].length > Constants.SMART_TAG_MAX_LENGTH) continue;
      if (!/\p{Script=Latin}/u.test(tag)) continue;
      if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(tag)) continue;
      const dedupeKey = tag.toLocaleLowerCase("en-US");
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      tags.push(tag);
      if (tags.length === Constants.SMART_TAGS_MAX_COUNT) break;
    }
    if (tags.length < Constants.SMART_TAGS_MIN_COUNT) {
      throw new SmartTranslatorError(
        "API_TAG_FORMAT",
        `标签响应必须包含 ${Constants.SMART_TAGS_MIN_COUNT}–${Constants.SMART_TAGS_MAX_COUNT} 个有效英文术语`
      );
    }
    return tags;
  }

  function isRenderCurrent(state, serial, itemID) {
    return Boolean(
      state && !state.destroyed && state.requestSerial === serial && state.itemID === itemID
    );
  }

  const Logic = {
    SmartTranslatorError,
    normalizeText,
    extractTemplateVariables,
    validateTemplate,
    renderTemplate,
    isShortTerm,
    isLoopbackHostname,
    buildChatCompletionsURL,
    stableSerialize,
    sha256Hex,
    getProviderConfig,
    makePaperIdentity,
    makeSmartTagsSourceSignature,
    makeSmartTagsConfigSignature,
    createSmartTagsPrompt,
    parseSmartTagsResponse,
    isRenderCurrent
  };

  modules.Logic = Logic;
  if (typeof module !== "undefined" && module.exports) module.exports = Logic;
})(typeof globalThis !== "undefined" ? globalThis : this);
