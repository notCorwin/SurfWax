# 状态机审查

本文记录项目运行时的状态、所有权和转换。状态是对实际代码的归纳，并不要求每一项都增加一个枚举；有明确业务状态的事件日志仍是持久事实的唯一来源。一次性条件判断和普通局部变量不列入。优先级按可观察的数据丢失、重复副作用、死锁，再到短暂展示错误和维护成本排序。

表中“保持”表示现有局部状态或投影能够表达约束，不建议单独引入状态机框架；“约束”表示在现有所有者内收紧转换或异步失效规则。风险是静态审查发现的边界，除另有说明外不表示已复现的故障。

## 运行、日志和模型

| 状态机与所有者 | 状态、事件、条件和副作用 | 评估 |
| --- | --- | --- |
| 全局运行租约：侧栏 coordinator 和后台 BackgroundRunCoordinator | 空闲 → 申请 → 持有 → 取消／释放。申请要求无其他 owner、无维护且取得锁；取消、中断端口或窗口关闭触发 abort；释放端口和 Web Lock。generation 和 ownerId 拒绝旧操作。 | 约束申请握手的取消，防止无响应的后台使申请与锁永久占用。 |
| 一轮运行：transport | 已提交 → 模型／工具 → 刷新投递、协议修复、目标续跑或重试 → 完成／失败／中止。abort 和持久化结果决定能否继续；转换追加 canonical 事件并清理租约。 | 保持循环；不可将模型调用、日志终态和副作用的局部状态混为一个枚举。 |
| 工具反馈和中断恢复：transport、EventLogger、会话投影 | 已接受／已开始 → 成功／失败；owner 消失时按已持久化证据为悬空调用合成终态。由 run、phase、call ID 和日志 epoch 约束，首次终态胜出。 | 保持事件投影；注意日志写入和恢复必须保持幂等，不能推断未观察到的副作用。 |
| 会话和分支：EventLogger、conversation repository | 创建／恢复、消息追加、选择分支、删除；submitted → 运行，终态 → 空闲或中断。事件顺序及 parent/head 决定可见路径，删除和恢复追加事件。 | 保持日志投影；历史消息和当前 head 必须用同一日志世代。 |
| 上下文压缩与计数：compaction、runner | 原始 → 达到压力／溢出 → 压缩 → checkpoint 有效；分支、模型、来源 digest 或版本不匹配时失效并重新计算。副作用是摘要和计数校准事件。 | 保持带来源的 checkpoint；不能把过期摘要当作当前分支事实。 |
| 增量上下文选择：context-choice | 空 → 按 afterId 增量投影；epoch 变化时丢弃并重放。latest valid 取代较早有效结果。 | 保持 cursor 和 epoch 配对；避免旧日志世代的数据参与新结果。 |
| 后续消息：日志和 LocalComposer | queued → dispatched／removed；上一轮正常结束或用户主动恢复才自动派发，立即发送先取消运行。消息、出队和 submitted 在同一事务中写入。 | 约束持久化前清空输入及派发失败路径；事务失败须保留队列，提交后崩溃按 submitted 恢复。 |
| 完成目标：runner 和 goal-completion | 收集证据 → 独立调用 complete_goal → 校验任务、证据、未知效果及后台任务 → 审核通过／继续。拒绝时继续主循环。 | 保持校验边界；完成状态必须以实际结果而非单一布尔值决定。 |
| 请求恢复：model 和 transport | 请求 → 成功／可重试／上下文溢出／永久失败；abort 终止重试，溢出先压缩，其他恢复性错误等待后重试，追加重试事件。 | 保持两层职责，关注终止信号和相同上下文反复压缩的边界。 |
| 推理参数：ReasoningSettings | 未就绪 → 读取手动及学习记录 → ready 和后台探测 → 可选项；provider 拒绝值则排除并选择下一个，字段不支持时禁用，学习结果持久化。 | 约束选择只能位于可用集合，串行化共享存储的读改写；长寿命内存实例的学习记录 TTL 尚不会主动刷新。 |
| 模型目录与限制：model-limits | 内置／有效缓存 → 需要时刷新 → 新目录或失败后保留可用数据；按 key 合并进行中请求，revision 使派生匹配失效。 | 保持数据生命周期；保证缓存有效性和 in-flight 去重，不把缓存命中视为业务终态。 |
| Provider token：model | 无／临近过期 → 兑换 → 有效 → 过期重换；缓存属于模型实例。 | 检查并发兑换与服务端语义；仅在确有共享需求时去重。 |
| 启动和日志维护：background、EventLogger | 启动维护 → 恢复输入和悬空运行 → 开放；清理时通知 writers、等待操作 → 清理成功／失败 → 恢复。generation 拒绝旧写入。 | 约束被失败或超时取消的旧 prepare，不能在恢复后再次暂停 writer。 |
| 自动命名：conversations | 无标题／待首次完成 → 生成中 → 写标题；生成前后均检查手动标题，删除或中止阻止完成；同一会话请求去重。 | 保持局部异步流程；手动标题始终优先。 |

## 浏览器与脚本

| 状态机与所有者 | 状态、事件、条件和副作用 | 评估 |
| --- | --- | --- |
| 自动化会话、文档和 frame：AutomationRuntime | 创建 → 初始化 → 可用 → 导航、frame 附着／迁移／分离导致旧代失效 → 重建／释放。generation、frameRevision 和 session 所有权约束引用。 | 保持代次和资源所有权；旧 frame、DOM handle 不能跨文档使用。 |
| 快照分页与交付：AutomationRuntime、refresh observer | 捕获／冻结 → 分页 → 待提交 → 完整投递后推进基线，或失效／取消。只有当前文档和按顺序交付的分页可提交；日志持久化确认后 finish lease。 | 保持显式 lease；捕获不等于已交付，导航及取消必须释放。 |
| 刷新观察：RefreshTracker | loading → complete → 已绑定的 pending 或未绑定完成；绑定后投递，drain 消费，切 tab、移除和 abort 清理。generation 检查是否仍为当前文档。 | 保持局部跟踪；不能为过期文档投递快照。 |
| 工具批次调度：ToolScheduler | prepare 创建 slot → 等待前项 → 派发 → settled；失败建立资源／弹窗屏障，清理和只读调用有例外，后台任务未观察终态时阻止相关工作。 | 保持 slot 和 fence；slot 只能消费一次，取消必须释放后续等待。 |
| 浏览器执行与绑定：ChromeExecutor | 空闲／绑定 → 队列执行 → 结束／停止 → 释放；运行身份、tab、signal、event epoch 和后台任务限制执行。 | 保持执行器所有权；过期 run 回调不能继续使用当前 tab 或事件句柄。 |
| 后台任务：BrowserJobs 和事件日志 | queued → running → succeeded／failed／cancelled；执行回调也可不报告启动而从 queued 直接结束，owner 丢失可转 interrupted。启动、终态和恢复由日志状态、owner 和 epoch 约束；大结果可写入 artifact。 | 约束 running 和终态的条件写入，避免恢复之后的迟到启动覆盖终态；实际浏览器操作在副作用前等待 running 回执。 |
| 程序操作回执：ProgramScope | 排队 → 未派发 → 派发结果未知 → completed／verified，或失败；写前意图、pending 和 uncertain 记录副作用边界；finish／revoke 后能力失效。 | 保持局部回执；已派发而未确认不能推断无效果或自动重复。 |
| 沙盒宿主：program-host | iframe 加载 → 初始化 → worker 运行／RPC → 完成／失败／中止 → dispose；RPC 绑定及操作计数跟随实际进行中调用。 | 保持显式阶段和资源清理；中止必须终结同步死循环。 |
| 事件订阅：EventSubscriptions | active → closed／移除；发布推进 cursor，超出容量产生 overflow；读取等待事件、超时、关闭或 abort。owner 和 tab 限制访问。 | 保持局部状态；关闭必须唤醒等待者，overflow 不能伪装成完整历史。 |
| 弹窗／文件选择器：EventSubscriptions | active → handling → handled／uncertain；确定未派发才回 active，关闭、tab 或 owner 终止时删除；claim version 防止过期响应。 | 保持已声明状态及 claim 检查；不确定副作用不能自动重试。 |
| 前台阻塞：ForegroundBlockers | job／operation active，operation 可派发；观察到同 tab dialog 后先持久化证据 → blocked；也可 settled／cancelled／persistence-failed。 | 保持局部句柄；异步持久化完成后必须重新检查 job、operation 和 dialog 仍有效。 |
| 按住的输入：executor、background | key/button down → held → up；派发前记录意图，结束或崩溃时按日志恢复释放，失败保留待恢复状态。 | 保持按目标的串行化和恢复日志；派发结果未知时不能直接清除 held。 |
| 网络诊断：BrowserDiagnostics | 请求开始 → 补充头／响应 → 完成、失败或被导航替代；异序额外信息暂存，按 revision 和 log epoch 回放。 | 保持投影；事件缺失标记 incomplete，不能把未观察到当作未发生。 |
| 用户脚本注册：userscripts persistence | 定义保存为启用／禁用 → Chrome 注册／注销 → 启动时协调；失败尝试回滚，操作按队列串行。 | 保持持久定义为权威，Chrome 注册为外部投影；失败和启动恢复须可重试。 |

## 界面

| 状态机与所有者 | 状态、事件、条件和副作用 | 评估 |
| --- | --- | --- |
| 消息追底：MessageScroller | 跟随 → 用户主动离底暂停 → 回底或按钮恢复；内容和尺寸变化时仅在跟随状态滚动。 | 保持局部意图状态；不能以程序触发滚动误判用户意图。 |
| 侧栏会话和运行锁：ConversationStore、useRunState | 加载／空闲 → 运行 → 停止／完成；切换通过 loadVersion 排除过期结果，后台 owner 决定全局锁。 | 约束成功和失败的过期结果；运行期间会话修改必须检查全局租约。 |
| 消息、工具及等待展示：conversation-store、process-group、waiting-status | 根据消息 part、日志、run 和后续消息投影 running／complete／incomplete 等状态；终态由终止事件或工具结果决定。 | 保持纯投影；不能把展示态作为日志和工具执行的权威。 |
| 上下文计数和手动压缩：LocalComposer、App | loading → ready／unavailable；版本、待更新和取消限制异步结果。手动压缩取得租约 → 执行 → 完成／失败／取消。 | 保持局部异步状态；依赖变化后旧估算不可覆盖新值，正在评估时的新请求合并并在旧任务退出后处理。 |
| 设置编辑：OptionsApp | 加载 → 干净／已修改 → 校验 → 保存／失败或清空；存储成功后更新已保存基线。 | 保持局部表单状态；应区分保存失败与已保存。 |
| 脚本管理界面：ScriptsApp | 列表／编辑 → 已修改 → 格式化／保存／启停／删除；存储变化触发刷新。 | 约束并发刷新结果，旧读取不能覆盖新状态；草稿修订需阻止迟到格式化覆盖用户输入。 |
| 会话搜索及撤销：ThreadList | 未建索引 → 索引建立／增量更新 → 失效重建；删除后进入限时可撤销窗口。 | 保持局部缓存；日志修订决定索引失效，不把撤销窗口当作持久删除事实。 |

## 检查范围与剩余边界

逐项检查了状态所有权、终态与取消、并发结果的新旧顺序、持久化与外部副作用的先后关系，以及恢复时无法确认的效果。状态集合不等于所有布尔字段的笛卡尔积：一些组合是中间实现细节，只有影响下一次事件处理的组合才列为状态。分析不能证明外部 Chrome 或 provider 的所有时序；对需修改的竞争路径以可控异步测试验证。对尚无具体失败证据的局部状态和缓存不作机械式重构。

## 优先级和验证依据

1. **高：持久化或副作用失序。** 后续消息必须在写入成功后才能清除输入，消息、出队和提交作为一个事务；后台任务必须先以预期状态写入 `running` 才能派发操作，恢复到终态后不能倒退；日志维护失败后已取消的暂停请求不能再次生效。分别以写入失败、中断恢复、跨实例恢复竞争和延迟维护回执测试。[LocalComposer](../src/components/chat/local-composer.tsx)、[transport](../src/agent/transport.ts)、[BrowserJobs](../src/chrome/jobs.ts)、[EventLogger](../src/logging.ts)
2. **高：运行无法退出。** 申请租约等待后台回复期间允许取消，释放端口和 Web Lock，并拒绝无效 generation。[coordinator](../src/agent/coordinator.ts)
3. **中：并发结果或共享数据覆盖。** 会话切换和脚本刷新丢弃旧结果；推理设置的共享存储读改写串行化，读取失败不覆盖现有数据，恢复选择必须属于可用集合。均以可控逆序或失败测试验证。[conversation-store](../src/sidepanel/conversation-store.ts)、[ScriptsApp](../src/userscripts/ScriptsApp.tsx)、[reasoning](../src/agent/reasoning.ts)
4. **中：漏掉上下文检查。** 进行中的检查退出后处理最新的待检查请求，并保留同一 effect 中的强制请求；运行时仍不启动维护压缩。[ConversationView](../src/sidepanel/App.tsx)
5. **后续观察。** 内存中的推理学习结果在长寿命实例中不会主动按 TTL 失效；并发 token 兑换尚未共享请求，取消语义需先明确。事务保证本地提交事实一致，不能保证外部模型请求恰好执行一次。对这些边界本次不声称已修复。

本次约束优先放在已有状态所有者和持久化边界，未增加通用状态机框架。以上测试覆盖已证实的关键时序，并不构成对全部浏览器事件或 provider 行为的形式化证明。
