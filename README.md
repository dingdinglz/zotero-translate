# Smart Paper Translator

Smart Paper Translator 0.1.3 是面向 Zotero 9 内置 PDF 阅读器的学术翻译插件。它会在原生文本选择弹窗中直接显示缓存译文，未命中时提供手动“翻译”按钮，并按论文保存摘要、术语和句段译文。

## 功能

- DeepSeek 内置配置，以及标准 Bearer 鉴权的 OpenAI Chat Completions 兼容服务。
- 两套可编辑安全模板；划线翻译模板默认携带论文标题与 Zotero 父条目摘要。
- 打开 PDF 时自动翻译尚未缓存的摘要；划线缓存命中时直接显示，未命中时必须点击“翻译”后才发送。
- Reader 工具栏提供独立翻译图标，可随时显示或隐藏悬浮窗。
- 悬浮窗用两个独立 Tab 显示摘要译文和当前论文术语；缓存状态使用 Tag 呈现，不混入译文正文。
- 标题栏支持连续拖动，右下角手柄支持自由调整宽高；位置和尺寸都会记住，内容独立滚动，不会挤压工具栏或 PDF 阅读区。
- 每篇论文独立本机缓存；模型、目标语言、摘要或提示词改变后产生新缓存版本。
- API Key 使用 Zotero/Mozilla Login Manager，与论文缓存和偏好设置分离。

## 设置与模板

在 Zotero 设置中打开 “Smart Paper Translator”：

1. 选择 DeepSeek 或自定义 OpenAI 兼容服务。
2. 填写模型和 Base URL；自定义 URL 应是 API 根路径，例如 `https://api.example.com/v1`，插件会追加 `/chat/completions`。
3. 保存 API Key。自定义 localhost/回环服务可不填写 Key。
4. 设置目标语言并按需编辑两套提示词。

划线模板支持 `{{text}}`、`{{abstract}}`、`{{title}}`、`{{targetLanguage}}`、`{{pageNumber}}`；摘要模板支持 `{{abstract}}`、`{{title}}`、`{{targetLanguage}}`。模板仅做变量替换，不支持代码、循环或条件执行。

## 数据与隐私

- 摘要自动翻译会把 Zotero `abstractNote`、标题和模板发送给所选服务，并产生 API 用量。
- 划线弹窗会先在本机检查当前配置对应的缓存；命中时直接显示且不联网，未命中时只有点击“翻译”后才发送。
- 请求使用匿名 Cookie 容器、60 秒超时，关闭 Zotero 默认长时间 5xx 重试，并设置 `logBodyLength: 0`，不把论文正文写入 Zotero HTTP 调试日志。
- 原文和译文以 JSON 保存在 Zotero 数据目录的 `smart-paper-translator/records/` 下，不随 Zotero 同步，也不加密。
- API Key 存在 Zotero 使用的 Login Manager 中，不写入偏好、JSON 缓存或插件包。

## 开发与验证

无需运行时依赖。需要 Node.js 22、Python 3 和 Info-ZIP：

```bash
npm run check
sh scripts/build.sh
```
