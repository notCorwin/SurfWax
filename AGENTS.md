# Chrome 138+ Side Panel Agent Harness

基于 Manifest V3 的 Chrome Side Panel 智能体运行环境。

## 核心架构

1. 浏览器自动化由两个互补的元工具组成，工具调用严格串行执行：

   - `chrome()`：Extension API、Web API、持久化 User Script、页面 JavaScript 与原始 CDP，定位类似“浏览器里的 Bash”。
   - `page()`：Playwright 风格的 Page、Locator、自动等待、语义快照与网页工作流。

   两个工具共用 CDP bridge、串行队列、Abort、interaction blocker 和 canonical event log。`chrome()` 应最大程度暴露浏览器本身允许访问的能力，包括但不限于：

   - Chrome Extension API
   - Web API
   - 页面自身的 JavaScript 环境
   - Chrome DevTools Protocol
   - 持久化 User Script

   不为具体 Chrome API、Web API、CDP Domain 或单个浏览器能力额外定义独立工具。底层能力通过 `chrome()`，语义网页工作流通过 `page()` 统一访问。

   网页观察和交互优先使用 `page()`；浏览器管理、特殊 API、任意 JavaScript 和未封装能力使用 `chrome()`。`page()` 借鉴 Playwright API，但不依赖或承诺兼容 Playwright package。

2. User Script 由 Harness 自身负责持久化，并在扩展更新或重新加载后自动恢复注册。

   不增加额外的代码沙箱、权限沙箱或 capability layer。

   不实现 Greasemonkey 兼容层。

3. 使用最新稳定版 Vercel AI SDK，并支持 OpenAI-Compatible Endpoint 的 BYOK。

4. 日志是整个会话唯一的 canonical event log。

   不单独维护“聊天记录”“模型上下文”或“恢复状态”等平行数据源。

   以下状态全部从日志派生和重建：

   - UI
   - LLM context
   - 会话恢复
   - 工具执行记录
   - 请求状态

   用户可以从上次中断的位置继续会话，也可以删除已有日志。

5. 日志必须完整记录会话事件。

   所有事件至少包含：

   - `id`
   - event type
   - timestamp
   - content

   模型事件额外记录：

   - stop reason
   - usage
   - provider metadata

   工具事件额外记录：

   - tool call ID
   - input
   - output
   - error

   模型请求额外记录：

   - retry
   - abort
   - latency

6. Harness 不主动限制智能体能力。

   不设计独立权限系统，也不人为收缩浏览器已经允许扩展访问的能力。目标是在 Chrome 安全模型允许的边界内，让智能体获得尽可能完整的浏览器控制能力。

7. 不对网页内容进行脱敏、过滤或改写。

8. 不引入宿主进程。整个系统保持为 Chrome Manifest V3 Extension。

## 请求与执行生命周期

1. 对可恢复错误自动重试，包括：

   - 网络错误
   - HTTP 408
   - HTTP 429
   - 可恢复的 HTTP 5xx
   - 其他明确属于临时故障的错误

   使用带 jitter 的指数退避。

   单次退避时间最高为 10 秒。

   不设置最大重试次数，持续重试直到：

   - 请求成功；或
   - 用户主动中断。

   不可恢复错误立即返回。

2. Side Panel 关闭时：

   - 立即 Abort 当前模型请求；
   - 不再产生新的工具调用；
   - 尽力取消尚未完成的工具调用。

   已经发生的浏览器副作用不执行回滚。

## LLM Context

1. 在不改变上下文语义的前提下，尽可能提高 Prompt Cache Hit Percent。

   核心原则：

   - system prompt 保持稳定；
   - tool schema 保持稳定；
   - 已存在的历史上下文前缀保持稳定；
   - context 尽量 append-only；
   - 避免无必要地修改、重排或重新序列化历史消息；
   - 兼容不同 Provider 自身的 prompt caching 机制。

2. 默认使用模型可用的最低 thinking/reasoning effort。

3. 当剩余可用 context 低于总 context window 的 20% 时，自动执行上下文压缩。

4. 模型 context window 默认通过 BYOK 模型名称在 Models.dev 中进行模糊匹配获得，同时允许用户手动覆盖。

## UI / UX

1. 优先使用 Assistant UI 提供的组件；缺失的部分使用 shadcn/ui。

2. Design Token 是唯一的视觉设计规范。

   样式主要通过 Tailwind CSS 实现，组件本身不得形成彼此独立的视觉规范。

3. 自动跟随浏览器的浅色 / 深色模式。

4. 模型输出以逐 Token 流式接收。

   UI 更新按 animation frame 合并，避免每个 Token 都触发独立渲染。

   Markdown 渲染完整支持：

   - CommonMark
   - GFM
   - LaTeX
   - Footnotes
   - 表格
   - 代码块
   - 语法高亮
   - Task List
   - 删除线
   - 链接
   - 引用
   - 脚注
   - 行内/块级数学公式

   长回复、长代码块和复杂 Markdown 场景下仍以 60 FPS 为目标。

   避免在流式输出过程中反复完整解析全部 Markdown，从而造成明显卡顿。

5. 用户消息使用消息气泡。

   Assistant 回复不使用气泡背景，正文直接占据消息区域可用宽度。

6. 表格使用 zebra striping。

7. 所有适合复制的代码块提供复制功能。

## 会话与交互

1. 用户消息支持：

   - 编辑
   - Retry
   - Branch

2. 会话支持：

   - 重命名
   - 归档
   - 搜索

3. 当前会话仍在运行时禁止切换到其他会话，并明确提示原因。

4. 工具调用无论成功、失败还是被中断，都必须生成对应的 tool result，使 event log 和 LLM tool-call 状态始终闭合。

5. 提供独立的 User Scripts 管理标签页，用于查看和管理由本扩展维护的持久化脚本。

6. 智能体正在操作某个网页时，在对应页面覆盖透明的 interaction blocker，阻止用户点击、输入等操作干扰智能体当前任务。

   blocker 仅阻止用户交互，不影响智能体自身的页面操作。

## 开发约定

完成有效修改后，主动：

1. 创建 Git commit；
2. push 到当前远程分支。

除非存在明确阻塞，不等待额外确认。
