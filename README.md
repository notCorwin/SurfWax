> Attention：本项目的开发难度极大，功能目前只是雏形。
# Surf Wax
Chrome 侧边栏智能体（Agent），让它替你浏览、点击、输入，完成复杂网页任务。
## 为何使用 Surf Wax
### 开箱即用
- 单一（Simple）Chrome 插件，无需安装额外程序。
### BYOK
- 自定义 Provider 和 Model，支持 Tool Calling 就可以用。
- 支持现代推理端点：OpenAI Response、Anthropic Messages、Google (v1) Interactions。
### Snapshot
- 专为 LLM 定制的网页快照技术，节省令牌（Tokens）。
- 以提取肉眼可见的内容为目标；无法确认的内容会标记为未知或不完整。
### Userscript
- 根据用户需要，生成持久化网页 JavaScript 脚本。
- 借助此项目的浏览器工具，智能体可以自主验证脚本可用性，也可以根据反馈改进脚本。
