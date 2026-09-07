# Smart Paper Translator

Smart Paper Translator 0.1.34 是面向 macOS Zotero 9 内置 PDF Reader 的学术翻译插件。它保留原有翻译、摘要和智能标签功能，并提供一个可切换本机 Codex / Pi 的原生 **Agents** 右侧栏。对话走 [Agent Client Protocol](https://agentclientprotocol.com/) stdio，不使用插件内置翻译 LLM，也不与翻译 API Key 共用配置。

## 功能

### 翻译与智能标签

- DeepSeek 内置配置，以及标准 Bearer 鉴权的 OpenAI Chat Completions 兼容服务。
- 两套可编辑安全模板；划线翻译模板默认携带论文标题与 Zotero 父条目摘要。
- 打开 PDF 时自动翻译尚未缓存的摘要；划线缓存命中时直接显示并提供“重新翻译”，未命中时默认等待点击“翻译”，也可在设置中开启自动翻译。
- Reader 工具栏可单独禁用当前 PDF 的划线翻译；禁用开关默认关闭并按 PDF 持久化，禁用后不显示插件的划线翻译入口、不查询划线缓存，也不调用翻译 API。
- 根据标题与 Zotero 摘要生成 3–5 个英文智能标签，在主页独立列中显示，但不写入 Zotero 原生 Tags。
- Reader 工具栏保留论文智译悬浮窗；摘要译文和术语分 Tab 展示，窗口支持拖动、缩放与持久化。
- 每篇论文独立缓存；模型、目标语言、摘要或提示词变化后生成新的缓存版本。

### Agents ACP 论文对话

- 在 Zotero 主窗口 Reader 的原生右侧 Item Pane 显示“Agents”，采用中性对话图标和 Codex / Pi 下拉选择。插件只通过 `item-details.tabID → Zotero.Reader.getByTabID()` 获取当前 PDF 附件；无法精确解析时直接禁用，不猜测父条目附件。
- PDF 划线弹窗提供“添加到 Agents”：点击只把选中文本及 PDF 坐标加入当前附件、当前 Agent 的内存草稿，自动尝试展开同一 Reader tab 的 Agents 侧栏并聚焦问题输入框，不启动 ACP、不请求模型。多个选区可累积、去重和删除，卡片只显示页码与文本；正在生成时加入的选区留给下一轮发送。按 PDF 禁用划线翻译不会关闭此入口。
- Reader 工具栏和 Agents 输入区都提供“截图”。进入框选模式后可在左侧 PDF 阅读区拖出矩形，靠近边缘时自动滚动；跨页矩形按实际覆盖页面拆成多张图，页间空隙不计入。插件针对 Zotero 9.0.6 隔离调用 PDF.js 原页渲染能力，按 PDF 坐标重新生成不含工具栏、框选层、深色模式或 Zotero 批注的干净 PNG；内部能力或版本不匹配时失败关闭，不退回屏幕抓图。
- 截图采用自适应高分辨率渲染，单张最长边 4096、最多 1600 万像素且 PNG 不超过 12 MiB。张数不设固定上限；侧栏按页折叠分组并只解码已展开的预览。为避免 Zotero 或 stdio 内存耗尽，单轮仍有 64 MiB/1.28 亿像素的紧急总保护，超限时保留完整草稿并阻止发送。
- 框选结果先进入当前 PDF、捕获开始时所选 Agent 的会话草稿，不自动发送。卡片支持放大、移除和重新框选；重新框选成功前保留旧图。允许不填写问题直接发送纯图片。真正发送时，每张 PNG 使用 ACP 图片块，并用受安全边界保护的 JSON 同步发送页索引、页标签、PDF 点坐标矩形、输出像素、旋转和渲染比例；图片像素与论文内容都被标记为不可信数据。当前模型拒绝图片输入时，本地用户消息会回滚，截图草稿原样保留且不会自动换模型。
- 每篇论文记住当前 Agent，首次默认 Codex；Codex / Pi 各自保留 session、历史、模型、思考强度与草稿。切换只读本地历史，不启动模型；连接、生成、等待授权和停止期间禁用切换，停止完成后恢复。同一 PDF/Agent 的多个 Reader 视图共享单 turn 锁，不同 PDF 可并行对话。
- Codex 支持“审批模式 / Full Access”：新会话默认审批，已有会话恢复保存的权限。Full Access 允许工作区外文件操作和联网，只作用于当前 Codex 会话；切换成功后保存，失败保留原选择并在发送前重新确认。Pi 直接使用本机工具执行机制，界面不把它的思考 mode 当作权限；适配器扩展发出的交互请求仍然显示。
- 第一条真实消息会把源 PDF 原子复制为专用工作区中的 `source.pdf`，再以 `application/pdf` 的 ACP `resource_link` 引用；后续 turn 不重复附加 PDF，只发送文本以及用户本轮明确添加的截图图片块。
- Zotero 重启后，在用户重新加载或首次发送前通过 `session/load` 恢复同一 Agent session，并用 thread 回放对账本地镜像。交付状态不确定时必须先对账，避免重复发送。
- 支持流式文本、安全 Markdown（标题、强调、列表、引用、表格、代码）、完整的 KaTeX 0.18.4 → Firefox MathML 公式，以及 fenced `mermaid` 图表。Mermaid 11.16.1 随 XPI 离线内置并按窗口延迟加载；图表以严格模式、禁用 HTML 标签和交互的方式渲染，经本地资源与 SVG 白名单复核后作为隔离数据图片显示，宽图可横向滚动，源码可折叠查看和复制，解析失败或超限时自动展开源码。公式支持分式、求和上下标、集合运算、重音、根式、矩阵、对齐环境及上下花括号；解析失败时保留原始 TeX，不再输出命令粘连的伪公式。Codex 的 `:codex-file-citation{...}` 与兼容的 `::codex-file-citation{...}` 文件引用会显示为引用胶囊，并且只允许在当前论文工作区内定位。工具和计划卡片在长对话中保持固定高度；流式更新会保留已展开卡片与阅读位置，只有用户原本就在底部时才继续跟随新内容。
- Codex / Pi 的对话消息、代码、表格及展开的工具内容支持鼠标选择文字，并使用原生 ⌘C（Windows/Linux 为 Ctrl+C）或“编辑 → 复制”。选中文字时暂停消息区重绘，取消选择后立即显示最新回复；生成、停止及授权状态仍正常更新。
- 超宽工具输出、路径和表格被限制在 Item Pane 内，不再把用户消息推到侧栏可视区域之外。
- `execute`、文件读取、图片查看和搜索等常见工具会显示为语义卡片，只呈现安全元数据，不再把内部 ID、时间戳及原始事件 JSON 暴露在界面中；权限审批使用同一套可读展示。Codex 完成态 `View Image` 会联合核对工具类型、标题、输入路径、位置和资源链接，再把通过常规文件、25 MiB、扩展名与文件签名校验的 PNG/JPEG/GIF/WebP/AVIF 复制到工作区外的会话媒体目录；SVG、未知格式、路径不一致和伪装文件只显示错误，不回退直读源路径。图片卡片默认折叠，用户展开后才解码本地副本；点击预览可在当前 Zotero 窗口放大，并在适应窗口与 1:1 原始像素间切换。Web Search 会区分多查询搜索、打开网页和页内查找，完整展示 ACP 返回的查询、页面、查找词，以及事件中实际携带的结果标题、摘要或文本；若固定适配器没有传回网页正文或结果摘要，卡片会明确标注协议事件未携带内容。
- Agents 回答和 Web Search 卡片中的 HTTP/HTTPS 链接只在用户点击后通过 Zotero 9.0.6 的 `Zotero.launchURL()` 交给系统默认浏览器；插件不在 Item Pane 内导航，也不允许其他 URL scheme。
- Agent 思考增量中的最新非空状态行会显示在输入框上方的加载栏中；空白分隔块被忽略，历史思考不再堆成可展开卡片，任务结束后加载栏自动隐藏。
- 设置页提供默认关闭的“开发者模式”。只有开启后，Agents 侧栏才显示“复制日志”按钮，并在内存中记录当前实时 turn 的工具调用与思考事件；关闭后立即清空且停止采集。日志会脱敏用户主目录和常见密钥字段，并限制事件、字符串及集合大小，但复制前仍应检查其中的命令、路径和工具输出。
- 首轮实际发送给 ACP 的论文安全边界和 `resource_link` 只作为协议上下文保存；用户消息气泡始终只显示用户输入的问题，远端回放也会做同样的展示归一化。
- 选区在真正发送时才以版本化 JSON 文本交给所选本机 Agent，包含 `pageIndex`、页码、页标签、单页或跨页矩形坐标，并明确把选区文字标记为不可信论文数据而非指令。已发送消息的本地镜像和 `session/load` 回放会恢复可读问题与选区卡片；旧纯文本历史保持原样。
- 已发送截图在消息历史中默认折叠，只显示页码、数量和位置摘要；展开后才从会话隔离副本解码缩略图，并可放大查看。`session/load` 回放中的 base64 图片标记只用于重新关联同一截图 ID 的本地受控副本，不直接作为界面图片源。
- 设置页的模型与推理强度只作为新会话默认值；首条消息发送前即可在侧栏为当前 PDF 单独选择，创建后也可继续修改同一个 session。模型变化时会使用该模型实际支持的推理强度列表。模型和思考强度各占一行，收起时显示完整名称，长名称自动换行；保留原生下拉菜单与键盘操作。
- 支持 ACP 权限请求和表单 elicitation。命令、cwd、主机、读写位置及适配器提供的授权选项会在侧栏显示；插件不会自动批准。
- 插件为每篇论文、每个 Agent 提供独立工作区，不自动导入生成文件或修改 Zotero 条目。Full Access 和 Pi 的工具可能操作工作区外文件；工作区不是这两种执行方式的安全沙箱。

独立 Reader 窗口不提供 Agents 侧栏；当前目标是 Zotero 主窗口中的 Reader tab。

## 公共 ACP 运行环境

在 Zotero 设置中打开 “Smart Paper Translator → Agents（ACP）”。顶部“公共运行环境”配置 Node、`npx-cli.js`，两者由 Codex / Pi 共用。Node、npx、Codex、Pi 路径均提供候选下拉、可编辑文本框及“选择…”文件浏览。打开设置即只读扫描 Zotero 进程的 PATH、默认 `~/.nvm`、`NVM_DIR` / `XDG_CONFIG_HOME` 下的 NVM 与常见安装位置；候选显示来源及 NVM 目录版本，识别 npm 的 npx 软链接。选择下拉项后填入绝对路径，也可直接修改文本；“刷新路径列表”保留当前及手动选择，不执行 shell 配置或候选程序。点击“检测 Node / npx”才读取本机版本，不启动 Agent、不下载、不发送提示词。已保存路径在升级后保留。

以这里检测到的 Node 版本为准，终端的 `node --version` 可能来自另一套安装。例如，终端 NVM 是 Node 24.14.0，而设置仍指向 `/usr/local/bin/node` 的 22.13.0，仍然不满足 Pi 的最低要求。应选择 NVM 下的 `bin/node` 和对应 `lib/node_modules/npm/bin/npx-cli.js`，然后重新检测。所选 Node 目录会排在子进程 PATH 首位，供两个 Agent 使用。

下方圆角分段式 Codex / Pi Tab 分别保存各自的可执行路径、默认模型和思考强度，并显示独立的准备状态。Tab 切换只显示本地设置，不启动 ACP；检测或准备期间锁住配置以防路径混用。路径刷新不修改公共 Node / npx。文件选择使用 [Zotero 推荐的 FilePicker 模块](https://www.zotero.org/support/dev/zotero_8_for_developers)，由它处理新版 BrowsingContext 参数；取消或关闭设置窗口后不提交结果。

## 配置本机 Codex

在“Agents（ACP）”下选择 **Codex** Tab：

1. 从已发现的路径下拉选择 Codex，也可手动输入或浏览可执行文件；“刷新路径列表”重新扫描本机安装。插件不依赖 Finder 启动 Zotero 时常常缺失的 NVM/PATH。
2. 点击“重新检测”会运行本地版本与登录检查；若固定适配器已经准备好，还会用一个不发送提示词的临时空 session 读取动态模型选项，随后通过 `session/close` 释放它。这个动作不调用 `session/delete`、不下载依赖，也不产生模型生成用量。
3. 首次使用必须明确点击“准备并检测 ACP 1.6.2”。这是唯一允许 npx 下载的入口，执行固定包 `@agentclientprotocol/codex-acp@1.6.2`，随后验证版本、ACP 握手、登录状态、能力和动态模型选项。若失败，设置页会显示阶段、错误代码、目标包、退出码以及脱敏后的 stdout/stderr，便于继续定位。
4. 日常聊天以 npm 离线模式启动已准备的适配器。缓存缺失、路径变化或版本不匹配时直接报错，不静默下载或升级。
5. 模型和推理强度取自适配器返回并原子缓存的动态配置。设置值只提供新 session 默认值；每个 PDF 可在侧栏保存自己的选择，已存在 session 保留自己的选择。保存的选项若已不可用，发送会被阻止，不会静默换模型。
6. 调试侧栏事件时，可在设置页单独开启“开发者模式”。开启后运行一轮对话，再点击侧栏“复制日志”；日志只驻留内存、不会自动写文件或上传。关闭开关会立刻清空已收集内容。

适配器通过 `CODEX_PATH` 使用所选本机 Codex，并继承其账号、配置、全局指令、Skills 与 MCP。插件不保存或展示 token。新会话默认受审批的 `agent`（工作区可写、网络默认关闭）；侧栏可按会话选择 `agent-full-access`，允许工作区外文件操作与联网。该选择不修改插件的全局权限。

## 配置本机 Pi

当前以本机 **Pi 0.85.1 / Zotero 9.0.6** 为验证目标。需要 Pi >= 0.85.1、Node >= 22.19.0，并先在本机 Pi CLI 中配置可用模型与登录。插件使用固定 [pi-acp 0.0.33](https://github.com/svkozak/pi-acp/tree/1bfcb394088ed879db8fd936b570bb626017f878)。

1. 在“Agents（ACP）”下选择 **Pi** Tab，从候选下拉选择 Pi，或手动输入/浏览其绝对路径；Node 与 `npx-cli.js` 使用上方公共配置。
2. 点击“准备并检测 pi-acp 0.0.33”允许下载该固定适配器；通过初始化响应核对版本，再用独立连接的空 session 读取模型与思考选项。不发送提示词，完成后退出探测进程。
3. 升级到 0.1.32 后，在 Pi Tab 点击“重新检测”刷新选项目录。选择 Pi 默认模型与思考强度，或在 Agents 侧栏针对当前论文选择；选项按模型区分，支持的模型可选择 `max`。Pi 使用 `model` 与 `thought_level`，不调用 Codex 的登录状态或关闭 session 扩展方法。
4. 日常启动只使用缓存中的适配器，并设置 `PI_OFFLINE=1`、`PI_TELEMETRY=0`、`PI_SKIP_VERSION_CHECK=1`，关闭 Pi 的启动更新等联网操作；这些设置不禁止用户发送后的模型请求或工具联网。缺少登录或模型时先在本机 Pi 配置，再重新检测。

Pi 每篇论文懒创建独立连接，因为该适配器会替换同一连接中的前一个 session。切换或关闭 Reader 后，无视图引用且已空闲的连接会退出；再次发送时恢复原持久 session。Pi 工具终端输出可回放；自身资源上下文包装不会显示为用户问题。现有 Codex 数据仍在原目录使用。

`pi-acp@0.0.33` 原版的档位白名单只到 `xhigh`。插件内置 `pi-acp-compat.js`，在自己的 Node 进程中用 [Node 模块加载钩子](https://nodejs.org/api/module.html#moduleregisterhooksoptions) 转换该固定版本入口：读取 Pi 的 `get_available_thinking_levels`，支持 `max` 并在设置后回读确认，保持已有 `max` 的真实显示。只转换 SHA-256 为 `24ff73fda6e3c76ddce2d359a79f5c4b8f292eb290e4d2ab85aac94676b2c2dc` 的 `dist/index.js`，内容不符即报错；不改本机 Pi 或 npm 缓存。补丁随 XPI 发布，无需等待上游合并，也不自动提交上游 PR。

## 对话存储与恢复

本机 Zotero 数据目录下新增：

```text
smart-paper-translator/
├── records/                         # 原有翻译与智能标签缓存
├── codex-acp/
│   ├── records/                     # 每个 PDF 的 session 映射与离线对话镜像
│   ├── workspaces/                  # 当前 session 的 source.pdf 与生成文件
│   ├── tool-images/                 # 按论文/本地会话隔离、不会交给 ACP 的 View Image 副本
│   ├── screenshots/                 # 按论文/本地会话隔离的 PDF 截图草稿与历史副本
│   ├── archives/                    # 重建后保留的旧映射和旧工作区
│   ├── configuration-catalog.json   # 最近一次显式检测得到的模型/推理选项目录
│   └── configuration-workspace/     # 不含论文的临时配置检测工作区
└── pi-acp/                          # 与 Codex 同结构，独立保存 Pi 数据
```

- 当前 Agent 选择仅存本机偏好；旧记录缺失 Agent 标识时视为 Codex，保留原 session ID、工作区与图片引用。重建会话只影响当前 Agent。文字和选区草稿仅存内存；截图草稿按 Agent 独立持久化与恢复。
- JSON 使用临时文件原子替换；损坏镜像会先生成 `.corrupt-*` 备份再重建。
- Agent 的持久 session 是上下文权威来源，本地镜像用于离线展示。session 缺失时保留本地历史为只读，需用户确认后才能新建会话。
- PDF 大小或修改时间变化时暂停发送。用户可以继续使用旧快照，或归档旧映射与工作区后建立新 session。
- 同一 session 重启或 `session/load` 回放时，工具调用 ID 和截图 ID 会重新关联各自的本地受控副本。移除未发送截图会立即删除其文件；发送成功后的截图随 session 保留。新建会话会删除旧 session 的 `tool-images` 与 `screenshots` 目录，因此旧归档中的图片预览不再保留。
- 若系统找不到 `pdftotext`，插件使用 Zotero 9.0.6 的 `Zotero.PDFWorker.getFullText()` 生成本地 `source.txt` 兜底，但仍保留并引用真实 PDF。

这些文件不参与 Zotero 同步，也不加密。

## 数据与隐私

- 翻译链路与 Codex ACP 链路完全独立。翻译 API Key 仍保存在 Mozilla Login Manager，不写入偏好、JSON 或 XPI。
- 打开 PDF、展开 Codex 侧栏和读取离线镜像不会启动 ACP、下载依赖或产生 Codex 用量。用户发送消息会启动已经准备好的本地适配器；用户明确点击“准备并检测”或“重新检测”也会启动 ACP，并使用临时空 session 更新选项目录，但不发送提示词。
- 未发送的 Codex 问题和 PDF 选区草稿只保存在插件进程内存中，按附件隔离；截图文件及其最小位置元数据会保存在工作区外的 `screenshots/<论文标识>/<本地会话标识>/` 与会话镜像中，以便 Zotero 重启后恢复。移除截图或重建会话会按生命周期清理副本。自动展开能力缺失时草稿仍保留，可手动打开 Codex 侧栏。
- 第一条 Codex 消息会把 PDF 的本地快照交给本机 Codex；后续消息不再重复 PDF，但本轮明确附加的截图及精确位置仍会发送。同一 thread 中 Codex 仍可读取自己的工作区和上下文。
- `tool-images/<论文标识>/<本地会话标识>/` 位于 ACP 工作区之外，不会作为 cwd、资源、附加目录或软链接交给 Codex；普通界面不显示源文件绝对路径，只渲染完成校验的受控副本。
- `screenshots/<论文标识>/<本地会话标识>/` 同样位于 ACP 工作区之外，路径不写入图片载荷或位置 JSON；发送时插件重新校验常规文件类型、PNG 签名、字节数、像素尺寸与位置元数据，再以内嵌图片块传输。
- 本机 Codex 的 Skills/MCP 与 Pi 的扩展可能访问论文之外的数据或服务；Codex 审批模式仍受其沙箱和审批机制约束，Full Access 与 Pi 不提供该工作区沙箱限制。
- 原始 HTML 不会渲染，远程图片不会自动加载；普通 Markdown、公式、Codex 指令、工具输出和权限详情均通过受限 DOM/MathML 节点显示，不把不可信内容交给 `innerHTML`。公式由 XPI 内置 KaTeX 离线转换，使用 `trust: false`、有限宏展开与尺寸上限，只导入不含外部元素、链接或资源属性的 MathML。Mermaid 固定版本运行时在同一 Zotero 窗口的本地 `about:blank` HTML iframe 与专用 Gecko sandbox 中延迟加载，以适配 Item Pane 的无 `body` XUL 文档；sandbox 通过该 HTML 窗口原型继承只读的全局 `window`/`document` 绑定。它锁定严格安全配置并限制源文本、边数、渲染时间、SVG 大小和节点数。返回 SVG 只额外接受 Mermaid flowchart 自动生成、且只引用本地片段的 `feDropShadow` 投影，仍拒绝活动元素、HTML、链接和非本地资源引用，最终只作为 `data:image/svg+xml` 图片显示，不把活动 SVG 注入 Item Pane。HTTP/HTTPS 链接只在明确点击后交给系统浏览器，网页访问不发生在插件渲染过程中。
- 开发者模式默认关闭。开启时只收集当前实时 turn 的工具与思考事件，不收集用户消息或最终回答；内存日志采用有界环形缓冲并做密钥和用户目录脱敏，关闭模式、重建会话或退出插件时清空。
- 翻译请求继续使用匿名 Cookie 容器、60 秒超时和 `logBodyLength: 0`，不把论文正文写入 Zotero HTTP 调试日志。
- 已禁用划线翻译的 PDF 附件 ID 列表只保存在本机 Zotero 偏好中，不写入条目或 Zotero 原生 Tags。

## 开发与验证

插件 XPI 不捆绑 Node、Pi、npm 缓存或 ACP 适配器包；它额外内置 MIT 许可的 KaTeX 0.18.4 与 Mermaid 11.16.1 单文件运行时，不含运行时 CDN、字体或网络下载。开发检查需要 Node.js 22、Python 3 和 Info-ZIP：

```bash
npm run check
sh scripts/build.sh
shasum -a 256 -c dist/SHA256SUMS
unzip -t dist/smart-paper-translator-0.1.34.xpi
```

真实 npx 下载、Codex/Pi 模型用量测试、插件安装和 UI 冒烟测试不属于自动构建；这些操作需要分别明确授权。真实 E2E 应使用合成 PDF，不发送用户论文。

0.1.34 已通过 231 项自动测试、JavaScript/静态检查、构建、SHA-256、XPI 根目录与 `unzip -t` 检查，归档内 38 个运行时文件与源码逐字节一致。用实际侧栏模块与样式、合成消息制作独立浏览器预览，验证了文字及代码拖选、⌘C 复制与粘贴，以及流式更新期间保持选区、取消选择后恢复更新。回归测试覆盖最终回复补绘、不同论文/Agent/会话/加载请求的隔离和销毁后的监听器清理。

0.1.34 的最终 XPI 已在 Zotero 9.0.6 中通过 `AddonManager.getInstallForFile()` 非安装式解析：插件 ID 为 `smart-paper-translator@zotero.local`，版本为 `0.1.34`，`error: 0`、`isCompatible: true`、`appDisabled: false`。本次未安装插件或进行真实模型/UI 冒烟测试。

此前 0.1.33 已通过 228 项自动测试、JavaScript/静态检查、构建、SHA-256、XPI 根目录与 `unzip -t` 检查，归档内 38 个运行时文件与源码逐字节一致。使用实际侧栏模块与样式的独立浏览器预览，检查了 240px / 320px / 500px 宽度、长模型名称、深色主题和选中值同步；模型与思考强度各占一行，完整名称自动换行，无横向溢出。配置失败恢复原值和生成期间禁用控件由回归测试覆盖。

0.1.33 的最终 XPI 已在 Zotero 9.0.6 中通过 `AddonManager.getInstallForFile()` 非安装式解析：插件 ID 为 `smart-paper-translator@zotero.local`，版本为 `0.1.33`，`error: 0`、`isCompatible: true`、`appDisabled: false`。未安装该 XPI 或调用真实模型。

此前 0.1.32 已通过 227 项自动测试、JavaScript/静态检查、构建、SHA-256、XPI 根目录与 `unzip -t` 检查。最终 XPI 在 Zotero 9.0.6 中非安装式解析得到 `error: 0`、`isCompatible: true`、`appDisabled: false`；从该 XPI 读取的兼容模块可在 Gecko 中生成 Node 启动代码。另对本机已准备的 pi-acp 0.0.33 完成 2 项可选验证：兼容入口初始化后 EOF 正常退出，以及真实 ACP 配置方法通过假 Pi RPC 显示/设置/恢复 `max`、按模型过滤选项；原版文件哈希未改变。

离线 npm 调用在现成缓存包目录中完成握手验证；本次命令行从项目目录启动时遇到 npm registry 元数据 `ENOTCACHED`，因此未将该调用计为通过。缓存补齐仍只允许用户在设置页点击“准备并检测”。没有执行真实 Pi 会话或模型请求。

此前 0.1.31 已通过 218 项自动测试、JavaScript/静态检查、构建、SHA-256、XPI 根目录与 `unzip -t` 检查；最终 XPI 在 Zotero 9.0.6 中通过 `AddonManager.getInstallForFile()` 非安装式解析，得到 `error: 0`、`isCompatible: true`、`appDisabled: false`。

在 Zotero 9.0.6 中以隔离脚本调用新版路径枚举和文件选择代码，实际识别出 NVM 下的 Node、npx、Codex、Pi 及系统安装，并成功打开原生文件选择器、返回所选 Node 的绝对路径；没有修改插件偏好。取消、不写偏好、PATH 目录含空格、自定义 NVM、npm 软链接、迟到扫描结果与窗口关闭分支由受控测试覆盖。用实际设置页模块的独立浏览器预览检查了 400px / 560px 布局、圆角分段 Tab、路径下拉/手动输入/刷新，确认无横向溢出、保留自定义路径且不启动 Agent；这不替代插件安装后的完整 Zotero UI 冒烟测试。

此前在 Zotero 9.0.6 中执行本地 `--version`，已验证 Node 24.14.0 / npx 11.9.0 / Pi 0.85.1 返回正常。Pi 协议与聊天行为仍由受控测试验证；本次未下载适配器、安装插件、修改 Zotero profile 或调用真实 Codex/Pi 模型。

可选现成适配器验证（路径需指向已经准备好的 `pi-acp@0.0.33`）：

```bash
SPT_TEST_PI_ACP_ENTRY=/absolute/path/to/pi-acp/dist/index.js node --test tests/pi-acp-compat.test.js
```

此检查只对原版模块做初始化握手，以及用假 Pi RPC 验证真实适配器的配置方法；不启动真实 Pi，不创建用户会话，不读取登录信息。
