#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT_DIR"

python3 scripts/build_xpi.py \
  plugin \
  --output dist \
  --slug smart-paper-translator

VERSION=$(python3 -c 'import json; print(json.load(open("plugin/manifest.json", encoding="utf-8"))["version"])')
case "$VERSION" in
  ""|*[!0-9A-Za-z._-]*)
    echo "Invalid manifest version: $VERSION" >&2
    exit 2
    ;;
esac

XPI_PATH="dist/smart-paper-translator-${VERSION}.xpi"
test -f "$XPI_PATH"
unzip -t "$XPI_PATH"
unzip -Z1 "$XPI_PATH"
shasum -a 256 "$XPI_PATH" > dist/SHA256SUMS
