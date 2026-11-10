# 独立运行 LLM Tools

Node 24 下无需安装扩展即可调用生产工具。入口复用 `PROGRAM_TOOL_REGISTRY`、`createProgramTools`、`ChromeExecutor`、快照生成器和结果日志；CDP 适配器负责浏览器连接，Node Worker 复用扩展的程序执行协议与值编解码。取消或超时会终止 Worker。

## 命令行

先用本机安装的 Google Chrome 启动一个专用、无扩展、默认缩放的测试 Profile：

```sh
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --remote-debugging-port=9222 \
  --user-data-dir="$PWD/.dev/standalone-chrome" about:blank
```

另一个终端启动工具入口：

```sh
npm run --silent tools
```

标准输入每行一个请求，标准输出每行一个结果；诊断信息写入标准错误。EOF 结束运行并清理连接。多个请求共享一次运行的页面绑定、观察基线、事件订阅、作业与产物：

```json
{"id":1,"name":"list_tabs","input":{}}
{"id":2,"name":"navigate","input":{"url":"https://example.com"}}
{"id":3,"name":"inspect_page","input":{}}
```

输出形式为 `{"id":1,"result":...}`；工具失败保留生产结果中的 `ok:false` 和恢复指导，协议错误为 `{"id":1,"error":"..."}`。

`SURFWAX_CDP_URL` 可指定 HTTP CDP 地址或浏览器 WebSocket 地址。`npm run --silent tools -- --list` 无需浏览器，输出工具名称、说明和 JSON Schema。程序化使用时导入 `src/standalone/runtime.ts` 的 `connectToolRuntime(endpoint)`，通过 `.call(name, input, signal?)` 调用，并始终在 finally 中 `await runtime.close()`。`.tools` 可直接传给 AI SDK；`.events` 提供此次运行的 Canonical Event Log。

源码通过 Vite SSR 按需加载，不启动开发服务器或构建扩展。

## 元素 ID

`inspect_page` 的每个 item 都有 `id`。只有 `actionable:true` 的 item 才绑定一个真实元素，可直接传给 `click`、`fill` 等工具；`find_elements` 同样返回 `id`，不再返回独立的元素 `ref`。文本、路径和聚合项仍有用于快照补丁的 ID，但不能作为操作目标。Frame 继续使用单独的 `frameRef`。

```js
const snapshot = await runtime.call("inspect_page", { full: true });
const button = snapshot.items.find(item => item.actionable && item.role === "button" && item.name === "登陆");
await runtime.call("click", { target: { id: button.id } });
```

ID 使用递增的短 36 进制编号，例如 `1`、`2`、`a`、`10`；归属信息保存在内部。扩展持久保存分配进度，独立 Node 入口在进程内共享分配进度；清理绑定不重置编号。

ID 限定所属标签页、文档与运行；点击前重新核验节点身份和可操作状态。只读采样通过隔离世界内的弱引用绑定实际节点，并校验原始标签证据（包括闭合 Shadow DOM）。旧 ID 失效后返回 `stale-id`，不会重新按名称查找或按旧坐标猜测点击。保留角色、文本、CSS 等定位器，便于寻找尚未出现在快照中的具体元素。

## 测试与边界

```sh
npm run test:tools
```

测试使用 Playwright 的 `channel: "chrome"` 启动本机 Chrome，无头运行，不下载 Chromium 或 Chrome for Testing。单独的测试配置避免普通单测启动浏览器。覆盖实际输入、点击、可见快照、弹窗/对话框事件、标签页操作、错误回执与 Worker 强制终止。

动态页面的一致性检查无法完成时，工具可返回同步采样的只读视口快照，保留 `partial:true`、`limitations` 和未知字段。独立模式通过 CDP 提供真实开放/闭合 ShadowRoot；采样期间的 Shadow DOM 拓扑变化会使读取失效，避免把隐藏的 Light DOM 当成可见文字。

此入口用于专用测试浏览器：所有页面映射到一个逻辑窗口，tab ID 为连接内稳定编号，不是扩展的原生 tab ID。当前不声明真实窗口管理或浏览器缩放设置一致性。页面上下文请求仍在页面执行；原扩展上下文的请求在 Node 执行，因此不证明扩展 Cookie、CORS 或权限行为。

用户脚本注册和 Chrome 下载 API 返回明确的 `extension-required` 错误；这部分继续使用扩展测试。原生产 Schema 和工具目录保持一致，避免按测试环境维护另一份工具定义。产物和日志仅保存在此次 Node 运行内存，关闭后不持久化。本入口不证明 MV3 Worker 生命周期、侧栏交互或完整模型任务完成能力。
