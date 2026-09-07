(function (global) {
  "use strict";

  const modules = global.SmartPaperTranslatorModules = global.SmartPaperTranslatorModules || {};
  const REVISION = "pi-thinking-levels-1";
  // Exact npm pi-acp@0.0.33 dist/index.js, verified against the prepared adapter.
  const ADAPTER_SHA256 = "24ff73fda6e3c76ddce2d359a79f5c4b8f292eb290e4d2ab85aac94676b2c2dc";

  // These functions are serialized into the pinned adapter's Node process. They
  // never run in Zotero and never infer model capabilities from a model name.
  function isThinkingLevel(value) {
    return ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value);
  }

  async function sptAvailableThinkingLevels(proc) {
    const response = await proc.request({ type: "get_available_thinking_levels" });
    const levels = response?.data?.levels;
    if (response?.success !== true || !Array.isArray(levels) || !levels.length ||
        levels.length > 7 || levels.some(level => !isThinkingLevel(level))) {
      throw new Error("SPT_PI_THINKING_OPTIONS: Pi did not return valid model thinking levels");
    }
    return [...new Set(levels)];
  }

  async function getThinkingState(proc, pre) {
    const available = await sptAvailableThinkingLevels(proc);
    const state = pre?.state ?? await proc.getState();
    const current = state?.thinkingLevel;
    if (!available.includes(current)) {
      throw new Error("SPT_PI_THINKING_STATE: Pi returned an unsupported current thinking level");
    }
    return {
      currentModeId: current,
      availableModes: available.map(id => ({ id, name: `Thinking: ${id}`, description: null }))
    };
  }

  async function sptSetThinkingLevel(level) {
    const available = await sptAvailableThinkingLevels(this);
    if (!available.includes(level)) {
      throw new Error(`SPT_PI_THINKING_UNSUPPORTED: ${level}`);
    }
    const response = await this.request({ type: "set_thinking_level", level });
    if (response?.success !== true) throw new Error("SPT_PI_THINKING_SET_FAILED");
    const state = await this.getState();
    if (state?.thinkingLevel !== level) throw new Error("SPT_PI_THINKING_NOT_APPLIED");
  }

  function patchAdapterSource(source) {
    const replaceBlock = (start, end, replacement) => {
      const from = source.indexOf(start);
      const to = source.indexOf(end, from + start.length);
      if (from < 0 || to <= from || source.indexOf(start, from + start.length) !== -1) {
        throw new Error("SPT_PI_COMPAT_LAYOUT: The pinned adapter layout has changed");
      }
      source = source.slice(0, from) + replacement + "\n" + source.slice(to);
    };
    replaceBlock("function isThinkingLevel(x) {", "async function getSessionConfiguration(proc, pre) {",
      [isThinkingLevel, sptAvailableThinkingLevels, getThinkingState, sptSetThinkingLevel].map(fn => fn.toString()).join("\n"));
    replaceBlock("  async setThinkingLevel(level) {", "  async setFollowUpMode(mode) {",
      "  async setThinkingLevel(level) { return sptSetThinkingLevel.call(this, level); }");
    return source;
  }

  async function launchPiAdapter() {
    const fs = require("node:fs");
    const path = require("node:path");
    const { createHash } = require("node:crypto");
    const { pathToFileURL } = require("node:url");
    const { registerHooks } = require("node:module");
    if (typeof registerHooks !== "function") throw new Error("SPT_PI_COMPAT_NODE: Node >= 22.19.0 is required");
    // npm exec prepends its package .bin directory. Resolve its entry without
    // running another command or loading a package from the paper workspace.
    let entry;
    for (const directory of (process.env.PATH || "").split(path.delimiter)) {
      if (!path.isAbsolute(directory)) continue;
      const candidate = path.join(directory, "pi-acp");
      try { entry = fs.realpathSync(candidate); break; }
      catch (error) { if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error; }
    }
    if (!entry) throw new Error("SPT_PI_COMPAT_MISSING: Prepare pi-acp 0.0.33 in plugin settings");
    const stat = fs.statSync(entry);
    if (!stat.isFile() || stat.size > 1024 * 1024 || path.basename(entry) !== "index.js" ||
        path.basename(path.dirname(entry)) !== "dist") throw new Error("SPT_PI_COMPAT_ENTRY");
    const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(entry), "..", "package.json"), "utf8"));
    if (pkg.name !== "pi-acp" || pkg.version !== "0.0.33") throw new Error("SPT_PI_COMPAT_VERSION");
    const bytes = fs.readFileSync(entry);
    if (createHash("sha256").update(bytes).digest("hex") !== ADAPTER_SHA256) {
      throw new Error("SPT_PI_COMPAT_HASH: The pinned adapter differs from the verified release");
    }
    const patched = patchAdapterSource(bytes.toString("utf8"));
    const entryURL = pathToFileURL(entry).href;
    // Only this exact, verified module is transformed; dependencies and the Pi
    // subprocess use their normal loaders. Nothing is written to the npm cache.
    const hook = registerHooks({ load(url, context, nextLoad) {
      if (url === entryURL) return { format: "module", source: patched, shortCircuit: true };
      return nextLoad(url, context);
    } });
    process.argv = [process.execPath, entry];
    try { await import(entryURL); }
    finally { hook.deregister(); }
  }

  function createLauncherSource() {
    return '"use strict";\n' + `const ADAPTER_SHA256 = ${JSON.stringify(ADAPTER_SHA256)};\n` +
      [isThinkingLevel, sptAvailableThinkingLevels, getThinkingState, sptSetThinkingLevel, patchAdapterSource, launchPiAdapter]
        .map(fn => fn.toString()).join("\n") +
      '\nlaunchPiAdapter().catch(error => { process.stderr.write(String(error.message) + "\\n"); process.exitCode = 1; });';
  }

  modules.PiACPCompat = { REVISION, ADAPTER_SHA256, createLauncherSource, patchAdapterSource };
  if (typeof module !== "undefined" && module.exports) module.exports = modules.PiACPCompat;
})(typeof globalThis !== "undefined" ? globalThis : this);
