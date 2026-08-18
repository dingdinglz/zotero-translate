#!/usr/bin/env python3
"""Create a minimal bootstrapped Zotero desktop plugin without overwriting files."""

from __future__ import annotations

import argparse
import html
import json
import re
import sys
import textwrap
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("target", type=Path, help="New plugin source directory")
    parser.add_argument("--name", required=True, help="Human-readable plugin name")
    parser.add_argument("--id", required=True, help="Stable plugin ID, usually name@example.org")
    parser.add_argument("--version", default="0.1.0")
    parser.add_argument("--min-version", required=True, help="Lowest tested Zotero version")
    parser.add_argument("--max-version", required=True, help="Highest tested range, e.g. 9.0.*")
    parser.add_argument(
        "--update-url",
        help="HTTPS updates.json URL; defaults to a non-updating .invalid placeholder",
    )
    return parser.parse_args()


def slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    if not slug:
        raise ValueError("target directory name must contain ASCII letters or digits")
    return slug


def global_name(slug: str) -> str:
    return "".join(part.capitalize() for part in slug.split("-")) + "Plugin"


def validate(args: argparse.Namespace) -> None:
    for label, value in (("name", args.name), ("id", args.id), ("version", args.version)):
        if not value.strip() or any(char in value for char in "\r\n"):
            raise ValueError(f"{label} must be a non-empty single-line value")
    if any(char.isspace() for char in args.id):
        raise ValueError("plugin ID cannot contain whitespace")
    if not re.fullmatch(r"[0-9]+(?:\.[0-9A-Za-z-]+)+", args.version):
        raise ValueError("version must look like 0.1.0")
    if args.update_url and not args.update_url.startswith("https://"):
        raise ValueError("update URL must use HTTPS")


def write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content.rstrip() + "\n", encoding="utf-8")


def main() -> int:
    args = parse_args()
    try:
        validate(args)
        target = args.target.expanduser().resolve()
        if target.exists() and any(target.iterdir()):
            raise ValueError(f"target is not empty: {target}")

        slug = slugify(target.name)
        object_name = global_name(slug)
        preference = f"extensions.{slug}.enabled"
        update_url = args.update_url or f"https://example.invalid/{slug}/updates.json"
        js_log_prefix = json.dumps(args.name + ": ", ensure_ascii=False)

        manifest = {
            "manifest_version": 2,
            "name": args.name,
            "version": args.version,
            "description": f"{args.name} Zotero plugin",
            "author": "Local Developer",
            "applications": {
                "zotero": {
                    "id": args.id,
                    "update_url": update_url,
                    "strict_min_version": args.min_version,
                    "strict_max_version": args.max_version,
                }
            },
        }
        write_text(target / "manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))

        bootstrap = f"""
        var {object_name};

        function log(message) {{
          Zotero.debug({js_log_prefix} + message);
        }}

        function install({{ version }}) {{
          log("Installed " + version);
        }}

        async function startup({{ id, version, rootURI }}) {{
          await Zotero.uiReadyPromise;
          Services.scriptloader.loadSubScript(rootURI + "content/main.js");
          await {object_name}.init({{ id, version, rootURI }});
          {object_name}.addToAllWindows();
        }}

        function onMainWindowLoad({{ window }}) {{
          {object_name}?.addToWindow(window);
        }}

        function onMainWindowUnload({{ window }}) {{
          {object_name}?.removeFromWindow(window);
        }}

        function shutdown() {{
          {object_name}?.shutdown();
          {object_name} = undefined;
        }}

        function uninstall({{ version }}) {{
          log("Uninstalled " + version);
        }}
        """
        write_text(target / "bootstrap.js", textwrap.dedent(bootstrap))

        main_js = f"""
        var {object_name} = {{
          id: null,
          rootURI: null,
          initialized: false,
          windowStates: new Map(),

          async init({{ id, rootURI }}) {{
            if (this.initialized) return;
            this.id = id;
            this.rootURI = rootURI;
            this.initialized = true;

            await Zotero.PreferencePanes.register({{
              pluginID: id,
              id: "{slug}-preferences",
              src: rootURI + "content/preferences.xhtml",
              label: {json.dumps(args.name, ensure_ascii=False)},
            }});
          }},

          log(message, error) {{
            Zotero.debug({js_log_prefix} + message);
            if (error) Zotero.logError(error);
          }},

          addToAllWindows() {{
            for (const win of Zotero.getMainWindows()) {{
              if (win.ZoteroPane) this.addToWindow(win);
            }}
          }},

          addToWindow(win) {{
            if (!this.initialized || !win?.ZoteroPane || this.windowStates.has(win)) return;
            this.windowStates.set(win, {{ cleanups: [] }});
            this.log("Attached to a main window");
          }},

          removeFromWindow(win) {{
            const state = this.windowStates.get(win);
            if (!state) return;
            for (const cleanup of state.cleanups) {{
              try {{ cleanup(); }} catch (error) {{ this.log("Cleanup failed", error); }}
            }}
            this.windowStates.delete(win);
          }},

          shutdown() {{
            for (const win of Array.from(this.windowStates.keys())) this.removeFromWindow(win);
            this.initialized = false;
          }},
        }};
        """
        write_text(target / "content" / "main.js", textwrap.dedent(main_js))

        write_text(target / "prefs.js", f'pref("{preference}", true);')

        pane = f"""
        <vbox
          xmlns="http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul"
          xmlns:html="http://www.w3.org/1999/xhtml"
          id="{slug}-preferences-pane"
        >
          <groupbox>
            <label><html:h2>General</html:h2></label>
            <checkbox
              id="{slug}-enabled"
              native="true"
              preference="{preference}"
              label="Enable {html.escape(args.name, quote=True)}"
            />
          </groupbox>
        </vbox>
        """
        write_text(target / "content" / "preferences.xhtml", textwrap.dedent(pane))
        write_text(target / ".gitignore", "dist/\n*.xpi\n.DS_Store")

        print(target)
        if not args.update_url:
            print(
                "WARNING: update_url uses example.invalid; replace it with a real HTTPS URL before distribution.",
                file=sys.stderr,
            )
        return 0
    except (OSError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
