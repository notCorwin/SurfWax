# Surf Wax 0.3.0 正式化验收记录

记录日期：2026-09-30。此文档记录八个工程史诗的实现与验收证据。自动验证针对下表中的候选 ZIP；Chrome 原生首次下载授权气泡与商店素材核对仍需人工完成，Chrome Web Store 尚未发布。

发布版本来自 `package.json`。最终验证应针对同一提交、同一构建产物；修改源码后需要更新相关结果，不能沿用旧构建的通过记录。

## 八个史诗的实现清单

| 史诗 | 已落盘的实现 | 主要证据与验收范围 |
| --- | --- | --- |
| 1. 权限与产品功能逐项对应 | 必需权限限定为 debugger、scripting、sidePanel、storage、tabs、unlimitedStorage、userScripts；保留 `<all_urls>`。downloads 改为可选权限，明确保存时显示“授权并保存”，产物先进入会话日志。移除 devtools/offscreen Manifest 入口、HTML、host 与 capabilities。 | [Manifest](../manifests/store.json)、[下载授权](../src/chrome/downloads.ts)、[下载 UI](../src/sidepanel/DownloadAuthorization.tsx)、[产物校验](../scripts/validate-build.mjs)、[发布测试](../e2e/release.spec.ts)。下载原生气泡仍待人工验证，见下文。 |
| 2. 工具收敛与 Registry | 80 个工具收敛到 49 个独立工具；保留 act、画布所需的 keydown/keyup/mousemove/mousedown/mouseup、七个只读诊断工具和五个用户脚本工具。schema、描述、摘要目录及生成文档来自同一 registry；act 保持按操作类型约束必填字段的联合 schema，tabId 保持显式目标选择能力。 | [工具源与 Registry](../src/chrome/tool.ts)、[工具契约测试](../src/chrome/tool.test.ts)、[生成器](../scripts/generate-tool-docs.mjs)、[工具参考](../Playwright-Tools.md)、[预算测量](../scripts/measure-tool-budget.mjs)。数量、字节与 BPE 结果分别记录，不能互相替代。 |
| 3. 统一运行所有权、取消与恢复 | background 仲裁跨侧栏运行，使用 runId/ownerId/generation 与真实 Port 约束所有权。绑定本轮窗口和目标标签页，切换浏览器焦点不会重定向工具；显式 tab-select 可以切换目标。关闭 owner、中断任务、清空日志会取消请求及排队操作，并清理页面防干扰与输入状态。worker 启动时先清理遗留 guard、从 canonical input state 释放遗留按键/鼠标、补齐悬挂运行，再允许新 owner；成功释放后保存空状态，失败保留恢复证据。 | [后台仲裁](../src/agent/background-coordinator.ts)、[协调器](../src/agent/coordinator.ts)、[后台生命周期](../src/background.ts)、[原生侧栏 E2E](../e2e/lifecycle.spec.ts)、[真实 Worker 重启](../e2e/maintenance.spec.ts)。 |
| 4. Canonical Tool Log | 对话、分支、工具结果、产物、重试和中断均从 append-only event log 恢复；没有第二份持久化运行真相。终态写入跨 writer 串行化，按 run/phase/toolCallId 去重；失败与中断补 Tool Result。清空日志使用 writer handshake、维护代际与待执行操作屏障，避免旧 writer 把数据写回。大型结果和产物使用稳定日志 ID，result 支持精确读取。 | [日志实现](../src/logging.ts)、[日志契约测试](../src/logging.test.ts)、[会话与分支](../src/conversations.ts)、[恢复测试](../e2e/conversations.spec.ts)。终态记录幂等不等于外部副作用具备 exactly-once 保证。 |
| 5. 可靠请求与自动压缩 | 可恢复错误无限重试，退避单次不超过 10 秒，停止可中断退避。SSE 断流从持久化部分文本和工具结果续接，工具调用按请求 phase 区分。剩余容量不足 20% 或 Provider 拒绝超长上下文时自动摘要；保留分支/source/summary digest，超长源先分块再合并。失败保留原历史并提供重试，取消不写半成品 checkpoint；旧手动 gate 自动迁移。未匹配模型窗口使用 256K，首条用户消息的工具目录前缀按其持久化版本恢复。 | [请求与流恢复](../src/agent/model.ts)、[SSE 恢复](../src/agent/stream-recovery.ts)、[自动压缩](../src/agent/context-choice.ts)、[压缩契约](../src/agent/compaction.ts)、[工具目录前缀](../src/agent/tool-catalog.ts)、[上下文 E2E](../e2e/context.spec.ts)。真实断流与副作用未重放由原生侧栏用例验证。 |
| 6. 浏览器操作语义 | 专用命令、act 与 run-code 的 page facade 共用浏览器执行层。按操作检查可见、稳定、启用、可编辑与接收输入条件；严格唯一匹配，ref 节点失效明确报错。支持跨源 iframe、open Shadow DOM、隐藏 file input/filechooser、组合键及跨命令保留输入状态。截图/PDF 默认是内部产物，坐标按观察信息映射；act 部分失败保留已完成步骤。 | [共享自动化](../src/chrome/automation.ts)、[执行器](../src/chrome/executor.ts)、[自动化 E2E](../e2e/automation.spec.ts)、[page facade 等待约定](../Playwright-Tools.md)。DPR=2、框架与输入场景必须以最终矩阵实测为准。 |
| 7. 只读诊断、性能与 UX | 保留请求列表/详情、请求头/body、响应头/body与 console。诊断内存缓存设上限，原始 CDP 事件保留在日志，查询支持分页并从日志补读。UI 按 animation frame 合并流式更新，保留完整 GFM、LaTeX 与语法高亮；长会话虚拟化，工具结果展开时加载，完整错误仍可查看。会话编辑、分支、归档、搜索与运行中切换约束保留。 | [只读诊断](../src/chrome/diagnostics.ts)、[诊断测试](../src/chrome/diagnostics.test.ts)、[渲染 E2E](../e2e/rendering.spec.ts)、[本地性能测试](../e2e/performance.spec.ts)。本地固定环境测量见下表与 performance-results.json。 |
| 8. 可维护升级发布 | package.json 为版本唯一来源；lockfile、Manifest、七权限、入口与移除 host 均由构建验证，主入口 JS 上限为 2,000,000B。E2E 按域拆分并共享夹具，失败保留 profile；真实 0.2.0 fixture 验证升级配置、日志 ID 与用户脚本启停状态。CI 验证 Chrome 138/current 功能矩阵；性能仅本地。本地版本包同 SHA 可复用、不同 SHA 拒绝覆盖并原子发布；正式 v* 发布不覆盖，ZIP 有 SHA-256；autobuild 经验证后更新固定测试渠道资产，标记 prerelease 且不占 Latest。 | [构建与版本校验](../scripts/validate-build.mjs)、[历史升级 fixture](../scripts/prepare-upgrade-fixture.mjs)、[发布工作流](../.github/workflows/autobuild.yml)、[ZIP 打包](../scripts/package-release.mjs)、[商店材料](store-listing.md)、[隐私政策](../PRIVACY.md)、[更新记录](../CHANGELOG.md)。CI 浏览器门禁直接安装 verify 已打包且经 checksum 校验的 ZIP，不重新构建；工作流配置不代表正式发布或商店审核已经完成。 |

## 工具输入预算的实际测量

基线为 0.2.0 的 80 个工具，当前为 0.3.0 的 49 个工具。报告来源是 `scripts/measure-tool-budget.mjs` 生成的 [tool-budget.json](tool-budget.json)。定义按 registry 顺序序列化 `{ name, description, inputSchema: z.toJSONSchema(...) }`；目录测量原始 `TOOL_SUMMARY`。此处不包含 Provider 请求封装、系统提示、用户消息或网页结果。

| 指标 | 80 工具基线 | 49 工具当前 | 减少量 |
| --- | ---: | ---: | ---: |
| 独立工具数 | 80 | 49 | 31 |
| 定义 JSON，UTF-8 字节 | 63,544 | 46,022 | 17,522（27.6%） |
| 摘要目录，UTF-8 字节 | 5,983 | 2,946 | 3,037（50.8%） |
| 定义，cl100k_base BPE token | 15,033 | 11,048 | 3,985 |
| 摘要目录，cl100k_base BPE token | 1,246 | 645 | 601 |
| 定义，o200k_base BPE token | 15,569 | 11,429 | 4,140 |
| 摘要目录，o200k_base BPE token | 1,257 | 647 | 610 |

固定 BPE 编码用于可复现的输入比较，**不是 Provider 计费 usage**。实际 Provider 可能采用不同 tokenizer、schema 转换与缓存规则；输入、输出和缓存 usage 应读取真实响应。工具数量减少 38.75%，不能据此声称实际请求 token 或费用也下降 38.75%。回归预算分别为定义不超过 50,500B、目录不超过 4,100B。

## 下载授权的验证边界

`e2e/release.spec.ts` 使用真实扩展、真实内部产物、真实 Side Panel UI 点击和真实智能体调用，但在 Chrome API 边界模拟权限行为：

| 场景 | 已覆盖的行为 | 模拟边界 |
| --- | --- | --- |
| 初次明确保存、允许 | 显示授权组件；点击“授权并保存”；获准后进入一次保存路径 | permissions.contains/request 的获准状态与 downloads.download 返回值受 mock 控制；没有验证真实文件落盘 |
| 拒绝与停止 | 拒绝返回明确 Tool Result；停止移除待授权项；原内部产物继续存在 | request 返回 false；该结果不是原生 Chrome 气泡中点“拒绝”的实测 |
| 撤销后再保存 | 再次检查权限并显示授权，拒绝后不新增下载，原产物不重复创建 | 将 mock 的 contains 状态改为未授权，未在 Chrome 原生权限页实际撤销 |

`e2e/native-download.spec.ts` 另外使用真实 0.2.0 安装保留的下载授权，调用真实 `chrome.downloads.download/search`，等待完成并逐字节比较下载文件与 canonical artifact；随后调用真实 `chrome.permissions.remove` 撤销权限，核对再次保存出现授权 UI，取消后留下失败终态且不重新采集产物。此流程没有模拟上述 Chrome API。等待首次授权的原生侧栏用例先等待 11 秒，验证授权组件仍然存在，再关闭侧栏并恢复同一产物；人工等待不受浏览器操作默认 10 秒超时限制，停止或关闭仍立即中止。

Chrome 138 使用 `pagehide` 与 owner Port 断开处理关闭；有 `sidePanel.onClosed` 的版本补充核对 owner document 已不存在再取消，并在异步查询后再次核对 owner 世代。迟到的旧关闭事件不能取消同窗口的新运行。对应单元测试覆盖文档仍活跃、owner 换代、文档已关闭、查询失败及其他窗口；两个浏览器的原生关闭与恢复用例另外重复运行共 4 次通过。

新安装测试读取真实 Manifest 与初始 permissions.contains；升级测试使用真实历史构建与同一 profile，创建两个旧分支并在升级后恢复切换，重新加载后还验证新请求确实注册 49 个工具。**Chrome 原生首次下载授权气泡中的允许/拒绝操作仍未实测。**最终发布前应在普通 Chrome 上完成首次授权、拒绝及原生撤销后再授权，并核对产物仍可读取及下载次数。解包扩展升级测试会先在 Chrome 扩展管理页打开开发者模式再重新加载；关闭开发者模式时重新加载会禁用解包扩展，这属于测试安装条件。

## 最终验证结果

功能矩阵和性能测试使用同一候选 ZIP 的解包目录；源码变更后重新构建、打包并验证。旧候选与失败 trace 保留为排查证据，不计入最终通过结果。

| 项目 | 结果 | 证据 |
| --- | --- | --- |
| 最终版本 / 提交 | 0.3.0 / `b1e43dd（源码与候选 ZIP）` | `master；按实现与门禁拆分提交，详见 Git 历史` |
| docs:check | `通过` | `.dev/formalization-evidence/docs.log` |
| 类型、独立构建及产物契约 | `通过`；主入口 `1,998,887`B | `.dev/formalization-evidence/check.log` |
| 单元与协议测试 | `273` / `273` | `.dev/formalization-evidence/unit.log` |
| Chrome 138 功能矩阵 | `84` 通过 / `85`；1 项缺少 CDP 测试接口跳过，原生行为有其他真实点击用例覆盖；版本 `138.0.7204.183` | `.dev/formalization-evidence/final-matrix.json` |
| 当前 Stable 功能矩阵 | `85` / `85` 通过；版本 `154.0.8037.92` | `.dev/formalization-evidence/final-matrix.json` |
| 原生下载授权及实际落盘 | 真实继承授权下载与撤销通过；首次气泡仍需人工 | `native-download.spec.ts；首次原生授权气泡仍待人工` |
| 真实 worker 重启与副作用边界 | 最终 ZIP 的两个浏览器用例均通过 | `maintenance.spec.ts；真实 ServiceWorker.stopWorker，不重放副作用` |
| 本地性能 | 2/2 通过；流式 p95 16.7ms，滚动 p95 16.7ms，输入 p95 14.4ms，恢复 441ms | [performance-results.json](performance-results.json)；原始样本 `.dev/formalization-evidence/performance-ready/` |
| 最终 ZIP / SHA-256 | `.dev/releases/ready/surf-wax-0.3.0.zip` / `22838690a4c29cc1ad7060f2d77e98a1c41aa90ed1a398dd33c54ea64271e0df` | `.dev/formalization-evidence/package-integrity.json；421 个解包文件与构建逐一 SHA-256 匹配；同包功能矩阵 169 通过、1 跳过、0 失败` |
| GitHub 渠道与商店发布 | 工作流与候选版本包已准备；远端每次运行独立验证其 ZIP，商店尚未发布 | [GitHub Actions](https://github.com/notCorwin/SurfWax/actions/workflows/autobuild.yml)；正式版本与 autobuild 分离 |

Canonical IndexedDB 证据按仓库约定保存在 `../.dev/chromium-profile/Default/IndexedDB/`；隔离 profile 测试结束后复制到该位置，失败 profile 不先删除。trace、失败截图和性能 JSON 应一并保留，记录浏览器实际版本、project、提交、viewport、DPR 与运行环境。

完整矩阵共 170 项，169 通过、1 跳过、无失败与重试后才通过的 flaky 项。结构化结果见 [acceptance-results.json](acceptance-results.json)，其中记录候选 ZIP 的提交、checksum、权限、工具预算、浏览器版本、跳过原因与性能环境；此报告中的源码提交与后续仅记录验收结果的文档提交分别标识。

## 发布前人工门禁与行为边界

- **首次原生下载授权**：自动测试覆盖 Chrome API 边界的允许/拒绝，真实继承授权后的文件落盘、实际撤销，以及等待授权时关闭原生侧栏后的恢复。原生首次授权气泡的允许、拒绝与撤销后再次允许，仍需在普通 Chrome 中操作并记录；当前运行环境不能控制浏览器原生权限气泡。
- **原生生命周期覆盖**：功能矩阵实际覆盖 SSE 断流续接且副作用只执行一次、双侧栏互斥与非 owner 关闭、owner 关闭后排队指令未执行、部分 act 结果恢复、等待下载授权时关闭后复用原产物。实际终止 MV3 worker 的用例验证按键释放、移除页面保护、幂等补齐工具与运行终态、新任务可启动；每种崩溃时间点尚未做穷举。
- **已发出的副作用**：取消可以阻止后续和排队指令，不能撤回已经发送的 CDP 输入、网页提交、下载或服务端行为。终态日志去重与请求续接不构成外部副作用 exactly-once 保证；断线时结果不明确的动作应先观察页面再决定后续操作，不能声称它已回滚。
- **性能范围**：本地固定环境测量流式与长日志场景的 rAF 间隔 p95 ≤20ms、input 事件到下一 rAF p95 ≤50ms；语义定位+动作 p95 ≤100ms。保留长日志恢复、DOM 数量及原有交互门槛。结果是此环境的 p95，不能理解为每一帧都在 20ms 内；GitHub Actions 不运行性能测试。
- **发布证据**：CI 配置、版本 ZIP 与商店材料已经具备；远端工作流以对应提交的 Actions 结果为准，正式 tag 与商店提交尚未执行。现有商店图片属于既有素材，不自动证明与 0.3.0 界面一致。

最终结论以“最终验证结果”表为准。正式版本 tag 与商店提交须在人工授权气泡、素材核对及远端发布门禁通过后进行；本轮交付为可独立安装的候选版本包。
