# Zotero 9 → 10 迁移

适用于主版本迁移、清单兼容报错和 Zotero 10 Reader/PDF.js 调试。先读[官方 Zotero 10 开发说明](https://www.zotero.org/support/dev/zotero_10_for_developers)，再按插件实际用到的接口检查；未使用的功能无需引入迁移代码。

资料核对日期：2026-09-29。本文的原生经验来自 macOS **Zotero 10.0.4 / Gecko 140.15.0**，旧客户端经验来自 **9.0.6 / Gecko 140.12.0**，不代表其他补丁版本或平台已验证。

## 先定位兼容性阻断

读取客户端精确版本、现有清单和原生解析结果。旧包上限为 `9.0.*` 时，10.0.4 可能被清单拒绝；仍需检查受影响接口与私有桥，再按官方说明将上限设为 `10.0.*`。保留已有最低版本时，同时保留旧版分支与回归覆盖。

区分三个范围：清单允许加载的版本、实际运行验证过的客户端、私有功能开放的版本。比如本项目清单支持 `9.0`–`10.0.*`，截图桥只开放 `9.0.6` / `10.0.4`；其他插件应根据自己的实现与验证选择范围。

## 按实际调用查官方变更

Zotero 9/10 同用 Firefox 140 ESR，并不意味着 Zotero API 不变。迁移时用下表定位相关官方章节：

| 源码中涉及的部分 | 需要核对的行为 |
|---|---|
| 分类选择 getter、`collectionTreeRow` | 新版支持多选。采用数组接口，明确操作全部选中项还是要求单选，不随意取第一个。 |
| `itemsView`、`getRow()`、`_rows` | 核对 `viewMode`、`collectionTreeRows` 和 `isObjectRow`；标题/间隔行不能当条目。 |
| 搜索、全文索引、数据库 | 检查旧条件/API 是否仍存在，避免依赖旧表布局或只复制启用 WAL 的主数据库文件。 |
| Cookie 隔离、HTTP 返回值、本机 API | 查看 `newCookieContext()`、下载响应与本机请求头/版本语义；不要为兼容关闭安全限制。 |
| 条目修改、Fluent 注册 | 根据实际写入操作核对校验与撤销；让标准插件本地化机制处理语言回退。 |

优先保持公开 `Reader.registerEventListener()`、`Reader.getByTabID()`、`ItemPaneManager`、`ItemTreeManager` 和 `PreferencePanes` 集成。用源码确认参数与调用方，原生探针确认所需行为；仅检查 `typeof ... === "function"` 不等于完整功能通过。

## Reader / PDF.js 私有桥

本机 10.0.4 的 `app/omni.ja` 中：

- `chrome/content/zotero/xpcom/reader.js` 展示 Reader 事件、文档域和 `getByTabID()` 的实际连接方式。
- `resource/reader/reader.js` 的 `_lastView` 会选择当前交互视图，Reading Mode 的 SDT 重排视图可覆盖基础 PDF 视图。这是内部实现，不是公开 API。
- `resource/reader/pdf/build/pdf.mjs` 可核对当前 `PDFPageProxy.getViewport()` / `render()` 参数；同时查看 Reader 中的调用方。

依赖这类字段的截图功能应在读取私有对象前检查精确版本，并核对当前视图的 PDF.js 文档、页面和容器。重排模式缺少原页能力时禁用截图、保留草稿，不能改取后台隐藏 PDF 或屏幕图像。论文关联仍从当前 `tabID → Reader.getByTabID() → itemID` 精确确认。

Xray 包装、域内参数对象与隔离模块加载方法见 [源码与调试参考](source-and-debugging.md)。不要因为诊断脚本的作用域或宿主 API 不完整而修改正常的插件实现。

## 验证应覆盖实际行为

1. 运行既有测试，并补上此次变化的边界，例如已支持版本、未验证补丁/beta、无 PDF.js 能力的重排视图，以及旧版本分支。
2. 构建后检查运行时文件与源码字节一致、ZIP 根目录和哈希，再让目标客户端解析最终 XPI。旧包与新包的对照有助于分辨清单阻断，但不代替功能验证。
3. 涉及截图时，在实际 PDF.js 域中加载无外部资源的合成 PDF，验证输出 PNG 签名、尺寸和已知颜色像素。只观察用户 Reader 的桥接结构即可，不必保存或上传用户论文来证明渲染链路。
4. 在 `finally` 中释放合成文档/加载任务、临时画布和自建监听器；只清理探针自己的资源，不关闭用户 Reader 或会话。

10.0.4 上的本项目探针从最终 XPI 加载截图模块，用红蓝矩形合成 PDF 验证了 PNG 与像素输出；同时验证了包内 D3/主题的 UTF-8 读取。这些是受控子系统证据。完整安装、聊天、启停和重启仍需各自的实际验收，不应从原生解析成功推断出来。
