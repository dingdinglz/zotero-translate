#!/usr/bin/env python3
"""Validate and reproducibly package the plugin directory as an XPI."""

from __future__ import annotations

import argparse
import json
import os
import re
import tempfile
import zipfile
from pathlib import Path


EXCLUDED_DIRS = {
    ".git",
    ".hg",
    ".svn",
    "dist",
    "node_modules",
    "__pycache__",
    ".pytest_cache",
}
EXCLUDED_FILES = {".DS_Store"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="Plugin source directory")
    parser.add_argument("--output", type=Path, help="Output directory")
    parser.add_argument("--slug", help="Output filename prefix")
    return parser.parse_args()


def load_manifest(source: Path) -> dict:
    manifest_path = source / "manifest.json"
    if not manifest_path.is_file():
        raise ValueError("manifest.json is missing at the plugin root")
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"cannot read manifest.json: {error}") from error

    zotero = manifest.get("applications", {}).get("zotero", {})
    required = {
        "manifest_version": manifest.get("manifest_version"),
        "name": manifest.get("name"),
        "version": manifest.get("version"),
        "applications.zotero.id": zotero.get("id"),
        "applications.zotero.update_url": zotero.get("update_url"),
        "applications.zotero.strict_min_version": zotero.get("strict_min_version"),
        "applications.zotero.strict_max_version": zotero.get("strict_max_version"),
    }
    missing = [key for key, value in required.items() if value in (None, "")]
    if missing:
        raise ValueError("manifest.json missing: " + ", ".join(missing))
    if manifest["manifest_version"] != 2:
        raise ValueError("manifest_version must be 2")
    if not str(zotero["update_url"]).startswith("https://"):
        raise ValueError("applications.zotero.update_url must use HTTPS")
    if not (source / "bootstrap.js").is_file():
        raise ValueError("bootstrap.js is missing at the plugin root")
    return manifest


def iter_files(source: Path, output: Path):
    resolved_output = output.resolve()
    for path in sorted(source.rglob("*")):
        relative = path.relative_to(source)
        if any(part in EXCLUDED_DIRS for part in relative.parts):
            continue
        if path.is_symlink():
            raise ValueError(f"refusing to package symbolic link: {relative}")
        if not path.is_file() or path.name in EXCLUDED_FILES or path.suffix == ".xpi":
            continue
        if path.resolve() == resolved_output:
            continue
        yield path, relative.as_posix()


def make_zip(source: Path, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    file_descriptor, temporary_name = tempfile.mkstemp(
        prefix=target.name + ".",
        suffix=".tmp",
        dir=target.parent,
    )
    os.close(file_descriptor)
    temporary = Path(temporary_name)
    try:
        with zipfile.ZipFile(
            temporary,
            "w",
            compression=zipfile.ZIP_DEFLATED,
            compresslevel=9,
        ) as archive:
            for path, archive_name in iter_files(source, target):
                info = zipfile.ZipInfo(archive_name, date_time=(1980, 1, 1, 0, 0, 0))
                mode = path.stat().st_mode & 0o777
                info.external_attr = (0o100000 | mode) << 16
                info.compress_type = zipfile.ZIP_DEFLATED
                archive.writestr(info, path.read_bytes())
        with zipfile.ZipFile(temporary) as archive:
            bad = archive.testzip()
            names = set(archive.namelist())
            if bad:
                raise ValueError(f"corrupt archive member: {bad}")
            if not {"manifest.json", "bootstrap.js"}.issubset(names):
                raise ValueError("archive root is missing manifest.json or bootstrap.js")
        temporary.replace(target)
        target.chmod(0o644)
    finally:
        if temporary.exists():
            temporary.unlink()


def main() -> int:
    try:
        args = parse_args()
        source = args.source.expanduser().resolve()
        if not source.is_dir():
            raise ValueError(f"source directory does not exist: {source}")
        manifest = load_manifest(source)
        version = str(manifest["version"])
        slug = args.slug or source.name
        safe_name = re.compile(r"[0-9A-Za-z][0-9A-Za-z._-]*")
        if not safe_name.fullmatch(version) or not safe_name.fullmatch(slug):
            raise ValueError("slug or manifest version is unsafe for a filename")
        output = (args.output or source / "dist").expanduser().resolve()
        target = output / f"{slug}-{version}.xpi"
        make_zip(source, target)
        print(target)
        return 0
    except (OSError, ValueError, zipfile.BadZipFile) as error:
        print(f"error: {error}")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
