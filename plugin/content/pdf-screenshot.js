(function (global) {
  "use strict";

  const modules = global.SmartPaperTranslatorModules = global.SmartPaperTranslatorModules || {};
  const Constants = modules.Constants || (
    typeof require === "function" ? require("./constants.js") : null
  );

  const PNG_SIGNATURE = Object.freeze([137, 80, 78, 71, 13, 10, 26, 10]);
  const TARGET_ZOTERO_VERSION = Constants.PDF_SCREENSHOT_TARGET_ZOTERO_VERSION;
  const MIN_SELECTION_PIXELS = 3;
  const EDGE_SCROLL_ZONE = 52;
  const EDGE_SCROLL_MAX_STEP = 26;

  class PDFScreenshotError extends Error {
    constructor(code, message, details) {
      super(message);
      this.name = "PDFScreenshotError";
      this.code = code;
      this.details = details;
    }
  }

  function finiteNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
  }

  function safePositiveInteger(value) {
    return Number.isSafeInteger(value) && value > 0;
  }

  function normalizeRotation(value) {
    if (!finiteNumber(value)) return null;
    const normalized = ((Math.round(value) % 360) + 360) % 360;
    return [0, 90, 180, 270].includes(normalized) ? normalized : null;
  }

  function normalizeRect(value) {
    if (!Array.isArray(value) || value.length !== 4) return null;
    // `value` can be an Xray-wrapped PDF.js array. Calling its realm-owned
    // `.every()` with a privileged callback is rejected by Gecko, so read the
    // four scalar values directly instead of passing code across compartments.
    if (
      !finiteNumber(value[0]) || !finiteNumber(value[1]) ||
      !finiteNumber(value[2]) || !finiteNumber(value[3])
    ) return null;
    const left = Math.min(value[0], value[2]);
    const top = Math.min(value[1], value[3]);
    const right = Math.max(value[0], value[2]);
    const bottom = Math.max(value[1], value[3]);
    if (!(right > left) || !(bottom > top)) return null;
    return [left, top, right, bottom];
  }

  function normalizePDFRect(value) {
    return normalizeRect(value);
  }

  function normalizePixelSize(value) {
    const width = Number(value?.width);
    const height = Number(value?.height);
    if (!safePositiveInteger(width) || !safePositiveInteger(height)) return null;
    if (width > Constants.PDF_SCREENSHOT_MAX_EDGE || height > Constants.PDF_SCREENSHOT_MAX_EDGE) {
      return null;
    }
    if (width * height > Constants.PDF_SCREENSHOT_MAX_PIXELS) return null;
    return { width, height };
  }

  function normalizeScreenshotLocation(value) {
    if (!value || value.coordinateSystem !== "pdf-points") return null;
    const pageIndex = Number(value.pageIndex);
    const rect = normalizePDFRect(value.rect);
    const pixelSize = normalizePixelSize(value.pixelSize);
    const pageRotation = normalizeRotation(value.pageRotation);
    if (!Number.isSafeInteger(pageIndex) || pageIndex < 0 || !rect || !pixelSize) return null;
    if (pageRotation == null) return null;
    const pageLabel = String(value.pageLabel || "")
      .replace(/[\u0000-\u001f\u007f]/gu, "")
      .trim()
      .slice(0, 80);
    const renderScale = Number(value.renderScale);
    if (!finiteNumber(renderScale) || renderScale <= 0 || renderScale > 16) return null;
    return {
      coordinateSystem: "pdf-points",
      pageIndex,
      pageNumber: pageIndex + 1,
      pageLabel: pageLabel || null,
      rect,
      pixelSize,
      pageRotation,
      renderScale
    };
  }

  function normalizeScreenshotID(value) {
    const id = String(value || "").trim();
    return /^[0-9A-Za-z][0-9A-Za-z._-]{0,119}$/u.test(id) ? id : null;
  }

  function normalizeScreenshotReference(value) {
    const id = normalizeScreenshotID(value?.id);
    const location = normalizeScreenshotLocation(value?.location);
    const byteSize = Number(value?.byteSize);
    if (!id || !location || value?.source !== "source.pdf" || value?.mimeType !== "image/png") {
      return null;
    }
    if (!safePositiveInteger(byteSize) || byteSize > Constants.PDF_SCREENSHOT_MAX_BYTES) return null;
    return {
      schemaVersion: Constants.PDF_SCREENSHOT_SCHEMA_VERSION,
      id,
      source: "source.pdf",
      mimeType: "image/png",
      byteSize,
      width: location.pixelSize.width,
      height: location.pixelSize.height,
      location
    };
  }

  function normalizeStoredScreenshot(value) {
    const reference = normalizeScreenshotReference(value);
    const fileName = String(value?.fileName || "").trim();
    if (!reference || !/^capture-[0-9A-Za-z][0-9A-Za-z._-]{0,119}\.png$/u.test(fileName)) {
      return null;
    }
    const result = { ...reference, fileName };
    const localURI = String(value?.localURI || "").trim();
    if (localURI) {
      if (localURI.length > 8192 || !/^file:\/\/\/[^\r\n]+$/iu.test(localURI)) return null;
      result.localURI = localURI;
    }
    return result;
  }

  function screenshotReferenceFromStored(value) {
    const normalized = normalizeStoredScreenshot(value);
    if (!normalized) return null;
    const { fileName: _fileName, localURI: _localURI, ...reference } = normalized;
    return reference;
  }

  function screenshotContextKey(value) {
    const normalized = normalizeScreenshotReference(value) || normalizeStoredScreenshot(value);
    return normalized ? normalized.id : null;
  }

  function uint32(bytes, offset) {
    return (
      bytes[offset] * 0x1000000 +
      bytes[offset + 1] * 0x10000 +
      bytes[offset + 2] * 0x100 +
      bytes[offset + 3]
    );
  }

  function inspectPNGBytes(value) {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value || []);
    if (bytes.length < 24 || !PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) {
      return null;
    }
    if (
      bytes[8] !== 0 || bytes[9] !== 0 || bytes[10] !== 0 || bytes[11] !== 13 ||
      bytes[12] !== 73 || bytes[13] !== 72 || bytes[14] !== 68 || bytes[15] !== 82
    ) return null;
    const width = uint32(bytes, 16);
    const height = uint32(bytes, 20);
    if (!safePositiveInteger(width) || !safePositiveInteger(height)) return null;
    return { bytes, width, height };
  }

  function normalizeScreenshotCapture(value) {
    const inspected = inspectPNGBytes(value?.data);
    const location = normalizeScreenshotLocation(value?.location);
    if (!inspected || !location || value?.mimeType !== "image/png") return null;
    if (inspected.bytes.length > Constants.PDF_SCREENSHOT_MAX_BYTES) return null;
    if (
      inspected.width !== location.pixelSize.width ||
      inspected.height !== location.pixelSize.height
    ) return null;
    return {
      schemaVersion: Constants.PDF_SCREENSHOT_SCHEMA_VERSION,
      source: "source.pdf",
      mimeType: "image/png",
      data: inspected.bytes,
      byteSize: inspected.bytes.length,
      width: inspected.width,
      height: inspected.height,
      location
    };
  }

  function bytesToBase64(value) {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value || []);
    if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
    const encode = global.btoa;
    if (typeof encode !== "function") {
      throw new PDFScreenshotError("SCREENSHOT_BASE64", "当前运行时无法编码截图");
    }
    // Keep every independently encoded chunk divisible by three so padding can
    // only appear at the end of the complete base64 value.
    const chunkSize = 0x7ffe;
    const chunks = [];
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      const chunk = bytes.subarray(offset, Math.min(bytes.length, offset + chunkSize));
      let binary = "";
      for (let index = 0; index < chunk.length; index++) {
        binary += String.fromCharCode(chunk[index]);
      }
      chunks.push(encode(binary));
    }
    return chunks.join("");
  }

  function dataURLToBytes(value) {
    const match = String(value || "").match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/u);
    if (!match) throw new PDFScreenshotError("SCREENSHOT_PNG_ENCODE", "PDF 截图编码结果无效");
    if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(match[1], "base64"));
    const decode = global.atob;
    if (typeof decode !== "function") {
      throw new PDFScreenshotError("SCREENSHOT_PNG_ENCODE", "当前运行时无法读取 PDF 截图");
    }
    const binary = decode(match[1]);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  async function blobToBytes(blob) {
    if (typeof blob?.arrayBuffer === "function") {
      return new Uint8Array(await blob.arrayBuffer());
    }
    const Reader = global.FileReader;
    if (typeof Reader !== "function") {
      throw new PDFScreenshotError("SCREENSHOT_PNG_ENCODE", "当前运行时无法读取 PDF 截图");
    }
    return new Promise((resolve, reject) => {
      const reader = new Reader();
      reader.addEventListener("load", () => resolve(new Uint8Array(reader.result)));
      reader.addEventListener("error", () => reject(
        new PDFScreenshotError("SCREENSHOT_PNG_ENCODE", "读取 PDF 截图失败")
      ));
      reader.readAsArrayBuffer(blob);
    });
  }

  async function canvasToPNGBytes(canvas) {
    if (typeof canvas?.toBlob === "function") {
      const blob = await new Promise((resolve, reject) => {
        canvas.toBlob((value) => {
          if (value) resolve(value);
          else reject(new PDFScreenshotError("SCREENSHOT_PNG_ENCODE", "PDF 截图编码失败"));
        }, "image/png");
      });
      return blobToBytes(blob);
    }
    if (typeof canvas?.toDataURL === "function") {
      return dataURLToBytes(canvas.toDataURL("image/png", 1));
    }
    throw new PDFScreenshotError("SCREENSHOT_PNG_ENCODE", "当前页面不支持 PNG 截图编码");
  }

  function calculateRenderScale(widthAtOne, heightAtOne, options = {}) {
    const width = Number(widthAtOne);
    const height = Number(heightAtOne);
    if (!(width > 0) || !(height > 0)) return 0;
    const maxScale = Number(options.maxScale || Constants.PDF_SCREENSHOT_MAX_SCALE);
    const maxEdge = Number(options.maxEdge || Constants.PDF_SCREENSHOT_MAX_EDGE);
    const maxPixels = Number(options.maxPixels || Constants.PDF_SCREENSHOT_MAX_PIXELS);
    const viewerPixels = Number(options.maxCanvasPixels);
    let scale = maxScale;
    scale = Math.min(scale, maxEdge / Math.max(width, height));
    scale = Math.min(scale, Math.sqrt(maxPixels / (width * height)));
    if (finiteNumber(viewerPixels) && viewerPixels > 0) {
      scale = Math.min(scale, Math.sqrt(viewerPixels / (width * height)));
    }
    if (!finiteNumber(scale) || scale <= 0) return 0;
    return Math.min(maxScale, scale);
  }

  function intersectRect(left, right) {
    const first = normalizeRect(left);
    const second = normalizeRect(right);
    if (!first || !second) return null;
    const intersection = [
      Math.max(first[0], second[0]),
      Math.max(first[1], second[1]),
      Math.min(first[2], second[2]),
      Math.min(first[3], second[3])
    ];
    return intersection[2] > intersection[0] && intersection[3] > intersection[1]
      ? intersection
      : null;
  }

  function selectionIntersections(selectionRect, pages) {
    const selection = normalizeRect(selectionRect);
    if (!selection || !Array.isArray(pages)) return [];
    return pages.flatMap((page) => {
      const pageRect = normalizeRect([
        Number(page.left),
        Number(page.top),
        Number(page.left) + Number(page.width),
        Number(page.top) + Number(page.height)
      ]);
      const intersection = intersectRect(selection, pageRect);
      if (!pageRect || !intersection) return [];
      return [{ page, rect: intersection }];
    }).sort((left, right) => left.page.pageIndex - right.page.pageIndex);
  }

  function unwrapPDFObject(value) {
    return value?.wrappedJSObject || value;
  }

  function createRealmOptions(win, values) {
    let options = {};
    try {
      if (typeof win?.Object === "function") options = new win.Object();
    }
    catch (_error) {}
    for (const [key, value] of Object.entries(values || {})) options[key] = value;
    return options;
  }

  function cropViewportRect(pdfPage, pdfRect, scale, rotation, realmWindow = null) {
    const page = unwrapPDFObject(pdfPage);
    const viewport = page.getViewport(createRealmOptions(realmWindow, { scale, rotation }));
    const first = viewport.convertToViewportPoint(pdfRect[0], pdfRect[1]);
    const second = viewport.convertToViewportPoint(pdfRect[2], pdfRect[3]);
    return {
      viewport,
      rect: normalizeRect([first[0], first[1], second[0], second[1]])
    };
  }

  function resetCanvas(canvas) {
    try {
      canvas.width = 0;
      canvas.height = 0;
    }
    catch (_error) {}
  }

  async function renderPageCrop({
    pdfPage,
    pageView,
    pdfRect,
    pageIndex,
    pageLabel,
    document,
    maxCanvasPixels,
    setRenderTask,
    isCancelled
  }) {
    const page = unwrapPDFObject(pdfPage);
    const realmWindow = document?.defaultView || null;
    const rotation = normalizeRotation(pageView?.viewport?.rotation ?? page?.rotate ?? 0);
    if (rotation == null || !page?.getViewport || !page?.render || !document?.createElement) {
      throw new PDFScreenshotError(
        "SCREENSHOT_RENDER_UNAVAILABLE",
        `Zotero ${TARGET_ZOTERO_VERSION} 的 PDF 原页渲染能力不可用`
      );
    }
    const normalizedPDFRect = normalizePDFRect(pdfRect);
    if (!normalizedPDFRect) {
      throw new PDFScreenshotError("SCREENSHOT_LOCATION", "截图的 PDF 坐标无效");
    }
    const unit = cropViewportRect(page, normalizedPDFRect, 1, rotation, realmWindow).rect;
    if (!unit) throw new PDFScreenshotError("SCREENSHOT_LOCATION", "截图区域为空");
    let scale = calculateRenderScale(unit[2] - unit[0], unit[3] - unit[1], {
      maxCanvasPixels
    });
    if (!(scale > 0)) throw new PDFScreenshotError("SCREENSHOT_SIZE", "截图区域无法安全渲染");

    let lastResult = null;
    for (let attempt = 0; attempt < 8; attempt++) {
      if (isCancelled?.()) throw new PDFScreenshotError("SCREENSHOT_CANCELLED", "已取消截图");
      const crop = cropViewportRect(page, normalizedPDFRect, scale, rotation, realmWindow);
      const cropRect = crop.rect;
      if (!cropRect) throw new PDFScreenshotError("SCREENSHOT_LOCATION", "截图区域为空");
      const width = Math.max(1, Math.ceil(cropRect[2] - cropRect[0]));
      const height = Math.max(1, Math.ceil(cropRect[3] - cropRect[1]));
      if (
        width > Constants.PDF_SCREENSHOT_MAX_EDGE ||
        height > Constants.PDF_SCREENSHOT_MAX_EDGE ||
        width * height > Constants.PDF_SCREENSHOT_MAX_PIXELS
      ) {
        throw new PDFScreenshotError("SCREENSHOT_SIZE", "截图像素尺寸超过安全上限");
      }
      const viewport = page.getViewport(createRealmOptions(realmWindow, {
        scale,
        rotation,
        offsetX: -cropRect[0],
        offsetY: -cropRect[1]
      }));
      const canvas = document.createElement("canvas");
      const context = canvas.getContext?.("2d", { alpha: false });
      if (!context) {
        resetCanvas(canvas);
        throw new PDFScreenshotError("SCREENSHOT_CANVAS", "无法创建 PDF 截图画布");
      }
      canvas.width = width;
      canvas.height = height;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, width, height);
      context.skipBlender = true;
      let task = null;
      try {
        task = page.render(createRealmOptions(realmWindow, {
          canvasContext: context,
          viewport,
          background: "#ffffff"
        }));
        setRenderTask?.(task);
        await task.promise;
        const data = await canvasToPNGBytes(canvas);
        const inspected = inspectPNGBytes(data);
        if (!inspected || inspected.width !== width || inspected.height !== height) {
          throw new PDFScreenshotError("SCREENSHOT_PNG_SIGNATURE", "PDF 截图 PNG 校验失败");
        }
        lastResult = { data: inspected.bytes, width, height, scale };
      }
      finally {
        setRenderTask?.(null);
        resetCanvas(canvas);
      }
      if (lastResult.data.length <= Constants.PDF_SCREENSHOT_MAX_BYTES) break;
      const ratio = Math.sqrt(Constants.PDF_SCREENSHOT_MAX_BYTES / lastResult.data.length) * 0.94;
      const nextScale = scale * Math.max(0.2, Math.min(0.88, ratio));
      if (!(nextScale > 0) || Math.ceil(nextScale * (unit[2] - unit[0])) === lastResult.width) {
        break;
      }
      scale = nextScale;
      lastResult = null;
    }
    if (!lastResult || lastResult.data.length > Constants.PDF_SCREENSHOT_MAX_BYTES) {
      throw new PDFScreenshotError("SCREENSHOT_BYTES", "截图压缩后仍超过 12 MiB 安全上限");
    }
    return {
      schemaVersion: Constants.PDF_SCREENSHOT_SCHEMA_VERSION,
      source: "source.pdf",
      mimeType: "image/png",
      data: lastResult.data,
      byteSize: lastResult.data.length,
      width: lastResult.width,
      height: lastResult.height,
      location: {
        coordinateSystem: "pdf-points",
        pageIndex,
        pageNumber: pageIndex + 1,
        pageLabel: String(pageLabel || "").trim() || null,
        rect: normalizedPDFRect,
        pixelSize: { width: lastResult.width, height: lastResult.height },
        pageRotation: rotation,
        renderScale: lastResult.scale
      }
    };
  }

  function resolveTargetContext(doc, {
    zoteroVersion = global.Zotero?.version
  } = {}) {
    const readerApp = doc?.defaultView?._reader;
    const view = readerApp?._lastView;
    const iframeWindow = view?._iframeWindow;
    const application = iframeWindow?.PDFViewerApplication;
    const pdfViewer = application?.pdfViewer;
    const pdfDocument = application?.pdfDocument;
    const container = iframeWindow?.document?.getElementById?.("viewerContainer");
    if (
      String(zoteroVersion || "") !== TARGET_ZOTERO_VERSION ||
      readerApp?._type !== "pdf" || !view || !iframeWindow || !application ||
      !pdfViewer || !pdfDocument?.getPage || !Array.isArray(pdfViewer._pages) ||
      !container || !iframeWindow.document?.createElement
    ) {
      throw new PDFScreenshotError(
        "SCREENSHOT_BRIDGE_UNAVAILABLE",
        `当前页面不支持 Zotero ${TARGET_ZOTERO_VERSION} 原页截图；草稿未改变`
      );
    }
    return {
      readerApp,
      view,
      iframeWindow,
      document: iframeWindow.document,
      application,
      pdfViewer,
      pdfDocument,
      container,
      pageLabels: Array.isArray(readerApp._state?.pageLabels)
        ? readerApp._state.pageLabels.slice()
        : []
    };
  }

  function pageDescriptors(context) {
    const containerRect = context.container.getBoundingClientRect();
    const scrollLeft = Number(context.container.scrollLeft) || 0;
    const scrollTop = Number(context.container.scrollTop) || 0;
    const descriptors = [];
    const pages = context.pdfViewer._pages;
    // `_pages` belongs to the PDF.js content compartment in Zotero 9.0.6.
    // Invoking its `.flatMap()` with this privileged callback throws
    // "Permission denied to pass object to privileged code" on pointerdown.
    for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
      const pageView = pages[pageIndex];
      const pageRect = pageView?.div?.getBoundingClientRect?.();
      const width = Number(pageView?.viewport?.width);
      const height = Number(pageView?.viewport?.height);
      if (!pageRect || !(width > 0) || !(height > 0)) continue;
      descriptors.push({
        pageIndex,
        pageView,
        pageLabel: context.pageLabels[pageIndex] || String(pageIndex + 1),
        pageRotation: normalizeRotation(pageView.viewport.rotation) ?? 0,
        left: pageRect.left - containerRect.left + scrollLeft,
        top: pageRect.top - containerRect.top + scrollTop,
        width,
        height
      });
    }
    return descriptors;
  }

  function contentPoint(event, container) {
    const rect = container.getBoundingClientRect();
    return {
      x: Number(event.clientX) - rect.left + (Number(container.scrollLeft) || 0),
      y: Number(event.clientY) - rect.top + (Number(container.scrollTop) || 0)
    };
  }

  function selectionRect(start, end) {
    return normalizeRect([start.x, start.y, end.x, end.y]);
  }

  function pointOnPage(point, page) {
    return point.x >= page.left && point.x <= page.left + page.width &&
      point.y >= page.top && point.y <= page.top + page.height;
  }

  function requestFrame(win, callback) {
    if (typeof win?.requestAnimationFrame === "function") return win.requestAnimationFrame(callback);
    return global.setTimeout?.(callback, 16);
  }

  function cancelFrame(win, id) {
    if (id == null) return;
    if (typeof win?.cancelAnimationFrame === "function") win.cancelAnimationFrame(id);
    else global.clearTimeout?.(id);
  }

  class CaptureController {
    constructor(context, options = {}) {
      this.context = context;
      this.onProgress = options.onProgress;
      this.startPoint = null;
      this.currentPoint = null;
      this.lastClientPoint = null;
      this.pointerID = null;
      this.frameID = null;
      this.renderTask = null;
      this.settled = false;
      this.rendering = false;
      this.cleanups = [];
      this.selectionNodes = [];
      this.promise = new Promise((resolve, reject) => {
        this.resolve = resolve;
        this.reject = reject;
      });
    }

    run() {
      this._mount();
      return this.promise;
    }

    _mount() {
      const { document, iframeWindow, container } = this.context;
      const style = document.createElement("style");
      style.dataset.smartPaperTranslatorScreenshot = "true";
      style.textContent = [
        ".spt-pdf-capture{position:fixed;z-index:2147483000;overflow:hidden;cursor:crosshair;touch-action:none;user-select:none;background:rgba(31,41,55,.035);outline:2px solid rgba(64,114,229,.72);outline-offset:-2px}",
        ".spt-pdf-capture[data-state=rendering]{cursor:progress;background:rgba(15,23,42,.18)}",
        ".spt-pdf-capture-hint{position:absolute;z-index:3;top:12px;left:50%;max-width:calc(100% - 84px);transform:translateX(-50%);padding:7px 11px;border-radius:999px;background:rgba(20,24,31,.9);color:#fff;font:menu;font-size:12px;line-height:1.35;text-align:center;pointer-events:none;box-shadow:0 3px 14px rgba(0,0,0,.24)}",
        ".spt-pdf-capture-cancel{position:absolute;z-index:4;top:10px;right:10px;min-width:30px;min-height:30px;padding:4px 8px;border:1px solid rgba(255,255,255,.45);border-radius:7px;background:rgba(20,24,31,.9);color:#fff;font:menu;cursor:pointer}",
        ".spt-pdf-capture-selection{position:absolute;z-index:2;border:2px solid #4072e5;background:rgba(64,114,229,.17);box-shadow:0 0 0 1px rgba(255,255,255,.9) inset;pointer-events:none}",
        ".spt-pdf-capture-status{position:absolute;z-index:3;left:50%;bottom:14px;transform:translateX(-50%);padding:6px 10px;border-radius:7px;background:rgba(20,24,31,.88);color:#fff;font:menu;font-size:12px;pointer-events:none}"
      ].join("");
      (document.head || document.documentElement).append(style);
      const overlay = document.createElement("div");
      overlay.className = "spt-pdf-capture";
      overlay.dataset.state = "selecting";
      overlay.tabIndex = 0;
      overlay.setAttribute("role", "dialog");
      overlay.setAttribute("aria-modal", "true");
      overlay.setAttribute("aria-label", "在 PDF 原页中框选截图区域");
      const hint = document.createElement("div");
      hint.className = "spt-pdf-capture-hint";
      hint.textContent = "拖动框选论文区域；跨页会拆成多张原页图；按 Esc 取消";
      const cancel = document.createElement("button");
      cancel.className = "spt-pdf-capture-cancel";
      cancel.type = "button";
      cancel.textContent = "取消";
      cancel.setAttribute("aria-label", "取消 PDF 截图");
      const status = document.createElement("div");
      status.className = "spt-pdf-capture-status";
      status.hidden = true;
      status.setAttribute("role", "status");
      overlay.append(hint, cancel, status);
      (document.documentElement || document.body).append(overlay);
      this.style = style;
      this.overlay = overlay;
      this.hint = hint;
      this.cancelButton = cancel;
      this.status = status;
      this._syncBounds();

      const pointerDown = (event) => this._pointerDown(event);
      const pointerMove = (event) => this._pointerMove(event);
      const pointerUp = (event) => this._pointerUp(event);
      const pointerCancel = (event) => this._pointerCancel(event);
      const keyDown = (event) => {
        if (event.key !== "Escape") return;
        event.preventDefault?.();
        event.stopPropagation?.();
        this.cancel();
      };
      const scroll = () => this._drawSelection();
      const resize = () => {
        this._syncBounds();
        this._drawSelection();
      };
      const wheel = (event) => {
        if (this.rendering) return;
        event.preventDefault?.();
        container.scrollLeft += Number(event.deltaX) || 0;
        container.scrollTop += Number(event.deltaY) || 0;
        if (this.lastClientPoint && this.startPoint) {
          this.currentPoint = contentPoint(this.lastClientPoint, container);
          this._drawSelection();
        }
      };
      const cancelClick = (event) => {
        event.preventDefault?.();
        event.stopPropagation?.();
        this.cancel();
      };
      overlay.addEventListener("pointerdown", pointerDown);
      overlay.addEventListener("pointermove", pointerMove);
      overlay.addEventListener("pointerup", pointerUp);
      overlay.addEventListener("pointercancel", pointerCancel);
      overlay.addEventListener("wheel", wheel, { passive: false });
      cancel.addEventListener("click", cancelClick);
      document.addEventListener("keydown", keyDown, true);
      container.addEventListener("scroll", scroll);
      iframeWindow.addEventListener?.("resize", resize);
      this.cleanups.push(
        () => overlay.removeEventListener("pointerdown", pointerDown),
        () => overlay.removeEventListener("pointermove", pointerMove),
        () => overlay.removeEventListener("pointerup", pointerUp),
        () => overlay.removeEventListener("pointercancel", pointerCancel),
        () => overlay.removeEventListener("wheel", wheel, { passive: false }),
        () => cancel.removeEventListener("click", cancelClick),
        () => document.removeEventListener("keydown", keyDown, true),
        () => container.removeEventListener("scroll", scroll),
        () => iframeWindow.removeEventListener?.("resize", resize)
      );
      overlay.focus?.();
    }

    _syncBounds() {
      const rect = this.context.container.getBoundingClientRect();
      Object.assign(this.overlay.style, {
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${Math.max(0, this.context.container.clientWidth || rect.width)}px`,
        height: `${Math.max(0, this.context.container.clientHeight || rect.height)}px`
      });
    }

    _pointerDown(event) {
      if (this.rendering || this.pointerID != null || event.button !== 0) return;
      if (event.target === this.cancelButton || event.target?.closest?.(".spt-pdf-capture-cancel")) {
        return;
      }
      const point = contentPoint(event, this.context.container);
      if (!pageDescriptors(this.context).some((page) => pointOnPage(point, page))) {
        this._showStatus("请从 PDF 页面内部开始框选");
        return;
      }
      event.preventDefault?.();
      event.stopPropagation?.();
      this.pointerID = event.pointerId;
      this.startPoint = point;
      this.currentPoint = point;
      this.lastClientPoint = { clientX: event.clientX, clientY: event.clientY };
      this.overlay.setPointerCapture?.(event.pointerId);
      this._showStatus("拖动到目标区域后松开");
      this._drawSelection();
      this._scheduleAutoScroll();
    }

    _pointerMove(event) {
      if (this.rendering || event.pointerId !== this.pointerID) return;
      event.preventDefault?.();
      this.lastClientPoint = { clientX: event.clientX, clientY: event.clientY };
      this.currentPoint = contentPoint(event, this.context.container);
      this._drawSelection();
    }

    _pointerUp(event) {
      if (this.rendering || event.pointerId !== this.pointerID) return;
      event.preventDefault?.();
      event.stopPropagation?.();
      this.lastClientPoint = { clientX: event.clientX, clientY: event.clientY };
      this.currentPoint = contentPoint(event, this.context.container);
      this._releasePointer();
      void this._completeSelection();
    }

    _pointerCancel(event) {
      if (event.pointerId === this.pointerID) this.cancel();
    }

    _releasePointer() {
      const pointerID = this.pointerID;
      this.pointerID = null;
      cancelFrame(this.context.iframeWindow, this.frameID);
      this.frameID = null;
      try { this.overlay.releasePointerCapture?.(pointerID); }
      catch (_error) {}
    }

    _showStatus(value) {
      this.status.hidden = false;
      this.status.textContent = value;
      this.onProgress?.(value);
    }

    _drawSelection() {
      for (const node of this.selectionNodes.splice(0)) node.remove();
      if (!this.startPoint || !this.currentPoint) return;
      const rect = selectionRect(this.startPoint, this.currentPoint);
      if (!rect) return;
      const scrollLeft = Number(this.context.container.scrollLeft) || 0;
      const scrollTop = Number(this.context.container.scrollTop) || 0;
      for (const { rect: intersection } of selectionIntersections(rect, pageDescriptors(this.context))) {
        const node = this.context.document.createElement("div");
        node.className = "spt-pdf-capture-selection";
        Object.assign(node.style, {
          left: `${intersection[0] - scrollLeft}px`,
          top: `${intersection[1] - scrollTop}px`,
          width: `${intersection[2] - intersection[0]}px`,
          height: `${intersection[3] - intersection[1]}px`
        });
        this.overlay.append(node);
        this.selectionNodes.push(node);
      }
    }

    _scheduleAutoScroll() {
      cancelFrame(this.context.iframeWindow, this.frameID);
      const tick = () => {
        this.frameID = null;
        if (this.pointerID == null || !this.lastClientPoint || this.rendering) return;
        const containerRect = this.context.container.getBoundingClientRect();
        const x = this.lastClientPoint.clientX - containerRect.left;
        const y = this.lastClientPoint.clientY - containerRect.top;
        const width = this.context.container.clientWidth || containerRect.width;
        const height = this.context.container.clientHeight || containerRect.height;
        const edgeStep = (position, extent) => {
          if (position < EDGE_SCROLL_ZONE) {
            return -EDGE_SCROLL_MAX_STEP * (1 - Math.max(0, position) / EDGE_SCROLL_ZONE);
          }
          if (position > extent - EDGE_SCROLL_ZONE) {
            return EDGE_SCROLL_MAX_STEP * (
              1 - Math.max(0, extent - position) / EDGE_SCROLL_ZONE
            );
          }
          return 0;
        };
        const dx = edgeStep(x, width);
        const dy = edgeStep(y, height);
        if (dx || dy) {
          this.context.container.scrollLeft += dx;
          this.context.container.scrollTop += dy;
          this.currentPoint = contentPoint(this.lastClientPoint, this.context.container);
          this._drawSelection();
        }
        this.frameID = requestFrame(this.context.iframeWindow, tick);
      };
      this.frameID = requestFrame(this.context.iframeWindow, tick);
    }

    async _completeSelection() {
      const rect = selectionRect(this.startPoint, this.currentPoint);
      if (
        !rect || rect[2] - rect[0] < MIN_SELECTION_PIXELS ||
        rect[3] - rect[1] < MIN_SELECTION_PIXELS
      ) {
        this._showStatus("截图区域太小，请重新拖动框选");
        this.startPoint = null;
        this.currentPoint = null;
        this.lastClientPoint = null;
        this._drawSelection();
        return;
      }
      const intersections = selectionIntersections(rect, pageDescriptors(this.context));
      if (!intersections.length) {
        this._showStatus("框选区域没有覆盖 PDF 页面，请重新选择");
        return;
      }
      this.rendering = true;
      this.overlay.dataset.state = "rendering";
      this.hint.textContent = `正在从原 PDF 渲染 ${intersections.length} 张截图…`;
      this._showStatus(`正在渲染 1 / ${intersections.length}`);
      try {
        const captures = [];
        let totalBytes = 0;
        let totalPixels = 0;
        for (let index = 0; index < intersections.length; index++) {
          if (this.settled) throw new PDFScreenshotError("SCREENSHOT_CANCELLED", "已取消截图");
          const { page, rect: intersection } = intersections[index];
          this._showStatus(`正在渲染 ${index + 1} / ${intersections.length}`);
          const pageView = page.pageView;
          const pdfPage = unwrapPDFObject(
            await this.context.pdfDocument.getPage(page.pageIndex + 1)
          );
          const localRect = [
            intersection[0] - page.left,
            intersection[1] - page.top,
            intersection[2] - page.left,
            intersection[3] - page.top
          ];
          const first = pageView.viewport.convertToPdfPoint(localRect[0], localRect[1]);
          const second = pageView.viewport.convertToPdfPoint(localRect[2], localRect[3]);
          const requestedPDFRect = normalizePDFRect([
            first[0], first[1], second[0], second[1]
          ]);
          const pageBounds = normalizePDFRect(pdfPage.view);
          const pdfRect = intersectRect(requestedPDFRect, pageBounds);
          if (!pdfRect) {
            throw new PDFScreenshotError("SCREENSHOT_LOCATION", "截图坐标无法映射回 PDF 页面");
          }
          const capture = await renderPageCrop({
            pdfPage,
            pageView,
            pdfRect,
            pageIndex: page.pageIndex,
            pageLabel: page.pageLabel,
            document: this.context.document,
            maxCanvasPixels: this.context.pdfViewer.maxCanvasPixels,
            setRenderTask: (task) => { this.renderTask = task; },
            isCancelled: () => this.settled
          });
          totalBytes += capture.byteSize;
          totalPixels += capture.width * capture.height;
          if (
            totalBytes > Constants.PDF_SCREENSHOT_TURN_MAX_BYTES ||
            totalPixels > Constants.PDF_SCREENSHOT_TURN_MAX_PIXELS
          ) {
            throw new PDFScreenshotError(
              "SCREENSHOT_TURN_BUDGET",
              "跨页截图超过紧急资源保护（64 MiB 或 1.28 亿像素）；已有草稿未改变"
            );
          }
          captures.push(capture);
        }
        this._settle("resolve", captures);
      }
      catch (error) {
        if (error?.code === "SCREENSHOT_CANCELLED") this._settle("resolve", []);
        else this._settle("reject", error);
      }
    }

    cancel() {
      if (this.settled) return;
      try { this.renderTask?.cancel?.(); }
      catch (_error) {}
      this._settle("resolve", []);
    }

    _settle(kind, value) {
      if (this.settled) return;
      this.settled = true;
      this._releasePointer();
      for (const cleanup of this.cleanups.splice(0)) {
        try { cleanup(); }
        catch (_error) {}
      }
      for (const node of this.selectionNodes.splice(0)) node.remove();
      this.overlay?.remove();
      this.style?.remove();
      if (kind === "reject") this.reject(value);
      else this.resolve(value);
    }
  }

  class ZoteroPDFScreenshotBridge {
    constructor({ log } = {}) {
      this.log = log || (() => {});
      this.active = new Map();
    }

    canCapture({ doc } = {}) {
      try {
        resolveTargetContext(doc);
        return true;
      }
      catch (_error) {
        return false;
      }
    }

    isCapturing(doc) {
      return this.active.has(doc);
    }

    cancel(doc) {
      const controller = this.active.get(doc);
      if (!controller) return false;
      controller.cancel();
      return true;
    }

    async capture({ doc, onProgress } = {}) {
      if (this.active.has(doc)) {
        throw new PDFScreenshotError("SCREENSHOT_ACTIVE", "当前 Reader 已在截图模式中");
      }
      const context = resolveTargetContext(doc);
      const controller = new CaptureController(context, { onProgress });
      this.active.set(doc, controller);
      try {
        return await controller.run();
      }
      finally {
        if (this.active.get(doc) === controller) this.active.delete(doc);
      }
    }

    shutdown() {
      for (const controller of this.active.values()) controller.cancel();
      this.active.clear();
    }
  }

  const exported = {
    PDFScreenshotError,
    ZoteroPDFScreenshotBridge,
    TARGET_ZOTERO_VERSION,
    normalizePDFRect,
    normalizeScreenshotLocation,
    normalizeScreenshotReference,
    normalizeStoredScreenshot,
    screenshotReferenceFromStored,
    screenshotContextKey,
    inspectPNGBytes,
    normalizeScreenshotCapture,
    bytesToBase64,
    calculateRenderScale,
    intersectRect,
    selectionIntersections,
    cropViewportRect,
    renderPageCrop,
    resolveTargetContext,
    pageDescriptors
  };
  modules.PDFScreenshot = exported;
  if (typeof module !== "undefined" && module.exports) module.exports = exported;
})(typeof globalThis !== "undefined" ? globalThis : this);
