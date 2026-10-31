# 真实模型评测

`npm run eval:real-model` 使用隔离的 Chrome 配置和扩展实际运行浏览器任务。默认任务为跨域 iframe 订单；设置 `SURFWAX_EVAL_SCENARIO=claims-queue` 可运行另一项跨页理赔筛选任务，涉及金额边界、相似记录、重复使用的表格 DOM 和逐条审批。模型自主选择工具；测试根据独立本机服务保存的业务记录判分，不依赖模型声称成功或页面中的变量。服务只追加操作记录，没有读取或清除记录的 HTTP 接口。工具仍可直接发送请求，因此结果证明服务收到预期业务请求，不能证明一定通过真实 UI 点击，也不是防恶意绕过的评测。这些任务是起点，单次通过不代表复杂任务整体能力。

另有七个侧重操作能力的关卡：`sequence-editor` 要求在嵌套跨域框架的 Shadow DOM 中用键盘重排至少七次；`dispatch-review` 要求打开新窗口并处理原生提示框；`dossier-upload` 要求取得两份文件，包括超过 32 KiB 的非 UTF-8 二进制文件，再原样提交；`pointer-drag` 要求在跨域框架的内层滚动区域中，将指定对象拖到离屏目标；`uncertain-write` 要求在服务端已提交但响应被截断后核验状态，且不能重复提交；`window-transfer` 要求在两个外观相似的跨源窗口间传递数据；`long-manifest` 要求按顺序收集跨域页面中 20 页共 1,200 条包含多字节字符的记录并完整提交。任务规则刻意保持简单。每个种子生成不同数据，独立账本会记录错误或重复操作，最终状态正确并不能抵消之前的误操作。长数据关卡逐页提供内容并复用 DOM；页面请求记录本身不能证明通过 UI 阅读。报告中的 `toolNames` 记录实际发起的工具名称和次数，但调用工具本身不能证明任务通过特定路径完成。脚本化工具通路检查不是模型能力或成功率评测。上传脚本在观察到下载后通过 URL 重新获取文件字节；不能据此认为扩展能读取 Chrome 下载文件的字节。文件来源响应的完成仅表示服务端已将字节交给操作系统。

`sequence-editor` 和 `pointer-drag` 的业务判分和 `interactionVerified` 分开记录；后者根据页面报告的可信键盘或指针事件检查操作。它能发现直接提交或普通合成事件等常见绕过，但页面发送的证据仍可被刻意伪造，不是防作弊机制。这两关要求业务结果和交互证据均通过；其他关卡的交互证据为 null。Playwright 对话框自动关闭已被禁用，以便扩展处理实际提示框。评测还要求至少执行一个工具，且每个已启动工具恰有一个终态；没有启动记录的失败终态会单独计数，因为参数非法的调用也会产生这种记录，无法仅凭终态区分丢失的启动日志。报告中的 `completedProgramOperations` 汇总已完成的程序操作名称，不包含参数；它提供比工具名称更细的执行证据，但不代替业务判分。

`SURFWAX_CAPABILITY_PROBES=1 npx playwright test e2e/capability-probes.spec.ts --retries=0` 可显式运行已知困难工具路径的脚本化探针。当前这两个探针分别复现连续监听第二个弹窗事件和点击跨域框架深处离屏目标时的超时；默认测试会跳过它们，显式运行时按期望行为判定成功或失败。正常多窗口关卡的脚本通路使用窗口列表定位第二个窗口；长清单关卡将分页控件放在可见区域。这些探针不调用真实模型。

在本机复现中，第二个窗口的 `tabs.onCreated.openerTabId` 指向当时激活的第一个弹窗，而 CDP `Target.targetCreated` 的 opener 仍指向实际发起页面；仅以前者匹配原标签会漏掉事件。该观察需要在修复时结合并发窗口、跨域和生命周期竞态验证，不能用第一个新标签作为通用关联依据。

离屏目标探针中，子文档的命中检查找到了按钮，但 OOPIF 子 session 的 `DOM.getNodeForLocation` 在对应坐标返回找不到节点，导致动作反复判为被遮挡。具体坐标和裁剪语义仍需验证；修复时需保留跨框架遮挡检查。

运行前显式设置 `SURFWAX_REAL_MODEL_EVAL=1`、`SURFWAX_EVAL_PROVIDER`（报告中的提供商名称）、`SURFWAX_EVAL_MODEL`、`SURFWAX_EVAL_BASE_URL` 和 `SURFWAX_EVAL_API_KEY`。当前入口支持 OpenAI Chat Completions 兼容协议；Base URL 应包含服务要求的前缀，例如 `https://provider.example/v1`。可选设置 `SURFWAX_EVAL_SEED`（0–999999，默认 17）和 `SURFWAX_EVAL_TIMEOUT_MS`（默认 600000）。运行会请求所配置的服务并可能产生费用，不设置 opt-in 时不会请求模型；CI 不应设置 opt-in。

评测通过带随机令牌的本机回环代理转发请求，仅在内存中使用提供的凭据，不把凭据放入扩展配置或报告。代理不跟随重定向，并在下游取消时中止上游请求。评测关闭 Playwright trace、截图和录像；扩展的 canonical event log 保持原样。关闭浏览器前，评测要求浏览器上下文与 fixture 服务端的已观察请求同时结束并保持短暂静默，服务端跟踪也覆盖 Playwright 不上报的下载；`networkSettled` 为 false 时不判通过。历史中断单独记录，不会自动阻止当前静默；该检查不能预测未来定时器，也不能证明服务端响应已被浏览器完整接收。报告默认写入被 git 忽略的 `.dev/verification/model-evals/`，可用 `SURFWAX_EVAL_REPORT_DIR` 指定目录；报告包括失败运行、版本、独立业务判分、工具终态、各请求和智能体模型步骤实际返回的 usage（未返回的字段为 null）、请求字节数、工具 schema 哈希和相邻智能体请求的消息前缀比较。辅助请求单独标识；可能存在任务完成时仍未结束的辅助请求。请求字节不是 token，usage 不是费用；报告不假设价格或把缺失的 usage 记为零。schema 稳定与消息前缀稳定也不保证服务商缓存命中。任务超时是评测时限，不是对智能体工具步数的限制。

先启动 `npm run dev` 并保持开发服务器运行，再在安全地向当前 shell 注入上述变量后执行 `npm run eval:real-model`。请勿把密钥放入命令行参数或提交到仓库。使用 `npm test -- src/evaluation/model-proxy.test.ts` 可以在不设置密钥、不访问外部服务的情况下验证代理和证据契约。
