# 真实模型评测

`npm run eval:real-model` 使用隔离的 Chrome 配置和扩展实际运行浏览器任务。默认任务为跨域 iframe 订单；设置 `SURFWAX_EVAL_SCENARIO=claims-queue` 可运行另一项跨页理赔筛选任务，涉及金额边界、相似记录、重复使用的表格 DOM 和逐条审批。模型自主选择工具；测试根据独立本机服务保存的业务记录判分，不依赖模型声称成功或页面中的变量。服务只追加操作记录，没有读取或清除记录的 HTTP 接口。工具仍可直接发送请求，因此结果证明服务收到预期业务请求，不能证明一定通过真实 UI 点击，也不是防恶意绕过的评测。这些任务是起点，单次通过不代表复杂任务整体能力。

另有三个侧重操作能力的关卡：`sequence-editor` 要求在嵌套跨域框架的 Shadow DOM 中用键盘重排至少七次，并填写和提交表单；`dispatch-review` 要求打开跨域框架中的新窗口，读取窗口中的信息并处理原生提示框；`dossier-upload` 要求取得两份文件，包括超过 32 KiB 的非 UTF-8 二进制文件，然后通过文件选择器原样提交。任务规则刻意保持简单。每个种子生成不同数据，独立账本会记录错误或重复提交，最终状态正确并不能抵消之前的误操作。报告中的 `toolNames` 记录实际发起的工具名称和次数，但调用工具本身不能证明任务通过特定路径完成。`e2e/dispatch-tools.spec.ts` 和 `e2e/upload-tools.spec.ts` 是脚本化工具通路检查，不是模型能力或成功率评测。上传脚本在观察到下载后通过 URL 重新获取文件字节；不能据此认为扩展能读取 Chrome 下载文件的字节。

`sequence-editor` 的业务判分和 `interactionVerified` 分开记录；后者重放页面报告的可信键盘事件和提交事件。它能发现直接提交或普通合成事件等常见绕过，但页面发送的证据仍可被刻意伪造，不是防作弊机制。该关要求业务结果和交互证据均通过；其他关卡的交互证据为 null。Playwright 对话框自动关闭已被禁用，以便扩展处理实际提示框。

运行前显式设置 `SURFWAX_REAL_MODEL_EVAL=1`、`SURFWAX_EVAL_PROVIDER`（报告中的提供商名称）、`SURFWAX_EVAL_MODEL`、`SURFWAX_EVAL_BASE_URL` 和 `SURFWAX_EVAL_API_KEY`。当前入口支持 OpenAI Chat Completions 兼容协议；Base URL 应包含服务要求的前缀，例如 `https://provider.example/v1`。可选设置 `SURFWAX_EVAL_SEED`（0–999999，默认 17）和 `SURFWAX_EVAL_TIMEOUT_MS`（默认 600000）。运行会请求所配置的服务并可能产生费用，不设置 opt-in 时不会请求模型；CI 不应设置 opt-in。

评测通过带随机令牌的本机回环代理转发请求，仅在内存中使用提供的凭据，不把凭据放入扩展配置或报告。代理不跟随重定向。评测关闭 Playwright trace、截图和录像；扩展的 canonical event log 保持原样。关闭浏览器前，评测等待上下文中所有页面和弹窗发往 fixture 的已观察请求结束并保持短暂静默；`networkSettled` 为 false 时不判通过。此检查不能预测未来定时器或保证观察到浏览器上下文之外发出的请求。报告写入被 git 忽略的 `.dev/verification/model-evals/`，包括失败运行、版本、独立业务判分、工具终态、各请求和智能体模型步骤实际返回的 usage（未返回的字段为 null）、请求字节数、工具 schema 哈希和相邻智能体请求的消息前缀比较。辅助请求单独标识；可能存在任务完成时仍未结束的辅助请求。请求字节不是 token，usage 不是费用；报告不假设价格或把缺失的 usage 记为零。schema 稳定与消息前缀稳定也不保证服务商缓存命中。任务超时是评测时限，不是对智能体工具步数的限制。

先启动 `npm run dev` 并保持开发服务器运行，再在安全地向当前 shell 注入上述变量后执行 `npm run eval:real-model`。请勿把密钥放入命令行参数或提交到仓库。使用 `npm test -- src/evaluation/model-proxy.test.ts` 可以在不设置密钥、不访问外部服务的情况下验证代理和证据契约。
