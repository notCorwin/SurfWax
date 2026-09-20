# Surf Wax

基于 Chrome 138+ 和 Manifest V3 的 Chrome Side Panel 智能体运行环境（Harness）。

## 核心架构

1. 智能体的工具应尽最大程度，使其获得尽可能完整的浏览器控制能力。

2. 使用最新稳定版 Vercel AI SDK，并支持 OpenAI-Compatible Endpoint 的 BYOK。
4. 日志是整个会话唯一的 Canonical Event Log，不单独维护平行数据源。

4. 不对网页内容进行脱敏、过滤或改写。

## 请求与执行生命周期

1. 对**可恢复**错误自动无限重试，直到请求成功或用户主动中断。单次退避时间最高为 10 秒。
2. Side Panel 关闭时，立即 Abort 当前模型请求和工具调用。


## LLM Context

1. Append-Only：历史上下文前缀保持稳定和可复用，以便命中缓存。

## UI / UX

1. 优先使用 Assistant UI 提供的组件；缺失的部分使用 shadcn/ui。
2. Design Token 是唯一的视觉设计规范。
3. 样式主要通过 Tailwind CSS 实现。
4. 组件本身不得形成彼此独立的视觉规范。
5. 自动跟随浏览器的浅色 / 深色模式。
6. 渲染完整支持 GitHub Flavored Markdown、行内/块级 LaTeX 和语法高亮。
7. 逐 Token 流式接收并渲染模型输出，在任何场景下都以 60 FPS 为目标。
8. 侧边栏 UI 更新 Response 时按 Animation Frame 合并，避免每个 Token 都触发独立渲染。
9. 用户消息使用消息气泡。Assistant 回复不使用气泡背景，正文直接占据消息区域可用宽度。


## 会话与交互

1. 用户消息支持编辑、重试和分支。

2. 会话支持重命名、归档和搜索。
3. 会话运行时禁止切换到其他会话。
4. 工具调用无论成功、失败还是被中断，都必须生成对应的 Tool Result。
5. 提供独立的 User Scripts 管理标签页，用于查看和管理由本扩展维护的持久化脚本。
6. 智能体正在操作某个网页时，在对应页面覆盖透明的 Interaction Blocker，阻止用户点击、输入等操作干扰智能体当前任务；不影响智能体自身的页面操作。


## 开发约定

1. 完成有效修改后，主动创建 Git Commit 并 Push 到当前远程分支。
2. GitHub Actions 的结果可作为参考。
