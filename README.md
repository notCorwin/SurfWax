# Surf Wax

[![Autobuild Release](https://github.com/notCorwin/SurfWax/actions/workflows/autobuild.yml/badge.svg)](https://github.com/notCorwin/SurfWax/actions/workflows/autobuild.yml)
[![Chrome 138+](https://img.shields.io/badge/Chrome-138%2B-4285F4?logo=googlechrome&logoColor=white)](https://www.google.com/chrome/)
[![Version](https://img.shields.io/badge/version-0.2.0-blue)](manifests/store.json)

Surf Wax 是一个 Chrome 138+ Manifest V3 Side Panel Agent Harness。它使用 Vercel AI SDK v7 和 Assistant UI，直接连接用户配置的 OpenAI-compatible Provider，并只向模型提供一个 `browser` 工具。

`browser` 默认以 `observe` / `act` JSON DSL 提供语义定位、自动等待、截图与真实输入；`run` 是 JavaScript 逃生舱，可访问完整 Chrome Extension API、页面对象、执行上下文和原始 CDP。

## 为什么使用它

- **一个工具同时提高下限与保留上限**：普通模型只需生成合法动作 JSON；强模型仍可通过 `run` 使用 JavaScript、Chrome API 和 CDP。
- **纯浏览器扩展**：没有守护进程、远程执行器或中间服务；模型请求从扩展直接发送到配置的 Provider。
- **可恢复的本地多对话**：IndexedDB 中的 append-only event log 是对话列表、UI、模型上下文和中断恢复的唯一事实来源。
- **持久 User Scripts**：Agent 可通过原生 `chrome.userScripts` 查看、注册、更新、运行和删除脚本；Harness 保存注册快照，并在扩展启动或更新后恢复。
- **不中断的 Agent 循环**：工具调用严格串行，不设应用级步骤上限、执行超时或输出上限，直到模型自然结束或用户中止。
- **可中止的无限重试**：网络错误、408、429 和可恢复的 5xx 使用带 jitter 的指数退避，单次等待最多 10 秒。
- **流畅的富文本输出**：逐 Token 流式显示 CommonMark、GFM、脚注、LaTeX、表格、任务列表、代码高亮等内容，同时保持输入框响应。

## 安装

### 安装 Autobuild

从 [Autobuild Release](https://github.com/notCorwin/SurfWax/releases/tag/autobuild) 下载并解压 `surf-wax-autobuild.zip`，然后：

1. 打开 `chrome://extensions`。
2. 开启右上角的“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择包含 `manifest.json` 的解压目录。

发布页同时提供 `.sha256` 校验文件。

### 从源码构建

需要 Chrome 138+、Node.js 22（CI 基准版本）和 npm：

```sh
git clone https://github.com/notCorwin/SurfWax.git
cd SurfWax
npm ci
npm run build
```

然后按上面的 Chrome 步骤加载生成的 `dist/` 目录。修改源码后重新运行 `npm run build`，再在 `chrome://extensions` 中重新加载扩展。

### 开发时热更新

开发扩展时只需一条命令：

```sh
npm run dev
```

该命令会启动 Vite、加载专用的 Playwright Chromium、打开测试网页和真实 Side Panel。修改 Side Panel、设置页或样式后会通过 HMR 原地更新并保留页面状态；修改后台 Service Worker 或 Manifest 时会自动重新加载扩展并恢复 Side Panel。模型配置、对话和 User Scripts 保存在 Git 忽略的 `.dev/chromium-profile/` 中，删除该目录即可重置开发环境。

可在命令后指定启动网页；只启动 Vite/CRXJS 时使用 `npm run dev:vite`：

```sh
npm run dev -- https://example.com
npm run dev:vite
```

开发服务器固定使用 `localhost:5173`，端口已被占用时会直接报错。若本机尚未安装 Playwright Chromium，先运行 `npx playwright install chromium`。

## 首次配置

1. 点击扩展图标打开 Side Panel。
2. 点击标题栏中的设置按钮。
3. 填写 Provider 的 **Base URL**、**Model ID** 和 **API Key**。Base URL 应包含 Provider 要求的 API 前缀，例如 `https://provider.example/v1`。
4. 保存配置并返回 Side Panel。
5. 如需使用持久 User Scripts，在扩展详情页开启 **Allow User Scripts**。

Side Panel 标题栏的脚本按钮会打开独立的用户脚本页面。列表可搜索、多选、批量启停/删除、导入和导出；点击脚本进入全屏编辑，也可复制为新脚本。导入先预览，同名脚本逐项选择是否覆盖；导入/导出文件仅包含 Chrome 原生 `RegisteredUserScript[]` JSON，不包含启停状态。编辑器会高亮 `CSS_*` 静态字符串中的 CSS，保存时自动格式化 JavaScript 和静态 CSS。停用的脚本可继续编辑，且不会在扩展重启后自行启用。新脚本的网站范围需要明确填写。高级编辑入口保留 Chrome 原生 `RegisteredUserScript` JSON 格式及全部字段。

模型配置只保存在当前扩展的 `chrome.storage.local` 中。Provider 必须支持 OpenAI-compatible Chat Completions、流式响应和 tool calling，并允许扩展发起跨域请求。

聊天框中模型名旁可选择思考强度，默认使用已知的最低档；若端点未公开档位，则从 `none` 开始，在真实请求被明确拒绝时逐步调整。选择按 Base URL 和 Model ID 保存在本地；端点不支持该参数时使用端点默认值。

高级设置中的 Jev 消息选择支持 TypeSafe AI、Vercel AI Gateway、OpenRouter、Cloudflare Workers AI、LiteLLM Proxy、Opper、AI/ML API，以及自定义 System One 或 Decisions 端点。切换平台会填入默认地址和模型，Base URL 与 Model ID 仍可修改；清空 Jev API Key 即停用。Netlify AI Gateway 仅在 Netlify Functions 中自动注入 Jev 凭证和端点，因此属于部署环境兼容能力，不作为浏览器扩展的内置选项。

## 使用

直接用自然语言描述浏览器任务，例如：

```text
列出当前窗口中的全部标签页，并返回标题和 URL。
```

模型通常先调用 `browser({ mode: "observe" })`，再用 `browser({ mode: "act", steps: [...] })` 操作。只有 DSL 无法表达时才使用 `mode: "run"`；其中 `code` 是异步函数体，必须显式 `return`。旧 `chrome` / `page` 调用会继续在历史对话中显示，但不再注册给新请求。

实时检查能力：

```json
{
  "mode": "run",
  "code": "return await chrome.capabilities()"
}
```

### Chrome Extension API

```json
{
  "mode": "run",
  "code": "return await chrome.tabs.query({ currentWindow: true });"
}
```

### 任意执行上下文

```json
{
  "mode": "run",
  "code": "return await browser.runIn({ kind: 'page', tabId: 123, world: 'MAIN' }, 'return document.title');"
}
```

`run` 默认运行在扩展上下文；页面 DOM 优先使用 `const page = await browser.page(tabId); return await page.evaluate(...)`。`browser.runIn(target, code)` 同时接受正式的 ChromeTarget 和 `browser.page(tabId)` 返回的 PageFacade；所有 `run` 代码都必须显式 `return`。

页面目标优先通过原生 `chrome.userScripts.execute` 执行；该接口不可用时，`MAIN` 使用 CDP，`USER_SCRIPT` 返回明确错误。脚本执行失败不会自动换通道重试。

### 原始 CDP

```json
{
  "code": "const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); await chrome.debugger.attach({ tabId: tab.id }, '1.3'); try { return await chrome.debugger.sendCommand({ tabId: tab.id }, 'Runtime.evaluate', { expression: 'document.title', returnByValue: true }); } finally { await chrome.debugger.detach({ tabId: tab.id }); }"
}
```

跨多次调用时，保留 `chrome.debugger` 附加的页面会话及 `chrome.debugger.onEvent` 监听器；完成后主动 `detach`，关闭面板也会解除附加。跨进程 iframe 和 worker 可用 `Target.setAutoAttach({ autoAttach: true, flatten: true, waitForDebuggerOnStart: false })` 获取子会话，并在 `sendCommand` 的 debuggee 中传入 `sessionId`。同进程 iframe 可从 `Runtime.executionContextCreated` 找到 `contextId`；页面导航后重新查找上下文。

不超过 8 KiB 的 JSON 值直接返回。更大的结果先完整写入事件日志，再返回事件 ID、大小、可用顶层键和可复制的读取示例；可在后续 `run` 中用 `await browser.result(id, { path: "snapshot", offset: 0, limit: 4000 })` 或数组路径读取，并只 `return` 所需字段或片段。此引用关闭面板后仍可读取，删除所属对话时失效。

### 持久 User Script

```json
{
  "mode": "run",
  "code": "await chrome.userScripts.register([{ id: 'page-helper', matches: ['<all_urls>'], js: [{ code: \"document.documentElement.dataset.agent = 'ready'\" }], world: 'MAIN' }]); return await chrome.userScripts.getScripts({ ids: ['page-helper'] });"
}
```

Side Panel 关闭时，Harness 会立即中止当前模型请求，阻止排队的工具调用启动，并尽力取消执行中的工具和 detach 自己创建的调试会话。已经发生的浏览器副作用不会回滚。

### 语义网页自动化

日常网页操作使用 `observe` / `act`。观察返回当前文档的 `observationId`、稳定短 ref、角色、名称、状态、允许动作、viewport 和相对 `since` 的变化；语义不足或显式请求时附加 JPEG 截图：

```json
{
  "mode": "act",
  "steps": [
    { "type": "fill", "target": { "by": "label", "value": "邮箱" }, "value": "me@example.com" },
    { "type": "click", "target": { "by": "role", "value": "button", "name": "登录" } },
    { "type": "expect", "target": { "by": "text", "value": "欢迎回来" }, "state": "visible" }
  ]
}
```

支持 role/text/label/placeholder/alt/title/testId/CSS、frame、ref 和截图 point 目标，以及导航、点击、填写、键盘、选择、勾选、拖拽、上传和 `expect`。语义定位使用 Chrome Accessibility tree；ref 仅在同文档存在唯一完全匹配节点时安全重绑。point 必须携带截图的 `observationId`，导航或 viewport/缩放变化后会被拒绝。

动作成功只表示浏览器输入已经发送，不代表业务流程完成。应在同一批次加入 `expect`，验证目标元素状态、文本、值或 URL。批次首次失败后停止并返回已完成、失败、未执行步骤及刷新后的观察；已发生的副作用不会重放或回滚。

`run` 继续提供完整 Chrome Extension API、任意页面 JavaScript、User Script 与原始 CDP。两层共用同一 CDP session、定位器、串行队列、页面防点击层、Abort 生命周期和事件日志；扩展不依赖 Native Messaging 或生产环境 Playwright。

智能体运行时，已连接或操作的网页会覆盖防点击层；导航后会重装，结束或中止时移除。通过 CDP 注入鼠标或触摸手势时，防点击层会短暂透传，以便智能体操作页面。Chrome 不允许脚本注入的页面会在面板显示提示。

重新打开 Side Panel 后，已生成的文本、推理和工具结果会从事件流恢复并标记为“回复已中断”。只有最新的中断回复提供“继续”按钮；继续时会先要求 Agent 根据已有工具结果确认当前状态，不会自动重放浏览器操作。标题栏的对话按钮可新建、切换和永久删除单条本地对话；仅切换对话不会停止后台运行中的回复。

## 数据与隐私

事件日志会记录完整对话、模型 stop reason、usage、provider metadata、工具输入/输出/错误，以及请求 retry、abort 和 latency；网页内容不会脱敏。Side Panel 从日志恢复历史，并将历史作为后续模型上下文。

设置页的“清空对话与日志”会永久删除新旧本地事件日志，但保留模型配置。旧版没有 `conversationId` 的事件会原样保留在数据库中，但不会出现在新版对话列表；升级不会删除事件表。扩展声明广泛的 Chrome 权限和 `<all_urls>` host access，以便 `browser.run` 使用浏览器允许的最大能力范围。

## 架构

| 部分 | 职责 |
| --- | --- |
| `src/sidepanel/` | Side Panel 会话、配置加载、恢复和关闭生命周期 |
| `src/agent/` | OpenAI-compatible 模型、无限重试、Agent 循环和流式 transport |
| `src/chrome/` | 单一 `browser` 工具、动作 DSL、语义/视觉观察与共享 JavaScript/CDP 执行器 |
| `src/logging.ts` | IndexedDB canonical event log 与对话重建 |
| `src/userscripts/` | 原生 User Script 快照、迁移和恢复 |
| `src/options/` | BYOK 设置和日志清理 |

系统 prompt、工具 schema 和历史消息前缀保持稳定；新上下文只追加到日志，以提高兼容 Provider 的 prompt cache hit rate。

## 开发与验证

```sh
npm run check      # TypeScript 检查并构建
npm test           # Vitest 单元测试
npm run test:e2e   # 构建并运行真实扩展 Playwright 测试
git diff --check
```

`npm run test:e2e` 会启动带扩展的 Playwright Chromium，并使用本地 OpenAI-compatible SSE mock 验证工具执行、多对话切换、标题、日志与中断恢复、User Scripts、流式 Markdown 和关闭中止行为。CI 在每次推送到 `master` 时运行同一套检查，并更新 Autobuild 压缩包和 SHA-256 校验文件。

实现或评审改动前，请先阅读 [AGENTS.md](AGENTS.md) 中的项目要求。

## 获取帮助

- 缺陷与功能请求：[GitHub Issues](https://github.com/notCorwin/SurfWax/issues)
- 构建或测试失败：附上 Chrome、Node.js 版本、复现步骤和相关日志后提交 Issue
- 项目行为与约束：[AGENTS.md](AGENTS.md)

请勿在 Issue 中粘贴 API Key、私密网页内容或未经处理的完整事件日志。

## 维护与贡献

项目由 [notCorwin](https://github.com/notCorwin) 维护。欢迎提交聚焦、可验证的 Pull Request：

1. Fork 仓库并从最新 `master` 创建分支。
2. 保持单一 `browser` 工具和 canonical event log 语义不变。
3. 为非平凡行为添加最小覆盖，并运行上面的完整验证命令。
4. 不要提交 `dist/`、测试报告或本地密钥。

仓库目前没有 `LICENSE` 文件；除非维护者另行授权，否则不应假定获得任何使用、修改或分发许可。
