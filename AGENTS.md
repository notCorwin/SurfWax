# Surf Wax
在 Chrome 侧边栏（Side Panel）中，实现 LLM 代替人类操作浏览器，完成复杂的网页长任务。
## 核心架构
1. Chrome Manifest V3
2. Vercel AI SDK：`ai`，`openai-compatible`，`google`，`anthropic`
3. Simple Chrome Extension，不桥接本地程序
4. 使用追加式 Canonical Event Log（唯一权威事件日志）同时用于一轮工作的日志记录和对话记录。
## 开发约定
1. 只使用开发构建流，热更新 Extension 改动，方便测试。
## 设置页
1. 所有 LLM 和 Provider 在设置的下拉菜单中选择，数据来自 Models.dev 项目。
	1. Provider 与 Base URL 默认绑定
	2. Model ID 可以从下拉菜单中选择，也可以自定义
	3. 可以模糊搜索下拉菜单
2. 必须支持的端点包括但不限于（高级设置），按时间排序：
	1. OpenAI： `/v1/responses`
	2. Anthropic：`/v1/messages`
	3. Google：`/v1/interactions`
3. 以下设置默认由系统自动检测、推断或配置，不在常规界面主动展示，但允许用户手动查看和修改的设置：
	1. Base URL
	2. Context Window（Fallback = 256,000）
	3. Max Tokens（Fallback = 128,000）
## Harness Design
1. 将所有工具的简明定位拼接在系统提示词后，便于用户自定义系统提示词。
2. 通过追加消息，保证历史上下文前缀保持稳定和可复用，以便命中缓存。
3. 不对智能体的操作做次数限制，或者权限限制。
4. 当上下文达到 80% 时，自动压缩上下文。
5. 不对网页内容隐私脱敏和内容审查。
### LLM Tools Design
1. 在每次操作完成后，自动向 LLM 发送操作结果，和最新的网页快照。
2. 每个 Simple 操作对应一个 Simple 工具。
3. 总是发送完全加载后的快照。
## UI / UX
1. 自动跟随浏览器的浅色 / 深色模式。
2. 渲染功能 1:1 复刻 GitHub Flavored Markdown，再加上行内 / 块级 LaTeX 渲染。
### 会话与交互
1. 用户消息仅支持编辑和复制；Assistant 消息仅支持复制、重试和分支。这些操作只在会话暂停/完成时可用。
2. 当前会话运行时，禁止用户切换到其他会话，或做对会话有影响的事情（如分支）。提示用户必须暂停。
3. 用户消息使用消息气泡。Assistant 回复不使用气泡背景，正文直接占据消息区域可用宽度。
4. 工具调用无论成功、失败还是被中断，都必须有反馈。
5. 会话支持重命名、搜索和删除。
## 用户脚本 `.userScripts()`
1. 用户可以通过脚本管理页管理脚本。
2. 智能体可以通过工具启用、禁用、列出、阅读、编辑脚本。
3. 脚本定义与启停状态由扩展持久化，升级或启动时恢复已启用脚本。
