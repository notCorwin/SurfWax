import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, type MockResponse } from "./fixtures";

const lastTool = (request: any) => JSON.parse(request.messages.findLast((entry: any) => entry.role === "tool").content);

test("read_checked distinguishes absent, unchecked, checked and unsupported elements", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/automation`);
    await target.evaluate(() => {
      const inputs = document.createElement("div");
      inputs.innerHTML = '<input type="checkbox" id="no"><input type="checkbox" id="yes" checked><button id="invalid">Button</button>';
      document.body.append(inputs);
    });
    const element = (value: string) => ({ by: "css", value });
    responses.push(
      commandResponse("read_checked", { target: element("#missing") }, "missing"),
      (request) => { expect(lastTool(request)).toMatchObject({ ok: false, error: { code: "not-found" } }); return commandResponse("read_checked", { target: element("#no") }, "unchecked"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true, result: false }); return commandResponse("read_checked", { target: element("#yes") }, "checked"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true, result: true }); return commandResponse("read_checked", { target: element("#invalid") }, "unsupported"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: false, error: { code: "invalid-checked-state" } }); return commandResponse("verify_state", { target: element("#missing"), state: "unchecked" }, "verify-missing"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true, result: { verified: false, actual: null, present: false } }); return textResponse("CHECKED_READ_TRUTH_OK"); },
      textResponse("读取勾选状态"),
    );
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("read and verify checkbox states");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("CHECKED_READ_TRUTH_OK", { timeout: 45000 });
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
