# Surf Wax 工具参考

此文件由真实工具 registry 自动生成（npm run docs:tools）。新回合公开 59 个工具；每个独立工具对应一个操作，具体参数以工具 schema 为准。旧会话的 canonical 历史原样保留，历史工具名称不会因此重新成为可执行入口。

页面语义观察支持区域、字段、字符预算、分页、截断说明与增量。ref 带 tab/document 归属，导航和移除不会自动替换成相似元素。只有明确请求时才返回截图；AX 数据仍从 Chrome 读取，输出增量不意味着底层 CDP 事件已增量化。

| 工具 | 功能 |
| --- | --- |
| `inspect_page` | Inspect semantic text and stable refs. region and fields narrow the result; budget and pagination limit output; since reads changes. Use take_screenshot for visual input. |
| `click` | Click exactly one matching element. |
| `double_click` | Double-click exactly one matching element. |
| `hover` | Move the pointer over exactly one matching element. |
| `fill` | Replace an editable element's value; an empty value clears it. |
| `type_text` | Enter text character by character into an editable element. |
| `press_key` | Press a key or chord, optionally focusing an element first. |
| `key_down` | Hold a key until key_up or run cleanup. |
| `key_up` | Release a held key. |
| `set_checked` | Set a checkbox or radio button to the requested checked state. |
| `select_option` | Select option values or labels on a select element. |
| `drag` | Drag one element to another. |
| `scroll` | Scroll the page by a horizontal and vertical delta at the current pointer. |
| `move_pointer` | Move the pointer to coordinates bound to a current observation. |
| `press_pointer` | Press a pointer button at its current position. |
| `release_pointer` | Release a pointer button at its current position. |
| `read_text` | Read an element's visible text. |
| `read_value` | Read a form element's current value. |
| `read_checked` | Read an element's checked state. |
| `read_attribute` | Read an element's named attribute. |
| `verify_state` | Verify one element condition immediately or wait for it to become true; a timed-out wait returns verified=false and timedOut=true. |
| `wait_for_url` | Wait until the page URL contains the given text. |
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
| `read_artifact` | Read a stored artifact or large tool result by ID, including while a background job runs. |
| `create_text_artifact` | Store text as an internal artifact. |
| `save_artifact` | Export an internal artifact to a file. |
| `list_scripts` | List persisted user scripts and their state. |
| `read_script` | Read a persisted user script by ID. |
| `create_script` | Create a persisted user script. |
| `update_script` | Update a persisted user script. |
| `set_script_enabled` | Enable or disable a persisted user script. |
| `delete_script` | Delete a persisted user script. |
| `list_requests` | Read captured network requests for the selected tab. |
| `read_response` | Read a captured response body by request index. |
| `read_console` | Read captured console messages for the selected tab. |
| `fetch` | Fetch in the explicit page or extension context; contexts have different permissions and credentials. |
| `evaluate_js` | Execute a JavaScript body in the explicitly selected page world. |
| `list_cdp_sessions` | List CDP sessions owned by the selected tab. |
| `send_cdp` | Send a Chrome DevTools Protocol command to an owned tab or session. |
| `list_downloads` | List download metadata across the Chrome profile. limit defaults to 100; 0 requests all records. hasMore reports truncation. The list is live and Chrome's exists field may be stale; metadata does not provide file bytes. |
| `subscribe_event` | Subscribe to a tab's dialog, popup, download, filechooser, request, response or console events. Returns a run-scoped subscription and cursor. Filechooser events include a chooserId for upload_file. |
| `wait_event` | Read events after a subscription cursor, or wait up to waitMs. Use the returned nextCursor. Overflow, truncation and ended subscriptions are explicit. |
| `unsubscribe_event` | Stop a subscription and release its resources. |
| `handle_dialog` | Respond to a captured dialog by ID. prompt is allowed only when accepting a prompt dialog. An uncertain response must not be blindly retried. |
| `read_api_reference` | Read the available execute_program capabilities and usage details. |
| `execute_program` | Execute an async JavaScript body with page, browser, net, protocol, artifacts, emit, check, sleep and signal. Use for loops, conditions, event subscriptions and complex multi-step tasks. Call read_api_reference for the complete API. background=true starts a job. Set timeoutMs to accommodate the entire program. Effects are not automatically retried; inspect uncertain outcomes. |
| `list_jobs` | List jobs in creation order in a fixed snapshot. limit defaults to 25, max 100. If hasMore, pass nextCursor to continue; cursor expires on log maintenance. Job state is as of the first page; get_job reads current state. |
| `get_job` | Read status and paginated receipts for a job. waitMs waits for receipts after the supplied canonical event cursor or for completion; unread receipts return immediately. A running job is not complete. |
| `cancel_job` | Cancel a job in the current conversation. Cancellation does not roll back dispatched effects. |

## 可组合程序

`execute_program` 接受 async JavaScript 函数体，复杂工作可以使用变量、循环、条件、等待、过滤和断言。页面动作、脚本、网络、标签页、持久脚本与产物可在同一程序中组合。同步循环运行在可销毁的 opaque-origin sandbox Worker，Side Panel 中介浏览器能力，MV3 service worker 不 eval 模型字符串。

```js
await page.getByLabel('Email').fill('me@example.com');
await page.getByRole('button', { name: 'Sign in' }).click();
await page.getByText('Welcome me@example.com').waitFor({ state: 'visible' });
await check((await page.locator('output').innerText()).includes('Welcome'));
return await page.inspect();
```

```text
execute_program API (async JavaScript body; no function wrapper required):
page: tabId; inspect(options?, regionLocator?); snapshot(); observe('semantic'|'visual'); ref/locator/frameLocator/getByRole/getByText/getByLabel/getByPlaceholder/getByAltText/getByTitle/getByTestId; goto/reload/goBack/goForward; url/title; evaluate(functionOrString,arg?); waitForURL/waitForLoadState/waitForEvent('dialog'|'popup'|'download'|'filechooser'); point(observationId,x,y,'click'|'dblclick'|'hover',options?); upload(files); drop(target,{files?,data?}); screenshot(options?); pdf({filename?,save?}); keyboard.press/insertText/down/up; mouse.move/down/up/wheel.
locators: chain/filter/first/last/nth, count/waitFor/click/dblclick/hover/fill/clear/press/pressSequentially/check/uncheck/selectOption/dragTo/setInputFiles/focus/blur/scrollIntoViewIfNeeded/textContent/innerText/inputValue/getAttribute/isVisible/isEnabled/isChecked/evaluate. Files: {name,mimeType?,text|base64|url}; artifacts.read supplies existing file data. Event handles: chooser.isMultiple()/setFiles(files), dialog.type()/message()/defaultValue()/accept(prompt?)/dismiss(), popup is a page. Start event waits before the action, then await them.
browser: page(tabId); tabs.list()/open(url?)/select(tabId)/close(tabId); scripts.list()/read(id)/create(definition)/edit(id,changes)/setEnabled(id,enabled)/delete(id). Scripts use Chrome RegisteredUserScript fields including matches, js:[{code|file}], world:MAIN|USER_SCRIPT, runAt, allFrames, include/excludeGlobs/Matches, worldId. Persisted enablement is restored at startup/upgrade; Allow User Scripts must already be enabled.
browser.runIn({kind:'page',tabId,world:'MAIN'|'ISOLATED'|'USER_SCRIPT',frameId?,documentId?},codeBody): explicit execution domain. MAIN/ISOLATED root only; USER_SCRIPT supports Chrome frameId or documentId. Use frameLocator.evaluate for arbitrary supported frames. No automatic context substitution.
net.fetch({context:'page'|'extension',url,tabId?,init?}) returns {url,status,ok,headers,body}; no page-to-extension fallback. Page fetch obeys page origin/cookies/CORS; extension fetch uses extension host permissions. net.requests(options?,tabId?)/request(index,tabId?); net.responseBody(index,tabId?); net.console(options?,tabId?) read captured diagnostics.
protocol.sessions(tabId?) lists root/child CDP handles; protocol.send({tabId,sessionId?},method,params?) sends any Chrome CDP method available to the extension. Arbitrary JS/CDP/fetch are effectful; there is no readonly override. inspect.documentId is the local navigation generation; USER_SCRIPT documentId uses Chrome's native scripting document ID. File URL sources are fetched in extension context.
artifacts.read(id,{path?,offset?,limit?}); text(filename,text,mimeType?,save=false); save(id,filename?). Files and images stay internal unless the user requested download/export. emit(value) persists incremental output; check(condition,message?) records a verified assertion; sleep(ms) and signal support cancellation. Completed operations only confirm dispatch/return; verify application outcomes. Queued operations are not dispatched, uncertain effects must be inspected before continuing. Program computation uses a disposable opaque-origin sandbox Worker; browser capabilities are mediated by the Side Panel. Closing the panel cancels jobs and revokes capabilities; arbitrary program finally blocks are not guaranteed to run. Only records survive restart, never arbitrary JS stacks.
```

## 任务、回执与恢复

后台执行返回 queued/accepted，不代表完成。`list_jobs`、`get_job` 和 `cancel_job` 管理任务；`list_jobs` 默认每页 25 条，最多 100 条；返回 nextCursor 时可继续读取固定快照，日志维护后游标失效，`get_job` 则读取最新状态。回执使用 canonical event ID 分页。已完成的动作表示操作返回，业务结果需要单独验证。程序内的动作按顺序执行，事件应在触发动作前订阅。原生对话框与选择器的回复可在等待中的点击期间执行。

独立工具可通过 `subscribe_event`、`wait_event` 和 `unsubscribe_event` 接收运行内事件。处理原生对话框时，先订阅，再以 `background=true` 触发动作，取得 dialogId 后调用 `handle_dialog`，最后用 `get_job` 确认作业终态。处理文件选择器时先订阅并触发，再用返回的 chooserId 和已有产物调用 `upload_file`。前台操作遇到弹窗可能返回 blocked 任务；程序可能仍在自行处理该弹窗，可先查询作业，再按需回应并确认终态。未确认终态的后台作业会阻止新的排队浏览器动作；事件等待、对话框与文件选择器应答、作业查询和读取已有产物仍可执行。较大回执提供可直接传给 `read_artifact` 的 access；终态结果另有 resultAccess。

取消会销毁 Worker、撤销能力、清理浏览器输入和监听器。已经派发的操作可能有未知效果，不会回滚或盲目重试。关闭侧栏会取消全部作业；宿主丢失后持久记录变为 interrupted，不恢复任意 JavaScript 调用栈或自动重放。状态、回执与产物来自同一个 canonical event log。

截图、PDF 与文本默认是会话内部产物；用户明确请求保存或导出时才保存。网络必须显式选择 page 或 extension 上下文，页面 CORS/凭据和扩展 host permissions 不自动互换。公开 CDP 绑定当前窗口中的页面及其已知子会话，不按 CDP 域限制；任意 JavaScript、CDP 和 fetch 按有副作用处理。