# Smart Paper Translator

Smart Paper Translator 0.1.23 是面向 macOS Zotero 9 内置 PDF Reader 的学术翻译插件。它保留原有翻译、摘要和智能标签功能，并提供一个连接本机 Codex 的原生右侧栏。Codex 对话走 [Agent Client Protocol](https://agentclientprotocol.com/) stdio，不使用插件内置翻译 LLM，也不与翻译 API Key 共用配置。

## 功能

### 翻译与智能标签

- DeepSeek 内置配置，以及标准 Bearer 鉴权的 OpenAI Chat Completions 兼容服务。
- 两套可编辑安全模板；划线翻译模板默认携带论文标题与 Zotero 父条目摘要。
- 打开 PDF 时自动翻译尚未缓存的摘要；划线缓存命中时直接显示并提供“重新翻译”，未命中时默认等待点击“翻译”，也可在设置中开启自动翻译。
- Reader 工具栏可单独禁用当前 PDF 的划线翻译；禁用开关默认关闭并按 PDF 持久化，禁用后不显示插件的划线翻译入口、不查询划线缓存，也不调用翻译 API。
- 根据标题与 Zotero 摘要生成 3–5 个英文智能标签，在主页独立列中显示，但不写入 Zotero 原生 Tags。
- Reader 工具栏保留论文智译悬浮窗；摘要译文和术语分 Tab 展示，窗口支持拖动、缩放与持久化。
- 每篇论文独立缓存；模型、目标语言、摘要或提示词变化后生成新的缓存版本。

### Codex ACP 论文对话

- 在 Zotero 主窗口 Reader 的原生右侧 Item Pane 显示“Codex 对话”。插件只通过 `item-details.tabID → Zotero.Reader.getByTabID()` 获取当前 PDF 附件；无法精确解析时直接禁用，不猜测父条目附件。
- PDF 划线弹窗提供“添加到 Codex”：点击只把选中文本及 PDF 坐标加入当前附件的内存草稿，自动尝试展开同一 Reader tab 的 Codex 侧栏并聚焦问题输入框，不启动 ACP、不请求模型。多个选区可累积、去重和删除，卡片只显示页码与文本；正在生成时加入的选区留给下一轮发送。按 PDF 禁用划线翻译不会关闭此入口。
- 每个 PDF 附件永久绑定一个 Codex session。同一 PDF 的多个 Reader 视图共享状态和单 turn 锁，不同 PDF 可并行对话。
- 第一条真实消息会把源 PDF 原子复制为专用工作区中的 `source.pdf`，再以 `application/pdf` 的 ACP `resource_link` 引用；后续 turn 只发送文本。
- Zotero 重启后，在用户重新加载或首次发送前通过 `session/load` 恢复同一 Codex thread，并用 thread 回放对账本地镜像。交付状态不确定时必须先对账，避免重复发送。
- 支持流式文本、安全 Markdown（标题、强调、列表、引用、表格、代码）和完整的 KaTeX 0.18.4 → Firefox MathML 公式渲染，包括分式、求和上下标、集合运算、重音、根式、矩阵、对齐环境及上下花括号；解析失败时保留原始 TeX，不再输出命令粘连的伪公式。Codex 的 `:codex-file-citation{...}` 与兼容的 `::codex-file-citation{...}` 文件引用会显示为引用胶囊，并且只允许在当前论文工作区内定位。工具和计划卡片在长对话中保持固定高度；流式更新会保留已展开卡片与阅读位置，只有用户原本就在底部时才继续跟随新内容。
- 超宽工具输出、路径和表格被限制在 Item Pane 内，不再把用户消息推到侧栏可视区域之外。
- `execute`、文件读取、图片查看和搜索等常见工具会显示为语义卡片，只呈现安全元数据，不再把内部 ID、时间戳及原始事件 JSON 暴露在界面中；权限审批使用同一套可读展示。完成态 `View Image` 会联合核对工具类型、标题、输入路径、位置和资源链接，再把通过常规文件、25 MiB、扩展名与文件签名校验的 PNG/JPEG/GIF/WebP/AVIF 复制到工作区外的会话媒体目录；SVG、未知格式、路径不一致和伪装文件只显示错误，不回退直读源路径。图片卡片默认折叠，用户展开后才解码本地副本；点击预览可在当前 Zotero 窗口放大，并在适应窗口与 1:1 原始像素间切换。Web Search 会区分多查询搜索、打开网页和页内查找，完整展示 ACP 返回的查询、页面、查找词，以及事件中实际携带的结果标题、摘要或文本；若固定适配器没有传回网页正文或结果摘要，卡片会明确标注协议事件未携带内容。
- Codex 回答和 Web Search 卡片中的 HTTP/HTTPS 链接只在用户点击后通过 Zotero 9.0.6 的 `Zotero.launchURL()` 交给系统默认浏览器；插件不在 Item Pane 内导航，也不允许其他 URL scheme。
- Codex 思考增量中的最新非空状态行会显示在输入框上方的加载栏中；空白分隔块被忽略，历史思考不再堆成可展开卡片，任务结束后加载栏自动隐藏。
- 设置页提供默认关闭的“开发者模式”。只有开启后，Codex 侧栏才显示“复制日志”按钮，并在内存中记录当前实时 turn 的工具调用与思考事件；关闭后立即清空且停止采集。日志会脱敏用户主目录和常见密钥字段，并限制事件、字符串及集合大小，但复制前仍应检查其中的命令、路径和工具输出。
- 首轮实际发送给 ACP 的论文安全边界和 `resource_link` 只作为协议上下文保存；用户消息气泡始终只显示用户输入的问题，远端回放也会做同样的展示归一化。
- 选区在真正发送时才以版本化 JSON 文本交给本机 Codex，包含 `pageIndex`、页码、页标签、单页或跨页矩形坐标，并明确把选区文字标记为不可信论文数据而非指令。已发送消息的本地镜像和 `session/load` 回放会恢复可读问题与选区卡片；旧纯文本历史保持原样。
- 设置页的模型与推理强度只作为新会话默认值；首条消息发送前即可在侧栏为当前 PDF 单独选择，创建后也可继续修改同一个 session。模型变化时会使用该模型实际支持的推理强度列表。
- 支持 ACP 权限请求和表单 elicitation。命令、cwd、主机、读写位置及适配器提供的授权选项会在侧栏显示；插件不会自动批准。
- Codex 生成文件留在该 PDF 的专用工作区，不覆盖 Zotero PDF、不修改条目、不自动导入附件。

独立 Reader 窗口不提供 Codex 侧栏；当前目标是 Zotero 主窗口中的 Reader tab。

## 配置本机 Codex

在 Zotero 设置中打开 “Smart Paper Translator” 的“本地 Codex（ACP）”区块：

1. 点击“自动探测本地路径”，或分别选择 Node、`npx-cli.js` 与 Codex 的绝对路径。插件不依赖 Finder 启动 Zotero 时常常缺失的 NVM/PATH。
2. 点击“重新检测”会运行本地版本与登录检查；若固定适配器已经准备好，还会用一个不发送提示词的临时空 session 读取动态模型选项，随后通过 `session/close` 释放它。这个动作不调用 `session/delete`、不下载依赖，也不产生模型生成用量。
3. 首次使用必须明确点击“准备并检测 ACP 1.6.2”。这是唯一允许 npx 下载的入口，执行固定包 `@agentclientprotocol/codex-acp@1.6.2`，随后验证版本、ACP 握手、登录状态、能力和动态模型选项。若失败，设置页会显示阶段、错误代码、目标包、退出码以及脱敏后的 stdout/stderr，便于继续定位。
4. 日常聊天以 npm 离线模式启动已准备的适配器。缓存缺失、路径变化或版本不匹配时直接报错，不静默下载或升级。
5. 模型和推理强度取自适配器返回并原子缓存的动态配置。设置值只提供新 session 默认值；每个 PDF 可在侧栏保存自己的选择，已存在 session 保留自己的选择。保存的选项若已不可用，发送会被阻止，不会静默换模型。
6. 调试侧栏事件时，可在设置页单独开启“开发者模式”。开启后运行一轮对话，再点击侧栏“复制日志”；日志只驻留内存、不会自动写文件或上传。关闭开关会立刻清空已收集内容。

适配器通过 `CODEX_PATH` 使用所选本机 Codex，并继承其账号、配置、全局指令、Skills 与 MCP。插件不保存或展示 token。模式固定为受审批的 `agent`：专用工作区可写、网络默认关闭；代码拒绝启用 `agent-full-access`。

## 对话存储与恢复

本机 Zotero 数据目录下新增：

```text
smart-paper-translator/
├── records/                         # 原有翻译与智能标签缓存
└── codex-acp/
    ├── records/                     # 每个 PDF 的 session 映射与离线对话镜像
    ├── workspaces/                  # 当前 session 的 source.pdf 与生成文件
    ├── tool-images/                 # 按论文/本地会话隔离、不会交给 ACP 的 View Image 副本
    ├── archives/                    # 重建后保留的旧映射和旧工作区
    ├── configuration-catalog.json   # 最近一次显式检测得到的模型/推理选项目录
    └── configuration-workspace/     # 不含论文的临时配置检测工作区
```

- JSON 使用临时文件原子替换；损坏镜像会先生成 `.corrupt-*` 备份再重建。
- Codex thread 是上下文权威来源，本地镜像用于离线展示。thread 缺失时保留本地历史为只读，需用户确认后才能新建会话。
- PDF 大小或修改时间变化时暂停发送。用户可以继续使用旧快照，或归档旧映射与工作区后建立新 session。
- 同一 session 重启或 `session/load` 回放时，工具调用 ID 会重新关联已复制的图片副本；新建会话会删除旧 session 的 `tool-images` 目录，因此旧归档中的图片预览不再保留。
- 若系统找不到 `pdftotext`，插件使用 Zotero 9.0.6 的 `Zotero.PDFWorker.getFullText()` 生成本地 `source.txt` 兜底，但仍保留并引用真实 PDF。

这些文件不参与 Zotero 同步，也不加密。

## 数据与隐私

- 翻译链路与 Codex ACP 链路完全独立。翻译 API Key 仍保存在 Mozilla Login Manager，不写入偏好、JSON 或 XPI。
- 打开 PDF、展开 Codex 侧栏和读取离线镜像不会启动 ACP、下载依赖或产生 Codex 用量。用户发送消息会启动已经准备好的本地适配器；用户明确点击“准备并检测”或“重新检测”也会启动 ACP，并使用临时空 session 更新选项目录，但不发送提示词。
- 未发送的 Codex 问题和 PDF 选区草稿只保存在插件进程内存中，按附件隔离；切换 Reader tab、折叠侧栏或重建视图时保留，发送成功或插件退出时清除。自动展开能力缺失时草稿仍保留，可手动打开 Codex 侧栏。
- 第一条 Codex 消息会把 PDF 的本地快照交给本机 Codex；后续消息只发送文本。同一 thread 中 Codex 仍可读取自己的工作区和上下文。
- `tool-images/<论文标识>/<本地会话标识>/` 位于 ACP 工作区之外，不会作为 cwd、资源、附加目录或软链接交给 Codex；普通界面不显示源文件绝对路径，只渲染完成校验的受控副本。
- 本机 Codex 的 Skills/MCP 可能访问论文之外的数据或服务；实际访问仍受 Codex 配置、沙箱和逐次权限审批约束。
- 原始 HTML 不会渲染，远程图片不会自动加载；Markdown、公式、Codex 指令、工具输出和权限详情均通过受限 DOM/MathML 节点显示，不使用 `innerHTML`。公式由 XPI 内置 KaTeX 离线转换，使用 `trust: false`、有限宏展开与尺寸上限，只导入不含外部元素、链接或资源属性的 MathML。HTTP/HTTPS 链接只在明确点击后交给系统浏览器，网页访问不发生在插件渲染过程中。
- 开发者模式默认关闭。开启时只收集当前实时 turn 的工具与思考事件，不收集用户消息或最终回答；内存日志采用有界环形缓冲并做密钥和用户目录脱敏，关闭模式、重建会话或退出插件时清空。
- 翻译请求继续使用匿名 Cookie 容器、60 秒超时和 `logBodyLength: 0`，不把论文正文写入 Zotero HTTP 调试日志。
- 已禁用划线翻译的 PDF 附件 ID 列表只保存在本机 Zotero 偏好中，不写入条目或 Zotero 原生 Tags。

## 开发与验证

插件 XPI 不捆绑 Node、npm 缓存或 codex-acp 包；它只额外内置 MIT 许可的 KaTeX 0.18.4 单文件解析器，不含 KaTeX CSS、字体或运行时网络加载。开发检查需要 Node.js 22、Python 3 和 Info-ZIP：

```bash
npm run check
sh scripts/build.sh
shasum -a 256 -c dist/SHA256SUMS
unzip -t dist/smart-paper-translator-0.1.23.xpi
```

真实 npx 下载、Codex 用量测试、插件安装和 UI 冒烟测试不属于自动构建；这些操作需要分别明确授权。真实 E2E 应使用合成 PDF，不发送用户论文。
