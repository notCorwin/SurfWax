# Surf Wax
让 LLM 在 Chrome Side Panel 中高效操作网页和浏览器。
高级设置：默认由系统自动检测、推断或配置，不在常规界面主动展示，但允许用户手动查看和修改。
## 核心架构
1. Chrome 138+，Manifest V3。
2. 单一 Chrome Extension，不桥接 Desktop App。
3. 使用唯一 Canonical Event Log（唯一权威事件日志）同时作为日志和对话记录。
## 特殊需求
1. 不对网页内容进行脱敏、过滤或改写。
## 模型调用
1. 以 `@ai-sdk/openai-compatible` 为核心模型调用基础。
2. 所有 LLM 和 Provider 数据从 Models.dev 获取。
3. 预置 Provider 与对应 Base URL 绑定，无需用户单独配置。
4. 仅在接入自定义 Provider 时允许手动指定 Base URL。
5. 支持用户在任何情况下自定义 Model ID。
6. 如果无法获取`Context Window`和`max_tokens`的数据，则默认分别设置为`256000`和`128000`（这两项作为高级设置）。
7. 必须支持的端点包括但不限于（作为高级设置）：
	1. `/v1/chat/completions`
	2. `/v1/completions`
	3. `/v1/responses`
	4. `/v1/messages`
	5. `/v1beta/models/{model}:generateContent`
	6. `/v1beta/interactions`
	7. `/v1beta/openai/chat/completions`
## LLM Context & Permissions
1. 通过附加消息的方式，保证历史上下文前缀保持稳定和可复用，以便命中缓存。
2. 不对智能体做步数或权限上的限制。
3. 当上下文容量不到 20% 时，自动压缩上下文。
4. 将所有工具的简明定位拼接在系统提示词后，便于用户自定义系统提示词。
## UI / UX
1. 自动跟随浏览器的浅色 / 深色模式。
2. 渲染完整支持 GitHub Flavored Markdown、行内 / 块级 LaTeX 和语法高亮。
3. 逐 Token 流式接收并渲染模型输出，在任何高压场景下都要至少达到 120 帧。
4. 侧边栏 UI 更新 Response 时按 Animation Frame 合并，避免每个 Token 都触发独立渲染。
5. 用户消息使用消息气泡。Assistant 回复不使用气泡背景，正文直接占据消息区域可用宽度。
## 会话与交互
1. 用户消息支持编辑、复制和分支；Assistant 消息支持复制、重试和分支。按钮只在会话暂停/完成时出现。
2. 会话支持重命名、删除和搜索。删除无需二次确认。
3. 当前会话运行时，禁止用户切换到其他会话，或做对会话有影响的事情（如分支）。
4. 工具调用无论成功、失败还是被中断，都必须生成对应的 Tool Result。
5. User Scripts 支持管理页和智能体工具；脚本定义与启停状态由扩展持久化，升级或启动时恢复已启用脚本。
6. 智能体正在操作某个网页时，在对应页面覆盖透明的 Interaction Blocker，阻止用户点击、输入等操作干扰智能体当前任务；不影响智能体自身的页面操作。在 Interaction Blocker 上添加半透明呼吸动画用于状态显示。
## macOS 浏览器测试执行环境
1. 在 macOS 的 Codex 命令沙箱中，Playwright 启动 Chrome 会因无法访问 LaunchServices / WindowServer 而在 `TransformProcessType` / `_RegisterApplication` 阶段触发 SIGABRT；同一沙箱也会阻止 E2E 的 localhost 服务监听。
2. 执行 Playwright E2E、`npm run test:e2e`、`npm run test:performance` 或其他会启动 Chrome 的验证时，首次调用就应使用 `exec_command` 的 `sandbox_permissions: "require_escalated"`，使整个 Node / Playwright 进程及其浏览器子进程在沙箱外运行。按执行环境的审批机制完成授权后，继续运行完整验证。
3. Chrome 的 `--no-sandbox` 和 headless 模式不会解除父进程继承的 Codex Seatbelt 限制。遇到上述启动栈或 localhost `listen EPERM` 时，应改用正确的执行环境重跑；不通过删除测试、跳过断言、减少扩展能力或反复重装浏览器处理。
