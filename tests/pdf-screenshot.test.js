"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Constants = require("../plugin/content/constants.js");
const {
  PDFScreenshotError,
  TARGET_ZOTERO_VERSION,
  normalizePDFRect,
  normalizeScreenshotLocation,
  normalizeScreenshotCapture,
  normalizeStoredScreenshot,
  screenshotReferenceFromStored,
  inspectPNGBytes,
  bytesToBase64,
  calculateRenderScale,
  selectionIntersections,
  renderPageCrop,
  resolveTargetContext,
  pageDescriptors
} = require("../plugin/content/pdf-screenshot.js");

function pngBytes(width = 40, height = 20) {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52], 8);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function location(overrides = {}) {
  return {
    coordinateSystem: "pdf-points",
    pageIndex: 2,
    pageNumber: 3,
    pageLabel: "iii",
    rect: [10.125, 20.5, 30.75, 40.875],
    pixelSize: { width: 40, height: 20 },
    pageRotation: 90,
    renderScale: 4,
    ...overrides
  };
}

test("screenshot normalization keeps only reproducible PDF positions and bounded PNG metadata", () => {
  const normalized = normalizeScreenshotLocation(location());
  assert.deepEqual(normalized, location());
  assert.equal(normalizeScreenshotLocation(location({ coordinateSystem: "screen-pixels" })), null);
  assert.equal(normalizeScreenshotLocation(location({ pageRotation: 45 })), null);
  assert.equal(normalizeScreenshotLocation(location({
    pixelSize: { width: Constants.PDF_SCREENSHOT_MAX_EDGE + 1, height: 1 }
  })), null);

  const capture = normalizeScreenshotCapture({
    source: "source.pdf",
    mimeType: "image/png",
    data: pngBytes(),
    location: location()
  });
  assert.equal(capture.byteSize, 24);
  assert.equal(capture.width, 40);
  assert.equal(capture.location.pageIndex, 2);
  assert.equal(normalizeScreenshotCapture({
    source: "source.pdf",
    mimeType: "image/png",
    data: pngBytes(41, 20),
    location: location()
  }), null);

  const stored = normalizeStoredScreenshot({
    ...capture,
    id: "shot-safe_1",
    fileName: "capture-shot-safe_1.png",
    localURI: "file:///private/session/capture-shot-safe_1.png"
  });
  assert.equal(stored.id, "shot-safe_1");
  assert.equal(screenshotReferenceFromStored(stored).localURI, undefined);
  assert.equal(screenshotReferenceFromStored(stored).fileName, undefined);
  assert.equal(normalizeStoredScreenshot({
    ...stored,
    fileName: "../capture-shot-safe_1.png"
  }), null);
});

test("PDF rectangles are read by index without invoking realm-owned callbacks", () => {
  const rect = [30, 40, 10, 20];
  rect.every = () => {
    throw new Error("Permission denied to pass object to privileged code");
  };
  assert.deepEqual(normalizePDFRect(rect), [10, 20, 30, 40]);
});

test("PNG inspection validates the signature and IHDR length before trusting dimensions", () => {
  assert.deepEqual(inspectPNGBytes(pngBytes(12, 34)), {
    bytes: pngBytes(12, 34),
    width: 12,
    height: 34
  });
  const wrongSignature = pngBytes();
  wrongSignature[1] = 0;
  assert.equal(inspectPNGBytes(wrongSignature), null);
  const wrongIHDRLength = pngBytes();
  wrongIHDRLength[11] = 12;
  assert.equal(inspectPNGBytes(wrongIHDRLength), null);
});

test("base64 encoding remains correct across browser-sized chunks", () => {
  const bytes = Uint8Array.from({ length: 0x7ffe + 7 }, (_value, index) => index % 251);
  assert.equal(bytesToBase64(bytes), Buffer.from(bytes).toString("base64"));
});

test("adaptive render scale honors edge, pixel, and viewer canvas limits", () => {
  assert.equal(calculateRenderScale(100, 200), 4);
  assert.equal(calculateRenderScale(2000, 1000), 2.048);
  assert.equal(calculateRenderScale(1000, 1000, { maxCanvasPixels: 4_000_000 }), 2);
  assert.equal(calculateRenderScale(0, 100), 0);
});

test("a cross-page rectangle becomes ordered page crops while page gaps are excluded", () => {
  const pages = [
    { pageIndex: 0, left: 0, top: 0, width: 100, height: 100 },
    { pageIndex: 1, left: 0, top: 120, width: 100, height: 100 },
    { pageIndex: 2, left: 10, top: 240, width: 80, height: 100 }
  ];
  const intersections = selectionIntersections([20, 50, 70, 290], pages);
  assert.deepEqual(intersections.map(({ page, rect }) => [page.pageIndex, rect]), [
    [0, [20, 50, 70, 100]],
    [1, [20, 120, 70, 220]],
    [2, [20, 240, 70, 290]]
  ]);
});

test("page discovery never passes privileged callbacks into the PDF.js pages array", () => {
  const pages = [{
    viewport: { width: 600, height: 800, rotation: 0 },
    div: {
      getBoundingClientRect() {
        return { left: 110, top: 220 };
      }
    }
  }];
  pages.flatMap = () => {
    throw new Error("Permission denied to pass object to privileged code");
  };
  const result = pageDescriptors({
    container: {
      scrollLeft: 12,
      scrollTop: 34,
      getBoundingClientRect() {
        return { left: 10, top: 20 };
      }
    },
    pdfViewer: { _pages: pages },
    pageLabels: ["A-1"]
  });
  assert.deepEqual(result.map(({ pageView: _pageView, ...page }) => page), [{
    pageIndex: 0,
    pageLabel: "A-1",
    pageRotation: 0,
    left: 112,
    top: 234,
    width: 600,
    height: 800
  }]);
});

test("clean crop rendering uses the PDF page renderer and records exact output geometry", async () => {
  let renderInput;
  let canvas;
  const document = {
    createElement(name) {
      assert.equal(name, "canvas");
      canvas = {
        width: 0,
        height: 0,
        style: {},
        getContext() {
          return {
            fillStyle: "",
            fillRect() {}
          };
        },
        toDataURL() {
          return `data:image/png;base64,${Buffer.from(pngBytes(this.width, this.height)).toString("base64")}`;
        }
      };
      return canvas;
    }
  };
  const pdfPage = {
    rotate: 0,
    view: [0, 0, 100, 200],
    getViewport({ scale, rotation, offsetX = 0, offsetY = 0 }) {
      return {
        width: 100 * scale,
        height: 200 * scale,
        rotation,
        offsetX,
        offsetY,
        convertToViewportPoint(x, y) {
          return [x * scale, y * scale];
        }
      };
    },
    render(input) {
      renderInput = input;
      return { promise: Promise.resolve(), cancel() {} };
    }
  };

  const capture = await renderPageCrop({
    pdfPage,
    pageView: { viewport: { rotation: 0 } },
    pdfRect: [10, 20, 20, 30],
    pageIndex: 4,
    pageLabel: "5",
    document
  });
  assert.equal(renderInput.background, "#ffffff");
  assert.equal(renderInput.viewport.offsetX, -40);
  assert.equal(renderInput.viewport.offsetY, -80);
  assert.deepEqual(capture.location, {
    coordinateSystem: "pdf-points",
    pageIndex: 4,
    pageNumber: 5,
    pageLabel: "5",
    rect: [10, 20, 20, 30],
    pixelSize: { width: 40, height: 40 },
    pageRotation: 0,
    renderScale: 4
  });
  assert.equal(canvas.width, 0, "canvas backing memory is released after encoding");
  assert.equal(canvas.height, 0);
});

test("clean crop unwraps PDFPageProxy and creates options in the PDF.js realm", async () => {
  class RealmObject {}
  const optionObjects = [];
  const document = {
    defaultView: { Object: RealmObject },
    createElement() {
      return {
        width: 0,
        height: 0,
        style: {},
        getContext() {
          return { fillStyle: "", fillRect() {} };
        },
        toDataURL() {
          return `data:image/png;base64,${Buffer.from(pngBytes(this.width, this.height)).toString("base64")}`;
        }
      };
    }
  };
  const rawPage = {
    rotate: 0,
    getViewport(options) {
      assert.ok(options instanceof RealmObject);
      optionObjects.push(options);
      const { scale, rotation, offsetX = 0, offsetY = 0 } = options;
      return {
        width: 100 * scale,
        height: 200 * scale,
        rotation,
        offsetX,
        offsetY,
        convertToViewportPoint(x, y) {
          return [x * scale, y * scale];
        }
      };
    },
    render(options) {
      assert.ok(options instanceof RealmObject);
      optionObjects.push(options);
      return { promise: Promise.resolve(), cancel() {} };
    }
  };
  const xrayPage = {
    wrappedJSObject: rawPage,
    getViewport: undefined,
    render: undefined
  };

  const capture = await renderPageCrop({
    pdfPage: xrayPage,
    pageView: { viewport: { rotation: 0 } },
    pdfRect: [10, 20, 20, 30],
    pageIndex: 0,
    pageLabel: "1",
    document
  });
  assert.equal(capture.width, 40);
  assert.equal(capture.height, 40);
  assert.equal(optionObjects.length, 4);
  assert.equal(optionObjects.at(-1).background, "#ffffff");
});

test("the private Reader bridge is exact-version gated and fails closed", () => {
  const container = {};
  const innerDocument = {
    createElement() {},
    getElementById(id) { return id === "viewerContainer" ? container : null; }
  };
  const contextDocument = {
    defaultView: {
      _reader: {
        _type: "pdf",
        _state: { pageLabels: ["i"] },
        _lastView: {
          _iframeWindow: {
            document: innerDocument,
            PDFViewerApplication: {
              pdfViewer: { _pages: [] },
              pdfDocument: { getPage() {} }
            }
          }
        }
      }
    }
  };
  assert.equal(resolveTargetContext(contextDocument, {
    zoteroVersion: TARGET_ZOTERO_VERSION
  }).container, container);
  assert.throws(
    () => resolveTargetContext(contextDocument, { zoteroVersion: "9.0.7" }),
    (error) => error instanceof PDFScreenshotError && error.code === "SCREENSHOT_BRIDGE_UNAVAILABLE"
  );
  assert.throws(
    () => resolveTargetContext({}, { zoteroVersion: TARGET_ZOTERO_VERSION }),
    { code: "SCREENSHOT_BRIDGE_UNAVAILABLE" }
  );
});
