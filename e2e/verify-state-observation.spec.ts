import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, type MockResponse } from "./fixtures";

const lastTool = (request: any) => {
  const content = request.messages.findLast((message: any) => message.role === "tool").content;
  return JSON.parse(Array.isArray(content) ? content.find((part: any) => part.type === "text").text : content);
};

test("verify_state distinguishes missing, disabled, checked, text and value observations", async () => {
  test.setTimeout(90_000);
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/automation`);
    await target.evaluate(() => {
      const container = document.createElement("div");
      container.innerHTML = '<input id="disabled" disabled><input type="checkbox" id="unchecked"><input type="checkbox" id="checked" checked><input id="value" value="done"><div id="text">Saved order</div><input id="vanish-disabled"><input type="checkbox" id="vanish-checked"><fieldset disabled><legend><input id="legend-input"></legend><input id="fieldset-input"></fieldset>';
      document.body.append(container);
      const disabled = container.querySelector<HTMLInputElement>("#vanish-disabled")!;
      Object.defineProperty(disabled, "disabled", { get() { disabled.remove(); return true; } });
      const checked = container.querySelector<HTMLInputElement>("#vanish-checked")!;
      Object.defineProperty(checked, "checked", { get() { checked.remove(); return false; } });
    });
    const css = (value: string) => ({ by: "css", value });
    responses.push(
      commandResponse("verify_state", { target: css("#vanish-disabled"), state: "disabled" }, "vanish-disabled"),
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true, result: { verified: false, present: false, actual: null } }); return commandResponse("verify_state", { target: css("#vanish-checked"), state: "unchecked" }, "vanish-checked"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true, result: { verified: false, present: false, actual: null } }); return commandResponse("verify_state", { target: css("#missing"), state: "disabled" }, "missing-disabled"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true, result: { verified: false, present: false, actual: null } }); return commandResponse("verify_state", { target: css("#missing"), state: "hidden" }, "missing-hidden"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true, result: { verified: true, present: false, actual: null } }); return commandResponse("verify_state", { target: css("#missing"), textIncludes: "", timeoutMs: 120 }, "missing-wait"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true, result: { verified: false, present: false, actual: null, timedOut: true } }); return commandResponse("verify_state", { target: { ...css("#inside"), frame: { by: "css", value: "#missing-frame" } }, state: "disabled", timeoutMs: 120 }, "missing-frame"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true, result: { verified: false, present: false, actual: null, timedOut: true } }); return commandResponse("verify_state", { target: css("#disabled"), state: "disabled" }, "disabled"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true, result: { verified: true, present: true, actual: false } }); return commandResponse("verify_state", { target: css("#legend-input"), state: "enabled" }, "legend-enabled"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true, result: { verified: true, present: true, actual: true } }); return commandResponse("verify_state", { target: css("#fieldset-input"), state: "disabled" }, "fieldset-disabled"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true, result: { verified: true, present: true, actual: false } }); return commandResponse("verify_state", { target: css("#unchecked"), state: "unchecked" }, "unchecked"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true, result: { verified: true, present: true, actual: false } }); return commandResponse("verify_state", { target: css("#checked"), state: "checked" }, "checked"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true, result: { verified: true, present: true, actual: true } }); return commandResponse("verify_state", { target: css("#text"), textIncludes: "order" }, "text"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true, result: { verified: true, present: true, actual: "Saved order" } }); return commandResponse("verify_state", { target: css("#value"), valueEquals: "done" }, "value"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true, result: { verified: true, present: true, actual: "done" } }); return textResponse("VERIFY_BOUND_STATE_OK"); },
      textResponse("状态验证"),
    );
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("verify several page states");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("VERIFY_BOUND_STATE_OK", { timeout: 60_000 });
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
