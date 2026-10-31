# 真实模型评测

`npm run eval:real-model` 使用隔离的 Chrome 配置和扩展实际运行浏览器任务。默认任务为跨域 iframe 订单；设置 `SURFWAX_EVAL_SCENARIO=claims-queue` 可运行另一项跨页理赔筛选任务，涉及金额边界、相似记录、重复使用的表格 DOM 和逐条审批。模型自主选择工具；测试根据独立本机服务保存的业务记录判分，不依赖模型声称成功或页面中的变量。服务只追加操作记录，没有读取或清除记录的 HTTP 接口。工具仍可直接发送请求，因此结果证明服务收到预期业务请求，不能证明一定通过真实 UI 点击，也不是防恶意绕过的评测。这些任务是起点，单次通过不代表复杂任务整体能力。

另有两个侧重操作能力的关卡：`sequence-editor` 要求在嵌套跨域框架的 Shadow DOM 中用键盘重排节点，并填写和提交表单；`dispatch-review` 要求打开跨域框架中的新窗口，读取窗口中的信息并处理原生提示框。任务规则刻意保持简单。每个种子生成不同数据，独立账本会记录错误或重复提交，最终状态正确并不能抵消之前的误操作。报告中的 `toolNames` 记录实际发起的工具名称和次数，但调用工具本身不能证明任务通过特定路径完成。`e2e/dispatch-tools.spec.ts` 是脚本化工具通路检查，不是模型能力或成功率评测。

当前脚本化通路已验证 `sequence-editor`；`dispatch-review` 的弹窗内原生提示框通路尚未打通，对应回归暂标为 fixme。浏览器 fixture 自身可完成该任务，但这不代表扩展工具已具备完整通关能力。

运行前显式设置 `SURFWAX_REAL_MODEL_EVAL=1`、`SURFWAX_EVAL_PROVIDER`（报告中的提供商名称）、`SURFWAX_EVAL_MODEL`、`SURFWAX_EVAL_BASE_URL` 和 `SURFWAX_EVAL_API_KEY`。当前入口支持 OpenAI Chat Completions 兼容协议；Base URL 应包含服务要求的前缀，例如 `https://provider.example/v1`。可选设置 `SURFWAX_EVAL_SEED`（0–999999，默认 17）和 `SURFWAX_EVAL_TIMEOUT_MS`（默认 600000）。运行会请求所配置的服务并可能产生费用，不设置 opt-in 时不会请求模型；CI 不应设置 opt-in。

评测通过带随机令牌的本机回环代理转发请求，仅在内存中使用提供的凭据，不把凭据放入扩展配置或报告。代理不跟随重定向。评测关闭 Playwright trace、截图和录像；扩展的 canonical event log 保持原样。报告写入被 git 忽略的 `.dev/verification/model-evals/`，包括失败运行、版本、独立业务判分、工具终态、各请求和智能体模型步骤实际返回的 usage（未返回的字段为 null）、请求字节数、工具 schema 哈希和相邻智能体请求的消息前缀比较。辅助请求单独标识；可能存在任务完成时仍未结束的辅助请求。请求字节不是 token，usage 不是费用；报告不假设价格或把缺失的 usage 记为零。schema 稳定与消息前缀稳定也不保证服务商缓存命中。任务超时是评测时限，不是对智能体工具步数的限制。

先启动 `npm run dev` 并保持开发服务器运行，再在安全地向当前 shell 注入上述变量后执行 `npm run eval:real-model`。请勿把密钥放入命令行参数或提交到仓库。使用 `npm test -- src/evaluation/model-proxy.test.ts` 可以在不设置密钥、不访问外部服务的情况下验证代理和证据契约。
