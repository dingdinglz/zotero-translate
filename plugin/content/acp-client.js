(function (global) {
  "use strict";

  const modules = global.SmartPaperTranslatorModules = global.SmartPaperTranslatorModules || {};
  const Constants = modules.Constants || (
    typeof require === "function" ? require("./constants.js") : null
  );

  class ACPError extends Error {
    constructor(code, message, details) {
      super(message);
      this.name = "ACPError";
      this.code = code;
      this.details = details;
    }
  }

  function isAbsolutePath(path) {
    return typeof path === "string" && path.startsWith("/") && !path.includes("\0");
  }

  function sanitizeDiagnostic(value, maxLength = Constants.ACP_MAX_STDERR_CHARS) {
    return String(value || "")
      .replace(/(https?:\/\/)[^/\s:@]+:[^@\s/]+@/giu, "$1[REDACTED]@")
      .replace(/Bearer\s+[^\s]+/giu, "Bearer [REDACTED]")
      .replace(/(authorization|api[-_ ]?key|token|secret)(\s*[:=]\s*)([^\s]+)/giu, "$1$2[REDACTED]")
      .replace(/\b(?:sk|sess)-[A-Za-z0-9_-]{12,}\b/gu, "[REDACTED]")
      .slice(-maxLength);
  }

  function formatDiagnosticDetails(details) {
    if (details === undefined || details === null || details === "") return "";
    if (typeof details !== "object") return sanitizeDiagnostic(details);
    const labels = {
      stage: "阶段",
      packageSpec: "目标包",
      exitCode: "退出码",
      expectedVersion: "需要版本",
      detectedVersion: "检测版本",
      hint: "建议",
      cause: "原因",
      stderr: "stderr",
      stdout: "stdout"
    };
    const lines = [];
    for (const [key, value] of Object.entries(details)) {
      if (value === undefined || value === null || value === "") continue;
      const label = labels[key] || key;
      if (/(?:token|secret|credential|api[-_ ]?key|authorization)/iu.test(key)) {
        lines.push(`${label}：[REDACTED]`);
        continue;
      }
      let rendered;
      if (typeof value === "object") {
        try {
          rendered = JSON.stringify(value, (nestedKey, nestedValue) =>
            /(?:token|secret|credential|api[-_ ]?key|authorization)/iu.test(nestedKey)
              ? "[REDACTED]"
              : nestedValue
          , 2);
        }
        catch (_error) {
          rendered = String(value);
        }
      }
      else rendered = String(value);
      lines.push(`${label}：${sanitizeDiagnostic(rendered)}`);
    }
    return lines.join("\n");
  }

  function formatACPError(error, fallback = "ACP 操作失败") {
    const message = sanitizeDiagnostic(error?.message || fallback, 2000) || fallback;
    const code = sanitizeDiagnostic(error?.code || "", 200);
    const details = formatDiagnosticDetails(error?.details);
    return [
      message,
      code ? `错误代码：${code}` : "",
      details
    ].filter(Boolean).join("\n");
  }

  function prepareFailureHint(diagnostic) {
    const value = String(diagnostic || "");
    if (/\bETARGET\b|No matching version found/iu.test(value)) {
      return `npm 仓库中找不到固定版本 ${Constants.ACP_PACKAGE_SPEC}；请升级插件或确认 npm registry 配置。`;
    }
    if (/\b(?:ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT)\b/iu.test(value)) {
      return "请检查网络、代理和 npm registry 是否可访问，然后重试。";
    }
    if (/\b(?:EACCES|EPERM)\b/iu.test(value)) {
      return "请检查 npm 缓存目录权限；插件不会请求管理员权限。";
    }
    return "请保留这里的错误代码和 stderr/stdout，用于继续定位。";
  }

  function isAuthenticatedStatus(status) {
    if (!status || typeof status !== "object") return false;
    if (status.authenticated === false) return false;
    const kind = String(status.type || status.status || "").toLowerCase();
    return kind !== "unauthenticated" && kind !== "logged-out" && kind !== "logged_out";
  }

  class JSONLineDecoder {
    constructor({ maxBytes = Constants.ACP_MAX_JSON_LINE_BYTES } = {}) {
      this.maxBytes = maxBytes;
      this.buffer = "";
    }

    push(chunk) {
      this.buffer += String(chunk || "");
      if (this.buffer.length > this.maxBytes && !this.buffer.includes("\n")) {
        throw new ACPError("ACP_FRAME_TOO_LARGE", "ACP 返回了过大的 JSONL 数据帧");
      }
      const messages = [];
      while (true) {
        const newline = this.buffer.indexOf("\n");
        if (newline === -1) break;
        let line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (!line.trim()) continue;
        if (line.length > this.maxBytes) {
          throw new ACPError("ACP_FRAME_TOO_LARGE", "ACP 返回了过大的 JSONL 数据帧");
        }
        try {
          messages.push(JSON.parse(line));
        }
        catch (error) {
          throw new ACPError("ACP_INVALID_JSON", "ACP 返回了无效的 JSONL 数据", {
            line: sanitizeDiagnostic(line, 1000),
            cause: error.message
          });
        }
      }
      return messages;
    }

    finish() {
      if (!this.buffer.trim()) {
        this.buffer = "";
        return [];
      }
      const tail = this.buffer;
      this.buffer = "";
      return this.push(tail + "\n");
    }
  }

  function withTimeout(promise, milliseconds, createError, timers = global) {
    if (!milliseconds || milliseconds < 1) return promise;
    return new Promise((resolve, reject) => {
      const timer = timers.setTimeout(() => reject(createError()), milliseconds);
      promise.then(
        (value) => {
          timers.clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          timers.clearTimeout(timer);
          reject(error);
        }
      );
    });
  }

  class ACPClient {
    constructor({
      processFactory,
      getPreparedVersion,
      setPreparedVersion,
      requestTimeoutMs,
      prepareTimeoutMs,
      timers,
      log
    } = {}) {
      this.processFactory = processFactory;
      this.getPreparedVersion = getPreparedVersion || (() => "");
      this.setPreparedVersion = setPreparedVersion || (() => {});
      this.requestTimeoutMs = requestTimeoutMs || Constants.ACP_REQUEST_TIMEOUT_MS;
      this.prepareTimeoutMs = prepareTimeoutMs || Constants.ACP_PREPARE_TIMEOUT_MS;
      this.timers = timers || global;
      this.log = log || (() => {});
      this.process = null;
      this.starting = null;
      this.decoder = null;
      this.nextRequestID = 1;
      this.pending = new Map();
      this.incoming = new Map();
      this.requestHandlers = new Map();
      this.listeners = new Set();
      this.readTasks = [];
      this.stderr = "";
      this.initialized = false;
      this.initializeResult = null;
      this.authStatus = null;
      this.closed = false;
      this.generation = 0;
    }

    subscribe(listener) {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    }

    onRequest(method, handler) {
      this.requestHandlers.set(method, handler);
      return () => {
        if (this.requestHandlers.get(method) === handler) this.requestHandlers.delete(method);
      };
    }

    _emit(event) {
      for (const listener of this.listeners) {
        try {
          listener(event);
        }
        catch (_error) {}
      }
    }

    async prepare() {
      if (this.closed) throw new ACPError("ACP_CLOSED", "ACP 客户端已关闭");
      await this.stop();
      let process;
      try {
        process = await this.processFactory({ purpose: "version", allowDownload: true });
      }
      catch (error) {
        throw new ACPError(
          "ACP_PREPARE_SPAWN_FAILED",
          "无法启动 codex-acp 准备进程",
          {
            stage: "启动 npm/npx",
            packageSpec: Constants.ACP_PACKAGE_SPEC,
            cause: sanitizeDiagnostic(error?.message || error)
          }
        );
      }
      let result;
      try {
        result = await withTimeout(
          this._collectProcess(process),
          this.prepareTimeoutMs,
          () => new ACPError(
            "ACP_PREPARE_TIMEOUT",
            "准备 codex-acp 超时",
            {
              stage: "npm 下载与版本检查",
              packageSpec: Constants.ACP_PACKAGE_SPEC,
              hint: "请检查网络、代理和 npm registry 后重试。"
            }
          ),
          this.timers
        );
      }
      catch (error) {
        try { await process.kill?.(1000); }
        catch (_killError) {}
        if (error instanceof ACPError) throw error;
        throw new ACPError(
          "ACP_PREPARE_PROCESS_FAILED",
          "codex-acp 准备进程执行异常",
          {
            stage: "npm 下载与版本检查",
            packageSpec: Constants.ACP_PACKAGE_SPEC,
            cause: sanitizeDiagnostic(error?.message || error)
          }
        );
      }
      if (result.exitCode !== 0) {
        const diagnostic = [result.stderr, result.stdout].filter(Boolean).join("\n");
        throw new ACPError(
          "ACP_PREPARE_FAILED",
          "codex-acp 准备失败",
          {
            stage: "npm 下载与版本检查",
            packageSpec: Constants.ACP_PACKAGE_SPEC,
            exitCode: result.exitCode,
            hint: prepareFailureHint(diagnostic),
            stderr: result.stderr,
            stdout: sanitizeDiagnostic(result.stdout)
          }
        );
      }
      const versionMatch = String(result.stdout).match(/(?:^|\s)(\d+\.\d+\.\d+)(?:\s|$)/u);
      if (!versionMatch || versionMatch[1] !== Constants.ACP_PACKAGE_VERSION) {
        throw new ACPError(
          "ACP_VERSION_MISMATCH",
          `codex-acp 版本不匹配：需要 ${Constants.ACP_PACKAGE_VERSION}`,
          {
            stage: "版本校验",
            packageSpec: Constants.ACP_PACKAGE_SPEC,
            expectedVersion: Constants.ACP_PACKAGE_VERSION,
            detectedVersion: versionMatch?.[1] || "未识别",
            stderr: result.stderr,
            stdout: sanitizeDiagnostic(result.stdout)
          }
        );
      }
      await this._start({ allowUnprepared: true });
      const authentication = await this.refreshAuthenticationStatus();
      if (!isAuthenticatedStatus(authentication)) {
        await this.stop();
        throw new ACPError("ACP_NOT_AUTHENTICATED", "本机 Codex 尚未登录");
      }
      this.setPreparedVersion(Constants.ACP_PACKAGE_VERSION);
      return this.getStatus();
    }

    async _collectProcess(process) {
      const stdoutTask = this._readAll(process.stdout);
      const stderrTask = this._readAll(process.stderr);
      const [waitResult, stdout, stderr] = await Promise.all([
        process.wait(), stdoutTask, stderrTask
      ]);
      return {
        exitCode: Number(waitResult?.exitCode ?? waitResult ?? 0),
        stdout,
        stderr: sanitizeDiagnostic(stderr)
      };
    }

    async _readAll(pipe) {
      if (!pipe?.readString) return "";
      let result = "";
      while (true) {
        const chunk = await pipe.readString();
        if (!chunk) break;
        result += chunk;
        if (result.length > Constants.ACP_MAX_STDERR_CHARS * 4) {
          result = result.slice(-Constants.ACP_MAX_STDERR_CHARS * 4);
        }
      }
      return result;
    }

    async start() {
      if (this.closed) throw new ACPError("ACP_CLOSED", "ACP 客户端已关闭");
      if (this.initialized && this.process) return this.initializeResult;
      if (this.starting) return this.starting;
      this.starting = this._start({ allowUnprepared: false });
      try {
        return await this.starting;
      }
      finally {
        this.starting = null;
      }
    }

    async _start({ allowUnprepared }) {
      if (this.process) await this.stop();
      if (!allowUnprepared && this.getPreparedVersion() !== Constants.ACP_PACKAGE_VERSION) {
        throw new ACPError(
          "ACP_NOT_PREPARED",
          `请先在设置中准备并检测 codex-acp ${Constants.ACP_PACKAGE_VERSION}`
        );
      }
      const generation = ++this.generation;
      this.decoder = new JSONLineDecoder();
      this.stderr = "";
      this.initialized = false;
      this.initializeResult = null;
      this.authStatus = null;
      this.process = await this.processFactory({ purpose: "serve", allowDownload: false });
      this.readTasks = [
        this._readStdout(this.process, generation),
        this._readStderr(this.process, generation),
        this._watchExit(this.process, generation)
      ];
      try {
        this.initializeResult = await this.request("initialize", {
          protocolVersion: Constants.ACP_PROTOCOL_VERSION,
          clientCapabilities: {
            elicitation: { form: {} },
            session: { configOptions: { boolean: {} } }
          },
          clientInfo: {
            name: "smart-paper-translator",
            title: Constants.PLUGIN_NAME,
            version: Constants.VERSION
          }
        });
        if (this.initializeResult?.protocolVersion !== Constants.ACP_PROTOCOL_VERSION) {
          throw new ACPError("ACP_PROTOCOL_MISMATCH", "codex-acp 不支持所需的 ACP 协议版本");
        }
        this.initialized = true;
        this._emit({ type: "ready", status: this.getStatus() });
        return this.initializeResult;
      }
      catch (error) {
        await this.stop();
        throw error;
      }
    }

    async _readStdout(process, generation) {
      try {
        while (this.process === process && generation === this.generation) {
          const chunk = await process.stdout.readString();
          if (!chunk) break;
          for (const message of this.decoder.push(chunk)) this._handleMessage(message);
        }
        if (this.process === process) {
          for (const message of this.decoder.finish()) this._handleMessage(message);
        }
      }
      catch (error) {
        if (this.process === process) this._failProcess(error);
      }
    }

    async _readStderr(process, generation) {
      if (!process.stderr?.readString) return;
      try {
        while (this.process === process && generation === this.generation) {
          const chunk = await process.stderr.readString();
          if (!chunk) break;
          this.stderr = sanitizeDiagnostic(this.stderr + chunk);
          this._emit({ type: "stderr", diagnostic: this.stderr });
        }
      }
      catch (error) {
        this.log("Unable to read codex-acp stderr", error);
      }
    }

    async _watchExit(process, generation) {
      try {
        const result = await process.wait();
        if (this.process !== process || generation !== this.generation) return;
        const exitCode = Number(result?.exitCode ?? result ?? 0);
        this._failProcess(new ACPError(
          "ACP_PROCESS_EXIT",
          `codex-acp 进程已退出（${exitCode}）`,
          this.stderr
        ));
      }
      catch (error) {
        if (this.process === process) this._failProcess(error);
      }
    }

    _handleMessage(message) {
      if (!message || message.jsonrpc !== "2.0") {
        throw new ACPError("ACP_INVALID_MESSAGE", "ACP 返回了无效的 JSON-RPC 消息");
      }
      if (Object.prototype.hasOwnProperty.call(message, "id") && !message.method) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) {
          pending.reject(new ACPError(
            "ACP_REMOTE_ERROR",
            message.error.message || "ACP 请求失败",
            { code: message.error.code, data: message.error.data }
          ));
        }
        else pending.resolve(message.result);
        return;
      }
      if (message.method && Object.prototype.hasOwnProperty.call(message, "id")) {
        this._handleIncomingRequest(message);
        return;
      }
      if (message.method) this._emit({ type: "notification", method: message.method, params: message.params });
    }

    async _handleIncomingRequest(message) {
      const entry = {
        id: message.id,
        method: message.method,
        params: message.params || {},
        settled: false
      };
      this.incoming.set(message.id, entry);
      const handler = this.requestHandlers.get(message.method);
      try {
        if (!handler) throw new ACPError("ACP_METHOD_UNSUPPORTED", `不支持 ACP 请求：${message.method}`);
        const result = await handler(entry.params, { id: message.id, method: message.method });
        if (!entry.settled) await this._respondIncoming(entry, { result });
      }
      catch (error) {
        if (!entry.settled) {
          await this._respondIncoming(entry, {
            error: { code: -32603, message: error.message || "ACP 客户端请求处理失败" }
          });
        }
      }
    }

    async _respondIncoming(entry, payload) {
      if (entry.settled) return;
      entry.settled = true;
      this.incoming.delete(entry.id);
      await this._write({ jsonrpc: "2.0", id: entry.id, ...payload });
    }

    async request(method, params = {}, { timeoutMs = this.requestTimeoutMs } = {}) {
      if (!this.process) throw new ACPError("ACP_NOT_RUNNING", "codex-acp 尚未启动");
      const id = this.nextRequestID++;
      let resolvePending;
      let rejectPending;
      const result = new Promise((resolve, reject) => {
        resolvePending = resolve;
        rejectPending = reject;
      });
      this.pending.set(id, { resolve: resolvePending, reject: rejectPending, method });
      try {
        await this._write({ jsonrpc: "2.0", id, method, params });
      }
      catch (error) {
        this.pending.delete(id);
        throw error;
      }
      return withTimeout(
        result,
        timeoutMs,
        () => {
          this.pending.delete(id);
          return new ACPError("ACP_REQUEST_TIMEOUT", `ACP 请求超时：${method}`);
        },
        this.timers
      );
    }

    notify(method, params = {}) {
      if (!this.process) throw new ACPError("ACP_NOT_RUNNING", "codex-acp 尚未启动");
      return this._write({ jsonrpc: "2.0", method, params });
    }

    async _write(message) {
      try {
        await this.process.stdin.write(JSON.stringify(message) + "\n");
      }
      catch (error) {
        throw new ACPError("ACP_WRITE_FAILED", "无法写入 codex-acp 进程", error.message);
      }
    }

    async refreshAuthenticationStatus() {
      await this.start();
      this.authStatus = await this.request("authentication/status", {});
      return this.authStatus;
    }

    async cancelSession(sessionId) {
      if (!this.process) return;
      await this.notify("session/cancel", { sessionId });
      for (const entry of Array.from(this.incoming.values())) {
        if (entry.params?.sessionId !== sessionId) continue;
        const result = entry.method === "session/request_permission"
          ? { outcome: { outcome: "cancelled" } }
          : { action: "cancel" };
        await this._respondIncoming(entry, { result });
      }
    }

    getStatus() {
      return {
        healthy: Boolean(this.process && this.initialized),
        preparedVersion: this.getPreparedVersion() || "",
        requiredVersion: Constants.ACP_PACKAGE_VERSION,
        agent: this.initializeResult?.agentInfo || null,
        capabilities: this.initializeResult?.agentCapabilities || null,
        authentication: this.authStatus || null,
        mode: Constants.ACP_MODE,
        lastError: this.stderr || ""
      };
    }

    _failProcess(error) {
      if (!this.process) return;
      const current = this.process;
      this.process = null;
      this.initialized = false;
      this.initializeResult = null;
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      for (const entry of this.incoming.values()) entry.settled = true;
      this.incoming.clear();
      this._emit({ type: "exit", error, diagnostic: this.stderr });
      try { current.stdin?.close?.(); }
      catch (_error) {}
    }

    async stop() {
      const process = this.process;
      this.process = null;
      this.initialized = false;
      this.initializeResult = null;
      this.authStatus = null;
      ++this.generation;
      const error = new ACPError("ACP_STOPPED", "codex-acp 已停止");
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      for (const entry of this.incoming.values()) entry.settled = true;
      this.incoming.clear();
      if (!process) return;
      this._emit({ type: "stopped" });
      try { await process.stdin?.close?.(); }
      catch (_error) {}
      try { await process.kill?.(1000); }
      catch (_error) {}
    }

    async shutdown() {
      this.closed = true;
      this.listeners.clear();
      this.requestHandlers.clear();
      await this.stop();
    }
  }

  function getHomePath() {
    return global.Services.dirsvc.get("Home", global.Ci.nsIFile).path;
  }

  async function listNVMVersions(homePath) {
    const root = global.PathUtils.join(homePath, ".nvm", "versions", "node");
    try {
      const children = await global.IOUtils.getChildren(root);
      return children.sort().reverse();
    }
    catch (_error) {
      return [];
    }
  }

  async function firstExisting(candidates) {
    for (const candidate of candidates) {
      if (isAbsolutePath(candidate) && await global.IOUtils.exists(candidate)) return candidate;
    }
    return "";
  }

  async function detectLocalPaths(configured = {}) {
    const home = getHomePath();
    const nvmVersions = await listNVMVersions(home);
    const nodeCandidates = [
      configured.nodePath,
      "/usr/local/bin/node",
      "/opt/homebrew/bin/node",
      ...nvmVersions.map((root) => global.PathUtils.join(root, "bin", "node")),
      "/usr/bin/node"
    ];
    const nodePath = await firstExisting(nodeCandidates);
    const nodeRoot = nodePath ? global.PathUtils.parent(global.PathUtils.parent(nodePath)) : "";
    const npxCandidates = [
      configured.npxCliPath,
      nodeRoot && global.PathUtils.join(nodeRoot, "lib", "node_modules", "npm", "bin", "npx-cli.js"),
      "/usr/local/lib/node_modules/npm/bin/npx-cli.js",
      "/opt/homebrew/lib/node_modules/npm/bin/npx-cli.js",
      ...nvmVersions.map((root) => global.PathUtils.join(root, "lib", "node_modules", "npm", "bin", "npx-cli.js"))
    ];
    const codexCandidates = [
      configured.codexPath,
      "/usr/local/bin/codex",
      "/opt/homebrew/bin/codex",
      ...nvmVersions.map((root) => global.PathUtils.join(root, "bin", "codex"))
    ];
    return {
      nodePath,
      npxCliPath: await firstExisting(npxCandidates),
      codexPath: await firstExisting(codexCandidates)
    };
  }

  function validateRuntimePaths(paths) {
    for (const [name, path] of Object.entries(paths)) {
      if (!isAbsolutePath(path)) {
        throw new ACPError("ACP_PATH_INVALID", `${name} 必须是已选择的绝对路径`);
      }
    }
  }

  function createEnvironment(paths, { allowDownload }) {
    const directories = [
      global.PathUtils.parent(paths.codexPath),
      global.PathUtils.parent(paths.nodePath),
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin"
    ];
    return {
      CODEX_PATH: paths.codexPath,
      INITIAL_AGENT_MODE: Constants.ACP_MODE,
      NO_BROWSER: "1",
      PATH: [...new Set(directories)].join(":"),
      npm_config_loglevel: "error",
      ...(allowDownload ? {} : { npm_config_offline: "true" })
    };
  }

  async function createSubprocess(paths, { purpose, allowDownload }) {
    validateRuntimePaths(paths);
    const { Subprocess } = global.ChromeUtils.importESModule(
      "resource://gre/modules/Subprocess.sys.mjs"
    );
    const argumentsList = [
      paths.npxCliPath,
      "--yes",
      "--package",
      Constants.ACP_PACKAGE_SPEC,
      "codex-acp"
    ];
    if (purpose === "version") argumentsList.push("--version");
    return Subprocess.call({
      command: paths.nodePath,
      arguments: argumentsList,
      environmentAppend: true,
      environment: createEnvironment(paths, { allowDownload }),
      stderr: "pipe"
    });
  }

  async function collectSubprocess(process, maxChars = Constants.ACP_MAX_STDERR_CHARS) {
    const read = async (pipe) => {
      if (!pipe?.readString) return "";
      let value = "";
      while (true) {
        const chunk = await pipe.readString();
        if (!chunk) break;
        value = (value + chunk).slice(-maxChars);
      }
      return value.trim();
    };
    const [result, stdout, stderr] = await Promise.all([
      process.wait(),
      read(process.stdout),
      read(process.stderr)
    ]);
    return {
      exitCode: Number(result?.exitCode ?? result ?? 0),
      stdout: sanitizeDiagnostic(stdout, maxChars),
      stderr: sanitizeDiagnostic(stderr, maxChars)
    };
  }

  async function runLocalCommand(command, argumentsList, paths) {
    const { Subprocess } = global.ChromeUtils.importESModule(
      "resource://gre/modules/Subprocess.sys.mjs"
    );
    const process = await Subprocess.call({
      command,
      arguments: argumentsList,
      environmentAppend: true,
      environment: createEnvironment(paths, { allowDownload: false }),
      stderr: "pipe"
    });
    return collectSubprocess(process);
  }

  async function inspectLocalRuntime(paths) {
    validateRuntimePaths(paths);
    for (const path of Object.values(paths)) {
      if (!(await global.IOUtils.exists(path))) {
        throw new ACPError("ACP_PATH_MISSING", `文件不存在：${path}`);
      }
    }
    const [node, npx, codex, login] = await Promise.all([
      runLocalCommand(paths.nodePath, ["--version"], paths),
      runLocalCommand(paths.nodePath, [paths.npxCliPath, "--version"], paths),
      runLocalCommand(paths.codexPath, ["--version"], paths),
      runLocalCommand(paths.codexPath, ["login", "status"], paths)
    ]);
    const describe = (result) => result.exitCode === 0
      ? result.stdout || result.stderr
      : `检测失败（${result.exitCode}）：${result.stderr || result.stdout}`;
    return {
      paths: { ...paths },
      versions: {
        node: describe(node),
        npx: describe(npx),
        codex: describe(codex),
        codexACP: ""
      },
      login: describe(login),
      healthy: node.exitCode === 0 && npx.exitCode === 0 && codex.exitCode === 0,
      lastError: [node, npx, codex].filter((result) => result.exitCode !== 0)
        .map((result) => result.stderr || result.stdout).join("\n")
    };
  }

  function createZoteroACPClient({ getPreference, setPreference, log } = {}) {
    const readPaths = () => ({
      nodePath: String(getPreference(Constants.PREFS.codexNodePath) || "").trim(),
      npxCliPath: String(getPreference(Constants.PREFS.codexNpxCliPath) || "").trim(),
      codexPath: String(getPreference(Constants.PREFS.codexExecutablePath) || "").trim()
    });
    const fingerprint = () => JSON.stringify(readPaths());
    return new ACPClient({
      processFactory: (options) => createSubprocess(readPaths(), options),
      getPreparedVersion: () => {
        const savedFingerprint = String(
          getPreference(Constants.PREFS.codexPreparedFingerprint) || ""
        );
        return savedFingerprint === fingerprint()
          ? String(getPreference(Constants.PREFS.codexPreparedVersion) || "")
          : "";
      },
      setPreparedVersion: (version) => {
        setPreference(Constants.PREFS.codexPreparedVersion, version);
        setPreference(Constants.PREFS.codexPreparedFingerprint, fingerprint());
      },
      log
    });
  }

  modules.ACP = {
    ACPClient,
    ACPError,
    JSONLineDecoder,
    sanitizeDiagnostic,
    formatACPError,
    isAuthenticatedStatus,
    isAbsolutePath,
    detectLocalPaths,
    validateRuntimePaths,
    inspectLocalRuntime,
    createEnvironment,
    createZoteroACPClient
  };
  if (typeof module !== "undefined" && module.exports) module.exports = modules.ACP;
})(typeof globalThis !== "undefined" ? globalThis : this);
