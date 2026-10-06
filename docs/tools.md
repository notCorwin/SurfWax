# Surf Wax 工具参考

此文件由真实工具 registry 自动生成（npm run docs:tools）。新会话公开 3 个入口：inspect 了解页面、run 组合执行、jobs 管理长执行。旧会话仍使用其 canonical 提示词快照中的目录，成功压缩后迁移。

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

## 历史会话兼容目录

以下 49 项仅供历史提示词快照使用，新会话不会把它们同时公开给模型。原执行路径保留以恢复历史会话与升级测试。

| 历史工具 | 定位 |
| --- | --- |
| `goto` | Navigate the current tab to a URL. |
| `type` | Type text into the focused element. |
| `click` | Click a target from snapshot ref, CSS, locator expression, or structured locator. |
| `dblclick` | Double-click a target. |
| `fill` | Clear and fill a target. |
| `drag` | Drag one target onto another. |
| `drop` | Drop in-memory files or typed data onto a target. |
| `hover` | Hover over a target. |
| `select` | Select one or more option values. |
| `upload` | Upload one or more in-memory files to the active file input or chooser. |
| `check` | Check a checkbox or radio target. |
| `uncheck` | Uncheck a checkbox target. |
| `snapshot` | Capture an accessibility snapshot with stable element refs. filename stores an internal artifact; set save only when the user explicitly requested a local file. |
| `find` | Find matching text in a fresh accessibility snapshot. |
| `eval` | Evaluate a JavaScript function in the page or on a target element. filename stores an internal artifact; set save only when the user explicitly requested a local file. |
| `dialog-accept` | Accept the active dialog, optionally with prompt text. |
| `dialog-dismiss` | Dismiss the active dialog. |
| `go-back` | Navigate back. |
| `go-forward` | Navigate forward. |
| `reload` | Reload the current page. |
| `press` | Press a key or key chord. |
| `keydown` | Hold a keyboard key down. |
| `keyup` | Release a keyboard key. |
| `mousemove` | Move the mouse to viewport CSS coordinates. |
| `mousedown` | Press a mouse button. |
| `mouseup` | Release a mouse button. |
| `mousewheel` | Scroll by viewport CSS deltas. |
| `screenshot` | Capture a viewport, full-page, or element screenshot as an internal artifact. Set save only when the user explicitly requested a local file. |
| `pdf` | Print the current page to an internal PDF artifact. Set save only when the user explicitly requested a local file. |
| `tab-list` | List tabs in the current Chrome window using zero-based indices. |
| `tab-new` | Open and select a new tab. |
| `tab-close` | Close a tab by stable tabId or legacy zero-based index; omitted selects current tab. |
| `tab-select` | Select a tab in the bound window by stable tabId or legacy zero-based index. |
| `requests` | List captured requests since navigation. |
| `request` | Read full request and response details by one-based request index. filename stores an internal artifact; save requires an explicit user request. |
| `request-headers` | Read request headers by one-based request index. filename stores an internal artifact; save requires an explicit user request. |
| `request-body` | Read request body by one-based request index. filename stores an internal artifact; save requires an explicit user request. |
| `response-headers` | Read response headers by one-based request index. filename stores an internal artifact; save requires an explicit user request. |
| `response-body` | Read response body by one-based request index. filename stores an internal artifact; save requires an explicit user request. |
| `console` | List captured console messages at or above a level. |
| `run-code` | Run an async function receiving the bound page facade: locators (CSS/text/role/label/placeholder/alt/title/testId), ref, frameLocator, evaluate, snapshot, observe, point, keyboard, navigation, waitForURL/waitForLoadState/waitForEvent. Locators auto-wait; waitFor supports attached/detached/visible/hidden/enabled/editable/checked; nth accepts negative indices. Upload with locator.setInputFiles([{name, text\|base64\|url, mimeType?}]); no filesystem paths. Returns serializable values or an object reference. Use dedicated tools to save artifacts. |
| `artifact-save` | Save an existing internal artifact to Downloads only when the user explicitly requested it. |
| `act` | Execute deterministic browser steps as one batch, without a step-count limit. Prefer a dedicated command for one action; use act for two or more related actions and include expect steps for outcomes. |
| `result` | Read an exact slice or path from a large tool result stored in the canonical event log. Use the access object returned with $ref. |
| `userscript-list` | List saved user scripts with IDs, match patterns, and enabled state; excludes source code. |
| `userscript-read` | Read one saved user script's complete definition and enabled state by ID. |
| `userscript-create` | Create and enable a user script from a Chrome RegisteredUserScript definition. Fails if the ID exists. |
| `userscript-edit` | Edit specified fields of a saved user script, preserving its enabled state. Replace js and matches as whole fields; set optional fields to null to remove them. |
| `userscript-set-enabled` | Enable or disable a saved user script by ID. Repeating the same state succeeds. |

## run-code 的 page facade

输入为接收 `page` 的单个异步函数表达式。page 提供 snapshot/observe、ref、locator、frameLocator、getByRole/getByText/getByLabel/getByPlaceholder/getByAltText/getByTitle/getByTestId、goto/reload/goBack/goForward、url/title、press/insertText、waitForURL/waitForLoadState/waitForEvent、evaluate。Locator 支持链式查询、filter、first/last/nth、count、waitFor、click/dblclick/hover、fill/clear/press/pressSequentially、check/uncheck/selectOption/dragTo/setInputFiles、focus/blur/scrollIntoViewIfNeeded、textContent/innerText/inputValue/getAttribute、isVisible/isEnabled/isChecked、evaluate。

### 等待与动作完成

Locator 每次操作重新定位，并要求唯一匹配；多匹配会报 strict-match 错误。点击、双击和拖动等待元素可见、稳定、启用且能接收指针输入；填入文本还等待可编辑。ref 绑定既有 DOM 节点，节点移除或文档替换时明确失败。ref 不会自行换成另一个相似元素。

动作返回 `performed: true` 表示输入已发送。click/press/fill 和 goto/reload/goBack/goForward 不等待应用完成异步请求或后续跳转；业务成功仍需重新观察或检查结果。`page.press`/`page.insertText` 直接发送到当前焦点，不会替你定位或等待可编辑元素。`count`、`isVisible`、`isEnabled`、`isChecked` 读取当前状态，不会等到期望值成立；evaluate、focus/blur 和 setInputFiles 也不等待应用的后续副作用。

显式等待使用 `locator.waitFor({ state: 'visible' })`，可用状态包括 attached/detached/visible/hidden/enabled/editable/checked；`waitForURL` 对字符串执行包含匹配，也可传 RegExp；`waitForLoadState` 只支持 domcontentloaded/load。需要观察网页跳转或事件时，先启动对应等待，再触发动作。除 artifact-save 外的独立浏览器命令和 run-code 默认有 10 秒超时，可显式设置 timeoutMs。用户停止或关闭面板会立即中止当前工具。

```js
async (page) => {
  const navigation = page.waitForURL(/\/account(?:[/?#]|$)/);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await navigation;
  await page.getByText('Welcome', { exact: true }).waitFor({ state: 'visible' });
  return await page.snapshot();
}
```

### 隐藏文件输入与文件选择器

page facade 文件输入使用 `{ name, mimeType?, text | base64 | url }`，不接受本机路径；独立 upload 工具另支持已有会话产物 artifactId。setInputFiles 可操作隐藏的 file input，要求它存在且是唯一匹配；多个文件需要网页 input 的 multiple 属性。

```js
async (page) => {
  await page.locator('input[type=file]').setInputFiles({
    name: 'notes.txt', mimeType: 'text/plain', text: 'Browser task notes',
  });
  return await page.snapshot();
}
```

`waitForEvent('filechooser')` 返回 `{ isMultiple(), setFiles(files) }`，可以在按钮打开隐藏 input 的场景中使用。必须先注册等待再点击，避免漏掉已经发生的事件。

```js
async (page) => {
  const waiting = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Choose file' }).click();
  const chooser = await waiting;
  await chooser.setFiles([{ name: 'notes.txt', mimeType: 'text/plain', text: 'Browser task notes' }]);
  return { multiple: chooser.isMultiple(), observation: await page.snapshot() };
}
```

run-code 仅使用绑定窗口和标签页的 page facade；不提供任意 Chrome Extension API、原始 CDP 或备用执行 host。
