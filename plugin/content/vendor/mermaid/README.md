# Mermaid runtime

- Version: `11.16.1`
- Package: `mermaid@11.16.1`
- Source: <https://www.npmjs.com/package/mermaid/v/11.16.1>
- Upstream: <https://github.com/mermaid-js/mermaid>
- License: MIT; see `LICENSE.txt`
- Runtime file: `dist/mermaid.min.js` from the published npm tarball
- SHA-256: `18327bef70d96fb505fe7287d9f6a7362ebf07ff6576ddfaffb1a06f3e1a2954`

The XPI loads this browser bundle lazily and locally only when a fenced `mermaid`
block needs rendering. `mermaid-renderer.js` binds the trusted bundle to a local
`about:blank` HTML document through a dedicated Gecko sandbox, so Mermaid's global
`document` and staging DOM agree even though Zotero's Item Pane is a bodyless XUL
document. It fixes the runtime to strict security, disables HTML labels and
automatic startup, applies source/edge/time/output bounds, and serializes only a
resource-free SVG allowlist into an isolated data image. The returned SVG is never
injected into the Zotero Item Pane as live markup. Rendering failure preserves the
original Mermaid source.
