# 决策历史

本文根据仓库提交历史，记录未在当前 `AGENTS.md` 及工程约定中明确写出的产品与架构决策，不作为逐次改动的 Changelog。整理范围截至 `6632914`（2026-11-04）；日期采用提交的作者日期。

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

## 工作模式与完成判定

### 工作模式通过显式工具结束

2026-11-01 引入目标模式，随后将工作模式入口改为直接开关。启用后，普通文本回复不会结束任务，必须单独调用 `complete_goal`。可恢复的工具错误应进入后续恢复流程；真正阻塞需要指出认证、仅用户掌握的信息或外部依赖，以及所需用户操作和已尝试的恢复。

来源：[`fbcfd2a`](https://github.com/notCorwin/SurfWax/commit/fbcfd2a)、[`abe2329`](https://github.com/notCorwin/SurfWax/commit/abe2329)、[`a3d618b`](https://github.com/notCorwin/SurfWax/commit/a3d618b)。

### 浏览器目标完成需要结果证据和独立复核

2026-11-01 起加强完成判定：动作成功返回不等于业务目标完成。浏览器目标引用真实工具结果的 `evidenceId`，并由独立复核核对用户要求和观察结果；历史动作回执参与累计约束检查，例如“只能提交一次”。未结束的后台任务不能视为完成。副作用未知时，必须先用后续观察确认，不能盲目重试或直接宣告成功。2026-11-04 进一步明确，不完整快照不能作为完整观察证据。

来源：[`3437dbe`](https://github.com/notCorwin/SurfWax/commit/3437dbe)、[`b00caf4`](https://github.com/notCorwin/SurfWax/commit/b00caf4)、[`a49c713`](https://github.com/notCorwin/SurfWax/commit/a49c713)，见 `src/agent/goal-completion.ts`、`src/agent/goal-review.ts`。

### 完成工具不接收总结

2026-11-04 先允许无总结完成，随后从完成协议中移除总结字段。用户要求的事实、链接和其他产出应在调用完成工具前通过 Assistant 正文交付；不额外要求一份完成回顾。

来源：[`c7ab3ef`](https://github.com/notCorwin/SurfWax/commit/c7ab3ef)、[`636b563`](https://github.com/notCorwin/SurfWax/commit/636b563)。

## 浏览器执行与数据

### 默认从当前窗口开始，跨窗口使用稳定身份

2026-09-22 将默认浏览器操作范围收敛到当前 Chrome 窗口。后续工具可跨窗口发现标签页，使用稳定的 `tabId` 和 `windowId` 区分目标；选择标签页也不应强制抢占 Chrome 焦点。

来源：[`8e3643e`](https://github.com/notCorwin/SurfWax/commit/8e3643e)、[`d970aec`](https://github.com/notCorwin/SurfWax/commit/d970aec)，当前提示词见 `src/agent/prompt.ts`。

### 删除页面交互拦截层

2026-09 至 10 月曾为运行中的页面添加交互拦截及呼吸效果；2026-11-01 完整删除相关页面守卫、输入拦截和样式。任务运行时不再通过覆盖层阻止用户操作网页。会话本身的运行期保护仍按项目约定执行。

来源：[`f7503c0`](https://github.com/notCorwin/SurfWax/commit/f7503c0)、[`182dbfd`](https://github.com/notCorwin/SurfWax/commit/182dbfd)、[`5388fef`](https://github.com/notCorwin/SurfWax/commit/5388fef)。

### 页面请求与扩展请求显式区分

2026-10-29 起要求网络调用明确所属上下文；2026-11-03 进一步拆分工具，分别暴露页面请求与扩展请求、页面脚本与扩展脚本，以及不同读取操作。执行上下文成为工具选择的一部分，避免由通用入口隐式猜测。

来源：[`a58e77b`](https://github.com/notCorwin/SurfWax/commit/a58e77b)、[`e514df4`](https://github.com/notCorwin/SurfWax/commit/e514df4)。

### 同批动作保持顺序，失败后保留诊断和清理通道

工具调度在模型完整响应后预留调用位置，协调同批执行顺序。对某资源的动作失败后，阻止后续依赖该资源的写操作继续盲目执行，但允许读取诊断和释放按键、指针。任务查询、取消及处理阻塞事件的路径需保持可用，避免等待中的操作挡住自己的恢复操作。

来源：[`0c4173e`](https://github.com/notCorwin/SurfWax/commit/0c4173e)、[`171464b`](https://github.com/notCorwin/SurfWax/commit/171464b)、[`e514df4`](https://github.com/notCorwin/SurfWax/commit/e514df4)、[`902eeb0`](https://github.com/notCorwin/SurfWax/commit/902eeb0)，见 `src/chrome/tool-scheduler.ts`。

### 后台操作使用可查询任务与增量回执

2026-10-29 起，长操作和可能被浏览器事件阻塞的操作可交给后台任务，通过 `get_job` 增量读取回执直至终态，也可取消。取消不回滚已产生的副作用；重启保留任务记录，但不恢复正在运行的工作。浏览器事件使用运行期订阅和游标，显式报告溢出、截断和关闭。

来源：[`0c4173e`](https://github.com/notCorwin/SurfWax/commit/0c4173e)、[`171464b`](https://github.com/notCorwin/SurfWax/commit/171464b)、[`9c377f6`](https://github.com/notCorwin/SurfWax/commit/9c377f6)，当前协议见 `src/chrome/tool.ts`。

### 元素引用绑定观察、文档和框架

2026-10-29 至 31 日持续收敛目标身份：观察返回的元素引用需校验原角色和身份，框架引用绑定文档；导航、框架替换或后续观察可能使引用失效。DOM 节点未变也不能证明业务数据未变，因此操作前仍需核对相关行与页面状态。

来源：[`b60bf21`](https://github.com/notCorwin/SurfWax/commit/b60bf21)、[`6b41900`](https://github.com/notCorwin/SurfWax/commit/6b41900)、[`ea1c158`](https://github.com/notCorwin/SurfWax/commit/ea1c158)、[`41dc64a`](https://github.com/notCorwin/SurfWax/commit/41dc64a)、[`fea9e40`](https://github.com/notCorwin/SurfWax/commit/fea9e40)。

### 大结果存入会话 Artifact，保留原始数据语义

2026-09-22 起，将生成结果保存在会话存储中；2026-10-30 至 31 日进一步支持大结果、二进制和复杂数据图，通过 Artifact 引用、分页及范围读取按需取回。编码保留 `undefined`、特殊数值、BigInt、类型化数组等 JSON 不能直接表达的值，不把显示用截断结果当成完整原始数据。

来源：[`61c200f`](https://github.com/notCorwin/SurfWax/commit/61c200f)、[`45f231c`](https://github.com/notCorwin/SurfWax/commit/45f231c)、[`c7e6e18`](https://github.com/notCorwin/SurfWax/commit/c7e6e18)、[`b156e43`](https://github.com/notCorwin/SurfWax/commit/b156e43)、[`8efcf68`](https://github.com/notCorwin/SurfWax/commit/8efcf68)。

### 保存文件直接使用必需的 downloads 权限

2026-10-02 将 `downloads` 改为必需权限，删除单独的下载授权界面，直接保存 Artifact。浏览器下载列表中的元数据不等于文件内容；上传和保存使用已存在的 Artifact 数据。

来源：[`619d93c`](https://github.com/notCorwin/SurfWax/commit/619d93c)，当前工具说明见 `src/chrome/tool.ts`。

### 文件选择器可以在触发后发现

2026-11-02 简化文件选择器流程：除了预订阅事件，也可从动作结果的 `fileChoosers` 或 `list_file_choosers` 获取句柄。2026-11-03 拆分上传工具后，选择器句柄交给 `upload_file_chooser`，已有文件输入框目标使用 `upload_file`。选择器可能由其他页面事件触发，必须核对来源；句柄在替换、导航、处理或运行结束后失效。

来源：[`efadccd`](https://github.com/notCorwin/SurfWax/commit/efadccd)、[`e514df4`](https://github.com/notCorwin/SurfWax/commit/e514df4)。

## 快照协议

### 分页基于冻结观察，变化后重新检查

2026-11-01 至 02 日完善快照分页：长行可以跨页续读，`nextCursor` 延续同一次冻结观察；滚动、布局或可见性变化使续页失效时，应重新检查。`lookahead` 只提供稀疏预览，没有可操作元素引用，不能作为完整正文或完整基线。预算按解码后的 UTF-8 JSON 字节计算。

来源：[`ba2baea`](https://github.com/notCorwin/SurfWax/commit/ba2baea)、[`567f320`](https://github.com/notCorwin/SurfWax/commit/567f320)、[`398fac4`](https://github.com/notCorwin/SurfWax/commit/398fac4)，当前说明见 `src/chrome/tool.ts`。

### 动态区域的不确定性显式输出

2026-11-02 起，对变化中的文本允许返回 `partial=true` 的局部结果，保留已验证的稳定行；无法验证的名称和值明确标为未知，不提供可操作引用。局部结果不能证明完整页面状态，需要重新检查相关区域或使用截图、专用读取工具确认。

来源：[`9c04c78`](https://github.com/notCorwin/SurfWax/commit/9c04c78)、[`a2ce5f8`](https://github.com/notCorwin/SurfWax/commit/a2ce5f8)、[`a49c713`](https://github.com/notCorwin/SurfWax/commit/a49c713)。

### 简化模型收到的快照编码

2026-11-02 删除快照行字典及额外输出编码实现，简化模型可见协议；不再要求模型通过这些中间编码重建快照正文。

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

### 能力评估区分工具验证与真实模型验证

2026-10-30 起引入模型评估，随后按任务能力建立关卡，并提供不调用模型的沙盒和工具验证。固定脚本通过只能证明工具及关卡可用，真实模型完成能力由独立的模型评估证据支持；不能混用两类结果。

来源：[`45f231c`](https://github.com/notCorwin/SurfWax/commit/45f231c)、[`75a7e54`](https://github.com/notCorwin/SurfWax/commit/75a7e54)、[`b2c9e1d`](https://github.com/notCorwin/SurfWax/commit/b2c9e1d)、[`a6135d6`](https://github.com/notCorwin/SurfWax/commit/a6135d6)。

### 删除自动发布，改为本地打包

2026-08-14 曾引入 Autobuild GitHub Release 工作流；2026-10-14 删除自动发布，将版本设为 1.0.0，并完善本地发布包生成及来源校验。发布材料与 Vite 的公开输入隔离，归档输入与顺序需要可确定。

来源：[`2e96a95`](https://github.com/notCorwin/SurfWax/commit/2e96a95)、[`f1e1eac`](https://github.com/notCorwin/SurfWax/commit/f1e1eac)，见 `scripts/package-release.mjs`。

### 使用 GPL v3 许可证

2026-11-02 为项目加入 GNU GPL v3 许可证，具体条款以 `LICENSE` 为准。

来源：[`ced9391`](https://github.com/notCorwin/SurfWax/commit/ced9391)。
