# Surf Wax 工具参考

此文件由真实工具 registry 自动生成（npm run docs:tools）。当前暴露 49 个独立工具，全部操作本轮绑定的 Chrome 窗口与目标标签页。

运行中可通过 tab-select 显式切换目标；其他操作不会因用户切换活动标签页而改变目标。截图和 PDF 默认保存为会话内部产物；明确保存时才请求 downloads 权限。网页与网络内容原样保留在 canonical event log，大结果可使用 result 精确读取。

| 工具 | 定位 |
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
| `act` | Execute 1-100 deterministic browser steps as one batch. Prefer a dedicated command for one action; use act for two or more related actions and include expect steps for outcomes. |
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

显式等待使用 `locator.waitFor({ state: 'visible' })`，可用状态包括 attached/detached/visible/hidden/enabled/editable/checked；`waitForURL` 对字符串执行包含匹配，也可传 RegExp；`waitForLoadState` 只支持 domcontentloaded/load。需要观察网页跳转或事件时，先启动对应等待，再触发动作。除 artifact-save 外的独立浏览器命令和 run-code 默认有 10 秒超时，可显式设置 timeoutMs。首次保存需要人工下载授权时，停止当前命令的超时计时；用户停止或关闭面板仍立即中止等待。

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
