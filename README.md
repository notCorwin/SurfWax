# Side Agent Runtime

一个纯 Manifest V3 Chrome 扩展：在 Chrome Side Panel 中运行 Vercel AI SDK Agent，并通过一个动态 chrome 工具调用 Chrome 扩展 API、Chrome DevTools Protocol 和原生 User Scripts API。

## 功能

- 只向 Agent 暴露一个动态 chrome 工具，按需发现并调用浏览器能力。
- 支持 describe、call、waitEvent 和 cdp 四种操作。
- 可使用 chrome.scripting.executeScript 或 CDP Runtime.evaluate 执行页面脚本。
- Side Panel 与扩展选项页均支持 User Scripts 的创建、编辑、启用、禁用、删除和测试。
- User Scripts 支持 MAIN/USER_SCRIPT 执行世界、内联代码和扩展内文件 source；不提供 GM.* 兼容层。
- 唯一的 canonical event log 追加写入本地 IndexedDB，记录完整的对话、模型、工具、请求、用户脚本和系统事件；UI、LLM context 和恢复会话都从它重建，不脱敏网页内容。
- Side Panel 重新打开后从事件日志恢复对话；关闭面板会立即取消当前模型请求、停止后续工具调用、清理 handles 和 Debugger sessions，但已经发生的副作用和事件不会回滚或丢失。
- 模型配置在用户点击保存后写入当前浏览器的 chrome.storage.local。
- 不设置 Agent 步数、工具次数、消息长度、工具输出大小或任务时长上限；用户停止或关闭面板时用 AbortController 取消。

## 安装开发版

要求 Chrome 138+、Node.js 和 npm：

~~~sh
npm ci
npm run build
~~~

打开 chrome://extensions，开启“开发者模式”，选择“加载已解压的扩展程序”，然后选择 dist/。点击扩展 Action 图标打开 Side Panel。

点击 Side Panel 中的“打开设置”，或在扩展详情打开“扩展程序选项”，填写：

- OpenAI-compatible API Base URL，例如 https://api.openai.com/v1；
- Model ID；
- API Key。

Chrome 138+ 还需要在扩展详情页开启 “Allow User Scripts”。

开发时可运行：

~~~sh
npm run dev
~~~

## 动态 Chrome 工具

Agent 使用同一个工具发现和操作 Chrome API：

~~~json
{
  "operation": "call",
  "path": "tabs.query",
  "args": [{ "active": true, "currentWindow": true }]
}
~~~

查看能力：

~~~json
{
  "operation": "describe",
  "path": "tabs"
}
~~~

注册 User Script：

~~~json
{
  "operation": "call",
  "path": "userScripts.register",
  "args": [[{
    "id": "page-helper",
    "matches": ["<all_urls>"],
    "js": [{ "code": "document.documentElement.dataset.agent = 'ready'" }],
    "world": "MAIN"
  }]]
}
~~~

Manifest V3 不暴露 chrome.tabs.executeScript：扩展文件或函数注入使用 chrome.scripting.executeScript，任意字符串脚本使用 cdp 的 Runtime.evaluate。

## 日志

选项页的“本地事件日志”支持按分类/关键词查看、导出 JSONL 和清空。日志本身就是 Agent 的对话与上下文来源；日志存储不可用时，运行时使用内存后备实现。

## 验证

~~~sh
npm run check
npm test
npm run test:e2e
~~~

真实 OpenRouter E2E 测试通过环境变量提供 key，不要写入仓库：

~~~sh
OPENROUTER_API_KEY='your-key' npm run test:e2e -- e2e/openrouter.live.spec.ts
~~~

GitHub Autobuild 会运行同样的检查和 Playwright 测试，并发布 side-agent-runtime-autobuild.zip 及 SHA-256 校验文件。解压后仍需通过“加载已解压的扩展程序”安装；开发版不会从 GitHub Release 自动更新。

## 平台边界

扩展权限、host_permissions、受保护页面、Chrome 策略、Debugger 支持的 CDP domain、User Scripts 开关、Provider 的 CORS/限流/上下文窗口和浏览器资源限制仍由平台控制。项目不提供后端、原生 helper、权限审批 UI、代码沙箱或 capability layer；Agent 不受应用层步数、工具次数、消息长度、工具输出大小和任务时长上限限制。

## 获取帮助与贡献

问题反馈请附上 Chrome 版本、平台、扩展构建方式、复现步骤和相关日志分类；请移除 API key、Cookie、Authorization 和其他凭据。修改 public/manifest.json 时同时确认新增权限的必要性，并运行完整检查。

维护者：[notCorwin](https://github.com/notCorwin)。欢迎提交 [Issue](https://github.com/notCorwin/side-agent-runtime/issues) 和聚焦的 Pull Request。
