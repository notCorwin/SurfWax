import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, readEvents, type MockResponse } from "./fixtures";
import { itemLine } from "./snapshot-format";

const lastTool = (request: any) => JSON.parse(request.messages.findLast((entry: any) => entry.role === "tool").content);
const button = (items: any[], name: string) => items.find((item) => itemLine(item).includes(`button "${name}"`));

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
        <button data-reveal-clip style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap">Legacy clipped action</button>
        <p data-reveal-clip style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap">Legacy clipped standalone text</p>
        <button data-reveal-clip style="position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap">Modern clipped action</button>
        <p data-reveal-clip style="position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap">Modern clipped standalone text</p>
        <div data-reveal-clip style="position:absolute;left:900px;top:0;width:140px;height:60px;clip:rect(0,0,0,0)"><button id="legacy-fixed" style="position:fixed;left:910px;top:10px">Legacy fixed clipped action</button></div>
        <div data-reveal-clip style="position:absolute;left:900px;top:100px;width:140px;height:60px;clip-path:inset(50%)"><button id="modern-fixed" style="position:fixed;left:10px;top:10px">Modern fixed clipped action</button></div>
        <button id="legacy-partial" style="position:absolute;left:900px;top:250px;width:140px;height:40px;clip:rect(0,70px,40px,0)">Legacy partially clipped action</button>
        <button id="modern-partial" style="position:absolute;left:900px;top:300px;width:140px;height:40px;clip-path:inset(0 50% 0 0)">Modern partially clipped action</button>
        <span id="clipped-label" style="position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap">Clipped accessible name</span><button id="clipped-name-button" aria-labelledby="clipped-label"></button>
        <div style="position:relative"><div style="width:0;height:0;overflow:hidden"><button style="position:absolute;left:400px;top:0">Escaped absolute action</button></div></div>
        <div style="width:0;height:0;overflow:hidden"><button style="position:fixed;left:400px;top:80px">Escaped fixed action</button></div>
        <span id="label" style="display:none">Accessible name</span><button id="hidden-name-button" aria-labelledby="label"></button>
        <button id="aggregate"><span>Visible label</span><span style="opacity:0">Hidden label</span></button>
        <button>Start <span aria-label="Known alias">Original text</span><span style="opacity:0">Nested hidden secret</span> end</button>
        <button id="explicit-name-button" aria-label="Explicit label"><span style="opacity:0">Hidden child</span></button>
        <div style="display:contents"><button>Contents action</button></div>
        <div style="height:1800px"></div><button>Scrollable action</button>
      </main>`;
      const host = document.createElement("div");
      host.style.opacity = "0";
      host.attachShadow({ mode: "open" }).innerHTML = "<button>Shadow hidden action</button>";
      document.querySelector("main")!.append(host);
      document.querySelector("#aggregate")!.addEventListener("click", () => {
        document.body.dataset.aggregated = "yes";
        (document.querySelector("#visible") as HTMLElement).style.opacity = "0";
        (document.querySelector("#transparent")!.parentElement as HTMLElement).style.opacity = "1";
        document.querySelectorAll<HTMLElement>("[data-reveal-clip]").forEach((element) => {
          element.style.clip = "auto";
          element.style.clipPath = "none";
          element.style.width = "auto";
          element.style.height = "auto";
          element.style.overflow = "visible";
        });
      });
    });
    // Confirm Chrome paints part of each partial control while both fixed
    // descendants are fully clipped, independently of the semantic snapshot.
    expect(await target.evaluate(() => ["legacy-fixed", "modern-fixed", "legacy-partial", "modern-partial"].map((id) => {
      const element = document.getElementById(id)!;
      const rect = element.getBoundingClientRect();
      return document.elementFromPoint(rect.left + 5, rect.top + 5) === element;
    }))).toEqual([false, false, true, true]);
    let baseline: any;
    responses.push(
      commandResponse("inspect_page", { full: true, budget: 12000 }, "visibility-before"),
      (request) => {
        baseline = lastTool(request);
        return commandResponse("inspect_page", { full: true, budget: 12000, region: { by: "css", value: "#clipped-name-button" } }, "visibility-clipped-name");
      },
      commandResponse("inspect_page", { full: true, budget: 12000, region: { by: "css", value: "#hidden-name-button" } }, "visibility-hidden-name"),
      commandResponse("inspect_page", { full: true, budget: 12000, region: { by: "css", value: "#explicit-name-button" } }, "visibility-explicit-name"),
      commandResponse("inspect_page", { full: true, budget: 12000, region: { by: "css", value: "#legacy-partial" } }, "visibility-legacy-partial"),
      commandResponse("inspect_page", { full: true, budget: 12000, region: { by: "css", value: "#modern-partial" } }, "visibility-modern-partial"),
      () => {
        const aggregateRef = baseline.items.find((item: any) => itemLine(item).includes("Visible label"))?.id;
        return commandResponse("click", { target: { id: aggregateRef } }, "visibility-change");
      },
      () => commandResponse("inspect_page", { budget: 12000 }, "visibility-delta"),
      commandResponse("inspect_page", { full: true, budget: 12000 }, "visibility-after"),
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
    expect(changed, JSON.stringify(changed)).toHaveProperty("pageSnapshot");
    const delta = changed.pageSnapshot;
    expect(output("visibility-delta")).toMatchObject({ mode: "delta", baseObservationId: delta.observationId });
    const after = output("visibility-after");
    expect(before?.mode).toBe("full");
    expect(button(before.items, "Visible action")?.id).toBeTruthy();
    expect(button(before.items, "Transparent action")).toBeUndefined();
    expect(JSON.stringify(before.items)).not.toContain("Hidden input value");
    expect(button(before.items, "Clipped action")).toBeUndefined();
    expect(button(before.items, "Border clipped action")).toBeUndefined();
    for (const text of ["Legacy clipped action", "Legacy clipped standalone text", "Modern clipped action", "Modern clipped standalone text", "Legacy fixed clipped action", "Modern fixed clipped action"]) {
      expect(JSON.stringify(before.items)).not.toContain(text);
    }
    for (const [id, prefix] of [["visibility-legacy-partial", "Legacy"], ["visibility-modern-partial", "Modern"]]) {
      const page = output(id), row = page?.items?.find((item: any) => /\bbutton(?:\s|$)/.test(itemLine(item)) && item.id);
      expect(row?.id).toEqual(expect.any(String));
      expect(itemLine(row).includes(prefix) || itemLine(row).includes("[name=unknown]")).toBe(true);
      expect(itemLine(row)).not.toContain("partially clipped action");
    }
    for (const [id, hidden] of [["visibility-clipped-name", "Clipped accessible name"], ["visibility-hidden-name", "Accessible name"], ["visibility-explicit-name", "Explicit label"]]) {
      const page = output(id);
      expect(page?.items?.some((item: any) => /\bbutton(?:\s|$)/.test(itemLine(item)) && typeof item.id === "string")).toBe(true);
      expect(JSON.stringify(page.items)).not.toContain(hidden);
    }
    expect(JSON.stringify(before.items)).not.toContain("Clipped accessible name");
    expect(button(before.items, "Escaped absolute action")?.id).toBeTruthy();
    expect(button(before.items, "Escaped fixed action")?.id).toBeTruthy();
    expect(button(before.items, "Scrollable action")).toBeUndefined();
    expect(button(before.items, "Contents action")?.id).toBeTruthy();
    expect(button(before.items, "Shadow hidden action")).toBeUndefined();
    expect(JSON.stringify(before.items)).not.toContain("Accessible name");
    expect(button(before.items, "Visible label")?.id).toBeTruthy();
    expect(JSON.stringify(before.items)).not.toContain("Hidden label");
    expect(button(before.items, "Start Original text end")?.id).toBeTruthy();
    expect(JSON.stringify(before.items)).not.toContain("Known alias");
    expect(JSON.stringify(before.items)).not.toContain("Nested hidden secret");
    expect(JSON.stringify(before.items)).not.toContain("Explicit label");
    expect(changed).toMatchObject({ ok: true });
    expect(await target.locator("body").getAttribute("data-aggregated")).toBe("yes");
    expect(button(changed.pageSnapshot.items, "Visible action")).toBeUndefined();
    expect(button(changed.pageSnapshot.items, "Transparent action")?.id).toBeTruthy();
    for (const name of ["Legacy clipped action", "Modern clipped action", "Legacy fixed clipped action", "Modern fixed clipped action"]) {
      expect(button(changed.pageSnapshot.items, name)?.id).toBeTruthy();
      expect(button(delta.items, name)?.change).toBe("added");
    }
    for (const text of ["Legacy clipped standalone text", "Modern clipped standalone text"]) {
      expect(JSON.stringify(changed.pageSnapshot.items)).toContain(text);
      expect(delta.items.some((item: any) => item.change === "added" && itemLine(item).includes(text))).toBe(true);
    }
    expect(delta?.mode).toBe("delta");
    const previouslyVisible = button(before.items, "Visible action");
    expect(previouslyVisible?.id).toEqual(expect.any(String));
    expect(delta.items.find((item: any) => item.id === previouslyVisible.id)).toMatchObject({ id: previouslyVisible.id, line: "", change: "removed" });
    expect(button(delta.items, "Transparent action")?.change).toBe("added");
    expect(button(after.items, "Visible action")).toBeUndefined();
    expect(button(after.items, "Transparent action")?.id).toBeTruthy();
    expect(button(after.items, "Scrollable action")).toBeUndefined();
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
      commandResponse("inspect_page", { full: true, budget: 12000 }, "frame-visible"),
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
    expect(button(output("frame-show").pageSnapshot.items, "Frame action")?.id).toBeTruthy();
    expect(button(output("frame-show").pageSnapshot.items, "Nested frame action")?.id).toBeTruthy();
    expect(button(output("frame-visible").items, "Frame action")?.id).toBeTruthy();
    expect(button(output("frame-visible").items, "Nested frame action")?.id).toBeTruthy();
    expect(JSON.stringify(output("frame-visible").items)).toContain("same origin");
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});
