# KaTeX runtime

- Version: `0.18.4`
- Source: `katex@0.18.4` from the npm registry
- Upstream: <https://github.com/KaTeX/KaTeX>
- License: MIT; see `LICENSE.txt`
- Packaged runtime SHA-256: `2ec5916941ef4383e0314eaabcc712301b06001d9fb68e08d751d2bae5a27a1a`

Smart Paper Translator uses only `renderToString(..., { output: "mathml" })`. The generated MathML is parsed as XML, checked for foreign elements and resource-bearing attributes, and then imported into the Zotero document. KaTeX HTML output, CSS, web fonts, auto-rendering, trusted commands, and runtime network access are not used.
