#!/usr/bin/env python3
"""Static validation for Smart Paper Translator source artifacts."""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from xml.etree import ElementTree


ROOT = Path(__file__).resolve().parents[1]
PLUGIN = ROOT / "plugin"


def main() -> None:
    manifest = json.loads((PLUGIN / "manifest.json").read_text(encoding="utf-8"))
    zotero = manifest["applications"]["zotero"]
    assert manifest["manifest_version"] == 2
    assert manifest["version"] == "0.1.28"
    assert zotero["id"] == "smart-paper-translator@zotero.local"
    assert zotero["strict_min_version"] == "9.0"
    assert zotero["strict_max_version"] == "9.0.*"
    assert zotero["update_url"].startswith("https://")

    ElementTree.parse(PLUGIN / "content" / "preferences.xhtml")
    xhtml = (PLUGIN / "content" / "preferences.xhtml").read_text(encoding="utf-8")
    assert "<!DOCTYPE" not in xhtml

    executable_paths = [
        path for path in sorted(PLUGIN.rglob("*.js")) if path.name != "prefs.js"
    ]
    executable = "\n".join(path.read_text(encoding="utf-8") for path in executable_paths)
    for forbidden in ("reader._window", "reader._iframeWindow"):
        assert forbidden not in executable, f"private reader API used: {forbidden}"
    for path in executable_paths:
        source = path.read_text(encoding="utf-8")
        if "._lastView" in source or "._iframeWindow" in source:
            assert path.name == "pdf-screenshot.js", f"unisolated Reader bridge: {path}"

    constants = (PLUGIN / "content" / "constants.js").read_text(encoding="utf-8")
    acp_client = (PLUGIN / "content" / "acp-client.js").read_text(encoding="utf-8")
    chat_cache = (PLUGIN / "content" / "chat-cache.js").read_text(encoding="utf-8")
    pdf_screenshot = (PLUGIN / "content" / "pdf-screenshot.js").read_text(encoding="utf-8")
    chat_ui = (PLUGIN / "content" / "codex-chat-ui.js").read_text(encoding="utf-8")
    math_renderer = (PLUGIN / "content" / "math-renderer.js").read_text(encoding="utf-8")
    mermaid_renderer = (PLUGIN / "content" / "mermaid-renderer.js").read_text(encoding="utf-8")
    bootstrap = (PLUGIN / "bootstrap.js").read_text(encoding="utf-8")
    assert 'ACP_PACKAGE_SPEC: "@agentclientprotocol/codex-acp@1.6.2"' in constants
    assert 'ACP_MODE: "agent"' in constants
    assert 'ACP_TOOL_IMAGES_DIRECTORY: "tool-images"' in constants
    assert 'ACP_SCREENSHOTS_DIRECTORY: "screenshots"' in constants
    assert 'PDF_SCREENSHOT_TARGET_ZOTERO_VERSION: "9.0.6"' in constants
    assert "PDF_SCREENSHOT_MAX_EDGE: 4096" in constants
    assert "PDF_SCREENSHOT_MAX_PIXELS: 16 * 1000 * 1000" in constants
    assert "PDF_SCREENSHOT_MAX_BYTES: 12 * 1024 * 1024" in constants
    assert "context.pdfViewer._pages.flatMap" not in pdf_screenshot
    assert "function unwrapPDFObject" in pdf_screenshot
    assert "function createRealmOptions" in pdf_screenshot
    assert "ACP_MAX_JSON_LINE_BYTES: 20 * 1024 * 1024" in constants
    assert "ACP_TOOL_IMAGE_MAX_BYTES: 25 * 1024 * 1024" in constants
    assert 'npm_config_offline: "true"' in acp_client
    assert 'INITIAL_AGENT_MODE: Constants.ACP_MODE' in acp_client
    codex_chat = (PLUGIN / "content" / "codex-chat.js").read_text(encoding="utf-8")
    assert 'this.acp.request("session/close"' in codex_chat
    assert 'this.acp.request("session/delete"' not in codex_chat
    assert "resolveToolImageSource" in codex_chat
    assert "detectToolImageFormat" in codex_chat
    assert "validateToolImageBytes" in codex_chat
    assert "ensureToolImageDirectory" in chat_cache
    assert "deleteToolImageDirectory" in chat_cache
    assert "ensureScreenshotDirectory" in chat_cache
    assert "deleteScreenshotDirectory" in chat_cache
    assert "PDF_SCREENSHOT_TARGET_ZOTERO_VERSION" in pdf_screenshot
    assert "view?._iframeWindow" in pdf_screenshot
    assert "PDFViewerApplication" in pdf_screenshot
    assert "pdfDocument.getPage" in pdf_screenshot
    assert "page.render(createRealmOptions" in pdf_screenshot
    assert "convertToPdfPoint" in pdf_screenshot
    assert "SCREENSHOT_BRIDGE_UNAVAILABLE" in pdf_screenshot
    assert "getDisplayMedia" not in pdf_screenshot
    assert "drawWindow" not in pdf_screenshot
    assert ".innerHTML =" not in pdf_screenshot
    assert 'type: "image"' in codex_chat
    assert "saveScreenshotDrafts" in codex_chat
    assert "MODEL_IMAGE_UNSUPPORTED" in codex_chat
    assert "随附截图像素" in codex_chat
    assert "spt-codex-screenshot-group" in chat_ui
    assert "deferImageLoad: true" in chat_ui
    assert "spt-codex-image-lightbox" in chat_ui
    assert 'purpose: "version", allowDownload: true' not in bootstrap
    assert ".innerHTML =" not in chat_ui
    assert ".innerHTML =" not in math_renderer
    assert ".innerHTML =" not in mermaid_renderer
    assert 'output: "mathml"' in math_renderer
    assert 'trust: false' in math_renderer
    assert 'maxExpand: 1000' in math_renderer
    assert 'maxSize: 20' in math_renderer
    assert '"content/vendor/katex/katex.min.js"' in bootstrap
    assert '"content/math-renderer.js"' in bootstrap
    assert '"content/mermaid-renderer.js"' in bootstrap
    assert '"content/vendor/mermaid/mermaid.min.js"' not in bootstrap
    assert bootstrap.index('"content/vendor/katex/katex.min.js"') < bootstrap.index(
        '"content/math-renderer.js"'
    ) < bootstrap.index('"content/codex-chat-ui.js"')
    assert bootstrap.index('"content/mermaid-renderer.js"') < bootstrap.index(
        '"content/codex-chat-ui.js"'
    )
    katex_runtime = PLUGIN / "content" / "vendor" / "katex" / "katex.min.js"
    assert hashlib.sha256(katex_runtime.read_bytes()).hexdigest() == (
        "2ec5916941ef4383e0314eaabcc712301b06001d9fb68e08d751d2bae5a27a1a"
    )
    katex_license = (
        PLUGIN / "content" / "vendor" / "katex" / "LICENSE.txt"
    ).read_text(encoding="utf-8")
    assert "The MIT License" in katex_license
    assert 'MERMAID_VERSION = "11.16.1"' in mermaid_renderer
    assert 'securityLevel: "strict"' in mermaid_renderer
    assert "htmlLabels: false" in mermaid_renderer
    assert "suppressErrorRendering: true" in mermaid_renderer
    assert "MAX_MERMAID_SOURCE_LENGTH = 20000" in mermaid_renderer
    assert "MAX_MERMAID_SVG_LENGTH = 2 * 1024 * 1024" in mermaid_renderer
    assert "MAX_MERMAID_IMAGE_EDGE = 4096" in mermaid_renderer
    assert 'data:image/svg+xml;charset=UTF-8' in mermaid_renderer
    assert "hasUnsafeResourceReference" in mermaid_renderer
    assert 'createElementNS(XHTML_NS, "iframe")' in mermaid_renderer
    assert '"当前 Zotero 窗口无法创建 Mermaid 隔离文档"' in mermaid_renderer
    assert '"filter", "fedropshadow"' in mermaid_renderer
    assert '"stddeviation", "flood-color", "flood-opacity"' in mermaid_renderer
    assert "content/vendor/mermaid/mermaid.min.js" in chat_ui
    assert "runtimeURI" in mermaid_renderer
    assert "Cu.Sandbox" in mermaid_renderer
    assert "sandboxPrototype: win" in mermaid_renderer
    assert "wantXrays: false" in mermaid_renderer
    assert "sandbox.window =" not in mermaid_renderer
    assert "sandbox.document =" not in mermaid_renderer
    assert "scriptloader?.loadSubScript" in mermaid_renderer
    assert ".nukeSandbox(" not in mermaid_renderer
    mermaid_runtime = PLUGIN / "content" / "vendor" / "mermaid" / "mermaid.min.js"
    assert hashlib.sha256(mermaid_runtime.read_bytes()).hexdigest() == (
        "18327bef70d96fb505fe7287d9f6a7362ebf07ff6576ddfaffb1a06f3e1a2954"
    )
    mermaid_license = (
        PLUGIN / "content" / "vendor" / "mermaid" / "LICENSE.txt"
    ).read_text(encoding="utf-8")
    assert "The MIT License" in mermaid_license
    assert "zotero.launchURL(url)" in chat_ui
    assert "只允许打开 HTTP 或 HTTPS 链接" in chat_ui
    assert ':codex-file-citation{' in chat_ui
    assert "设置页只提供默认值" in chat_ui
    assert "getByTabID(tabID)" in chat_ui
    assert 'CODEX_L10N_RESOURCE = "smart-paper-translator-codex-chat.ftl"' in chat_ui
    assert chat_ui.index("ensureCodexLocalization(win);") < chat_ui.index("registerSection({")
    assert "content/acp-client.js" in bootstrap
    assert "content/pdf-screenshot.js" in bootstrap
    assert "content/codex-chat.js" in bootstrap
    assert "content/codex-chat-ui.js" in bootstrap
    assert bootstrap.index('"content/pdf-screenshot.js"') < bootstrap.index(
        '"content/chat-cache.js"'
    ) < bootstrap.index('"content/codex-chat.js"')

    for locale in ("en-US", "zh-CN"):
        ftl = (
            PLUGIN / "locale" / locale / "smart-paper-translator-codex-chat.ftl"
        ).read_text(encoding="utf-8")
        assert re.search(
            r"^smart-paper-translator-codex-chat-pane-header[ \t]*=[ \t]*$\n[ \t]+\.label[ \t]*=[ \t]*\S",
            ftl,
            re.MULTILINE,
        )
        assert re.search(
            r"^smart-paper-translator-codex-chat-pane-sidenav[ \t]*=[ \t]*$\n[ \t]+\.tooltiptext[ \t]*=[ \t]*\S",
            ftl,
            re.MULTILINE,
        )

    prefs = (PLUGIN / "prefs.js").read_text(encoding="utf-8")
    assert 'pref("extensions.smart-paper-translator.autoTranslateSelection", false);' in prefs
    assert 'pref("extensions.smart-paper-translator.selectionTranslationDisabledItems", "[]");' in prefs
    assert 'preference="extensions.smart-paper-translator.autoTranslateSelection"' in xhtml
    assert 'pref("extensions.smart-paper-translator.codexDeveloperMode", false);' in prefs
    assert 'preference="extensions.smart-paper-translator.codexDeveloperMode"' in xhtml
    for line in prefs.splitlines():
        if line.lstrip().startswith("pref("):
            key = re.search(r'pref\("([^"]+)"', line).group(1)
            assert "apikey" not in key.lower()
            assert "secret" not in key.lower()

    required = {
        "manifest.json",
        "bootstrap.js",
        "prefs.js",
        "content/main.js",
        "content/preferences.xhtml",
        "content/item-tree-ui.js",
        "content/item-tree.css",
        "content/reader-ui.js",
        "content/acp-client.js",
        "content/chat-cache.js",
        "content/pdf-screenshot.js",
        "content/codex-chat.js",
        "content/math-renderer.js",
        "content/mermaid-renderer.js",
        "content/codex-chat-ui.js",
        "content/codex-chat.css",
        "content/codex.svg",
        "content/vendor/katex/katex.min.js",
        "content/vendor/katex/LICENSE.txt",
        "content/vendor/katex/README.md",
        "content/vendor/mermaid/mermaid.min.js",
        "content/vendor/mermaid/LICENSE.txt",
        "content/vendor/mermaid/README.md",
        "locale/en-US/smart-paper-translator-codex-chat.ftl",
        "locale/zh-CN/smart-paper-translator-codex-chat.ftl",
    }
    present = {path.relative_to(PLUGIN).as_posix() for path in PLUGIN.rglob("*") if path.is_file()}
    assert required <= present
    assert not any(path.startswith("node_modules/") for path in present)
    assert not any("npm-cache" in path for path in present)
    print("static validation ok")


if __name__ == "__main__":
    main()
