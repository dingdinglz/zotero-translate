#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT_DIR"

python3 scripts/build_xpi.py \
  plugin \
  --output dist \
  --slug smart-paper-translator

unzip -t dist/smart-paper-translator-0.1.0.xpi
unzip -Z1 dist/smart-paper-translator-0.1.0.xpi
