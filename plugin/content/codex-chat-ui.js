(function (global) {
  "use strict";

  const modules = global.SmartPaperTranslatorModules = global.SmartPaperTranslatorModules || {};
  const Constants = modules.Constants || (
    typeof require === "function" ? require("./constants.js") : null
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

  function appendSafeInline(doc, parent, text) {
    const pattern = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/giu;
    let index = 0;
    let match;
    while ((match = pattern.exec(text))) {
      parent.append(doc.createTextNode(text.slice(index, match.index)));
      const link = doc.createElement("a");
      link.textContent = match[1];
      link.href = match[2];
      link.rel = "noopener noreferrer";
      link.target = "_blank";
      parent.append(link);
      index = match.index + match[0].length;
    }
    parent.append(doc.createTextNode(text.slice(index)));
  }

  function renderSafeMarkdown(doc, container, source) {
    container.replaceChildren();
    const lines = String(source || "").split(/\r?\n/u);
    let code = null;
    let language = "";
    let paragraph = [];

    const flushParagraph = () => {
      if (!paragraph.length) return;
      const element = doc.createElement("p");
      appendSafeInline(doc, element, paragraph.join("\n"));
      container.append(element);
      paragraph = [];
    };
    const flushCode = () => {
      const wrapper = doc.createElement("div");
      wrapper.className = "spt-codex-code";
      const header = doc.createElement("div");
      header.className = "spt-codex-code-header";
      const label = doc.createElement("span");
      label.textContent = language || "code";
      const copy = doc.createElement("button");
      copy.type = "button";
      copy.textContent = "复制";
      const value = code.join("\n");
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
      const codeElement = doc.createElement("code");
      codeElement.textContent = value;
      pre.append(codeElement);
      wrapper.append(header, pre);
      container.append(wrapper);
      code = null;
      language = "";
    };

    for (const line of lines) {
      const fence = line.match(/^```([^`]*)$/u);
      if (fence) {
        if (code) flushCode();
        else {
          flushParagraph();
          code = [];
          language = fence[1].trim();
        }
        continue;
      }
      if (code) {
        code.push(line);
        continue;
      }
      if (!line.trim()) {
        flushParagraph();
        continue;
      }
      const heading = line.match(/^(#{1,3})\s+(.+)$/u);
      if (heading) {
        flushParagraph();
        const element = doc.createElement(`h${Math.min(heading[1].length + 2, 5)}`);
        appendSafeInline(doc, element, heading[2]);
        container.append(element);
      }
      else if (/^[-*]\s+/u.test(line)) {
        flushParagraph();
        let list = container.lastElementChild;
        if (!list || list.localName !== "ul") {
          list = doc.createElement("ul");
          container.append(list);
        }
        const item = doc.createElement("li");
        appendSafeInline(doc, item, line.replace(/^[-*]\s+/u, ""));
        list.append(item);
      }
      else paragraph.push(line);
    }
    if (code) flushCode();
    flushParagraph();
  }

  function stringifyDetails(value) {
    try { return JSON.stringify(value, null, 2); }
    catch (_error) { return String(value || ""); }
  }

  function makeButton(doc, label, action, className = "") {
    const button = doc.createElement("button");
    button.type = "button";
    button.textContent = label;
    if (className) button.className = className;
    button.addEventListener("click", action);
    return button;
  }

  class CodexChatUI {
    constructor({ service, stylesheetText, rootURI, log } = {}) {
      this.service = service;
      this.stylesheetText = stylesheetText || "";
      this.rootURI = rootURI;
      this.log = log || (() => {});
      this.pluginID = null;
      this.paneID = null;
      this.views = new Map();
      this.windowCleanups = new Map();
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
      view.unsubscribe?.();
      for (const cleanup of view.cleanups) cleanup();
      this.views.delete(body);
    }

    _renderShell({ doc, body, setSectionSummary }) {
      this._destroyView(body);
      body.replaceChildren();
      const root = doc.createElement("div");
      root.className = "spt-codex-chat";
      const toolbar = doc.createElement("div");
      toolbar.className = "spt-codex-toolbar";
      const status = doc.createElement("span");
      status.className = "spt-codex-status";
      status.textContent = "本地历史";
      const reload = makeButton(doc, "重新加载", () => this._run(body, "reload"));
      const workspace = makeButton(doc, "打开工作区", () => this._run(body, "workspace"));
      const reset = makeButton(doc, "新建会话", () => this._run(body, "reset"), "spt-codex-danger-button");
      toolbar.append(status, reload, workspace, reset);
      const configuration = doc.createElement("div");
      configuration.className = "spt-codex-config";
      const notices = doc.createElement("div");
      notices.className = "spt-codex-notices";
      const messages = doc.createElement("div");
      messages.className = "spt-codex-messages";
      messages.setAttribute("aria-live", "polite");
      const composer = doc.createElement("div");
      composer.className = "spt-codex-composer";
      const input = doc.createElement("textarea");
      input.rows = 3;
      input.placeholder = "围绕当前 PDF 向本机 Codex 提问…";
      const actions = doc.createElement("div");
      const stop = makeButton(doc, "停止", () => this._run(body, "cancel"));
      stop.hidden = true;
      const send = makeButton(doc, "发送", () => this._run(body, "send"), "spt-codex-primary-button");
      actions.append(stop, send);
      composer.append(input, actions);
      root.append(toolbar, configuration, notices, messages, composer);
      body.append(root);
      const view = {
        body,
        root,
        attachmentID: null,
        state: null,
        setSectionSummary,
        elements: { status, configuration, notices, messages, input, send, stop, reload, workspace, reset },
        cleanups: []
      };
      const keydown = (event) => {
        if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
          event.preventDefault();
          this._run(body, "send");
        }
      };
      input.addEventListener("keydown", keydown);
      view.cleanups.push(() => input.removeEventListener("keydown", keydown));
      this.views.set(body, view);
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
        view.unsubscribe = this.service.subscribe(attachmentID, (state) => this._updateView(view, state));
      }
      try {
        this._updateView(view, await this.service.load(attachmentID));
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
      let pendingText = "";
      try {
        if (action === "send") {
          pendingText = view.elements.input.value.trim();
          if (!pendingText) return;
          view.elements.input.value = "";
          await this.service.send(view.attachmentID, pendingText);
        }
        else if (action === "reload") await this.service.reload(view.attachmentID);
        else if (action === "cancel") await this.service.cancel(view.attachmentID);
        else if (action === "workspace") await this.service.openWorkspace(view.attachmentID);
        else if (action === "reset") {
          const confirmed = body.ownerDocument.defaultView.confirm(
            "新建会话会归档当前映射并保留旧工作区，不会删除 Codex thread。继续吗？"
          );
          if (confirmed) await this.service.rebuild(view.attachmentID);
        }
      }
      catch (error) {
        if (action === "send" && pendingText) view.elements.input.value ||= pendingText;
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
            if (doc.defaultView.confirm("归档旧映射并为新 PDF 建立会话？")) {
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
        const details = doc.createElement("pre");
        details.textContent = stringifyDetails(interaction.toolCall);
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
      container.replaceChildren();
      if (!state.record.transcript.length) {
        const empty = doc.createElement("p");
        empty.className = "spt-codex-empty";
        empty.textContent = "首条消息会复制当前 PDF 到专用工作区并附加给 Codex；后续消息只发送文本。";
        container.append(empty);
        return;
      }
      for (const entry of state.record.transcript) {
        if (entry.kind === "message") {
          const article = doc.createElement("article");
          article.className = `spt-codex-message spt-codex-${entry.role}`;
          const label = doc.createElement("strong");
          label.textContent = entry.role === "user" ? "你" : "Codex";
          const content = doc.createElement("div");
          content.className = "spt-codex-markdown";
          renderSafeMarkdown(doc, content, entry.text);
          article.append(label, content);
          container.append(article);
        }
        else {
          const details = doc.createElement("details");
          details.className = "spt-codex-event";
          const summary = doc.createElement("summary");
          summary.textContent = entry.kind === "tool"
            ? `${entry.title || "工具调用"} · ${entry.status || ""}`
            : entry.kind === "plan" ? "计划" : "思考过程";
          const pre = doc.createElement("pre");
          pre.textContent = entry.kind === "thought" ? entry.text : stringifyDetails(entry);
          details.append(summary, pre);
          container.append(details);
        }
      }
      container.scrollTop = container.scrollHeight;
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
      view.setSectionSummary?.(waiting ? "等待授权" : (state.record.session.id ? "已绑定会话" : "未创建会话"));
      view.elements.stop.hidden = state.status !== "generating" && !waiting;
      view.elements.send.disabled = busy || waiting || state.sourceChanged || state.historyReadOnly;
      view.elements.input.disabled = busy || waiting || state.sourceChanged || state.historyReadOnly;
      view.elements.reset.disabled = busy || waiting;
      this._renderConfig(view, state);
      this._renderNotices(view, state);
      this._renderTranscript(view, state);
    }

    shutdown() {
      for (const body of Array.from(this.views.keys())) this._destroyView(body);
      if (this.paneID) global.Zotero.ItemPaneManager.unregisterSection(this.paneID);
      this.paneID = null;
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
    renderSafeMarkdown
  };
  if (typeof module !== "undefined" && module.exports) module.exports = modules.CodexChatUI;
})(typeof globalThis !== "undefined" ? globalThis : this);
