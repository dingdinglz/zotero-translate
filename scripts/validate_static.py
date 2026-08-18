#!/usr/bin/env python3
"""Static validation for Smart Paper Translator source artifacts."""

from __future__ import annotations

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
    assert manifest["version"] == "0.1.5"
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

    prefs = (PLUGIN / "prefs.js").read_text(encoding="utf-8")
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
    }
    present = {path.relative_to(PLUGIN).as_posix() for path in PLUGIN.rglob("*") if path.is_file()}
    assert required <= present
    print("static validation ok")


if __name__ == "__main__":
    main()
