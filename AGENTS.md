## 需求

1. Chrome 138+ Side Panel Agent Harness Manifest V3 Extension。

2. `chrome()`是智能体唯一的浏览器元工具，提供统一 JavaScript 执行环境，作为“浏览器 Bash”，可跨越扩展特权上下文、`USER_SCRIPT`、`MAIN` 与 CDP。支持范围包括但不限于：

   1. Chrome Extension API
   2. Web API
   3. 网页自身环境
   4. CDP
   5. 持久的 User Script
      1. Agent 可以自由查看、编辑、运行、保存或者删除脚本。
      2. 不实现额外的代码沙箱、权限沙箱或 capability layer。
      3. 不支持 Greasemonkey。
      4. 由 Harness 自己持久化，并在扩展更新后自动注册。

   工具调用按顺序执行，不并发。Harness 不为具体 Chrome API、Web API、CDP Domain 或浏览器能力定义独立工具。

3. 基于最新的 Vercel AI SDK；支持 OpenAI Compatible Endpoint BYOK。

4. 日志 = 对话记录 = LLM 上下文，可被用户从上次离开的地方继续，或者被删除。
   日志不是 UI 聊天记录的副本，而是唯一的 canonical event log；UI、LLM context、恢复会话都从日志重建。

5. 日志记录所有内容，每条事件至少记录：`id`、类型、时间、内容；模型事件额外记录 stop reason、usage、provider metadata；工具事件记录 tool call ID、input、output、error；请求记录 retry、abort 和 latency。

6. 不主动为智能体设限，不设计权限系统，专注于在浏览器允许的范围内，最大化智能体能力。

7. 不脱敏网页内容。

8. 对网络错误、408、429、可恢复的 5xx 等可重试错误使用指数退避，单次等待最高 10 秒，加入 jitter，无最大重试次数，直到成功或用户中断。不可恢复错误立即返回。

9. Side Panel 关闭后立即 Abort 当前模型请求，停止产生新的工具调用，并尽力取消正在执行的工具调用；已经发生的浏览器副作用不回滚。

10. 在不改变语义的前提下最大化 Prompt Cache Hit Percent：保持 system prompt、tool schema 和历史上下文前缀稳定，采用 append-only context，避免无必要地修改、重排或重新序列化历史内容；兼容 Provider 特有的 prompt caching 机制。

11. 关于 UI/UX：

    1. 套最新版本 Assistant UI 的模板。
    2. 流式接收逐 Token 数据，并按 animation frame 合并 UI 更新，目标在长回复、代码块和复杂 Markdown 下仍保持 60 FPS，不因 Markdown 全量重复解析而产生明显卡顿。**CommonMark + GFM + LaTeX + Footnotes**，至少完整支持表格、代码块、语法高亮、任务列表、删除线、链接、引用、脚注、行内/块级数学公式等。
    4. 用户的消息放在气泡中；LLM 的回复不用，直接跨越两端。