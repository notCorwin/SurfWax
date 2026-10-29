import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, readEvents, type MockResponse } from "./fixtures";

test("scoped locators resolve aria-labelledby in their own document or shadow root", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/automation`);
    await target.evaluate(() => {
      const decoy = document.createElement("span"); decoy.id = "shared-name"; decoy.textContent = "Wrong page label"; document.body.append(decoy);
      const frame = document.createElement("iframe"); frame.id = "local";
      frame.srcdoc = `<section><span id="shared-name">Frame email</span><input aria-labelledby="shared-name"><span id="button-name">Frame submit</span><button aria-labelledby="button-name" onclick="document.body.dataset.clicked='frame'"></button></section>`;
      document.body.append(frame);
      const host = document.createElement("div"); host.id = "host"; document.body.append(host);
      const shadow = host.attachShadow({ mode: "open" });
      shadow.innerHTML = `<section><span id="shared-name">Shadow submit</span><button aria-labelledby="shared-name"></button></section>`;
      shadow.querySelector("button")!.addEventListener("click", () => { host.dataset.clicked = "shadow"; });
    });
    await expect.poll(() => target.frames().some((frame) => frame.url() === "about:srcdoc")).toBe(true);
    const code = `const frame = page.frameLocator('#local').locator('section');
await frame.getByLabel('Frame email', {exact:true}).fill('frame-value');
await frame.getByRole('button', {name:'Frame submit', exact:true}).click();
await page.locator('#host').locator('section').getByRole('button', {name:'Shadow submit', exact:true}).click();
return 'scoped-ok';`;
    responses.push(commandResponse("execute_program", { code, timeoutMs: 10000 }, "scoped-labelledby"), textResponse("LABELLED_BY_SCOPES_OK"), textResponse("框架标签"));
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("fill the frame and click both scoped controls");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("LABELLED_BY_SCOPES_OK", { timeout: 30000 });
    expect((await readEvents(opened.page)).find((event) => event.toolCallId === "scoped-labelledby" && ["tool.finished", "tool.failed"].includes(event.type))?.output).toMatchObject({ ok: true, result: "scoped-ok" });
    const frame = target.frames().find((item) => item.url() === "about:srcdoc")!;
    await expect(frame.locator("input")).toHaveValue("frame-value");
    await expect(frame.locator("body")).toHaveAttribute("data-clicked", "frame");
    await expect(target.locator("#host")).toHaveAttribute("data-clicked", "shadow");
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
