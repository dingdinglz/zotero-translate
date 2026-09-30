---
name: develop-zotero-plugins
description: Develop, modify, migrate, debug, package, and validate bootstrapped Zotero desktop-client plugins. Use for Zotero manifest.json/bootstrap.js projects; reader toolbar or popup integrations; menus, item panes, Notifier events, preferences and prefs.js; XPI packaging; compatibility or installation failures; and questions about where to verify undocumented or version-dependent Zotero and Mozilla APIs.
---

# Develop Zotero Plugins

Build against the user's actual Zotero version and prefer public plugin APIs. For a runtime deliverable, finish with an XPI parsed by that Zotero version. Documentation-only work needs documentation validation, not a plugin installation or rebuild.

## Load only the needed references

- Read [references/implementation-patterns.md](references/implementation-patterns.md) before implementing lifecycle, reader UI, item access, events, or settings.
- Read [references/source-and-debugging.md](references/source-and-debugging.md) whenever an API, version rule, install error, DOM surface, or Mozilla behavior is uncertain.
- Read [references/zotero-10-migration.md](references/zotero-10-migration.md) for Zotero 9 → 10 migration, compatibility-range changes, or Reader/PDF.js behavior in Zotero 10.
- Read [references/abstract-popup-case-study.md](references/abstract-popup-case-study.md) for floating reader UI, auto/manual open state, or a misleading compatibility error.

## Follow the workflow

### 1. Fix the target and scope

Determine:

- exact Zotero version and OS;
- supported version range requested by the user;
- plugin ID, current version, and whether this is a new plugin or upgrade;
- required surfaces: library window, reader tab, standalone reader window, menu, item pane, preference pane;
- data read/written, network access, file access, and privacy constraints;
- whether the user wants source only, an XPI, live installation, or all three.

Do not infer compatibility from the latest Zotero release alone. Read the installed version with `Services.appinfo.version` or ask for it if no client is available.

### 2. Establish evidence before coding

Check the developer migration page for the target major version and the official `make-it-red` sample. The sample demonstrates plugin structure; its manifest may target an older client. For under-documented behavior, inspect the user's installed `app/omni.ja` and the matching `zotero/zotero` source.

Run the bundled source searcher when Zotero is installed locally:

```bash
python3 <skill-dir>/scripts/inspect_zotero_source.py renderToolbar
python3 <skill-dir>/scripts/inspect_zotero_source.py PreferencePanes \
  --file-regex 'preferencePanes\.js$'
```

Record whether each important conclusion comes from public documentation, target-version source, runtime behavior, or inference. Never present an internal underscore-prefixed field as a stable public API.

### 3. Scaffold or inspect the project

For a new minimal plugin, run:

```bash
python3 <skill-dir>/scripts/scaffold_zotero_plugin.py ./my-plugin \
  --name "My Plugin" \
  --id "my-plugin@example.org" \
  --min-version "10.0" \
  --max-version "10.0.*"
```

Choose the range from target-version verification; this example is not a blanket compatibility claim. For an existing plugin, preserve its established minimum version unless the implementation requires raising it. If automatic updates are in scope, configure a real HTTPS update manifest. A deliberately manual-update plugin can retain an explicitly disclosed `.invalid` placeholder; do not invent or deploy an update service just to finish a migration.

For an existing plugin, inspect `manifest.json`, `bootstrap.js`, root `prefs.js`, resource layout, build scripts, tests, and dirty worktree state before editing. Preserve unrelated user changes.

### 4. Implement symmetric lifecycle handling

Keep lifecycle hooks in `bootstrap.js` and feature logic in namespaced content scripts. Wait for `Zotero.uiReadyPromise`, load resources through `rootURI`, attach to all existing main windows, handle future window load/unload hooks, and make shutdown remove everything added by startup.

Maintain per-window state in a `Map`. Store observer IDs, event handlers, DOM nodes, stylesheets, request serials, and cleanup callbacks. Make add/remove operations idempotent.

Prefer official managers and event registration APIs over monkey patches or arbitrary DOM injection. If a version-specific fallback is unavoidable:

1. isolate it behind a small helper;
2. guard it by capability detection, and keep an explicit tested-version gate for fragile private bridges such as PDF.js capture;
3. prevent duplicate UI;
4. document the exact Zotero version verified;
5. remove it cleanly on disable or upgrade.

### 5. Implement settings correctly

Put default preferences in root `prefs.js` for Zotero 7+. Register the pane with `Zotero.PreferencePanes.register()`. Use a namespaced XHTML fragment with no `DOCTYPE`, bind controls directly to full preference keys, and prefix every DOM/localization identifier.

Use `Zotero.Prefs.get(fullKey, true)` and `registerObserver(fullKey, handler, true)` for full global keys. Unregister preference observers on shutdown. Model a persistent preference separately from transient UI state; for example, “auto-open enabled” is not the same state as “manually opened for this tab.”

### 6. Make asynchronous UI race-safe

Before every awaited read, capture the current tab/item and increment a request serial. After the await, verify that the request, selected tab, and dismissal state are still current. Closing a panel, changing settings, switching tabs, and shutting down must invalidate in-flight work.

Handle empty or unavailable data explicitly. Do not fabricate metadata, silently access the network, or write to the library unless requested.

### 7. Test by risk layer

For runtime changes, validate the affected behavior and final package:

1. JavaScript syntax checks for every executable script.
2. Relevant regression tests for state transitions, async cancellation, and compatibility boundaries; add tests when existing coverage misses the changed behavior.
3. XML parsing for preference fragments and SVG assets.
4. Manifest and XPI structure checks.
5. Native AddonManager parsing in the exact target Zotero version.

Targeted native probes can check isolated features without installing the plugin; see [references/source-and-debugging.md](references/source-and-debugging.md). A successful parser result does not verify startup or UI behavior.

When installation and UI testing are authorized, use a separate development profile where practical. Cover open/close, repeated toggle, tab switch, empty data, preference change, disable cleanup, and restart as relevant. Verify accessibility names and selected state. If those actions are outside the task's authorization, deliver the completed non-installing checks and label UI smoke testing as unperformed.

For Skill/reference-only edits, validate frontmatter, links, examples, and the documented directory layout. Do not bump the plugin version or rebuild an unchanged XPI.

### 8. Build the XPI reproducibly

Run:

```bash
python3 <skill-dir>/scripts/build_xpi.py ./my-plugin
```

Use the repository's build entry point when one exists. Pass only the runtime source directory (for this repository, `plugin/`) to the builder. It validates required manifest fields, rejects symlinks, filters common development metadata, puts files at the archive root, and writes a deterministic XPI. Also run `unzip -t` and inspect `unzip -Z1`; no Skill files, tests, or build tools belong in the final package.

Never broaden `strict_max_version` merely to silence an install dialog. Base the declared range on verification and report the exact client version tested. The manifest range and a private feature's exact-version allowlist are separate decisions.

### 9. Let Zotero parse the final artifact

Use the non-installing `AddonManager.getInstallForFile()` diagnostic from [references/source-and-debugging.md](references/source-and-debugging.md) against the final deliverable path. Require:

- `error === 0`;
- a non-null addon with the expected ID and version;
- `isCompatible === true`;
- `appDisabled === false` unless intentionally disabled.

If parsing fails, inspect Error Console before editing. Treat the dialog's compatibility wording as a symptom, not a root cause.

Actual installation runs privileged third-party code and changes Zotero state. Install only when the user explicitly requests or confirms it; otherwise stop after native parsing and provide the XPI.

### 10. Deliver with evidence

Provide:

- versioned `.xpi`;
- versioned source archive or repository changes;
- exact installation path/menu steps;
- supported and actually tested Zotero versions;
- tests run and native parser result;
- known limitations, private/internal APIs, network behavior, and update behavior;
- one short manual acceptance checklist.

Point users to the new versioned file when older XPIs remain nearby. Never claim live installation if only static or parser validation was performed.

When publishing is requested, inspect the last published release so the notes cover any intervening unreleased changes. Commit only the intended files, push the verified commit, and target that commit when creating the release. Confirm the remote tag, release state, uploaded asset sizes and hashes before reporting publication. Existing installation or publishing authorization remains scoped to the user's request.

## Handle uncertainty explicitly

When the answer is uncertain or likely version-dependent:

1. search the current official docs and the newest version-specific developer page;
2. inspect the official sample;
3. search the installed `app/omni.ja` for the public symbol and its caller;
4. compare the same file on the official GitHub branch/tag matching the client;
5. run a read-only probe in Tools → Developer → Run JavaScript;
6. ask `zotero-dev` with version, minimal reproduction, logs, and source link if ambiguity remains.

State the boundary: “verified on Zotero x.y.z”, “documented public API”, “internal implementation”, or “inference”. If live verification is unavailable, say so and do not upgrade an inference into a compatibility promise.
