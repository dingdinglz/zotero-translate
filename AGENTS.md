# Smart Paper Translator 项目指南

本文件适用于仓库根目录及其所有子目录。

## 开发前强制步骤

在检查、设计、修改、调试、打包或验证 Zotero 插件代码之前，必须先完整加载并阅读：

`./.agents/skills/develop-zotero-plugins/SKILL.md`

随后按照该 Skill 的路由说明，读取本次任务需要的 references。不得仅凭通用 WebExtension 或旧版 Zotero 经验推断 Zotero 9 API。

## 项目概要

- 插件名称：Smart Paper Translator
- 插件 ID：`smart-paper-translator@zotero.local`
- 当前版本：`0.1.37`
- 目标平台：macOS Zotero 9.0.6
- 清单兼容范围：Zotero `9.0`–`9.0.*`
- 插件源码根目录：`plugin/`
- 最终 XPI 中只能包含 `plugin/` 下的运行时文件，不得包含 `.agents/`、测试、文档或构建工具。
- 未经用户明确授权，不得安装插件、修改 Zotero profile、运行真实 npx 下载，或使用真实 API Key/Codex 发起模型请求。
- 内置 Agent 只允许 `codex` / `pi`；适配器分别固定为 `@agentclientprotocol/codex-acp@1.6.2` / `pi-acp@0.0.33`。只有设置页“准备并检测”可联网准备，聊天启动必须使用离线 npm 模式，不得静默下载或升级。
- Codex 动态模型选项检测使用不发送提示词的临时空 session，并以 `session/close` 释放；不得为清理该空 session 调用会归档 thread 的 `session/delete`。Pi 必须用独立连接检测，无提示词，结束后关闭进程；不得套用 Codex 的 `--version`、`authentication/status`、`session/close`。
- Codex 新会话默认受审批的 `agent`，用户可在当前论文的 Codex 会话中选择 `agent-full-access`。Full Access 明示允许工作区外文件操作与联网；已有会话恢复保存的模式，切换收到成功响应后才持久化，失败必须阻止使用未确认权限。不得把会话权限升级为插件全局授权。
- ACP 设置共用一个 Node / npx 运行环境，Codex 与 Pi 用 Tab 分开配置自身路径、模型和准备状态；公共路径继续使用旧 `codexNodePath` / `codexNpxCliPath` 偏好键以保留升级配置。选择的 Node 目录必须排在子进程 PATH 首位，Agent 路径探测不得覆盖公共路径；公共版本检测只运行本机 `--version`，不启动 ACP 或下载。检测期间锁住公共及 Agent 配置，Tab 切换只显示本地面板；窗口销毁后丢弃迟到结果。版本不满足、进程失败及无法读取版本必须区分并保留具体诊断。
- 路径控件必须同时提供本地候选下拉、手动输入及浏览文件，打开设置自动只读枚举当前进程 PATH、默认/自定义 NVM（含 `NVM_DIR` / `XDG_CONFIG_HOME`）和常见位置；NVM 目录按版本数字排序，每个来源最多 128 个目录，去重并过滤非常规文件。只读解析 npm 的 `npx → npx-cli.js` 软链接，不运行 shell 启动脚本或候选程序。刷新不得覆盖现有/手动路径。文件选择必须使用 Zotero `chrome://zotero/content/modules/filePicker.mjs`，传入当前设置窗口；由仍存活的设置视图提交选择结果，取消或关闭后不写偏好。
- Pi 首版验证目标为本机 Pi `0.85.1`，离线启动要求 Pi >= 0.85.1 / Node >= 22.19.0；使用 `PI_ACP_PI_COMMAND` 选择本机 Pi，设置 `PI_OFFLINE=1`、`PI_TELEMETRY=0`、`PI_SKIP_VERSION_CHECK=1`。用初始化响应校验 pi-acp 版本；`model` / `thought_level` 分别映射模型与思考强度，Pi `mode` 不作为权限。扩展交互请求必须保留。
- Pi `max` 兼容补丁只在插件启动的 Node 进程中生效：`pi-acp-compat.js` 用 Node `module.registerHooks()` 对固定 `pi-acp@0.0.33` 入口做内存转换，先检查包名、版本及 SHA-256；源码不符必须失败，不得修改 npm 缓存、全局 Pi 或静默下载。`get_available_thinking_levels` 是当前模型档位的唯一来源，设置后必须回读 `get_state` 确认；不支持的档位和无效响应必须拒绝，不得补造 `max` 或回退成 `medium`。独立配置探测按模型读取档位，不发送提示词；兼容修订变更只失效 Pi 的选项目录，保留会话与已准备状态。恢复先应用保存的模型再校验思考档位，配置中的中间通知不得覆盖尚未确认的选择。
- Agents 每篇论文记住当前 Agent（默认 Codex）；历史、模型、思考、文字/选区/截图草稿均按论文和 Agent 隔离。切换只加载本地历史，连接、生成、授权和停止期间禁用 Agent/权限切换；截图捕获绑定启动时的 Agent。异步视图回调必须复核附件、Agent 与请求序号。
- Pi 每篇论文懒创建独立 ACP 连接，避免单连接 session 替换影响其他论文；无 Reader 引用的空闲连接回收，重新发送用持久 session 恢复。探测连接独立；退出清理所有连接及子进程。
- 原 Codex 数据在 `codex-acp/` 原路径兼容升级，旧记录缺失 agentId 时视为 Codex，保留 session ID、工作区与图片引用；Pi 使用 `pi-acp/` 独立目录。重建只影响当前 Agent；文字/选区草稿仅内存，截图草稿沿用本机恢复与删除规则。
- Agents 消息区必须显式启用原生文本选择与复制；有选区时只延后当前论文/Agent/本地会话的消息 DOM 重绘，状态与停止/授权控件继续更新。选区取消后立即显示最新状态；切换论文、Agent、会话或重新加载不得被旧选区阻塞，窗口/视图销毁时移除监听器。
- Agents 侧栏模型/思考控件使用单列布局，选中全名可换行；保留原生 select 的菜单和键盘语义，展示副本设为 `aria-hidden`，配置失败同步恢复原值，忙碌状态同时禁用原生控件和更新展示样式。不得以裁切、省略号或仅悬停提示代替完整名称。
- Agents Item Pane 只能用 `tabID → Zotero.Reader.getByTabID()` 精确解析 Reader PDF 附件；失败时禁用，不得猜测父条目附件。独立 Reader 窗口不注册聊天。
- PDF 选区加入 Codex 必须再次用 `tabID → Zotero.Reader.getByTabID() → itemID` 精确复核附件，只复制白名单文本与有限数值 PDF 坐标；未发送草稿仅驻留内存并按附件隔离，精确坐标只在用户发送时交给本机 Codex。侧栏自动展开只能操作同一 tab 的 `item-details`，能力缺失时保留草稿并失败关闭。
- PDF 截图只能通过同一 `tabID → Zotero.Reader.getByTabID() → itemID` 映射加入对应 Codex 草稿。Zotero 9.0.6 的私有 PDF.js 原页渲染桥必须隔离在 `pdf-screenshot.js`、精确版本检查并失败关闭；不得退回屏幕抓图或携带界面/批注。桥接代码不得把特权回调直接传入 PDF.js 内容域数组方法，PDFPageProxy 只能受控解包，`getViewport()`/`render()` 参数必须在目标 iframe 域内创建。跨页框选按页面拆图，图片和可复现 PDF 位置在用户发送时分别作为 ACP 图片块与受边界保护的 JSON 交给 Codex。截图副本只能保存在 ACP 工作区外的 `screenshots/论文标识/本地会话标识`；未发送草稿需可恢复，移除即清理，已发送副本随会话保留，重建会话统一删除。单图和单轮资源上限不得绕过，模型不支持图片时必须原子保留草稿并阻止发送。
- Codex 消息中的文件引用只能在当前 PDF 的专用工作区内定位；不得让模型输出的路径越过工作区边界。首轮安全前缀和资源链接不得作为用户问题显示。
- Agents 的 `visualize` 标记只可读取当前论文、当前 Agent、当前本地会话工作区内不超过 1 MiB 的 UTF-8 HTML 常规文件，逐级拒绝软链接；切换论文、Agent、会话、重绘和销毁后丢弃迟到结果并清理预览。HTML 只能交给双层 `sandbox="allow-scripts"` 的不透明源 iframe；外层只运行插件固定桥接代码，以 `frame-src 'none'` 阻止内层导航，内层 CSP 禁止网络、外部资源、表单、弹窗和子资源。不得开放同源权限或把模型 HTML/JS 注入 Zotero 文档或特权 sandbox。固定 D3 7.9.0 随 XPI 内置，脚本和主题必须用 `Zotero.File.getResourceAsync()` 读取 UTF-8 文本并校验返回类型，不得把 `getContentsAsync(jarURI)` 返回的请求对象字符串化。只替换明确支持的固定 CDN 引用，不在运行时联网；其他外部脚本报错并保留原标记。外层在内层开始解析前注册消息监听，只接收精确 child/source 与随机 token 匹配的有界状态/尺寸和关闭通知；Gecko 禁止内容页调用特权窗口的 `postMessage`，原生侧须捕获所属 iframe 的内容 load 事件，再读取并观察外层固定状态属性，复核当前 frame/document/token，限制 JSON 长度并在清理时断开观察器。不得读取内层模型 DOM 作为状态源、向内容域暴露特权回调，或接受工具、文件及链接操作。生成、连接、等待授权和停止期间不创建预览或读取 HTML，回复结束后渲染，避免流式重绘反复启动脚本。当前消息区最多同时预览 4 个图表，放大层最多增加 1 个；加载超时后移除 iframe，关闭支持按钮、背景点击和 Escape（含图表焦点）。
- Codex 文本与 Web Search 卡片中的外部链接只能接受 HTTP/HTTPS，必须在用户点击后通过 `Zotero.launchURL()` 交给系统默认浏览器；不得在 Item Pane 内导航、自动打开链接或加载远程图片。Codex 文件引用需兼容单冒号 `:codex-file-citation{...}` 与双冒号格式，并继续执行工作区边界检查。
- 完成态 View Image 只能在状态、read 语义、标题、输入路径、位置和资源链接相互印证后处理；源文件必须是 25 MiB 以内且扩展名与签名一致的 PNG/JPEG/GIF/WebP/AVIF 常规文件，拒绝 SVG。副本只能写入 ACP 工作区外的 `tool-images/论文标识/本地会话标识`，不得作为 cwd、资源、附加目录或软链接交给 Codex；界面不得回退渲染源路径。卡片默认折叠并在展开后才解码，放大层必须支持关闭按钮、背景点击、Escape 以及适应窗口/1:1 切换。重建会话必须删除旧会话图片目录。
- Codex 公式固定使用 XPI 内置 KaTeX `0.18.4` 生成 MathML；必须保持 `trust: false`、宏展开/尺寸上限、每公式独立宏环境和 MathML 外部元素/资源属性过滤。不得使用 `innerHTML`、远程公式服务、运行时 CDN、KaTeX HTML 输出或可加载资源的可信命令。
- Codex Mermaid 固定使用 XPI 内置 Mermaid `11.16.1`，只在出现 `mermaid` fenced code block 时按窗口延迟加载，不得使用 CDN 或运行时下载。由于 Zotero Item Pane 属于无 `body` 的 XUL 文档，运行时必须留在同窗口的本地 `about:blank` HTML iframe 与专用 Gecko sandbox 中；sandbox 必须以该 HTML 窗口为原型继承只读的 `window`/`document`，不得再次赋值，关闭插件时移除 iframe 并丢弃 sandbox 引用；不得在 Zotero 9.0.6 调用 `Cu.nukeSandbox()`。必须保持 `securityLevel: strict`、`htmlLabels: false`、安全配置锁定、源文本/边数/超时/SVG 大小与节点数上限。返回 SVG 只允许 Mermaid flowchart 生成的本地 `feDropShadow` 滤镜，不得放行其他滤镜原语，并继续拒绝活动元素、HTML、链接和非本地资源引用；结果需写入最长边不超过 4096 像素的固有尺寸并序列化为隔离的数据图片，宽图在侧栏横向滚动，不得作为活动 SVG 注入 Item Pane。解析、超限或安全校验失败时必须保留原始源码。
- Codex 开发者模式必须默认关闭；关闭时不得采集或保留额外的可复制诊断日志，也不得显示复制入口。开启后仅允许在内存中有界记录当前实时 turn 的工具与思考诊断事件，脱敏常见密钥和用户主目录，不得自动落盘或上传；关闭模式、重建会话和插件退出必须清空。
- 悬浮面板术语删除仅清理当前论文中同一规范化原文的全部 selection 缓存配置变体；原子写入成功后更新列表与计数，不改摘要、智能标签或其他论文。删除必须使此前在途的对应划线请求及缓存探测失效，防止旧结果恢复缓存；异步列表刷新和删除回调复核 Reader、论文与请求序号，失败保留术语并允许重试。
- 当前 PDF 的划线翻译禁用开关默认关闭，禁用附件 ID 列表仅持久化在本机 Zotero 偏好中；命中禁用状态时不得追加插件划线翻译 UI、查询划线缓存或发起翻译请求，且不得影响其他 PDF 或独立的“添加到 Agents”入口。

上述 PDF/媒体/Markdown/外链/公式/Mermaid/开发者日志边界同样适用于 Pi；Codex View Image 的形状识别只作用于 Codex 工具事件，不得猜测 Pi 输出文件路径。

## 当前项目结构

```text
zotero-translate/
├── AGENTS.md                         # 本项目开发约束与结构说明
├── README.md                         # 英文主介绍：Agents 侧栏、安装配置、界面截图与数据说明
├── README.zh-CN.md                   # 中文介绍，与英文主版对应
├── package.json                      # Node 测试和静态检查入口
├── .gitignore
├── .agents/
│   └── skills/
│       └── develop-zotero-plugins/   # Zotero 插件开发 Skill 及参考资料
├── docs/
│   ├── screenshots/                 # 中英文 README 共用的 Zotero 实际界面截图
│   │   ├── agent-settings.png       # 公共运行环境与 Pi 模型、适配器准备状态
│   │   ├── paper-context.png        # 对话中展开的 PDF 截图、页码与问题
│   │   ├── sidebar-overview.png     # PDF 框架图与 Agents 侧栏全景
│   │   └── sidebar-results.png      # PDF 原文旁的 Agents 交互图表
│   └── technical-reference.zh-CN.md  # 详细功能、配置、实现边界与历史验证记录
├── plugin/                           # XPI 的唯一运行时源码根目录
│   ├── manifest.json                 # 插件清单、ID、版本和兼容范围
│   ├── bootstrap.js                  # Zotero bootstrapped 生命周期入口
│   ├── prefs.js                      # 默认偏好设置
│   ├── locale/
│   │   ├── en-US/smart-paper-translator-codex-chat.ftl   # Agents Item Pane / ACP 设置英文本地化
│   │   └── zh-CN/smart-paper-translator-codex-chat.ftl   # Agents Item Pane / ACP 设置中文本地化
│   └── content/
│       ├── constants.js              # 常量、默认服务、默认 Prompt 与工具/截图安全上限
│       ├── agent-providers.js        # Codex/Pi 固定注册表、配置映射、默认权限与 Reader 双语入口
│       ├── logic.js                  # 模板、术语与智能标签解析、URL 和签名逻辑
│       ├── credentials.js            # Mozilla Login Manager 密钥存储
│       ├── cache.js                  # 译文与智能标签持久化、原子新增/替换/术语删除和损坏恢复
│       ├── chat-cache.js             # 按 Agent 隔离的 session/镜像、旧 Codex 兼容及工作区/媒体生命周期
│       ├── pdf-screenshot.js         # Zotero 9.0.6 原页框选/跨页拆图、PDF 坐标映射、PNG 渲染校验与资源保护
│       ├── api.js                    # OpenAI Chat Completions 客户端与安全错误映射
│       ├── service.js                # 翻译、摘要、智能标签、缓存探测/强制刷新、术语删除及在途失效
│       ├── pi-acp-compat.js          # 固定 Pi 适配器哈希校验、Node 内存补丁、按模型读取档位与确认 max
│       ├── acp-client.js             # 双适配器准备/离线启动、Pi 补丁入口、版本检查、stdio 与进程清理
│       ├── codex-chat.js             # 共用聊天核心、每 PDF/Agent session、模型/权限/媒体边界与会话绑定图表读取
│       ├── agents-chat.js            # 当前 Agent 偏好、服务路由、Pi 每论文连接/引用与独立探测生命周期
│       ├── math-renderer.js          # KaTeX→MathML、有界不可信输入与安全导入/原始 TeX 回退
│       ├── mermaid-renderer.js       # Mermaid XUL/HTML sandbox、串行缓存、有界 SVG 校验与数据图片
│       ├── visualize-renderer.js     # visualize 标记、工作区 HTML 校验、双层无网络 iframe、UTF-8 资源、原生状态观察与预览清理
│       ├── visualize-theme.css       # 隔离图表的本地明暗主题与基础控件样式
│       ├── codex-chat-ui.js          # Agents Item Pane、配置/权限切换、文本选择保持、安全 Markdown 与 visualize 预览路由
│       ├── codex-chat.css            # Agents 配置/权限、消息选择、Mermaid/媒体及图表预览和放大层样式
│       ├── codex.svg                 # 旧 Codex 单色图标（保留历史资源）
│       ├── agents.svg                # Agents Item Pane/Sidenav 中性对话图标
│       ├── vendor/
│       │   ├── d3/
│       │   │   ├── d3.min.js         # D3 7.9.0 离线图表运行时，仅在隔离内容域运行
│       │   │   ├── LICENSE.txt       # D3 ISC 许可证
│       │   │   └── README.md         # 固定版本、npm 来源、哈希与网络隔离边界
│       │   ├── katex/
│       │   │   ├── katex.min.js      # KaTeX 0.18.4 离线单文件运行时
│       │   │   ├── LICENSE.txt       # KaTeX MIT 许可证
│       │   │   └── README.md         # 版本、来源、摘要与集成边界
│       │   └── mermaid/
│       │       ├── mermaid.min.js    # Mermaid 11.16.1 离线浏览器运行时
│       │       ├── LICENSE.txt       # Mermaid MIT 许可证
│       │       └── README.md         # 版本、来源、哈希与安全集成边界
│       ├── item-tree-ui.js           # 主页智能标签列、本地懒加载索引与列刷新
│       ├── item-tree.css             # 智能标签列、主题色胶囊与无障碍模式样式
│       ├── reader-ui.js              # Agents 选区/截图、划线缓存/重译/禁用、工具栏及悬浮面板术语删除/拖拽缩放
│       ├── reader.css                # Reader 工具栏/截图、Agents 选区、悬浮面板/悬停删除、缩放和划线弹窗样式
│       ├── main.js                   # 翻译/双 Agent 组装、热更新、只读路径枚举与 Zotero FilePicker 桥接
│       ├── preferences.xhtml         # 翻译/公共 ACP 环境、路径候选/编辑/浏览、Codex/Pi Tab 与开发者模式
│       ├── preferences.js            # 设置页路径发现、Tab、按模型思考默认项、互斥检测/准备和迟到回调隔离
│       └── preferences.css           # 设置页路径组合控件、分段 Tab、窄布局与诊断样式
├── tests/
│   ├── helpers.js                    # Zotero、缓存和偏好 mock
│   ├── logic.test.js                 # 模板、术语、URL、签名和论文标识
│   ├── credentials.test.js           # API Key 隔离测试
│   ├── cache.test.js                 # 缓存新增/替换/术语删除、配置与论文隔离、原子写入和损坏恢复
│   ├── chat-cache.test.js            # 旧 Codex 兼容与 Pi 镜像/配置/媒体目录隔离、损坏备份、并发和归档清理
│   ├── pdf-screenshot.test.js         # 原页截图坐标、跨页拆分、跨上下文桥、PNG/缩放、渲染和版本关闭
│   ├── api.test.js                   # 请求结构、隐私和错误映射
│   ├── pi-acp-compat.test.js          # max/能力/确认失败/哈希拒绝；可选现成适配器无提示词验证
│   ├── acp-client.test.js            # PATH/NVM/软链接发现、JSONL、双适配器准备/版本与进程清理
│   ├── agents-chat.test.js           # Agent 切换/偏好、忙碌锁、Pi 每论文连接隔离与探测生命周期
│   ├── codex-chat.test.js            # 权限/Pi 配置、PDF/媒体/日志边界与图表读取的 Agent/会话隔离
│   ├── codex-chat-ui.test.js         # Agent/草稿/文本选择、安全渲染与工具/外链边界、图表标记路由和预览清理
│   ├── math-renderer.test.js         # 公式回归样本、KaTeX 安全选项、MathML 导入过滤与回退
│   ├── mermaid-renderer.test.js      # Mermaid 上限、固定安全配置、SVG 过滤、延迟加载/串行/缓存与回退
│   ├── visualize-renderer.test.js    # 标记/路径/文件限制、离线脚本替换、双层隔离、资源返回类型、启动错误、原生状态与清理
│   ├── main.test.js                  # ACP/Agent 设置桥接、只读发现、FilePicker 选取/取消与偏好作用域
│   ├── preferences.test.js           # 路径下拉/编辑/刷新/迟到结果、Tab/表单保留、忙碌锁与版本错误
│   ├── service.test.js               # 摘要、缓存探测/强制刷新、术语删除/在途失效、并发与取消
│   ├── item-tree-ui.test.js          # 智能标签列、异步刷新、渲染安全与清理
│   └── reader-ui.test.js             # 选区/截图 Agents 入口、划线翻译/禁用、术语删除/重试、Tabs、拖拽缩放和陈旧 UI 防护
├── scripts/
│   ├── build.sh                      # 完整 XPI 构建与归档检查入口
│   ├── build_xpi.py                  # 无依赖、可复现的 XPI 打包器
│   └── validate_static.py            # 清单、XHTML 和安全边界检查
└── dist/                             # 生成的交付物，不是运行时源码
    ├── smart-paper-translator-0.1.37.xpi
    ├── smart-paper-translator-0.1.36.xpi         # 上一版本归档
    ├── smart-paper-translator-0.1.35.xpi         # 历史版本归档
    ├── smart-paper-translator-0.1.34.xpi         # 历史版本归档
    ├── smart-paper-translator-0.1.33.xpi         # 历史版本归档
    ├── smart-paper-translator-0.1.32.xpi         # 历史版本归档
    ├── smart-paper-translator-0.1.31.xpi         # 历史版本归档
    ├── smart-paper-translator-0.1.30.xpi         # 历史版本归档
    ├── smart-paper-translator-0.1.29.xpi         # 历史版本归档
    ├── smart-paper-translator-0.1.28.xpi         # 历史版本归档
    ├── smart-paper-translator-0.1.27.xpi         # 历史版本归档
    ├── smart-paper-translator-0.1.26.xpi         # 历史版本归档
    ├── smart-paper-translator-0.1.25.xpi         # 历史版本归档
    ├── smart-paper-translator-0.1.24.xpi         # 历史版本归档
    ├── smart-paper-translator-0.1.23.xpi         # 历史版本归档
    ├── smart-paper-translator-0.1.22.xpi         # 历史版本归档
    ├── smart-paper-translator-0.1.21.xpi         # 历史版本归档
    ├── smart-paper-translator-0.1.20.xpi         # 历史版本归档
    ├── smart-paper-translator-0.1.19.xpi         # 历史版本归档
    ├── smart-paper-translator-0.1.18.xpi         # 历史版本归档
    ├── smart-paper-translator-0.1.17.xpi         # 历史版本归档
    ├── smart-paper-translator-0.1.16.xpi         # 历史版本归档
    ├── smart-paper-translator-0.1.15.xpi         # 历史版本归档
    ├── smart-paper-translator-0.1.14.xpi         # 历史版本归档
    ├── smart-paper-translator-0.1.13.xpi         # 历史版本归档
    ├── smart-paper-translator-0.1.12.xpi         # 历史版本归档
    ├── smart-paper-translator-0.1.11.xpi         # 历史版本归档
    ├── smart-paper-translator-0.1.10.xpi         # 历史版本归档
    ├── smart-paper-translator-0.1.9.xpi          # 历史版本归档
    ├── smart-paper-translator-0.1.8.xpi          # 历史版本归档
    ├── smart-paper-translator-0.1.7.xpi          # 历史版本归档
    ├── smart-paper-translator-0.1.6.xpi          # 历史版本归档
    ├── smart-paper-translator-0.1.5.xpi          # 历史版本归档
    ├── smart-paper-translator-0.1.4.xpi          # 历史版本归档
    ├── smart-paper-translator-0.1.3.xpi          # 历史版本归档
    ├── smart-paper-translator-0.1.2.xpi          # 历史版本归档
    ├── smart-paper-translator-0.1.1.xpi          # 历史版本归档
    ├── smart-paper-translator-0.1.0.xpi          # 历史版本归档
    ├── smart-paper-translator-0.1.0-source.zip   # 历史版本源码归档
    └── SHA256SUMS
```

主页智能标签列只能读取本机缓存，不得因选择、排序或渲染列表条目发起网络请求；标签不得写入 Zotero 原生 Tags。

## 结构同步规则

任何变更只要满足以下任一条件，就必须在同一次修改中同步更新本 `AGENTS.md`：

- 新增、删除、移动或重命名文件或目录；
- 文件职责、模块边界、入口或数据流发生变化；
- 插件 ID、版本、Zotero 兼容范围或实际验证版本发生变化；
- 测试、构建、打包、验证命令或交付物路径发生变化；
- 新增需要开发者遵守的安全、隐私或安装约束。

完成任务前，应将实际目录与“当前项目结构”重新核对；如果不一致，任务不能视为完成。

## 常用验证命令

```bash
npm run check
sh scripts/build.sh
shasum -a 256 -c dist/SHA256SUMS
```

可选的已准备 Pi 适配器验证：设置 `SPT_TEST_PI_ACP_ENTRY=/absolute/path/to/pi-acp/dist/index.js`，执行 `node --test tests/pi-acp-compat.test.js`。只对现成模块做初始化握手和使用假 Pi RPC 的配置方法验证，不下载、不创建真实 Pi 会话、不调用模型。

涉及运行时文件的修改还必须遵循 `develop-zotero-plugins` Skill：检查 XPI 根目录、运行 `unzip -t`，并在目标 Zotero 版本中使用 `AddonManager.getInstallForFile()` 对最终 XPI 做非安装式解析。实际安装和 UI 冒烟测试需要用户单独授权。
