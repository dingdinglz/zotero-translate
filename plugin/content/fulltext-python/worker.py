#!/usr/bin/env python3
"""Fixed isolated entry point; no cwd imports or dependency installation."""
import importlib.util
from pathlib import Path
import sys

sys.dont_write_bytecode = True


def main():
    try:
        # Python -I excludes the script directory. Load the single fixed,
        # bundled sibling explicitly rather than extending sys.path.
        path = Path(__file__).resolve().with_name("pdf_to_markdown.py")
        spec = importlib.util.spec_from_file_location("spt_fulltext_core", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    except BaseException:
        sys.stderr.write("fulltext: worker_load_failed\n")
        sys.stdout.write('{"ok":false,"error":"worker_load_failed"}\n')
        return 1
    return module.main()


if __name__ == "__main__":
    sys.exit(main())
