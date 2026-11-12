# 决策历史

本文根据仓库提交历史，记录未在当前 `AGENTS.md` 及工程约定中明确写出的产品与架构决策，不作为逐次改动的 Changelog。提交历史整理范围截至 `6632914`（2026-11-04）；其后已实际采用的决策可引用当前实现。提交日期采用作者日期。

每项列出决策、必要的演变背景和来源提交。已撤销的方案明确标出，避免将历史实现误认为当前要求；这里只归纳提交及代码能够支持的取舍，不推测未记录的动机。

## 会话与交互

### 运行期间的追加输入进入队列

2026-09-19 引入后续消息队列：任务运行时，用户可以继续输入，消息按 FIFO 顺序等待发送。只有前一轮正常完成后才自动发送下一条；失败或中止不会自动触发后续消息。队列状态由事件重建。

来源：[`6bd736d`](https://github.com/notCorwin/SurfWax/commit/6bd736d)，当前实现见 `src/agent/followups.ts`。

### 会话不再提供归档

2026-10-13 删除归档能力，简化会话列表行操作。当前约定列出的重命名、搜索、删除来自这次收敛；归档不是待恢复的遗漏功能。

来源：[`a7922bf`](https://github.com/notCorwin/SurfWax/commit/a7922bf)。

### 会话选择使用锚定下拉菜单

2026-10-13 用锚定下拉菜单替代会话对话框；2026-11-01 调整为全宽菜单，继续精简搜索和行操作。

来源：[`c5ba9a0`](https://github.com/notCorwin/SurfWax/commit/c5ba9a0)、[`c9d2e5c`](https://github.com/notCorwin/SurfWax/commit/c9d2e5c)、[`99f23b8`](https://github.com/notCorwin/SurfWax/commit/99f23b8)。

### 推理、工具和等待合并到活动时间线

2026-11-03 至 11-04，将连续推理与工具活动归组，并将等待状态插入同一时间线。最终移除滚动切换动画及“只保留最近三项”的显示限制；已结束的推理和工具使用合并摘要。推理行显示的时间来自请求事件，表示包含推理、生成、网络等待的模型响应总耗时，不表示纯推理时间。计时刷新使用共享的可见时钟。

来源：[`fd5fde6`](https://github.com/notCorwin/SurfWax/commit/fd5fde6)、[`10fb8c1`](https://github.com/notCorwin/SurfWax/commit/10fb8c1)、[`ab36eb9`](https://github.com/notCorwin/SurfWax/commit/ab36eb9)、[`5681d32`](https://github.com/notCorwin/SurfWax/commit/5681d32)、[`83bd2b9`](https://github.com/notCorwin/SurfWax/commit/83bd2b9)、[`7ff3926`](https://github.com/notCorwin/SurfWax/commit/7ff3926)。

## 模型与上下文

### 端点选择以显式配置为准

普通 Google Provider 在未显式指定端点时使用 Interactions；显式端点优先于目录中的模型路由信息。自由输入模型时清除上一个目录模型的路由信息，避免沿用不属于新模型的协议。

来源：`90a474a`、`c598ced`，见 `src/agent/model.ts`。

### SDK 目录关卡与可选模型共用资格判定

SDK 目录检查与设置页预设共用模型资格：必须声明工具调用，且输出模态包含文本；未声明输出模态时沿用既有预设行为。关卡只对符合资格的路由检查 SDK 名称和 GitLab 路由元数据，报告仍保留完整目录的未支持 SDK、路由及排除原因。该关卡不证明协议、认证或实际模型兼容性。

来源：`c6391c0`，见 `scripts/sdk-coverage.mjs`、`src/types.ts`。

### 删除 Jev 消息选择服务

2026-09-18 引入 Jev 消息选择式压缩，随后扩展多 Provider 支持；2026-09-27 删除这项功能及其配置和依赖。自动上下文压缩保留，但不再依赖 Jev 进行消息选择。

来源：[`88e1163`](https://github.com/notCorwin/SurfWax/commit/88e1163)、[`e2363d6`](https://github.com/notCorwin/SurfWax/commit/e2363d6)、[`ab38d16`](https://github.com/notCorwin/SurfWax/commit/ab38d16)。

### 内置可离线使用的 Models.dev 目录

2026-10-14 将模型目录打包进扩展，使首次使用及离线场景不必等待在线目录。在线刷新继续更新目录，目录版本变化同时影响模型限制缓存及路由；内置数据经过校验，在线响应也会检查目录规模和 OpenAI 模型是否存在，拒绝明显不完整的数据。

来源：[`f9ef8a2`](https://github.com/notCorwin/SurfWax/commit/f9ef8a2)。

### 普通 Provider 不享受特殊排序

2026-11-04 取消 Vercel Provider 的优先位置。自定义入口之外的 Provider 按名称排序，同名时按 ID 排序，不再单独置顶 Vercel。

来源：[`0551138`](https://github.com/notCorwin/SurfWax/commit/0551138)。

### 发送、压缩和计数共享模型上下文投影

2026-11-04 统一执行请求、压缩和上下文计数所使用的提示词及工具定义。内部上下文消息拥有事件位置和消息锚点，可在恢复时按原位置重建；截图数据使用独立的持久化模型消息传递。UI 的可见分支树与模型上下文投影不要求完全同形。

来源：[`902eeb0`](https://github.com/notCorwin/SurfWax/commit/902eeb0)，见 `src/agent/context-projection.ts`、`src/agent/context-prompt.ts`。

请求容量判断集中在 `src/agent/context-budget.ts`：固定提示和工具定义先检查，有可压缩历史且满足增长保护时，达到有效输入预算的 80% 即触发自动压缩；非整数边界取向上整 token，发送、压力判断和 UI 抢占运行租约前使用同一阈值。空历史、不可约的固定开销和未增长的已压缩前缀不因此反复抢租约或请求摘要。最终仍必须检查完整请求是否超出输入预算，必要的强制压缩也不能放行超额请求。运行器负责提供压缩、补充浏览器输入和持久化适配；压缩后重新计入补充输入，不能只检查摘要大小。

模型限制由装配层解析并作为本次运行的快照传给运行器；压力估算和摘要生成也接收明确的限制，不自行读取模型目录。图像输入优先服从用户显式设置，否则使用同一限制快照中的输入模态。压缩和运行器测试使用真实事件记录器及内存事件存储，避免用全局网络替身或手写日志接口模拟这些边界。该隔离验证不替代模型目录解析、取消及浏览器端到端行为的验证。

模型上下文以本次请求明确指定、已经持久化的实际分支 head 为锚。重试与编辑沿该分支重建，不发送被替换的旧答案；尚未产生新输出的失败仍保留原 UI 历史。即使没有新事件，head 改变也必须使上下文缓存失效，不能复用另一分支的投影。

来源：`f9aaa1a`，见 `src/agent/context-choice.ts`、`src/agent/runner.ts`、`src/agent/transport.ts`、`src/components/chat/local-composer.tsx`。

首次回复尚未持久化时，补充观察虽锚定共享用户消息，仍归属其实际运行；可证明归属的投影只纳入当前 Assistant 分支的运行及明确的活跃运行；无法归属的旧记录保留原锚定语义，不能借此放行已知兄弟运行。重试和无输出失败的观察不能污染旧答案分支，当前重试也不能丢失自己的新观察。运行身份与 head、日志代次共同决定投影缓存和 UI 计数失效；切回或重载旧分支须恢复相同的原始模型上下文，而不只比较取整百分比。

来源：`src/agent/context-projection.ts`、`src/agent/context-choice.ts`、`src/agent/transport.ts`、`src/components/chat/local-composer.tsx`。

模型请求的重试原因与等待状态来自 Canonical 请求生命周期，仅展示结构化错误分类对应的安全文案，不将提供商原始错误体写入用户提示。通用 `TypeError` 只有在可信模型请求边界才可解释为 fetch 网络故障；普通 UI 错误保持安全的未知分类，结构化 status、code 与 cause 仍按同一分类规则处理。倒计时按事件中的实际延迟计算，共享低频时钟并在到期或卸载时停止；新请求、停止和终态清除旧等待，其他运行的迟到事件不能覆盖当前状态。该反馈不证明模型正在思考，也不改变重试策略。

来源：`fdf724f`，见 `src/model-error.ts`、`src/agent/model.ts`、`src/components/chat/waiting-status.tsx`、`src/components/chat/use-activity-clock.ts`。

会话重命名、新建与消息操作（包括切换分支）的异常保留原对象，统一经 `ErrorNotice` 的安全边界展示；编辑态、页头和消息操作提示不能直接输出异常的 message 或字符串化结果。空名称与运行忙碌属于独立的固定应用提示，不与未知操作失败混用；取消、输入修正和后续操作清除相应旧错误。错误展示不绕过运行互斥、不把未知失败一概判为忙碌或网络故障，也不因失败切换会话、分支或丢弃既有历史。

来源：`src/components/chat/thread-list.tsx`、`src/components/chat/thread.tsx`、`src/sidepanel/App.tsx`、`e2e/canonical-session.spec.ts`、`e2e/context.spec.ts`。

## 工作模式与完成判定

### 工作模式通过显式工具结束

2026-11-01 引入目标模式，随后将工作模式入口改为直接开关。启用后，普通文本回复不会结束任务，必须单独调用 `complete_goal`。可恢复的工具错误应进入后续恢复流程；真正阻塞需要指出认证、仅用户掌握的信息或外部依赖，以及所需用户操作和已尝试的恢复。

来源：[`fbcfd2a`](https://github.com/notCorwin/SurfWax/commit/fbcfd2a)、[`abe2329`](https://github.com/notCorwin/SurfWax/commit/abe2329)、[`a3d618b`](https://github.com/notCorwin/SurfWax/commit/a3d618b)。

### 浏览器目标完成需要结果证据和独立复核

2026-11-01 起加强完成判定：动作成功返回不等于业务目标完成。浏览器目标引用真实工具结果的 `evidenceId`，并由独立复核核对用户要求和观察结果；历史动作回执参与累计约束检查，例如“只能提交一次”。未结束的后台任务不能视为完成。副作用未知时，必须先用后续观察确认，不能盲目重试或直接宣告成功。2026-11-04 进一步明确，不完整快照不能作为完整观察证据。

来源：[`3437dbe`](https://github.com/notCorwin/SurfWax/commit/3437dbe)、[`b00caf4`](https://github.com/notCorwin/SurfWax/commit/b00caf4)、[`a49c713`](https://github.com/notCorwin/SurfWax/commit/a49c713)，见 `src/agent/goal-completion.ts`、`src/agent/goal-review.ts`。

完成复核结合累计动作回执与派发前实际观测到的目标身份；目标身份来自可操作性检查，并明确标注来源，不能由请求的选择器猜造。动作后按钮消失不应抹去派发前证据。引用证据只在预算选择时优先，选中的对话片段仍按原始时序呈现，并保留原位置；不能把较旧引用标成最新观察。累计证据使用独立的 Canonical Event Log 投影，按事件游标与存储代次增量重建，不把动作尝试塞入普通模型上下文。

审查的 `remaining` 只列当前所提状态获准前，智能体仍需补充的操作或观察；获准的 blocked 状态所需用户操作归入 `goal.userAction`。结构合法但 `accept:true` 且 `remaining` 非空时，规范为拒绝，保留具体原因和待办，不冒充审查服务故障，也不因此额外请求模型。Canonical 诊断同时保存原始答复与规范化标记；非法 JSON、截断和服务故障仍按各自错误路径处理，完成门槛不变。

审查片段有界且优先保留引用，省略或截断旧观察不能推导为从未访问页面或执行操作。证据不足仍应拒绝当前完成提议，但须指出需要证明的用户要求，优先引用既有有效结果或补充针对性的只读观察，不能仅因片段缺失就要求重复副作用；累计动作约束与未知效果的核验要求保持不变。

来源：`7fd6301`、`af5e79f`、`5e8d5fd`，见 `src/agent/goal-completion.ts`、`src/agent/goal-review.ts`、`src/logging.ts`。

### 完成工具不接收总结

2026-11-04 先允许无总结完成，随后从完成协议中移除总结字段。用户只要求浏览器操作时，以经验证的浏览器结果判断完成，不额外索要确认、报告或回顾；用户要求的事实、链接、文件和其他产出仍须在调用完成工具前按要求交付。

目标模式中的纯文本不会自动结束运行。尚无获准的完成标记不等于业务尚未完成；续跑提示区分这两者，引导智能体核对真正缺项、补足被请求的交付或只读证据后重试完成工具，而非重做已验证副作用。该提示不自动接受完成、降低业务门槛或将 blocked 转成成功，也不保证模型不会误判。

来源：[`c7ab3ef`](https://github.com/notCorwin/SurfWax/commit/c7ab3ef)、[`636b563`](https://github.com/notCorwin/SurfWax/commit/636b563)。

当前协议见 `src/agent/goal-review.ts`、`src/agent/goal-completion.ts`、`src/agent/transport.ts`。

## 浏览器执行与数据

### 浏览器执行按运行加载，调试资源按目标隔离

浏览器执行器在运行开始时按需加载。调试连接以标签页和目标的别名归并资源；运行结束后的原生调用与清理尚未结束时，其他运行不能复用该资源，不同资源仍可独立使用。运行所有权的释放有界，不必等待缓慢的原生清理完成。

清理中的首次 detach 拒绝不立即证明效果未知：自关闭目标可能仍留在旧输入记录中。最终结算须等待该资源的旧原生调用与首次清理结束，保持原租约，再以最终 detach 或当前原生目标状态确认已释放；同次结算的别名共享一次按需查询，不跨尝试缓存。旧调用未收束同样受既有清理期限约束，超时或仍附着且 detach 失败时继续隔离并记录可操作诊断；不能按 NoTab 错误文字猜成功，也不能用后续新运行的成功改写旧未知。此修复不改写原验收样本或分类。

来源：`06a5ff6`、`a519f6e`，见 `src/background.ts`。

### 默认从当前窗口开始，跨窗口使用稳定身份

2026-09-22 将默认浏览器操作范围收敛到当前 Chrome 窗口。后续工具可跨窗口发现标签页，使用稳定的 `tabId` 和 `windowId` 区分目标；选择标签页也不应强制抢占 Chrome 焦点。

默认窗口关闭不使显式 `tabId` 的独立只读观察失效；目标仍通过 Chrome 的实际标签身份解析。显式观察不悄悄重绑默认页，默认读取继续诚实报告关闭，并指引先发现标签、再用 `switch_tab` 选择仍存在的目标。此恢复不解除旧资源的清理隔离。

来源：[`8e3643e`](https://github.com/notCorwin/SurfWax/commit/8e3643e)、[`d970aec`](https://github.com/notCorwin/SurfWax/commit/d970aec)，当前提示词见 `src/agent/prompt.ts`。

### 删除页面交互拦截层

2026-09 至 10 月曾为运行中的页面添加交互拦截及呼吸效果；2026-11-01 完整删除相关页面守卫、输入拦截和样式。任务运行时不再通过覆盖层阻止用户操作网页。会话本身的运行期保护仍按项目约定执行。

来源：[`f7503c0`](https://github.com/notCorwin/SurfWax/commit/f7503c0)、[`182dbfd`](https://github.com/notCorwin/SurfWax/commit/182dbfd)、[`5388fef`](https://github.com/notCorwin/SurfWax/commit/5388fef)。

### 页面请求与扩展请求显式区分

2026-10-29 起要求网络调用明确所属上下文；2026-11-03 进一步拆分工具，分别暴露页面请求与扩展请求、页面脚本与扩展脚本，以及不同读取操作。执行上下文成为工具选择的一部分，避免由通用入口隐式猜测。

来源：[`a58e77b`](https://github.com/notCorwin/SurfWax/commit/a58e77b)、[`e514df4`](https://github.com/notCorwin/SurfWax/commit/e514df4)。

控制台的 retained 模式只读当前会话与运行拥有的 Canonical 捕获，不依赖页面仍存活，也不重新连接或订阅来补造历史。游标固定读取高水位，读完后才显式 follow 新捕获；日志清除、运行租约或控制器改变使旧游标失效。结果保留原 scope、capture 与 source，并明确完整性未知或不完整，不能把未捕获的消息判为空。

诊断源的分页与某份 Artifact 内数组的分页分别表达。大结果的工具摘要和模型读取页保留经验证的 `sourcePagination`；读完当前数组不等于源已读完，retained 扫描页即使没有匹配消息也须按原游标继续。缺少原调用范围时不从 `get_job` 参数猜造续页；捕获未知或不完整不能因数组结束而变成完整。

诊断来源由 Canonical Artifact 身份与唯一的先前工具启动记录、原生 run/tool 索引证明，只允许已知顶层诊断 collection 布局。普通 HTTP JSON、控制台参数中同名字段和缺少身份或索引的存储都不能据形状获得 Harness 元数据；只读取父记录的有界标量，不扫描大数组或退回全日志。分页提示与引用元数据计入既有响应预算，内部原始 `artifacts.read` 数据契约保持不变。

来源：`7d97108`，见 `src/chrome/executor.ts`、`src/logging.ts`、`src/chrome/tool.ts`。

当前呈现边界见 `src/chrome/job-result.ts`、`src/chrome/artifact-read.ts`、`src/chrome/atomic-tools.ts`；完成协议与诊断呈现契约统一使用 catalog v52。模型能否正确消费这些提示仍须由独立 Luna 会话验证，不改写旧样本结果。

### 同批动作保持顺序，失败后保留诊断和清理通道

工具调度在模型完整响应后预留调用位置，协调同批执行顺序。对某资源的动作失败后，阻止后续依赖该资源的写操作继续盲目执行，但允许读取诊断和释放按键、指针。任务查询、取消及处理阻塞事件的路径需保持可用，避免等待中的操作挡住自己的恢复操作。

来源：[`0c4173e`](https://github.com/notCorwin/SurfWax/commit/0c4173e)、[`171464b`](https://github.com/notCorwin/SurfWax/commit/171464b)、[`e514df4`](https://github.com/notCorwin/SurfWax/commit/e514df4)、[`902eeb0`](https://github.com/notCorwin/SurfWax/commit/902eeb0)，见 `src/chrome/tool-scheduler.ts`。

即时原子动作不隐式轮询缺失或不可操作的目标；等待由独立的显式等待工具表达。保留动作派发前既有的身份与可操作性检查，不能把动作超时当成等待入口。

原操作获得原生命令确认后，随后一次 Chrome `tabs.get` 的 URL/title 读取只是独立观察，不在网页主世界执行作者可覆写的 getter。标签元数据与动作来源文档未建立同次身份关系，因此不附会 `documentId`；快照仍使用自身的文档身份和加载规则。页面导航或自关闭使该读取普通失败时，保留已确认的 `performed`，以 `pageInfoStatus` 表达不可用，不伪造页面字段；自动快照仍独立报告其可用性。输入本身未获确认、取消和结构化超时继续走原失败路径，后续成功不能清除早先的未知副作用。这不改写旧会话分类，也不证明模型已正确处理这些结果。

来源：`60e53eb`，见 `src/chrome/automation.ts`。

### 后台操作使用可查询任务与增量回执

2026-10-29 起，长操作和可能被浏览器事件阻塞的操作可交给后台任务，通过 `get_job` 增量读取回执直至终态，也可取消。取消不回滚已产生的副作用；重启保留任务记录，但不恢复正在运行的工作。浏览器事件使用运行期订阅和游标，显式报告溢出、截断和关闭。

来源：[`0c4173e`](https://github.com/notCorwin/SurfWax/commit/0c4173e)、[`171464b`](https://github.com/notCorwin/SurfWax/commit/171464b)、[`9c377f6`](https://github.com/notCorwin/SurfWax/commit/9c377f6)，当前协议见 `src/chrome/tool.ts`。

取消结果依据实际派发边界判断：能够确认在真正派发前取消，才明确报告未派发；派发后的未知效果不能被后续成功调用擦掉。JavaScript 取消无法撤销已经交给 Chrome 的底层操作，必须保留未知状态并通过后续观察核实。

来源：`60e53eb`，见 `src/chrome/executor.ts`、`src/chrome/program.ts`、`src/chrome/tool.ts`。

文档句柄清理先同步撤销 entry 并取出、清空 objectId，再尽力释放远端引用；调用本身同步抛错与异步拒绝都不能覆盖原操作错误或累计未知效果。取消时 individual release 可能未执行，仍由既有 `surf-wax-automation` 对象组清理收束；不因此放宽命令取消、debugger detach 或资源隔离。

来源：`src/chrome/automation.ts`、`src/chrome/executor.ts`、`e2e/click-timeout.spec.ts`。

### 元素引用绑定观察、文档和框架

2026-10-29 至 31 日持续收敛目标身份：观察返回的元素引用需校验原角色和身份，框架引用绑定文档；导航、框架替换或后续观察可能使引用失效。DOM 节点未变也不能证明业务数据未变，因此操作前仍需核对相关行与页面状态。

来源：[`b60bf21`](https://github.com/notCorwin/SurfWax/commit/b60bf21)、[`6b41900`](https://github.com/notCorwin/SurfWax/commit/6b41900)、[`ea1c158`](https://github.com/notCorwin/SurfWax/commit/ea1c158)、[`41dc64a`](https://github.com/notCorwin/SurfWax/commit/41dc64a)、[`fea9e40`](https://github.com/notCorwin/SurfWax/commit/fea9e40)。

链接导入将解析与读取绑定到同一个真实节点及其框架；节点被替换或移除时明确失败，不重新匹配同名链接并读取另一节点。

来源：`60e53eb`，见 `src/chrome/executor.ts`、`src/chrome/automation.ts`。

搜索候选关联其自动附带快照的同次 capture 语义容器与已证明可见标签，复用现有快照证据和交付 lease，不另行采集或猜用 AX 名称、DOM 原文补齐。未证明的关联与标签保留 unknown 或不完整标记；当前关联不保证 DOM 复用后的业务身份永远不变。容器引用仅供观察，`scope:{id}` 仍不支持。

自动快照中实际交付的 actionable 项也可携带同次 capture 的容器标签关联；与 find 共用按需建立的语义索引，不增加 DOM、AX 或快照采集。自动关联受 3072 字节子预算与 16384 字节快照 envelope 共同约束，分页、delta、遗漏及 unknown 保持明确，交付 lease 失效时关联一起失效。关联仅帮助模型核对已观察内容，不替代任务条件判断或后续动作前的身份校验。

浏览器工具交付给模型的结果明确是否包含新网页观察。管理、日志和 Artifact 读取不为补状态而等待或采集浏览器；未采集、待观察和失败均不保证旧快照仍新鲜。主动 inspect 的实际捕获与冻结续页分别标识，失败优先覆盖预取状态；这些观察状态与副作用是否未知相互独立。最终状态及错误参与原有一次交付预算，原始 Artifact 的类型与分页契约不变。

来源：`b309d11`，见 `src/chrome/candidate-context.ts`、`src/chrome/automation.ts`；观察状态与最终预算见 `src/chrome/tool.ts`、`src/chrome/artifact-read.ts`。

来源：`8a4407b`，见 `src/chrome/candidate-context.ts`、`src/chrome/automation.ts`、`src/chrome/tool.ts`。

### 大结果存入会话 Artifact，保留原始数据语义

2026-09-22 起，将生成结果保存在会话存储中；2026-10-30 至 31 日进一步支持大结果、二进制和复杂数据图，通过 Artifact 引用、分页及范围读取按需取回。编码保留 `undefined`、特殊数值、BigInt、类型化数组等 JSON 不能直接表达的值，不把显示用截断结果当成完整原始数据。

来源：[`61c200f`](https://github.com/notCorwin/SurfWax/commit/61c200f)、[`45f231c`](https://github.com/notCorwin/SurfWax/commit/45f231c)、[`c7e6e18`](https://github.com/notCorwin/SurfWax/commit/c7e6e18)、[`b156e43`](https://github.com/notCorwin/SurfWax/commit/b156e43)、[`8efcf68`](https://github.com/notCorwin/SurfWax/commit/8efcf68)。

存储数据的文本处理采用职责固定的 JSON 字符串提取与 UTF-8 文本产物拼接，不要求模型逐字复制大结果；这两项操作不执行任意转换脚本。路径、解码方式和分隔符明确指定；严格检查字符串类型，保留输入顺序、重复项、空字符串与空白，不猜字段、不隐式字符串化、排序或裁剪。处理复用可终止的程序 Worker，全部来源验证通过后才保存一个产物，并返回来源、数量、字节数与哈希。

需要从既存文本中按字面行前缀提取时，使用独立的有界职责工具，不让模型重抄或执行脚本。前缀必须非空且不含 LF，按大小写精确匹配；仅以 LF 分行，去掉匹配行的该前缀，再以显式分隔符拼接原后缀。顺序、重复、空后缀、空白、CR 与 BOM 均保留，零匹配也生成有效空产物；输入须是当前归属下可读的有效 UTF-8 text 文件，返回计数、字节数、哈希和原有填入引用。原生 HTML 编辑控件自身的换行归一化与产物原字节分别验收，不把 DOM 等值反推为字节未变。该契约与清理结算改动统一更新 catalog v53；模型选用与完整任务结果仍待新会话验证，旧样本保持原状。

内部 `artifacts.read` 保留原始值读取契约；模型的 `read_artifact` 单独按响应预算分页，始终指向原产物与绝对路径，用绝对 `range`、`total` 和 `nextAccess` 表达进度。HTTP 大结果优先推荐正文路径；读取不重新包装、复制成新产物。单项过大而未交付数据时明确说明，可缩窄时给出路径，不伪造分页进度。

来源：`2ae82b8`、`53aac09`，见 `src/chrome/text-artifact-transform.ts`、`src/chrome/artifact-read.ts`、`src/chrome/atomic-tools.ts`、`src/chrome/executor.ts`、`src/artifact-selection.ts`。

### 保存文件直接使用必需的 downloads 权限

2026-10-02 将 `downloads` 改为必需权限，删除单独的下载授权界面，直接保存 Artifact。浏览器下载列表中的元数据不等于文件内容；上传和保存使用已存在的 Artifact 数据。

来源：[`619d93c`](https://github.com/notCorwin/SurfWax/commit/619d93c)，当前工具说明见 `src/chrome/tool.ts`。

### 文件选择器可以在触发后发现

2026-11-02 简化文件选择器流程：除了预订阅事件，也可从动作结果的 `fileChoosers` 或 `list_file_choosers` 获取句柄。2026-11-03 拆分上传工具后，选择器句柄交给 `upload_file_chooser`，已有文件输入框目标使用 `upload_file`。选择器可能由其他页面事件触发，必须核对来源；句柄在替换、导航、处理或运行结束后失效。

上传在读取文件 URL、记录派发或赋值之前，以 Chrome 对同一已解析 objectId 返回的原生节点元数据检查 file input 类型与文件数量；类型按 HTML 的 ASCII 大小写规则匹配，`multiple` 按属性存在语义处理。可信前置拒绝可明确未派发，最终同节点同步守卫仍保留；前置之后的节点变化、异常和取消不能被改判为确定无副作用。后续成功或前置失败只结算自己的操作，不能清除先前未知效果，也不信任网页伪造的错误码、消息或 `effectUnknown:false`。

原生文件选择器也按自己的可信派发边界记录前置拒绝；单文件选择器拒绝多文件后仍可用同一句柄正确上传，不因拒绝消费句柄。此边界不能把已派发或早先未知的操作改判为确定未执行。

来源：`src/chrome/automation.ts`、`src/chrome/executor.ts`、`src/chrome/program.ts`；该修复不改写原始运行的未知分类。

来源：[`efadccd`](https://github.com/notCorwin/SurfWax/commit/efadccd)、[`e514df4`](https://github.com/notCorwin/SurfWax/commit/e514df4)。

## 快照协议

### inspect_page 交付结构化 item，不再使用 `{id, line}`

观察结果按字段交付（`role`、`depth`、`name`、`box`、`state`、`nameUnknown`、`textParts`、`count`、`boxes`、`path`、`coordinates` 等）。分页切片 `name` / `value` / `textParts.*.text`，并用 `fragment.field` 标明被切字段；独立消费者按字段拼接，不把整行字符串当作权威正文。遗留树形行仅用于 observe 字符串或测试断言，由 `formatSnapshotItem` 从结构化 item 生成。

来源：当前实现见 `src/chrome/snapshot-render.ts`、`src/chrome/snapshot-pagination.ts`、`e2e/evaluation/semantic-state.ts`。

### 元素操作统一使用快照 item 的 ID

2026-11-10 将 LLM 面向的元素目标统一为 `target:{id}`。`inspect_page` 默认交付可操作元素的 ID 与 `actionable=true`，`find_elements` 使用同一 `id` 字段交付元素绑定，不再另交付元素 `ref`。此决策取代 2026-11-07“默认隐藏操作引用、显式请求 ref”的交付约定；内部引用机制仍负责真实节点绑定与校验，Frame 的 `frameRef` 继续作为框架定位句柄，不与元素 ID 混用。

ID 的可操作性来自唯一真实元素绑定，不来自名字匹配或包围盒。文字、重复观察组和单子祖先路径仍可有用于增量/分页的 ID，但只有明确标为 `actionable=true` 的 item 才能直接作为元素工具目标；可操作元素不再压入 `count` 或 `path` 聚合。动作提示与 `actionable` 均不保证操作会成功，实际输入仍检查节点身份、可见性、启用状态、布局与命中位置。

元素 ID 限定所属标签页、文档和运行，不能在失效后靠重新匹配同名节点恢复。观测到身份改变时退休旧绑定及其别名，增量可以用旧 ID 的删除和新 ID 的新增表达该变化。只读采样也能为本次同步读取中的实际控件提供 ID：节点以隔离世界私有的弱引用注册，身份指纹不进入模型结果；使用时核对文档 token、原节点连接状态、当前身份及运行归属，再绑定到浏览器真实节点。已退休的采样 ID 不因标签文字恢复而重新生效。此能力不改变 `partial=true` 和覆盖缺口的证据边界，也不把旧 `box` 当成可直接点击的坐标。

来源：`src/chrome/element-target.ts`、`src/chrome/automation.ts`、`src/chrome/sampled-element.ts`、`src/chrome/snapshot-readable-source.js`、`src/chrome/snapshot-repeat.ts`、`src/chrome/tool.ts`、`src/standalone/runtime.test.ts`。

### 元素 ID 使用短编号，归属信息仅在内部保存

2026-11-10 将对外交付的 item / 元素 ID 改为递增整数的 36 进制字符串（如 `1`、`a`、`10`），不再把标签页、文档代次或随机 token 拼入模型可见 ID。ID 是不透明句柄，消费者原样回传，不根据前缀推断页面或权限；内部绑定仍保存所属会话、文档、运行、原节点身份及可操作性，并在使用和交付时校验。相同的仍存活绑定复用已有短 ID；不同归属、已退休绑定、清理或淘汰后的重新绑定都不能复用旧编号。

私有节点引用使用含 `_` 的独立命名空间（如 `_e1`），不能与公开的纯 36 进制 ID 共用键空间；公开编号自然增长到 `e1` 等字符串时，也不能覆盖原节点绑定或改变后续快照的归属。运行归属同时支持 Canonical Event Log 的 `logIdentity.runId` 和独立调用的直接 `runId`，分配与解析必须采用同一规则。

扩展通过专用 IndexedDB 的原子读写事务分配自增键，再转为 36 进制。预留记录在同一事务内删除，保留自增分配进度，使并发扩展视图以及正常重载后仍不重复；该库不保存 DOM 句柄、标签内容或会话事实，不代替 Canonical Event Log。只有事务提交后才能交付分配结果，存储失败或超时明确报错，不降级为可能冲突的临时编号。独立 Node 入口没有跨进程模型历史，使用进程内共享的单调序列，替换运行器或清理绑定不重置它；此范围不等于跨 Node 进程持久化。

分配中的文档或整个运行器失效后，已经排队的分配不能重新发布旧绑定；耗用但未交付的编号可以留下空洞，不应为了连续编号回收它们。容量回收限定在对应 session 内，不能因某个标签页产生大量节点而淘汰另一标签页的 ID；有排队或进行中的分配时暂缓容量回收，避免复用检查和结果交付之间的绑定被移除。异步分配完成后还必须重新检查原引用是否仍存活；并发搜索退休了旧节点时，返回该项已变化，而非发布失效 ID。

回归分别验证内存模式的并发复用与退休不复活、排队失效、容量回收与分配竞争，以及真实扩展视图之间的并发唯一性、重载后递增和预留库无节点记录。独立真实 Chrome 回归使用 600 个同名按钮跨过公开编号与旧私有引用可能重名的区间，连续快照后验证 ID 稳定且实际点击仍命中原节点；直接 `runId` 的归属校验复用现有元素查询测试。这些测试保护实际生命周期边界，不以输出某个固定编号为验收依据。

来源：`src/chrome/element-ids.ts`、`src/chrome/automation.ts`、`src/chrome/element-ids.test.ts`、`src/chrome/find-elements.test.ts`、`src/standalone/runtime.test.ts`、`e2e/short-element-ids.spec.ts`。

### 可见语义与操作引用分离

2026-11-07 的实现默认以文字和状态呈现快照，不暴露元素操作引用；需要句柄时可显式请求 `ref` 字段，或通过 `find_elements` 获取。内部仍维护引用及其角色、身份和文档校验；快照行 `id` 用于分页和增量更新，不是操作目标别名。可见名称以绘制证据为准，未绘制的 alt 或无障碍名称不作为可见文字输出；`name=unknown` 只说明完整可见名称未被确认，仍可能提供已确认的前缀；不能推断底层元数据不存在。

来源：当前实现见 `src/chrome/automation.ts`、`src/chrome/snapshot-render.ts`、`src/chrome/tool.ts`。

网页文字定位、读取与文字条件验证复用快照的同步绘制证明，再由 Chrome 的 `innerText` 序列化已获证明的范围，保留换行、空白与文字变换语义。源码或 AX 名称不能代替可见文字证据；无法证明的内容保持不可用，不能凭空串宣告验证成功。此边界不宣称任意绘制、组合树或多目标查询都已完整覆盖。

来源：`8ec092f`、`0058ad6`，见 `src/chrome/rendered-text.ts`、`src/chrome/snapshot-readable-source.js`、`src/chrome/automation.ts`。

同一次同步文字查询的所有候选共享一次整页绘制证明，候选 metadata 在同一次 `Runtime.callFunctionOn` 中批量读取；不为每个匹配项重新采集页面。复用只限该同步调用，不跨异步等待、DOM 变化、框架或文档代次。空自定义元素依据真实 closed-root 与未知绘制证据判断，不能仅因标签含连字符就拒绝其可见父文字；这些取舍不构成任意页面的延迟上界。

来源：`128a59b`，见 `src/chrome/rendered-text.ts`、`src/chrome/automation.ts`。

默认原生列表 marker 的潜在绘制与正文分别取证。需要时才按实际节点 backend ID、loader 与同一隔离世界获取原生 marker 几何和实际字体；支持的单个系统字体与简单排版通过离屏 SVG 图像栅格化取得保守墨迹范围，不把 advance 或 SVG layout box 当作墨迹。最终正文由新的同步绘制证明读取，仍检查文档、节点、样式、字体、counter、相关动画与裁剪；不支持的字体、效果或 CSP 解码限制保持 unknown，不改作者 DOM 或字体集合，也不把 marker 文字回填正文。普通视口外的已渲染文字仍可读取，作者对父 iframe 的明确裁切不能与普通视口边界混同。每层父文档还需以同次同步绘制引擎核对实际 frame owner 的裁剪和竞争绘制；父层遮挡或证明不足时，不把子文档自身可读误当作目标可见。普通文字初次读取与 native marker 重读均不能只依赖前置证明；实际读取后仍需在原 frame/world 守卫下重新证明父层绘制，失败不交付文字，文字验证保持未知。祖先普通背景的后景豁免不适用于未证明的负 stacking 后代；父框架资格对负值或未知 stacking 路径保持 unknown。

frame owner 的祖先遍历显式区分动作结构可见性与文字绘制证明：动作保留结构裁剪和原生 hit-test，文字继续检查父层竞争绘制及读取前后新证明。frame owner 只接纳已证明的有限正轴向缩放和平移，不把该资格用于放宽正文的旋转、复杂裁切或未知绘制。

原生 focus outline 的有限界需要真实 UA root。能够同步取得根时直接使用；否则仅在确有缺失依赖时，按原文档 backend、loader、world 与实际 host 获取根。缺少扩展 API 的开发宿主必须取得完整的真实 author/UA 拓扑，不能用空表代替闭合根证明；异步获取后重新同步读取当前绘制，拓扑变化与绝对 deadline 到期均失效。

批量正文读取和同次 hasText 过滤共用真实节点数组及同步 reader；条件原生证据仅在该查询内共享，不跨异步边界复用旧同步证明。原生 AX 与 CSS 解析后均在正确框架的既有隔离世界读取相同 backend 节点，不执行作者覆写的读取 getter，不改变公开 `Page.evaluate` 的执行语义。原生 AX 查询使用本次实际 frame 的 fresh full tree 与真实 scope 的原生 child 关系，按 child 预序保持嵌套索引顺序；同次查询的多个 root 共用该 frame 的读取及索引，不跨工具缓存。原生序列化中完全相同的重复节点事实可去重；冲突身份、父链、悬空关系与循环仍拒绝，不用 DOM 推断角色或名称。数组解包及嵌套 has 引用的派生句柄继承已知来源的 execution context，不按对象字符串猜测或重新找 world；原生依赖不可用后的普通降级回执同样在 await 后复验原守卫。语义查询从入口保留原隔离世界与文档 entry 守卫，在后续异步绑定、描述、过滤及最终返回前复验；不能在失效后重新取得新 world 假装原查询仍有效，新取得的对象先登记所有权以便失败时释放。字体发现复用当前 frontend root，实际 `DOM.getDocument` 读取统一更新该权威。原生查询的临时对象、observer、图像与 URL 随查询收束，并以实际操作绝对 deadline 到期失效；timer 被节流也不能使证据继续有效。

本机 Chrome debugger 的 `CallArgument.value:null` 在实际对照中未传入；新增批量读取使用显式布尔模式，并核对完整的 total、项序和续页结果。这项局部取舍不声称修复全项目的空值协议。以上边界不保证任意网页绘制完整、固定延迟上界或真实模型已正确完成任务。

来源：`src/chrome/rendered-marker.ts`、`src/chrome/rendered-text.ts`、`src/chrome/snapshot-frame-paint.ts`、`src/chrome/automation.ts`、`src/chrome/executor.ts`、`e2e/snapshot-visibility.spec.ts`。

### 快照复用布局证据并保留语义边界

2026-11-07 的实现复用语义观察中同一次 DOMSnapshot 的几何，按各文档视口 CSS 像素表达包围盒。布局以实测几何而非 DOM 顺序表达，不自动根据已知名称推断“恰好两个”或全局唯一性，避免未知、部分名称及缺失几何造成误判；包围盒不代表保证可操作的坐标，不同框架的坐标不互相比较。布局写入快照行，参与增量比较；续页是否重新校验当前几何取决于观察是否暴露操作引用，具体规则见下文。该呈现过程不新增截图或模型调用。

精简呈现只折叠无独立信息的中性结构；可确认重复的完整标签将文字片段及其可用几何折入父行，而不是丢弃片段，因此浅层观察仍保有标签，片段之间或相对图像的移动也能进入增量。折叠须确认原始片段拼接可还原完整标签，并保留片段边界空白，使几何不变的文字变化仍可被检测。片段排列只表示结构顺序，不冒充视觉阅读顺序。独立交互、状态、匿名图像、格式及不确定内容保留，零尺寸不能作为删除可见溢出交互容器的依据。DOM 补充控件的标签聚合以已表达的 AX 节点为边界，避免祖先重复收集后代的语义。

被动的单子 paragraph 包装可沿完整单子链传播标签 owner，将与父标签完全同文的叶子折入父行；使用私有单子链标记线性处理，不反复扫描祖先。已有 `textFragments` 及其文字盒原样保留，没有片段时才使用原叶子盒子，父行也保留自身包围盒。这项传播不穿越多个段落或兄弟文字分支，也不跨过图像、unknown、状态或保留格式等独立证据。

控件的标签、当前值、placeholder 与选择文字属于不同字段；即使字符串相同，仍分别保留已经证实的字段语义，不以同文去重隐藏字段或状态。原生 UI 文字在名称折叠前分类，不能把 value 或 placeholder 当作作者标签。非空 value 统一使用 JSON 字符串引用与转义，避免字段内容伪装为快照元数据或打破行结构。

来源：当前实现见 `src/chrome/snapshot-layout.ts`、`src/chrome/snapshot-presentation.ts`、`src/chrome/automation.ts`、`src/chrome/snapshot-render.ts`。

### 重复叶子共享呈现，目标仍独立

2026-11-07 的实现将连续的同父级叶子按已提取字段和文档坐标范围合并呈现，折叠中性结构后仍保留原始父级边界，不推断业务分组或视觉顺序。重复行使用 `count` 和 `boxes` 表达已采集行数及每个包围盒；等差的盒子可用起点、`step` 和数量表示，其他盒子逐个列出。相邻文字叶子则保留各自的文字与几何片段。单子节点路径可共用一个传输 item，正文仍逐行保留每个节点及其缩进，不用新别名代替节点。默认不输出操作引用；显式请求 `ref` 或 `actions` 时展开原来的独立节点，引用仍按节点、文档及运行校验。合并行以首个节点的行 ID 参与快照增量；成员变化、分组拆合按重新呈现后的行比较。

可折叠空白的文字边界优先使用同次 DOMSnapshot 的 text box 偏移与 CSS 空白模式作为证据；有裁剪或文字绘制投影时不把这份边界证据直接套用到投影结果。没有可靠边界证据时，不把源码缩进当作已绘制的标签片段。普通文本行的归一化不会把非断行空格当作普通可折叠空白。保留格式的文字使用 Chrome 捕获的转换后拼写；自包含的 `pre-line` 文字可在空白序列一致时保留换行，不依赖默认语言的大小写转换来猜测字符偏移。

来源：当前实现见 `src/chrome/snapshot-repeat.ts`、`src/chrome/snapshot-preformatted.ts`、`src/chrome/snapshot-dom.ts`、`src/chrome/automation.ts`。

### 截图与语义观察独立

2026-11-04 本次实现中的决策：截图等待文档加载完成，并以 50 毫秒间隔确认视口几何稳定后只采集一次像素，不依赖 DOM 或无障碍语义快照的一致性。工具结果附带的自动网页快照仍独立采集，其部分结果或失败不代表图像内容；视觉观察不能作为语义增量的 `since` 基线。

截图记录文档、视口、像素尺寸、缩放和裁剪原点；目标裁剪使用根文档坐标，全页裁剪使用文档尺寸。采集后复核视口和裁剪几何，前后测得的几何不一致、目标消失或实际图像宽高无法按一致比例映射到声明范围时拒绝结果，不虚构缺失的像素尺寸；后续像素坐标操作还需匹配原视口，并落在当前可见视口内。

2026-11-07 自动观察按展开后的语义内容判断是否需要截图：存在可读文字、已记录的状态或未知字段语义、有效操作引用时，不因默认输出省略引用而自动截图。明确请求视觉观察仍走独立截图路径；没有可用语义内容的自动观察仍可能截图。该判断不把部分快照提升为完整观察，也不把未知字段当作字段值的证据。

来源：2026-11-04、2026-11-07 的实现决策，见 `src/chrome/automation.ts`、`src/chrome/executor.ts`、`src/chrome/tool.ts`。

### 分页基于冻结观察，操作引用校验当前几何

2026-11-01 至 02 日完善快照分页：长行可以跨页续读，`nextCursor` 延续同一次冻结观察；滚动、布局或可见性变化使续页失效时，应重新检查。`lookahead` 只提供稀疏预览，没有可操作元素引用，不能作为完整正文或完整基线。预算按解码后的 UTF-8 JSON 字节计算。

2026-11-07 进一步区分纯观察与操作引用：未暴露元素操作引用的续页只读取同一次历史冻结结果，不因后来滚动或布局变化重新采集，不能当作当前视口状态。包含操作引用的观察在续页前仍确认当前几何；文档、会话、框架修订、运行归属变化，或上下文重置、记录失效，均使旧续页失效。

新检查可绑定内部重采后最终验证的文档代次与框架修订，丢弃旧的隐式增量基线；显式 `since` 始终固定原基线，采集中任一身份修订变化都拒绝，不静默改成新文档的全量结果。

新发起且不含操作引用的 root-only 采集单独验证根 frame、loader、根文档修订和本扩展的隔离执行上下文。能证明与根读取无关的子帧变化不再单独使该次读取失败；交接时绑定最终的全局代次与框架修订。这只改变新观察的采集边界，已保存的 record、交付 lease、cursor 和显式 `since` 仍按原有全局身份校验，不允许旧结果沿用这个例外。现有 `point` 检查文档 generation 与 viewport，并拒绝只读采样用于坐标操作；不能将它描述为已经检查 frameRevision。

来源：[`ba2baea`](https://github.com/notCorwin/SurfWax/commit/ba2baea)、[`567f320`](https://github.com/notCorwin/SurfWax/commit/567f320)、[`398fac4`](https://github.com/notCorwin/SurfWax/commit/398fac4)，当前实现与说明见 `src/chrome/automation.ts`、`src/chrome/tool.ts`。

### 动态区域的不确定性显式输出

2026-11-02 起，对变化中的文本允许返回 `partial=true` 的局部结果，保留已验证的稳定行；无法验证的名称和值明确标为未知，不提供可操作引用。局部结果不能证明完整页面状态，需要重新检查相关区域或使用截图、专用读取工具确认。

来源：[`9c04c78`](https://github.com/notCorwin/SurfWax/commit/9c04c78)、[`a2ce5f8`](https://github.com/notCorwin/SurfWax/commit/a2ce5f8)、[`a49c713`](https://github.com/notCorwin/SurfWax/commit/a49c713)。

### HEAD 变化需要补齐绘制证据后重新采集

2026-11-07 只把没有布局的普通 HEAD 脚本及源码变化识别为补充证据的候选，不能直接忽略这些变化：`:has(...)` 等规则仍可能改变页面绘制。遇到此候选时，在现有恢复预算内升级为浏览器提供的完整标准计算属性目录，重新采集和呈现；目录不包含自定义属性，依赖 `paint()` 的变化不据此放行。属性目录请求在运行时去重复用，所选采集 profile 绑定文档代次，文档变化后重置；操作引用的续页几何检查沿用原观察的 profile。

宽松接受前，独立确认 AX、最终 DOM、完整样式与几何，并重新读取实际用于文字投影的实时绘制证据。绘制复核按共享 snapshot 对象去重，每个 debugger target 只处理一次；逐帧 AX 检查仍独立保留。使用完整 profile 时，还检查已布局且被判可见的普通文字，拒绝未覆盖的 `::first-line`、`::first-letter`、选区、Highlight 或 view transition 风险。完整目录仅覆盖布局行，不能证明没有布局行的 SVG 渐变、滤镜、mask、clipPath 等资源不变；存在这些资源时，不走 HEAD 松绑。这里的完整指已实现的采集契约，不承诺任意 CSS 绘制下全部肉眼可见内容均已覆盖。

区域检查过滤无关文档前，先按原始文档数组验证 `contentDocumentIndex`；过滤后重映射保留的文档边，避免把原来合法的子帧索引误判为越界。客户端水合使控件在采集中脱离时，只在现有稳定恢复预算内整体重采。新的文档代次或框架修订使当轮证据失效，但不使同一次观察的恢复预算归零；连续变化最终明确失败，或仅按根视口只读契约返回 partial，仍须满足该采集路径的身份边界。普通读取错误不转为重试。

来源：`src/chrome/automation.ts`、`src/chrome/snapshot-consistency.ts`、`src/chrome/snapshot-text-paint.ts`。

### 相同捕获颜色表示可见性未确认

2026-11-07 对严格快照中已捕获文字填充色与最近非透明祖先背景色的序列化值相同的情况，只检测为合成可见性不确定；检测也包含 CSS Color 4 和半透明颜色，不据此推断合成后的颜色或文字隐藏。背景图、非祖先绘制、选区或描边仍可能使文字可见，因此不能仅按颜色相同删除节点，也不能继续把其 DOM 或 AX 文字称为可见标签。保留未知名称与已采集几何，相关结果标记 `partial=true` 并说明局限；未确认名称的行不提供操作引用。已确认的其他文字仍可保留。

这项检测不等于实现通用对比度或像素可见性判定。动态网站的只读局部结果也不因此成为完整观察；取得 Polymarket 的部分标题、名称与赔率，只证明对应采样中确认的文字，不能代表全部市场内容、控件状态或嵌入文档已读完。

来源：`src/chrome/snapshot-visibility.ts`、`src/chrome/snapshot-text-paint.ts`、`src/chrome/automation.ts`。

### 动态页面读取与操作引用分离

2026-11-04 引入全页语义快照持续变化时的根视口同步只读采样。2026-11-07 将原来的纯文字结果改为保留同次 DOM 读取中的原生或声明角色、控件状态、已确认标签片段及几何；`false` 状态也保留，原生 checked 按实际控件类型读取，不因声明为 switch 而丢失。ARIA 角色与已支持的 boolean/enum token 按 ASCII 大小写规则识别，不能因有效的大写声明静默丢失语义。未确认的名称和值保持 unknown；不拼接前一轮或随后读取的 AX 名称、文字或状态。不能确认的文字保留有界未知区域，已证明完全隐藏或裁出的内容排除，不能用原始 DOM 字符串填补未知。嵌入文档及全部操作引用仍不包含在这条路径中，并以 `partial=true`、`limitations` 明确其范围和局限；不能将其作为完整观察证据或增量基线。局部区域检查及操作定位继续使用严格一致性校验。

只读续页复用该次冻结采样，不因页面后续布局变化重新采集；文档、会话、frame 树或运行归属变化后失效。后续动作通过 `find_elements` 获取引用，或使用专用读取与截图工具补充观察。

采样在扩展隔离世界中的静态同步函数内完成，按实际 composed tree 遍历开放及 closed 作者 shadow root、slot 的分发内容与回退内容，不重复输出被替换的回退或未分发的 light DOM。文档绑定的 WeakMap 只提供内部传输身份，统一使用现有快照呈现与压缩，不向模型暴露新的节点别名，也不成为动作引用。角色或未知字段不能被重新降为普通 text 行。没有可确认语义行时明确返回采样失败；不能将空采样或只含导航的局部结果视为主要内容已读完。

Chrome 扩展的 author-shadow API 不提供原生控件的 UA shadow root；原生字段改由 CDP 异步发现并解析 live roots，再将对象交给本扩展的隔离上下文，在最终一次同步调用中重新读取当前 host、Text、值、样式与几何。前置步骤只复用绑定 root 文档、loader/frame 身份的 host 索引，不传入旧的字段文字或状态；不能复用时按需发现当前根文档字段。root/host 的连接、所属文档和对应关系须现场验证，不能读取 UA root 的 `.mode`。该路径采用上述新 root-only 采集身份边界，根文档或其执行上下文、会话、页面缩放变化以及取消仍拒绝本次结果；临时句柄采后释放。

原生值、placeholder 与选择文字分别经过既有字段绘制证明，并与同一次局部采样接受的 Text 证据共同确认，映射到现有 `value`、`placeholder`、`selectedLabels` 字段。缺失或已替换的 root、未发现的新字段、字体或裁剪证明不足时保留 unknown 与 coverage gap，不能用 DOM value、aria-label 或 placeholder 属性补足。这仍是根视口 partial：Polymarket 的短输入提示词、自定义字体、native listbox 等未获完整覆盖，嵌入文档、Canvas 及任意 CSS 的完整性也未由此得到保证。

原生字段值的真实缺口来自独立整页绘制证明过度拒绝普通列表、将折叠光标当作选区以及原生 outline 的无界遮挡；不是已确认的跨 world 问题。字段值与单选标签改为共享同次同步文字引擎接受的 live Text Map，再核对当前 UA Text、host、完整几何、值及前后 capture 身份，不以 AX 或 DOM 原文补足。祖先样式仅在该次同步 batch 内按节点复用，语义采样直接使用自己的 Map，注入函数不重复携带独立采样器，也不跨异步或文档复用绘制证明。

不确定的字体、裁剪、遮挡、密码和非折叠选区仍保留 unknown。普通流中较晚的不透明原生背景只可排除同一已知绘制上下文内较早的普通流墨迹；定位伪元素不能借其 owner 的普通流身份获得这一豁免。outline 的有限边界与自身内区判定不放宽其它遮挡。ASCII、中文及所测控件状态的精确字节证据不代表任意文字、CSS、页面完整性或 Luna 任务成功。

来源：`ec2831b`，见 `src/chrome/snapshot-control-paint.ts`、`src/chrome/snapshot-native-value.ts`、`src/chrome/snapshot-native-runtime.ts`、`src/chrome/snapshot-readable-source.js`、`e2e/snapshot-visibility.spec.ts`。

来源：2026-11-04、2026-11-07 的实现决策，见 `src/chrome/snapshot-readable-source.js`、`src/chrome/snapshot-readable.ts`、`src/chrome/snapshot-native-runtime.ts` 及 `src/chrome/automation.ts` 的 `captureReadableSnapshot`、`inspect`。

### 只读可见性证明按绘制来源建立边界

2026-11-07 的只读采样分别处理盒子的背景、边框与阴影，以及每个直接文字节点的 Range 几何；不把后代文字并入父盒子的前景遮挡，也不跨文字片段用一个大矩形填满空隙。可证明的几何中性变换与二维平移仍保留其堆叠上下文作用；只有确认不绘制的隐藏或透明空伪元素才可排除。

外阴影的有限上界依据已核对的 Chrome 156 Blink 实现建立，不宣称 CSS 规范规定了通用模糊边界：`sigma = blur / 2`，外延以 `ceil(3 * sigma) + spread` 为基础，始终包含原盒子，负 spread 不缩小保守上界。另加 `2 * max(1, 1 / DPR)` 余量以覆盖 CSS 布局与设备像素对齐的舍入；这份余量来自实现与几何推导，未通过读取截图像素验证。不满足已证明样式、变换条件的阴影继续视为未知绘制。

HTML 祖先的 overflow 裁剪须按实际定位包含块判断，不能因 DOM 包含就直接裁剪 absolute/fixed 后代，也不能一律假定 fixed 永远逃逸。几何中性的 transform、individual translate/rotate/scale、运动路径或位置、preserve-3d 及对应 will-change 仍可能建立包含块；position 本身只增加 absolute 包含块，不由此建立 fixed 包含块。滤镜、有效 layout/paint containment 等按已核对的 Chrome 条件处理，活动变换动画等无法证明的关系保持 unknown，不能把当前 transform:none 当作不存在包含块。`display:contents` 不生成这类盒子，也不充当裁剪盒或定位容器；传播到视口的 root/body overflow 不按可能为零高的元素盒子裁剪。

已证明的裁剪不裁掉该祖先自身的阴影或轮廓；扩张性 filter 等效果可使内层界限失效，更外层的已证明裁剪可重新建立界限，`foreignObject`、SVG `use` 等未覆盖关系保持未知。已识别的 top-layer 盒子在绘制祖先链上独立于 DOM 祖先的裁剪和效果，继承样式仍读取浏览器的计算结果；结构归属不代替绘制归属。文字落在圆角裁剪内的判断使用实际使用半径与凸几何；可证明的分数 padding 边界直接按布局计算，避免 `clientWidth` 向下取整误删可见文字。

生产只读采样的颜色由浏览器在离屏纯色 swatch 上解析和合成，支持 CSS Color 4；不读取页面像素，也不执行截图。透明度保留解析后的精确 alpha，不能因 ImageData 量化而把微小非零遮挡当作透明。只有背景纯色及其半透明叠加已获证明时才确认文字与背景有差异；完全透明的 inset shadow 不构成绘制风险，其他未确认的内阴影和背景图仍不提供这项证明。字体仍在加载、活动 view transition、同色文字或无法排除的前景装饰均不输出为确认文字。

2026-11-07 进一步约束不透明背景的截断前提：纯色填充只能截断更早的背景颜色，不能消除包含该填充及文字的外层 group opacity 或混合关系。颜色查找提前停止前，须验证完整绘制祖先链的 opacity 为 1、mix-blend-mode 为 normal。背景本身还须按自己的绘制路径证明覆盖文字区域；absolute/fixed 文字逃出 overflow，不代表其静态祖先的背景也逃出。该检查保留背景自身不受自身 overflow 裁剪的 surface 语义，以及既有 root/body 背景传播例外；裁剪或合成证据不足时保留 unknown/gap，不将其误报为已确认文字或已证明隐藏。

绘制祖先的合成条件与“整条路径确定无潜在裁剪”标记按同次同步采样共享缓存。只有明确无裁剪时跳过背景层的重复裁剪扫描，复杂路径仍复用既有几何证明；不新增跨观察缓存、低 alpha 放行阈值或命中即可见规则。本次是背景证据的局部正确性修复，不代表任意网页的可见性或内容覆盖已获完整证明。

2026-11-07 经用户授权，将反事实截图差分作为生成器的开发验收辅助：仅在受控、无作者脚本的 fixture 中临时对文字叶子设置 `visibility:hidden`，保持 DOM 结构，并在 `finally` 中恢复原 style。比较解码后 RGBA 的 SHA-256，而非 PNG 编码字节；重复基线、恢复哈希及布局核对只支持该受控实验，不构成任意动态网页的稳定性证明。像素变化仅表明绘制受到影响，不能证明完整文字可读；部分裁剪文字的负控继续保持 unknown。该机制未接入生产网页的自动采集，不会临时隐藏用户网页元素，也不是运行期的虚拟删除探测。

差分反例证实，普通祖先背景可能在负层级文字之后绘制，不能将它作为该文字已经存在的底色；层叠上下文 owner 自身的背景则先于其负层级后代，继续保留这一可见正例。只读采样按文字的上下文路径一次索引这类先后关系，外层负上下文不能由内层正层级文字逃出。本轮新增拒绝仅针对已证明的负层级，不将 `null` 未知层级一概拒绝，保留 `will-change` 等既有支持场景。

来源：`src/chrome/snapshot-readable-source.js`、`e2e/snapshot-paint-probe.ts`、`e2e/snapshot-readable.spec.ts`。

用作者背景或边框证明空控件的可见存在时，也须确认其实际绘制来源：背景不含 image，且已证明 `background-clip:border-box`；border-image 未确认时，背景颜色不足以证明纯色 ground 或控件自身 fill，也不能仅用普通 border 颜色作证。控件自身非透明的 inset shadow 同样使 background fill 证明不足；普通 border 分支仍按原条件独立保留，不因 inset shadow 一概禁用。不能因为盒子有尺寸或声明了不透明颜色，就跳过背景裁剪、合成及前景遮挡证明。

2026-11-07 对潜在前景绘制进一步按实际来源约束：空 HTML 盒子没有可被装饰的 composed 文字或非空生成文字时，不因 text-decoration 声明制造下划线；replaced 子树自身的绘制仍独立保留，标签名必须结合命名空间判断。list-item 按 display token 识别，只有不能排除的 marker 才扩大其潜在绘制范围，不能把无 marker 的远处列表项当作整个视口的遮挡。

受支持的 SVG 逐图元读取原生 `getBBox()`、`getScreenCTM()`，并保守扩展描边、端帽与斜接；不能假设 Chrome 实现了 getBBox 的 stroke/markers 选项。Chrome 156 的文本叶子边界包含实际文字墨迹，不能仅据上层旧注释推断其只含 EM 盒子。透明 SVG viewport 不自动等于墨迹区域，只有实际 CSS 背景或边框绘制才加入其盒子；独立证明的 SVG 视口及祖先裁剪可与墨迹上界相交。外嵌于 HTML 的 SVG 按已确认的 CSS 盒子证明视口；nested SVG 则须证明自己的 viewport，不能用包含溢出墨迹的 client box 代替，未覆盖的 viewBox 变换保持 unknown。inline replaced SVG 仍执行其视口裁剪，不能按普通 inline 跳过。foreignObject、use、未知资源、滤镜、marker、非缩放描边及未覆盖的变换继续保持未知，不能用 fill box 缩小它们的潜在绘制；存在选区时，透明图元也可能产生选区绘制，不能按透明 fill/stroke 当作零绘制。

普通 SVG 叶子文字复用同次逐图元墨迹与矩阵片段，在纯色 fill、背景对比、裁剪、空白和 foreign cover 均获证明后输出。只接受已覆盖的字符排列与样式子集；逐字位置列表、复杂 spacing、bidi、伪元素差异等不能由整体包围盒推断成正确文字或视觉顺序。与其他图元相交时保持 unknown，不按 DOM 绘制顺序猜测谁遮住谁。恢复文字也不代表完整理解图表，`visual-content` coverage gap 仍保留。

普通叶子文字的 solid underline 可使用同文档 Canvas 字体度量建立有限纵向上界：空串的 top/bottom baseline 指标夹住 primary font 的原始 ascent，避免依赖 BASE 偏移或字号倍数猜测。字体及 offset/thickness 数值使用 Typed OM 避免序列化舍入；只有字体描述可匹配、页面 zoom 为 1 且其他裁剪、变换、伪元素条件获证时启用。字体资格逐项确认影响 primary metrics 的明确 longhand，不依赖可能为空的 font shorthand；伪元素同样比较相关 longhand。已证实仅影响 shaping 的 numeric/features 不因 shorthand 为空被拒绝，显式 variation 等尚未匹配的度量变化仍保持未知。GSUB/gvar 字形变化的验证不能替代 MVAR primary metrics 变化的独立证据。zoom 在采样前后确认，变化时拒绝该次结果；不满足字体证明时保留局部横向不确定范围，巨大 offset、粗线和其他装饰不能被忽略。

这份 primary metric 证明使用同文档匹配的 FontDescription 和实际空串 top/bottom 度量，不以整个 family list 的 `document.fonts.check` 作为资格。Chrome 156 的 check 会遍历后续 family，即使实际 PrimaryFont 查找已在前方可用字体停止，unused fallback 未加载也可能使其返回 false。度量后及同步采样返回前仍须确认 `document.fonts.status` 为 loaded；若查找触发 cold primary 加载而同步进入 loading，本轮采样返回 null，待后续 task 重新确认，不能混合旧布局与新字体。

装饰条带的有限上界仅用于判断潜在外来绘制，不等于下划线正文已经可读。普通 underline 的自身文字证明仍可能 unknown；单个系统字体的离屏墨迹实验未证明原生 baseline、栅格相位与完整条带严格分离，不据此放行或宣称任意链接已支持。

异步 IntersectionObserver v2 的结果未纳入同步采样：真实 CSSOM 竞态与目标自身遮挡反例不能由旧回调证明当前文字可见。同 z-index 的 DOM 顺序不用于一般绘制顺序推断。客户端水合在采集中替换控件时，严格采集共享现有的一次稳定重采预算；普通读取错误继续明确失败，不引入站点专用回退。局部采样的范围与完整性限制继续生效，不能把偶尔取得主要文字视为动态网站已完整验收。

来源：`src/chrome/snapshot-readable-source.js`、`src/chrome/automation.ts`；Chrome `156.0.8078.80` 的 [ShadowData](https://chromium.googlesource.com/chromium/src/+/refs/tags/156.0.8078.80/third_party/blink/renderer/core/style/shadow_data.cc)、[ShadowList](https://chromium.googlesource.com/chromium/src/+/refs/tags/156.0.8078.80/third_party/blink/renderer/core/style/shadow_list.cc)、[Skia 绘制辅助代码](https://chromium.googlesource.com/chromium/src/+/refs/tags/156.0.8078.80/third_party/blink/renderer/platform/graphics/skia/skia_utils.cc)及 [BoxPainterBase](https://chromium.googlesource.com/chromium/src/+/refs/tags/156.0.8078.80/third_party/blink/renderer/core/paint/box_painter_base.cc)。

### 局部覆盖证明共享，内容完整性单独验收

2026-11-07 完整文字投影与同步采样共用 mask/inset 局部覆盖算法，区分 complete、empty、unknown；同步采样中，已证明完全排除的内容优先于背景等不确定性，真实部分裁剪不能按原文放行。算法仅接受已覆盖的定位、合成、轴向渐变及圆角子集，保留各路径的其他绘制和身份校验。纯 helper 按根 frame、loader 和根文档修订去重安装，失败或身份失效后重建，不因无关子帧变化重复安装，也不缓存当前页面的文字、样式或几何为永久事实。

私有 factory v2 的文字流证明 `textFlowCoverage` 只允许已覆盖的 line-clamp 子集在同次实际行框与结构足以确认当前文字完整时通过。shadow/slot 等复杂 scope 的限制只在实际存在 clamp 时适用；没有 clamp 的作者 composed 内容继续走既有可见性流程，不因此一概拒绝。同步 sampler 传入真实 composed 父链，避免 closed slot 的 `assignedSlot` 不可见时漏查祖先 clamp。完整路径即使整体为 full，未获证明的 closed-slot clamp 名称也保留 unknown，不能据 full 标签放行原文。

伪元素仅在 content 为空串、absolute/fixed 脱离文字流，且背景、边框及 border-image、outline、shadow、filter、appearance 等绘制来源均可证明为空时，才不计作额外文字流分支。in-flow 生成盒即使没有文字，也可能增加行数；有任何未确认绘制来源的定位伪元素同样保持 unknown。此项局部判断不省略独立的 paint、clip 和 whitespace 校验。

静态候选的 `effectClipRisk` 声明数组必须与该次 live `clipInputs` 逐项一致，不一致或未覆盖的文字流保持 unknown；不能凭后来样式可读就套用到另一份静态捕获。局部文字流证明不替代普通裁剪、空白、遮挡或身份校验，也不代表任意被截断内容已经恢复。该证据接口保持私有，不新增模型可见字段、编号或目标别名。

完整路径的普通 overflow 外矩形继续用于 visible 候选筛选，文字证明另维护保守的圆角安全内区：按 CSS 外半径的各轴最大值，从 client padding 边界向内收缩，并结合 bounds/offset 的缩放及 1/64 CSS 像素的布局余量。CSS 半径重叠归一化只会缩小使用半径，因此落在该内区是充分条件；边角或不支持的几何保留 unknown，不能把外矩形包含当作圆角包含，也不把所有圆角文字判为隐藏。有无 clamp 都保留被曲线裁掉末尾字符的限制；缩放 clamp 仍受既有文字流证明支持范围约束。这不是精确圆角可见性判断或通用 CSS renderer；同步采样中已支持的实际半径几何证明仍按其自身条件使用。

验收分别检查内容覆盖、传输完整及模型理解：读完所有冻结续页只证明传输完成，不能把 partial、unknown 或 coverage gaps 变成完整观察；AX 中存在名称也不直接证明其可见。接口接通和定向沙盒通过仍须经过统一实站复采，不能代替完整内容覆盖验收或目标完成。真实模型盲读只提供公开快照与其局限，使用受限表达和同次候选的确定性唯一性验证，不让模型读取答案或私有节点身份，也不以第二个模型的理解冒充工具解析。该实验不证明通用自然语言定位、变化后目标仍相同或实际点击成功。

实站已确认 Polymarket 的主标题、分类导航、原生按钮及状态可以恢复，但仍有重要 unknown 和 partial，不能视为目标已全部完成。OpenRouter 早期模型说明为 unknown 曾是实际内容缺口；当前完整与同步只读路径已实测恢复简单、未截断的 LiquidAI 说明，且不重复输出正文。复杂或部分 clamp 等未获证明的内容仍可能 unknown，full 标签不能代替逐项内容验收；对 unknown 的安全拒答也不能算内容覆盖通过。

真实模型可从公开快照读取已恢复正文，并区分同文歧义；严格受限表达实验中曾返回大写 LINK，而验证器要求小写 link，原严格评分失败保留。离线仅做角色位置的 ASCII 大小写归一化后可唯一匹配，不更改原响应或把事后诊断算成原协议通过。Artificial Analysis 的“图像分类按钮”曾被模型过度按字面解释而未选择已有“图像”按钮，旧失败同样保留，后续同题答对不能消除其泛化风险。这些实验不表示产品已实现通用自然语言定位、实际点击或全页完整覆盖。

来源：`src/chrome/snapshot-observation-primitives.js`、`src/chrome/snapshot-text-paint.ts`、`src/chrome/snapshot-readable-source.js`、`src/chrome/automation.ts`，以及无编号快照的真实模型盲读实验。

### 简化模型收到的快照编码

2026-11-02 删除快照行字典及当时的额外输出编码实现，简化模型可见协议；不再要求模型通过这些中间编码重建快照正文。2026-11-07 的重复叶子呈现重新引入局部 `step`/`count` 几何编码，需按上述规则展开盒子；这不恢复原先的快照行字典。

来源：[`42daad1`](https://github.com/notCorwin/SurfWax/commit/42daad1)。

## 运行所有权、开发与交付

### 自主管理对话运行时

2026-10-13 替换 Assistant UI runtime，使用项目自己的对话存储和运行时组织侧栏。后续会话状态与分支的处理由本项目实现承接。

来源：[`c0376a9`](https://github.com/notCorwin/SurfWax/commit/c0376a9)。

### 运行所有权在整个扩展范围内唯一

2026-11-04 用跨侧栏的运行租约协调任务与会话写入。所有权包含运行、拥有者和代次；旧运行的迟到请求不能作用于新运行，重复操作不能再次接受。侧栏断开或对应文档关闭时取消所属运行；后台协调器只保存瞬时所有权，持久运行事实仍由日志表达。

来源：[`902eeb0`](https://github.com/notCorwin/SurfWax/commit/902eeb0)，见 `src/agent/coordinator.ts`、`src/agent/background-coordinator.ts`。

### 开发浏览器保留进程沙箱

2026-11-04 启用开发 Chrome 的进程沙箱；同日曾关闭，随后明确撤销关闭沙箱的提交。最终选择是保持沙箱启用。

来源：[`3f224fc`](https://github.com/notCorwin/SurfWax/commit/3f224fc)、被撤销的 [`d1ffb4a`](https://github.com/notCorwin/SurfWax/commit/d1ffb4a)、[`35205f9`](https://github.com/notCorwin/SurfWax/commit/35205f9)。

### 开发资料留在仓库内，生成物有保留边界

2026-11-04 将开发 Profile 与测试证据集中到仓库内管理，并引入按运行回执清理生成物的机制。每类测试至少保留最近一次已结束运行；未结束或回执无效的目录保留供检查。浏览器缓存清理需要确认 Profile 未使用，拒绝符号链接路径，避免误删活跃数据。

来源：[`af48f1e`](https://github.com/notCorwin/SurfWax/commit/af48f1e)、[`7a4ca61`](https://github.com/notCorwin/SurfWax/commit/7a4ca61)，见 `scripts/dev-storage.mjs`。

Profile 清理锁记录当前 PID、进程起始时间及唯一 owner；释放只删除自己创建的 owner 文件并移除空锁目录，不递归删除可能已被替换或仍有其他记录的锁。

来源：本地提交 `74d3642`，见 `scripts/dev-storage.mjs`。

### 能力评估区分工具验证与真实模型验证

2026-10-30 起引入模型评估，随后按任务能力建立关卡，并提供不调用模型的沙盒和工具验证。固定脚本通过只能证明工具及关卡可用，真实模型完成能力由独立的模型评估证据支持；不能混用两类结果。

来源：[`45f231c`](https://github.com/notCorwin/SurfWax/commit/45f231c)、[`75a7e54`](https://github.com/notCorwin/SurfWax/commit/75a7e54)、[`b2c9e1d`](https://github.com/notCorwin/SurfWax/commit/b2c9e1d)、[`a6135d6`](https://github.com/notCorwin/SurfWax/commit/a6135d6)。

2026-11-12 起，按用户明确决定，实际 Surf Wax 任务及其内部完成复核、上下文压缩与真实模型验收只使用 `gpt-6-luna`；开发子代理的模型不受此限制。每次真实会话都审阅历史，包括通过的用例，以模型实际收到的工具选择、结果和证据检查 Harness，不用更强模型掩盖工具契约缺陷。保留旧失败样本、证据与原分类；修复后的复测另建验收批次，不覆盖旧结果，也不把事后诊断算作原样本通过。

来源：用户 2026-11-12 的模型与会话审计约定；验收入口见 `e2e/real-model-evaluation.spec.ts`、`e2e/evaluation/run-evaluation.ts`。

### 删除自动发布，改为本地打包

2026-08-14 曾引入 Autobuild GitHub Release 工作流；2026-10-14 删除自动发布，将版本设为 1.0.0，并完善本地发布包生成及来源校验。发布材料与 Vite 的公开输入隔离，归档输入与顺序需要可确定。

来源：[`2e96a95`](https://github.com/notCorwin/SurfWax/commit/2e96a95)、[`f1e1eac`](https://github.com/notCorwin/SurfWax/commit/f1e1eac)，见 `scripts/package-release.mjs`。

第三方材料按真实输出模块、资源及明确归属的 public 输入生成，保留原文、哈希和来源；包的 license 字段不能代替完整条款。补充的官方标准条款与发布者对具体版本的许可声明分别记录，不能冒充原包内文件或据此猜造版权及 NOTICE。清单绑定锁文件与实际分发输入，无法核实的材料明确阻止发布。Chrome 138+ 只分发 KaTeX 的 WOFF2 格式，保留全部字型；TTF 仅作为提取原始字体声明的构建输入，不再重复分发兼容格式。

来源：`f3addcc`、`ffea672`、`f51ec24`，见 `scripts/third-party-licenses.mjs`、`scripts/validate-third-party.mjs`、`scripts/licenses/sources.json`、`vite.config.ts`。

发布路径保护同时覆盖 checkout 的 `.git` 入口、实际 Git 目录和 worktree 共用的 Git 目录，并解析真实路径。构建目录不能位于这些目录内，也不能成为其祖先；发布输出不能落入元数据目录，防止 `emptyOutDir` 擦除共享仓库。

来源：`scripts/package-release.mjs`。

### 使用 GPL v3 许可证

2026-11-02 为项目加入 GNU GPL v3 许可证，具体条款以 `LICENSE` 为准。

来源：[`ced9391`](https://github.com/notCorwin/SurfWax/commit/ced9391)。

真实构建随项目保留根 `LICENSE` 的 GPL 原文，校验器逐字节核对；项目许可与第三方材料分别表达。发布包的 `SOURCE.txt` 与发布说明从冻结的干净提交生成完整公开源码与源码归档入口、版本和 Node 24 构建命令，不能写死候选提交或把本地构建当成源码已经公开。归档核验包含该文件；实际分发前仍须使对应提交在公开仓库可取得。

来源：`vite.config.ts`、`scripts/validate-build.mjs`、`scripts/package-release.mjs`；条款依据根 `LICENSE` 第 4、6 节及 GNU 官方 GPL v3 文本。

### 验收区分测试运行、工具终态与用户目标

2026-11-04 的测试能力审计采用分层证据：测试退出状态只说明测试执行结果，工具终态只说明调用如何结束；用户目标是否达成还要核对页面、持久状态和实际交付内容。脚本化 Provider 与固定审查 verdict 适合检验协议和恢复流程，不能证明真实模型能自主判断任务；复用历史模型实验时应保留来源、源码匹配与验收范围。

针对关键断言，先记录无故障基线，再注入明确故障，并检查失败发生在对应的用户目标断言；基线失败、设置错误或超时不能自动算作捕获缺陷。动态语义观察失败后，符合约定的只读降级与独立截图属于恢复行为，应检查实际分支，不以测试通过直接推断可用性缺陷。

来源：`audit/testing-audit-2026-11-04.txt`、`audit/mutation-evidence.json`、`e2e/completion-review-boundary.spec.ts`、`e2e/page-independent-tools.spec.ts`。

### 测试区分扩展重装、浏览器重启和 Worker 重启

CDP `Extensions.loadUnpacked` 重新加载扩展不能当成持久安装后的普通浏览器重启。脚本恢复关卡通过管理页保存声明，清空原生注册以模拟投影丢失，再停止并唤醒 MV3 Worker，核对声明、注册状态及新页面上的实际执行。该关卡不证明浏览器重启、扩展重装或重新授权后的恢复行为。

来源：`audit/extension-installation-probe.json`、`audit/user-script-restoration-failure.json`、`e2e/userscripts.spec.ts`。

### CI 选测结果通过实际收集核对

关键用户路径在 `scripts/required-user-journeys.json` 独立列出，并以 `@user-journey` 标记；本地收集按当前 CI 的文件、标题、项目和性能排除条件核对这些路径，拒绝丢失标签与静态跳过。收集结果不等于远端执行结果，也不能证明运行时没有跳过。变异实验在独立源码副本中运行并使用 stage 锁，比较完整输入文件集合与哈希，拒绝新增、缺失或被修改的文件；仅排除明确的生成目录及共享依赖，后者仍是复用边界。

来源：`.github/workflows/capability-tests.yml`、`scripts/audit-tests.mjs`、`audit/ci-filter-evidence.json`。

失败证据须单独核验日志、结构化报告和 HTML，运行回执本身不足以证明报告存在。审计随提交提供冻结源码及结构化原始证据归档和哈希；未打包的二进制 trace 与外部图像明确标为仅存本机，避免将摘要或路径当成已交付现场。

### 测试清理以独立回归价值为依据

2026-11-05 清理测试时，只有已经找到更强的现存行为断言，或确认旧测试仅证明平台能力、失效构建假设时，才删除测试及其专用辅助代码。SDK 初始化属性检查由遍历同一注册表的真实 SDK 生成契约承接；Cloudflare 假 loader 参数检查由最终请求 URL、凭证及网关请求头断言承接。直接争抢同名 Web Lock 只证明 Chrome 的锁语义，不证明应用写入使用该锁；应用日志原子性、跨写入者互斥与恢复回归继续保留。只验证测试内局部变量自赋值的断言可删除，实际工件切片与跨会话拒绝断言继续保留。

开发构建的 HTML 入口可由 Vite 按请求提供，不能以输出目录中缺少 `userscripts.html` 判定管理页不可用。静态版本、权限集合和入口存在性由构建校验负责；开发 Chrome 测试继续验证管理入口、管理页加载和真实脚本注册/执行。删除重复静态断言不改变产品行为。

快照可见性/证据边界、原生输入与 MV3 生命周期，以及评估器拒绝不完整或失真证据的负控具有独立保护价值，不因用例规模、Mock 数量或同主题浏览器关卡而删除。用途或替代覆盖尚不明确的测试保留；单测与收集通过不能表述为全量 E2E 或真实模型能力已验收。

来源：`src/agent/sdk-generate-contract.test.ts`、`src/agent/cloudflare-model-routing.test.ts`、`src/logging.test.ts`、`src/chrome/executor.test.ts`、`scripts/validate-build.mjs`、`e2e/userscripts.spec.ts`，以及本次测试维护审计。

### 独立工具测试复用生产执行链

2026-11-10 为无扩展测试增加 Node 工具入口，通过 CDP 连接已运行的 Chrome，复用生产工具注册表、Schema、执行器、可见快照和结果归一化；不另建一套测试专用工具实现，也不向 Node 全局伪造 `chrome`。独立入口仅用于开发测试，不改变扩展不桥接本地程序的产品架构。

程序宿主按通信传输拆分，浏览器沙盒和 Node Worker 共用能力 RPC、值编解码和程序 Worker 逻辑。取消必须能终止不让出执行权的程序。快照辅助函数在独立模式下使用明确命名的隔离世界，仍通过同一可见性与可访问性证据链生成结果。

独立运行使用会话内存中的追加事件日志维护运行身份、工具结果和产物引用，不承诺跨进程恢复。依赖扩展原生 API 的能力明确返回 `extension-required`，由扩展测试验证；独立测试通过不等于扩展生命周期、持久恢复或真实模型任务能力已经验收。

2026-11-11 将已有内存事件存储提升为独立入口与测试共用的 `createMemoryEventStore`。内存存储必须支持生产日志契约中的批量追加、分块产物写入与范围读取，以及产物和作业终态的原子关联；不能只实现 `append` / `all`，让小结果通过而在较大截图越过分块阈值时失败。真实 Chrome 回归明确制造超过阈值的图像，确认产物进入分块路径、工具可读取其图像数据，且作业终态仍引用同一产物。

来源：`src/standalone/runtime.ts`、`src/standalone/chrome-adapter.ts`、`src/chrome/program-host.ts`、`src/chrome/program-worker.ts`、`scripts/tools.mjs`、`src/standalone/runtime.test.ts`、`src/memory-event-store.ts`。

### 动态页面的独立只读采样保持 Shadow DOM 证据完整

2026-11-10 在 Polymarket 的真实页面上，批量快照因动态布局或文字绘制不稳定而进入只读采样，暴露出该路径仍依赖扩展专属 `chrome.dom.openOrClosedShadowRoot`。独立模式改为通过 CDP 获取当前根文档的 ShadowRoot 拓扑，并将开放、闭合和原生根解析为同一隔离世界内的真实对象；采样只在最终同步读取中使用它们当前的内容、样式和几何，不把早先 DOM 抓取的文字拼入结果，也不以 `element.shadowRoot` 代替闭合根的证据。

ShadowRoot 在拓扑采集和对象解析期间被添加或移除时，使当前根文档读取失效，返回 `stale-observation`；后续读取重新采集当前根，避免已被 Shadow DOM 遮蔽的 Light DOM 字符串进入结果。动态页面恢复仍明确标记 `partial=true`、覆盖缺口和未知名称，不把有内容输出视为完整页面证据，也不为单个网站放宽可见性约束。

回归测试保留真实浏览器中的开放/闭合根、隐藏与视口外内容排除，以及采样中途新增闭合根后的拒绝与重采。这些断言能分别发现扩展依赖回流、隐藏内容泄漏和跨读取拓扑竞态，具有独立回归价值。

来源：`src/chrome/automation.ts`、`src/chrome/snapshot-native-runtime.ts`、`src/chrome/snapshot-readable-source.js`、`src/standalone/runtime.test.ts`。

### 核心回归测试精简

2026-11-11 根据用户明确决定，将自动化测试收敛到约 20–30 个核心用例，取代 2026-11-05 要求在用途不明确时保留测试的维护策略。优先保护 Canonical Event Log 的持久性与恢复、重复操作、停止与中断、可见快照、上下文压缩与计数、关键 UI，以及真实 Provider SDK 的请求契约；删除其他测试不代表这些行为已经由保留用例覆盖。

保留的 SDK 契约通过真实 SDK 和模拟 HTTP 响应检查 OpenAI Responses、Anthropic Messages、Google Interactions 与 OpenAI 兼容 Chat Completions 的工具结果往返、恢复和取消；它使用显式端点和 Custom Provider 配置，不证明普通 Provider 的自动端点选择或其他 SDK 的行为。确定性浏览器任务使用脚本化模型响应；真实模型评估必须显式启用，因此常规测试通过不证明模型任务能力。快照测试覆盖所列可见性场景，不证明所有绘制与动态页面边界；删除既有细分回归是本次精简接受的覆盖取舍。

来源：`src/logging.test.ts`、`src/agent/runner.test.ts`、`src/agent/sdk-generate-contract.test.ts`、`e2e/snapshot-visibility.spec.ts`、`e2e/context.spec.ts`、`e2e/lifecycle.spec.ts`、`e2e/real-model-evaluation.spec.ts`。

### 评估器入口与执行职责

2026-11-11 将真实模型评估的环境参数解析与执行流程拆分：真实模型入口保留显式启用和外层超时，确定性负控直接调用同一个评估执行器，避免嵌套启动 Playwright。报告、指纹、任务截止判断和后台作业证据仍由共享执行流程产生；普通测试通过不代表真实模型能力通过。

来源：`e2e/real-model-evaluation.spec.ts`、`e2e/real-model-harness.spec.ts`、`e2e/evaluation/options.ts`、`e2e/evaluation/run-evaluation.ts`。

### 真实网站评测与独立事实来源

真实网站关卡用于观察 Surf Wax 在本机 Chrome 和真实模型下的研究过程；本地 fixture 与脚本化响应主要验证工具、协议和评分边界，不能证明真实网站任务能力。评测前独立冻结公开来源及其哈希，以固定历史范围和来源语义校验构造事实基准；评分应同时核对答案事实与真实浏览工具证据，不能把模型自述来源或格式正确的 JSON 当作访问证明。不完整来源不能作为完整答案基准，网站或来源不可用应与模型任务失败区分。

原生公开 HTTP 工具的真实响应，以及模型通过关联工件实际读取到的内容，也是合法来源证据；工件的未读取正文不能计入。只读作业是否到达终态与操作副作用是否确定分别报告，不能把未知直接当作成功。对保留的运行与冻结来源进行离线复核时必须明确标识，不能伪装成新的模型运行或覆盖原始记录。

当前三个关卡分别为 Nobel 化学奖重复获奖者中等校准题、Vite 版本兼容性和 Chrome userScripts 版本边界困难题，不将其称为极难题。现有本地预检报告显示三个来源预检为 ready；这仅证明当次预检，不能证明 Chrome 中网站可用、真实模型完成任务或回归通过。真实模型运行和回归验证另行记录。

来源：`e2e/public-web/`、`e2e/public-web-evaluation.spec.ts`、`scripts/public-web.mjs`，以及本地预检报告。

### 公开网站评测最终证据采集

评测清理前不等待未完成的页面关联，冻结当时可得的文档和导航元数据（未知 tab 保持空值），有界读取一次 canonical 事件并先保存冻结的原始观察，再统一派生报告；读取失败时保留先前观察并标明采集失败，不能将未确定的副作用推断为安全。最终补读不会改变已有失败或超时判定，派生错误与运行和采集错误分别记录。成功读取仅证明本次读取成功，不证明历史完整。

### 有状态真实网站关卡与受控清理

2026-11-12 将匿名购物车作为有状态关卡：评测器仅准备隔离会话的初始状态，模型负责两阶段商品与数量调整；关闭并重开业务页后，独立读取真实购物车核验保留项、规格、数量、预算及恢复一致性。会话终态、业务状态、页面呈现和清理结果分别记录，购物车已达到目标不能替代模型正常结束。已完成的网站准入也不能当作双阶段模型评测通过。

清空购物车前必须确认本轮执行者停止、后台运行租约释放、作业与写入结果收敛，并检查明确的后台清理失败证据；租约释放本身不能覆盖清理错误。随后关闭业务页面与侧栏以阻止继续派发，再经同一隔离会话的独立 HTTP 请求清空并核验。无法确认停止或存在未知写入时保留未验证结论，不用固定等待或全量失败替代状态判定；任务失败与资源清理失败分别报告。

后台清理结果属于权威运行事实：先将失败细节及 `run.cleanup.finished` 持久化，再释放所有权，避免缓冲遥测晚于 idle 状态出现。评测读取本轮 `runId` 的清理终态，不能因其没有 `conversationId` 而漏掉后台错误。只读任务的作业终结与有状态任务的副作用确定性仍分别处理；清理终态或写入收敛未知时，不能借只读终态规则判成功。

Excalidraw 的编辑、文件导出与恢复尚未完成准入，其初步 oracle 和专用测试不列为正式关卡实现；探测记录留在本地验证目录，不宣称真实模型通过。

来源：`e2e/stateful-web/`、`e2e/stateful-web-evaluation.spec.ts`、`e2e/stateful-cleanup.spec.ts`，以及本地准入与模型运行报告。
