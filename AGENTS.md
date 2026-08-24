# Smart Paper Translator 项目指南

本文件适用于仓库根目录及其所有子目录。

## 开发前强制步骤

在检查、设计、修改、调试、打包或验证 Zotero 插件代码之前，必须先完整加载并阅读：

`./.agents/skills/develop-zotero-plugins/SKILL.md`

随后按照该 Skill 的路由说明，读取本次任务需要的 references。不得仅凭通用 WebExtension 或旧版 Zotero 经验推断 Zotero 9 API。

## 项目概要

- 插件名称：Smart Paper Translator
- 插件 ID：`smart-paper-translator@zotero.local`
- 当前版本：`0.1.23`
- 目标平台：macOS Zotero 9.0.6
- 清单兼容范围：Zotero `9.0`–`9.0.*`
- 插件源码根目录：`plugin/`
- 最终 XPI 中只能包含 `plugin/` 下的运行时文件，不得包含 `.agents/`、测试、文档或构建工具。
- 未经用户明确授权，不得安装插件、修改 Zotero profile、运行真实 npx 下载，或使用真实 API Key/Codex 发起模型请求。
- ACP 适配器固定为 `@agentclientprotocol/codex-acp@1.6.2`；只有设置页“准备并检测 ACP”可联网准备，聊天启动必须使用离线 npm 模式，不得静默下载或升级。
- 动态模型选项检测使用不发送提示词的临时空 session，并以 `session/close` 释放；不得为清理该空 session 调用会归档 thread 的 `session/delete`。
- Codex 会话必须固定使用受审批的 `agent` 模式；不得启用 `agent-full-access`，不得把 session 权限升级为插件全局授权。
- Codex Item Pane 只能用 `tabID → Zotero.Reader.getByTabID()` 精确解析 Reader PDF 附件；失败时禁用，不得猜测父条目附件。独立 Reader 窗口不注册聊天。
- PDF 选区加入 Codex 必须再次用 `tabID → Zotero.Reader.getByTabID() → itemID` 精确复核附件，只复制白名单文本与有限数值 PDF 坐标；未发送草稿仅驻留内存并按附件隔离，精确坐标只在用户发送时交给本机 Codex。侧栏自动展开只能操作同一 tab 的 `item-details`，能力缺失时保留草稿并失败关闭。
- Codex 消息中的文件引用只能在当前 PDF 的专用工作区内定位；不得让模型输出的路径越过工作区边界。首轮安全前缀和资源链接不得作为用户问题显示。
- Codex 文本与 Web Search 卡片中的外部链接只能接受 HTTP/HTTPS，必须在用户点击后通过 `Zotero.launchURL()` 交给系统默认浏览器；不得在 Item Pane 内导航、自动打开链接或加载远程图片。Codex 文件引用需兼容单冒号 `:codex-file-citation{...}` 与双冒号格式，并继续执行工作区边界检查。
- 完成态 View Image 只能在状态、read 语义、标题、输入路径、位置和资源链接相互印证后处理；源文件必须是 25 MiB 以内且扩展名与签名一致的 PNG/JPEG/GIF/WebP/AVIF 常规文件，拒绝 SVG。副本只能写入 ACP 工作区外的 `tool-images/论文标识/本地会话标识`，不得作为 cwd、资源、附加目录或软链接交给 Codex；界面不得回退渲染源路径。卡片默认折叠并在展开后才解码，放大层必须支持关闭按钮、背景点击、Escape 以及适应窗口/1:1 切换。重建会话必须删除旧会话图片目录。
- Codex 公式固定使用 XPI 内置 KaTeX `0.18.4` 生成 MathML；必须保持 `trust: false`、宏展开/尺寸上限、每公式独立宏环境和 MathML 外部元素/资源属性过滤。不得使用 `innerHTML`、远程公式服务、运行时 CDN、KaTeX HTML 输出或可加载资源的可信命令。
- Codex 开发者模式必须默认关闭；关闭时不得采集或保留额外的可复制诊断日志，也不得显示复制入口。开启后仅允许在内存中有界记录当前实时 turn 的工具与思考诊断事件，脱敏常见密钥和用户主目录，不得自动落盘或上传；关闭模式、重建会话和插件退出必须清空。
- 当前 PDF 的划线翻译禁用开关默认关闭，禁用附件 ID 列表仅持久化在本机 Zotero 偏好中；命中禁用状态时不得追加插件划线翻译 UI、查询划线缓存或发起翻译请求，且不得影响其他 PDF 或独立的“添加到 Codex”入口。

## 当前项目结构

```text
zotero-translate/
├── AGENTS.md                         # 本项目开发约束与结构说明
├── README.md                         # 功能、配置、隐私和开发说明
├── package.json                      # Node 测试和静态检查入口
├── .gitignore
├── .agents/
│   └── skills/
│       └── develop-zotero-plugins/   # Zotero 插件开发 Skill 及参考资料
├── plugin/                           # XPI 的唯一运行时源码根目录
│   ├── manifest.json                 # 插件清单、ID、版本和兼容范围
│   ├── bootstrap.js                  # Zotero bootstrapped 生命周期入口
│   ├── prefs.js                      # 默认偏好设置
│   ├── locale/
│   │   ├── en-US/smart-paper-translator-codex-chat.ftl   # Codex Item Pane 英文本地化
│   │   └── zh-CN/smart-paper-translator-codex-chat.ftl   # Codex Item Pane 中文本地化
│   └── content/
│       ├── constants.js              # 常量、默认服务、默认 Prompt 与工具图片安全上限
│       ├── logic.js                  # 模板、术语与智能标签解析、URL 和签名逻辑
│       ├── credentials.js            # Mozilla Login Manager 密钥存储
│       ├── cache.js                  # 译文与智能标签持久化、原子新增/替换和损坏恢复
│       ├── chat-cache.js             # Codex session/镜像、工作区/归档及工作区外会话图片目录生命周期
│       ├── api.js                    # OpenAI Chat Completions 客户端与安全错误映射
│       ├── service.js                # 翻译、摘要、智能标签、缓存探测/强制刷新及并发协调
│       ├── acp-client.js             # 固定版本准备、脱敏诊断、stdio JSON-RPC、握手、通知、取消与进程清理
│       ├── codex-chat.js             # 每 PDF session、回放、权限、引用边界、View Image 校验复制与内存开发日志
│       ├── math-renderer.js          # KaTeX→MathML、有界不可信输入与安全导入/原始 TeX 回退
│       ├── codex-chat-ui.js          # 原生 Item Pane、安全 Markdown/工具卡片、懒加载图片预览、模态放大及外链
│       ├── codex-chat.css            # Codex 侧栏、工具图片/模态层、消息、Web Search、加载状态与权限表单样式
│       ├── codex.svg                 # Codex Item Pane/Sidenav 单色图标
│       ├── vendor/
│       │   └── katex/
│       │       ├── katex.min.js      # KaTeX 0.18.4 离线单文件运行时
│       │       ├── LICENSE.txt       # KaTeX MIT 许可证
│       │       └── README.md         # 版本、来源、摘要与集成边界
│       ├── item-tree-ui.js           # 主页智能标签列、本地懒加载索引与列刷新
│       ├── item-tree.css             # 智能标签列、主题色胶囊与无障碍模式样式
│       ├── reader-ui.js              # 选区坐标规范化/Codex 入口、划线缓存/重译、禁用开关、工具栏与可拖拽缩放悬浮面板
│       ├── reader.css                # Reader 工具栏开关、Codex 选区操作、悬浮面板、缩放手柄和划线弹窗样式
│       ├── main.js                   # 翻译/ACP 模块组装、多窗口样式、偏好热更新观察者和设置页桥接
│       ├── preferences.xhtml         # 中文设置页结构与默认关闭的 Codex 开发者模式
│       ├── preferences.js            # 设置页翻译密钥、本地 Codex 探测/准备、会话默认项和详细错误交互
│       └── preferences.css           # 设置页样式
├── tests/
│   ├── helpers.js                    # Zotero、缓存和偏好 mock
│   ├── logic.test.js                 # 模板、术语、URL、签名和论文标识
│   ├── credentials.test.js           # API Key 隔离测试
│   ├── cache.test.js                 # 缓存新增/替换、并发、原子写入和损坏恢复
│   ├── chat-cache.test.js            # Codex 镜像/配置/工具图片目录隔离、损坏备份、并发和归档清理
│   ├── api.test.js                   # 请求结构、隐私和错误映射
│   ├── acp-client.test.js            # JSONL、并发请求、超时、取消、崩溃、stderr 与准备边界
│   ├── codex-chat.test.js            # 首轮 PDF/回放、View Image 校验复制、动态配置、权限、重建与日志边界
│   ├── codex-chat-ui.test.js         # 选区/安全渲染、工具图片懒加载与放大、Web Search/外链/引用边界
│   ├── math-renderer.test.js         # 公式回归样本、KaTeX 安全选项、MathML 导入过滤与回退
│   ├── main.test.js                  # 设置桥接、默认配置、Codex 路径探测偏好读写作用域
│   ├── service.test.js               # 摘要、缓存探测/强制刷新、缓存失效、并发与取消
│   ├── item-tree-ui.test.js          # 智能标签列、异步刷新、渲染安全与清理
│   └── reader-ui.test.js             # 选区坐标/Codex 入口、划线自动/手动/重译、按 PDF 禁用、工具栏、Tabs、拖拽缩放和陈旧 UI 防护
├── scripts/
│   ├── build.sh                      # 完整 XPI 构建与归档检查入口
│   ├── build_xpi.py                  # 无依赖、可复现的 XPI 打包器
│   └── validate_static.py            # 清单、XHTML 和安全边界检查
└── dist/                             # 生成的交付物，不是运行时源码
    ├── smart-paper-translator-0.1.23.xpi
    ├── smart-paper-translator-0.1.22.xpi         # 上一版本归档
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

涉及运行时文件的修改还必须遵循 `develop-zotero-plugins` Skill：检查 XPI 根目录、运行 `unzip -t`，并在目标 Zotero 版本中使用 `AddonManager.getInstallForFile()` 对最终 XPI 做非安装式解析。实际安装和 UI 冒烟测试需要用户单独授权。
