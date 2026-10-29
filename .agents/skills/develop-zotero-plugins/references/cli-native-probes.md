# 不依赖 Computer Use 的 Zotero 原生验证

仅在用户另行明确请求真机调试或验证时使用；本指南不是开发完成后的必做步骤，不应自动启动、操控 Zotero 或请求系统权限。默认交付只做静态检查、自动测试与归档检查。

获此授权后，只有终端、文件工具时的 macOS Zotero 调试可采用 **CLI → macOS Accessibility（AX）→ Zotero「执行 JavaScript」→ 结构化结果文件**，不把 Computer Use、远程调试端口或浏览器自动化工具当作前提。

本指南来自 macOS **Zotero 10.0.6 / Gecko 140.17.0** 的实际非安装式 XPI 解析和模拟后端窗口验证。AX 定位和编辑器细节不是 Zotero 公共 API，其他版本应先核对本机源码；其他操作系统不能照搬 Swift/AppKit 路线。通用 API、XPI 解析及模块隔离见 [source-and-debugging.md](source-and-debugging.md)。

## 1. 先确认进程、授权与工具

```bash
pgrep -x zotero
rg '^(Version|Milestone)=' \
  /Applications/Zotero.app/Contents/Resources/app/application.ini \
  /Applications/Zotero.app/Contents/Resources/platform.ini
command -v osascript
xcrun --find swift
```

- 每次控制前重新发现 PID，并用 `NSRunningApplication(processIdentifier:)?.bundleIdentifier == "org.zotero.zotero"` 复核；不得复用上一轮硬编码 PID。多个候选进程时先确认目标，不自动选第一个。
- 安装目录的版本只是预检；最终以探针中的 `Services.appinfo.version` / `platformVersion` 为准。此次调试期间客户端从 10.0.4 更新到了 10.0.6，旧 PID 和旧版本证据不能继续套用。
- 用 `AXIsProcessTrusted()` 检查当前工具进程权限。没有系统辅助功能/Automation 授权时请用户正常授权，或请用户手动运行短探针；不得修改 TCC 数据库、绕过系统限制。
- 使用现成本机工具链。若 `xcrun` 指向不可用工具链，可检查已安装 Xcode 的 `Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/swift`；不为此自动下载 Xcode、npm 包或其他工具。
- 不因缺少 Computer Use 而安装插件、创建/修改 profile、重启用户 Zotero、开启调试端口，或启动真实 Agent。发布授权也不包含这些操作。

Swift 检查若报 `unable to load standard library for target`，先确认 SDK 与工具链配套；本次显式指定现有 SDK 后通过类型检查，不需要下载或重装：

```bash
xcrun swiftc -sdk "$(xcrun --sdk macosx --show-sdk-path)" \
  -typecheck /absolute/path/to/owned-helper.swift
```

## 2. 把探针与 UI 输入分开

在自己新建的随机临时目录中保存：

- `probe.js`：已审查的完整探针，不含真实论文、聊天或密钥；
- `result.json`：本轮结果，路径和 `runID` 唯一，不复用上一轮文件；
- 如需隔离加载，保存最终 XPI 的同字节临时副本。

Run JavaScript 中只输入一个短包装，路径用 JSON 字符串字面量安全编码：

```javascript
return await eval(await IOUtils.readUTF8("/absolute/owned-temp-dir/probe.js"));
```

这里执行的是开发者自己刚写入并审查的本地探针，不是网页、模型输出或用户论文中的代码。勾选「作为异步函数执行」。临时目录、文件名和上下文不应来自模型消息或其他不可信输入。

### 可改写的非安装解析探针

以下代码保存为 `probe.js`；填写本轮 ID、路径及预期 ID/版本/哈希。`resultPath` 必须位于自己新建的临时目录中。

```javascript
(async () => {
  const runID = "REPLACE_WITH_FRESH_RUN_ID";
  const xpiPath = "/absolute/path/to/final-plugin.xpi";
  const resultPath = "/absolute/owned-temp-dir/result.json";
  const expected = {
    id: "example@example.org", version: "1.0.0",
    sha256: "REPLACE_WITH_FINAL_XPI_SHA256"
  };
  const result = { runID, complete: false, passed: false };
  try {
    result.appVersion = Services.appinfo.version;
    result.platformVersion = Services.appinfo.platformVersion;
    const bytes = await IOUtils.read(xpiPath);
    const hash = Cc["@mozilla.org/security/hash;1"].createInstance(Ci.nsICryptoHash);
    hash.init(hash.SHA256);
    hash.update(bytes, bytes.length);
    result.bytes = bytes.length;
    result.sha256 = Array.from(hash.finish(false), c =>
      c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
    if (result.sha256 !== expected.sha256) throw new Error("Artifact changed");
    const { AddonManager } = ChromeUtils.importESModule(
      "resource://gre/modules/AddonManager.sys.mjs"
    );
    const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    file.initWithPath(xpiPath);
    const install = await AddonManager.getInstallForFile(file);
    result.error = install.error;
    result.addon = install.addon && {
      id: install.addon.id, version: install.addon.version,
      isCompatible: install.addon.isCompatible, appDisabled: install.addon.appDisabled
    };
    result.passed = result.error === 0 && result.addon?.id === expected.id &&
      result.addon.version === expected.version &&
      result.addon.isCompatible === true && result.addon.appDisabled === false;
  }
  catch (error) { result.failure = String(error); }
  finally {
    result.complete = true;
    await IOUtils.writeUTF8(resultPath, JSON.stringify(result, null, 2));
  }
  return JSON.stringify(result, null, 2);
})()
```

不调用 `install.install()`。不要以 `state` 的数字作为跨版本通过标准。从终端读取 JSON 后，再比较本地最终 XPI 的大小和 SHA-256；只有 `runID` 匹配、`complete=true`、`passed=true` 且哈希一致才算通过。编译/输入阶段失败、Zotero 退出或无法写入结果时可能根本没有 JSON，不能沿用旧证据。

## 3. 只定位需要操作的窗口

使用 `osascript` / Swift `AppKit`、`ApplicationServices`，不依赖屏幕坐标：

1. 激活已确认的 Zotero 进程。若分支/设置等窗口使菜单不可用，定位并激活正确的主窗口；不能把所有以 “Zotero” 结尾的窗口都视为主窗口。
2. 只检查菜单栏所需路径：`工具 / Tools → 开发者 / Developer → Run JavaScript`。文字以当前语言和本机 `omni.ja` 中 `runJS.html`、`runJS.js`、Fluent 文件为准。
3. 打开前记录已有 Run JavaScript 窗口。**默认不改写已有窗口**；即便 ACE 的 AX textarea 值为空，也不能说明编辑器缓冲区为空。
4. 发出菜单动作后，使用有限期限等待新窗口。菜单 `AXPress` / `AXPick` 返回成功只代表动作被接受，不证明窗口已创建或代码已执行。必要时重新查询菜单节点；不要无限重复点击。
5. 只有确认该窗口由本轮创建，才在它的子树内定位编辑器、异步复选框和「执行 / Run」按钮。再次检查进程和窗口存活后再输入。

中文菜单的已用过的打开方式（使用前确认当前目标和语言）：

```applescript
tell application "System Events" to tell process "zotero"
  set frontmost to true
  click menu item "Run JavaScript" of menu 1 of menu item "开发者" of menu 1 of menu bar item "工具" of menu bar 1
end tell
```

不要递归打印整个主窗口 AX 树：它会带出真实论文标题等内容。只输出定位状态、数量和错误码；读取结果也只限本轮探针窗口/文件。若前一次打开动作迟到，先核实其归属，不要为了继续操作添加一个无校验的 `--owned` 绕过开关。

## 4. ACE 输入用完整粘贴，不逐字合成

本次在 Run JavaScript 的 ACE 编辑器中分块发送 Unicode 键盘事件，出现了 `SyntaxError: unexpected token: identifier`；改用完整剪贴板粘贴后，同一探针成功。这个现象不证明插件有语法错误，也未定位到某一层的具体输入缺陷。

推荐顺序：**聚焦本轮编辑器 → Cmd+A → Cmd+V → 等待输入处理 → 确认异步模式 → 执行一次**。长代码留在文件中，只粘贴短包装。不要把未释放的 Command 修饰状态带入普通输入。

下面是可嵌入临时 Swift 控制器的粘贴原语，不是完整自动化脚本。调用方必须已经确认 `editor` 属于本轮新建的 Run JavaScript 窗口，完成窗口激活，并在调用后定位该窗口中的异步开关和执行按钮。

```swift
import AppKit
import ApplicationServices

func pasteProbeCommand(_ command: String, editor: AXUIElement, pid: pid_t) throws {
    func failure(_ message: String) -> NSError {
        NSError(domain: "ZoteroNativeProbe", code: 1,
                userInfo: [NSLocalizedDescriptionKey: message])
    }
    guard AXIsProcessTrusted(),
          NSRunningApplication(processIdentifier: pid)?.bundleIdentifier == "org.zotero.zotero"
    else { throw failure("Target or Accessibility permission unavailable") }
    var editorPID: pid_t = 0
    guard AXUIElementGetPid(editor, &editorPID) == .success, editorPID == pid,
          AXUIElementSetAttributeValue(editor, kAXFocusedAttribute as CFString, kCFBooleanTrue) == .success
    else { throw failure("Probe editor is unavailable") }

    // Preserve every format in memory. Never print or write clipboard contents.
    let pb = NSPasteboard.general
    let initialCount = pb.changeCount
    let backup = try (pb.pasteboardItems ?? []).map { item -> NSPasteboardItem in
        let copy = NSPasteboardItem()
        for type in item.types {
            guard let data = item.data(forType: type), copy.setData(data, forType: type)
            else { throw failure("Cannot preserve clipboard; no paste attempted") }
        }
        return copy
    }
    guard pb.changeCount == initialCount else { throw failure("Clipboard changed; retry later") }
    pb.clearContents()
    let written = pb.setString(command, forType: .string)
    let ourCount = pb.changeCount
    defer {
        // Do not overwrite a newer copy performed by the user/another application.
        if pb.changeCount == ourCount {
            pb.clearContents()
            pb.writeObjects(backup)
        }
    }
    guard written else { throw failure("Could not prepare probe command") }
    func commandKey(_ code: CGKeyCode) {
        for down in [true, false] {
            let event = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down)!
            event.flags = .maskCommand
            event.postToPid(pid)
        }
    }
    commandKey(0) // A
    RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.1))
    commandKey(9) // V
    RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.6))
}
```

剪贴板快照/恢复仅用于避免破坏用户剪贴板，不得把内容交给模型、日志、文件或网络。若无法完整保留格式，先停止，不退回无保护的 `pbcopy`。`changeCount` 只能检测可观察到的并发修改，剪贴板操作并非原子事务；用户正使用剪贴板时应暂停。示例中的短等待用于 UI 事件处理，不是通过证明；最终必须读本轮结果文件。

## 5. 失败时判断哪一层没完成

| 现象 | 下一步 |
|---|---|
| PID 不再对应 Zotero / 版本变化 | 重新发现进程并校验 bundle ID、实际客户端版本；旧句柄不用。 |
| AX 无权限 | 请用户按系统方式授权或手动运行探针，不改 TCC/profile。 |
| 菜单动作返回 0，但没有新窗口 | 检查当前窗口、语言、迟到事件和节点有效性；有界等待，不宣称执行成功。 |
| `AXEnhancedUserInterface` 设置报错 | 此次曾返回 `-25208`，之后仍能完成原生验证；不要把该可选属性设置成功作为前提。 |
| 结果栏出现 SyntaxError，结果文件未创建 | 先检查输入/包装，改用完整粘贴；不要据此修改插件或声明清单不兼容。 |
| 结果文件还没有 / 只写了一半的阶段结果 | 视为未完成；确认本轮是否仍运行，不自动重复执行可能有副作用的探针。 |
| 有最终 JSON，但 runID/哈希不匹配 | 拒绝旧结果，重新核对交付物。 |

自动化仍无法完成时，明确报告卡在窗口定位、输入还是探针执行，给用户短包装手动执行。保留未完成状态，不以静态检查替代原生验证，也不为跑通自动化修改真实环境。

## 6. 用模拟后端验证原生窗口

原生解析只证明 XPI 可接受。要测界面，先审查待加载模块，再按 [模块探针](source-and-debugging.md#不安装插件的模块与资源探针) 建立独立命名空间：

- 从**最终 XPI 的唯一临时副本**加载模块；仅 `ignoreCache: true` 不能当作所有 jar 缓存都已失效的保证。先核对副本与最终包哈希。
- 需要特权本地窗口时，用 `amIAddonManagerStartup.registerChrome()` 注册本轮唯一 package 名，再打开其 `chrome://…/content/…xhtml`；不覆盖插件已有映射，不把普通 `jar:` / `file:` 页当作同等特权页面。
- UI 使用实际模块、XHTML、CSS；后端注入内存 mock，纸张身份、上下文和回复全为合成数据。不调用完整 `bootstrap.startup()`，不注册第二份 Item Pane、不读写插件偏好、不创建真实 ACP 连接。
- 检查窗口打开不发送、按钮触发仅调用 mock、多轮渲染、文本选择样式、控件状态、不同尺寸下的 `getBoundingClientRect()` 与横向溢出。只测 `user-select: text` 不等于操作系统复制命令已验收。
- 在 `finally` 中关闭并等待自己的窗口/管理器清理，再 `destruct()` 自己的 chrome 注册、删除自己的临时 XPI；结果记录清理是否成功。不得关闭用户原有 Reader、分支或其他窗口。
- Run JavaScript 窗口只在确认属于本轮、仍显示本轮唯一包装时关闭。`codeEditor` 是内部字段，使用前核对本机 `runJS.js`，不能以“最近一个窗口”单独判断所有权。

此次 0.1.48 的证据：最终 XPI 解析通过；合成分支窗口没有配置/上下文卡片，后台上下文保留，打开不自动发送，两个 mock turn 正常；680px / 480px 窗宽无横向溢出，输入区距底部约 16px；窗口、监听器、注册与临时副本清理完成。**未安装插件、未调用真实模型；不代表完整聊天、操作系统复制、插件启停或所有 Zotero 版本均通过。**
