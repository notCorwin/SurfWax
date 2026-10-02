# Surf Wax

[![Verify and Release](https://github.com/notCorwin/SurfWax/actions/workflows/autobuild.yml/badge.svg)](https://github.com/notCorwin/SurfWax/actions/workflows/autobuild.yml)
[![Chrome 138+](https://img.shields.io/badge/Chrome-138%2B-4285F4?logo=googlechrome&logoColor=white)](https://www.google.com/chrome/)
[![Version](https://img.shields.io/github/package-json/v/notCorwin/SurfWax)](package.json)

Surf Wax 是 Chrome 138+ 的 Manifest V3 Side Panel 智能体运行环境。它使用 Vercel AI SDK 和 Assistant UI，直接连接用户选择的 Provider 或 OpenAI-compatible Endpoint，支持 BYOK。

智能体使用 49 个独立、结构化工具完成网页阅读、表单、导航、多标签任务、画布输入、文件上传、截图、PDF、只读网络诊断和用户脚本。工具目录由源码 registry 生成，见 [工具参考](Playwright-Tools.md)。

## 安装与首次配置

在 [Chrome Web Store](https://chromewebstore.google.com/detail/surf-wax/kkopacjlnfpnpmfeinomkhhcndbdeoih) 安装后点击扩展图标打开 Side Panel。打开设置，选择 Provider 或自定义 Endpoint，填写凭据和模型，保存配置后即可发送任务。

也可从 [版本发布页](https://github.com/notCorwin/SurfWax/releases) 下载对应版本的 ZIP 和 `.sha256` 文件，核对 SHA-256，解压后在 `chrome://extensions` 开启开发者模式并选择“加载已解压的扩展程序”。商店版通过商店更新；已解压版本需要手动更新。正式版本发布绑定不可变的 Git 标签和提交，不覆盖已有版本产物。`autobuild` 是经过单元与 Chrome 双版本功能测试的可变测试渠道，标记为 prerelease，不会占用 Latest。

Provider 配置保存在本机 `chrome.storage.local`，按 Provider 隔离。设置页会刷新 Models.dev 模型目录，并保留目录不可用时的自定义 Endpoint。模型上下文容量未匹配时使用 256K；用户可覆盖容量及图片支持状态。

## 任务与会话

- 每轮绑定当前 Chrome 窗口的目标标签页，用户切换活动页面不会改变任务目标；工具可以显式选择该窗口内其他标签页。
- 历史上下文保持稳定前缀，工具的简短定位追加到第一条用户消息。剩余容量不足 20% 或 Provider 报上下文超限时自动生成摘要。
- 可恢复请求错误无限重试，单次退避不超过 10 秒；可查看重试状态或立即停止。
- 关闭真实 Side Panel 会中止模型请求、工具及排队调用。操作成功、失败和中断都写入 Tool Result，已发生的网页操作不会回滚或自动重放。
- 运行中锁定会话切换；用户消息可编辑、重试和分支，会话支持搜索、重命名、归档和删除。
- 正在操作的页面有透明防干扰层。智能体输入通过同一生命周期执行，任务结束后释放。
- 截图、PDF 和大型结果默认作为会话内部产物。用户明确要求保存时直接下载文件，无需再次授权。下载失败或任务中断后，内部产物仍可再次保存，无需重新生成。

用户脚本有独立管理页和五个智能体工具。脚本定义及启停状态由扩展持久化，并在启动或升级时恢复已启用脚本。使用前在 Chrome 扩展详情页开启 **Allow User Scripts**。

## 权限与数据

必需权限由实际功能逐项对应：

| 权限 | 用途 |
| --- | --- |
| debugger | 可访问性、截图和真实浏览器输入的 CDP 执行 |
| scripting | 安装和释放页面防干扰层 |
| sidePanel | 原生 Side Panel |
| storage | 本地配置、凭据及用户脚本定义 |
| tabs | 当前窗口标签页的标题、URL 和目标管理 |
| unlimitedStorage | 本地 canonical event log 和产物 |
| userScripts | 注册、恢复、启停用户脚本 |
| downloads | 用户明确保存时下载内部产物 |
| `<all_urls>` | 跨网站网页任务、用户脚本及用户指定模型端点 |

扩展不提供开发者运营的中转或同步服务。网页及工具内容不会脱敏、过滤或改写；用于模型上下文的内容会直接发送到用户配置的模型服务。对话、工具结果、重试和中断记录均来自本地 IndexedDB 的 canonical event log。删除、导出和保留规则见 [隐私政策](PRIVACY.md)。

## 开发与验证

需要 Node.js 24、npm 和 Chrome 138+：

```sh
npm ci
npm run build
npm run dev
```

`npm run dev` 启动 localhost:5173、加载专用 Chromium、开启 Allow User Scripts 并打开真实 Side Panel。UI 支持 HMR；后台或 Manifest 变化会重新加载扩展。开发配置及测试证据存放在仓库旁的 `../.dev/chromium-profile/`。不要清理该目录后再提交失败报告。

```sh
npm run docs:tools       # 从唯一 registry 生成工具参考
npm run docs:check       # 拒绝过期工具文档
npm run measure:tools    # 实测目录与 JSON schema 字节及可用 BPE token 数
npm run check           # 类型、独立构建及产物契约校验
npm test                # 单元测试
npm run test:e2e         # 功能 E2E，包含历史版本升级
npm run test:performance # 本地性能测试；GitHub Actions 不运行
npm run release:package  # 构建、ZIP、SHA-256 和 release notes
```

E2E 按设置、自动化、会话、上下文、生命周期、渲染、用户脚本、发布与升级及性能划分，共用真实扩展夹具和本地 Provider 协议 mock。失败会保留完整临时 profile；IndexedDB 证据复制到 `../.dev/chromium-profile/Default/IndexedDB/`，trace/screenshot 位于 `test-results/`。

指定 Chrome 可执行文件，或同时验证最低版本与当前版本：

```sh
SURFWAX_CHROME_PATH=/path/to/current/chrome npm run test:e2e
SURFWAX_CHROME_138_PATH=/path/to/chrome138 SURFWAX_CHROME_PATH=/path/to/current/chrome npm run test:e2e
node scripts/install-test-browser.mjs 138
node scripts/install-test-browser.mjs current
```

功能 CI 使用 Chrome for Testing 的 138 和当前 Stable。性能测试仅本地运行；测量真实 animation frame 间隔和输入事件到下一帧延迟，不使用 Playwright 输入命令耗时替代界面响应。版本只有 `package.json` 一个来源，构建校验 lockfile 和产物版本一致。

## 架构与贡献

`src/sidepanel/` 管理会话与生命周期，`src/agent/` 管理模型、请求与上下文，`src/chrome/` 提供 registry 和共享浏览器执行器，`src/logging.ts` 提供 canonical event log，`src/userscripts/` 与 `src/options/` 分别提供脚本和配置管理。

贡献前阅读 [AGENTS.md](AGENTS.md)。修改功能后运行相关测试和完整类型/构建检查；性能验证在本地完成。不要提交构建产物、浏览器 profile 或凭据。缺陷和功能请求请提交 [GitHub Issue](https://github.com/notCorwin/SurfWax/issues)，附版本、复现和经过自行审阅的诊断。仓库目前没有 LICENSE 文件，分发许可需由维护者另行确定。
