# Smart Paper Translator 项目指南

本文件适用于仓库根目录及其所有子目录。

## 开发前强制步骤

在检查、设计、修改、调试、打包或验证 Zotero 插件代码之前，必须先完整加载并阅读：

`./.agents/skills/develop-zotero-plugins/SKILL.md`

随后按照该 Skill 的路由说明，读取本次任务需要的 references。不得仅凭通用 WebExtension 或旧版 Zotero 经验推断 Zotero 9 API。

## 项目概要

- 插件名称：Smart Paper Translator
- 插件 ID：`smart-paper-translator@zotero.local`
- 当前版本：`0.1.5`
- 目标平台：macOS Zotero 9.0.6
- 清单兼容范围：Zotero `9.0`–`9.0.*`
- 插件源码根目录：`plugin/`
- 最终 XPI 中只能包含 `plugin/` 下的运行时文件，不得包含 `.agents/`、测试、文档或构建工具。
- 未经用户明确授权，不得安装插件、修改 Zotero profile 或使用真实 API Key 发起请求。

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
│   └── content/
│       ├── constants.js              # 常量、默认服务和默认 Prompt
│       ├── logic.js                  # 模板、术语与智能标签解析、URL 和签名逻辑
│       ├── credentials.js            # Mozilla Login Manager 密钥存储
│       ├── cache.js                  # 译文与智能标签持久化、原子写入和损坏恢复
│       ├── api.js                    # OpenAI Chat Completions 客户端与安全错误映射
│       ├── service.js                # 翻译、摘要、智能标签、本地缓存探测及并发协调
│       ├── item-tree-ui.js           # 主页智能标签列、本地懒加载索引与列刷新
│       ├── item-tree.css             # 智能标签列、主题色胶囊与无障碍模式样式
│       ├── reader-ui.js              # 划线缓存直显、工具栏图标和可拖拽缩放悬浮面板
│       ├── reader.css                # Reader 按钮、悬浮面板、缩放手柄和划线弹窗样式
│       ├── main.js                   # 模块组装、多窗口样式、观察者和设置页注册
│       ├── preferences.xhtml         # 中文设置页结构
│       ├── preferences.js            # 设置页交互与密钥操作
│       └── preferences.css           # 设置页样式
├── tests/
│   ├── helpers.js                    # Zotero、缓存和偏好 mock
│   ├── logic.test.js                 # 模板、术语、URL、签名和论文标识
│   ├── credentials.test.js           # API Key 隔离测试
│   ├── cache.test.js                 # 缓存、并发、原子写入和损坏恢复
│   ├── api.test.js                   # 请求结构、隐私和错误映射
│   ├── service.test.js               # 摘要、缓存探测、缓存失效、并发与取消
│   ├── item-tree-ui.test.js          # 智能标签列、异步刷新、渲染安全与清理
│   └── reader-ui.test.js             # 缓存直显、工具栏、Tabs、拖拽缩放和陈旧 UI 防护
├── scripts/
│   ├── build.sh                      # 完整 XPI 构建与归档检查入口
│   ├── build_xpi.py                  # 无依赖、可复现的 XPI 打包器
│   └── validate_static.py            # 清单、XHTML 和安全边界检查
└── dist/                             # 生成的交付物，不是运行时源码
    ├── smart-paper-translator-0.1.5.xpi
    ├── smart-paper-translator-0.1.4.xpi          # 上一版本归档
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
