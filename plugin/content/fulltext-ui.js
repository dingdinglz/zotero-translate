(function (global) {
  "use strict";
  const modules = global.SmartPaperTranslatorModules = global.SmartPaperTranslatorModules || {};
  const URI = "chrome://smart-paper-translator/content/fulltext.xhtml";
  const CLOSED = Symbol("closed");
  const CONFIG_KEYS = ["provider", "endpoint", "model", "translationPrompt", "reviewPrompt"];
  const configKey = config => JSON.stringify(CONFIG_KEYS.map(key => config[key]));
  let serial = 0;
  const stages = { new: "尚未上传", parsing: "正在解析 PDF", review: "请核对识别结果", ready: "等待翻译", translating: "逐段翻译与校对", paused: "已暂停", translated: "翻译完成，尚未保存 PDF", exporting: "正在生成并保存 PDF", complete: "中文 PDF 已保存" };
  const parsePhases = { preparing: "正在准备 PDF", planning: "正在划分 PDF", parsing: "正在解析 PDF",
    assembling: "正在整理解析结果", complete: "解析完成", paused: "解析已暂停", failed: "解析失败" };
  const chunkStates = { pending: "待上传", uploading: "上传中", submitted: "已提交，等待状态", queuing: "排队中",
    processing: "解析中", complete: "解析完成", paused: "已暂停", failed: "失败" };
  function duration(ms) {
    const seconds = Math.floor(Math.max(0, ms || 0) / 1000);
    return `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
  }
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
        if (!old.closed && !slot.owner.confirm("暂停并保存当前任务，打开另一篇论文？未保存的单块编辑和段落修正将丢弃；已提交的远端解析任务可能继续。")) return false;
        await this._close(old);
        if (this.stopped || slot.gone || slot.owner.closed) return false;
      }
      let resolveClosed;
      const r = { slot, attachmentID, window: null, document: null, service: null, closed: false,
        cleanups: [], opSerial: 0, previewSerial: 0, pending: false, stopping: false,
        dirty: false, draftDirty: false, mode: "page", page: 1, pages: 0, state: {},
        imageSerial: 0, renderSerial: 0, blockNodes: [], blockCleanups: [], selected: null,
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
        if ((this._active(r) || r.dirty || r.draftDirty) && !win.confirm("暂停并关闭全文翻译？已保存原文与已确认进度将保留；未保存的单块编辑和段落修正将丢弃。已提交的 OXR 远端任务可能继续。")) return;
        void this._close(r).catch(error => win.alert?.(safeError(error)));
      }, r.cleanups);
      listen(win, "beforeunload", event => {
        if (top(event, win) && (this._active(r) || r.dirty || r.draftDirty) && !r.closed) {
          event.preventDefault(); event.returnValue = "关闭将暂停并保留已保存原文与已确认进度，但丢弃未保存的编辑。远端任务可能继续。";
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
      const uploadbar = node("div", "uploadbar");
      uploadbar.append(node("p", "destination"), button("parse", "上传 PDF 并解析", () => this._parse(r)));
      const progress = node("details", "parse-progress"), summary = node("summary", "parse-summary");
      progress.open = true; progress.hidden = true;
      summary.append(node("span", "parse-heading", "PDF 解析进度"), node("span", "parse-toggle", "收起"));
      progress.append(summary, node("p", "parse-note"), node("ol", "parse-list"));
      listen(progress, "toggle", () => {
        if (!this._current(r)) return;
        e["parse-toggle"].textContent = progress.open ? "收起" : "展开";
        if (progress.open) this._progress(r);
      }, r.cleanups);
      r.progressRows = [];
      r.cleanups.push(() => { global.clearTimeout(r.progressTimer); r.progressTimer = null; r.progressRows = []; });
      upload.append(uploadbar, progress);
      const columns = node("main", "columns"), left = node("section", "pdf"), right = node("section", "markdown");
      const pdfbar = node("div", "pdfbar");
      e.original = node("input", "original"); e.original.type = "checkbox";
      const label = node("label", null, "原始 PDF"); label.prepend?.(e.original);
      if (!e.original.parentNode) label.append(e.original);
      listen(e.original, "change", () => {
        if (!this._current(r) || this._active(r) || !this._discard(r)) { e.original.checked = !e.original.checked; return; }
        r.page = 1; r.mode = "page"; void this._preview(r);
      }, r.cleanups);
      pdfbar.append(label, button("previous", "上一页", () => this._navigate(r, r.page - 1)),
        node("span", "page", "尚无预览"), button("next", "下一页", () => this._navigate(r, r.page + 1)),
        button("reload", "加载预览", () => { if (this._discard(r)) { r.mode = "page"; void this._preview(r); } }));
      const imagebox = node("div", "imagebox");
      imagebox.append(node("img", "image")); e.image.alt = "当前 PDF 页的本地预览"; e.image.hidden = true;
      left.append(pdfbar, node("p", "preview-error"), imagebox);
      const mdbar = node("div", "mdbar");
      mdbar.append(node("h2", "md-title", "Markdown"), button("edit", "编辑一段", () => this._edit(r)),
        button("full", "预览全文", () => this._mode(r, "full")),
        button("preview", "返回当前页", () => this._mode(r, "page")),
        button("save", "保存编辑", () => this._save(r)),
        button("cancel", "取消编辑", () => this._mode(r, "page")));
      e.source = node("textarea", "source"); e.source.setAttribute("aria-label", "选中块的 Markdown 源码"); e.source.spellcheck = false;
      listen(e.source, "input", () => {
        if (r.mode !== "edit" || this._active(r)) return;
        r.dirty = e.source.value !== r.editing?.source; this._controls(r);
      }, r.cleanups);
      e.source.hidden = true;
      e.rendered = node("div", "rendered");
      const mdStatus = node("p", "md-status", "加载左侧预览，或选择当前页/全文原文预览。"); mdStatus.setAttribute("role", "status");
      const images = node("div", "image-statusbar");
      images.append(node("span", "image-status"), button("retry-images", "重试图片", () => this._render(r)));
      e["image-status"].setAttribute("role", "status"); e["retry-images"].hidden = true;
      right.append(mdbar, node("p", "md-note"), mdStatus, images, e.source, e.rendered);
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
        node("p", "notice", "打开不上传 PDF、不调用模型；原文预览会自动下载并缓存远程图片（仅公网 HTTP/HTTPS）。翻译共用 DeepSeek 配置。中文 PDF 重新排版且批注独立，原 PDF 保留。关闭会暂停；已提交的远端解析可能继续。"));
      listen(r.window, "focus", () => this._controls(r), r.cleanups);
      this._controls(r);
    }
    _active(r) { return Boolean(r.pending || r.stopping || r.state.busy); }
    _changed(r, config) {
      const old = r.state.config;
      return Boolean(r.state.sourceChanged || (old && configKey(old) !== configKey(config)));
    }
    _state(r, state) {
      const sourceChanged = r.state.source !== state.source || r.state.documentRevision !== state.documentRevision;
      if (sourceChanged || (!r.state.busy && state.busy)) this._cancelImages(r);
      r.state = state;
      if (r.mode === "edit" && r.editing?.revision !== state.documentRevision) {
        r.el["md-status"].textContent = "原文版本已改变，未保存草稿已保留；请复制需要的修改，取消后重新选择当前块。";
      }
      if (!r.draftDirty && r.el.draft.value !== (state.draft || "")) r.el.draft.value = state.draft || "";
      r.el.current.textContent = state.currentSource || "";
      r.progressReceivedAt = Date.now();
      this._progress(r);
      if (!r.localError) r.el.error.textContent = safeError(state.error || "");
      r.pages = r.pages || state.pageCount || 0;
      this._controls(r);
      if (sourceChanged && r.mode !== "edit" && !this._active(r)) this._render(r);
    }
    _progressStatus(r) {
      const s = r.state, p = s.parseProgress;
      const parsing = s.stage === "parsing" && s.busy && p && !["complete", "failed", "paused"].includes(p.phase);
      const elapsed = p ? duration(p.elapsedMS + (parsing ? Math.max(0, Date.now() - r.progressReceivedAt) : 0)) : "";
      const count = p?.chunks?.length || 0;
      const completed = p?.completed ?? (p?.chunks?.filter(c => c.status === "complete").length || 0);
      const countText = count && p.phase !== "planning" ? `已完成 ${completed} / ${count} 块` : (parsePhases[p?.phase] || "正在准备 PDF");
      if (s.stage === "parsing" || (p && s.stage === "paused" && !s.approvedHash)) {
        r.el.status.textContent = `${parsePhases[p?.phase] || "正在准备 PDF"}${count && p.phase !== "planning" ? ` · ${countText}` : ""}${p ? ` · 已耗时 ${elapsed}` : ""}`;
      } else {
        r.el.status.textContent = `${stages[s.stage] || "本地任务"}${s.total > 0 ? ` · ${s.completed || 0} / ${s.total} 段` : ""}`;
      }
      if (p) r.el["parse-heading"].textContent = `PDF 解析进度 · ${countText}${p.pageCount ? ` · 共 ${p.pageCount} 页` : ""} · 已耗时 ${elapsed}`;
      if (parsing && !r.progressTimer) {
        r.progressTimer = global.setTimeout(() => {
          r.progressTimer = null;
          if (this._current(r)) this._progressStatus(r);
        }, 1000);
      } else if (!parsing && r.progressTimer) {
        global.clearTimeout(r.progressTimer); r.progressTimer = null;
      }
    }
    _progress(r) {
      const p = r.state.parseProgress, e = r.el;
      e["parse-progress"].hidden = !p;
      this._progressStatus(r);
      if (!p) { e["parse-list"].replaceChildren(); r.progressRows = []; return; }
      const notes = {
        preparing: "正在检查本地 PDF 并启动解析工具，尚未获得分块信息。",
        planning: "正在按实际页数与文件体积规划上传块；未提交的块不会显示为远端排队。",
        parsing: "按顺序上传和解析。正在等待解析服务返回结果；耗时不代表完成百分比。",
        assembling: "所有分块已解析，正在本地整理 Markdown 与版面 PDF，请稍候。",
        complete: "解析结果已就绪，请核对 Markdown。可随时展开或收起此列表。",
        paused: "本地任务已暂停，已完成的解析缓存保留；远端已提交任务可能继续。",
        failed: "任务未完成，请查看下方错误提示；已完成的解析缓存保留。"
      };
      e["parse-note"].textContent = (notes[p.phase] || "") + " 灰色节点表示未收到该阶段状态。";
      if (!e["parse-progress"].open) return;
      const chunks = p.chunks || [];
      if (r.progressRows.length > chunks.length || r.progressRows.some((row, i) => row.start !== chunks[i]?.start || row.end !== chunks[i]?.end)) {
        e["parse-list"].replaceChildren(); r.progressRows = [];
      }
      const node = (tag, text, cls) => {
        const n = r.document.createElementNS("http://www.w3.org/1999/xhtml", tag);
        if (text) n.textContent = text;
        if (cls) n.className = cls;
        return n;
      };
      chunks.forEach((chunk, index) => {
        let row = r.progressRows[index];
        if (!row) {
          const item = node("li", "", "spt-parse-row");
          const range = node("span", `第 ${chunk.start}–${chunk.end} 页`, "spt-parse-range");
          const timeline = node("span", "", "spt-parse-timeline");
          timeline.setAttribute("aria-hidden", "true");
          const steps = ["排队中", "解析中", "解析完成"].map(label => node("span", label, "spt-parse-step"));
          timeline.append(...steps);
          const status = node("span", "", "spt-parse-state");
          item.append(range, timeline, status); e["parse-list"].append(item);
          row = { start: chunk.start, end: chunk.end, item, status, steps }; r.progressRows.push(row);
        }
        const observed = chunk.observed || [chunk.status];
        const value = JSON.stringify([chunk.status, observed]);
        if (row.value === value) return;
        row.value = value;
        row.status.textContent = chunkStates[chunk.status] || "等待状态";
        row.item.setAttribute("data-state", chunk.status);
        row.steps.forEach((step, i) => {
          const stage = ["queuing", "processing", "complete"][i];
          const seen = observed.includes(stage);
          step.setAttribute("data-stage", !seen ? "waiting" : stage === "complete" ? "done" : chunk.status === stage ? "active" : "observed");
          step.setAttribute("title", seen ? `已收到${chunkStates[stage]}状态` : "未收到此阶段状态");
        });
      });
    }
    _controls(r) {
      if (!r.el || !this._current(r)) return;
      const e = r.el, s = r.state, busy = this._active(r), ready = Boolean(r.service);
      let config, changed = Boolean(s.sourceChanged);
      try { config = this.runtime.config(); changed = this._changed(r, config); e.destination.textContent = `解析会上传完整 PDF 至：${address(config.oxrBaseURL)}`; }
      catch (error) { changed = true; e.destination.textContent = safeError(error); }
      e.parse.disabled = !ready || busy || Boolean(s.importIntent && !s.chineseAttachmentID);
      e.parse.textContent = s.pageCount ? "重新上传并解析" : "上传 PDF 并解析";
      e.confirm.disabled = !ready || busy || !s.pageCount || !s.source?.trim() || r.dirty || r.mode === "edit" || r.draftDirty || Boolean(s.documentError) || (Boolean(s.translated) && !changed);
      e.source.readOnly = e.source.disabled = !ready || busy;
      e.pause.disabled = !ready || r.stopping || !busy;
      e.finish.disabled = !ready || busy || !s.translated || Boolean(s.chineseAttachmentID) || Boolean(s.importIntent) || changed || r.dirty || r.mode === "edit" || Boolean(s.documentError);
      e.export.disabled = !ready || busy || !s.translated || changed || r.dirty || r.mode === "edit" || Boolean(s.documentError);
      e.zh.disabled = e.en.disabled = !ready || busy || !s.chineseAttachmentID;
      e.repair.hidden = !s.currentID || busy || !s.error;
      e.draft.readOnly = e.draft.disabled = busy; e["save-draft"].disabled = busy || !ready || !s.currentID || !r.draftDirty;
      e.original.disabled = e.reload.disabled = !ready || busy;
      e.previous.disabled = !ready || busy || r.page <= 1;
      e.next.disabled = !ready || busy || r.page >= r.pages;
      e.preview.disabled = e.full.disabled = !ready || busy || !s.pageCount;
      const blocked = Boolean(s.documentError || (!s.editingReady && s.canEnableEditing === false) || (s.importIntent && !s.chineseAttachmentID));
      e.edit.disabled = !ready || busy || blocked || r.mode !== "page" || r.previewPending || r.previewInvalid || !r.selected ||
        r.selected.revision !== s.documentRevision;
      e.save.disabled = !ready || busy || blocked || r.mode !== "edit" || !r.dirty || r.editing?.revision !== s.documentRevision;
      e.cancel.disabled = !ready || busy;
      e.save.hidden = e.cancel.hidden = r.mode !== "edit";
      e.edit.hidden = r.mode !== "page";
      e.source.hidden = r.mode !== "edit"; e.rendered.hidden = r.mode === "edit";
      e["retry-images"].disabled = !ready || busy || r.mode === "edit" || r.previewPending;
      e["md-title"].textContent = r.mode === "full" ? "Markdown · 全文原文预览" :
        r.mode === "edit" ? `Markdown · 第 ${r.page} 页单块编辑` : `Markdown · 第 ${r.page} 页`;
      e["md-note"].textContent = s.documentError ? safeError(s.documentError) : r.mode === "edit"
        ? "仅编辑选中块；保存进入待译稿，不会发送模型请求。修改后须重新确认翻译。"
        : s.editingReady ? "统一逐页原文稿（含已保存编辑），排版可能与 OXR 全文不同。当前页可点击或用键盘选择一块，再点“编辑一段”；全文仅供预览。"
        : !s.pageCount ? "上传并解析后可核对原文、选择单块编辑或预览全文。"
        : s.canEnableEditing === false ? "逐页识别信息不完整，无法启用编辑；请明确确认后重新上传并解析。现有旧稿和译文仍保留。"
        : "旧任务：当前页是独立识别预览，全文显示旧原文稿。编辑前需确认迁移：替换旧手改稿、保留备份，并重新确认翻译。";
      e.page.textContent = r.pages ? `第 ${r.page} / ${r.pages} 页` : "尚无预览";
      for (const entry of r.blockNodes) entry.node.setAttribute("aria-disabled", String(busy || blocked));
    }
    _error(r, error) { if (this._current(r)) { r.localError = true; r.el.error.textContent = safeError(error); } }
    _action(r, fn, after) {
      if (!this._current(r) || !r.service || this._active(r)) return Promise.resolve(false);
      const id = ++r.opSerial, doc = r.document;
      this._cancelImages(r);
      ++r.previewSerial;
      if (r.previewPending) { r.previewPending = false; r.previewInvalid = true; }
      r.pending = true; r.localError = false; r.el.error.textContent = ""; this._controls(r);
      const valid = () => this._current(r) && r.document === doc && id === r.opSerial;
      const action = Promise.resolve().then(() => valid() ? fn(valid) : undefined).then(() => {
        if (valid()) { after?.(); this._state(r, r.service.snapshot()); } return valid();
      }).catch(error => { if (valid()) this._error(r, error); return false; }).finally(() => {
        if (valid()) {
          r.pending = false;
          if (r.mode !== "edit" && (r.renderedSource !== r.state.source || r.renderedRevision !== r.state.documentRevision)) this._render(r);
          this._controls(r);
        }
      });
      r.action = action; return action;
    }
    _parse(r) {
      let parsed = false;
      return this._action(r, async valid => {
        const config = this.runtime.config(), replaceApproved = Boolean(r.state.approvedHash);
        if (!r.window.confirm(`将完整 PDF 上传至 ${address(config.oxrBaseURL)} 进行解析？仍按页数和体积分块，不额外逐页请求。已提交的远端任务可能无法取消。`)) return;
        if ((replaceApproved || r.state.pageCount || r.dirty || r.draftDirty) && !r.window.confirm(
          "重新解析会先归档已有确认稿的检查点；新解析成功后才切换，并需重新确认和翻译。失败保留旧任务；已有附件不会删除。未确认的单块编辑和未保存的段落修正将在成功后丢弃，是否继续？")) return;
        if (this.runtime.config().oxrBaseURL !== config.oxrBaseURL) throw new Error("上传地址已经改变，请重新检查并确认。");
        if (valid()) {
          ++r.previewSerial; r.previewPending = false; r.previewInvalid = true; this._clearBlocks(r);
          r.el.image.removeAttribute("src"); r.el.image.hidden = true; r.el.rendered.replaceChildren();
          r.el["md-status"].textContent = "正在重新解析，完成后加载对应页。";
          await r.service.parse({ consent: true, replaceApproved }); parsed = true;
        }
      }, () => {
        if (parsed) { r.dirty = false; r.draftDirty = false; r.editing = null; r.mode = "page"; r.page = 1; r.pages = r.service.snapshot().pageCount; }
      }).then(async ok => {
        if (!this._current(r)) return;
        if (!ok) r.el["md-status"].textContent = "解析未完成，旧任务已保留；可重新加载原有预览。";
        if (ok && parsed && r.state.pageCount) {
          await this._preview(r);
        }
      });
    }
    _translate(r) {
      if (r.mode === "edit" || r.dirty || r.draftDirty || r.state.documentError) return Promise.resolve(false);
      return this._action(r, async valid => {
        const config = this.runtime.config(), source = r.state.source;
        if (config.provider !== "deepseek") throw new Error("请在现有翻译服务设置中选择 DeepSeek，未发送任何内容。");
        const changed = this._changed(r, config);
        const plan = modules.FulltextMarkdown.createPlan?.(source);
        const references = plan ? `\n已识别并保留 ${plan.referenceCount} 条参考文献。若遗漏，请先将参考文献节标题改为 ## References 再确认。` : "";
        if (r.state.translated && !changed) return;
        const reset = r.state.approvedHash && changed ? "\n原文或配置已改变，确认会重置旧检查点及译文。" : "\n未改变的原文与配置会保留已有检查点。";
        if (!r.window.confirm(`确认 Markdown 并向 DeepSeek 发送正文？\n地址：${address(config.endpoint)}\n模型：${String(config.model || "未配置")}\n每段会产生翻译和独立校对请求；格式失败可能重试并产生费用。全部通过后自动生成并保存独立中文 PDF 附件。${references}${reset}`)) return;
        if (!valid()) return;
        const unchanged = () => {
          if (configKey(this.runtime.config()) !== configKey(config) || r.state.source !== source) {
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
      r.stopping = true; ++r.opSerial; ++r.previewSerial; this._cancelImages(r);
      if (r.previewPending) { r.previewPending = false; r.el["md-status"].textContent = "预览已暂停，请重新加载。"; }
      this._controls(r);
      try {
        await r.service.pause(); await r.action; await r.service.pause();
      } catch (error) { this._error(r, error); }
      finally { if (this._current(r)) { r.pending = false; r.stopping = false; this._state(r, r.service.snapshot()); } }
    }
    _discard(r) {
      if (!this._current(r) || this._active(r)) return false;
      if (r.dirty && !r.window.confirm("丢弃尚未保存的单块编辑？已保存的原文稿不变。")) return false;
      r.dirty = false; r.editing = null; return true;
    }
    _navigate(r, page) {
      if (!Number.isSafeInteger(page) || page < 1 || page > r.pages || !this._discard(r)) return;
      r.page = page; r.mode = "page"; void this._preview(r);
    }
    _mode(r, mode) {
      if (!this._discard(r)) return;
      r.mode = mode; this._render(r);
    }
    _clearBlocks(r) {
      ++r.renderSerial;
      for (const cleanup of r.blockCleanups.splice(0)) cleanup();
      r.blockNodes = []; r.selected = null;
    }
    _select(r, entry) {
      if (!this._current(r) || this._active(r) || r.mode !== "page" || r.previewPending || r.previewInvalid ||
          entry.serial !== r.renderSerial || entry.revision !== r.state.documentRevision) return;
      r.selected = entry;
      for (const item of r.blockNodes) item.node.setAttribute("aria-pressed", String(item === entry));
      r.el["md-status"].textContent = `${r.renderWarning || ""}已选第 ${r.blockNodes.indexOf(entry) + 1} 块（${entry.kind}），点击“编辑一段”修改。`;
      this._controls(r);
    }
    _block(r, node, block) {
      const exact = r.blocks[block.index];
      if (!exact || exact.index !== block.index || exact.start !== block.start || exact.end !== block.end || exact.source !== block.source) return; // Match exact metadata, never visual order or similar text.
      const entry = { ...exact, node, serial: r.renderSerial, revision: r.state.documentRevision, page: r.page };
      node.setAttribute("class", "spt-fulltext-block"); node.setAttribute("role", "button"); node.setAttribute("tabindex", "0");
      node.setAttribute("aria-label", `选择第 ${r.blockNodes.length + 1} 块（${block.kind}）`); node.setAttribute("aria-pressed", "false");
      listen(node, "click", () => this._select(r, entry), r.blockCleanups);
      listen(node, "keydown", event => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault(); this._select(r, entry);
      }, r.blockCleanups);
      r.blockNodes.push(entry);
    }
    async _edit(r) {
      if (!this._current(r) || this._active(r) || r.mode !== "page" || r.previewPending || r.previewInvalid || !r.selected ||
          r.state.documentError || (!r.state.editingReady && r.state.canEnableEditing === false) || (r.state.importIntent && !r.state.chineseAttachmentID)) return;
      const chosen = r.selected;
      if (chosen.serial !== r.renderSerial || chosen.revision !== r.state.documentRevision) return;
      if (!r.state.editingReady) {
        if (!r.window.confirm("启用统一逐页编辑稿？将用完整逐页识别结果替换旧全文稿（包括旧手改内容），排版可能不同。旧稿和检查点会保留备份，迁移后须重新确认翻译。缺少完整页映射时不会迁移。")) return;
        const ok = await this._action(r, () => r.service.enableEditing({ consent: true }));
        if (ok && this._current(r) && r.state.editingReady) {
          this._render(r); r.el["md-status"].textContent = "迁移已保存；请在当前稿重新选择块，再点击“编辑一段”。";
        }
        return; // No pre-migration selection may be written into a new revision.
      }
      this._cancelImages(r);
      r.editing = { page: chosen.page, index: chosen.index, revision: chosen.revision, source: chosen.source };
      r.el.source.value = chosen.source; r.dirty = false; r.mode = "edit";
      this._controls(r); r.el.source.focus?.();
    }
    _save(r) {
      const edit = r.editing;
      if (r.mode !== "edit" || !r.dirty || !edit || !r.state.editingReady ||
          edit.revision !== r.state.documentRevision || r.state.documentError || (r.state.importIntent && !r.state.chineseAttachmentID)) return Promise.resolve(false);
      const text = r.el.source.value;
      return this._action(r, () => r.service.editBlock({ page: edit.page, index: edit.index, revision: edit.revision, text }), () => {
        r.dirty = false; r.editing = null; r.mode = "page";
        r.renderedRevision = null; // Refresh even if an identical replacement kept the same revision.
      });
    }
    _cancelImages(r) {
      ++r.imageSerial;
      if (r.service) this.runtime.cancelImages?.(r.service);
      if (r.el?.["image-status"]) {
        if (r.imagesPending) {
          r.el["image-status"].textContent = "图片加载已暂停。";
          r.el["retry-images"].hidden = false;
        }
        r.imagesPending = 0;
      }
    }
    _remoteImages(r) {
      const id = r.imageSerial, doc = r.document, page = r.page, mode = r.mode,
        revision = r.state.documentRevision, source = r.state.source, request = r.previewSerial, jobs = new Map();
      let failed = 0, loaded = 0, limited = false;
      const valid = () => this._current(r) && r.document === doc && r.page === page && r.mode === mode &&
        r.imageSerial === id && r.state.documentRevision === revision && r.state.source === source &&
        r.previewSerial === request && (mode === "full" || (!r.previewPending && !r.previewInvalid)) && !this._active(r) && mode !== "edit";
      const status = () => {
        if (!valid()) return;
        r.el["image-status"].textContent = `${r.imagesPending ? `正在加载 ${r.imagesPending} 张图片。` : loaded ? `已加载 ${loaded} 张图片。` : ""}${failed ? "部分图片加载失败，已保留原文，可重试。" : ""}${limited ? "本次预览最多加载 128 个不同图片地址，超出部分保留原文。" : ""}`;
        r.el["retry-images"].hidden = !failed && !limited;
      };
      return (uri, commit) => {
        if (!valid()) return;
        if (!jobs.has(uri) && jobs.size >= 128) { limited = true; status(); return; }
        r.imagesPending++;
        if (!jobs.has(uri)) jobs.set(uri, Promise.resolve().then(() => {
          if (!valid()) return null;
          const cache = this.runtime.imageCacheFor?.(r.service);
          if (!cache) throw new Error("图片缓存不可用");
          return cache.resolve(uri, { isCurrent: valid });
        }));
        status();
        jobs.get(uri).then(data => {
          if (!valid()) return;
          if (!data) throw new Error("图片不可用");
          commit(data); loaded++;
        }).catch(() => { if (valid()) failed++; }) // Never expose an untrusted URL or remote response in errors.
          .finally(() => { if (valid()) { r.imagesPending--; status(); } });
      };
    }
    async _preview(r) {
      if (!this._current(r) || !r.service || this._active(r)) return;
      this._cancelImages(r); this._clearBlocks(r);
      const id = ++r.previewSerial, doc = r.document, requestedPage = r.page;
      r.previewPending = true; r.previewInvalid = true;
      r.el.image.removeAttribute("src"); r.el.image.hidden = true; r.el["preview-error"].textContent = "正在本地生成预览…";
      r.el.rendered.replaceChildren();
      if (r.el.source.hidden) r.el["md-status"].textContent = "正在加载对应页面…";
      this._controls(r);
      try {
        const result = await r.service.preview(requestedPage, Boolean(r.el.original.checked));
        if (!this._current(r) || r.document !== doc || id !== r.previewSerial) return;
        if (result.page !== requestedPage || !Number.isSafeInteger(result.pageCount) || result.pageCount < requestedPage ||
            (r.state.pageCount && result.pageCount !== r.state.pageCount)) throw new Error("本地预览页码与任务不一致。");
        if (typeof result.dataURI !== "string" || !/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/u.test(result.dataURI) || result.dataURI.length > 45 * 1024 * 1024) throw new Error("本地预览图片无效。");
        r.el.image.setAttribute("src", result.dataURI); r.el.image.hidden = false;
        r.previewPending = false; r.previewInvalid = false;
        r.page = result.page; r.pages = result.pageCount; r.el["preview-error"].textContent = ""; this._controls(r);
        if (r.mode === "page") this._render(r);
      } catch (error) {
        if (this._current(r) && r.document === doc && id === r.previewSerial) {
          r.previewPending = false; r.el["preview-error"].textContent = safeError(error);
          if (r.mode === "page") {
            r.el.rendered.replaceChildren(); r.el["md-status"].textContent = "左侧页面加载失败，未展示可能错位的内容。";
          }
        }
      }
    }
    _render(r) {
      if (!this._current(r) || this._active(r) || r.mode === "edit") return;
      this._cancelImages(r); this._clearBlocks(r);
      r.el.rendered.replaceChildren(); r.el.rendered.scrollTop = 0;
      r.el["image-status"].textContent = ""; r.el["retry-images"].hidden = true;
      r.renderedSource = r.state.source; r.renderedRevision = r.state.documentRevision;
      this._controls(r);
      if (!r.state.pageCount) { r.el["md-status"].textContent = "请先确认上传 PDF 并完成解析。"; return; }
      if (r.mode === "page" && r.previewPending) { r.el["md-status"].textContent = "正在加载对应页面…"; return; }
      if (r.mode === "page" && r.previewInvalid) { r.el["md-status"].textContent = "左侧页面加载失败或已失效，请重新加载预览。"; return; }
      let source;
      r.blocks = []; r.renderWarning = "";
      try {
        source = r.mode === "full" ? r.state.source : r.service.getPageMarkdown(r.page);
        if (source === null || source === undefined) {
          r.el["md-status"].textContent = r.state.documentError || r.state.pagePreviewError || "本页缺少完整逐页识别信息，无法准确预览，需要重新解析；不会自动上传。";
          return;
        }
        r.blocks = r.mode === "page" ? r.service.getPageBlocks(r.page) : [];
        r.el["md-status"].textContent = source.trim() ? "" : "本页无识别内容。";
        modules.FulltextMarkdown.renderMarkdown(r.document, r.el.rendered, source, {
          onBlock: r.mode === "page" ? (node, block) => this._block(r, node, block) : undefined,
          onRemoteImage: this._remoteImages(r)
        });
      } catch (error) {
        this._cancelImages(r); this._clearBlocks(r); r.el.rendered.replaceChildren();
        // Literal text only: malformed Markdown remains repairable, never active HTML.
        if (typeof source === "string") {
          for (const block of r.mode === "page" ? r.blocks || [] : [{ source }]) {
            const node = r.document.createElementNS("http://www.w3.org/1999/xhtml", "pre");
            node.textContent = block.source; r.el.rendered.append(node);
            if (r.mode === "page") this._block(r, node, block);
          }
        }
        if (!r.el.rendered.children.length && typeof source === "string") {
          const node = r.document.createElementNS("http://www.w3.org/1999/xhtml", "pre");
          node.textContent = source; r.el.rendered.append(node);
        }
        r.renderWarning = "无法安全排版，已显示原文文字；可选择块修复。";
        r.el["md-status"].textContent = r.renderWarning; this._error(r, error);
      }
      if (r.blockNodes.length) this._select(r, r.blockNodes[0]);
      this._controls(r);
    }
    _close(r) {
      if (r.closing) return r.closing;
      r.closed = true; ++r.opSerial; ++r.previewSerial; this._cancelImages(r); this._clearBlocks(r); r.resolveClosed();
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
