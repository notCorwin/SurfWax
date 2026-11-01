import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, readEvents, type MockResponse } from "./fixtures";

test("allows page interaction after a document rewrite during a run", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/automation`);
    const markup = '<!doctype html><script>window.userKeys=0;window.addEventListener("keydown",()=>window.userKeys++,true)</script><input id="user-input"><button id="user-target" style="position:fixed;left:30px;top:60px" onclick="window.userClicks=(window.userClicks||0)+1">Target</button>';
    await target.evaluate((html) => {
      const button = document.createElement("button"); button.id = "rewrite-document"; button.textContent = "Rewrite document";
      button.onclick = () => { document.open(); document.write(html); document.close(); };
      document.body.append(button);
    }, markup);
    responses.push(
      commandResponse("click", { target: { by: "css", value: "#rewrite-document" } }, "rewrite"),
      (request) => {
        const result = JSON.parse(request.messages.findLast((entry: any) => entry.role === "tool").content);
        expect(result).toMatchObject({ ok: true });
        return commandResponse("verify_state", { target: { by: "css", value: "#user-target" }, textIncludes: "NEVER_MATCHES", timeoutMs: 9000 }, "rewrite-and-wait");
      },
      (request) => {
        const result = JSON.parse(request.messages.findLast((entry: any) => entry.role === "tool").content);
        expect(result).toMatchObject({ ok: true, result: { verified: false, timedOut: true } });
        return textResponse("REWRITE_WAIT_DONE");
      },
    );
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("rewrite the document and wait");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(target.locator("#user-target")).toBeVisible();
    await expect.poll(async () => (await readEvents(opened.page)).some((event) => event.type === "tool.started" && event.toolCallId === "rewrite-and-wait")).toBe(true);
    await target.evaluate((markup) => { document.open(); document.write(markup); document.close(); }, markup);
    await expect(target.locator("#user-target")).toBeVisible();
    await target.mouse.click(45, 70);
    expect(await target.evaluate(() => (window as any).userClicks ?? 0)).toBe(1);
    await target.evaluate(() => document.querySelector<HTMLInputElement>("#user-input")!.focus());
    await target.keyboard.press("a");
    await expect(target.locator("#user-input")).toHaveValue("a");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("REWRITE_WAIT_DONE", { timeout: 20000 });
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
