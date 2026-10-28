(function (global) {
  "use strict";
  const modules = global.SmartPaperTranslatorModules = global.SmartPaperTranslatorModules || {};
  const PREFIX = "extensions.smart-paper-translator.";
  const HELPERS = ["worker.py", "pdf_to_markdown.py", "layout_pdf.py", "requirements.txt"];
  const MAX_FILE = 256 * 1024 * 1024;
  const MAX_TEXT = 128 * 1024 * 1024;
  function validateOXRURL(value) {
    let url;
    try { url = new URL(String(value)); } catch (_) { throw new Error("OXR API 地址无效。"); }
    if (url.username || url.password || url.search || url.hash ||
        !(url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
      throw new Error("OXR 仅允许 HTTPS 或本机 HTTP 地址，不能携带用户名、密码、查询参数或片段。");
    }
    return url.href.replace(/\/+$/u, "");
  }
  function hashBytes(bytes) {
    const hash = global.Cc["@mozilla.org/security/hash;1"].createInstance(global.Ci.nsICryptoHash);
    hash.init(hash.SHA256); hash.update(bytes, bytes.length);
    return Array.from(hash.finish(false), c => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
  }
  function native(path) {
    const result = modules.ACP.toNativeAbsolutePath(path);
    if (!result) throw new Error("必须选择本机绝对文件路径。");
    return result;
  }
  function fileObject(path) {
    const file = global.Cc["@mozilla.org/file/local;1"].createInstance(global.Ci.nsIFile);
    file.initWithPath(native(path)); return file;
  }
  function checkPath(path, expected, allowMissing = false) {
    let file = fileObject(path); const leaf = file;
    while (file) {
      let symlink = false;
      try { symlink = file.isSymlink(); } catch (error) { if (file.exists()) throw error; }
      if (symlink) throw new Error("全文任务目录不允许软链接。");
      if (file.exists() && file.path !== leaf.path && !file.isDirectory()) throw new Error("全文任务父路径不是目录。");
      file = file.parent;
    }
    if (!leaf.exists()) { if (allowMissing) return; throw new Error("全文任务文件不存在。"); }
    if (expected === "directory" ? !leaf.isDirectory() : !leaf.isFile()) throw new Error("全文任务文件类型无效。");
  }
  async function boundedRead(path, max = MAX_TEXT) {
    checkPath(path, "regular");
    const stat = await global.IOUtils.stat(path);
    if (stat.size > max) throw new Error("全文任务文件超出资源上限。");
    const bytes = await global.IOUtils.read(path, { maxBytes: max + 1 });
    checkPath(path, "regular");
    if (bytes.length > max) throw new Error("全文任务文件超出资源上限。");
    return bytes;
  }
  async function directory(path) {
    checkPath(path, "directory", true);
    await global.IOUtils.makeDirectory(path, { ignoreExisting: true, createAncestors: true });
    checkPath(path, "directory"); return path;
  }
  function storeAt(root) {
    const pathFor = name => {
      if (!/^(?:state\.json|source\.md|approved(?:-[a-f0-9]{64})?\.md|translated\.md)$/u.test(name)) throw new Error("无效的全文任务文件名。");
      const path = global.PathUtils.join(root, name); checkPath(path, "regular", true); return path;
    };
    return {
      async readText(name) {
        const path = pathFor(name);
        if (!(await global.IOUtils.exists(path))) return null;
        return new TextDecoder("utf-8", { fatal: true }).decode(await boundedRead(path));
      },
      async readJSON(name) { const text = await this.readText(name); return text === null ? null : JSON.parse(text); },
      async writeText(name, text) {
        const bytes = new TextEncoder().encode(text);
        if (bytes.length > MAX_TEXT) throw new Error("全文任务数据过大，未覆盖已有文件。");
        const path = pathFor(name); const temporary = path + ".tmp";
        checkPath(temporary, "regular", true);
        await global.IOUtils.write(path, bytes, { tmpPath: temporary });
      },
      async writeJSON(name, value) { return this.writeText(name, JSON.stringify(value)); }
    };
  }
  async function collectProcess(process, { timeoutMS, registerCancel, timers = global }) {
    let stopped = false, reason = "";
    const stop = message => {
      if (stopped) return;
      stopped = true; reason = message;
      try { process.kill(0); } catch (_) {}
    };
    const unregister = registerCancel?.(() => stop("本地转换已暂停。"));
    const timer = timers.setTimeout(() => stop("本地转换超时，已停止；已提交的远端任务可能仍运行。"), timeoutMS);
    const read = async pipe => {
      let text = "";
      try {
        while (true) {
          const part = await pipe.readString(); if (!part) break;
          if (text.length + part.length > 65536) { stop("本地转换诊断输出超限。"); continue; }
          text += part;
        }
      } catch (_) { if (!stopped) stop("无法读取本地转换结果。"); }
      return text;
    };
    try {
      const [exit, stdout] = await Promise.all([process.wait(), read(process.stdout), read(process.stderr)]);
      if (reason) throw new Error(reason);
      let result;
      try { result = JSON.parse(stdout); } catch (_) { throw new Error("Python 未返回有效结果，请检查所选环境及依赖。"); }
      if (exit.exitCode !== 0 || result?.ok !== true) throw new Error(String(result?.error || "Python 转换失败，请检查依赖、PDF 和 API 地址。").slice(0, 500));
      return result;
    } finally { timers.clearTimeout(timer); unregister?.(); }
  }
  class FulltextRuntime {
    constructor({ rootURI, getPreference, apiClient, credentials }) {
      Object.assign(this, { rootURI, getPreference, apiClient, credentials });
      this.root = global.PathUtils.join(global.Zotero.DataDirectory.dir, "smart-paper-translator", "fulltext");
      this.processes = new Set(); this.services = new Map(); this.stopped = false; this.helperPromise = null; this.processFailure = false;
    }
    config() {
      const config = modules.Logic.getProviderConfig(this.getPreference);
      return { ...config, pythonPath: String(this.getPreference(PREFIX + "fulltextPythonPath") || "").trim(),
        oxrBaseURL: validateOXRURL(this.getPreference(PREFIX + "fulltextOXRBaseURL") || "https://free-oxr.somark.ai/api/v1"),
        translationPrompt: this.getPreference(PREFIX + "fulltextTranslationPrompt") || modules.FulltextService.DEFAULT_TRANSLATION_PROMPT,
        reviewPrompt: this.getPreference(PREFIX + "fulltextReviewPrompt") || modules.FulltextService.DEFAULT_REVIEW_PROMPT };
    }
    async helpers() {
      if (!this.helperPromise) this.helperPromise = (async () => {
        const root = await directory(global.PathUtils.join(this.root, "runtime-" + modules.Constants.VERSION));
        for (const name of HELPERS) {
          const text = await global.Zotero.File.getResourceAsync(this.rootURI + "content/fulltext-python/" + name);
          if (typeof text !== "string" || text.length > 1024 * 1024) throw new Error("插件 Python 资源无效。");
          const path = global.PathUtils.join(root, name);
          checkPath(path, "regular", true); checkPath(path + ".tmp", "regular", true);
          await global.IOUtils.writeUTF8(path, text, { tmpPath: path + ".tmp" });
        }
        return root;
      })().catch(error => { this.helperPromise = null; throw error; });
      return this.helperPromise;
    }
    async python(operation, request, { pythonPath, registerCancel } = {}) {
      if (this.stopped) throw new Error("插件已退出。");
      if (this.processFailure) throw new Error("旧 Python 进程未确认回收，请重启 Zotero 后重试。");
      const command = native(pythonPath || this.config().pythonPath);
      // A venv's Python is normally a symlink. Only plugin-owned output paths prohibit symlinks.
      if (!(await global.IOUtils.exists(command))) throw new Error("Python 路径不存在，请在设置中选择环境。");
      const root = await this.helpers();
      if (this.stopped) throw new Error("插件已退出。");
      const { Subprocess } = global.ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");
      const process = await Subprocess.call({ command, arguments: ["-I", global.PathUtils.join(root, "worker.py"), operation, JSON.stringify(request)],
        workdir: root, environmentAppend: true, environment: { PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1", PYTHONUNBUFFERED: "1" }, stderr: "pipe" });
      this.processes.add(process);
      try {
        if (this.stopped) { process.kill(0); await process.wait(); throw new Error("插件已退出。"); }
        return await collectProcess(process, { timeoutMS: operation === "convert" ? 2 * 60 * 60 * 1000 : 60000, registerCancel });
      } finally {
        try { await process.wait(); this.processes.delete(process); }
        catch (_) { this.processFailure = true; }
      }
    }
    async inspect(pythonPath) { return this.python("check", {}, { pythonPath }); }
    async attachment(id) {
      const item = await global.Zotero.Items.getAsync(id);
      if (!item || item.deleted || !item.isPDFAttachment() || !item.parentItemID) throw new Error("请选择普通论文条目下的 PDF 附件；独立 PDF 请先建立父条目。");
      const parent = await global.Zotero.Items.getAsync(item.parentItemID);
      if (!parent || parent.deleted || !parent.isRegularItem() || parent.libraryID !== item.libraryID) throw new Error("论文父条目不可用。");
      return { item, parent };
    }
    async mapping(id) {
      const path = global.PathUtils.join(this.root, `link-${Number(id)}.json`);
      if (!(await global.IOUtils.exists(path))) return null;
      const value = JSON.parse(new TextDecoder().decode(await boundedRead(path, 8192)));
      const { item } = await this.attachment(id);
      if (value.libraryID !== item.libraryID || ![value.sourceID, value.chineseID].includes(id) ||
          item.key !== (id === value.sourceID ? value.sourceKey : value.chineseKey) || item.parentItemID !== value.parentID) return null;
      const source = await this.attachment(value.sourceID);
      if (source.item.key !== value.sourceKey || source.item.parentItemID !== value.parentID) return null;
      return value;
    }
    async openVersion(id, language) {
      const map = await this.mapping(id);
      if (!map) throw new Error("这篇论文尚未生成中文版。");
      const target = language === "zh" ? map.chineseID : map.sourceID;
      const { item } = await this.attachment(target);
      if (item.key !== (language === "zh" ? map.chineseKey : map.sourceKey) || item.libraryID !== map.libraryID || item.parentItemID !== map.parentID) throw new Error("对应语言附件已改变或被删除。");
      if (!(await item.getFilePathAsync())) throw new Error("对应 PDF 尚未下载到本机。");
      await global.Zotero.Reader.open(target, undefined, { openInBackground: false });
    }
    async create(attachmentID) {
      if (this.stopped) throw new Error("插件已退出。");
      const mapping = await this.mapping(attachmentID);
      const id = mapping?.sourceID || attachmentID;
      if (this.services.has(id)) return this.services.get(id);
      const promise = this._create(id).catch(error => { this.services.delete(id); throw error; });
      this.services.set(id, promise); return promise;
    }
    async _create(id) {
      const { item, parent } = await this.attachment(id);
      const sourcePath = native(await item.getFilePathAsync());
      const bytes = await boundedRead(sourcePath, MAX_FILE);
      if (new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-") throw new Error("附件不是有效 PDF。");
      const digest = hashBytes(bytes);
      const identity = `${item.libraryID}-${item.key}-${digest}`;
      const taskRoot = await directory(global.PathUtils.join(this.root, "tasks", identity));
      const storage = storeAt(taskRoot);
      const verifySource = async () => {
        const current = await this.attachment(id);
        if (current.item.key !== item.key || current.item.libraryID !== item.libraryID || current.parent.id !== parent.id ||
          native(await current.item.getFilePathAsync()) !== sourcePath || hashBytes(await boundedRead(sourcePath, MAX_FILE)) !== digest) {
          throw new Error("原 PDF 或论文身份已经改变，请关闭窗口并重新打开任务。");
        }
        const library = global.Zotero.Libraries.get(item.libraryID);
        if (!library?.editable || library.filesEditable === false) throw new Error("当前文库不可写，不能保存中文附件。");
      };
      await verifySource();
      const previewRoot = await directory(global.PathUtils.join(taskRoot, "preview"));
      let previewQueue = Promise.resolve();
      const service = new modules.FulltextService.FulltextService({
        identity, storage, hash: text => hashBytes(new TextEncoder().encode(text)), verifySource,
        getConfig: () => this.config(),
        convert: options => this.python("convert", { sourcePath, outputDir: taskRoot, baseURL: validateOXRURL(options.baseURL) }, options),
        preview: options => {
          const task = previewQueue.catch(() => {}).then(async () => {
            if (!options.isCurrent()) throw new Error("预览已取消。");
            const path = options.original ? sourcePath : global.PathUtils.join(taskRoot, "layout.pdf");
            await boundedRead(path, MAX_FILE);
            const result = await this.python("preview", { sourcePath: path, outputDir: previewRoot, page: options.page }, { registerCancel: options.registerCancel });
            const png = await boundedRead(global.PathUtils.join(previewRoot, "preview.png"), 32 * 1024 * 1024);
            if (Array.from(png.slice(0, 8)).join(",") !== "137,80,78,71,13,10,26,10") throw new Error("PDF 预览图片无效。");
            let binary = "";
            for (let i = 0; i < png.length; i += 8192) binary += String.fromCharCode(...png.subarray(i, i + 8192));
            return { dataURI: "data:image/png;base64," + global.btoa(binary), page: result.page, pageCount: result.pageCount };
          });
          previewQueue = task; return task;
        },
        complete: async options => {
          const key = await this.credentials.get("deepseek");
          return this.apiClient.complete({ ...options, apiKey: key });
        },
        createPDF: (owner, markdown, registerCancel) => this.printPDF(owner, markdown, taskRoot, registerCancel),
        importPDF: async () => {
          await verifySource();
          const file = global.PathUtils.join(taskRoot, "translated.pdf"); await boundedRead(file, MAX_FILE);
          const chinese = await global.Zotero.Attachments.importFromFile({ file, parentItemID: parent.id,
            title: `${parent.getField("title") || "论文"} — 中文译文`, contentType: "application/pdf" });
          const link = { sourceID: id, sourceKey: item.key, chineseID: chinese.id, chineseKey: chinese.key, parentID: parent.id, libraryID: item.libraryID };
          for (const target of [id, chinese.id]) {
            const path = global.PathUtils.join(this.root, `link-${target}.json`);
            checkPath(path, "regular", true); checkPath(path + ".tmp", "regular", true);
            await global.IOUtils.writeJSON(path, link, { tmpPath: path + ".tmp" });
          }
          return chinese.id;
        },
        exportMarkdown: async (owner, markdown) => {
          const { FilePicker } = global.ChromeUtils.importESModule("chrome://zotero/content/modules/filePicker.mjs");
          const picker = new FilePicker(); picker.init(owner, "导出中文 Markdown", picker.modeSave);
          picker.defaultString = "translated.md"; picker.appendFilter("Markdown", "*.md");
          const result = await picker.show();
          if (owner.closed || ![picker.returnOK, picker.returnReplace].includes(result)) return false;
          const path = native(picker.file);
          if (path === sourcePath) throw new Error("不能覆盖原始 PDF。");
          checkPath(path, "regular", true); checkPath(path + ".spt-tmp", "regular", true);
          await global.IOUtils.writeUTF8(path, markdown, { tmpPath: path + ".spt-tmp" }); return true;
        }
      });
      service.attachmentID = id; service.title = parent.getField("title") || item.getField("title") || "论文全文翻译";
      await service.load();
      if (this.stopped) { await service.shutdown(); throw new Error("插件已退出。"); }
      return service;
    }
    async printPDF(owner, markdown, taskRoot, registerCancel) {
      if (owner.closed) throw new Error("确认窗口已经关闭。");
      const doc = owner.document.implementation.createHTMLDocument("中文译文");
      const meta = doc.createElement("meta"); meta.setAttribute("http-equiv", "Content-Security-Policy");
      meta.setAttribute("content", "default-src 'none'; script-src 'none'; connect-src 'none'; img-src data:; style-src 'unsafe-inline'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'");
      doc.head.append(meta);
      const style = doc.createElement("style"); style.textContent = modules.FulltextMarkdown.PRINT_CSS; doc.head.append(style);
      modules.FulltextMarkdown.renderMarkdown(doc, doc.body, markdown);
      const html = "<!doctype html>" + new owner.XMLSerializer().serializeToString(doc.documentElement);
      const frame = owner.document.createElementNS("http://www.w3.org/1999/xhtml", "iframe");
      frame.setAttribute("sandbox", ""); frame.setAttribute("aria-hidden", "true");
      frame.style.cssText = "position:fixed;left:-10000px;top:0;width:794px;height:1123px;border:0";
      const output = global.PathUtils.join(taskRoot, "translated.pdf");
      const temporary = global.PathUtils.join(taskRoot, "translated-print.pdf");
      checkPath(temporary, "regular", true); checkPath(output, "regular", true);
      let timer, cancelled = false, rejectCancellation;
      const cancellation = new Promise((_, reject) => { rejectCancellation = reject; });
      // Attach a rejection handler before registration, which may synchronously cancel.
      cancellation.catch(() => {});
      const unregister = registerCancel?.(() => {
        cancelled = true; frame.remove(); rejectCancellation(new Error("PDF 导出已暂停，Markdown 已保留。"));
      });
      const current = () => { if (cancelled || owner.closed) throw new Error("PDF 导出已暂停。"); };
      try {
        current();
        await Promise.race([cancellation, new Promise((resolve, reject) => {
          timer = global.setTimeout(() => reject(new Error("静态打印文档加载超时。")), 30000);
          frame.addEventListener("load", () => { if (frame.contentDocument?.URL === "about:srcdoc") resolve(); });
          frame.srcdoc = html; owner.document.documentElement.append(frame);
        })]);
        global.clearTimeout(timer); current();
        if (owner.closed || !frame.browsingContext?.print) throw new Error("当前 Zotero 不支持此安全 PDF 导出方式；Markdown 已保留。");
        await Promise.race([cancellation, frame.contentDocument?.fonts?.ready, new Promise((_, reject) => {
          timer = global.setTimeout(() => reject(new Error("中文字体加载超时。")), 30000);
        })]);
        global.clearTimeout(timer); current();
        const settings = global.Cc["@mozilla.org/gfx/printsettings-service;1"].getService(global.Ci.nsIPrintSettingsService).createNewPrintSettings();
        Object.assign(settings, { isInitializedFromPrinter: true, isInitializedFromPrefs: true,
          outputFormat: global.Ci.nsIPrintSettings.kOutputFormatPDF, outputDestination: global.Ci.nsIPrintSettings.kOutputDestinationFile,
          printerName: "", printSilent: true, toFileName: temporary,
          paperSizeUnit: global.Ci.nsIPrintSettings.kPaperSizeInches, paperWidth: 8.2677, paperHeight: 11.6929,
          marginTop: 0.55, marginBottom: 0.55, marginLeft: 0.55, marginRight: 0.55,
          unwriteableMarginTop: 0, unwriteableMarginBottom: 0, unwriteableMarginLeft: 0, unwriteableMarginRight: 0,
          printBGColors: true, printBGImages: true, scaling: 1, shrinkToFit: true,
          headerStrCenter: "", headerStrLeft: "", headerStrRight: "", footerStrCenter: "", footerStrLeft: "", footerStrRight: "" });
        await Promise.race([cancellation, frame.browsingContext.print(settings), new Promise((_, reject) => {
          timer = global.setTimeout(() => reject(new Error("PDF 导出超时，Markdown 已保留。")), 90000);
        })]);
        global.clearTimeout(timer); current();
        const pdf = await boundedRead(temporary, MAX_FILE);
        if (new TextDecoder().decode(pdf.slice(0, 5)) !== "%PDF-" || pdf.length < 100) throw new Error("导出的 PDF 无效。");
        const validationRoot = await directory(global.PathUtils.join(taskRoot, "pdf-check"));
        await this.python("preview", { sourcePath: temporary, outputDir: validationRoot, page: 1 }, { registerCancel });
        current(); await global.IOUtils.move(temporary, output, { noOverwrite: false });
      } finally { global.clearTimeout(timer); unregister?.(); frame.remove(); }
    }
    async shutdown() {
      this.stopped = true;
      for (const process of this.processes) { try { process.kill(0); } catch (_) {} }
      await Promise.allSettled([...this.services.values()].map(async promise => (await promise).shutdown()));
      await Promise.allSettled([...this.processes].map(process => process.wait()));
      this.services.clear();
    }
  }
  modules.FulltextRuntime = { FulltextRuntime, validateOXRURL, collectProcess, storeAt, checkPath };
  if (typeof module !== "undefined" && module.exports) module.exports = modules.FulltextRuntime;
})(typeof globalThis !== "undefined" ? globalThis : this);
