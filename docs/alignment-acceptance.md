# Surf Wax 需求对齐验收

`npm run verify:local` 是提交前的完整 CI 入口，要求 Node 24。它校验生成文档、live Models.dev 的 SDK 覆盖差集、类型、构建、Manifest、单测，并在 Chrome for Testing 138 和当前 Stable 分别运行全部功能 E2E 与性能检查。繁忙本地主机上的浏览器用例最多重试一次，原始失败和 flaky 状态保留在 Playwright JSON 与 trace 中；没有通过的重试不能被汇总为成功。仓库当前不配置 GitHub Actions 或自动发布；版本包只能从干净工作区手动生成。

## 运行时与日志

Assistant UI 只提供非视觉运行时和历史适配器；Thread、Message、Composer、ActionBar、BranchPicker、ThreadList 和 Markdown 视觉组件已由 Base UI、Tailwind CSS、原生 CSS 与直接 Streamdown 渲染替代。TanStack Virtual 限制长历史的挂载范围，帧级投影每个 RAF 最多发布一次最新响应；流式事件全部写入 canonical event log。完成的 Markdown 块由 Streamdown 缓存，Shiki 语言按需加载，GFM 与 KaTeX 覆盖表格、任务列表、行内及块级数学。完成的轮次、工具状态、消息操作与输入区保留稳定的投影和组件身份，正文流动只更新发生变化的部分。

所有颜色、字体、字号、间距、圆角、阴影、语法色与动效来自 `src/styles.css` 和 `src/design-tokens/interaction.css`。浏览器浅深主题自动生效，脚本编辑器使用同一套语法 Token。用户使用 Bubble，Assistant 正文占据完整可用宽度。

新会话的 `context.prompt.updated` 保存用户系统提示词、完整工具简明目录、格式与目录版本。旧会话保持用户消息目录前缀，成功摘要的 `context.compacted.prompt` 才迁移到系统格式，失败和取消不会改变格式。Checkpoint 保留分支、source/summary digest；配置修改在任务结束后生效，下一轮仍使用当前会话。所有历史、分支、摘要和提示词都可仅从日志重建，没有第二个会话持久化数据源。

模型请求、流恢复、摘要、标题及模型鉴权的可恢复错误无限重试，退避、抖动和 Retry-After 单次最多 5 秒；永久错误终止，工具失败返回模型处理。Side Panel 关闭将 Abort 传播到模型、元数据、活动与排队工具，并释放输入。每个工具调用恰有一个成功、失败或中断结果。`run` 组合程序和智能体工具循环均无总步数限制。

## SDK 协议

`scripts/check-sdk-coverage.mjs` 比较 Models.dev 当前 SDK 集合与 `MODEL_SDKS`，拒绝未登记项，并把查询时间、Provider 数量、SDK 集合和差集保存到 `.dev/verification/sdk-coverage.json`。

`src/agent/sdk-stream-contract.test.ts` 逐 SDK 验证真实增量响应：暂扣响应尾部，确认首段已经可读；再发送分段工具参数，执行工具，并验证结果回传、最终正文、凭据、可恢复请求、永久错误与 Abort。夹具使用各已安装原生 SDK 的协议 schema，覆盖 Chat Completions、Responses、Anthropic Messages、Gemini、Cohere、Bedrock 二进制 EventStream 和 AI Gateway 流。SAP 转接真实增量 SSE 的 `final_result`，不先聚合完整 JSON。Vertex 服务账号 JWT 和 token 请求通过可取消、可重试的扩展 fetch 执行。Perplexity 无工具请求保留原生搜索元数据；工具请求使用 Chat 协议，具体模型能力仍由服务端决定。

这些是本地协议契约验证，不代表已使用用户付费凭据请求每个第三方服务。扩展没有运行时中转服务，自定义 OpenAI-Compatible Endpoint 保留完整 BYOK，网页内容不脱敏、过滤或改写。

## 浏览器与输入

功能矩阵覆盖消息复制、编辑、重试、分支恢复，全部会话运行锁定，主题和 Markdown，用户脚本启动/升级恢复、超过 100 步的 `run` 组合程序，以及真实原生 Side Panel 的关闭、模型断流续接和工具结果。跨侧栏所有权检查同时存在于界面与命令入口。

页面透明覆盖层覆盖已操作标签页及 iframe。独立内容脚本在 `document_start` 同步注册捕获监听器，避免异步模块加载落后于网页监听器；构建校验拒绝异步加载器。命中测试只暂时放行覆盖层的指针命中，阻断监听器始终安装。原生动作以侧栏帧调度同步采样目标的真实几何信息，不会因 Chrome 暂停子框架 RAF 或计时器而挂起；回归覆盖子框架动画帧暂停。原生智能体输入票据绑定当前 run 与 CDP 时间戳；批量 Unicode 编辑在同一 JS 任务中完成。用户点击、键盘及粘贴无法借用票据，结束、导航和中断撤销状态。

## 120Hz 渲染 trace

性能检查使用无头 Chrome，无需 120Hz 屏幕。软件节拍每 8.33ms 请求真实 Chrome RAF，把应用回调合并到该帧；Chrome 本身完成真实布局、绘制及提交。预热至少 1 秒，测量至少 600 帧。负载同时包含逐 Token 接收、完成的代码与数学块、500 轮 canonical 历史、滚动、草稿输入和工具结果。

Chrome TimeStamp 标记确定扩展渲染进程与线程，每帧关联该线程的 JS、样式、布局、预绘制、绘制和提交 trace。标记只写入 trace，避免额外 PerformanceEntry 和 observer 工作干扰旧版 Chrome；末尾增加边界标记，使第 600 帧与后续收尾工作分别关联。合并嵌套时间区间，避免重复计时；要求 P95 工作耗时 ≤ 8.33ms、截止时间违约率 ≤ 3%，并核对至少 95% 帧有真实渲染工作、最终正文逐字一致及工具终态数量。次级墙钟 rAF 压力样本允许 P95 ≤ 34ms，以容纳繁忙本地主机的一次调度丢帧；输入事件到下一帧仍须 ≤ 50ms，100 次语义定位与动作仍须 P95 ≤ 100ms。

原始 `render-trace.json` 与 `render-report.json` 按浏览器保存于 `.dev/verification/performance/`，报告含实际浏览器版本、Node 版本、帧样本、渲染事件与完整性校验。渲染与交互基准按浏览器分别在全新 Playwright/Chrome 进程中运行；本地主机有并发负载时，性能用例最多重试三次，但每次尝试都必须独立满足原有阈值，不能合并样本或放宽门槛。`test-results/` 保留测试附件，`.dev/verification/local-ci.json` 保存完整本地 CI 各阶段状态。具体结果以本轮生成报告为准，历史 0.3.0 结果保留在 [历史验收](formalization-acceptance.md)。

## 1.0.0 发布准备结果

2026-10-15 在 macOS、Node 24.22.0 下完成发布前矩阵。生成文档、依赖新鲜度、`npm audit`、Biome、类型、构建与 Manifest 校验通过；live Models.dev 包含 230 个 Provider、8,876 个模型和 28 项 SDK 名称。29 项运行时 SDK 登记覆盖全部受支持目录项；已移除 Model API 的 `@ai-sdk/vercel` 仅作为明确的弃用排除项检查，不属于受支持 SDK。

| 验证 | 结果 |
| --- | --- |
| 单测与 SDK 增量流协议 | 55 个文件，562 项通过 |
| Chrome 138.0.7204.183 功能 E2E | 108 项通过，1 项跳过 |
| Chrome 155.0.8059.79 功能 E2E | 109 项通过 |
| 双版本性能检查 | 6 项通过 |

唯一跳过项使用旧版 CDP 不提供的 `Extensions.triggerAction` 触发扩展图标；Chrome 138 的真实 Side Panel 开启、关闭、排队调用取消及跨窗口所有权仍由独立场景验证通过。

| 浏览器 | 测量帧 | 实际渲染覆盖 | 工作 P95 门槛 | 8.33ms 截止时间违约率门槛 |
| --- | --- | --- | --- | --- |
| Chrome 138.0.7204.183 | 600 | 至少 570/600 | ≤ 8.333ms | ≤ 3% |
| Chrome 155.0.8059.79 | 600 | 至少 570/600 | ≤ 8.333ms | ≤ 3% |

两版均预热 1 秒，核对最终正文 8,842 字符逐字一致、733 条流事件及恰好一个 `trace-tool` 终态。逐帧报告记录本次实际 P95、违约帧数、浏览器版本和原始 trace SHA-256；静态文档不复制易随每次运行变化的样本值。

功能矩阵的结构化报告位于 `.dev/verification/e2e-results.json`，逐帧报告与原始 trace 位于 `.dev/verification/performance/`。最终打包只接受 `.dev/verification/local-ci.json` 中 `success: true`、Node 24、版本和当前 Git 提交完全匹配的证据；修改提交后必须重跑。大型原始 trace 保存在本地，不加入扩展包或 Git。
