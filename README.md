# Smart Paper Translator

English · [简体中文](README.zh-CN.md)

**Codex and Pi, beside your paper in Zotero.**

Smart Paper Translator adds an Agents sidebar to Zotero's PDF reader. Ask about a passage while it's still in view, attach a figure to your question, and return to the conversation when you reopen the paper. It connects to the Codex or Pi you already use on your computer.

[Download](https://github.com/dingdinglz/zotero-translate/releases) · [Get started](#get-started) · [Report an issue](https://github.com/dingdinglz/zotero-translate/issues)

<!-- screenshot: sidebar-overview -->
![A paper's model diagram alongside an explanation in Zotero's Agents sidebar](docs/screenshots/sidebar-overview.png)

Keep the paper open while you work through it with an agent in the sidebar.

## Reading with the sidebar

### Ask about the passage in front of you

Select text in the PDF and choose **Add to Agents**. The passage and its page location appear in your draft, ready for a question such as "What assumption is this argument making?" You can add several passages before sending.

For a figure, equation, or table, use the screenshot button in the reader toolbar or sidebar and drag over the PDF. The capture comes from the PDF itself, without Zotero's interface or annotations. A selection spanning pages becomes one image per page.

Selections and screenshots stay in the draft until you send them. Image questions need a model that accepts images; if yours doesn't, the draft is kept so you can change models.

<!-- screenshot: paper-context -->
![A PDF screenshot expanded in the Agents conversation, with its page number and the question it was sent with](docs/screenshots/paper-context.png)

The screenshot and its page location stay with the question, ready to reopen in the conversation.

### Pick up where you left off

Each PDF keeps its own conversation. Codex and Pi have separate histories, drafts, and model settings, and the sidebar remembers which agent you last used for that paper. Switching agents opens that agent's history.

You can choose the model and thinking level in the sidebar. The available levels follow the selected model, including Pi's `max` where supported. After restarting Zotero, you can read the saved history and resume the same agent session when you send another message.

### Read the answer next to the source

Replies support tables, code, and mathematical notation, along with Mermaid diagrams. Text is selectable and copyable, including while a reply is streaming. Tool calls appear in expandable cards.

When an agent writes a local HTML chart and includes a `visualize` marker in its answer, the sidebar previews it after the reply finishes. You can use the chart's controls or open a larger view. Charts run without network access, with D3 included in the plugin.

<!-- screenshot: sidebar-results -->
![A GlucoFM paper open in Zotero, with an interactive chart in the Agents sidebar](docs/screenshots/sidebar-results.png)

An interactive chart from the conversation, shown beside the passage it explains.

## Get started

The current version is **0.1.37**, targeting **macOS with Zotero 9.0.6**. The plugin declares compatibility with Zotero 9.0.x. The Agents sidebar works in PDF tabs in Zotero's main window; standalone reader windows are not supported.

### Install the plugin

1. Download the `.xpi` file from [Releases](https://github.com/dingdinglz/zotero-translate/releases).
2. Open Zotero's plugin manager, choose the option to install from a file, and select the downloaded XPI.
3. Open a PDF in the main Zotero window. Find **Agents** in the right sidebar.

Updates are installed manually from a newer XPI.

### Connect an agent

You need a working local Codex or Pi installation, with its login and models configured, plus Node.js and npm. The plugin does not include those programs. Pi requires **Pi 0.85.1 or later** and **Node.js 22.19.0 or later**.

1. Open Zotero settings, then **Smart Paper Translator → Agents (ACP)**.
2. Select the paths to Node and `npx-cli.js` in the shared runtime section, then click **Check Node / npx**. Paths can be selected from detected installations, entered manually, or chosen with the file picker.
3. In the Codex or Pi tab, select that agent's executable and click **Prepare and inspect** (准备并检测).

| Agent | Adapter prepared by the plugin |
| --- | --- |
| Codex | `@agentclientprotocol/codex-acp@1.6.2` |
| Pi | `pi-acp@0.0.33` |

Preparation downloads the pinned adapter and checks the connection and model options without sending a prompt. Once it finishes, choose your defaults and send a question from the sidebar. Normal chat startup uses the cached adapter; it won't download or upgrade packages in the background.

<!-- screenshot: agent-settings -->
![Shared Node and npx paths, with the Pi tab showing its model, thinking level, and prepared adapter](docs/screenshots/agent-settings.png)

Codex and Pi share the Node / npx runtime and keep their own model settings.

If a path or model is missing, use the path refresh or agent inspection controls in settings. With NVM, check the Node path selected in Zotero: it may differ from the one your terminal uses. Detailed setup and troubleshooting are in the [technical reference (Chinese)](docs/technical-reference.zh-CN.md).

## Translation and glossary

The reader also has selection translation and an abstract/glossary panel. These use a separately configured translation API, with a DeepSeek preset and support for OpenAI Chat Completions compatible services.

- Translate a selected passage and reuse its cached translation. Automatic selection translation is optional and off by default.
- Read the translated abstract and saved terms in a floating panel. Uncached abstracts are translated when you open a PDF, once the translation service is configured.
- Delete terms you no longer need, or disable selection translation for one PDF while keeping **Add to Agents** available.
- View generated English smart tags in a separate library column. They stay in the plugin's local cache and do not change Zotero's native tags.

You can use the Agents sidebar without configuring the translation API.

## Your data and agent permissions

Opening the Agents sidebar or switching agents reads local history without requesting model output. Your first message gives the selected agent a copy of the PDF in a workspace for that paper. Later messages include your question and any selections or screenshots you attach. The agent can still read the PDF in its workspace.

The agent runs locally, but its configured model provider may receive paper content and prompts. Codex uses its existing account and configuration, including Skills and MCP; Pi uses its own login, models, and extensions. The plugin does not automatically modify Zotero items or import generated files.

Codex starts in approval mode. You can enable **Full Access** for the current conversation to allow network access and file operations outside its workspace. Pi follows its local tool and extension configuration. The paper workspace is not a security sandbox for Full Access or Pi.

Histories, PDF copies, and screenshots are stored under `smart-paper-translator/` in your Zotero data directory. These files are not encrypted or included in Zotero sync. Text and selection drafts last only for the current Zotero run; screenshot drafts can be restored after a restart. Translation API keys are stored in Mozilla Login Manager.

## Development

Read [AGENTS.md](AGENTS.md) before changing plugin code. Runtime files live in `plugin/`; tests and build tools stay outside the XPI. Development checks require Node.js 22, Python 3, and Info-ZIP.

```bash
npm run check
sh scripts/build.sh
shasum -a 256 -c dist/SHA256SUMS
unzip -t dist/smart-paper-translator-0.1.37.xpi
```

Build output goes to `dist/`. Runtime changes also require non-installing XPI parsing in the target Zotero version. The [technical reference (Chinese)](docs/technical-reference.zh-CN.md) covers adapter behavior, storage, rendering limits, and historical validation results.

If you report a bug, include your plugin and Zotero versions, the selected agent, and steps to reproduce it. Remove API keys and private paper content from logs and screenshots.
