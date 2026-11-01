import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, readEvents, type MockResponse } from "./fixtures";

const lastTool = (request: any) => JSON.parse(request.messages.findLast((entry: any) => entry.role === "tool").content);
const button = (items: any[], name: string) => items.find((item) => item.line.includes(`button "${name}"`));

test("snapshots reflect rendered visibility and update when content is shown or hidden", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    await target.evaluate(() => {
      document.body.innerHTML = `<main>
        <button id="visible">Visible action</button>
        <div style="opacity:0"><button id="transparent">Transparent action</button></div>
        <input style="opacity:0" aria-label="Hidden input" value="Hidden input value">
        <div style="width:0;height:0;overflow:hidden"><button>Clipped action</button></div>
        <div style="width:0;height:0;overflow:hidden;border:12px solid red"><button>Border clipped action</button></div>
        <div style="position:relative"><div style="width:0;height:0;overflow:hidden"><button style="position:absolute;left:400px;top:0">Escaped absolute action</button></div></div>
        <div style="width:0;height:0;overflow:hidden"><button style="position:fixed;left:400px;top:80px">Escaped fixed action</button></div>
        <div style="height:1800px"></div><button>Scrollable action</button>
        <span id="label" style="display:none">Accessible name</span><button aria-labelledby="label"></button>
        <button id="aggregate"><span>Visible label</span><span style="opacity:0">Hidden label</span></button>
        <button aria-label="Explicit label"><span style="opacity:0">Hidden child</span></button>
        <div style="display:contents"><button>Contents action</button></div>
      </main>`;
      const host = document.createElement("div");
      host.style.opacity = "0";
      host.attachShadow({ mode: "open" }).innerHTML = "<button>Shadow hidden action</button>";
      document.querySelector("main")!.append(host);
      document.querySelector("#aggregate")!.addEventListener("click", () => {
        document.body.dataset.aggregated = "yes";
        (document.querySelector("#visible") as HTMLElement).style.opacity = "0";
        (document.querySelector("#transparent")!.parentElement as HTMLElement).style.opacity = "1";
      });
    });
    let baseline: any;
    responses.push(
      commandResponse("inspect_page", { budget: 12000 }, "visibility-before"),
      (request) => {
        baseline = lastTool(request);
        const aggregateRef = baseline.items.find((item: any) => item.line.includes("Visible label"))?.ref;
        return commandResponse("click", { target: { ref: aggregateRef } }, "visibility-change");
      },
      () => commandResponse("inspect_page", { since: baseline.observationId, budget: 12000 }, "visibility-delta"),
      commandResponse("inspect_page", { budget: 12000 }, "visibility-after"),
      textResponse("VISIBILITY_OK"),
      textResponse("可见性测试"),
    );
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Inspect the page and observe visibility changes");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("VISIBILITY_OK", { timeout: 45_000 });
    const events = await readEvents(opened.page);
    const output = (id: string) => events.find((event) => ["tool.finished", "tool.failed"].includes(event.type) && event.toolCallId === id)?.output;
    const before = output("visibility-before");
    const changed = output("visibility-change");
    const delta = output("visibility-delta");
    const after = output("visibility-after");
    expect(before?.mode).toBe("full");
    expect(button(before.items, "Visible action")?.ref).toBeTruthy();
    expect(button(before.items, "Transparent action")).toBeUndefined();
    expect(JSON.stringify(before.items)).not.toContain("Hidden input value");
    expect(button(before.items, "Clipped action")).toBeUndefined();
    expect(button(before.items, "Border clipped action")).toBeUndefined();
    expect(button(before.items, "Escaped absolute action")?.ref).toBeTruthy();
    expect(button(before.items, "Escaped fixed action")?.ref).toBeTruthy();
    expect(button(before.items, "Scrollable action")?.ref).toBeTruthy();
    expect(button(before.items, "Contents action")?.ref).toBeTruthy();
    expect(button(before.items, "Shadow hidden action")).toBeUndefined();
    expect(button(before.items, "Accessible name")?.ref).toBeTruthy();
    expect(button(before.items, "Visible label")?.ref).toBeTruthy();
    expect(JSON.stringify(before.items)).not.toContain("Hidden label");
    expect(button(before.items, "Explicit label")?.ref).toBeTruthy();
    expect(changed).toMatchObject({ ok: true });
    expect(await target.locator("body").getAttribute("data-aggregated")).toBe("yes");
    expect(button(changed.pageSnapshot.items, "Visible action")).toBeUndefined();
    expect(button(changed.pageSnapshot.items, "Transparent action")?.ref).toBeTruthy();
    expect(delta?.mode).toBe("delta");
    expect(button(delta.items, "Visible action")?.change).toBe("removed");
    expect(button(delta.items, "Transparent action")?.change).toBe("added");
    expect(button(after.items, "Visible action")).toBeUndefined();
    expect(button(after.items, "Transparent action")?.ref).toBeTruthy();
    expect(button(after.items, "Scrollable action")?.ref).toBeTruthy();
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});

test("omits hidden same-origin and cross-origin frames and includes them after they become visible", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/complex`);
    const crossOriginFrame = target.locator('iframe[src*="localhost"]');
    const sameOriginFrame = target.locator('iframe[src="/same-frame"]');
    await expect(target.frameLocator('iframe[src*="localhost"]').getByRole("button", { name: "Frame action" })).toBeVisible();
    await target.frameLocator('iframe[src="/same-frame"]').locator("body").evaluate((body) => {
      const nested = document.createElement("iframe");
      nested.srcdoc = "<!doctype html><button>Nested frame action</button>";
      body.append(nested);
    });
    await expect(target.frameLocator('iframe[src="/same-frame"]').frameLocator("iframe").getByRole("button", { name: "Nested frame action" })).toBeVisible();
    await crossOriginFrame.evaluate((element) => { (element as HTMLElement).style.opacity = "0"; });
    await sameOriginFrame.evaluate((element) => { (element as HTMLElement).style.opacity = "0"; });
    await target.evaluate(() => {
      const show = document.createElement("button");
      show.textContent = "Show frames";
      show.addEventListener("click", () => {
        (document.querySelector('iframe[src*="localhost"]') as HTMLElement).style.opacity = "1";
        (document.querySelector('iframe[src="/same-frame"]') as HTMLElement).style.opacity = "1";
      });
      document.body.append(show);
    });
    responses.push(
      commandResponse("inspect_page", { budget: 12000 }, "frame-hidden"),
      commandResponse("click", { target: { by: "role", value: "button", name: "Show frames" } }, "frame-show"),
      commandResponse("inspect_page", { budget: 12000 }, "frame-visible"),
      textResponse("FRAME_VISIBILITY_OK"),
      textResponse("框架可见性测试"),
    );
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Inspect the frame before and after it is shown");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("FRAME_VISIBILITY_OK", { timeout: 45_000 });
    const events = await readEvents(opened.page);
    const output = (id: string) => events.find((event) => ["tool.finished", "tool.failed"].includes(event.type) && event.toolCallId === id)?.output;
    expect(button(output("frame-hidden").items, "Frame action")).toBeUndefined();
    expect(button(output("frame-hidden").items, "Nested frame action")).toBeUndefined();
    expect(JSON.stringify(output("frame-hidden").items)).not.toContain("same origin");
    expect(output("frame-show")).toMatchObject({ ok: true });
    expect(button(output("frame-show").pageSnapshot.items, "Frame action")?.ref).toBeTruthy();
    expect(button(output("frame-show").pageSnapshot.items, "Nested frame action")?.ref).toBeTruthy();
    expect(button(output("frame-visible").items, "Frame action")?.ref).toBeTruthy();
    expect(button(output("frame-visible").items, "Nested frame action")?.ref).toBeTruthy();
    expect(JSON.stringify(output("frame-visible").items)).toContain("same origin");
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});
