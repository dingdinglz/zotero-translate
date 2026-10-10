(function (global) {
  "use strict";

  const modules = global.SmartPaperTranslatorModules = global.SmartPaperTranslatorModules || {};
  const ChatUI = modules.CodexChatUI || (
    typeof require === "function" ? require("./codex-chat-ui.js") : null
  );
  const CLOSED = Symbol("branch-closed");
  const BUSY = new Set(["connecting", "generating", "waiting-approval", "cancelling"]);
  const WINDOW_FEATURES = "chrome,dialog=no,resizable,centerscreen,width=680,height=720";
  let windowSerial = 0;

  const STRINGS = {
    en: {
      title: "Temporary branch chat", untitled: "Untitled paper",
      explain: "Explain this passage", send: "Send", stop: "Stop", messages: "Branch messages",
      input: "Ask a follow-up question…", keys: "Enter to send · Shift+Enter for a new line",
      empty: "No request has been sent. Explain the selected passage, or write your own question.",
      replace: "Discard the existing temporary branch and open a new one? Generation will stop and the plugin’s branch data will be removed. The Agent or provider may retain records.",
      failed: "Could not open the temporary branch chat.", actionFailed: "The operation failed.",
      cleanupFailed: "Temporary branch cleanup failed. Some temporary files may remain. A new branch is blocked to avoid overlapping processes. Restart Zotero before trying again.",
      loading: "Loading local view…", idle: "Not connected", ready: "Ready", connecting: "Connecting…",
      generating: "Generating…", cancelling: "Stopping…", cancelled: "Stopped", error: "Error",
      "waiting-approval": "Waiting for your response", "thread-missing": "Session unavailable",
      blocked: "This branch cannot send with the current paper/session state. Close it and open a new branch.",
      interactions: "Agent permissions and questions"
    },
    zh: {
      title: "临时分支聊天", untitled: "未命名论文", explain: "解释这段内容", send: "发送", stop: "停止",
      messages: "分支对话消息", input: "继续提问…", keys: "Enter 发送 · Shift+Enter 换行",
      empty: "尚未发送请求。可点击“解释这段内容”，也可自行输入问题。",
      replace: "丢弃已有临时分支并打开新分支？这会停止生成并清理插件的分支数据，但 Agent 或服务商可能保留记录。",
      failed: "无法打开临时分支聊天。", actionFailed: "操作失败。", loading: "正在加载本地视图…",
      cleanupFailed: "临时分支清理失败，可能残留临时文件。为避免进程重叠，已阻止新建分支；请重启 Zotero 后再试。",
      idle: "未连接", ready: "就绪", connecting: "正在连接…", generating: "正在生成…",
      cancelling: "正在停止…", cancelled: "已停止", error: "发生错误", "waiting-approval": "等待你的回应",
      "thread-missing": "会话不可用", blocked: "当前论文或会话状态无法发送，请关闭后重新打开分支。",
      interactions: "Agent 授权与交互"
    }
  };

  function strings() {
    return /^zh(?:-|$)/iu.test(global.Zotero?.locale || "") ? STRINGS.zh : STRINGS.en;
  }

  // The caller validates the context. Copy again before queueing, and pass a
  // separate JSON copy to the backend: neither side can follow later main-chat changes.
  function copyContext(context) {
    if (!context || !["codex", "pi", "opencode"].includes(context.agentId) ||
      !Number.isSafeInteger(context.attachmentID) || context.attachmentID <= 0 ||
      context.paper?.attachmentID !== context.attachmentID ||
      typeof context.selectionText !== "string" || !context.selectionText.trim()) {
      throw new Error("Invalid branch context");
    }
    const snapshot = JSON.parse(JSON.stringify({
      agentId: context.agentId, attachmentID: context.attachmentID, paper: context.paper,
      selectionText: context.selectionText, answerText: context.answerText || "",
      questionText: context.questionText || "",
      config: { model: context.config?.model || "", reasoningEffort: context.config?.reasoningEffort || "" }
    }));
    // Capability metadata is an internal factory input, not UI or prompt data.
    // The service factory passes it separately to its memory cache.
    if (context.configurationCatalog) {
      snapshot.configurationCatalog = JSON.parse(JSON.stringify(context.configurationCatalog));
    }
    return snapshot;
  }

  function listen(target, type, callback, cleanups, capture = false) {
    target.addEventListener(type, callback, capture);
    cleanups.push(() => target.removeEventListener(type, callback, capture));
  }

  function topLevelEvent(event, win) {
    return !event.target || event.target === win || event.target === win.document ||
      event.target.defaultView === win;
  }

  class BranchChatUI {
    // openWindow(owner, url, name, features) may return a Window or a Promise<Window>.
    // No context, callback or owner object is passed as a dialog argument/content payload.
    constructor({
      createService, rootURI = "", stylesheetText = "", log, openWindow,
      windowURI = "chrome://smart-paper-translator/content/branch-chat.xhtml"
    } = {}) {
      this.createService = createService;
      this.rootURI = rootURI;
      this.windowURI = windowURI;
      this.stylesheetText = stylesheetText;
      this.log = log || (() => {});
      this.openWindow = openWindow || ((owner, url, name, features) => owner.openDialog(url, name, features));
      this.windows = new Map();
      this.stopped = false;
      this.shutdownPromise = null;
    }

    _slot(owner) {
      let slot = this.windows.get(owner);
      if (slot) return slot;
      slot = { owner, current: null, epoch: 0, queue: Promise.resolve(), pending: 0, cleanups: [], gone: false };
      const ownerClosed = (event) => {
        if (!topLevelEvent(event, owner)) return;
        slot.gone = true;
        this.closeForWindow(owner).catch(error => this.log("Branch owner cleanup failed", error));
      };
      listen(owner, "unload", ownerClosed, slot.cleanups);
      listen(owner, "close", ownerClosed, slot.cleanups);
      this.windows.set(owner, slot);
      return slot;
    }

    _slotCurrent(slot, epoch) {
      return !this.stopped && !slot.gone && !slot.owner.closed &&
        this.windows.get(slot.owner) === slot && slot.epoch === epoch;
    }

    _current(record) {
      return !record.closed && this._slotCurrent(record.slot, record.epoch) &&
        record.slot.current === record && !record.window?.closed &&
        (!record.document || record.window.document === record.document);
    }

    _prune(slot) {
      if (slot.pending || slot.current || slot.failure || this.windows.get(slot.owner) !== slot) return;
      for (const cleanup of slot.cleanups.splice(0)) {
        try { cleanup(); }
        catch (error) { this.log("Branch owner listener cleanup failed", error); }
      }
      this.windows.delete(slot.owner);
    }

    open(ownerWindow, context) {
      if (this.stopped || !ownerWindow || ownerWindow.closed) return Promise.resolve(false);
      let snapshot;
      try { snapshot = copyContext(context); }
      catch (error) {
        this.log("Invalid branch context", error);
        return Promise.resolve(false);
      }
      const slot = this._slot(ownerWindow);
      const epoch = slot.epoch;
      slot.pending++;
      const task = slot.queue.then(() => this._open(slot, epoch, snapshot)).catch(error => {
        if (slot.failure) this._reportCleanupFailure(slot, error);
        else this.log("Branch initialization failed", error);
        return false;
      }).finally(() => {
        slot.pending--;
        this._prune(slot);
      });
      slot.queue = task.then(() => {});
      return task;
    }

    async _open(slot, epoch, context) {
      if (!this._slotCurrent(slot, epoch)) return false;
      if (slot.failure) throw slot.failure;
      if (slot.current) {
        const previous = slot.current;
        if (!previous.closed && !slot.owner.confirm(strings().replace)) {
          previous.window?.focus?.();
          return false;
        }
        // Never construct a new backend while the old backend can still remove files.
        await this._closeRecord(previous);
        if (!this._slotCurrent(slot, epoch)) return false;
      }
      let resolveClosed;
      const record = {
        slot, epoch, context, words: strings(), closed: false, cleanups: [],
        window: null, document: null, service: null, renderer: null, view: null,
        loaded: false, sending: false, cancelPending: false, stateRevision: 0,
        closedPromise: new Promise(resolve => { resolveClosed = resolve; }),
        resolveClosed: () => resolveClosed(CLOSED)
      };
      slot.current = record;
      let opened = false;
      try {
        const url = this.windowURI;
        const opening = Promise.resolve(this.openWindow(
          slot.owner, url, `spt-branch-chat-${Date.now()}-${++windowSerial}`, WINDOW_FEATURES
        )).then(win => {
          if (!this._current(record)) {
            this._closeWindow(win);
            return CLOSED;
          }
          record.window = win;
          return win;
        });
        const win = await this._untilClosed(record, opening);
        if (win === CLOSED || !this._current(record)) return false;
        if (!win?.document) throw new Error("Branch window unavailable");
        const doc = await this._waitForDocument(record, url);
        if (doc === CLOSED || !this._current(record)) return false;
        record.document = doc;
        record.service = this.createService(copyContext(context));
        if (!this._current(record)) {
          // A factory can synchronously re-enter the owner's close handler.
          // That handler ran before this return value became available to it.
          const service = record.service;
          try { await service?.shutdown?.(); }
          catch (error) { slot.failure = error; throw error; }
          return false;
        }
        if (!record.service || typeof record.service.shutdown !== "function" ||
          typeof record.service.load !== "function" || typeof record.service.subscribe !== "function") {
          throw new Error("Branch service unavailable");
        }
        record.renderer = new ChatUI.CodexChatUI({
          service: record.service, rootURI: this.rootURI, stylesheetText: this.stylesheetText, log: this.log
        });
        // Deliberately do not call init(), addToWindow(), or the sidebar shell.
        this._buildView(record);
        const unsubscribe = record.service.subscribe(context.attachmentID, state => {
          if (this._current(record)) this._acceptState(record, state);
        });
        const detach = () => {
          try { unsubscribe?.(); }
          catch (error) { this.log("Branch unsubscribe failed", error); }
        };
        if (!this._current(record)) {
          detach();
          return false;
        }
        record.view.unsubscribe = detach;
        const revision = record.stateRevision;
        const state = await this._untilClosed(record, record.service.load(context.attachmentID));
        if (state === CLOSED || !this._current(record)) return false;
        // A subscription may have delivered a more recent snapshot during load.
        if (record.stateRevision === revision && !this._acceptState(record, state)) {
          throw new Error("Invalid branch state");
        }
        if (!record.view.state) throw new Error("Missing branch state");
        record.loaded = true;
        this._updateControls(record);
        record.view.elements.input.focus();
        opened = true;
        return true;
      }
      catch (error) {
        if (this._current(record)) {
          this.log("Branch opening failed", error);
          slot.owner.alert?.(`${record.words.failed}\n${error.message || ""}`);
        }
        return false;
      }
      finally {
        if (!opened) await this._closeRecord(record);
      }
    }

    _untilClosed(record, promise) {
      // Promise.race also observes a late rejection. A closed window must not wait
      // for document loading, service.load(), or a pending turn to settle its UI task.
      return Promise.race([Promise.resolve(promise), record.closedPromise]);
    }

    _reportCleanupFailure(slot, error) {
      this.log("Branch cleanup failed", error);
      if (!this.stopped && !slot.gone && !slot.owner.closed) slot.owner.alert?.(strings().cleanupFailed);
    }

    _waitForDocument(record, url) {
      const win = record.window;
      const closed = event => {
        if (topLevelEvent(event, win)) {
          this.closeForWindow(record.slot.owner).catch(error => this._reportCleanupFailure(record.slot, error));
        }
      };
      listen(win, "close", closed, record.cleanups);
      listen(win, "unload", event => {
        // Ignore about:blank and iframe unloads, including late initial events
        // delivered after the target document has already been bound.
        const doc = event.target;
        const uri = doc?.documentURI || doc?.URL;
        if (win.closed || (uri === url && doc === (record.document || win.document))) closed(event);
      }, record.cleanups);
      return new Promise((resolve, reject) => {
        let done = false;
        let timer;
        const finish = (value, error) => {
          if (done) return;
          done = true;
          win.removeEventListener("load", loaded);
          global.clearTimeout(timer);
          if (error) reject(error);
          else resolve(value);
        };
        const loaded = event => {
          if (event && event.target !== win.document) return;
          if (!this._current(record)) return finish(CLOSED);
          const doc = win.document;
          const uri = doc?.documentURI || doc?.URL;
          if (doc?.readyState === "complete" && uri === url && doc.body) {
            record.document = doc;
            finish(doc);
          }
          else if (event && uri && uri !== "about:blank" && uri !== url) {
            finish(null, new Error("Unexpected branch document"));
          }
        };
        win.addEventListener("load", loaded);
        record.cleanups.push(() => finish(CLOSED));
        timer = global.setTimeout(() => finish(null, new Error("Branch window load timed out")), 15000);
        loaded();
      });
    }

    _buildView(record) {
      const { document: doc, context, words } = record;
      doc.title = `${words.title} — ${context.paper.title || words.untitled}`;
      doc.documentElement.setAttribute("lang", words === STRINGS.zh ? "zh-CN" : "en");
      if (this.stylesheetText) {
        const style = doc.createElement("style");
        style.textContent = this.stylesheetText;
        doc.head.insertBefore(style, doc.head.firstChild);
        doc.getElementById("spt-branch-base-style")?.remove();
        record.cleanups.push(() => style.remove());
      }
      const node = (name, className, text) => {
        const result = doc.createElement(name);
        if (className) result.className = className;
        if (text !== undefined) result.textContent = text;
        return result;
      };
      const root = node("main", "spt-codex-chat spt-branch-chat");
      const elements = {};
      const view = {
        body: doc.body, root, attachmentID: context.attachmentID, agentId: context.agentId,
        requestSerial: 0, state: null, transcriptRendered: false, elements, cleanups: []
      };
      record.view = view;
      record.renderer.views.set(view.body, view);
      const button = (label, action, extra = "") => {
        const result = node("button", `spt-codex-button ${extra}`, label);
        result.type = "button";
        listen(result, "click", () => { if (this._current(record)) void action(); }, view.cleanups);
        return result;
      };
      const header = node("header", "spt-branch-header");
      header.append(node("h1", "", words.title), node("h2", "spt-branch-paper-title", context.paper.title || words.untitled));
      elements.messages = node("div", "spt-codex-messages");
      elements.messages.tabIndex = 0;
      elements.messages.setAttribute("role", "region");
      elements.messages.setAttribute("aria-label", words.messages);
      elements.notices = node("div", "spt-codex-notices spt-branch-errors");
      elements.notices.setAttribute("role", "alert");
      elements.interactions = node("section", "spt-branch-interactions");
      elements.interactions.setAttribute("aria-label", words.interactions);
      // Never allow an implicit HTML form submission to navigate the window.
      listen(elements.interactions, "submit", event => event.preventDefault(), view.cleanups);
      elements.status = node("div", "spt-branch-status", words.loading);
      elements.status.setAttribute("role", "status");
      elements.status.setAttribute("aria-live", "polite");
      const composer = node("section", "spt-codex-composer");
      elements.input = node("textarea");
      elements.input.rows = 3;
      elements.input.placeholder = words.input;
      elements.input.setAttribute("aria-label", words.input);
      elements.input.setAttribute("aria-describedby", "spt-branch-key-hint");
      elements.input.readOnly = true;
      const hint = node("p", "spt-branch-key-hint", words.keys);
      hint.id = "spt-branch-key-hint";
      elements.explain = button(words.explain, () => this._send(record, true));
      elements.stop = button(words.stop, () => this._cancel(record));
      elements.send = button(words.send, () => this._send(record), "spt-codex-primary-button");
      const actions = node("div", "spt-branch-actions");
      actions.append(elements.explain, elements.stop, elements.send);
      composer.append(elements.status, elements.input, hint, actions);
      root.append(header, elements.messages, elements.notices, elements.interactions, composer);
      view.body.replaceChildren(root);
      listen(elements.input, "input", () => this._updateControls(record), view.cleanups);
      listen(elements.input, "keydown", event => {
        if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
          event.preventDefault();
          void this._send(record);
        }
      }, view.cleanups);
      listen(doc, "selectionchange", () => {
        if (this._current(record) && view.transcriptDeferred && view.state) this._renderTranscript(record);
      }, view.cleanups);
      this._updateControls(record);
    }

    _acceptState(record, state) {
      if (!this._current(record) || !state?.record?.session || !Array.isArray(state.record.transcript) ||
        (state.agentId && state.agentId !== record.context.agentId) ||
        (state.attachmentID && state.attachmentID !== record.context.attachmentID)) return false;
      record.view.state = state;
      record.stateRevision++;
      this._updateControls(record);
      this._renderInteractions(record, state.pendingInteractions || []);
      this._renderTranscript(record);
      return true;
    }

    _renderTranscript(record) {
      const { view, renderer, words } = record;
      renderer._renderTranscript(view, view.state);
      if (!view.transcriptDeferred && !view.state.record.transcript.length) {
        view.elements.messages.firstElementChild.textContent = words.empty;
      }
    }

    _renderInteractions(record, interactions) {
      const key = JSON.stringify(interactions);
      if (record.interactionKey === key) return;
      record.interactionKey = key;
      const { view, renderer } = record;
      const container = view.elements.interactions;
      // Stream/status updates must not replace Pi's focused elicitation inputs.
      container.replaceChildren(...interactions.map(interaction => renderer._renderInteraction(view, interaction)));
    }

    _updateControls(record) {
      if (!this._current(record) || !record.view) return;
      const { state, elements, root } = record.view;
      const status = state?.status || "idle";
      const busy = record.sending || BUSY.has(status);
      const blocked = Boolean(state?.sourceChanged || state?.historyReadOnly);
      elements.input.readOnly = !record.loaded || busy || blocked;
      elements.send.disabled = !record.loaded || busy || blocked || !elements.input.value.trim();
      elements.explain.disabled = !record.loaded || busy || blocked;
      elements.stop.hidden = !busy;
      elements.stop.disabled = record.cancelPending || status === "cancelling";
      const visibleStatus = record.cancelPending ? "cancelling" :
        !record.loaded ? "loading" : record.sending && !BUSY.has(status) ? "connecting" : status;
      elements.status.textContent = record.words[visibleStatus] || visibleStatus;
      root.dataset.status = visibleStatus;
      const error = record.localError || state?.error || (blocked ? record.words.blocked : "");
      // Renderer failures use this same notices node, never the interaction container.
      if (error !== record.renderedError) {
        elements.notices.textContent = error;
        record.renderedError = error;
      }
    }

    async _send(record, explain = false) {
      if (!this._current(record) || !record.loaded) return false;
      const { view, context } = record;
      if (record.sending || BUSY.has(view.state?.status) || view.state?.sourceChanged || view.state?.historyReadOnly) return false;
      const draft = view.elements.input.value;
      const text = explain ? record.words.explain : draft.trim();
      if (!text) return false;
      const serial = view.requestSerial;
      record.sending = true;
      record.localError = "";
      view.elements.notices.replaceChildren();
      this._updateControls(record);
      try {
        const result = await this._untilClosed(record, record.service.send(context.attachmentID, text));
        if (result === CLOSED || !this._current(record) || view.requestSerial !== serial) return false;
        if (!explain && view.elements.input.value === draft) view.elements.input.value = "";
        return true;
      }
      catch (error) {
        if (this._current(record) && view.requestSerial === serial) {
          // Keep the exact draft, including whitespace, on any rejected send.
          record.localError = error.message || record.words.actionFailed;
        }
        return false;
      }
      finally {
        if (this._current(record) && view.requestSerial === serial) {
          record.sending = false;
          this._updateControls(record);
        }
      }
    }

    async _cancel(record) {
      if (!this._current(record) || record.cancelPending ||
        !(record.sending || BUSY.has(record.view?.state?.status))) return false;
      record.cancelPending = true;
      this._updateControls(record);
      try {
        return await this._untilClosed(record, record.service.cancel(record.context.attachmentID)) !== CLOSED;
      }
      catch (error) {
        if (this._current(record)) record.localError = error.message || record.words.actionFailed;
        return false;
      }
      finally {
        if (this._current(record)) {
          record.cancelPending = false;
          this._updateControls(record);
        }
      }
    }

    _closeWindow(win) {
      if (win && !win.closed) win.close();
    }

    _closeRecord(record) {
      if (record.closePromise) return record.closePromise;
      let resolve, reject;
      record.closePromise = new Promise((yes, no) => { resolve = yes; reject = no; });
      record.closed = true;
      record.resolveClosed();
      const errors = [];
      const attempt = action => {
        try { action(); }
        catch (error) { errors.push(error); }
      };
      for (const cleanup of record.cleanups.splice(0)) attempt(cleanup);
      if (record.view) {
        attempt(() => record.renderer._destroyView(record.view.body));
        // Clear detached nodes too: late renderer promises may still hold view.
        for (const element of Object.values(record.view.elements)) attempt(() => element.replaceChildren());
        attempt(() => record.view.root.replaceChildren());
        attempt(() => record.view.body.replaceChildren());
        record.view.state = null;
        attempt(() => { if (record.view.elements.input) record.view.elements.input.value = ""; });
      }
      attempt(() => this._closeWindow(record.window));
      // shutdown(), not cancel()+await turn, is the backend's stop-and-reclaim
      // boundary. Start it immediately even when load/send are still outstanding.
      const shutdown = async target => { if (target) await target.shutdown(); };
      Promise.allSettled([shutdown(record.renderer), shutdown(record.service)]).then(results => {
        for (const result of results) if (result.status === "rejected") errors.push(result.reason);
        record.context = null;
        record.interactionKey = null;
        record.localError = record.renderedError = "";
        record.view = null;
        record.renderer = null;
        record.service = null;
        record.window = null;
        record.document = null;
        if (errors.length) {
          record.slot.failure = errors[0];
          reject(errors[0]); // Fail closed: an uncertain cleanup must not permit replacement.
        }
        else {
          if (record.slot.current === record) record.slot.current = null;
          this._prune(record.slot);
          resolve();
        }
      });
      return record.closePromise;
    }

    async closeForWindow(ownerWindow) {
      const slot = this.windows.get(ownerWindow);
      if (!slot) return;
      slot.epoch++;
      const closing = slot.current ? this._closeRecord(slot.current) : Promise.resolve();
      const results = await Promise.allSettled([closing, slot.queue]);
      this._prune(slot);
      const failure = results.find(result => result.status === "rejected");
      if (failure) throw failure.reason;
      if (slot.failure) throw slot.failure;
    }

    shutdown() {
      if (this.shutdownPromise) return this.shutdownPromise;
      this.stopped = true;
      this.shutdownPromise = (async () => {
        const results = await Promise.allSettled([...this.windows.keys()].map(owner => this.closeForWindow(owner)));
        for (const slot of this.windows.values()) {
          for (const cleanup of slot.cleanups.splice(0)) {
            try { cleanup(); }
            catch (error) { this.log("Branch owner listener cleanup failed", error); }
          }
        }
        this.windows.clear();
        const failure = results.find(result => result.status === "rejected");
        if (failure) throw failure.reason;
      })();
      return this.shutdownPromise;
    }
  }

  modules.BranchChatUI = { BranchChatUI };
  if (typeof module !== "undefined" && module.exports) module.exports = modules.BranchChatUI;
})(typeof globalThis !== "undefined" ? globalThis : this);
