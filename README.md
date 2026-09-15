# Side Agent Runtime

Side Agent Runtime 是一个 Chrome 138+ Manifest V3 Side Panel Agent Harness。它只向模型提供一个浏览器元工具 `chrome({ code })`；代码在当前 Side Panel 的扩展上下文中作为异步 JavaScript 执行，可直接使用 Web API、Chrome Extension API、原生 User Scripts API 和 CDP。

## 安装

需要 Node.js、npm 和 Chrome 138+：

```sh
npm ci
npm run build
```

在 `chrome://extensions` 开启开发者模式，选择“加载已解压的扩展程序”并选中 `dist/`。点击扩展图标打开 Side Panel；在设置页填写 OpenAI-compatible Base URL、Model ID 和 API Key。使用 `chrome.userScripts` 前，还需要在扩展详情页开启 “Allow User Scripts”。

## 唯一工具

工具输入只有一个 `code` 字段。代码是异步函数体，因此需要显式 `return` 结果，调用严格串行执行。

查询标签页：

```json
{
  "code": "return await chrome.tabs.query({ active: true, currentWindow: true });"
}
```

使用页面 MAIN world：

```json
{
  "code": "const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); return await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', func: () => document.title });"
}
```

直接使用 CDP：

```json
{
  "code": "const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); await chrome.debugger.attach({ tabId: tab.id }, '1.3'); try { return await chrome.debugger.sendCommand({ tabId: tab.id }, 'Runtime.evaluate', { expression: 'document.title', returnByValue: true }); } finally { await chrome.debugger.detach({ tabId: tab.id }); }"
}
```

注册原生 User Script：

```json
{
  "code": "await chrome.userScripts.register([{ id: 'page-helper', matches: ['<all_urls>'], js: [{ code: \"document.documentElement.dataset.agent = 'ready'\" }], world: 'MAIN' }]); return await chrome.userScripts.getScripts({ ids: ['page-helper'] });"
}
```

Harness 不提供结构化 Chrome RPC、独立 CDP 工具、权限审批、额外沙箱、capability layer 或 Greasemonkey 兼容层。能力边界来自 Chrome 本身、Manifest 权限、浏览器策略和目标页面。

## 数据与恢复

IndexedDB 中的 append-only event log 是唯一事实来源。每条事件都有 `id`、`type`、`timestamp` 和 `content`；模型、工具与请求事件还记录对应的 stop reason、usage、provider metadata、tool call ID、输入、输出、错误、retry、abort 和 latency。聊天 UI、恢复会话和下一次模型上下文只从按序的 `conversation.message` 事件重建。

用户消息只追加一次，模型消息在成功、失败或中止时保存最终快照。设置页只保留 BYOK 配置和“清空对话与日志”；日志存储失败会直接显示致命错误，不使用内存后备。

Side Panel 关闭时会中止模型请求、阻止排队工具继续启动，并尽力结束工具执行和 detach 本扩展创建的调试会话。已经发生的浏览器副作用不会回滚。

User Scripts 完全通过 `chrome.userScripts` 管理。Harness 在每次工具调用后保存当前注册快照，并在后台启动或更新后重新注册。升级到 0.2.0 时会清空旧日志和旧 User Script 数据，但保留 BYOK 模型配置。

## 重试与流式 UI

网络错误、408、429 和可恢复的 5xx 使用带 jitter 的指数退避，单次等待最高 10 秒，不设最大重试次数；不可恢复错误立即结束，用户中止立即生效。

聊天界面使用 Assistant UI 与 AI SDK v7 直接集成。模型 Token 持续流入，Markdown 显示按 animation frame 平滑提交并缓存 renderer，支持 CommonMark、GFM、脚注、LaTeX、表格、任务列表、删除线、引用、链接和语法高亮。用户消息显示为气泡，模型消息全宽显示。

## 验证

```sh
npm run check
npm test
npm run test:e2e
git diff --check
```

GitHub Autobuild 会执行检查和 Playwright 测试，并生成扩展压缩包与 SHA-256 校验文件。

维护者：[notCorwin](https://github.com/notCorwin)。欢迎提交 [Issue](https://github.com/notCorwin/side-agent-runtime/issues) 和聚焦的 Pull Request。
