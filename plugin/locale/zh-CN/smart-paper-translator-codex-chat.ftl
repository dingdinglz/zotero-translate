smart-paper-translator-codex-chat-pane-header =
    .label = Agents
smart-paper-translator-codex-chat-pane-sidenav =
    .tooltiptext = Agents
smart-paper-translator-codex-mermaid-rendering = 正在渲染 Mermaid 图表…
smart-paper-translator-codex-mermaid-source = 查看 Mermaid 源码
smart-paper-translator-codex-mermaid-error = Mermaid 渲染失败，已在下方保留源码。
smart-paper-translator-codex-mermaid-image =
    .alt = Mermaid 图表

smart-paper-translator-agents-selector = Agent
smart-paper-translator-agents-messages =
    .aria-label = 对话消息
smart-paper-translator-agents-access = 权限
smart-paper-translator-agents-approval = 审批模式
smart-paper-translator-agents-full = Full Access
smart-paper-translator-agents-full-hint = Full Access 允许操作工作区外的文件和联网，仅作用于当前 Codex 会话。
smart-paper-translator-agents-pi-access = Pi 按本机配置直接执行工具；这里不提供 Codex 的审批模式。扩展发出的交互请求仍需回应。
smart-paper-translator-agents-pi-title = 本地 Pi（ACP）
smart-paper-translator-agents-pi-thinking = 思考档位随模型变化，支持的模型可选择 max。更新插件后请重新检测 Pi，以刷新选项。
smart-paper-translator-agents-pi-setup = 沿用本机 Pi 的登录、模型及扩展配置；共用上方公共运行环境中的 Node / npx。先在终端配置 Pi，再准备固定版本 pi-acp 0.0.33。
smart-paper-translator-agents-browse = 选择…
smart-paper-translator-agents-default-model = 新会话默认模型
smart-paper-translator-agents-default-thinking = 新会话默认思考强度
smart-paper-translator-agents-detect = 自动探测本地路径
smart-paper-translator-agents-inspect = 重新检测
smart-paper-translator-agents-pi-prepare = 准备并检测 pi-acp 0.0.33
smart-paper-translator-agents-runtime = 本机运行时
smart-paper-translator-agents-catalog = 模型选项目录
smart-paper-translator-agents-status = 状态
smart-paper-translator-agents-pi-offline = 准备按钮是唯一允许下载 pi-acp 的入口。检测只创建空会话，不发送提示词；聊天启动使用已准备的软件和 Pi 离线启动设置。需要 Pi 0.85.1 或更新版本。
smart-paper-translator-agents-inherit = 跟随 { $agent } 当前值（{ $value }）
smart-paper-translator-agents-options-unavailable = 尚未读取选项，请准备或重新检测 ACP
smart-paper-translator-agents-ready = 已准备
smart-paper-translator-agents-pi-needs-setup = 请配置 Pi 并准备适配器
smart-paper-translator-agents-working = 正在检测…
smart-paper-translator-agents-not-prepared = 尚未准备 { $adapter } { $version }。请先到插件设置执行“准备并检测”。
smart-paper-translator-agents-generating = { $agent } 正在生成…
smart-paper-translator-agents-connecting = 正在连接本地 { $agent }…
smart-paper-translator-agents-thinking = { $agent } 正在思考…
smart-paper-translator-agents-model = 模型
smart-paper-translator-agents-thinking-label = 思考
smart-paper-translator-agents-input =
    .placeholder = 围绕当前 PDF 向本机 { $agent } 提问…

smart-paper-translator-agents-overview = Reader 右侧“Agents”使用本机 Agent 登录和配置，与上方翻译 API 完全独立。打开 PDF 或展开侧栏不会启动 ACP、下载依赖或产生模型用量。

smart-paper-translator-agents-default-mode = 默认模式

smart-paper-translator-agents-codex-mode-info = 新建 Codex 会话默认使用审批模式；可在 Agents 侧栏按会话选择 Full Access，允许操作工作区外文件及联网。

smart-paper-translator-agents-privacy = Agents 首次发送时将 PDF 副本交给当前 Agent；后续发送问题及明确添加的选区和截图。Codex/Pi 的对话与媒体各自存储在本机，插件不自动修改 Zotero 条目或导入附件。Full Access 和 Pi 可操作工作区外文件并联网，专用工作区不是这两种执行方式的沙箱。

smart-paper-translator-agents-developer-checkbox =
    .label = 在 Agents 侧栏显示“复制日志”按钮
smart-paper-translator-agents-settings-title = Agents（ACP）
smart-paper-translator-agents-shared-runtime = 公共运行环境
smart-paper-translator-agents-shared-runtime-help = Codex 和 Pi 共用这里选择的 Node 与 npx；下方 Tab 只配置各自的 Agent。Pi 需要 Node 22.19.0 或更新版本。
smart-paper-translator-agents-shared-detect = 刷新路径列表
smart-paper-translator-agents-shared-inspect = 检测 Node / npx
smart-paper-translator-agents-settings-tabs =
    .aria-label = Agent 配置
smart-paper-translator-agents-codex-title = 本地 Codex（ACP）
smart-paper-translator-agents-codex-detect = 刷新路径列表
smart-paper-translator-agents-pi-detect = 刷新路径列表
smart-paper-translator-agents-runtime-unchecked = 尚未检测
smart-paper-translator-agents-shared-checked = 已检测所选 Node / npx；Agent 要求在各自 Tab 中检测。
smart-paper-translator-agents-shared-needs-inspect = 请选择或探测路径，然后检测 Node / npx。
smart-paper-translator-agents-path-candidates =
    .aria-label = { $name } 路径候选
smart-paper-translator-agents-path-manual = 手动输入或浏览…
smart-paper-translator-agents-path-help = 自动列出 PATH、NVM 和常见安装位置；可下拉选择，也可编辑路径或浏览文件。刷新列表不会执行程序或改变已选路径。
smart-paper-translator-agents-paths-scanning = 正在查找本机安装…
smart-paper-translator-agents-paths-found = 已找到 { $count } 个路径候选；保留当前选择。
smart-paper-translator-agents-paths-empty = 未找到安装，可手动输入路径或浏览文件。
smart-paper-translator-agents-paths-error = 无法读取候选路径，仍可手动输入或浏览文件。
smart-paper-translator-agents-path-option =
    { $source ->
        [configured] 当前配置 · { $path }
        [nvm] NVM { $version } · { $path }
        [path] PATH · { $path }
        [node] 所选 Node · { $path }
       *[standard] 常见位置 · { $path }
    }

smart-paper-translator-agents-session-mode = 运行模式
smart-paper-translator-agents-opencode-title = 本地 OpenCode（原生 ACP）
smart-paper-translator-agents-opencode-setup = 沿用本机 OpenCode 的登录、模型、权限及扩展配置，不需要 Node / npx。需要 OpenCode 1.18.30 或更新的 1.x。检测不发送提示词，也不下载依赖。
smart-paper-translator-agents-opencode-thinking = 模型、思考档位和运行模式由 OpenCode 提供。程序升级或本机配置改变后，请重新检测；依赖缺失时请先在终端准备。
smart-paper-translator-agents-opencode-detect = 刷新路径列表
smart-paper-translator-agents-opencode-inspect = 检测 OpenCode
smart-paper-translator-agents-opencode-offline = 原生启动使用本机 OpenCode，禁用自动升级与依赖下载。检测使用独立临时数据库和空会话，结束后清理；不会创建模型回复或修改原有 OpenCode 会话。
smart-paper-translator-agents-opencode-access = OpenCode 按本机配置执行工具；需要授权时会在当前对话中询问。运行模式仅作用于当前论文会话。
smart-paper-translator-agents-opencode-needs-setup = 请在插件设置中选择本机程序并检测 OpenCode。
