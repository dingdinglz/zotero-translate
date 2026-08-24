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
    assert manifest["version"] == "0.1.22"
    assert zotero["id"] == "smart-paper-translator@zotero.local"
    assert zotero["strict_min_version"] == "9.0"
    assert zotero["strict_max_version"] == "9.0.*"
    assert zotero["update_url"].startswith("https://")

    ElementTree.parse(PLUGIN / "content" / "preferences.xhtml")
    xhtml = (PLUGIN / "content" / "preferences.xhtml").read_text(encoding="utf-8")
    assert "<!DOCTYPE" not in xhtml

    executable = "\n".join(
        path.read_text(encoding="utf-8")
        for path in sorted(PLUGIN.rglob("*.js"))
        if path.name != "prefs.js"
    )
    for forbidden in ("reader._window", "reader._iframeWindow"):
        assert forbidden not in executable, f"private reader API used: {forbidden}"

    constants = (PLUGIN / "content" / "constants.js").read_text(encoding="utf-8")
    acp_client = (PLUGIN / "content" / "acp-client.js").read_text(encoding="utf-8")
    chat_ui = (PLUGIN / "content" / "codex-chat-ui.js").read_text(encoding="utf-8")
    math_renderer = (PLUGIN / "content" / "math-renderer.js").read_text(encoding="utf-8")
    bootstrap = (PLUGIN / "bootstrap.js").read_text(encoding="utf-8")
    assert 'ACP_PACKAGE_SPEC: "@agentclientprotocol/codex-acp@1.6.2"' in constants
    assert 'ACP_MODE: "agent"' in constants
    assert 'npm_config_offline: "true"' in acp_client
    assert 'INITIAL_AGENT_MODE: Constants.ACP_MODE' in acp_client
    codex_chat = (PLUGIN / "content" / "codex-chat.js").read_text(encoding="utf-8")
    assert 'this.acp.request("session/close"' in codex_chat
    assert 'this.acp.request("session/delete"' not in codex_chat
    assert 'purpose: "version", allowDownload: true' not in bootstrap
    assert ".innerHTML =" not in chat_ui
    assert ".innerHTML =" not in math_renderer
    assert 'output: "mathml"' in math_renderer
    assert 'trust: false' in math_renderer
    assert 'maxExpand: 1000' in math_renderer
    assert 'maxSize: 20' in math_renderer
    assert '"content/vendor/katex/katex.min.js"' in bootstrap
    assert '"content/math-renderer.js"' in bootstrap
    assert bootstrap.index('"content/vendor/katex/katex.min.js"') < bootstrap.index(
        '"content/math-renderer.js"'
    ) < bootstrap.index('"content/codex-chat-ui.js"')
    katex_runtime = PLUGIN / "content" / "vendor" / "katex" / "katex.min.js"
    assert hashlib.sha256(katex_runtime.read_bytes()).hexdigest() == (
        "2ec5916941ef4383e0314eaabcc712301b06001d9fb68e08d751d2bae5a27a1a"
    )
    katex_license = (
        PLUGIN / "content" / "vendor" / "katex" / "LICENSE.txt"
    ).read_text(encoding="utf-8")
    assert "The MIT License" in katex_license
    assert "zotero.launchURL(url)" in chat_ui
    assert "只允许打开 HTTP 或 HTTPS 链接" in chat_ui
    assert ':codex-file-citation{' in chat_ui
    assert "设置页只提供默认值" in chat_ui
    assert "getByTabID(tabID)" in chat_ui
    assert 'CODEX_L10N_RESOURCE = "smart-paper-translator-codex-chat.ftl"' in chat_ui
    assert chat_ui.index("ensureCodexLocalization(win);") < chat_ui.index("registerSection({")
    assert "content/acp-client.js" in bootstrap
    assert "content/codex-chat.js" in bootstrap
    assert "content/codex-chat-ui.js" in bootstrap

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
        "content/codex-chat.js",
        "content/math-renderer.js",
        "content/codex-chat-ui.js",
        "content/codex-chat.css",
        "content/codex.svg",
        "content/vendor/katex/katex.min.js",
        "content/vendor/katex/LICENSE.txt",
        "content/vendor/katex/README.md",
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
