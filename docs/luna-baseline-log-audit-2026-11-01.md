# Luna Baseline 日志审计（2026-11-01）

## 本次运行范围与结果

使用用户指定的 `http://127.0.0.1:8317/v1` 与 `gpt-6-luna`，不约束思考强度；只使用开发扩展。每次任务预设 300 秒观察时限，不是 Harness 的工具次数限制。共八种任务，另外保留两次本地启动失败的独立重跑和一次公开网站中止后的重跑。

| 任务 | 已观察结果 | 判定边界 |
| --- | --- | --- |
| 跨页理赔 claims-queue | 三条目标审批正确，其余未变 | 业务通过；参数错误日志契约导致总评 unknown |
| 二进制 binary-transfer | 字节校验正确，文件改名后被拒绝 | 独立业务判分 failed |
| 动态框架 frame-replacement | 第一轮拒绝，0/12，模型声明外部依赖 | 独立业务和交互判分 failed；无法评价后续重建轮次 |
| 键盘重排 sequence-editor | 错误顺序提交被拒，最后模型请求未返回 | 300 秒超时，unknown；保留已观察错误 |
| 拖拽 pointer-drag | 重跑业务、可信交互、任务与生命周期均通过 | passed；首次 setup_failed 未调用模型，不计能力失败 |
| 不确定写入 uncertain-write | 重跑只提交一次，查询确认完成 | passed；首次 setup_failed 单独保留 |
| Wikipedia 跨页核对 | 已访问两条目，无最终答复 | 超时 unknown；已证实刷新与压缩缺陷，见公开网站审计 |
| GitHub Release / Issues | 首次 owner-disconnected；隔离重跑正常结束，但缺日期、第三项变更和 Issue 详情 | 结构检查通过，业务交付未完成；不能计成功，详见公开网站审计 |

冻结的六项本地初始计划及原始结果没有被重跑覆盖：`.dev/verification/luna-baseline/{plan.json,manifest.json,summary.json}`，planHash 为 `5c51f106b83abe3741c933f52e8a6b064ed8ef254d9e3c8e29c303321e7ae1d8`。原始汇总为 0 passed / 2 failed / 4 unknown，包含两次 setup_failed；重跑独立存于 `rerun-reports/` 和 `rerun-events/`，不能把它们偷偷替换为原始计划的成功样本。这是小样本诊断，不是统计成功率。

开发服务器日志还确认 HTML 测试报告生成会触发 Vite page reload，首轮并发样本存在环境干扰；构建哈希稳定不能证明浏览器没有重载。已将 `.dev/`、`playwright-report/`、`test-results/` 排除出开发监听，并增加设置前的应用就绪等待。GitHub 在此隔离后单独重跑。未证明某一次报告重载就是初次 owner 断连的直接原因。

两个通过场景也审计了恢复成本：拖拽重跑先错误地把 `region:"Loading desk"` 当语义区域名（字符串实际按 CSS 解释），随后改用 frame 内的结构化 main 定位成功；不确定写入没有盲目重交，但第一次完成调用误用 `resolves`，将网页“确认不可用”混同于工具 effectUnknown，移除不成立的引用后完成。它们没有无休止轮询或重复业务写入。

## 附加回归检查

1. 自动跟随底部：实际运行 `rendering.spec.ts` 的 follows-the-bottom 用例失败；窗口缩窄到 430×650 后距底部 176px，期望不超过 1px。保留 `.dev/verification/baseline-ui-regressions/pw/` 中的截图、trace 与失败上下文。没有把已有 autoScroll 配置当作通过证据。
2. 即时工具：click/double_click 支持 failFast，但结果还须等待快照采集；本次 sequence 的 focus 约等 40 秒。应区分输入派发与完整结果返回时限，不能泛称所有工具即时。
3. Schema 清晰度：本次已观察 frame 参数层级错误、region 字符串语义误解、无效 ARROWUP 被接受，以及框架归属缺失。严格校验正常不代表模型能低成本正确使用。
4. 开发窗口：`scripts/dev.mjs` 用 viewport=null，按 screen.avail* 设置窗口并读回断言。此次评测使用独立 headless profile，不能替代可见开发窗口是否铺满屏幕的实测。
5. 快照可见性：现有测试明确保留离屏但可滚达内容；这与“仅当前视口可见”不同。隐藏、透明、裁剪等过滤已有专门测试，本次未逐项重跑全部可见性组合。
6. 上下文计数：真实运行 `context.spec.ts` 的 provider-reported input tokens 校准用例通过；实现是字节估算加 usage 校准，不能称精确 tokenizer。Wikipedia 的容量门禁错误单独成立，不等同于本次已量到 UI 计数显示延迟。

交付验证：评测单元测试 9 文件共 56 项通过；TypeScript 检查通过；模型配置显示用例通过；上述两项 UI 回归一通过、一失败。没有为得到绿色报告而修改失败断言或隐藏失败记录。此次修正仅覆盖测试取证、公开网站入口及开发监听隔离；日志揭示的产品设计缺陷列为后续修复与同模型复测对象。

## 结论

Claims 与 Binary 日志暴露出三个有证据的设计问题：自动回传的动作后快照不能被完成验证器识别为观察证据；参数验证错误没有统一的错误代码，导致已经成功的业务被评测记为后台任务未知；文件导入允许不必要的改名，而常规快照不展示原文件名，模型将文件改名后被业务端拒绝。

`claims-queue` 的业务结果正确，五次点击完成三条审批和两次翻页。它没有反复寻找元素或重复审批。额外回合集中在一次参数结构错误及完成验证器强制补读。

`binary-transfer` 的失败不能归因于二进制被当作文本。本审计从原始事件的 base64 独立解码并计算 SHA-256，导入及上传前读取的 65,539 字节均与 fixture 的独立预期一致。明确发生的是原名 `sample-17.bin` 被覆盖成 `generated-file.bin`；服务端要求原名，因此单此差异就足以拒绝。最终接收端字节摘要没有保存在当前报告中，不能声称已经直接核验服务端收到的字节。

以下严格区分事件事实、代码解释与修复建议。没有把模型自述当作成功证据，也没有将业务成功改写为完整评测通过。

## 数据与审计方法

- 模型：`gpt-6-luna`；provider 标签：`local-baseline`；seed：17。
- 两场报告记录的开发构建哈希均为 `752df59b136f444fb36d0ff8921c6f5500d4503aa7ed5e6fc9cdaf1563dc2867`，运行前后稳定；浏览器为 Chrome 151.0.7922.34。
- Claims 事件文件：`.dev/verification/luna-baseline/events/1793527519990-17-3a65d2c5-fc8f-42f2-b0c9-4f12a578e960.json`。
- Binary 事件文件：`.dev/verification/luna-baseline/events/1793527521073-17-96fe9dc9-3538-46c0-b71e-7b81b1cb6561.json`。
- 对应结果报告位于同层 `reports/`，文件名相同。事件编号只在各自文件内唯一。

按工具调用的参数、终态、回传快照、下一步动作重建执行链，并将回合分为业务进展、必要核验、恢复及无新增业务信息的补操作。然后对照代码解释机制。工具总数不是绕弯的判据。

## Claims：业务正确，完成证据与错误契约增加成本

报告事实：`businessVerified=true`、`lifecycleVerified=true`、`networkSettled=true`、`ledgerDrained=true`，但 `jobsSettled=null`，整体 `classification=unknown`、原因 `jobs_unknown`。任务按时结束。

| 事件 | 实际行为与观察 | 判断 |
| --- | --- | --- |
| 16 → 20 | 首次 inspect 返回完整三列业务条件、状态、按钮引用及 Page 1 of 3；包含跨域子框架正文 | 有效起点；不存在子框架完全不可读的问题 |
| 30 | click 参数把 `frame` 放在顶层；schema 拒绝 `Unrecognized key: "frame"` | 一次参数结构错误，尚未执行点击 |
| 42 → 64 | 改用快照给出的 ref；CLM-17-1 从 pending 变为 approved，$900 项仍 pending | 恢复成功，自动快照可核验结果 |
| 75 → 91 | 点击 Next，回传 Page 2 of 3 | 正常业务分页 |
| 102 → 124 | CLM-17-3 从 pending 变为 approved；EMEA/AMER 仍 pending | 正确筛选并核验 |
| 135 → 151 | 点击 Next，回传 Page 3 of 3 | 正常业务分页 |
| 162 → 184 | CLM-17-2 从 pending 变为 approved；APAC $501 仍 pending、EMEA paid 未变 | 正确处理金额边界和非目标项 |
| 195 → 196 | complete_goal 引用三次成功 click 的动作后快照；验证器拒绝，称缺少 successful observation | 已有观察被按工具名排除 |
| 207 → 210 | 再次 inspect 第三页，重复确认 event 184 已包含的结果 | 验证器导致的额外读取，无新增审批进展 |
| 221 → 222 | 改为包含这次 inspect 的证据后，complete_goal 成功 | 证据门槛通过 |
| 227 | conversation.finished | 会话结束，不等于整体评测通过 |

### 已确认：动作附带的快照与完成验证器不一致

事件 64、124、184 都包含完整 `pageSnapshot`，明确显示对应理赔的 approved 状态。首次 complete_goal 的证据引用的正是这些工具结果；事件 196 却返回：

> Completion requires at least one successful observation; dispatch alone does not establish the outcome.

代码解释：`src/agent/goal-completion.ts` 的 `observation()` 只检查工具名是否属于 `OBSERVATION_TOOLS` 以及调用是否成功，`click` 不在白名单；投影的 Evidence 也没有表示工具内含有效页面观察的字段。`src/chrome/tool.ts` 则已在动作后、释放调度位置之前完成页面采集。这两项契约不一致，使自动快照在决策时有用，在完成验证时却失去资格。

这不是建议把 dispatch 直接当成功。建议识别动作结果中的成功观察、其页面/文档身份及观察时序，允许引用该真实快照；采集 unavailable/pending 时继续要求补观察。当前实现让本场增加一次失败完成调用、一次重复 inspect、一次重新完成调用。

### 已确认：jobs_unknown 来自参数错误的证据契约，不能解释成仍有任务运行

事件 30 是 `AI_InvalidToolInputError`，日志中的 error 是编码的 Error（含 name/message/stack），没有普通错误对象的 `code`。它也没有 `tool.started`；报告准确记录 `unstartedFailures=1`，不是缺失了正常动作的终态。

`e2e/evaluation/job-evidence.ts` 对每个 `tool.failed` 解码后要求错误含非空字符串 `code` 和 `message`。此事件不满足 `code` 要求，会直接返回 null。相应五个浏览器任务的状态终点事件 61、88、121、148、181 全部是 succeeded；本场没有可见的 running/blocked/cancelled 终点。

因此 `jobs_unknown` 不能作为后台任务实际挂起的证据。它反映“SDK 参数拒绝”没有转成统一的已知未执行错误契约。应在参数拒绝入口记录结构化代码及明确的未派发状态，保留原始诊断，再让评测据此确认无未知副作用，而不是宽泛忽略全部失败。

### 本场未观察到的问题

没有 stale-ref 循环、重复审批、无休止 get_job 轮询、快照分页遗漏或跨域正文缺失。模型在参数错误后直接使用已有引用继续成功完成业务。不能仅凭模型第一次传错字段就断言 schema 本身错误；能够确定的设计缺陷是错误反馈契约及完成验证的观察资格。

## Binary：字节完整，文件身份被改名破坏，框架作用域造成绕路

报告事实：`classification=failed`，原因 `business_incorrect`；`businessVerified=false`、`lifecycleVerified=true`、`jobsSettled=true`。不是超时或传输中断。

| 事件 | 实际行为与观察 | 判断 |
| --- | --- | --- |
| 16 → 20 | 首次 inspect 已给出 Source/Destination 两个框架、Generate/Choose/Submit 按钮引用 | 首屏已有主要动作入口 |
| 31 → 43 | 使用 `frame: iframe` 点击 Generate；strict-mode 返回两个候选 Source、Destination | 正确拒绝歧义，未生成文件 |
| 54 → 75 | 改用现成 Generate ref；回传 Generated file 链接与 Ready | 生成成功 |
| 86 → 102 | 点击 Generated file 链接 | 启动普通下载路径；后面仍另做 artifact 导入 |
| 113 → 130 | import_file_from_link 传入 filename=`generated-file.bin`；返回 artifact 125，65,539 字节 | 显式覆盖原文件名，导致身份变化 |
| 141 → 144 | inspect region 为 heading Destination，未给 frame；返回 not-found | 跨框架语义快照与定位作用域不一致 |
| 155 → 160 | 顶层查找 input[type=file] 返回 total=0，附带快照仍能看到框架内 Choose file | 读取范围误判，不代表页面没有输入控件 |
| 171 → 187 | 点击 Choose file，之后仍通过直接 input target 上传 | 未使用 chooserId；这步未成为最终上传必需条件 |
| 198 → 214 | 使用第二个 iframe 的 hidden input 上传 artifact 125；回传所选名 generated-file.bin | 文件附加成功，改名可见 |
| 225 → 247 | 点击 Submit 一次；快照显示 Rejected | 业务拒绝，不是工具执行失败 |
| 258 → 261 | 再次 inspect，同样 Rejected | 再确认，未发现新状态 |
| 272 → 273 | 完成调用引用动作后快照，被同一 observation 白名单规则拒绝 | 与 claims 相同的契约缺陷 |
| 284 → 285 | 改为引用事件 261 的 inspect 后完成；summary 明确承认 Rejected | 验证器只验证证据存在，不判断用户业务目标实现 |
| 290 | conversation.finished | 失败业务被允许以 completed 结构结束 |

### 字节核验：未发现文本损坏

独立按 fixture 的 seed=17 生成预期字节，并对事件内 base64 解码后计算哈希：

| 数据位置 | 长度 | SHA-256 |
| --- | ---: | --- |
| fixture 独立预期 | 65,539 | `d6c452b7e92ec90e95ca825ff367ed4c67aa540ffc0628c4c5f3c92887bb6756` |
| 事件 124：artifacts.importLink 完成输出 | 65,539 | 同上 |
| 事件 125：存储的 artifact 输出 | 65,539 | 同上 |
| 事件 204：上传流程 artifacts.read 完成输出 | 65,539 | 同上 |

`src/chrome/executor.ts` 的 importLink 使用 `response.arrayBuffer()` 后转 base64，未经过 UTF-8 文本解码；`upload_file` 读取同一个 artifact 并把 base64 传入 setInputFiles。这与日志哈希一致。当前证据排除了“导入时将 blob 当文本导致损坏”，也排除了“上传前读取 artifact 时已损坏”。当前报告不包含服务端 upload 的原始摘要，无法将客户端哈希等同于接收端哈希；保留这一验证边界。

### 拒绝的充分原因：原名被不必要地覆盖

`e2e/evaluation/binary-transfer-fixture.ts` 源链接的 `download` 是 `sample-17.bin`，服务端同时检查生成次数、上传次数、名称、长度与 SHA-256。事件 113 明确把可选 filename 设为 `generated-file.bin`；事件 214 的页面观察也确认该名字。即使字节完全正确，名称不匹配就会被拒绝。

普通语义快照将源链接呈现为 `link "Generated file"`，没有展示 `download` 文件名。模型没有 read_attribute 就自行命名。工具说明允许 filename 覆盖，也说明省略时沿用 download；因此模型参数选择是直接触发原因。设计上可改进的是：在文件链接快照或导入结果中明确展示来源文件名，默认保留来源身份，让“同一文件转移”无需自行提供名称。无需为了本关添加专用规则或隐藏改名能力。

不能声称模型已诊断这个原因：最后 summary 仍说 attached that same generated file，仅承认 Rejected；日志没有名称比对诊断。

### 跨框架定位的可发现性问题

事件 20/130 的 inspect 输出横跨框架，确实包含 heading Destination；事件 144 的同名 region 查找却在未指定 frame 时 not-found。事件 160 也在顶层查找 file input 得到零个。它们不是浏览器数据缺失，而是“观察能看见、定位默认范围不同”。错误目前只报未找到 locator，没有解释该项已在某个子框架被观察到。

建议：语义项明确携带可操作的 frame 引用或定位作用域；定位失败时，在已有观察中发现跨框架同名项，可返回限定 frame 的恢复线索。仍须保留 strict-mode 和明确作用域，避免用全框架猜测点击掩盖歧义。

本场并未调用 list_frames，最后通过第二个 iframe 的 CSS 成功上传。不能推断 list_frames 工具失效；应改善当前观察到的可发现性与反馈。

### 完成机制的边界

事件 285 被接受的 completed summary 包含“submission was attempted but not accepted”。这证明当前 complete_goal 能检查引用存在和观察类别，不能校验自然语言目标已经达成。对本任务“submit once”的限制，失败后盲目重交也不正确；改进方向应允许清晰表达已完成尝试但业务失败的终态，而不是把它包装成 completed，或硬逼智能体重试。

## 修复优先级与验证要求

1. 统一观察证据：已有有效动作后快照可作为完成证据；pending/unavailable 不能。用本次 claims 事件证明不需再 inspect，仍核验三条审批和非目标项。
2. 统一参数拒绝错误：记录稳定 code 和未派发状态；使 claims 的 jobs_unknown 不再由 SDK Error 编码触发，同时未知副作用仍保留 unknown。
3. 保留文件身份：工具默认沿用源名，并在相关快照/结果明确展示来源名；binary 必须同时核验服务端名称、长度、SHA-256、生成和提交次数，不能只看页面 Submitted。
4. 明确跨框架定位范围：复现“inspect 看见 Destination，region 找不到”并提供具体框架恢复证据。不要改成不受控的跨框架匹配。
5. 区分业务失败与目标完成：Rejected 可以作为失败观察，但不应因此宣称用户目标成功。禁止为绕过该状态擅自重交。

以上为 Claims 与 Binary 的审计结论。其他场景分别记录如下。

## Frame replacement：丢失嵌入关系，拒绝后过早归因于外部依赖

结论：本场能确认语义快照缺少“父页面的哪一个 iframe 元素承载哪一个子 frameId”的显式关联，且完整快照仍如此。一次 ref 点击后业务显示 Rejected；这本身不能证明坐标错误、点击错 frame 或服务端故障。模型之后做截图是合理的布局核验，但仍没有建立外部依赖的证据便要求用户修复页面；完成器只验证 blocker 引用结构，接受了这一未经证实的归因。

数据文件：`.dev/verification/luna-baseline/events/1793527664312-17-13bea3f6-1d1e-44f2-aaa4-52235653f6bb.json`；同名报告中 `businessVerified=false`、`interactionVerified=false`、`jobsSettled=true`，整体 failed。交互判分包含整场完成条件；false 不能单独解释为某次事件不可信或没有发出点击。

| 事件 | 观察事实 | 解释边界 |
| --- | --- | --- |
| 16 → 20 | inspect 返回全部 36 项，truncated=false，baselineComplete=true；父页面有 Next、Waiting，各紧邻同名 Iframe Work item | 不是快照预算造成的缺项 |
| 20 | 两份子文档在父树结束后分别追加；frameId 为 `4C552BD1F8DD815D98BE0B7C6E9A7AA9` 与 `CF3AC3BC8BD9E67A89CDE1C305AA90AE`；两者均显示 Item 1 of 12、Confirm、Ready | 子文档内容足够，但没有公开其 owner iframe 与父页面 Next/Waiting 的关联 |
| 31 → 43 | click 指定 frame CSS iframe，strict-mode 返回两个完全同名候选 | 正确避免歧义操作；恢复提示只有通用 inspect 建议，没有可区分 owner 的线索 |
| 54 → 76 | 模型点击第一份追加子文档的 Confirm ref `t1023198979sc8553d0caee3d0e3`；工具成功返回；该子文档状态变 Rejected，父页仍 Completed 0 of 12 | 有业务拒绝，但没有请求账本具体 round/slot/token 可供本审计直接判定拒绝原因 |
| 87 → 90 | 再次 inspect，重复确认 Rejected 与 0 of 12 | 可确认未进展，但没有补足 owner 关联 |
| 101 → 114 | take_screenshot 成功，返回 PNG artifact 109、1280×577 的 screenshot 元数据及快照 | 对布局/关联歧义采取视觉核验合理，不应把截图本身标为浪费 |
| 125 → 126 | complete_goal status=blocked、dependency=external_dependency 被接受，要求用户解决首个 Next 被拒绝 | 归因未被证明；模型把自己选择的 frame 称为 Next，但前述语义观察未建立这一绑定 |

### 代码确认的缺失是输出关联，不是内部不存在 frame 信息

`src/chrome/automation.ts` 的快照采集已有 `session.frameParents`，也调用 `DOM.getFrameOwner` 取得宿主节点。但当前在这一段仅用 owner backendNodeId 查询 visibility，并将 `owners` 存为 frameId→boolean；没有将 owner AX/DOM 身份输出给模型。

同文件的快照 `render()` 在每个独立子树前添加 `iframe [frame=...]`，然后在所有 trees 上依次 render。父文档的 Iframe AX 节点使用普通 SnapshotNode 输出，未携带 childFrameId；`src/chrome/snapshot-render.ts` 的 SnapshotNode/RenderedSnapshotNode 也没有 owner/childFrame 关联字段。最终事件 20 的父节点 ID（例如 `...:ax:18`、`...:ax:5`）无法与追加子树的 frameId 通过输出字段连接。

因此可以确认：模型可见的快照丢失了已在内部获取的嵌入对应关系。不能把追加子树的枚举顺序当作父页面 iframe 的 DOM 顺序契约。修复应在父 Iframe 项上附对应 frameId/引用，或将子树准确嵌入对应 owner 项，并保留跨域、重建及同名 frame 的身份稳定性。

### Rejected 不是坐标 bug 的证明

Fixture 的 `/confirm` 根据当前 round、slot、token 和请求字段判定接受，普通错误目标也可能得到 Rejected；当前归档只有最终评分，没有独立 attempts 明细。事件只能直接证明：选用 e3 后发生拒绝、队列未进展。不能从该结果进一步声称 e3 必是 Waiting、指针落到另一框架，或页面标记 Next 本身错误。需要另取 DOM owner→frame 关联、动作命中记录以及服务端 attempts 对照才能区分。

这次只点击一次 Confirm，也未发生成功后销毁并重建双框架。因此本场失败不能用于评价第 2–12 轮的 frame replacement 引用更新能力。

### blocker 为什么被接受

事件 125 的 evidence 引用首次 inspect、成功 click 和再次 inspect；attemptedRecovery 引用 strict-mode 失败以及 take_screenshot。`src/agent/goal-completion.ts` 的 blocked 分支只核验：引用都来自本轮已终结工具、attemptedRecovery 引用存在、至少一条 evidence 属于成功 observation。schema 另要求 dependency、userAction、attemptedRecovery 存在。

成功 inspect 已满足 observation；截图也属于观察类，但此调用把截图放在 attemptedRecovery。验证器不会判断“external_dependency”是否由这些观察实际推出，不检查是否已经利用可用的 frame/DOM 查询辨别 owner，也不检验用户能做什么才能解除障碍。因此 126 成功表示 blocker 结构合格，不代表外部依赖成立。

默认提示要求缺元素、歧义和一次失败后继续恢复，不能自行视为用户依赖。此次模型的外部归因不满足这项行为要求。这里应改善的是有具体证据的恢复路径及阻塞结果语义；不能通过盲目点击另一项来碰运气，也不能为了通过任务重复提交未知操作。

### 建议验证

1. 快照将 Next/Waiting 邻近的两个父 iframe 节点分别绑定到正确 childFrameId/ref；同名子树不可仅靠枚举顺序推断。
2. 业务拒绝报告保留最小独立 attempts 明细（round、slot、accepted、可信交互），以便区分选择错误、过期数据和动作投递问题。
3. 将“已观察到拒绝，原因未明”与“经证据确认需用户解除的外部依赖”区分，审阅具体恢复路径，避免完成器的结构接受被误读为有效归因。
4. 关联修复后再用新 seed 跑满 12 轮，验证重建后的 owner/frame/ref 更新；本场不能替代此验证。

## Sequence editor：排序未完成就提交；工具缺少非法按键的明确反馈

结论：本场真实执行到提交，页面明确返回 Dispatch rejected。提交前排序仍是 `Coral, Tide, Kelp, Reef, Drift`，与用户要求 `Kelp, Tide, Drift, Reef, Coral` 不符；这是已观察到的业务错误。模型并非陷入无限工具循环：它做了六次有效相邻移动，一次错误大小写按键没有产生移动，随后过早提交。300 秒截止时，处理拒绝后的下一次模型请求尚无响应，因此整体保持 timed_out/unknown，不能据此断言模型拒绝恢复、模型最终会成功，或传输端本身故障。

事件文件：`.dev/verification/luna-baseline/events/1793527842945-17-f0861120-df54-4c9f-b3e5-62dc772612bf.json`；同名报告有 15 个启动工具及 15 个工具终态，`businessVerified=false`、`interactionVerified=false`，但因缺会话终态，`lifecycleVerified=null`、`jobsSettled=null`。后两项 unknown 不能改写为已观察到的工具终态丢失。本场也不是 setup failure；冻结套件其他首次 setup failure 不应计为工具能力失败。

### 执行链

| 事件 | 动作及顺序观察 | 审计判断 |
| --- | --- | --- |
| 16 → 21 | 初始完整观察：Coral, Reef, Drift, Tide, Kelp；嵌套框架和 Shadow DOM 内容均可读 | 快照提供了实际顺序，非缺失业务文本 |
| 32 → 86 | 在一层 iframe 选择器中 focus Kelp，40 秒超时；底层事件 79 记录 no-candidate、matches=0、attempt=672 | 选错定位深度；对静态不存在目标反复等待成本高 |
| 97 → 102 | list_frames 返回根、workspace、editor 的 parentFrameRef 链 | 正常恢复；不能说 frame 工具失效 |
| 113 → 129 | 用 editor frameRef 点击 Kelp，成功 | 已找准目标文档 |
| 140 → 158 | press_key `ARROWUP` 返回 performed=true，但顺序完全不变 | 无效键名被作为成功派发反馈，未明确提示大小写错误 |
| 169 → 187 | 改 `ArrowUp`：Coral, Reef, Drift, Kelp, Tide | 有效移动 1 |
| 198 → 216 | Kelp 再向上：Coral, Reef, Kelp, Drift, Tide | 有效移动 2 |
| 227 → 243 | 点击 Tide | press_key 本身可 target 后聚焦；这里没有新增排序进展 |
| 254 → 272 | Tide 向上：Coral, Reef, Kelp, Tide, Drift | 有效移动 3 |
| 283 → 301 | Tide 向上：Coral, Reef, Tide, Kelp, Drift | 有效移动 4 |
| 312 → 330 | Tide 向上：Coral, Tide, Reef, Kelp, Drift | 有效移动 5 |
| 341 → 359 | Kelp 向上：Coral, Tide, Kelp, Reef, Drift | 有效移动 6；仍不等于目标 |
| 370 → 384 | 填入正确的 DSP-17-A/7 | 字段填写正确，但排序前置条件未达成 |
| 395 → 411 | 勾选 Confirm dispatch | 正确设置确认状态 |
| 422 → 444 | 只点 editor 内 Send dispatch；快照明确 Dispatch rejected，排序仍错误 | 已观察到错误提交；不是点了顶层同名诱饵按钮的证据 |
| 451 | 开始拒绝后的下一次模型请求，归档结束前未取得响应 | 无后续恢复/完成声明可审 |

初始序列是目标序列的倒序，共需 10 次相邻交换才能排序完成。本场只有六次有效交换；这不靠工具计数推测，而是按每次回传快照逐项重建。七次 press_key 不能等同七次业务移动，更不能等同排序正确。

### 明确的工具反馈缺陷：ARROWUP 静默成功

`src/chrome/automation-utils.ts` 的 `KEY_ALIASES` 只归一化修饰键。`parseKeyboardChord()` 对其他名字直接保留；`keyboardParams()` 的虚拟键表只有规范形式 `ArrowUp`，未知长字符串回退为 windowsVirtualKeyCode=0，key/code 仍为 `ARROWUP`。工具 schema 对 key 只要求非空字符串。Fixture 的事件监听明确只接受 `ArrowUp`/`ArrowDown`。

事件 158 的 performed=true 只表示派发流程结束，而不表示合法的方向键移动。模型下一次改用 ArrowUp 后立刻获得预期变化，这说明它依据快照完成了键名恢复。改进应是规范常见命名或直接拒绝不支持的键名并返回合法示例，避免“未识别键名”伪装成普通成功操作。仍应保留动作后快照验证业务变化，不应把所有无业务变化的合法按键判失败。

### 排序状态没有被保持到最终提交

事件 359、384、411 都回传相同错误顺序，而用户的目标顺序在原始消息中明确存在。模型仍在 422 提交，说明缺少提交前对全部条件的有效核对。快照在这一链上正确反映了每次变化；本次不能把排序失败归咎于快照未更新或框架引用过期。

模型恢复定位后不再重复 focus 超时、没有 stale-ref 循环、没有反复全量 inspect，也没有盲目重交。可确认的额外成本是 40 秒错误作用域等待、一次无效键、两次在 targeted press_key 前的单独点击；后两次工具 press_key 已支持自动聚焦，属于可省步骤，但不能证明是业务失败的主因。

### 300 秒怎样被消耗

按 `model.request.started` 到其下一条 `model.response.received` 的时间配对，15 次已返回模型请求合计约 238.439 秒。这是客户端观察到的请求等待时间，包含服务端推理、排队及传输，不能进一步拆成纯模型计算。初次错误 focus 消耗约 40.064 秒。成功的单步工具多在不到一秒内完成。

模型输入 usage 从约 21,964 增至 58,242 tokens；每步动作后都追加完整页面快照。这个样本可以证明历史体积增长和等待占比，不能单凭相关性断言全量快照直接导致这次延迟。应在保持稳定前缀和可核验性的前提下评估增量观察/重复信息消除，不能以删掉关键顺序信息换速度。

事件 451 时间为 10:10:25.966Z；任务截止为 10:10:41.257Z。下一步只剩约 15.3 秒，报告最后 agent response status=null、complete=false。故本次超时既有先前可确认的效率损失，也有截止时未返回的请求；不能把 timed_out 单独等同工具不具备按键/Shadow DOM 能力。已有六次实际排序变化正面证明这些通路部分工作。

### 建议验证

1. 对已完整加载、定位深度错误且持续零匹配的情形提供具体 frame 恢复线索，避免 672 次静态无效轮询；对真实动态加载继续支持有界等待。
2. 非法 named key 返回明确错误，规范 ArrowUp/ArrowDown 保持真实可信键盘派发。
3. 提交前从最新观察对照目标全部顺序、reference 和确认状态；本例必须达到 Kelp, Tide, Drift, Reef, Coral 才可 Send。
4. 新运行独立保存提交账本和键盘 witness，验证完整十次必要交换及仅一次正确提交；不要只按七个 press_key 工具调用判能力通过。
5. 对 300 秒样本保留 unknown 和未完成请求事实，业务错误另记，不与 setup failure 混同。
