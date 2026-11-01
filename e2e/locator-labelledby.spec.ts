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
    const frameTarget = { by: "css", value: "#local" }, scope = { by: "css", value: "section" };
    responses.push(
      commandResponse("fill", { target: { by: "label", value: "Frame email", exact: true, frame: frameTarget, scope }, value: "frame-value" }, "scoped-frame-fill"),
      (request) => {
        const result = JSON.parse(request.messages.findLast((entry: any) => entry.role === "tool").content);
        expect(result).toMatchObject({ ok: true });
        return commandResponse("click", { target: { by: "role", value: "button", name: "Frame submit", exact: true, frame: frameTarget, scope } }, "scoped-frame-click");
      },
      (request) => {
        const result = JSON.parse(request.messages.findLast((entry: any) => entry.role === "tool").content);
        expect(result).toMatchObject({ ok: true });
        return commandResponse("click", { target: { by: "role", value: "button", name: "Shadow submit", exact: true, scope } }, "scoped-shadow-click");
      },
      (request) => { const result = JSON.parse(request.messages.findLast((entry: any) => entry.role === "tool").content); expect(result).toMatchObject({ ok: true }); return textResponse("LABELLED_BY_SCOPES_OK"); },
      textResponse("框架标签"),
    );
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("fill the frame and click both scoped controls");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("LABELLED_BY_SCOPES_OK", { timeout: 30000 });
    const events = await readEvents(opened.page);
    for (const id of ["scoped-frame-fill", "scoped-frame-click", "scoped-shadow-click"])
      expect(events.find((event) => event.toolCallId === id && ["tool.finished", "tool.failed"].includes(event.type))?.output).toMatchObject({ ok: true });
    const frame = target.frames().find((item) => item.url() === "about:srcdoc")!;
    await expect(frame.locator("input")).toHaveValue("frame-value");
    await expect(frame.locator("body")).toHaveAttribute("data-clicked", "frame");
    await expect(target.locator("#host")).toHaveAttribute("data-clicked", "shadow");
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
