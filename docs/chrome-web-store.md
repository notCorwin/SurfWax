# Chrome Web Store 发布与更新

Surf Wax 已以简体中文、免费、所有地区、**仅链接可见**的方式上架。商店条目 ID 为 `kkopacjlnfpnpmfeinomkhhcndbdeoih`；用户安装链接为 [Chrome Web Store 页面](https://chromewebstore.google.com/detail/surf-wax/kkopacjlnfpnpmfeinomkhhcndbdeoih)。将此链接用于 README、网站或公告；仅链接可见的条目不会出现在商店搜索结果中。

## 商店页面

- 名称：Surf Wax
- 类别：效率工具
- 简短说明（使用 Manifest 中的说明）：在 Chrome 侧边栏中运行使用自选模型的浏览器智能体。
- 详细说明：

> Surf Wax 是运行在 Chrome 侧边栏中的 AI 浏览器智能体。配置自己选择的模型服务和 API 凭据后，可以用自然语言让它查看网页、操作标签页、填写表单、读取浏览器状态并核查结果。
>
> 扩展支持 Models.dev 中的多种模型提供商，也支持自定义 OpenAI 兼容端点。对话和完整工具日志保存在本机；模型请求从扩展直接发送到你选择的服务。
>
> 智能体可能读取并发送当前任务涉及的网页内容、截图、Cookie、浏览器数据和工具结果，也能按任务创建和管理自动运行的用户脚本。扩展不会对这些内容脱敏或改写。请只连接你信任的模型服务，并查看隐私政策。
>
> 需要 Chrome 138 或更高版本。安装后点击扩展图标打开侧边栏，在设置页配置模型与凭据，然后输入任务。

- 隐私政策：[PRIVACY.md](https://github.com/notCorwin/SurfWax/blob/master/PRIVACY.md)
- 支持链接：https://github.com/notCorwin/SurfWax/issues
- 商店图标：`public/icons/icon-128.png`
- 截图：`docs/store/screenshot-1280x800.png`
- 小型宣传图：`docs/store/promo-440x280.png`

## 隐私字段

- **单一用途**：让用户通过自选 AI 服务在 Chrome 侧边栏中读取、操作并验证浏览器任务。
- **用户数据**：可能处理网页内容、浏览活动、截图、通信内容、身份或认证信息、用户输入及工具结果；范围由任务决定。配置和完整日志保存在本机；模型请求发送到用户选择的服务。参见隐私政策。
- **远程代码**：应如实声明模型可返回 `run-code` 的 JavaScript 函数表达式，扩展通过 `chrome.debugger` 的 CDP 能力在任务上下文执行；智能体也可创建和编辑由 `chrome.userScripts` 注册的自动运行脚本。商店审核需要判断这些用法是否符合 Manifest V3 要求。不要勾选“完全没有远程代码”来规避审核。
- **审核测试说明**：安装后点击扩展图标打开 Side Panel，进入设置页配置自有的 OpenAI 兼容模型端点和 API Key；输入“列出当前窗口的标签页及标题”，随后测试 `snapshot`、`click` 等任务。若审核员需要现成的测试端点或凭据，在提交时通过后台的测试说明字段提供，不能写入仓库或截图。

## 权限用途

下表与 `manifests/store.json` 对齐，只列出当前注册工具与扩展运行时实际使用的权限。当前提供 75 个浏览器工具和 5 个用户脚本工具。

| 权限 | 用途说明 |
| --- | --- |
| `browsingData` | `delete-data` 按用户任务清理指定网站的浏览器数据。 |
| `cookies` | 提供 Cookie 查询、设置和删除命令。 |
| `debugger` | 用 CDP 获取语义快照、输入操作、网络/页面状态及执行任务代码。 |
| `downloads` | 用户明确要求保存时创建或管理下载。 |
| `scripting` | 在任务页面注入操作代码和透明防点击层。 |
| `sidePanel` | 显示主智能体聊天界面。 |
| `storage` | 在本机保存模型配置、凭据和可恢复的扩展状态。 |
| `tabs` | 定位、创建、切换和操作标签页。 |
| `unlimitedStorage` | 在本机保留完整事件日志与较大的任务产物。 |
| `userScripts` | 创建、编辑、启停和恢复用户脚本；用户还需在扩展详情页开启 Allow User Scripts。 |
| `windows` | 定位和操作当前 Chrome 窗口。 |
| `<all_urls>` | 允许智能体在用户指定的网站执行跨站页面任务，并连接自选模型端点。 |

## 后续版本发布

1. 在 `manifests/store.json` 中提高 `version`，并同步 `package.json` 的版本和 README 徽章。Chrome Web Store 要求更新包的 Manifest 版本高于当前已发布版本。同一条目更新时保留原有商店 ID 和安装链接。
2. 运行 `npm run check`、`npm test`、`npm run test:e2e`。推送 `master` 后，Autobuild 工作流会生成 `surf-wax-autobuild.zip` 和 `.sha256`；确认工作流成功，下载对应 commit 的 ZIP 并校验哈希。检查 ZIP 根目录直接包含 `manifest.json`，版本与本次发布一致，Side Panel、设置页、用户脚本管理页和后台入口存在，且没有 `localhost:5173` 开发代码。
3. 在 [Chrome Web Store 开发者后台](https://chrome.google.com/webstore/devconsole)打开现有的 Surf Wax 条目，在“Package”上传新 ZIP。功能、权限、数据用途或页面素材有变更时，同步更新商店介绍、隐私声明、审核测试说明和截图。保持“仅链接可见”和所有地区设置，然后提交审核。不要创建新条目。
4. 审核期间，现有商店用户继续使用已发布版本；新版发布后，Chrome 会向商店安装用户自动分发更新。若新增权限，用户可能需要重新批准。审核通过后检查商店页面版本，并在 macOS、Windows、Linux 的普通 Chrome 138+ 中分别验证安装或更新、打开 Side Panel、配置模型和运行浏览器任务。

仓库文档改动无需上传新的扩展包。开发者模式加载的 Autobuild 解压版不会通过商店自动更新。商店审核如有具体拒绝理由，应修正对应代码或材料后重新测试和提交，不删减现有功能。
