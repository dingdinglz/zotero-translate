(function (global) {
  "use strict";

  const modules = global.SmartPaperTranslatorModules = global.SmartPaperTranslatorModules || {};
  const Constants = modules.Constants || (
    typeof require === "function" ? require("./constants.js") : null
  );

  const Agents = modules.AgentProviders || (typeof require === "function" ? require("./agent-providers.js") : null);
  const PiCompat = modules.PiACPCompat || (typeof require === "function" ? require("./pi-acp-compat.js") : null);
  const OpenCode = modules.OpenCodeACP || (typeof require === "function" ? require("./opencode-acp.js") : null);

  class ACPError extends Error {
    constructor(code, message, details) {
      super(message);
      this.name = "ACPError";
      this.code = code;
      this.details = details;
    }
  }

  function isWindowsAbsolutePath(path) {
    if (typeof path !== "string") return false;
    return /^[A-Za-z]:[\\/]/u.test(path)
      || /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/u.test(path);
  }

  function isAbsolutePath(path) {
    return typeof path === "string"
      && !path.includes("\0")
      && (path.startsWith("/") || isWindowsAbsolutePath(path));
  }

  function usesWindowsPaths(paths = {}) {
    try {
      if (typeof global.Zotero?.isWin === "boolean") return global.Zotero.isWin;
      if (global.Services?.appinfo?.OS) return global.Services.appinfo.OS === "WINNT";
    }
    catch (_error) {}
    return Object.values(paths).some(isWindowsAbsolutePath);
  }

  // Gecko 140 PathUtils/IOUtils require native backslashes on Windows. Path
  // comparison alone must never turn an accepted C:/... into an unusable file.
  function toNativeAbsolutePath(path, windows = usesWindowsPaths({ path })) {
    if (!isAbsolutePath(path)) return "";
    if (windows) return isWindowsAbsolutePath(path) ? path.replace(/\//gu, "\\") : "";
    return path.startsWith("/") ? path : "";
  }

  function normalizeRuntimePaths(paths) {
    const windows = usesWindowsPaths(paths);
    return Object.fromEntries(Object.entries(paths).map(([key, path]) =>
      [key, toNativeAbsolutePath(path, windows)]
    ));
  }

  function pathName(path) {
    return String(path || "").split(/[\\/]/u).at(-1) || "";
  }

  function sanitizeDiagnostic(value, maxLength = Constants.ACP_MAX_STDERR_CHARS) {
    return String(value || "")
      .replace(/(https?:\/\/)[^/\s:@]+:[^@\s/]+@/giu, "$1[REDACTED]@")
      .replace(/Bearer\s+[^\s]+/giu, "Bearer [REDACTED]")
      .replace(/(authorization|api[-_ ]?key|token|secret|password)(["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}]+)/giu, "$1$2[REDACTED]")
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
      if (/(?:token|secret|credential|password|api[-_ ]?key|authorization)/iu.test(key)) {
        lines.push(`${label}：[REDACTED]`);
        continue;
      }
      let rendered;
      if (typeof value === "object") {
        try {
          rendered = JSON.stringify(value, (nestedKey, nestedValue) =>
            /(?:token|secret|credential|password|api[-_ ]?key|authorization)/iu.test(nestedKey)
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
      agentId = "codex",
      nativeRuntime = null,
      getPreparedVersion,
      setPreparedVersion,
      requestTimeoutMs,
      prepareTimeoutMs,
      timers,
      log
    } = {}) {
      this.provider = Agents.getProvider(agentId);
      this.processFactory = processFactory;
      this.nativeRuntime = nativeRuntime;
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
      this.cleanupTasks = new Set();
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
      if (this.provider.runtime === "native") {
        await this._start({ allowUnprepared: true });
        this.setPreparedVersion(this.nativeVersion);
        return this.getStatus();
      }
      if (this.provider.id === "pi") {
        // pi-acp has no --version CLI. Preparation only initializes ACP; it never prompts Pi.
        try {
          await this._start({ allowUnprepared: true, allowDownload: true });
          this.setPreparedVersion(this.provider.version);
          return this.getStatus();
        }
        finally { await this.stop(); }
      }
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
            packageSpec: this.provider.packageSpec,
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
              packageSpec: this.provider.packageSpec,
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
            packageSpec: this.provider.packageSpec,
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
            packageSpec: this.provider.packageSpec,
            exitCode: result.exitCode,
            hint: prepareFailureHint(diagnostic),
            stderr: result.stderr,
            stdout: sanitizeDiagnostic(result.stdout)
          }
        );
      }
      const versionMatch = String(result.stdout).match(/(?:^|\s)(\d+\.\d+\.\d+)(?:\s|$)/u);
      if (!versionMatch || versionMatch[1] !== this.provider.version) {
        throw new ACPError(
          "ACP_VERSION_MISMATCH",
          `codex-acp 版本不匹配：需要 ${this.provider.version}`,
          {
            stage: "版本校验",
            packageSpec: this.provider.packageSpec,
            expectedVersion: this.provider.version,
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
      this.setPreparedVersion(this.provider.version);
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

    async start({ cwd } = {}) {
      if (this.closed) throw new ACPError("ACP_CLOSED", "ACP 客户端已关闭");
      if (this.initialized && this.process) {
        if (this.provider.runtime === "native" && this.getPreparedVersion() !== this.nativeVersion) await this.stop();
        else return this.initializeResult;
      }
      if (this.starting) return this.starting;
      this.starting = this._start({ allowUnprepared: false, cwd });
      try {
        return await this.starting;
      }
      finally {
        this.starting = null;
      }
    }

    async _start({ allowUnprepared, allowDownload = false, cwd }) {
      if (this.process) await this.stop();
      if (this.cleanupTasks.size) await Promise.allSettled(this.cleanupTasks);
      if (this.provider.runtime === "native") {
        const generation = this.generation;
        try { this.nativeVersion = await this.nativeRuntime.readVersion(); }
        catch (error) { this.setPreparedVersion(""); throw error; }
        if (this.closed || generation !== this.generation) throw new ACPError("ACP_STOPPED", "OpenCode startup was cancelled");
      }
      if (!allowUnprepared && this.getPreparedVersion() !== (this.nativeVersion || this.provider.version)) {
        if (this.provider.runtime === "native") this.setPreparedVersion("");
        throw new ACPError(
          "ACP_NOT_PREPARED",
          this.provider.runtime === "native" ? "OpenCode 路径或版本已变化，请先在设置中检测 OpenCode" : `请先在设置中准备并检测 ${this.provider.command} ${this.provider.version}`
        );
      }
      const generation = ++this.generation;
      this.decoder = new JSONLineDecoder();
      this.stderr = "";
      this.initialized = false;
      this.initializeResult = null;
      this.authStatus = null;
      const process = await this.processFactory({ purpose: "serve", allowDownload, ...(cwd ? { cwd } : {}) });
      if (this.closed || generation !== this.generation) {
        await this._terminateProcess(process);
        throw new ACPError("ACP_STOPPED", "ACP startup was cancelled");
      }
      this.process = process;
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
        }, { timeoutMs: allowDownload ? this.prepareTimeoutMs : this.requestTimeoutMs });
        if (this.initializeResult?.protocolVersion !== Constants.ACP_PROTOCOL_VERSION) {
          throw new ACPError("ACP_PROTOCOL_MISMATCH", `${this.provider.command} 不支持所需的 ACP 协议版本`);
        }
        if (this.provider.id === "pi" && this.initializeResult?.agentInfo?.version !== this.provider.version) {
          throw new ACPError("ACP_VERSION_MISMATCH", `pi-acp requires ${this.provider.version}`);
        }
        if (this.provider.runtime === "native" && (
          this.initializeResult?.agentInfo?.name?.toLowerCase() !== "opencode" ||
          this.initializeResult?.agentInfo?.version !== this.nativeVersion ||
          this.initializeResult?.agentCapabilities?.loadSession !== true ||
          !this.initializeResult?.agentCapabilities?.sessionCapabilities?.close
        )) throw new ACPError("ACP_CAPABILITY_MISMATCH", "OpenCode 未返回所需版本、会话恢复或关闭能力");
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
      const decoder = this.decoder;
      const titleFilter = this.provider.runtime === "native" ? new OpenCode.TerminalTitleFilter() : null;
      try {
        while (this.process === process && generation === this.generation) {
          const chunk = await process.stdout.readString();
          if (this.process !== process || generation !== this.generation) return;
          if (!chunk) break;
          for (const message of decoder.push(titleFilter ? titleFilter.push(chunk) : chunk)) this._handleMessage(message);
        }
        if (this.process === process && generation === this.generation) {
          titleFilter?.finish();
          for (const message of decoder.finish()) this._handleMessage(message);
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
          if (generation !== this.generation) return;
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
          `${this.provider.command} 进程已退出（${exitCode}）` + (this.provider.runtime === "native"
            ? `。请先在终端运行 opencode 完成登录和依赖准备，再回设置检测 OpenCode。${this.stderr ? "\n" + this.stderr : ""}` : ""),
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
      if (!this.process) throw new ACPError("ACP_NOT_RUNNING", `${this.provider.command} 尚未启动`);
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
      if (!this.process) throw new ACPError("ACP_NOT_RUNNING", `${this.provider.command} 尚未启动`);
      return this._write({ jsonrpc: "2.0", method, params });
    }

    async _write(message) {
      try {
        await this.process.stdin.write(JSON.stringify(message) + "\n");
      }
      catch (error) {
        throw new ACPError("ACP_WRITE_FAILED", `无法写入 ${this.provider.command} 进程`, error.message);
      }
    }

    async refreshAuthenticationStatus() {
      await this.start();
      if (this.provider.id !== "codex") {
        // Pi authenticates out of band; session/new reports auth_required when no model is usable.
        return { status: `configured-in-${this.provider.id}` };
      }
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
        requiredVersion: this.provider.minimumVersion || this.provider.version,
        agent: this.initializeResult?.agentInfo || null,
        capabilities: this.initializeResult?.agentCapabilities || null,
        authentication: this.authStatus || null,
        agentId: this.provider.id,
        mode: this.provider.defaultMode,
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
      const cleanup = this._terminateProcess(current);
      this.cleanupTasks.add(cleanup);
      void cleanup.catch(error => this.log("Unable to clean up ACP process", error))
        .finally(() => this.cleanupTasks.delete(cleanup));
    }

    async stop() {
      const process = this.process;
      this.process = null;
      this.initialized = false;
      this.initializeResult = null;
      this.authStatus = null;
      ++this.generation;
      const error = new ACPError("ACP_STOPPED", `${this.provider.command} 已停止`);
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      for (const entry of this.incoming.values()) entry.settled = true;
      this.incoming.clear();
      if (process) {
        this._emit({ type: "stopped" });
        await this._terminateProcess(process);
      }
      await Promise.allSettled(this.cleanupTasks);
      await this.nativeRuntime?.cleanup();
    }

    async _terminateProcess(process) {
      try { await process.stdin?.close?.(); }
      catch (_error) {}
      if (this.provider.id === "pi") {
        try {
          await withTimeout(process.wait(), 1500, () => new Error("ACP shutdown timeout"), this.timers);
          return;
        }
        catch (_error) {}
      }
      try { await process.kill?.(1000); }
      catch (_error) {}
      if (this.provider.runtime === "native" && !this.process) await this.nativeRuntime?.cleanup();
    }

    async shutdown() {
      this.closed = true;
      this.listeners.clear();
      this.requestHandlers.clear();
      await this.stop();
      if (this.starting) await Promise.allSettled([this.starting]);
    }
  }

  function getHomePath() {
    return global.Services.dirsvc.get("Home", global.Ci.nsIFile).path;
  }

  function environmentValue(name) {
    try { return String(global.Services.env.get(name) || ""); }
    catch (_error) { return ""; }
  }

  async function listNVMVersions(homePath, windows = usesWindowsPaths()) {
    const xdg = toNativeAbsolutePath(environmentValue("XDG_CONFIG_HOME"), windows);
    const roots = [...new Set([
      toNativeAbsolutePath(environmentValue("NVM_DIR"), windows), global.PathUtils.join(homePath, ".nvm"),
      xdg && global.PathUtils.join(xdg, "nvm"),
      windows && toNativeAbsolutePath(environmentValue("NVM_HOME"), windows)
    ].filter(Boolean))];
    const children = [];
    for (const root of roots) {
      const versionRoots = windows
        ? [root, global.PathUtils.join(root, "versions", "node")]
        : [global.PathUtils.join(root, "versions", "node")];
      for (const versionRoot of versionRoots) {
        try { children.push(...await global.IOUtils.getChildren(versionRoot)); }
        catch (_error) { /* An absent NVM install does not block PATH discovery. */ }
      }
    }
    return [...new Set(children)].filter(path => /^v\d+\.\d+\.\d+$/u.test(pathName(path)))
      .sort((a, b) => pathName(b).localeCompare(pathName(a), "en", { numeric: true }))
      .slice(0, 128);
  }

  async function isRuntimeFile(path) {
    if (!isAbsolutePath(path) || path.length > 4096) return false;
    try { return (await global.IOUtils.stat(path, { followSymlinks: true })).type === "regular"; }
    catch (_error) { return false; }
  }

  function npxLinkTarget(path) {
    try {
      const file = global.Cc["@mozilla.org/file/local;1"].createInstance(global.Ci.nsIFile);
      file.initWithPath(path);
      if (file.isSymlink() && /[\\/]npx-cli\.js$/iu.test(file.target)) return file.target;
    }
    catch (_error) { /* Only resolve existing npm links; never execute shell shims. */ }
    return "";
  }

  // Enumeration reads file metadata only: no shell startup files, executables, or downloads.
  async function listRuntimePathCandidates(configured = {}) {
    const windows = usesWindowsPaths(configured);
    configured = normalizeRuntimePaths(configured);
    const candidates = { node: [], npx: [], codex: [], pi: [], opencode: [] };
    const seen = Object.fromEntries(Object.keys(candidates).map(kind => [kind, new Set()]));
    const add = async (kind, path, source, version = "") => {
      path = toNativeAbsolutePath(path, windows);
      if (!path || seen[kind].has(path)) return;
      seen[kind].add(path);
      if (await isRuntimeFile(path)) candidates[kind].push({ path, source, version });
    };
    for (const [kind, key] of [["node", "nodePath"], ["npx", "npxCliPath"], ["codex", "codexPath"], ["pi", "piPath"], ["opencode", "opencodePath"]]) {
      await add(kind, configured[key], "configured");
    }
    const directories = [];
    directories.push({ path: global.PathUtils.join(getHomePath(), ".opencode", "bin"), source: "opencode" });
    directories.push({ path: global.PathUtils.join(getHomePath(), ".local", "bin"), source: "local" });
    if (isAbsolutePath(configured.nodePath)) directories.push({ path: global.PathUtils.parent(configured.nodePath), source: "node" });
    for (const root of await listNVMVersions(getHomePath(), windows)) {
      directories.push({ path: windows ? root : global.PathUtils.join(root, "bin"), source: "nvm", version: pathName(root) });
    }
    const pathSeparator = windows ? ";" : ":";
    const pathDirectories = environmentValue("PATH").split(pathSeparator)
      .map(path => toNativeAbsolutePath(path, windows))
      .filter(path => path && path.length <= 4096);
    for (const path of [...new Set(pathDirectories)].slice(0, 128)) directories.push({ path, source: "path" });
    const programFiles = toNativeAbsolutePath(environmentValue("ProgramFiles"), windows);
    const appData = toNativeAbsolutePath(environmentValue("APPDATA"), windows);
    const standardDirectories = windows ? [
      toNativeAbsolutePath(environmentValue("NVM_SYMLINK"), windows),
      programFiles && global.PathUtils.join(programFiles, "nodejs"),
      appData && global.PathUtils.join(appData, "npm")
    ] : ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
    for (const path of standardDirectories.filter(isAbsolutePath)) directories.push({ path, source: "standard" });
    const searched = new Set();
    for (const { path: directory, source, version } of directories) {
      if (searched.has(directory)) continue;
      searched.add(directory);
      await Promise.all(["node", "codex", "pi", "opencode"].flatMap(kind =>
        (windows ? [`${kind}.exe`, kind] : [kind])
          .map(name => add(kind, global.PathUtils.join(directory, name), source, version))
      ));
      const prefix = global.PathUtils.parent(directory);
      if (prefix) await add("npx", global.PathUtils.join(prefix, "lib", "node_modules", "npm", "bin", "npx-cli.js"), source, version);
      await add("npx", global.PathUtils.join(directory, "node_modules", "npm", "bin", "npx-cli.js"), source, version);
      await add("npx", global.PathUtils.join(directory, "npx-cli.js"), source, version);
      await add("npx", npxLinkTarget(global.PathUtils.join(directory, "npx")), source, version);
    }
    return candidates;
  }

  async function detectSharedPaths(configured = {}) {
    const candidates = await listRuntimePathCandidates(configured);
    return { nodePath: candidates.node[0]?.path || "", npxCliPath: candidates.npx[0]?.path || "" };
  }

  async function detectLocalPaths(configured = {}, agentId = "codex") {
    const provider = Agents.getProvider(agentId);
    const candidates = await listRuntimePathCandidates(configured);
    return {
      nodePath: candidates.node[0]?.path || "", npxCliPath: candidates.npx[0]?.path || "",
      [`${provider.id}Path`]: candidates[provider.id][0]?.path || ""
    };
  }

  function validateRuntimePaths(paths) {
    const windows = usesWindowsPaths(paths);
    for (const [name, path] of Object.entries(paths)) {
      if (!toNativeAbsolutePath(path, windows)) {
        throw new ACPError("ACP_PATH_INVALID", `${name} 必须是绝对文件路径`);
      }
    }
  }

  function createEnvironment(paths, { allowDownload }, agentId = "codex") {
    const provider = Agents.getProvider(agentId);
    const windows = usesWindowsPaths(paths);
    paths = normalizeRuntimePaths(paths);
    const pathSeparator = windows ? ";" : ":";
    const inheritedDirectories = environmentValue("PATH").split(pathSeparator)
      .map(path => toNativeAbsolutePath(path, windows))
      .filter(path => path && path.length <= 4096)
      .slice(0, 128);
    const directories = [
      global.PathUtils.parent(paths.nodePath),
      ...(paths[`${provider.id}Path`] ? [global.PathUtils.parent(paths[`${provider.id}Path`])] : []),
      ...inheritedDirectories,
      ...(windows ? [] : ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"])
    ];
    return {
      ...(paths[`${provider.id}Path`] ? (agentId === "codex" ? {
        CODEX_PATH: paths.codexPath,
        INITIAL_AGENT_MODE: Constants.ACP_MODE
      } : {
        PI_ACP_PI_COMMAND: paths.piPath,
        PI_OFFLINE: "1",
        PI_TELEMETRY: "0",
        PI_SKIP_VERSION_CHECK: "1"
      }) : {}),
      NO_BROWSER: "1",
      PATH: [...new Set(directories)].join(pathSeparator),
      npm_config_loglevel: "error",
      ...(allowDownload ? {} : { npm_config_offline: "true" })
    };
  }

  async function createSubprocess(paths, { purpose, allowDownload }, agentId = "codex") {
    const provider = Agents.getProvider(agentId);
    paths = normalizeRuntimePaths(paths);
    validateRuntimePaths(paths);
    const { Subprocess } = global.ChromeUtils.importESModule(
      "resource://gre/modules/Subprocess.sys.mjs"
    );
    const argumentsList = [
      paths.npxCliPath,
      "--yes",
      "--package",
      provider.packageSpec,
      ...(agentId === "pi" ? ["--", paths.nodePath, "--input-type=commonjs", "--eval", PiCompat.createLauncherSource()] : [provider.command])
    ];
    if (purpose === "version") argumentsList.push("--version");
    return Subprocess.call({
      command: paths.nodePath,
      arguments: argumentsList,
      environmentAppend: true,
      environment: createEnvironment(paths, { allowDownload }, agentId),
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

  async function runLocalCommand(command, argumentsList, paths, agentId = "codex") {
    const { Subprocess } = global.ChromeUtils.importESModule(
      "resource://gre/modules/Subprocess.sys.mjs"
    );
    const process = await Subprocess.call({
      command,
      arguments: argumentsList,
      environmentAppend: true,
      environment: createEnvironment(paths, { allowDownload: false }, agentId),
      stderr: "pipe"
    });
    return collectSubprocess(process);
  }

  async function validateExistingPaths(paths) {
    validateRuntimePaths(paths);
    for (const path of Object.values(paths)) {
      if (!(await global.IOUtils.exists(path))) {
        throw new ACPError("ACP_PATH_MISSING", `文件不存在：${path}`);
      }
    }
  }

  function describeRuntime(result) {
    return result.exitCode === 0 ? result.stdout || result.stderr
      : `检测失败（${result.exitCode}）：${result.stderr || result.stdout}`;
  }

  async function inspectSharedRuntime(paths) {
    const shared = normalizeRuntimePaths({ nodePath: paths.nodePath, npxCliPath: paths.npxCliPath });
    await validateExistingPaths(shared);
    const [node, npx] = await Promise.all([
      runLocalCommand(shared.nodePath, ["--version"], shared),
      runLocalCommand(shared.nodePath, [shared.npxCliPath, "--version"], shared)
    ]);
    return {
      paths: shared,
      versions: { node: describeRuntime(node), npx: describeRuntime(npx) },
      healthy: node.exitCode === 0 && npx.exitCode === 0,
      lastError: [node, npx].filter((result) => result.exitCode !== 0)
        .map(describeRuntime).join("\n")
    };
  }

  async function inspectLocalRuntime(paths, agentId = "codex") {
    const provider = Agents.getProvider(agentId);
    paths = normalizeRuntimePaths(paths);
    await validateExistingPaths(paths);
    const [node, npx, codex, login] = await Promise.all([
      runLocalCommand(paths.nodePath, ["--version"], paths, agentId),
      runLocalCommand(paths.nodePath, [paths.npxCliPath, "--version"], paths, agentId),
      runLocalCommand(paths[`${provider.id}Path`], ["--version"], paths, agentId),
      agentId === "codex" ? runLocalCommand(paths.codexPath, ["login", "status"], paths) : Promise.resolve({ exitCode: 0, stdout: "Pi: configure providers using the local pi CLI" })
    ]);
    const version = (result) => `${result.stdout}\n${result.stderr}`
      .match(/^(?:v|pi\s+)?(\d+\.\d+\.\d+)(?:[-+][\w.-]+)?\s*$/imu)?.[1];
    const atLeast = (value, required) => {
      const match = value.match(/(\d+)\.(\d+)\.(\d+)/u);
      const actual = match.slice(1).map(Number);
      for (let index = 0; index < 3; index++) {
        if (actual[index] !== required[index]) return actual[index] > required[index];
      }
      return true;
    };
    if (agentId === "pi") {
      const details = {
        stage: "runtime",
        expectedVersion: "Pi >= 0.85.1; Node >= 22.19.0",
        detectedVersion: `Pi ${version(codex) || "unknown"}; Node ${version(node) || "unknown"}`,
        paths: { ...paths }
      };
      for (const [name, result] of [["Node", node], ["npx", npx], ["Pi", codex]]) {
        if (result.exitCode !== 0) {
          throw new ACPError("PI_RUNTIME_PROBE_FAILED", `${name} --version failed`, {
            ...details, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr
          });
        }
      }
      if (!version(node) || !version(codex)) {
        throw new ACPError("PI_RUNTIME_VERSION_UNKNOWN", "Could not read the Node / Pi version", {
          ...details, stdout: `Node: ${node.stdout}\nPi: ${codex.stdout}`,
          stderr: `Node: ${node.stderr}\nPi: ${codex.stderr}`
        });
      }
      if (!atLeast(version(node), [22, 19, 0]) || !atLeast(version(codex), [0, 85, 1])) {
        throw new ACPError("PI_RUNTIME_VERSION", "Pi >= 0.85.1 and Node >= 22.19.0 are required for offline startup", details);
      }
    }
    return {
      paths: { ...paths },
      versions: {
        node: describeRuntime(node),
        npx: describeRuntime(npx),
        [provider.id]: describeRuntime(codex),
        codexACP: ""
      },
      login: describeRuntime(login),
      healthy: node.exitCode === 0 && npx.exitCode === 0 && codex.exitCode === 0,
      lastError: [node, npx, codex].filter((result) => result.exitCode !== 0)
        .map((result) => result.stderr || result.stdout).join("\n")
    };
  }

  function createZoteroACPClient({ getPreference, setPreference, log, agentId = "codex", probe = false } = {}) {
    const provider = Agents.getProvider(agentId);
    const readPaths = () => ({
      nodePath: String(getPreference(Constants.PREFS.codexNodePath) || "").trim(),
      npxCliPath: String(getPreference(Constants.PREFS.codexNpxCliPath) || "").trim(),
      [`${provider.id}Path`]: String(getPreference(provider.executablePref) || "").trim()
    });
    const fingerprint = () => JSON.stringify(provider.runtime === "native" ? { opencodePath: readPaths().opencodePath } : readPaths());
    const nativeRuntime = provider.runtime === "native" ? OpenCode.createRuntime({ readPaths, probe }) : null;
    return new ACPClient({
      agentId,
      nativeRuntime,
      processFactory: (options) => nativeRuntime ? nativeRuntime.spawn(options) : createSubprocess(readPaths(), options, agentId),
      getPreparedVersion: () => {
        const savedFingerprint = String(
          getPreference(provider.fingerprintPref) || ""
        );
        return savedFingerprint === fingerprint()
          ? String(getPreference(provider.preparedPref) || "")
          : "";
      },
      setPreparedVersion: (version) => {
        setPreference(provider.preparedPref, version);
        setPreference(provider.fingerprintPref, fingerprint());
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
    toNativeAbsolutePath,
    detectLocalPaths,
    validateRuntimePaths,
    inspectLocalRuntime,
    detectSharedPaths,
    listRuntimePathCandidates,
    inspectSharedRuntime,
    createSubprocess,
    createEnvironment,
    createZoteroACPClient
  };
  if (typeof module !== "undefined" && module.exports) module.exports = modules.ACP;
})(typeof globalThis !== "undefined" ? globalThis : this);
