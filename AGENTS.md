Chrome 138+ Side Panel Agent Harness Manifest V3 Extension

## 需求

1. `chrome()`是智能体唯一的浏览器元工具，提供统一 JavaScript 执行环境，作为“浏览器 Bash”，可跨越扩展特权上下文、`USER_SCRIPT`、`MAIN` 与 CDP。支持范围包括但不限于：

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

2. 基于最新的 Vercel AI SDK；支持 OpenAI Compatible Endpoint BYOK。

3. 日志 = 对话记录 = LLM 上下文，是会话唯一的 canonical event log；UI、LLM context 和会话恢复均由日志重建，用户可从上次离开的地方继续会话，也可删除日志。

4. 日志记录所有内容，每条事件至少记录：`id`、类型、时间、内容；模型事件额外记录 stop reason、usage、provider metadata；工具事件记录 tool call ID、input、output、error；请求记录 retry、abort 和 latency。

5. 不主动为智能体设限，不设计权限系统，专注于在浏览器允许的范围内，最大化智能体能力。

6. 不脱敏网页内容。

7. 对网络错误、408、429、可恢复的 5xx 等可重试错误使用指数退避，单次等待最高 10 秒，加入 jitter，无最大重试次数，直到成功或用户中断。不可恢复错误立即返回。

8. Side Panel 关闭后立即 Abort 当前模型请求，停止产生新的工具调用，并尽力取消正在执行的工具调用；已经发生的浏览器副作用不回滚。

9. 在不改变语义的前提下最大化 Prompt Cache Hit Percent：保持 system prompt、tool schema 和历史上下文前缀稳定，采用 append-only context，避免无必要地修改、重排或重新序列化历史内容；兼容 Provider 特有的 prompt caching 机制。

10. 默认选择可用的最低的思考程度。

11. 当上下文可用百分比不足 20%时，自动压缩上下文。

    1. 上下文大小数据来自 BYOK 在 Models.dev 的模糊匹配；也可以手动设置。


## UI/UX：

1. 套最新版本 Assistant UI 的模板。
2. 跟随浏览器的深浅色模式。
3. 流式接收逐 Token 数据，并按 animation frame 合并 UI 更新；完整支持 **CommonMark + GFM + LaTeX + Footnotes**，包括表格、代码块、语法高亮、任务列表、删除线、链接、引用、脚注及行内/块级数学公式等。目标是在长回复、代码块和复杂 Markdown 场景下仍保持 60 FPS，避免因 Markdown 全量重复解析造成明显卡顿。
4. 用户的消息放在气泡中；LLM 的回复不用，直接跨越两端。
5. 表格用斑马纹（隔行换色）。
6. 可复制的代码块。
7. 1 倍行间距，1.5 倍段间距。

## 交互体验

1. 支持用户消息的编辑、重试与分支
1. 会话重命名、归档与搜索
1. 当前会话未结束时无法切换会话（提示用户）
1. 工具的错误或被中断也作为工具结果返回。
1. 增加一个标签页，专门用于管理与此扩展相关的用户脚本。
1. 智能体运行时，在它连接的网页上增加防用户点击的透明层，防止用户操作影响工作。