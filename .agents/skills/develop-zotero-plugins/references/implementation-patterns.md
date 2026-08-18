# Zotero 插件实现模式

## 目录

- 最小目录结构
- 清单与兼容范围
- 生命周期与窗口状态
- 阅读器工具栏
- 读取 PDF 父条目元数据
- Notifier 事件
- 设置页与默认偏好
- 清理、权限与兼容性

## 最小目录结构

Zotero 7 及之后的 bootstrapped 插件至少需要：

```text
plugin-root/
├── manifest.json
├── bootstrap.js
├── prefs.js                  # 有默认设置时使用
└── content/
    ├── main.js
    ├── preferences.xhtml     # 有设置页时使用
    └── style.css             # 可选
```

XPI 是 ZIP 文件，但 `manifest.json` 和 `bootstrap.js` 必须位于归档根目录，不能再包一层文件夹。

## 清单与兼容范围

```json
{
  "manifest_version": 2,
  "name": "Example Plugin",
  "version": "0.1.0",
  "description": "Example Zotero plugin",
  "author": "Developer",
  "applications": {
    "zotero": {
      "id": "example@example.org",
      "update_url": "https://example.invalid/example/updates.json",
      "strict_min_version": "7.0",
      "strict_max_version": "9.0.*"
    }
  }
}
```

执行以下规则：

- 保持插件 ID 永久稳定；升级版本必须沿用同一 ID。
- 只声明实际测试过的兼容范围。发布前检查当前 Zotero 主版本和最新版本迁移说明。
- 为正式发行提供真实、可访问的 HTTPS `updates.json`。
- 仅在本地开发且不提供自动更新时，才使用保留的 `.invalid` HTTPS 地址，并在交付说明中明确它不会更新。
- Zotero 9.0.6 的实际安装解析器会拒绝缺少 `applications.zotero.update_url` 的清单；其他版本仍应通过目标客户端复核。

## 生命周期与窗口状态

让 `bootstrap.js` 只负责生命周期和加载主脚本：

```javascript
var ExamplePlugin;

async function startup({ id, version, rootURI }) {
  await Zotero.uiReadyPromise;
  Services.scriptloader.loadSubScript(rootURI + "content/main.js");
  await ExamplePlugin.init({ id, version, rootURI });
  ExamplePlugin.addToAllWindows();
}

function onMainWindowLoad({ window }) {
  ExamplePlugin?.addToWindow(window);
}

function onMainWindowUnload({ window }) {
  ExamplePlugin?.removeFromWindow(window);
}

function shutdown() {
  ExamplePlugin?.shutdown();
  ExamplePlugin = undefined;
}
```

在主脚本中以窗口为单位保存状态：

```javascript
var ExamplePlugin = {
  windowStates: new Map(),

  addToAllWindows() {
    for (const win of Zotero.getMainWindows()) {
      if (win.ZoteroPane) this.addToWindow(win);
    }
  },

  addToWindow(win) {
    if (this.windowStates.has(win)) return;
    this.windowStates.set(win, { cleanups: [] });
  },

  removeFromWindow(win) {
    const state = this.windowStates.get(win);
    if (!state) return;
    for (const cleanup of state.cleanups) cleanup();
    this.windowStates.delete(win);
  },
};
```

不要只处理 `Zotero.getMainWindow()`：插件启用时可能已有窗口，以后也可能新增窗口。

## 阅读器工具栏

优先使用 Zotero 的 `renderToolbar` 事件，不要依赖屏幕坐标或固定 DOM 层级：

```javascript
function handleRenderToolbar({ reader, doc, append }) {
  const button = doc.createElement("button");
  button.type = "button";
  button.tabIndex = -1;
  button.className = "toolbar-button example-plugin-button";
  button.title = "显示或隐藏内容";
  button.setAttribute("aria-label", "显示或隐藏内容");
  button.addEventListener("click", () => toggleForReader(reader));
  append(button);
}

Zotero.Reader.registerEventListener(
  "renderToolbar",
  handleRenderToolbar,
  pluginID
);
```

关键约束：

- 使用事件提供的 `doc` 创建节点。
- 在事件处理器返回前直接、同步调用 `append()`。当前阅读器实现会拒绝延迟追加。
- 使用 `toolbar-button` 复用阅读器的尺寸、hover 和 active 样式。
- 设置 `title`、`aria-label` 和 `aria-pressed`。
- 把 `pluginID` 传给注册函数，使 Zotero 在禁用或卸载插件时自动移除监听器。
- `reader.itemID` 是当前附件 ID；`reader.tabID` 只适用于标签页阅读器。
- `_window`、`_iframeWindow` 等下划线字段是内部实现。仅在没有公开替代方案且已对目标版本源码和运行时验证后使用，并提供回退路径。

如果插件在一个已经打开的阅读器中被热启用，`renderToolbar` 可能已经触发。可以要求用户重新打开标签页；若必须即时补按钮，应把直接 DOM 注入限制为版本化回退，并防止重复按钮。

## 读取 PDF 父条目元数据

```javascript
const attachment = await Zotero.Items.getAsync(reader.itemID);
if (!attachment?.isPDFAttachment()) return;

const parent = attachment.parentItemID
  ? await Zotero.Items.getAsync(attachment.parentItemID)
  : null;

const title = parent?.getField("title") || attachment.getField("title");
const abstract = parent?.getField("abstractNote") || "";
```

明确处理三种状态：父条目有摘要、父条目摘要为空、PDF 没有父条目。不要在用户只要求显示 Zotero 元数据时擅自联网或生成摘要。

异步读取时使用请求序号或取消标记，避免用户切换标签页后旧请求把弹窗重新显示：

```javascript
const serial = ++state.requestSerial;
const item = await Zotero.Items.getAsync(itemID);
if (serial !== state.requestSerial || selectedTabID !== tabID) return;
```

## Notifier 事件

使用 `Zotero.Notifier` 响应标签页和条目变化，并保存 observer ID：

```javascript
state.observerID = Zotero.Notifier.registerObserver(
  {
    notify(event, type, ids) {
      // Handle tab select/close and item modify.
    },
  },
  ["tab", "item"],
  pluginID
);
```

在 `removeFromWindow()` 中调用 `Zotero.Notifier.unregisterObserver(state.observerID)`。把嵌套的 `ids` 扁平化后再比较；不要假设通知始终只包含一个字符串 ID。

## 设置页与默认偏好

Zotero 7+ 的默认值放在插件根目录 `prefs.js`：

```javascript
pref("extensions.example-plugin.alwaysOpen", true);
```

在初始化期间注册独立设置页：

```javascript
await Zotero.PreferencePanes.register({
  pluginID,
  id: "example-plugin-preferences",
  src: rootURI + "content/preferences.xhtml",
  label: "Example Plugin",
});
```

`preferences.xhtml` 是 XUL/XHTML 片段，不要添加 `DOCTYPE`：

```xml
<vbox xmlns="http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul"
      xmlns:html="http://www.w3.org/1999/xhtml">
  <groupbox>
    <label><html:h2>显示设置</html:h2></label>
    <checkbox native="true"
      preference="extensions.example-plugin.alwaysOpen"
      label="打开文献时自动显示"/>
  </groupbox>
</vbox>
```

读取完整偏好键时传 `global=true`：

```javascript
const enabled = Zotero.Prefs.get(
  "extensions.example-plugin.alwaysOpen",
  true
);
```

需要即时响应设置变化时注册观察者，并在 shutdown 时注销：

```javascript
const symbol = Zotero.Prefs.registerObserver(prefName, handler, true);
Zotero.Prefs.unregisterObserver(symbol);
```

所有 `id`、class 和本地化标识都加插件前缀，避免与 Zotero 或其他插件冲突。

## 清理、权限与兼容性

- 在 shutdown 中移除所有 DOM、样式表、窗口事件、Notifier 和偏好观察者。
- 对官方支持 `pluginID` 自动清理的注册 API，仍要清理自己创建的 DOM 和状态。
- 不要写 Zotero SQLite 数据库；通过 Zotero 数据 API 读写条目，并在写操作前建立测试数据与备份。
- 对网络、文件写入、密钥或论文内容上传做显式披露；默认保持本地、最小权限。
- Zotero 8 起 Mozilla 平台继续演进，模块导入和窗口作用域会变化。涉及 ESM/JSM、Firefox/XPCOM 或内部字段时，必须读取目标版本迁移说明和实际源码。
