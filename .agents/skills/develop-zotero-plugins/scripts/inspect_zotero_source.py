#!/usr/bin/env python3
"""Search text files inside an installed Zotero omni.ja archive."""

from __future__ import annotations

import argparse
import os
import re
import sys
import zipfile
from pathlib import Path


TEXT_SUFFIXES = {".js", ".mjs", ".xhtml", ".xul", ".css", ".json"}


def default_candidates() -> list[Path]:
    candidates = [
        Path("/Applications/Zotero.app/Contents/Resources/app/omni.ja"),
        Path("/Applications/Zotero Beta.app/Contents/Resources/app/omni.ja"),
        Path("/opt/zotero/app/omni.ja"),
        Path("/usr/lib/zotero/app/omni.ja"),
    ]
    program_files = os.environ.get("PROGRAMFILES")
    if program_files:
        candidates.append(Path(program_files) / "Zotero" / "app" / "omni.ja")
    return candidates


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pattern", help="Literal text to search, or a regex with --regex")
    parser.add_argument("--omni", type=Path, help="Path to app/omni.ja or platform omni.ja")
    parser.add_argument("--file-regex", help="Only search archive paths matching this regex")
    parser.add_argument("--regex", action="store_true", help="Interpret PATTERN as a regular expression")
    parser.add_argument("--ignore-case", action="store_true")
    parser.add_argument("--max-results", type=int, default=80)
    return parser.parse_args()


def resolve_omni(explicit: Path | None) -> Path:
    if explicit:
        path = explicit.expanduser().resolve()
        if not path.is_file():
            raise ValueError(f"omni.ja does not exist: {path}")
        return path
    for candidate in default_candidates():
        if candidate.is_file():
            return candidate.resolve()
    raise ValueError("cannot find Zotero app/omni.ja; pass --omni /absolute/path/to/omni.ja")


def main() -> int:
    args = parse_args()
    try:
        if args.max_results < 1:
            raise ValueError("--max-results must be positive")
        omni = resolve_omni(args.omni)
        flags = re.IGNORECASE if args.ignore_case else 0
        matcher = re.compile(args.pattern if args.regex else re.escape(args.pattern), flags)
        file_matcher = re.compile(args.file_regex) if args.file_regex else None
        results = 0

        with zipfile.ZipFile(omni) as archive:
            for name in archive.namelist():
                if Path(name).suffix.lower() not in TEXT_SUFFIXES:
                    continue
                if file_matcher and not file_matcher.search(name):
                    continue
                try:
                    text = archive.read(name).decode("utf-8", errors="replace")
                except (KeyError, OSError):
                    continue
                for line_number, line in enumerate(text.splitlines(), 1):
                    snippet = line.strip()
                    match = matcher.search(snippet)
                    if not match:
                        continue
                    if len(snippet) > 500:
                        original_length = len(snippet)
                        start = max(0, match.start() - 180)
                        snippet = snippet[start : start + 500]
                        if start:
                            snippet = "…" + snippet
                        if start + 500 < original_length:
                            snippet += "…"
                    print(f"{name}:{line_number}:{snippet}")
                    results += 1
                    if results >= args.max_results:
                        print(f"-- stopped after {results} results from {omni}", file=sys.stderr)
                        return 0

        if not results:
            print(f"no matches in {omni}", file=sys.stderr)
            return 1
        return 0
    except (OSError, ValueError, re.error, zipfile.BadZipFile) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
