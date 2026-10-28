(function (global) {
  "use strict";
  const modules = global.SmartPaperTranslatorModules = global.SmartPaperTranslatorModules || {};
  const URI = "chrome://smart-paper-translator/content/fulltext.xhtml";
  const CLOSED = Symbol("closed");
  const CONFIG_KEYS = ["provider", "endpoint", "model", "translationPrompt", "reviewPrompt"];
  const configKey = config => JSON.stringify(CONFIG_KEYS.map(key => config[key]));
  let serial = 0;
  const stages = { new: "尚未上传", parsing: "正在解析 PDF", review: "请核对识别结果", ready: "等待翻译", translating: "逐段翻译与校对", paused: "已暂停", translated: "翻译完成，尚未保存 PDF", exporting: "正在生成并保存 PDF", complete: "中文 PDF 已保存" };
  function listen(target, name, fn, cleanups) {
    target.addEventListener(name, fn);
    cleanups.push(() => target.removeEventListener(name, fn));
  }
  function top(event, win) { return event.target === win || event.target === win.document; }
  function safeError(error) {
    return String(error?.message || error || "")
      .replace(/(?:Bearer\s+|sk-)[A-Za-z0-9_.-]+/giu, "[已隐藏密钥]")
      .replace(/([?&](?:key|api_key|token|access_token)=)[^\s&#]+/giu, "$1[已隐藏]")
      .slice(0, 1200);
  }
  function address(value) {
    try { const url = new URL(value); return url.origin + url.pathname; }
    catch (_) { return "未配置有效地址"; }
  }
  class FulltextUI {
    constructor({ runtime, rootURI = "", openWindow, windowURI = URI } = {}) {
      Object.assign(this, { runtime, rootURI, windowURI });
      this.openWindow = openWindow || ((owner, url, name, features) => owner.openDialog(url, name, features));
      this.windows = new Map(); this.stopped = false;
    }
    _slot(owner) {
      if (this.windows.has(owner)) return this.windows.get(owner);
      const slot = { owner, current: null, queue: Promise.resolve(), gone: false, cleanups: [] };
      const close = event => { if (top(event, owner)) void this.closeForWindow(owner).catch(() => {}); };
      listen(owner, "close", close, slot.cleanups); listen(owner, "unload", close, slot.cleanups);
      this.windows.set(owner, slot); return slot;
    }
    _current(r) {
      return !this.stopped && !r.closed && !r.slot.gone && !r.slot.owner.closed &&
        this.windows.get(r.slot.owner) === r.slot && r.slot.current === r && !r.window?.closed &&
        (!r.document || (r.window.document === r.document && r.document.documentURI === this.windowURI));
    }
    open(owner, attachmentID) {
      if (this.stopped || !owner || owner.closed || !Number.isSafeInteger(attachmentID) || attachmentID <= 0) return Promise.resolve(false);
      const slot = this._slot(owner);
      const task = slot.queue.then(() => this._open(slot, attachmentID)).catch(error => {
        if (!slot.gone && !owner.closed) owner.alert?.(safeError(error));
        return false;
      });
      slot.queue = task.then(() => {}); return task;
    }
    async _open(slot, attachmentID) {
      if (this.stopped || slot.gone || slot.owner.closed) return false;
      const old = slot.current;
      if (old) {
        if (this._current(old) && (old.attachmentID === attachmentID || old.service?.attachmentID === attachmentID)) {
          old.window?.focus(); return true;
        }
        if (!old.closed && !slot.owner.confirm("暂停并保存当前任务，打开另一篇论文？已提交的远端解析任务可能继续。")) return false;
        await this._close(old);
        if (this.stopped || slot.gone || slot.owner.closed) return false;
      }
      let resolveClosed;
      const r = { slot, attachmentID, window: null, document: null, service: null, closed: false,
        cleanups: [], opSerial: 0, previewSerial: 0, pending: false, stopping: false,
        dirty: false, draftDirty: false, page: 1, pages: 0, state: {},
        closedPromise: new Promise(resolve => { resolveClosed = resolve; }), resolveClosed: () => resolveClosed(CLOSED) };
      slot.current = r;
      try {
        r.ready = Promise.resolve(this.runtime.create(attachmentID)).then(async service => {
          // The runtime caches by source PDF. Claim a service synchronously before
          // awaiting load, so two owners cannot both become its editor.
          for (;;) {
            const existing = [...this.windows.values()].map(item => item.current)
              .find(other => other && other !== r && other.service === service);
            if (!existing) break;
            if (existing.closed) {
              await existing.closing;
              if (!this._current(r)) return CLOSED;
              service = await this.runtime.create(attachmentID);
              continue;
            }
            if (this._current(r)) {
              if (existing.window) existing.window.focus();
              else existing.focusRequested = true;
            }
            return CLOSED; // Do not pause a service owned by the other window.
          }
          r.service = service;
          if (this._current(r) && !service.snapshot().busy) await service.load();
          return service;
        });
        const loaded = await Promise.race([r.ready, r.closedPromise]);
        if (loaded === CLOSED || !this._current(r)) { await this._close(r); return false; }
        const opening = Promise.resolve(this.openWindow(slot.owner, this.windowURI, `spt-fulltext-${++serial}`,
          "chrome,dialog=no,resizable,centerscreen,width=1100,height=800")).then(win => {
          if (!this._current(r)) { win?.close(); return CLOSED; }
          r.window = win;
          if (r.focusRequested) win?.focus();
          return win;
        });
        if (await Promise.race([opening, r.closedPromise]) === CLOSED) return false;
        if (!r.window?.document) throw new Error("无法打开全文翻译窗口。");
        const doc = await this._document(r);
        if (doc === CLOSED || !this._current(r) || doc !== r.window.document) { await this._close(r); return false; }
        r.document = doc;
        this._build(r);
        doc.title = `全文翻译 — ${r.service.title || "论文"}`;
        r.el.title.textContent = r.service.title || "论文全文翻译";
        const unsubscribe = r.service.subscribe(state => { if (this._current(r)) this._state(r, state); });
        r.cleanups.push(unsubscribe);
        this._state(r, r.service.snapshot());
        return true;
      } catch (error) {
        if (this._current(r)) slot.owner.alert?.(safeError(error));
        await this._close(r); return false;
      }
    }
    _document(r) {
      const win = r.window;
      listen(win, "close", event => {
        if (!top(event, win) || r.closed) return;
        event.preventDefault();
        if ((this._active(r) || r.dirty || r.draftDirty) && !win.confirm("暂停并关闭全文翻译？已确认进度将保留；未确认的原文编辑和未保存的段落修正将丢弃。已提交的 OXR 远端任务可能继续。")) return;
        void this._close(r).catch(error => win.alert?.(safeError(error)));
      }, r.cleanups);
      listen(win, "beforeunload", event => {
        if (top(event, win) && (this._active(r) || r.dirty || r.draftDirty) && !r.closed) {
          event.preventDefault(); event.returnValue = "关闭将暂停并保留已确认进度，但丢弃未确认的编辑。远端任务可能继续。";
        }
      }, r.cleanups);
      listen(win, "unload", event => {
        if (event.target === (r.document || win.document) && (win.closed || event.target.documentURI === this.windowURI)) {
          void this._close(r).catch(() => {});
        }
      }, r.cleanups);
      return new Promise((resolve, reject) => {
        let done = false, timer;
        const finish = (doc, error) => {
          if (done) return; done = true; global.clearTimeout(timer);
          win.removeEventListener("load", loaded);
          if (error) reject(error); else resolve(doc);
        };
        const loaded = event => {
          if (event && event.target !== win.document) return;
          if (!this._current(r)) return finish(CLOSED);
          const doc = win.document;
          if (doc.documentURI === this.windowURI && doc.readyState === "complete" && doc.body) { r.document = doc; finish(doc); }
          else if (doc.documentURI && doc.documentURI !== this.windowURI && doc.documentURI !== "about:blank") finish(null, new Error("全文翻译页面地址不匹配。"));
        };
        listen(win, "load", loaded, r.cleanups);
        r.cleanups.push(() => finish(CLOSED));
        timer = global.setTimeout(() => finish(null, new Error("全文翻译窗口加载超时。")), 15000);
        loaded();
      });
    }
    _build(r) {
      const doc = r.document, e = r.el = {};
      const node = (tag, id, text) => {
        const n = doc.createElementNS("http://www.w3.org/1999/xhtml", tag);
        if (id) { n.id = `spt-fulltext-${id}`; e[id] = n; }
        if (text) n.textContent = text; return n;
      };
      const button = (id, text, fn) => {
        const n = node("button", id, text); n.type = "button";
        listen(n, "click", () => { if (this._current(r) && !n.disabled) fn(); }, r.cleanups); return n;
      };
      const header = node("header");
      header.append(node("h1", "title", "论文全文翻译"), node("p", "status", "正在加载本地任务…"));
      e.status.setAttribute("role", "status");
      const upload = node("section", "upload-panel");
      upload.append(node("p", "destination"), button("parse", "上传 PDF 并解析", () => this._parse(r)));
      const columns = node("main", "columns"), left = node("section", "pdf"), right = node("section", "markdown");
      const pdfbar = node("div", "pdfbar");
      e.original = node("input", "original"); e.original.type = "checkbox";
      const label = node("label", null, "原始 PDF"); label.prepend?.(e.original);
      if (!e.original.parentNode) label.append(e.original);
      listen(e.original, "change", () => { r.page = 1; void this._preview(r); }, r.cleanups);
      pdfbar.append(label, button("previous", "上一页", () => { r.page--; void this._preview(r); }),
        node("span", "page", "尚无预览"), button("next", "下一页", () => { r.page++; void this._preview(r); }),
        button("reload", "加载预览", () => this._preview(r)));
      const imagebox = node("div", "imagebox");
      imagebox.append(node("img", "image")); e.image.alt = "当前 PDF 页的本地预览"; e.image.hidden = true;
      left.append(pdfbar, node("p", "preview-error"), imagebox);
      const mdbar = node("div", "mdbar");
      mdbar.append(node("h2", null, "Markdown"), button("edit", "编辑原文", () => {
        e.source.hidden = false; e.rendered.hidden = true;
      }), button("preview", "安全预览", () => this._render(r)));
      e.source = node("textarea", "source"); e.source.setAttribute("aria-label", "识别结果 Markdown 源码"); e.source.spellcheck = false;
      listen(e.source, "input", () => { r.dirty = true; this._controls(r); }, r.cleanups);
      e.rendered = node("div", "rendered"); e.rendered.hidden = true;
      right.append(mdbar, e.source, e.rendered, node("p", null, "可修正识别结果；参考文献整条保留原文，正文引用标记受保护。"));
      columns.append(left, right);
      e.error = node("p", "error"); e.error.setAttribute("role", "alert");
      const repair = node("section", "repair");
      repair.append(node("h2", null, "当前段校对未通过"), node("pre", "current"),
        node("p", null, "可修正下面的 masked draft；占位符的内容、数量与顺序不可改变。保存修正不会自动发送。"),
        node("textarea", "draft"), button("save-draft", "保存修正", () => this._action(r, () => r.service.setDraft(e.draft.value), () => { r.draftDirty = false; })));
      e.draft.setAttribute("aria-label", "当前段 masked draft");
      listen(e.draft, "input", () => { r.draftDirty = true; this._controls(r); }, r.cleanups);
      const footer = node("footer");
      footer.append(button("confirm", "确认并开始翻译 / 重试", () => this._translate(r)),
        button("pause", "暂停并保存进度", () => this._pause(r)),
        button("finish", "生成并保存中文 PDF", () => this._action(r, () => r.service.finish(r.window))),
        button("zh", "查看中文 PDF", () => this._action(r, () => this.runtime.openVersion(r.attachmentID, "zh"))),
        button("en", "查看英文 PDF", () => this._action(r, () => this.runtime.openVersion(r.attachmentID, "en"))),
        button("export", "导出中文 Markdown", () => this._action(r, () => r.service.export(r.window))));
      doc.body.replaceChildren(header, upload, columns, e.error, repair, footer,
        node("p", "notice", "打开不上传、不调用模型。翻译共用现有 DeepSeek 配置。中文 PDF 重新排版且批注独立，原 PDF 保留。关闭会暂停；已提交的远端解析可能继续。"));
      listen(r.window, "focus", () => this._controls(r), r.cleanups);
      this._controls(r);
    }
    _active(r) { return Boolean(r.pending || r.stopping || r.state.busy); }
    _changed(r, config) {
      const old = r.state.config;
      return r.el.source.value !== r.state.source || (old && configKey(old) !== configKey(config));
    }
    _state(r, state) {
      r.state = state;
      if (!r.dirty && r.el.source.value !== (state.source || "")) r.el.source.value = state.source || "";
      if (!r.draftDirty && r.el.draft.value !== (state.draft || "")) r.el.draft.value = state.draft || "";
      r.el.current.textContent = state.currentSource || "";
      r.el.status.textContent = `${stages[state.stage] || "本地任务"} · ${state.completed || 0} / ${state.total || 0} 段`;
      if (!r.localError) r.el.error.textContent = safeError(state.error || "");
      r.pages = r.pages || state.pageCount || 0;
      this._controls(r);
      if (state.translated && state.translated !== r.renderedTranslation && !r.dirty && !state.busy) {
        this._render(r); r.renderedTranslation = state.translated;
      }
    }
    _controls(r) {
      if (!r.el || !this._current(r)) return;
      const e = r.el, s = r.state, busy = this._active(r), ready = Boolean(r.service);
      let config, changed = false;
      try { config = this.runtime.config(); changed = this._changed(r, config); e.destination.textContent = `解析会上传完整 PDF 至：${address(config.oxrBaseURL)}`; }
      catch (error) { e.destination.textContent = safeError(error); }
      e.parse.disabled = !ready || busy || Boolean(s.approvedHash);
      e.confirm.disabled = !ready || busy || !s.pageCount || !e.source.value.trim() || r.draftDirty || (Boolean(s.translated) && !changed);
      e.source.readOnly = !ready || busy;
      e.pause.disabled = !ready || r.stopping || !busy;
      e.finish.disabled = !ready || busy || !s.translated || Boolean(s.chineseAttachmentID) || Boolean(s.importIntent) || changed;
      e.export.disabled = !ready || busy || !s.translated || changed;
      e.zh.disabled = e.en.disabled = !ready || busy || !s.chineseAttachmentID;
      e.repair.hidden = !s.currentID || busy || !s.error;
      e.draft.readOnly = busy; e["save-draft"].disabled = busy || !ready || !s.currentID || !r.draftDirty;
      e.original.disabled = e.reload.disabled = !ready || busy;
      e.previous.disabled = !ready || busy || r.page <= 1;
      e.next.disabled = !ready || busy || r.page >= r.pages;
      e.preview.disabled = !ready || busy || !e.source.value;
      e.preview.textContent = s.translated && !r.dirty ? "预览中文译文" : "预览原文";
      e.page.textContent = r.pages ? `第 ${r.page} / ${r.pages} 页` : "尚无预览";
    }
    _error(r, error) { if (this._current(r)) { r.localError = true; r.el.error.textContent = safeError(error); } }
    _action(r, fn, after) {
      if (!this._current(r) || !r.service || this._active(r)) return Promise.resolve(false);
      const id = ++r.opSerial, doc = r.document;
      r.pending = true; r.localError = false; r.el.error.textContent = ""; this._controls(r);
      const valid = () => this._current(r) && r.document === doc && id === r.opSerial;
      const action = Promise.resolve().then(() => valid() ? fn(valid) : undefined).then(() => {
        if (valid()) { after?.(); this._state(r, r.service.snapshot()); } return valid();
      }).catch(error => { if (valid()) this._error(r, error); return false; }).finally(() => {
        if (valid()) { r.pending = false; this._controls(r); }
      });
      r.action = action; return action;
    }
    _parse(r) {
      return this._action(r, async valid => {
        const config = this.runtime.config();
        if (!r.window.confirm(`将完整 PDF 上传至 ${address(config.oxrBaseURL)} 进行解析？已提交的远端任务可能无法取消。`)) return;
        if (this.runtime.config().oxrBaseURL !== config.oxrBaseURL) throw new Error("上传地址已经改变，请重新检查并确认。");
        if (valid()) await r.service.parse({ consent: true });
      }).then(ok => { if (ok && r.state.pageCount) return this._preview(r); });
    }
    _translate(r) {
      return this._action(r, async valid => {
        const config = this.runtime.config(), source = r.el.source.value;
        if (config.provider !== "deepseek") throw new Error("请在现有翻译服务设置中选择 DeepSeek，未发送任何内容。");
        const changed = this._changed(r, config);
        const plan = modules.FulltextMarkdown.createPlan?.(source);
        const references = plan ? `\n已识别并保留 ${plan.referenceCount} 条参考文献。若遗漏，请先将参考文献节标题改为 ## References 再确认。` : "";
        if (r.state.translated && !changed) return;
        const reset = r.state.approvedHash && changed ? "\n原文或配置已改变，确认会重置旧检查点及译文。" : "\n未改变的原文与配置会保留已有检查点。";
        if (!r.window.confirm(`确认 Markdown 并向 DeepSeek 发送正文？\n地址：${address(config.endpoint)}\n模型：${String(config.model || "未配置")}\n每段会产生翻译和独立校对请求；格式失败可能重试并产生费用。全部通过后自动生成并保存独立中文 PDF 附件。${references}${reset}`)) return;
        if (!valid()) return;
        const unchanged = () => {
          if (configKey(this.runtime.config()) !== configKey(config) || r.el.source.value !== source) {
            throw new Error("原文或 DeepSeek 配置已在确认期间改变，未开始翻译；请重新检查并确认检查点。");
          }
        };
        unchanged();
        await r.service.confirm(source);
        if (!valid()) return;
        unchanged();
        r.dirty = false;
        await r.service.translate({ consent: true });
        if (valid() && r.service.snapshot().translated) await r.service.finish(r.window);
      });
    }
    async _pause(r) {
      if (!this._current(r) || r.stopping) return;
      r.stopping = true; ++r.opSerial; ++r.previewSerial; this._controls(r);
      try {
        await r.service.pause(); await r.action; await r.service.pause();
      } catch (error) { this._error(r, error); }
      finally { if (this._current(r)) { r.pending = false; r.stopping = false; this._state(r, r.service.snapshot()); } }
    }
    async _preview(r) {
      if (!this._current(r) || !r.service || this._active(r)) return;
      const id = ++r.previewSerial, doc = r.document;
      r.el.image.removeAttribute("src"); r.el.image.hidden = true; r.el["preview-error"].textContent = "正在本地生成预览…";
      this._controls(r);
      try {
        const result = await r.service.preview(r.page, Boolean(r.el.original.checked));
        if (!this._current(r) || r.document !== doc || id !== r.previewSerial) return;
        if (typeof result.dataURI !== "string" || !/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/u.test(result.dataURI) || result.dataURI.length > 45 * 1024 * 1024) throw new Error("本地预览图片无效。");
        r.el.image.setAttribute("src", result.dataURI); r.el.image.hidden = false;
        r.page = result.page; r.pages = result.pageCount; r.el["preview-error"].textContent = ""; this._controls(r);
      } catch (error) {
        if (this._current(r) && r.document === doc && id === r.previewSerial) r.el["preview-error"].textContent = safeError(error);
      }
    }
    _render(r) {
      if (!this._current(r)) return;
      try {
        modules.FulltextMarkdown.renderMarkdown(r.document, r.el.rendered, !r.dirty && r.state.translated ? r.state.translated : r.el.source.value);
        r.el.source.hidden = true; r.el.rendered.hidden = false;
      } catch (error) { this._error(r, error); }
    }
    _close(r) {
      if (r.closing) return r.closing;
      r.closed = true; ++r.opSerial; ++r.previewSerial; r.resolveClosed();
      for (const cleanup of r.cleanups.splice(0)) { try { cleanup?.(); } catch (_) {} }
      r.el?.image.removeAttribute("src"); r.el?.rendered.replaceChildren();
      r.closing = (async () => {
        // A factory may still be loading local state. Never clear the runtime's shared service.
        try { await r.ready; } catch (_) {}
        await r.service?.pause(); await r.action; await r.service?.pause();
        if (r.service) await this.runtime.release?.(r.service);
        r.window?.close();
        if (r.slot.current === r) r.slot.current = null;
      })();
      return r.closing;
    }
    async closeForWindow(owner) {
      const slot = this.windows.get(owner); if (!slot) return;
      slot.gone = true;
      for (const cleanup of slot.cleanups.splice(0)) cleanup();
      if (slot.current) await this._close(slot.current);
      await slot.queue;
      if (this.windows.get(owner) === slot) this.windows.delete(owner);
    }
    shutdown() {
      if (!this.shutdownPromise) {
        this.stopped = true;
        this.shutdownPromise = Promise.all([...this.windows.keys()].map(owner => this.closeForWindow(owner)));
      }
      return this.shutdownPromise;
    }
  }
  modules.FulltextUI = { FulltextUI };
  if (typeof module !== "undefined" && module.exports) module.exports = modules.FulltextUI;
})(typeof globalThis !== "undefined" ? globalThis : this);
