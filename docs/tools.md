# Surf Wax 工具参考

此文件由真实工具 registry 自动生成（npm run docs:tools）。所有新回合公开 3 个入口：inspect 了解页面、run 组合执行、jobs 管理长执行。旧会话的 canonical 历史原样保留；继续、重试、自定义提示词及压缩后的回合统一使用这三个工具，旧工具名称不再可执行。

inspect 默认只返回语义文本，有视觉能力的模型也不会自动截图；图片、布局、Canvas 或歧义才显式请求 image=true。文本支持区域、字段、字符预算、分页、截断说明与 since 增量；增量只返回 changes，不重复全页。ref 带 tab/document 归属，导航和移除不会自动替换成相似元素。AX 数据仍从 Chrome 读取，输出增量不意味着底层 CDP 事件已增量化。

| 入口 | 定位 |
| --- | --- |
| `inspect` | Inspect the bound page as semantic text with stable refs and tab/document ownership. region selects a locator subtree; fields selects text/state/ref/actions; budget limits returned characters with explicit truncation and nextOffset. since returns changes only for the same document/region/fields; a truncated baseline resets to full. image=true explicitly captures a screenshot artifact for images, layout, Canvas, or ambiguity; default never captures pixels. |
| `run` | Execute an async JavaScript body with page, browser, net, protocol, artifacts, emit, check, sleep, signal. Example: await page.getByLabel('Email').fill('a@example.com'); await check(await page.getByLabel('Email').inputValue() === 'a@example.com'); return await page.inspect(); Supports variables/loops/conditions/filtering, locators/frames, page.evaluate, native input, tabs, persistent scripts, explicit page/extension fetch, scoped CDP, and artifacts. Mutations are ordered and recorded as receipts. Subscribe with page.waitForEvent before triggering actions. background=true starts a cancellable job; defaults: 10s foreground / 300s background; jobs reads progress and results. No hidden agent or side-effect retries. See the runtime API appended to the system prompt. |
| `jobs` | Manage programs in this conversation: list; status(id,after?,limit?); wait(id,waitMs<=30000,after?,limit?); cancel(id). after/nextCursor are canonical event IDs. Job status and output are projections of the canonical log, available independently of the execution queue. accepted/queued is not completion; completed input is not business success. Cancellation is not rollback. Lost hosts become interrupted and are never automatically replayed or resumed from a JavaScript stack. |

## 可组合程序

run 接受 async JavaScript 函数体；简单操作直接调用，复杂工作可用变量、循环、条件、等待、过滤和断言。页面动作、脚本、网络、标签页、持久脚本与产物在同一程序中组合。同步循环运行在可销毁的 opaque-origin sandbox Worker，Side Panel 中介浏览器能力，jobs 不进入动作队列。没有新增 Chrome 权限，MV3 service worker 不 eval 模型字符串。

```js
await page.getByLabel('Email').fill('me@example.com');
await page.getByRole('button', { name: 'Sign in' }).click();
await page.getByText('Welcome me@example.com').waitFor({ state: 'visible' });
await check((await page.locator('output').innerText()).includes('Welcome'));
return await page.inspect();
```

```text
run API (async JavaScript body; no function wrapper required):
page: tabId; inspect(options?, regionLocator?); snapshot(); observe('semantic'|'visual'); ref/locator/frameLocator/getByRole/getByText/getByLabel/getByPlaceholder/getByAltText/getByTitle/getByTestId; goto/reload/goBack/goForward; url/title; evaluate(functionOrString,arg?); waitForURL/waitForLoadState/waitForEvent('dialog'|'popup'|'download'|'filechooser'); point(observationId,x,y,'click'|'dblclick'|'hover',options?); upload(files); drop(target,{files?,data?}); screenshot(options?); pdf({filename?,save?}); keyboard.press/insertText/down/up; mouse.move/down/up/wheel.
locators: chain/filter/first/last/nth, count/waitFor/click/dblclick/hover/fill/clear/press/pressSequentially/check/uncheck/selectOption/dragTo/setInputFiles/focus/blur/scrollIntoViewIfNeeded/textContent/innerText/inputValue/getAttribute/isVisible/isEnabled/isChecked/evaluate. Files: {name,mimeType?,text|base64|url}; artifacts.read supplies existing file data. Event handles: chooser.isMultiple()/setFiles(files), dialog.type()/message()/defaultValue()/accept(prompt?)/dismiss(), popup is a page. Start event waits before the action, then await them.
browser: page(tabId); tabs.list()/open(url?)/select(tabId)/close(tabId); scripts.list()/read(id)/create(definition)/edit(id,changes)/setEnabled(id,enabled). Scripts use Chrome RegisteredUserScript fields including matches, js:[{code|file}], world:MAIN|USER_SCRIPT, runAt, allFrames, include/excludeGlobs/Matches, worldId. Persisted enablement is restored at startup/upgrade; Allow User Scripts must already be enabled.
browser.runIn({kind:'page',tabId,world:'MAIN'|'ISOLATED'|'USER_SCRIPT',frameId?,documentId?},codeBody): explicit execution domain. MAIN/ISOLATED root only; USER_SCRIPT supports Chrome frameId or documentId. Use frameLocator.evaluate for arbitrary supported frames. No automatic context substitution.
net.fetch({context:'page'|'extension',url,tabId?,init?}) returns {url,status,ok,headers,body}; no page-to-extension fallback. Page fetch obeys page origin/cookies/CORS; extension fetch uses extension host permissions. net.requests(options?,tabId?)/request(index,tabId?); net.responseBody(index,tabId?); net.console(options?,tabId?) read captured diagnostics.
protocol.sessions(tabId?) lists owned root/child CDP handles; protocol.send({tabId,sessionId?},method,params?): CDP Page/DOM/Runtime/Accessibility/Network/Log/Input only, in the bound window and known child sessions. No Browser/Target/permission APIs. Arbitrary JS/CDP/fetch are effectful; there is no readonly override. inspect.documentId is the local navigation generation; USER_SCRIPT documentId uses Chrome's native scripting document ID. File URL sources are fetched in extension context.
artifacts.read(id,{path?,offset?,limit?}); text(filename,text,mimeType?,save=false); save(id,filename?). Files and images stay internal unless the user requested download/export. emit(value) persists incremental output; check(condition,message?) records a verified assertion; sleep(ms) and signal support cancellation. Completed operations only confirm dispatch/return; verify application outcomes. Queued operations are not dispatched, uncertain effects must be inspected before continuing. Program computation uses a disposable opaque-origin sandbox Worker; browser capabilities are mediated by the Side Panel. Closing the panel cancels jobs and revokes capabilities; arbitrary program finally blocks are not guaranteed to run. Only records survive restart, never arbitrary JS stacks.
```

## 任务、回执与恢复

run(background=true) 返回 queued/accepted，不代表完成。jobs 的 after/nextCursor 使用 canonical event ID，可分页读取分步回执、emit 与终态结果。effectful 操作从 not-dispatched 到 dispatched-unknown，再到 completed；check 与显式等待通过才记录 verified。completed 表示操作返回，业务结果需要断言。动作在同一程序中排序，即使使用 Promise.all；事件先订阅再派发。原生对话框与选择器的回复可在等待中的点击期间执行。

取消会销毁 Worker、撤销能力、清理浏览器输入和监听器，已经派发的请求可能有未知效果，不会回滚或盲目重试。关闭侧栏会取消全部作业；宿主丢失后持久记录变为 interrupted，不恢复任意 JS 调用栈或自动重放。所有状态、回执与产物来自同一个 canonical event log。

截图、PDF 与文本默认是会话内部产物；用户明确请求保存或导出才调用 save。网络必须显式选择 page 或 extension 上下文，页面 CORS/凭据和扩展 host permissions 不自动互换。公开 CDP 限于绑定窗口内的 Page/DOM/Runtime/Accessibility/Network/Log/Input 与已知子会话；任意 JS、CDP 和 fetch 按有副作用处理。