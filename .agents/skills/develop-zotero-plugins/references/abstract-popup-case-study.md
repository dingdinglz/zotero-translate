# 案例：PDF 摘要悬浮窗插件

## 目标

在 Zotero 内置 PDF 阅读器打开论文时，读取 PDF 附件父条目的 `abstractNote`，显示可拖动悬浮窗；阅读器工具栏提供手动开关；设置页控制是否自动常开。

## 开发与排错过程

1. 创建 Zotero 7+ bootstrapped 插件：根目录放 `manifest.json`、`bootstrap.js`，主逻辑放 `content/`。
2. 监听标签页选择/关闭和条目修改事件；根据阅读器 `itemID` 读取附件和父条目。
3. 首个 XPI 的静态检查全部通过，但 Zotero 报“可能无法与该版本兼容”。
4. 不修改兼容范围，先用 AddonManager 原生解析：结果为非零错误且 `addon` 为空。
5. 打开 Error Console，定位真实清单错误：缺少 `applications.zotero.update_url`。
6. 增加 HTTPS 更新地址并升级版本。Zotero 9.0.6 原生解析随后返回 `error: 0`、`isCompatible: true`。
7. 使用 `Zotero.Reader.registerEventListener("renderToolbar", ...)` 添加阅读器工具栏按钮；处理器同步 `append()` 按钮。
8. 在根 `prefs.js` 定义 `alwaysOpen` 默认值；用 `Zotero.PreferencePanes.register()` 添加设置页；用偏好观察者即时关闭或恢复自动弹窗。
9. 为自动模式、手动模式、关闭期间异步请求、缺失父条目、空摘要、工具栏注册和设置注册编写 mock 测试。
10. 对最终交付 XPI 再运行 ZIP 完整性检查和 Zotero 原生解析，不依赖中间构建结果。

## 关键状态模型

每个 Zotero 主窗口维护：

```text
currentTabID
currentAttachmentID
currentParentID
dismissedTabID
manualOpenTabID
requestSerial
toolbarButtons
observerID
cleanups
```

自动常开和手动开关分开建模：

- `alwaysOpen=true`：进入新 PDF 自动打开；用户关闭后，本标签页保持关闭，切走再回来重新打开。
- `alwaysOpen=false`：进入 PDF 不弹出；点击工具栏按钮设置 `manualOpenTabID` 后打开；再次点击或关闭按钮清除手动状态。
- 偏好从 true 改为 false：如果当前不是手动打开，立即隐藏并递增 `requestSerial`，使在途异步读取失效。

## 验收矩阵

| 场景 | 预期 |
|---|---|
| 父条目有摘要 | 显示父条目标题和摘要 |
| 父条目摘要为空 | 显示明确空状态，不生成内容 |
| 独立 PDF 无父条目 | 提示检索元数据或创建父条目 |
| 切到非阅读器标签 | 隐藏悬浮窗，取消旧请求 |
| 工具栏按钮 | 点击开关，active/aria-pressed 同步 |
| 关闭自动常开 | 不自动弹出，但按钮仍可手动打开 |
| 条目摘要被修改 | 打开的悬浮窗自动刷新 |
| 禁用插件 | 移除 DOM、观察者、样式和按钮 |
| 最终 XPI | 原生 AddonManager 解析成功且兼容 |

## 可复用结论

- 安装对话框文案不是根因；用原生解析结果和 Error Console 建立证据链。
- 阅读器 UI 优先走公开的 `renderToolbar` 事件。
- 插件支持热启用/禁用时，初始化和清理必须对称。
- 异步 UI 必须防止标签切换后的陈旧结果回写。
- 设置“是否自动打开”和“用户本次手动打开”是两个不同状态，不能只用一个布尔值。
- 最终验收对象是交付 XPI，而不是源码目录或之前的 XPI。

## 不要过度泛化

- `update_url` 缺失问题是在 Zotero 9.0.6 上实测；未来版本应重新运行原生解析。
- `reader._window`、`reader._iframeWindow` 等内部字段不是稳定公共合同。
- 数值 AddonManager 状态码可能随 Mozilla 平台变化；保留原始结果并查目标版本源码。
