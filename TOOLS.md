# 命令参考

以下所有命令始终可用，并且只操作当前 Chrome 窗口。尖括号中的参数（如 `<angle brackets>`）为必填项，方括号中的参数（如 `[square brackets]`）为可选项。

## 核心命令

| 命令 | 说明 |
|---|---|
| `goto <url>` | 跳转到指定 URL |
| `type <text>` | 在当前聚焦的可编辑元素中输入文本 |
| `click <target> [button]` | 单击元素 |
| `dblclick <target> [button]` | 双击元素 |
| `fill <target> <text>` | 在可编辑元素中填写文本 |
| `drag <startTarget> <endTarget>` | 在两个元素之间执行拖放操作 |
| `drop <target>` | 从页面外部将文件或数据拖放到元素上 |
| `hover <target>` | 将鼠标悬停在元素上 |
| `select <target> <val>` | 在下拉菜单中选择一个选项 |
| `upload <files...>` | 上传一个或多个文件 |
| `check <target>` / `uncheck <target>` | 选中或取消选中复选框或单选按钮 |
| `snapshot [target]` | 捕获页面快照以获取元素引用 |
| `find [text]` | 搜索页面快照，并返回匹配项及其上下文 |
| `eval <func> [target]` | 在页面或元素上执行 JavaScript |
| `dialog-accept [prompt]` / `dialog-dismiss` | 处理对话框 |
| `resize <w> <h>` | 调整浏览器窗口大小 |
| `delete-data` | 删除当前浏览器目标访问过的网站数据 |

另请参阅：[交互](https://playwright.dev/agent-cli/commands/interaction)、[导航](https://playwright.dev/agent-cli/commands/navigation)和[对话框](https://playwright.dev/agent-cli/commands/dialogs)。

## 导航

| 命令 | 说明 |
|---|---|
| `go-back` | 返回上一页 |
| `go-forward` | 前进到下一页 |
| `reload` | 重新加载当前页面 |

## 键盘

| 命令 | 说明 |
|---|---|
| `press <key>` | 按下按键，例如 `Enter` 或 `ArrowLeft` |
| `keydown <key>` / `keyup <key>` | 按住或释放按键 |

## 鼠标

使用截图中的像素坐标进行交互，适用于画布应用、地图以及没有无障碍元素的自定义控件。

| 命令 | 说明 |
|---|---|
| `mousemove <x> <y>` | 将鼠标移动到指定坐标 |
| `mousedown [button]` / `mouseup [button]` | 按下或释放鼠标按键 |
| `mousewheel <dx> <dy>` | 使用鼠标滚轮滚动 |

另请参阅：[视觉模式](https://playwright.dev/agent-cli/vision-mode)。

## 保存为

| 命令 | 说明 |
|---|---|
| `screenshot [target]` | 截取页面或元素的屏幕截图 |
| `pdf` | 将页面保存为 PDF |

另请参阅：[截图与 PDF](https://playwright.dev/agent-cli/commands/screenshots-pdf)。

## 标签页

| 命令 | 说明 |
|---|---|
| `tab-list` | 列出所有标签页 |
| `tab-new [url]` | 新建标签页 |
| `tab-close [index]` | 关闭指定标签页；未提供索引时关闭当前标签页 |
| `tab-select <index>` | 切换到指定标签页 |

另请参阅：[标签页](https://playwright.dev/agent-cli/commands/tabs)。

## 存储

| 命令 | 说明 |
|---|---|
| `cookie-list`、`cookie-get`、`cookie-set`、`cookie-delete` | 管理 Cookie |
| `localstorage-list/get/set/delete/clear` | 管理 localStorage |
| `sessionstorage-list/get/set/delete/clear` | 管理 sessionStorage |

另请参阅：[存储与身份验证](https://playwright.dev/agent-cli/commands/storage)。

## 网络

| 命令 | 说明 |
|---|---|
| `requests` | 列出网络请求并编号，以供 `request` 使用 |
| `request <index>` | 查看单个请求的完整详情 |
| `request-headers <index>` / `request-body <index>` | 查看请求的指定部分 |
| `response-headers <index>` / `response-body <index>` | 查看响应的指定部分 |
| `route <pattern>` | 模拟与 URL 模式匹配的请求 |
| `route-list` | 列出当前生效的路由 |
| `unroute [pattern]` | 移除匹配的路由；未提供模式时移除全部路由 |
| `network-state-set <state>` | 将浏览器设置为在线或离线状态 |

另请参阅：[网络与模拟](https://playwright.dev/agent-cli/commands/network-routing)。

## 开发者工具

| 命令 | 说明 |
|---|---|
| `console [min-level]` | 列出控制台消息 |
| `run-code [code]` | 运行 Playwright 代码片段 |
| `recording-start` / `recording-stop` | 录制用户操作并输出为 Playwright 代码 |
| `tracing-start` / `tracing-stop` | 记录执行跟踪 |
| `video-start [filename]` / `video-stop` | 录制视频 |
| `video-chapter <title>` | 在视频中添加章节标记 |
| `video-show-actions` / `video-hide-actions` | 在录制的视频中显示或隐藏操作标注 |
| `pause-at <location>`、`resume`、`step-over` | 控制已暂停的测试 |
| `generate-locator <target>` | 为元素生成 Playwright 定位器 |
| `highlight [target]` | 显示或隐藏页面上的高亮覆盖层 |

另请参阅：[控制台与求值](https://playwright.dev/agent-cli/commands/console-eval)、[代码生成与高亮](https://playwright.dev/agent-cli/commands/codegen)、[跟踪](https://playwright.dev/agent-cli/commands/tracing)、[视频录制](https://playwright.dev/agent-cli/commands/video-recording)和[测试调试](https://playwright.dev/agent-cli/commands/test-debugging)。

## 安装

| 命令 | 说明 |
|---|---|
| `install` | 初始化工作区，并可选择安装技能 |
| `install-browser [browser]` | 安装浏览器 |

另请参阅：[安装](https://playwright.dev/agent-cli/installation)。
