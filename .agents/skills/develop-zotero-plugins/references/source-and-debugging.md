# Zotero 插件资料查找与调试

## 目录

- 证据优先级
- 官方入口
- 检查目标版本
- 搜索本机 Zotero 源码
- 常见源码位置
- 用 Zotero 原生安装器解析 XPI
- 安装失败的分层诊断
- 开发环境与提问渠道

## 证据优先级

遇到不确定内容时按以下顺序查找，并记录 Zotero 版本、源码版本或访问日期：

1. 当前版本的 Zotero 官方开发文档与版本迁移页。
2. Zotero 官方示例插件 `zotero/make-it-red`。
3. 用户实际安装版本中的 `app/omni.ja` 源码；它最能解释本机真实行为。
4. `zotero/zotero` GitHub 主仓库相应 API 的实现和注释。
5. 活跃第三方插件，只用于观察实践，不能代替官方接口或目标版本验证。
6. `zotero-dev` 讨论组；普通使用问题再去 Zotero Forums。

如果文档、主分支源码和本机行为冲突，以目标客户端的源码与运行结果为准，并把结论标注为“在 Zotero x.y.z 验证”，不要泛化为所有版本。

## 官方入口

- 插件开发环境：<https://www.zotero.org/support/dev/client_coding/plugin_development>
- Zotero 7 插件结构、偏好和阅读器事件：<https://www.zotero.org/support/dev/zotero_7_for_developers>
- Zotero 8+ Mozilla 平台迁移：<https://www.zotero.org/support/dev/zotero_8_for_developers>
- JavaScript API 与 Run JavaScript：<https://www.zotero.org/support/dev/client_coding/javascript_api>
- 官方示例插件：<https://github.com/zotero/make-it-red>
- Zotero 客户端源码：<https://github.com/zotero/zotero>
- 开发讨论组：<https://groups.google.com/g/zotero-dev>

先检查有没有比上述页面更新的主版本迁移页。文档自身说明 JavaScript API 并不完整，因此“文档里没写”不代表接口不存在或可安全使用。

## 检查目标版本

在 Zotero 的“工具 → 开发者 → Run JavaScript”中执行：

```javascript
return {
  version: Services.appinfo.version,
  platformVersion: Services.appinfo.platformVersion,
  os: Zotero.isMac ? "macOS" : Zotero.isWin ? "Windows" : "Linux",
};
```

含 `await` 或 `return` 的诊断代码要勾选“作为异步函数执行”。使用独立开发 profile，避免实验影响真实文库。

## 搜索本机 Zotero 源码

macOS 常见路径：

```text
/Applications/Zotero.app/Contents/Resources/app/omni.ja
/Applications/Zotero.app/Contents/Resources/omni.ja
```

- `app/omni.ja`：Zotero 自身 JavaScript、XHTML、阅读器资源。
- 外层 `omni.ja`：Mozilla 平台和 Add-on Manager 等底层代码。

列出和读取文件：

```bash
unzip -Z1 /Applications/Zotero.app/Contents/Resources/app/omni.ja | rg 'reader|preference'
unzip -p /Applications/Zotero.app/Contents/Resources/app/omni.ja \
  chrome/content/zotero/xpcom/reader.js | rg -n -C 8 'renderToolbar'
```

使用本 Skill 的跨平台搜索脚本：

```bash
python3 scripts/inspect_zotero_source.py renderToolbar
python3 scripts/inspect_zotero_source.py PreferencePanes \
  --file-regex 'preferencePanes\.js$'
python3 scripts/inspect_zotero_source.py 'update_url not provided' \
  --omni /Applications/Zotero.app/Contents/Resources/omni.ja
```

如果脚本找不到安装位置，显式传 `--omni`。Windows/Linux 在 Zotero 安装目录附近寻找 `app/omni.ja`，不要假设固定路径。

## 常见源码位置

在 `app/omni.ja` 或 `zotero/zotero` 仓库优先查：

| 需求 | 常见源码 |
|---|---|
| 阅读器实例与事件 | `chrome/content/zotero/xpcom/reader.js` |
| 插件设置页注册 | `chrome/content/zotero/xpcom/preferencePanes.js` |
| 偏好读写与观察者 | `chrome/content/zotero/xpcom/prefs.js` |
| 标签页事件和数据 | `chrome/content/zotero/tabs.js` 或搜索 `Zotero_Tabs` |
| 条目数据 | `chrome/content/zotero/xpcom/data/item.js`、`items.js` |
| 菜单、条目树、侧栏 API | `chrome/content/zotero/xpcom/pluginAPI/` |
| 阅读器实际 DOM/CSS | `resource/reader/reader.js`、`resource/reader/reader.css` |

文件名会变化。找不到时搜索公开对象或方法名，而不是猜新的路径。

## 用 Zotero 原生安装器解析 XPI

静态 ZIP/JSON 校验不能证明 Zotero 会接受插件。打包后，在 Run JavaScript 中勾选异步模式并执行：

```javascript
var { AddonManager } = ChromeUtils.importESModule(
  "resource://gre/modules/AddonManager.sys.mjs"
);
var xpiFile = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
xpiFile.initWithPath("/ABSOLUTE/PATH/plugin.xpi");
var install = await AddonManager.getInstallForFile(xpiFile);
return JSON.stringify({
  appVersion: Services.appinfo.version,
  state: install.state,
  error: install.error,
  addon: install.addon && {
    id: install.addon.id,
    name: install.addon.name,
    version: install.addon.version,
    type: install.addon.type,
    isCompatible: install.addon.isCompatible,
    appDisabled: install.addon.appDisabled,
    strictCompatibility: install.addon.strictCompatibility,
  },
}, null, 2);
```

这只解析 XPI，不调用 `install.install()`，不会安装插件。不要把数值状态码当成跨版本常量；以 `error === 0`、`addon` 非空、`isCompatible === true` 为主要验收信号，并用目标版本源码解释异常状态。

## 安装失败的分层诊断

按层排查，不要看到“可能不兼容”就直接扩大版本范围：

1. **归档层**：`unzip -t plugin.xpi`；确认根目录有 `manifest.json`、`bootstrap.js`。
2. **清单层**：检查 JSON、ID、版本、`applications.zotero`、HTTPS `update_url` 和兼容范围。
3. **原生解析层**：执行上面的 `getInstallForFile()` 诊断。
4. **错误详情层**：打开“工具 → 开发者 → Error Console”，按插件 ID、文件名或 `Reading manifest` 搜索。
5. **启动层**：若可安装但启用失败，检查 bootstrap 日志、异常和每个资源 URI。
6. **功能层**：分别验证 UI、数据读取、设置、切换标签、禁用清理和重启恢复。

本次实测中的典型陷阱：Zotero 9.0.6 安装对话框只显示笼统的兼容性提示，但 Error Console 的真实错误是：

```text
Reading manifest: applications.zotero.update_url not provided
```

补上 HTTPS `update_url` 后，同一客户端原生解析得到 `error: 0` 和 `isCompatible: true`。因此错误对话框只能作为症状，不能作为根因。

## 开发环境与提问渠道

- 正式开发使用独立 Zotero profile 和测试文库。
- 可以按官方文档使用 extension proxy 从源码加载；修改 profile 前先关闭 Zotero 并备份。
- 运行时调试使用 Run JavaScript、Error Console、Browser Toolbox 和 `-ZoteroDebugText`。
- 内部 API 没有公开替代项时，在问题中提供 Zotero 精确版本、最小复现、相关源码路径和错误日志，再去 `zotero-dev` 提问。
- 不要在没有目标版本运行证据时声称“兼容 Zotero 7–9”或“无需重启”。
