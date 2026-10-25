# Surf Wax
让无视觉能力的 LLM 在 Chrome Side Panel 中高效操作网页和浏览器。
高级设置：默认由系统自动检测、推断或配置，不在常规界面主动展示，但允许用户手动查看和修改。
## 核心架构
1. Chrome 138+，Manifest V3。
2. 统一使用开发构建流程，不使用生产构建流程。
3. 单一 Chrome Extension，不桥接 Desktop App。Side Panel 为主要执行环境。
4. 使用追加式 Canonical Event Log（唯一权威事件日志）同时作为日志和对话记录。
## 模型调用
1. 使用 Vercel AI SDK 作为统一架构：
	1. `ai`
	2. `openai-compatible`
	3. `openai`
	4. `anthropic`
	5. `google`
2. 所有 LLM 和 Provider 数据从 Models.dev 获取。
3. 预置 Provider 与对应 Base URL 绑定，无需用户单独配置。自定义 Base URL 作为高级设置。
4. 支持用户在任何情况下自定义 Model ID。
5. `Context Window`和`max_tokens`作为高级设置。如果无法获取它们的数据，则默认`Context Window = 256000`；不传递`max_tokens`，除非是 Anthropic（类），则传递`max_tokens = 128000`。
6. 必须支持的端点包括但不限于（作为高级设置）：
	1. `/v1/chat/completions`
	2. `/v1/completions`
	3. `/v1/responses`
	4. `/v1/messages`
	5. `/v1beta/models/{model}:generateContent`
	6. `/v1beta/interactions`
	7. `/v1/interactions`
	8. `/v1beta/openai/chat/completions`
## LLM Context & Permissions
1. 通过附加消息的方式，保证历史上下文前缀保持稳定和可复用，以便命中缓存。
2. 不对智能体做步数或权限上的限制。
3. 当上下文容量不到 20% 时，自动压缩上下文。
4. 将所有工具的简明定位拼接在系统提示词后，便于用户自定义系统提示词。
5. 不对网页内容隐私脱敏和内容审查。
## UI / UX
1. 自动跟随浏览器的浅色 / 深色模式。
2. 渲染完整支持 GitHub Flavored Markdown、行内 / 块级 LaTeX 和语法高亮。
3. 用户消息使用消息气泡。Assistant 回复不使用气泡背景，正文直接占据消息区域可用宽度。
## 会话与交互
1. 用户消息支持编辑、复制和分支；Assistant 消息支持复制、重试和分支。按钮只在会话暂停/完成时出现。
2. 会话支持重命名、删除和搜索。删除无需二次确认，但允许短时间内撤销。
3. 当前会话运行时，禁止用户切换到其他会话，或做对会话有影响的事情（如分支）。
4. 工具调用无论成功、失败还是被中断，都必须生成对应的 Tool Result。
5. 智能体正在操作某个网页时，在对应页面覆盖透明的 Interaction Blocker，阻止用户点击、输入等操作干扰智能体当前任务；不影响智能体自身的页面操作。在 Interaction Blocker 上添加半透明呼吸动画用于状态显示。
## 用户脚本 chrome/browser.userScripts()
1. 用户可以通过脚本管理页管理脚本。
2. 智能体可以通过工具启用、禁用、列出、阅读、编辑脚本。
3. 脚本定义与启停状态由扩展持久化，升级或启动时恢复已启用脚本。
