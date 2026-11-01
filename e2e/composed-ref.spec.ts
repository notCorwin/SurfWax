import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, type MockResponse } from "./fixtures";

const lastTool = (request: any) => {
  const content = request.messages.findLast((message: any) => message.role === "tool").content;
  return JSON.parse(Array.isArray(content) ? content.find((part: any) => part.type === "text").text : content);
};

test("finds targets in scoped rows, follows a reference, and rejects a stale row reference", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/automation`);
    await target.evaluate(() => {
      const section = document.createElement("section");
      section.innerHTML = '<article tabindex="0" aria-label="First row"><div class="inner"><span class="needle">match</span><button>Safe target</button><button>Extra target</button></div></article><article tabindex="0" aria-label="Second row"><span>Safe target note</span><button>Other target</button></article>';
      const shadowRow = document.createElement("article");
      shadowRow.setAttribute("tabindex", "0"); shadowRow.setAttribute("aria-label", "Shadow row");
      const host = document.createElement("div");
      host.attachShadow({ mode: "open" }).innerHTML = '<button>Shadow target</button>';
      shadowRow.append(host); section.append(shadowRow);
      section.addEventListener("click", () => { document.body.dataset.clicks = String(Number(document.body.dataset.clicks || 0) + 1); });
      const change = document.createElement("button"); change.id = "change-row"; change.textContent = "Change row";
      change.onclick = () => section.querySelector("article")!.setAttribute("aria-label", "Changed row");
      document.body.append(section, change);
    });
    let rowRef = "", buttonRef = "";
    responses.push(
      commandResponse("inspect_page", {}, "inspect"),
      (request) => {
        const items = lastTool(request).items;
        rowRef = items.find((item: any) => item.line.includes('article "First row"'))?.ref;
        buttonRef = items.find((item: any) => item.line.includes('button "Safe target"'))?.ref;
        expect(rowRef).toEqual(expect.any(String)); expect(buttonRef).toEqual(expect.any(String));
        return commandResponse("count_elements", { target: { by: "role", value: "button", name: "Safe target", scope: { by: "role", value: "article", name: "First row" } } }, "scoped-button");
      },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true, result: 1 }); return commandResponse("count_elements", { target: { by: "css", value: ".needle", scope: { by: "role", value: "article", name: "First row" } } }, "scoped-needle"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true, result: 1 }); return commandResponse("count_elements", { target: { by: "role", value: "button", name: "Shadow target", scope: { by: "role", value: "article", name: "Shadow row" } } }, "shadow-button"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true, result: 1 }); return commandResponse("click", { target: { ref: buttonRef } }, "referenced-button"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true }); return commandResponse("click", { target: { by: "css", value: "#change-row" } }, "change-row"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true }); return commandResponse("count_elements", { target: { ref: rowRef } }, "stale-row"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: false, error: { code: "stale-ref" } }); return textResponse("COMPOSED_REF_OK"); },
      textResponse("Scoped references"),
    );
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Check scoped targets and reference safety");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("COMPOSED_REF_OK", { timeout: 90000 });
    await expect(target.locator("body")).toHaveAttribute("data-clicks", "1");
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("locates a scoped target in an out-of-process frame and follows its reference", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/complex`);
    await target.evaluate(() => { const button = document.createElement("button"); button.textContent = "Outer target"; document.body.append(button); });
    const frame = target.frames().find((value) => value.url().includes("localhost"))!;
    await frame.evaluate(() => { document.body.innerHTML = '<article tabindex="0" aria-label="Frame row"><button>Frame target</button></article>'; document.querySelector("button")!.onclick = () => { document.body.dataset.clicked = "yes"; }; });
    const sameFrame = target.frames().find((value) => value.url().includes("same-frame"))!;
    await sameFrame.evaluate(() => { document.body.innerHTML = '<article><button>Same frame target</button></article>'; });
    let frameRef = "";
    responses.push(
      commandResponse("inspect_page", {}, "inspect-frame"),
      (request) => {
        frameRef = lastTool(request).items.find((item: any) => item.line.includes('button "Frame target"'))?.ref;
        expect(frameRef).toEqual(expect.any(String));
        return commandResponse("count_elements", { target: { by: "role", value: "button", name: "Frame target", scope: { by: "role", value: "article", name: "Frame row" }, frame: { by: "css", value: 'iframe[src*="localhost"]' } } }, "frame-scoped");
      },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true, result: 1 }); return commandResponse("count_elements", { target: { by: "role", value: "button", name: "Same frame target", frame: { by: "css", value: 'iframe[src="/same-frame"]' } } }, "same-frame"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true, result: 1 }); return commandResponse("click", { target: { ref: frameRef } }, "frame-reference"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true }); return textResponse("COMPOSED_FRAME_REF_OK"); },
      textResponse("Frame references"),
    );
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Check scoped targets and references in frames");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("COMPOSED_FRAME_REF_OK", { timeout: 90000 });
    await expect(frame.locator("body")).toHaveAttribute("data-clicked", "yes");
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
