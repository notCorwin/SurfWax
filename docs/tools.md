# Surf Wax 工具参考

此文件由真实工具 registry 自动生成（npm run docs:tools）。新回合公开 65 个工具；每个独立工具对应一个操作，具体参数以工具 schema 为准。旧会话的 canonical 历史原样保留，历史工具名称不会因此重新成为可执行入口。

页面语义观察支持区域、字段、字符预算、分页、截断说明与增量。ref 带 tab/document 归属，导航和移除不会自动替换成相似元素。只有明确请求时才返回截图；AX 数据仍从 Chrome 读取，输出增量不意味着底层 CDP 事件已增量化。

| 工具 | 功能 |
| --- | --- |
| `inspect_page` | Inspect semantic items with id, line and optional ref. Item ids identify snapshot rows, not frame handles. An iframe's frameRef in its line is the handle to pass as target.frame.ref; a frame-document marker with that same handle introduces the child document's items. Frame handles expire when the frame tree changes. Waits for a fully loaded page for up to 15 seconds by default; set timeoutMs to allow more time. For since, first reconstruct all primary pages; baselineComplete means the server generated the pages, not that you read them. Remove removed ids and upsert added, updated or moved items immediately after their after id (null means first). Reassemble split items using their UTF-16 fragment offsets before applying changes. Ref use checks the underlying role and identity, which may differ from visible text; use the ref when a role/name locator does not match the visible label. A DOM node may be reused for different business data with the same identity; verify relevant row and page state before acting. Older refs may expire after later independent observations or searches; an affected continuation returns stale-observation. Default fields are text, state and ref; include actions explicitly for per-row hints. These hints are derived from role, not proof an action will succeed: textbox/searchbox/spinbutton use click, fill, press_key, type_text; checkbox/radio/switch use click, set_checked; combobox/listbox use click, select_option; rows marked editable use click, fill, press_key, type_text; other rows with a ref use click, double_click, hover. region and fields narrow results. [name=unknown] marks text that could not be verified; use a screenshot to inspect it. [value=unknown] marks an unverified control value; use read_value on its ref to retrieve the current value. budget limits UTF-8 JSON items bytes; when lookahead is present it also bounds JSON {items,lookahead}, measured by truncation.withLookahead. limit also bounds the source row window eligible for lookahead. lookahead contains sparse, non-authoritative later rows from the same frozen snapshot, not part of items or a complete baseline; ancestor context may be absent and no element refs are provided. Use a locator or continue the snapshot. The complete response is capped at 16 KiB and may use less than the requested budget. Continue a frozen snapshot by passing nextCursor as cursor, with only tabId, budget, limit or timeoutMs if needed. Continuation pages omit url and title; use the first page or refresh metadataAccess. Use take_screenshot for visual input. |
| `find_elements` | Find matching elements with refs for actions. Ref use checks the underlying role and identity, which may differ from visible text, but cannot prove business identity for reused nodes; verify relevant row and page state before acting. Older refs may expire after later independent observations or searches. limit defaults to 25, max 100; repeat target and tab with nextCursor as cursor to page a fixed node list. Candidates may report detached, changed or identity-unknown without a ref. Details may change between pages; cursors expire on run or document changes or eviction. |
| `list_frames` | List the selected tab's frame tree with refs usable as target.frame.ref. limit defaults to 25, max 100; pass nextCursor as cursor to continue a fixed snapshot. References and cursors expire on document or frame changes. |
| `click` | Click exactly one matching element. Fails immediately if it is missing, blocked or otherwise not actionable. Defaults to a 5 second execution timeout. |
| `double_click` | Double-click exactly one matching element. Fails immediately if it is missing, blocked or otherwise not actionable. Defaults to a 5 second execution timeout. |
| `hover` | Move the pointer over exactly one matching element. |
| `focus_element` | Focus exactly one matching element. Fails immediately if the target or frame is missing; use verify_state to wait explicitly. |
| `blur_element` | Blur exactly one matching element. Fails immediately if the target or frame is missing. |
| `scroll_to_element` | Scroll exactly one matching element into view. |
| `fill` | Replace an editable element's value; an empty value clears it. Does not emit beforeinput or keyboard events. Date, time, datetime-local, month and week require valid browser-format values and dispatch untrusted input/change events; the result includes the actual normalized value. |
| `fill_from_artifact` | Replace an editable element's value with a stored string or UTF-8 file artifact. Use path to select a string within a stored result. Applies the same fill semantics as fill. |
| `type_text` | Insert text character by character into a text, number or contenteditable element; this does not emit beforeinput, keydown or keyup. Use fill for date/time/month/week controls. |
| `press_key` | Press a character or chord such as Control+ArrowUp, optionally focusing an element first. A missing or non-actionable target, including its frame, fails immediately; use verify_state for an explicit wait. Named keys (ArrowUp, Enter, F1–F24) are case-insensitive; unknown key names fail before input or focus is dispatched. |
| `key_down` | Hold one character or named key until key_up or run cleanup. Named keys are case-insensitive; chords and unknown key names are rejected. |
| `key_up` | Release one held character or named key. Named keys are case-insensitive; chords and unknown key names are rejected. |
| `set_checked` | Set a checkbox or radio button to the requested checked state. |
| `select_option` | Select option values or labels on a select element. An empty array clears selection; missing, disabled or ambiguous options fail without changing selection. |
| `drag` | Drag one element to another using pointer events. |
| `scroll` | Scroll the page by a horizontal and vertical delta at the current pointer. |
| `move_pointer` | Move the pointer using observationId from take_screenshot on the same tab. x and y are pixel coordinates relative to that screenshot's top-left, including for an element screenshot; the tool accounts for its scale and origin. A navigation or change in scroll position, viewport size or scale invalidates the observation; take a new screenshot. |
| `press_pointer` | Press a pointer button at its current position. |
| `release_pointer` | Release a pointer button at its current position. |
| `read_text` | Read an element's visible text. |
| `read_value` | Read a form element's current value. |
| `read_checked` | Read an element's checked state; missing or unsupported states are errors. |
| `read_attribute` | Read an element's named attribute. |
| `count_elements` | Count elements matching a target. |
| `read_elements` | Read visible text and selected attributes from a page of matching elements. The list is live: elements can change between reads or pages. offset defaults to 0 and limit defaults to 25, maximum 100. |
| `verify_state` | Specify exactly one of textIncludes, textEquals, valueEquals, or state. Checks immediately by default (timeoutMs=0); a positive timeoutMs waits for the condition. textEquals compares the complete visible text exactly; textIncludes checks a substring. A timed-out wait returns verified=false and timedOut=true. |
| `wait_for_url` | Wait until the page URL contains the given text. |
| `get_page_info` | Read the selected page's URL and title. |
| `navigate` | Navigate the selected page to a URL. |
| `reload` | Reload the selected page. |
| `go_back` | Navigate back in the selected page history. |
| `go_forward` | Navigate forward in the selected page history. |
| `list_tabs` | List tabs across browser windows. |
| `open_tab` | Open a tab in the bound browser window. |
| `switch_tab` | Switch the bound page to a tab. |
| `close_tab` | Close a tab. |
| `upload_file` | Upload one or more artifacts. Supply exactly one target or chooserId; chooser uploads cannot set tabId or background. |
| `take_screenshot` | Capture a screenshot when visual input is enabled. |
| `create_pdf` | Create a PDF artifact of the selected page. |
| `read_artifact` | Read a stored artifact or large tool result by ID, including during a background job. Missing paths fail. offset/limit page arrays, strings, Map/Set entries, binary bytes for ArrayBuffer/DataView, or elements for TypedArray. In path, a numeric Map index selects a [key,value] pair and a numeric Set index selects an item. Undefined is null with resultType=undefined; nested undefined and array holes are null with undefinedPaths and holePaths; non-finite numbers, negative zero and bigints use numberPaths and bigintPaths. Paths are relative to the returned slice; large results expose paged sidecar access. |
| `create_text_artifact` | Store text as an internal artifact. |
| `import_file_from_url` | Fetch a file in the extension context and store its original bytes as an internal artifact. Uses extension permissions and credentials, not the page's context. Fails on non-success HTTP responses. |
| `import_file_from_link` | Import a linked file with its original bytes and filename in the link's page and frame context. Uses page origin, credentials and CORS; supports page-created blob URLs. Preserves the download attribute, otherwise uses Content-Disposition or the response URL filename. Returns filename and byteLength; fails if no filename is available or the response is unsuccessful. Use save_artifact for an explicitly renamed export. |
| `save_artifact` | Export an internal artifact to a file. |
| `list_scripts` | List persisted user scripts and their state. |
| `read_script` | Read a persisted user script by ID. |
| `create_script` | Create a persisted user script and immediately enable and register it. It will run on matching page loads according to its injection settings. |
| `update_script` | Update one or more fields of a persisted user script while preserving its enabled state. Supplied fields, including arrays, replace their old values; omitted fields remain unchanged. For nullable optional settings, null removes the setting and restores Chrome's default. |
| `set_script_enabled` | Enable or disable a persisted user script. |
| `delete_script` | Delete a persisted user script. |
| `list_requests` | List captured network requests and requestRef identifiers. limit defaults to 100, max 100. integrity describes captured history, not all network traffic; hasMore may be null when unknown. nextOffset paginates a live, possibly changing list. |
| `read_response` | Read the captured response body identified by requestRef from list_requests. |
| `read_console` | Read captured console messages. limit defaults to 100, max 100. integrity describes captured history; hasMore may be null when unknown. nextOffset paginates a live, possibly changing list. |
| `send_request` | Send one HTTP request in the explicit page or extension context; contexts have different permissions and credentials. |
| `list_downloads` | List download metadata across the Chrome profile. limit defaults to 100; 0 requests all records. hasMore reports truncation. The list is live and Chrome's exists field may be stale; metadata does not provide file bytes. |
| `subscribe_event` | Subscribe to a tab's dialog, popup, download, filechooser, request, response or console events. Returns a run-scoped subscription and cursor. Filechooser events include a chooserId for upload_file. |
| `wait_event` | Read events after a subscription cursor, or wait up to waitMs. Pass the returned nextCursor as after on the next call; hasMore indicates unread events. Overflow, truncation and closure are explicit; a closed tab's bounded unread events remain available until unsubscribe or run end. |
| `unsubscribe_event` | Stop a subscription and release its resources. |
| `handle_dialog` | Respond to a captured dialog by ID. prompt is allowed only when accepting a prompt dialog. An uncertain response must not be blindly retried. |
| `list_jobs` | List jobs in creation order in a fixed snapshot. limit defaults to 25, max 100. If hasMore, pass nextCursor as cursor to continue; cursor expires on log maintenance. Job state is as of the first page; get_job reads current state. |
| `get_job` | Read status and paginated receipts for a job. Pass the previous response's nextCursor as after to read subsequent receipts. waitMs waits for receipts after the supplied canonical event cursor or for completion; unread receipts return immediately. A terminal event with outputAt:'result' or 'resultAccess' refers to that top-level field. A running job is not complete. |
| `cancel_job` | Cancel a job in the current conversation. Cancellation does not roll back dispatched effects. |

## 多步工作

通过独立工具逐步观察、操作和验证。每次工具调用都描述具体用途；按需使用批量读取减少重复观察。用户脚本管理工具用于管理持久化用户脚本。

## 任务、回执与恢复

后台执行返回 queued/accepted，不代表完成。`list_jobs`、`get_job` 和 `cancel_job` 管理任务；`list_jobs` 默认每页 25 条，最多 100 条；返回 nextCursor 时可继续读取固定快照，日志维护后游标失效，`get_job` 则读取最新状态。回执使用 canonical event ID 分页。已完成的动作表示操作返回，业务结果需要单独验证。事件应在触发动作前订阅。原生对话框与选择器的回复可在等待中的点击期间执行。

独立工具可通过 `subscribe_event`、`wait_event` 和 `unsubscribe_event` 接收运行内事件。处理原生对话框时，先订阅，再以 `background=true` 触发动作，取得 dialogId 后调用 `handle_dialog`，最后用 `get_job` 确认作业终态。处理文件选择器时先订阅并触发，再用返回的 chooserId 和已有产物调用 `upload_file`。前台操作遇到弹窗可能返回 blocked 任务，可先查询作业，再按需回应并确认终态。未确认终态的后台作业会阻止新的排队浏览器动作；事件等待、对话框与文件选择器应答、作业查询和读取已有产物仍可执行。较大回执提供可直接传给 `read_artifact` 的 access；终态结果另有 resultAccess。

取消会销毁 Worker、撤销能力、清理浏览器输入和监听器。已经派发的操作可能有未知效果，不会回滚或盲目重试。关闭侧栏会取消全部作业；宿主丢失后持久记录变为 interrupted，不恢复任意 JavaScript 调用栈或自动重放。状态、回执与产物来自同一个 canonical event log。

截图、PDF 与文本默认是会话内部产物；用户明确请求保存或导出时才保存。`send_request` 必须显式选择 page 或 extension 上下文，页面 CORS/凭据和扩展 host permissions 不自动互换；网络请求按有副作用处理。