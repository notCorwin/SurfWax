# 程序工具改造

公开工具固定为 inspect、run、jobs。旧 49 个工具的 registry、schema、执行入口、目录选择及侧栏 DevTools 求值宿主已移除；旧名称不能翻译或分发到新执行器。

inspect 默认返回带 tab/document 归属的语义文本，支持区域、字段、预算、截断和增量输出。明确请求 image=true 才取图。run 使用可销毁的 opaque-origin sandbox Worker 执行组合程序；page、browser、net、protocol、artifacts 共用现有浏览器实现。定位、批量与表单、frame、输入与 Canvas、导航与多标签页、上传下载、原生对话框、诊断、页面 JavaScript 及持久 MAIN/USER_SCRIPT 脚本仍可组合使用。执行域和网络上下文显式指定，Chrome 权限维持八项。

jobs 在动作队列外读取 canonical 记录，支持增量结果、等待、取消和宿主丢失后的 interrupted 状态。取消不回滚；已经派发而结果未知的动作需要重新观察，不能盲目重放。浏览器初始化结束后检查取消栅栏；下载等待可中止，已经派发的下载仍可能完成。保存已有产物前记录 canonical browser.artifact.used 引用，关闭侧栏后可以追踪原始字节。

旧对话、工具结果、产物、用户消息里的历史目录和分支保持可读，不重写用户数据。旧会话继续或重试时追加 context.prompt.updated，统一注册三工具；自定义提示词和成功压缩保留用户指导并附加当前 API。失败压缩保留原始历史及已迁移的新目录。

入口和 API 详见 [工具参考](tools.md)。验证使用 Node 24、Chrome 138 与当前 Chrome；运行 npm run verify:local。浏览器用例逐项检查业务结果、canonical 回执及外部副作用；100 次点击 P95≤100ms 与 120Hz 绘制 P95≤8.33ms、错过截止时间≤1% 阈值保持不变。旧工具测试已转换到组合程序并保留业务断言，同时覆盖旧历史读取、新回合三工具、旧名称拒绝、取消与部分成功后的恢复。正式化旧版本报告和 JSON 是历史验证证据，不能用作本次运行结果。
