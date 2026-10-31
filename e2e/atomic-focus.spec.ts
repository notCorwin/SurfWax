import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, type MockResponse } from "./fixtures";

const lastTool = (request: any) => {
  const content = request.messages.findLast((entry: any) => entry.role === "tool").content;
  return JSON.parse(Array.isArray(content) ? content.find((part: any) => part.type === "text").text : content);
};

test("focuses and blurs individual elements without clicking or typing", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    await target.evaluate(() => {
      document.body.innerHTML = '<input id="validate" value="ready"><canvas id="canvas" tabindex="0"></canvas>';
      const input = document.querySelector<HTMLInputElement>("#validate")!;
      const canvas = document.querySelector<HTMLCanvasElement>("#canvas")!;
      const events: string[] = [];
      (window as any).focusEvents = events;
      for (const element of [input, canvas]) for (const name of ["focus", "blur", "click", "keydown", "keyup", "input"])
        element.addEventListener(name, () => { events.push(`${element.id}:${name}`); });
      input.addEventListener("blur", () => { input.dataset.validated = input.value; });
    });
    const input = { by: "css", value: "#validate" };
    const canvas = { by: "css", value: "#canvas" };
    responses.push(
      commandResponse("focus_element", { target: input }, "focus-input"),
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true }); return commandResponse("blur_element", { target: input }, "blur-input"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true }); return commandResponse("focus_element", { target: canvas }, "focus-canvas"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true }); return commandResponse("focus_element", { target: { by: "css", value: "#missing" }, timeoutMs: 1200 }, "missing-focus"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: false, error: expect.any(Object) }); return textResponse("FOCUS_ACTIONS_OK"); },
      textResponse("焦点动作"),
    );
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Validate the input and focus the canvas");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("FOCUS_ACTIONS_OK", { timeout: 45000 });
    expect(await target.evaluate(() => ({ events: (window as any).focusEvents, active: document.activeElement?.id,
      validated: document.querySelector<HTMLInputElement>("#validate")?.dataset.validated }))).toEqual({
      events: ["validate:focus", "validate:blur", "canvas:focus"], active: "canvas", validated: "ready",
    });
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("a background focus can hand off a blocking dialog and finish", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    target.on("dialog", () => {});
    await target.evaluate(() => {
      document.body.innerHTML = '<input id="focus-dialog">';
      document.querySelector<HTMLInputElement>("#focus-dialog")!.addEventListener("focus", () => {
        document.body.dataset.answer = prompt("Focus question?") ?? "cancelled";
      });
    });
    let subscriptionId = "", jobId = "", polls = 0;
    const poll: MockResponse = (request) => {
      const result = lastTool(request);
      if (result.terminal) { expect(result).toMatchObject({ ok: true, state: "succeeded" }); return textResponse("FOCUS_DIALOG_OK"); }
      responses.unshift(poll);
      return commandResponse("get_job", { jobId, after: result.nextCursor, waitMs: 10000 }, `focus-poll-${++polls}`);
    };
    responses.push(
      commandResponse("subscribe_event", { kind: "dialog" }, "subscribe-focus-dialog"),
      (request) => { subscriptionId = lastTool(request).subscriptionId; return commandResponse("focus_element", { target: { by: "css", value: "#focus-dialog" }, background: true, timeoutMs: 30000 }, "background-focus"); },
      (request) => { const result = lastTool(request); expect(result).toMatchObject({ accepted: true, complete: false }); jobId = result.jobId; return commandResponse("wait_event", { subscriptionId, waitMs: 10000 }, "wait-focus-dialog"); },
      (request) => { const dialog = lastTool(request).events.find((item: any) => item.kind === "dialog"); expect(dialog.payload.message).toBe("Focus question?"); return commandResponse("handle_dialog", { dialogId: dialog.payload.dialogId, accept: true, prompt: "confirmed" }, "answer-focus-dialog"); },
      (request) => { expect(lastTool(request)).toMatchObject({ state: "completed" }); return commandResponse("get_job", { jobId }, "focus-job"); },
      poll, textResponse("焦点对话框"),
    );
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Focus the input and answer its prompt");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("FOCUS_DIALOG_OK", { timeout: 45000 });
    await expect(target.locator("body")).toHaveAttribute("data-answer", "confirmed");
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("rejects an unfocusable target and verifies focus through a frame and shadow root", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    await target.evaluate(() => {
      document.body.innerHTML = '<input id="disabled" disabled><div id="host"></div><iframe id="frame" srcdoc="<input id=inner>"></iframe>';
      document.querySelector("#host")!.attachShadow({ mode: "open" }).innerHTML = '<input id="shadow-input">';
    });
    await expect(target.locator("#frame").contentFrame().locator("#inner")).toBeVisible();
    responses.push(
      commandResponse("focus_element", { target: { by: "css", value: "#disabled" } }, "focus-disabled"),
      (request) => { expect(lastTool(request)).toMatchObject({ ok: false }); return commandResponse("focus_element", { target: { by: "css", value: "#shadow-input" } }, "focus-shadow"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true }); return commandResponse("focus_element", { target: { by: "css", value: "#inner", frame: { by: "css", value: "#frame" } } }, "focus-frame"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true }); return textResponse("FOCUS_BOUNDARIES_OK"); },
      textResponse("焦点边界"),
    );
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Focus the available elements");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("FOCUS_BOUNDARIES_OK", { timeout: 45000 });
    await expect(target.locator("#frame").contentFrame().locator("#inner")).toBeFocused();
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
