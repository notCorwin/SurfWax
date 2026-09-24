# Chrome Web Store 首次上架材料

Surf Wax 首次发布：简体中文、免费、所有地区、**仅链接可见**（仍需完整审核）。使用现有 Autobuild Release 的 `surf-wax-autobuild.zip` 上传；ZIP 根目录须直接包含 `manifest.json`。商店审核通过前，README 继续指向可加载的解压版。商店条目生成后记录其 ID 和安装链接，审核通过后更新 README。

## 商店页面

- 名称：Surf Wax
- 类别：效率工具
- 简短说明（使用 Manifest 中的说明）：在 Chrome 侧边栏中运行使用自选模型的浏览器智能体。
- 详细说明：

> Surf Wax 是运行在 Chrome 侧边栏中的 AI 浏览器智能体。配置自己选择的模型服务和 API 凭据后，可以用自然语言让它查看网页、操作标签页、填写表单、读取浏览器状态并核查结果。
>
> 扩展支持 Models.dev 中的多种模型提供商，也支持自定义 OpenAI 兼容端点。对话和完整工具日志保存在本机；模型请求从扩展直接发送到你选择的服务。可选的 Jev 服务可辅助选择上下文消息。
>
> 智能体可能读取并发送当前任务涉及的网页内容、截图、Cookie、浏览器数据和工具结果。扩展不会对这些内容脱敏或改写。请只连接你信任的模型服务，并查看隐私政策。
>
> 需要 Chrome 138 或更高版本。安装后点击扩展图标打开侧边栏，在设置页配置模型与凭据，然后输入任务。

- 隐私政策：[PRIVACY.md](https://github.com/notCorwin/SurfWax/blob/master/PRIVACY.md)
- 支持链接：https://github.com/notCorwin/SurfWax/issues
- 商店图标：`public/icons/icon-128.png`
- 截图：`docs/store/screenshot-1280x800.png`
- 小型宣传图：`docs/store/promo-440x280.png`

## 隐私字段

- **单一用途**：让用户通过自选 AI 服务在 Chrome 侧边栏中读取、操作并验证浏览器任务。
- **用户数据**：可能处理网页内容、浏览活动、截图、通信内容、身份或认证信息、用户输入及工具结果；范围由任务决定。配置和完整日志保存在本机；模型请求发送到用户选择的服务，启用 Jev 后相关上下文也发送到 Jev 服务。参见隐私政策。
- **远程代码**：应如实声明模型可返回 `run-code` 的 JavaScript 函数表达式，扩展通过 `chrome.debugger` 的 CDP 能力在任务上下文执行；`run-code` 不加载远程托管的 JS 文件。商店审核需要判断这一用法是否符合 Manifest V3 的 Debugger API 例外。不要勾选“完全没有远程代码”来规避审核。
- **审核测试说明**：安装后点击扩展图标打开 Side Panel，进入设置页配置自有的 OpenAI 兼容模型端点和 API Key；输入“列出当前窗口的标签页及标题”，随后测试 `snapshot`、`click` 等任务。若审核员需要现成的测试端点或凭据，在提交时通过后台的测试说明字段提供，不能写入仓库或截图。

## 权限用途

下表与 `manifests/store.json` 对齐，只列出当前注册工具与扩展运行时实际使用的权限。未注册的旧 `run` 执行器相关权限不随正式包声明；源码保留，现有 75 个聊天工具不变。

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
| `windows` | 定位和操作当前 Chrome 窗口。 |
| `<all_urls>` | 允许智能体在用户指定的网站执行跨站页面任务，并连接自选模型端点。 |

## 提交与验收

1. `npm run check && npm test && npm run test:e2e`；从 CI Autobuild Release 下载与提交 commit 对应的 ZIP，校验其 `.sha256`，检查根目录的 Manifest、Side Panel、设置页和后台入口，并确认没有 `localhost:5173` 开发代码或 User Scripts 权限。
2. 在开发者后台创建新条目、上传 ZIP、填写商店页面与隐私字段，设置所有地区及“仅链接可见”，提交审核。审核如有具体拒绝理由，应修正对应代码或材料后重新测试和提交，不删减现有功能。
3. 审核通过后把商店 URL 加入 README；在 macOS、Windows、Linux 的普通 Chrome 138+ 中分别安装，打开侧边栏、配置模型并运行一个浏览器任务。
