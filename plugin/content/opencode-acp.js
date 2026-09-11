(function (global) {
  "use strict";
  const modules = global.SmartPaperTranslatorModules = global.SmartPaperTranslatorModules || {};
  const MIN_VERSION = "1.18.30";
  const REVISION = "opencode-native-acp-2";
  const MAX_MODEL_BYTES = 16 * 1024 * 1024;
  const MAX_MODELS = 10000;
  // Gecko's Unix pipe worker can observe HUP between read requests and close
  // before all buffered output is drained. Keep the CLI's stdout open until
  // the bounded collector has received a private end marker and closes stdin.
  // Only this short, read-only command uses sh; ACP itself is launched directly.
  const MODEL_COLLECT_SCRIPT = `spt_marker=$1
shift
spt_child=
trap 'if [ -n "$spt_child" ]; then kill -KILL "$spt_child" 2>/dev/null; wait "$spt_child" 2>/dev/null; fi; exit 143' HUP INT TERM
"$@" </dev/null &
spt_child=$!
wait "$spt_child"
spt_exit=$?
spt_child=
printf '\\n%s\\n' "$spt_marker"
IFS= read -r spt_ack
exit "$spt_exit"`;

  function fail(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function parseVersion(value) {
    const match = String(value).trim().match(/^(?:opencode\s+|v)?((\d{1,6})\.(\d{1,6})\.(\d{1,6}))$/u);
    if (!match) throw fail("OPENCODE_VERSION_UNKNOWN", "无法识别 OpenCode 版本；需要稳定版 1.18.30 或更新的 1.x");
    if (Number(match[2]) !== 1 || Number(match[3]) < 18 || (Number(match[3]) === 18 && Number(match[4]) < 30)) {
      throw fail("OPENCODE_VERSION_UNSUPPORTED", "OpenCode 版本不受支持；需要 1.18.30 或更新的 1.x，请在终端更新后重新检测");
    }
    return match[1];
  }

  function isSupportedVersion(value) {
    try { return parseVersion(value) === value; }
    catch (_error) { return false; }
  }

  function absolutePath(path) {
    return typeof path === "string" && path.startsWith("/") && path.length <= 4096 && !/[\0\r\n]/u.test(path);
  }

  // Local terminal-title plugins can emit OSC 0/1/2 even in ACP mode.
  // These are literal control bytes, unlike escaped characters inside JSON.
  // Accept only bounded title sequences; arbitrary logs and other OSC commands
  // (including clipboard/link commands) must still fail protocol validation.
  class TerminalTitleFilter {
    constructor() { this.pending = ""; }

    push(chunk) {
      const text = this.pending + String(chunk || "");
      this.pending = "";
      let output = "", offset = 0;
      while (offset < text.length) {
        const start = text.indexOf("\x1b", offset);
        if (start < 0) return output + text.slice(offset);
        output += text.slice(offset, start);
        const rest = text.slice(start);
        if (["\x1b", "\x1b]", "\x1b]0", "\x1b]1", "\x1b]2"].includes(rest)) {
          this.pending = rest;
          return output;
        }
        if (!/^\x1b\][012];/u.test(rest)) throw fail("OPENCODE_STDOUT_CONTROL", "OpenCode 协议包含不支持的终端控制码；请检查本机扩展的 stdout 输出");
        const terminator = /\x07|\x1b\\/u.exec(rest);
        const title = rest.slice(4, terminator ? terminator.index : undefined);
        const partialTitle = !terminator && title.endsWith("\x1b") ? title.slice(0, -1) : title;
        if (/[\x00-\x1f\x7f]/u.test(partialTitle) || new TextEncoder().encode(rest.slice(0, terminator?.index)).length > 4096) {
          throw fail("OPENCODE_STDOUT_CONTROL", "OpenCode 终端标题控制码无效或超过上限");
        }
        if (!terminator) {
          this.pending = rest;
          return output;
        }
        offset = start + terminator.index + terminator[0].length;
      }
      return output;
    }

    finish() {
      if (this.pending) throw fail("OPENCODE_STDOUT_CONTROL", "OpenCode 返回了不完整的终端标题控制码");
    }
  }

  // models --verbose is an ID line followed by a pretty-printed JSON object.
  // Never cache headers, options, provider credentials, or the original output.
  function parseModelCatalog(text) {
    if (typeof text !== "string" || new TextEncoder().encode(text).length > MAX_MODEL_BYTES) {
      throw fail("OPENCODE_MODEL_LIMIT", "OpenCode 模型目录超过 16 MiB 上限");
    }
    const result = Object.create(null);
    let offset = 0, count = 0;
    while (offset < text.length) {
      while (/\s/u.test(text[offset] || "") && offset < text.length) offset++;
      if (offset === text.length) break;
      const end = text.indexOf("\n", offset);
      const id = text.slice(offset, end < 0 ? text.length : end).trim();
      if (end < 0 || !/^[^\s\0]{1,256}\/[^\s\0]{1,1024}$/u.test(id) || ++count > MAX_MODELS) {
        throw fail("OPENCODE_MODEL_FORMAT", "OpenCode 模型目录格式无效或模型数量超限");
      }
      offset = end + 1;
      while (/\s/u.test(text[offset] || "") && offset < text.length) offset++;
      const start = offset;
      if (text[offset] !== "{") throw fail("OPENCODE_MODEL_FORMAT", "OpenCode 未返回模型能力对象");
      let depth = 0, quoted = false, escaped = false;
      for (; offset < text.length; offset++) {
        const char = text[offset];
        if (quoted) {
          if (escaped) escaped = false;
          else if (char === "\\") escaped = true;
          else if (char === '"') quoted = false;
        }
        else if (char === '"') quoted = true;
        else if (char === "{") depth++;
        else if (char === "}" && --depth === 0) { offset++; break; }
      }
      let model;
      try { model = JSON.parse(text.slice(start, offset)); }
      catch (_error) { throw fail("OPENCODE_MODEL_FORMAT", "OpenCode 模型能力 JSON 不完整"); }
      if (`${model.providerID}/${model.id}` !== id || Object.hasOwn(result, id)) {
        throw fail("OPENCODE_MODEL_FORMAT", "OpenCode 模型标识不一致或重复");
      }
      result[id] = {
        image: model.capabilities?.input?.image === true,
        pdf: model.capabilities?.input?.pdf === true
      };
    }
    return result;
  }

  function launchOptions({ executablePath, cwd, password, dbPath, nodePath, inheritedPath = "" }, args) {
    if (!absolutePath(executablePath) || (cwd && !absolutePath(cwd)) || (dbPath && !absolutePath(dbPath))) {
      throw fail("ACP_PATH_INVALID", "OpenCode 必须使用已选择的本机绝对路径");
    }
    const parent = path => path.slice(0, path.lastIndexOf("/")) || "/";
    const directories = [
      ...(absolutePath(nodePath) ? [parent(nodePath)] : []), parent(executablePath),
      ...inheritedPath.split(":"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"
    ].filter(absolutePath);
    return {
      command: executablePath,
      arguments: args || ["acp", "--cwd", cwd, "--hostname", "127.0.0.1", "--port", "0", "--mdns=false"],
      ...(cwd ? { workdir: cwd } : {}),
      environmentAppend: true,
      environment: {
        PATH: [...new Set(directories)].join(":"),
        OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1",
        OPENCODE_DISABLE_TERMINAL_TITLE: "1", NO_COLOR: "1",
        npm_config_offline: "true", npm_config_audit: "false", npm_config_fund: "false",
        NO_BROWSER: "1",
        ...(password ? { OPENCODE_SERVER_PASSWORD: password, OPENCODE_SERVER_USERNAME: "spt" } : {}),
        ...(dbPath ? { OPENCODE_DB: dbPath } : {})
      },
      stderr: "pipe"
    };
  }

  function modelLaunchOptions(settings, marker) {
    const options = launchOptions(settings, ["models", "--verbose"]);
    return {
      ...options,
      command: "/bin/sh",
      arguments: ["-c", MODEL_COLLECT_SCRIPT, "spt-opencode-models", marker, options.command, ...options.arguments],
      environment: { ...options.environment, ENV: null, BASH_ENV: null }
    };
  }

  async function collect(process, maxBytes = 65536, timers = global, marker = "") {
    let timeout;
    const read = async (pipe, limit, endMarker = "", filter = null) => {
      let text = "", bytes = 0;
      const suffix = endMarker ? "\n" + endMarker + "\n" : "";
      while (true) {
        const raw = await pipe.readString();
        if (!raw) {
          filter?.finish();
          if (endMarker) throw fail("OPENCODE_OUTPUT_INCOMPLETE", "OpenCode 模型目录输出提前结束，请重新检测");
          return text;
        }
        bytes += new TextEncoder().encode(raw).length;
        if (bytes > limit + suffix.length) throw fail("OPENCODE_OUTPUT_LIMIT", "OpenCode 检测输出超过上限");
        text += filter ? filter.push(raw) : raw;
        if (suffix && text.endsWith(suffix)) {
          await process.stdin.close();
          return text.slice(0, -suffix.length);
        }
      }
    };
    try {
      const [status, stdout, stderr] = await Promise.race([
        Promise.all([process.wait(), read(process.stdout, maxBytes, marker, new TerminalTitleFilter()), read(process.stderr, 65536)]),
        new Promise((_, reject) => { timeout = timers.setTimeout(() => reject(fail("OPENCODE_TIMEOUT", "OpenCode 本地检测超时")), 30000); })
      ]);
      if (Number(status?.exitCode ?? status) !== 0) {
        const diagnostic = modules.ACP?.sanitizeDiagnostic(stderr) || "";
        throw fail("OPENCODE_PROCESS_FAILED", `OpenCode 检测失败（退出码 ${status?.exitCode ?? status}）。请先在终端完成登录和依赖准备后重试。${diagnostic ? "\n" + diagnostic : ""}`);
      }
      return stdout;
    }
    finally {
      timers.clearTimeout(timeout);
      try { await process.stdin?.close?.(); } catch (_error) {}
      try { await process.kill?.(1000); } catch (_error) {}
    }
  }

  function createRuntime({ readPaths, probe = false }) {
    let context = null;
    let cleaning = null;
    const processes = new Set();
    const uuid = () => global.Services.uuid.generateUUID().toString().replace(/[{}]/gu, "");
    const settings = () => ({
      executablePath: readPaths().opencodePath,
      nodePath: readPaths().nodePath,
      inheritedPath: global.Services.env.get("PATH") || ""
    });
    const call = async options => {
      if (cleaning) await cleaning;
      const { Subprocess } = global.ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");
      const process = await Subprocess.call(options);
      processes.add(process);
      return process;
    };
    const ensureContext = async cwd => {
      if (cleaning) await cleaning;
      if (context) return context;
      if (probe) {
        const root = global.PathUtils.join(global.Services.dirsvc.get("TmpD", global.Ci.nsIFile).path, "spt-opencode-probe-" + uuid());
        await global.IOUtils.makeDirectory(root, { permissions: 0o700 });
        context = { root, cwd: root, dbPath: global.PathUtils.join(root, "probe.sqlite"), password: uuid() + uuid() };
      }
      else {
        if (!absolutePath(cwd)) throw fail("ACP_PATH_INVALID", "OpenCode 需要当前论文的独立工作区");
        context = { cwd, password: uuid() + uuid() };
      }
      return context;
    };
    return {
      async readVersion() {
        const process = await call(launchOptions(settings(), ["--version"]));
        try { return parseVersion(await collect(process)); }
        finally { processes.delete(process); }
      },
      async spawn({ cwd }) {
        const current = await ensureContext(cwd);
        try { return await call(launchOptions({ ...settings(), ...current })); }
        catch (error) { await this.cleanup(); throw error; }
      },
      getWorkingDirectory() { return context?.cwd; },
      async readModelCatalog() {
        const current = await ensureContext();
        const marker = "SPT_MODELS_END_" + uuid();
        const process = await call(modelLaunchOptions({ ...settings(), ...current }, marker));
        try { return parseModelCatalog(await collect(process, MAX_MODEL_BYTES, global, marker)); }
        finally { processes.delete(process); }
      },
      async cleanup() {
        if (cleaning) return cleaning;
        const currentProcesses = [...processes];
        for (const process of currentProcesses) processes.delete(process);
        const current = context;
        context = null;
        cleaning = (async () => {
          await Promise.allSettled(currentProcesses.map(async process => {
            try { await process.stdin?.close?.(); } catch (_error) {}
            await process.kill?.(1000);
          }));
          if (current?.root) await global.IOUtils.remove(current.root, { recursive: true, ignoreAbsent: true });
        })();
        try { await cleaning; }
        finally { cleaning = null; }
      }
    };
  }

  modules.OpenCodeACP = { MIN_VERSION, REVISION, MAX_MODEL_BYTES, TerminalTitleFilter, parseVersion, isSupportedVersion, parseModelCatalog, launchOptions, modelLaunchOptions, collect, createRuntime };
  if (typeof module !== "undefined" && module.exports) module.exports = modules.OpenCodeACP;
})(typeof globalThis !== "undefined" ? globalThis : this);
