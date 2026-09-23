# Surf Wax

[![Autobuild Release](https://github.com/notCorwin/SurfWax/actions/workflows/autobuild.yml/badge.svg)](https://github.com/notCorwin/SurfWax/actions/workflows/autobuild.yml)
[![Chrome 138+](https://img.shields.io/badge/Chrome-138%2B-4285F4?logo=googlechrome&logoColor=white)](https://www.google.com/chrome/)
[![Version](https://img.shields.io/badge/version-0.2.0-blue)](manifests/store.json)

Surf Wax 是一个 Chrome 138+ Manifest V3 Side Panel Agent Harness。它使用 Vercel AI SDK v7 和 Assistant UI，从扩展直接连接 Models.dev Provider 或用户配置的 OpenAI-compatible Endpoint。

模型通过 80 个独立、结构化命令工具操作 Chrome；常规流程是 `snapshot` / `find`、执行操作、再次验证。`run-code` 只提供现有 Playwright 风格 `page` facade，不向模型暴露任意 Chrome Extension API、执行上下文或原始 CDP。

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
npm run dev -- https://polymarket.com/zh
npm run dev:vite
```

开发服务器固定使用 `localhost:5173`，端口已被占用时会直接报错。若本机尚未安装 Playwright Chromium，先运行 `npx playwright install chromium`。

## 首次配置

1. 点击扩展图标打开 Side Panel。
2. 点击标题栏中的设置按钮。
3. 选择 Models.dev Provider，填写 **Model ID** 和页面显示的凭据字段；自定义 Endpoint 需要填写 Base URL 与 API Key。
4. 保存配置并返回 Side Panel。
5. 如需使用持久 User Scripts，在扩展详情页开启 **Allow User Scripts**。

Side Panel 标题栏的脚本按钮会打开独立的用户脚本页面。列表可搜索、多选、批量启停/删除、导入和导出；点击脚本进入全屏编辑，也可复制为新脚本。导入先预览，同名脚本逐项选择是否覆盖；导入/导出文件仅包含 Chrome 原生 `RegisteredUserScript[]` JSON，不包含启停状态。编辑器会高亮 `CSS_*` 静态字符串中的 CSS，保存时自动格式化 JavaScript 和静态 CSS。停用的脚本可继续编辑，且不会在扩展重启后自行启用。新脚本的网站范围需要明确填写。高级编辑入口保留 Chrome 原生 `RegisteredUserScript` JSON 格式及全部字段。

模型配置只保存在当前扩展的 `chrome.storage.local` 中，并按 Provider 隔离。设置页支持普通 API Key，也支持 Bedrock、Azure、Vertex、Cloudflare、GitLab、Watsonx 和 SAP AI Core 等多字段凭据；Models.dev Endpoint 中的 `${VAR}` 会自动变成独立输入项并在请求前插值。

每次打开设置页都会向 Models.dev 校验 Provider 和模型目录，并更新模型上下文限制；离线时继续使用已缓存的目录并显示提示。模型运行期间沿用本地缓存，不持续轮询 Models.dev。

当前 Registry 覆盖 2026-09-22 Models.dev 的 223 个 Provider、28 个 `npm` SDK 标识。兼容浏览器的 `@ai-sdk/*`、AIHubMix、OpenRouter、SaladCloud 与 Merge Gateway 按需加载原包；QVAC、Venice、Cloudflare AI Gateway、GitLab Duo、watsonx.ai 和 SAP AI Core 使用等价浏览器协议适配，不需要 Native Messaging、Node 服务或远程代理。未来出现的未知 SDK 会在加入 Registry 后才可执行。

模型列表默认只推荐 Models.dev 中 `tool_call: true` 且输出文本的模型。Provider 没有符合条件的目录模型时仍可手填 Model ID；例如 Perplexity 当前会提示浏览器工具可能不可用。`/models` 能力探测只用于 OpenAI-compatible Endpoint，原生 SDK 使用 Models.dev 的 Provider/Model 元数据。

聊天框中模型名旁可选择思考强度，默认使用已知的最低档；若端点未公开档位，则从 `none` 开始，在真实请求被明确拒绝时逐步调整。选择按 Base URL 和 Model ID 保存在本地；端点不支持该参数时使用端点默认值。

高级设置中的 Jev 消息选择支持 TypeSafe AI、Vercel AI Gateway、OpenRouter、Cloudflare Workers AI、LiteLLM Proxy、Opper、AI/ML API，以及自定义 System One 或 Decisions 端点。切换平台会填入默认地址和模型，Base URL 与 Model ID 仍可修改；清空 Jev API Key 即停用。Netlify AI Gateway 仅在 Netlify Functions 中自动注入 Jev 凭证和端点，因此属于部署环境兼容能力，不作为浏览器扩展的内置选项。

## 使用

直接用自然语言描述浏览器任务，例如：

```text
列出当前窗口中的全部标签页，并返回标题和 URL。
```

模型使用 80 个独立命令 Tool，而不是一个多模式 `browser()`：通常先调用 `snapshot` 或 `find` 获取 ref，再调用 `click`、`fill`、`select` 等命令，并在操作后重新检查页面状态。完整命令表见 [TOOLS.md](./TOOLS.md)。旧 `browser`、`chrome`、`page` 调用只在历史对话中显示，不再注册给新请求。

```jsonc
// snapshot
{}

// fill
{ "target": { "by": "label", "value": "邮箱" }, "text": "me@example.com" }

// click
{ "target": "getByRole('button', { name: '登录' })" }
```

`target` 可使用快照 ref、CSS、常见 Playwright locator 字符串，或结构化 role/text/label/placeholder/alt/title/testId/CSS locator。定位器继续自动等待、严格匹配并在 DOM 更新后重新解析。

所有命令只操作打开 Side Panel 时所在的 Chrome 窗口。每轮任务开始时，Surf Wax 会绑定当时的活动标签页，并向模型提供该窗口全部标签页的索引、标题和 URL；页面正文仍由模型按需调用 `snapshot` 或 `find` 获取。`goto` 导航当前目标标签页，`tab-new` 在该窗口中新建标签页；Surf Wax 不创建、连接或关闭独立 Chrome 窗口。标签页索引从 0 开始。

仅当专用命令无法表达任务时使用 `run-code`，其输入为接收现有 Playwright 风格 `page` facade 的单个异步函数表达式；不再向模型暴露任意 Chrome Extension API、原始 CDP、任意执行上下文或大结果 `$ref`。

截图会下载并作为图片提供给下一模型步骤；PDF、存储状态、Chrome Trace 和 WebM 视频保存到 Chrome 下载目录。上传与外部拖放使用包含 `text`、`base64` 或 `url` 的内存文件对象，不接受本机文件路径。

Side Panel 关闭时，Harness 会立即中止当前模型请求，阻止排队的工具调用启动，并尽力取消执行中的工具和 detach 自己创建的调试会话。已经发生的浏览器副作用不会回滚。

所有命令共用同一 CDP session、串行队列、页面防点击层、Abort 生命周期和事件日志；扩展不依赖 Native Messaging 或生产环境 Playwright。动作成功只表示输入已经发送，模型必须检查返回状态或重新调用 `snapshot` 验证业务结果。

智能体运行时，已连接或操作的网页会覆盖防点击层；导航后会重装，结束或中止时移除。通过 CDP 注入鼠标或触摸手势时，防点击层会短暂透传，以便智能体操作页面。Chrome 不允许脚本注入的页面会在面板显示提示。

重新打开 Side Panel 后，已生成的文本、推理和工具结果会从事件流恢复并标记为“回复已中断”。只有最新的中断回复提供“继续”按钮；继续时会先要求 Agent 根据已有工具结果确认当前状态，不会自动重放浏览器操作。标题栏的对话按钮可新建、切换和永久删除单条本地对话；仅切换对话不会停止后台运行中的回复。

## 数据与隐私

事件日志会记录完整对话、模型 stop reason、usage、provider metadata、工具输入/输出/错误，以及请求 retry、abort 和 latency；网页内容不会脱敏。Side Panel 从日志恢复历史，并将历史作为后续模型上下文。

设置页的“清空对话与日志”会永久删除新旧本地事件日志，但保留模型配置。旧版没有 `conversationId` 的事件会原样保留在数据库中，但不会出现在新版对话列表；升级不会删除事件表。扩展声明广泛的 Chrome 权限和 `<all_urls>` host access，以支持命令式浏览器自动化。

## 架构

| 部分 | 职责 |
| --- | --- |
| `src/sidepanel/` | Side Panel 会话、配置加载、恢复和关闭生命周期 |
| `src/agent/` | Models.dev SDK Registry、浏览器协议适配、无限重试、Agent 循环和流式 transport |
| `src/chrome/` | 80 个命令工具、语义/视觉自动化与共享 Chrome/CDP 执行器 |
| `src/logging.ts` | IndexedDB canonical event log 与对话重建 |
| `src/userscripts/` | 原生 User Script 快照、迁移和恢复 |
| `src/options/` | BYOK 设置和日志清理 |

系统 prompt、工具 schema 和历史消息前缀保持稳定；新上下文只追加到日志，以提高兼容 Provider 的 prompt cache hit rate。

## 开发与验证

```sh
npm run check      # TypeScript 检查并构建到 .dev/check-dist/，不覆盖开发扩展
npm test           # Vitest 单元测试
npm run test:e2e   # 构建并运行真实扩展 Playwright 测试
git diff --check
```

`npm run test:e2e` 会启动带扩展的 Playwright Chromium，并使用本地协议 mock 验证 Provider 配置、工具执行、多对话切换、标题、日志与中断恢复、User Scripts、流式 Markdown 和关闭中止行为。单元测试覆盖 28 个 SDK 工厂以及 Cloudflare、GitLab、Watsonx、SAP 的浏览器协议映射；CI 不需要真实收费 Provider 凭据。

实现或评审改动前，请先阅读 [AGENTS.md](AGENTS.md) 中的项目要求。

## 获取帮助

- 缺陷与功能请求：[GitHub Issues](https://github.com/notCorwin/SurfWax/issues)
- 构建或测试失败：附上 Chrome、Node.js 版本、复现步骤和相关日志后提交 Issue
- 项目行为与约束：[AGENTS.md](AGENTS.md)

请勿在 Issue 中粘贴 API Key、私密网页内容或未经处理的完整事件日志。

## 维护与贡献

项目由 [notCorwin](https://github.com/notCorwin) 维护。欢迎提交聚焦、可验证的 Pull Request：

1. Fork 仓库并从最新 `master` 创建分支。
2. 保持独立浏览器命令工具和 canonical event log 语义不变。
3. 为非平凡行为添加最小覆盖，并运行上面的完整验证命令。
4. 不要提交 `dist/`、测试报告或本地密钥。

仓库目前没有 `LICENSE` 文件；除非维护者另行授权，否则不应假定获得任何使用、修改或分发许可。
