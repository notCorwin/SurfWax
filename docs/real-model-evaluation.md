# 真实模型评测

`npm run eval:real-model` 使用隔离的 Chrome 配置和扩展实际运行浏览器任务。默认任务为跨域 iframe 订单；设置 `SURFWAX_EVAL_SCENARIO=claims-queue` 可运行另一项跨页理赔筛选任务，涉及金额边界、相似记录、重复使用的表格 DOM 和逐条审批。模型自主选择工具；测试根据独立本机服务保存的业务记录判分，不依赖模型声称成功或页面中的变量。服务只追加操作记录，没有读取或清除记录的 HTTP 接口。工具仍可直接发送请求，因此结果证明服务收到预期业务请求，不能证明一定通过真实 UI 点击，也不是防恶意绕过的评测。这些任务是起点，单次通过不代表复杂任务整体能力。

另有十三个侧重操作能力的关卡：`sequence-editor` 要求在嵌套跨域框架的 Shadow DOM 中用键盘重排至少七次；`dispatch-review` 要求打开新窗口并处理原生提示框；`dossier-upload` 要求取得两份文件，包括超过 32 KiB 的非 UTF-8 二进制文件，再原样提交；`pointer-drag` 要求在跨域框架的内层滚动区域中，将指定对象拖到离屏目标；`uncertain-write` 要求在服务端已提交但响应被截断后核验状态，且不能重复提交；`window-transfer` 要求在两个外观相似的跨源窗口间传递数据；`long-manifest` 要求按顺序收集跨域页面中 20 页共 1,200 条包含多字节字符的记录并完整提交；`rolling-queue` 要求在五个不断复用的行中，连续准确处理 30 个标记为 Next 的任务；`chooser-prompt` 要求在正确的跨域框架选择文件，并处理文件变更立即触发的原生提示框；`network-identity` 要求对应六个同一 URL 的并发请求及乱序响应，包括跨域框架中的请求，再按名称提交各自的响应码；`userscript-repair` 要求修复并启用预置用户脚本，在跨域框架的八个不同文档中依次执行，同时保留另一个相似脚本；`frame-replacement` 要求连续处理 12 轮任务，每轮都会销毁并重建两个同名跨域框架，目标由页面标记为 Next；`binary-transfer` 要求将源框架内生成的 65,539 字节非 UTF-8 文件原样传到目标框架并提交，源文件没有普通 HTTP 下载地址。任务规则刻意保持简单。每个种子生成不同数据，独立账本会记录错误或重复操作，最终状态正确并不能抵消之前的误操作。长数据关卡逐页提供内容并复用 DOM；页面请求记录本身不能证明通过 UI 阅读。报告中的 `toolNames` 记录实际发起的工具名称和次数，但调用工具本身不能证明任务通过特定路径完成。用户脚本关卡检查 Chrome 原生注册、扩展持久化状态以及服务端回执；会话正常结束且已知浏览器任务均终止后，评测器还在全新跨域文档中检查脚本是否处理随机值。验证文档无法访问或任务状态未知时执行证据为 unknown；新文档加载后 3 秒内没有期望结果时记为 false，这个时限可能受极端浏览器负载影响。报告分别记录账本、后台任务和脚本执行证据；套件汇总会检查这些证据与结果是否一致，缺少新证据的旧用户脚本报告不能用于当前汇总。该验证提高了对空脚本和页面直接赋值的辨别力，但并非防对抗隔离。该关卡在隔离配置中启用 Chrome 的 Allow User Scripts。二进制关卡由服务端核对长度和 SHA-256；生成回执及上传仍可通过直接请求伪造，不能用作防作弊证明。脚本化工具通路检查不调用真实模型，也不是模型成功率评测。上传脚本在观察到下载后通过 URL 重新获取文件字节；不能据此认为扩展能读取 Chrome 下载文件的字节。文件来源响应的完成仅表示服务端已将字节交给操作系统。

`sequence-editor`、`pointer-drag`、`rolling-queue` 和 `frame-replacement` 的业务判分和 `interactionVerified` 分开记录；后者根据页面报告的可信键盘或指针事件检查操作。它能发现直接提交或普通合成事件等常见绕过，但页面发送的证据仍可被刻意伪造，不是防作弊机制。这四关要求业务结果和交互证据均通过；其他关卡的交互证据不适用。Playwright 对话框自动关闭已被禁用，以便扩展处理实际提示框。评测还要求至少执行一个工具，每个已启动工具恰有一个终态，且助手消息中声明的每个工具调用均有终态；消息证据不完整时生命周期结果为 unknown；没有启动记录的失败终态会单独计数，因为参数非法的调用也会产生这种记录，无法仅凭终态区分丢失的启动日志。报告中的 `completedProgramOperations` 汇总已完成的程序操作名称，不包含参数；它提供比工具名称更细的执行证据，但不代替业务判分。

`SURFWAX_CAPABILITY_PROBES=1 npx playwright test e2e/capability-probes.spec.ts --retries=0` 可显式运行已知困难工具路径的脚本化探针。探针覆盖连续监听第二个弹窗事件、点击跨域框架深处离屏目标，以及框架重建后点击纵向排列的下方跨域框架；默认测试会跳过它们，显式运行时按期望行为判定成功或失败。正常多窗口关卡的脚本通路使用窗口列表定位第二个窗口；长清单关卡将分页控件放在可见区域。这些探针不调用真实模型。

已有扩展构建时，可通过以下命令在本机运行二进制转移和用户脚本的实际扩展通路，包含有效脚本与空脚本绕过两种结果。测试使用本地模拟服务提供固定工具调用，无需真实 LLM 或 API 密钥：

```sh
npx playwright test e2e/real-model-harness.spec.ts -g 'local scripted binary-transfer|local scripted userscript-repair|a no-op registered script' --retries=0
```

在本机复现中，第二个窗口的 `tabs.onCreated.openerTabId` 指向当时激活的第一个弹窗，而 CDP `Target.targetCreated` 的 opener 仍指向实际发起页面；仅以前者匹配原标签会漏掉事件。该观察需要在修复时结合并发窗口、跨域和生命周期竞态验证，不能用第一个新标签作为通用关联依据。

离屏目标探针中，子文档的命中检查找到了按钮，但 OOPIF 子 session 的 `DOM.getNodeForLocation` 在对应坐标返回找不到节点，导致动作反复判为被遮挡。具体坐标和裁剪语义仍需验证；修复时需保留跨框架遮挡检查。框架重建关卡的纵向排列对照中，前两次服务端确认成功，第三次工具动作后没有确认；并排布局可完成同样的 12 轮。这个对照显示行为与布局有关，尚不能确定底层原因，纵向对照保留为显式探针。

运行前显式设置 `SURFWAX_REAL_MODEL_EVAL=1`、`SURFWAX_EVAL_PROVIDER`（报告中的提供商名称）、`SURFWAX_EVAL_MODEL`、`SURFWAX_EVAL_BASE_URL` 和 `SURFWAX_EVAL_API_KEY`。当前入口支持 OpenAI Chat Completions 兼容协议；Base URL 应包含服务要求的前缀，例如 `https://provider.example/v1`。可选设置 `SURFWAX_EVAL_SEED`（0–999999，默认 17）和 `SURFWAX_EVAL_TIMEOUT_MS`（任务时间，默认 600000 毫秒；配置和收尾另留时间）。运行会请求所配置的服务并可能产生费用，不设置 opt-in 时不会请求模型；CI 不应设置 opt-in。

评测通过带随机令牌的本机回环代理转发请求，仅在内存中使用提供的凭据，不把凭据放入扩展配置或报告。代理不跟随重定向，并在下游取消时中止上游请求。评测关闭 Playwright trace、截图和录像；扩展的 canonical event log 保持原样。关闭浏览器前，评测要求浏览器上下文与 fixture 服务端的已观察请求同时结束并保持短暂静默，服务端跟踪也覆盖 Playwright 不上报的下载；`networkSettled` 为 false 时不判通过。历史中断单独记录，不会自动阻止当前静默；该检查不能预测未来定时器，也不能证明服务端响应已被浏览器完整接收。报告默认写入被 git 忽略的 `.dev/verification/model-evals/`，可用 `SURFWAX_EVAL_REPORT_DIR` 指定目录；报告包括失败运行、版本、独立业务判分、工具终态、各请求和智能体模型步骤实际返回的 usage（未返回的字段为 null）、请求字节数、工具 schema 哈希和相邻智能体请求的消息前缀比较。辅助请求单独标识；可能存在任务完成时仍未结束的辅助请求。请求字节不是 token，usage 不是费用；报告不假设价格或把缺失的 usage 记为零。schema 稳定与消息前缀稳定也不保证服务商缓存命中。任务超时是评测时限，不是对智能体工具步数的限制。

报告将 `classification` 记为 `passed`、`failed` 或 `unknown`，并列出原因。网络未结算或账本未排空时业务结果为 null；未获得完整终态日志时工具生命周期结果为 null，而不是假定失败。`interactionApplicable` 区分不适用与适用但未知。会话失败、取消或超时均分类为 unknown：它们可能由服务商或传输故障引起，不能仅凭未完成的账本归因于工具能力。报告保留最后一个智能体请求的状态和传输是否完成，但未完成也可能由下游取消引起；汇总会核对该字段与请求快照，缺少此字段的旧报告不能用于当前汇总。超时单独标记为 `timed_out`；做有预先约定的统计时可将超时计为任务失败，但不能将未知的业务或日志证据改写为已观察到的错误。

先启动 `npm run dev` 并保持开发服务器运行，再在安全地向当前 shell 注入上述变量后执行 `npm run eval:real-model`。请勿把密钥放入命令行参数或提交到仓库。使用 `npm test -- src/evaluation/model-proxy.test.ts` 可以在不设置密钥、不访问外部服务的情况下验证代理和证据契约。


固定样本套件可以在运行前冻结计划，保留未取得报告的样本，避免只统计成功保存的运行。以下命令只读写本地文件，不调用模型：

```json
{
  "version": 1,
  "provider": "example",
  "model": "example-model",
  "scenarios": ["cross-frame-order", "network-identity"],
  "seeds": [17, 23],
  "repeats": 2,
  "timeoutMs": 600000
}
```

将计划保存为 `plan.json`，执行 `npm run eval:suite -- freeze plan.json manifest.json`。清单列出每个样本的 `id`、`scenario`、`seed` 和 `repeat`，以及整体 `planHash`。逐个运行样本时，将 `SURFWAX_EVAL_SUITE_PLAN_HASH`、`SURFWAX_EVAL_SUITE_SAMPLE_ID` 和 `SURFWAX_EVAL_SUITE_REPEAT` 分别设为清单中的 `planHash`、样本 `id` 和 `repeat`；同时设置匹配计划的 provider、model、scenario、seed 和 timeout，以及上述运行所需的凭据和 opt-in。把这些运行的报告放在一个只含 JSON 报告的目录中，执行 `npm run eval:suite -- aggregate manifest.json reports summary.json`。清单和汇总文件不会覆盖已有文件。套件执行本身仍需手动启动每个样本；仅创建清单不会发起付费调用。汇总会拒绝身份不匹配、重复、额外或证据自相矛盾的报告，将缺失样本保留为 unknown，并分别统计超时和缺失。重复运行同一种子并非独立任务。清单身份是归档和防误配机制，并非防篡改签名。

单次报告记录任务起止时限和当前运行的终态事件时间，以持久化终态而非轮询发现的时刻判断是否超时；缺少或冲突的时间证据为 unknown。报告还记录扩展目录构建哈希、评测源码哈希、运行前后哈希是否一致、锁文件哈希和浏览器版本。评测源码哈希覆盖 `e2e/evaluation` 下非测试 TypeScript 文件、评测入口、`e2e/fixtures.ts`、Playwright 配置及日志解码依赖 `src/logging.ts`、`src/log-graph.ts`、`src/artifact-graph.ts`。汇总的 `environment.comparable` 只比较这些扩展构建、评测源码、锁文件和浏览器证据：不同或不稳定为 false，缺少信息为 null，一致且至少两个样本为 true；它不表示实验具有统计可比性。哈希描述的是两次读取时的磁盘内容；模块可能在首次计算哈希前已加载，不能证明运行时代码与磁盘一致，前后哈希一致也不能排除运行中临时修改后还原。上述范围不包括 Node、操作系统或实际安装依赖，锁文件哈希不能证明实际安装的依赖一致。未进行真实模型样本运行时，这些关卡和脚本化通路不能说明模型成功率或关卡难度已经校准。
