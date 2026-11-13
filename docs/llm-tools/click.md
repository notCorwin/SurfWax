# Click

> Before refactoring, we should always remember, this tool is built for LLM.

## Limitations of the following implementations

Here are the implementation approaches that most readily come to mind, and why they are unsuitable as the technical foundation for this project. Always remember that the tool’s user is an LLM, not a person or a piece of code.

### Chrome DevTools Protocol (CDP)

Limitations of using `chrome.debugger` with `Input.dispatchMouseEvent`:

- Mouse input is coordinate-based, although CDP also provides DOM inspection and element-targeting capabilities.
- A race condition may occur between locating the target and dispatching the click:
  - Pointer movement may trigger hover effects or other changes to the page.
  - The target may move, disappear, or become obstructed before the click is dispatched.
  - Revalidating the target reduces this risk but cannot eliminate it entirely.
- Successful command execution does not guarantee that the intended interaction succeeded.
- Requires the `debugger` permission and a target that permits debugger attachment.
- Some websites may detect or restrict automation, but CDP usage alone does not establish that automation will be detected.

### `element.click()`

- Fires a synthetic `click` event without reproducing the preceding pointer movement, press, and release events.
- The generated event has `isTrusted: false`.
- May fail to trigger interactions that depend on pointer events or trusted user activation.
- Can trigger standard element activation behavior, but does not verify that the intended result occurred.

### `dispatchEvent()`

- Requires manually constructing and dispatching synthetic events.
- The LLM should not be responsible for assembling browser interaction sequences.
- A typical pointer-based click involves events such as `pointerdown → mousedown → pointerup → mouseup → click`, but the actual sequence and behavior depend on the interaction.
- Synthetic events have `isTrusted: false` and cannot fully reproduce browser-managed input behavior.
- Successful event dispatch does not guarantee successful interaction.

## Assumption

- The task can be done without screenshot.


