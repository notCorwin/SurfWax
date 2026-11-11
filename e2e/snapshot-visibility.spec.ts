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
    // Separated painted fragments stay structured; a hidden span leaves a
    // geometric gap, so there is deliberately no invented contiguous name.
    const fragmented = before.items.find((item: any) => item.role === "button"
      && item.textParts?.map((part: any) => part.text).join("") === "Start Original text end");
    expect(fragmented?.id).toBeTruthy();
    expect(fragmented.name).toBeUndefined();
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
    expect(delta.items.find((item: any) => item.id === previouslyVisible.id)).toEqual({ id: previouslyVisible.id, change: "removed" });
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

test("automatic actionable contexts permit a unique click and find observes recycled rows", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const ledger: string[] = [];
  provider.server.on("request", request => {
    const clicked = new URL(request.url ?? "/", provider.origin).searchParams.get("clicked");
    if (clicked) ledger.push(clicked);
  });
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    await target.evaluate(() => {
      document.body.innerHTML = `<ul><li><span>JOB-A Waiting</span><span hidden>Hidden decoy</span><span aria-label="ARIA-only decoy"></span><button>Process</button></li><li><span>JOB-B Next</span><button>Process</button></li></ul>`;
      document.querySelectorAll("button").forEach(button => button.onclick = () => {
        document.body.dataset.clicked = button.parentElement!.querySelector("span")!.textContent!;
        void fetch(`/target?clicked=${encodeURIComponent(document.body.dataset.clicked)}`);
        document.querySelectorAll("li").forEach((row, i) => row.querySelector("span")!.textContent = i ? "JOB-D Waiting" : "JOB-C Next");
        document.querySelector("ul")!.prepend(document.querySelectorAll("li")[1]!);
      });
    });
    const found: any[] = [];
    const check = (request: any, expected: string[]) => {
      const result = lastTool(request);
      found.push(result);
      expect(result.elements).toHaveLength(2);
      const labels = result.elements.map((element: any) => {
        expect(element).toMatchObject({ actionable: true, context: { status: "verified", observationId: result.pageSnapshot.observationId, container: { role: "listitem" } } });
        expect(element.context.snapshotItemId).toBeTruthy();
        const labels = element.context.visibleLabels.map((label: any) => label.text).join(" ");
        expect(labels).not.toMatch(/Hidden decoy|ARIA-only decoy/);
        return labels;
      });
      expected.forEach(label => expect(labels.some((text: string) => text.includes(label)), JSON.stringify(result)).toBe(true));
      const { pageSnapshot, ...core } = result;
      expect(Buffer.byteLength(JSON.stringify(core))).toBeLessThanOrEqual(8192);
      expect(Buffer.byteLength(JSON.stringify(pageSnapshot))).toBeLessThanOrEqual(16384);
      return result;
    };
    responses.push(
      commandResponse("get_page_info", {}, "row-info"),
      request => {
        const snapshot = lastTool(request).pageSnapshot;
        const pairs = snapshot.actionContexts.targets;
        expect(pairs).toHaveLength(2);
        expect(JSON.stringify(pairs)).not.toMatch(/Hidden decoy|ARIA-only decoy/);
        const selected = pairs.find((pair: any) => pair.context.visibleLabels.some((label: any) => label.text.includes("JOB-B Next")));
        expect(selected.context).toMatchObject({ observationId: snapshot.observationId, status: "verified" });
        expect(snapshot.items.some((item: any) => item.id === selected.targetId && item.actionable)).toBe(true);
        expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThanOrEqual(16384);
        return commandResponse("click", { target: { id: selected.targetId } }, "row-click");
      },
      commandResponse("find_elements", { target: { by: "role", value: "button", name: "Process", exact: true } }, "row-find-recycled"),
      request => { check(request, ["JOB-C Next", "JOB-D Waiting"]); return textResponse("ROW_CONTEXT_OK"); },
      textResponse("候选关联"),
    );
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Find the Process button on JOB-B Next, click it, and inspect current rows");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("ROW_CONTEXT_OK", { timeout: 60_000 });
    expect(await target.getAttribute("body", "data-clicked")).toBe("JOB-B Next");
    await expect.poll(() => ledger).toEqual(["JOB-B Next"]);
    expect(found[0].pageSnapshot.mode).toBe("delta");
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

for (const selector of ['iframe[src="/same-frame"]', 'iframe[src*="localhost"]']) {
  test(`candidate context preserves actual document identity in ${selector}`, async () => {
    const responses: MockResponse[] = [];
    const provider = await startProvider(responses);
    const opened = await openExtension();
    try {
      const target = await opened.context.newPage();
      await target.goto(`${provider.origin}/complex`);
      const frame = await (await target.locator(selector).elementHandle())!.contentFrame();
      await frame!.waitForLoadState("load");
      await frame!.evaluate(() => {
        document.body.innerHTML = `<ul><li><span>FRAME-A Waiting</span><button>Process</button></li><li><span>FRAME-B Next</span><span style="opacity:0">Transparent decoy</span><button>Process</button></li></ul>`;
        document.querySelectorAll("button").forEach(button => button.onclick = () => document.body.dataset.clicked = button.parentElement!.querySelector("span")!.textContent!);
      });
      responses.push(
        commandResponse("find_elements", { target: { by: "role", value: "button", name: "Process", frame: { by: "css", value: selector } } }, "frame-find"),
        request => {
          const result = lastTool(request);
          expect(result.elements).toHaveLength(2);
          const selected = result.elements.find((element: any) => element.context.visibleLabels?.some((label: any) => label.text.includes("FRAME-B Next")));
          expect(selected, JSON.stringify(result)).toMatchObject({ actionable: true, context: { status: "verified", observationId: result.pageSnapshot.observationId } });
          expect(JSON.stringify(result.elements.map((element: any) => element.context))).not.toContain("Transparent decoy");
          const automatic = result.pageSnapshot.actionContexts.targets.find((pair: any) => pair.targetId === selected.context.snapshotItemId);
          expect(automatic, JSON.stringify(result.pageSnapshot)).toMatchObject({ context: { status: "verified", observationId: result.pageSnapshot.observationId } });
          expect(JSON.stringify(automatic.context)).toContain("FRAME-B Next");
          expect(JSON.stringify(automatic.context)).not.toContain("FRAME-A Waiting");
          return commandResponse("click", { target: { id: selected.id } }, "frame-click");
        },
        textResponse("FRAME_CONTEXT_OK"), textResponse("框架关联"),
      );
      await (await configure(opened.context, opened.page, provider.baseURL)).close();
      await target.bringToFront();
      await opened.page.getByTestId("composer-input").fill("Process FRAME-B Next in the requested frame");
      await opened.page.getByTestId("composer-input").press("Enter");
      await expect(opened.page.locator(".markdown-body").last()).toContainText("FRAME_CONTEXT_OK", { timeout: 60_000 });
      expect(await frame!.getAttribute("body", "data-clicked")).toBe("FRAME-B Next");
    } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
  });
}

test("large candidate contexts keep complete inline pairs and original artifact access", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    await target.evaluate(() => {
      document.body.innerHTML = `<ul><li><span>BUDGET-ROW Next</span>${"<button>Process</button>".repeat(25)}</li></ul>`;
    });
    responses.push(
      commandResponse("find_elements", { target: { by: "role", value: "button", name: "Process" } }, "budget-find"),
      request => {
        const result = lastTool(request);
        expect(result.$ref, JSON.stringify(result)).toBeTruthy();
        expect(result.elementsTruncated).toBe(true);
        expect(result.elements.length).toBeGreaterThan(0);
        result.elements.forEach((element: any) => {
          expect(element.context.status).toBe("verified");
          expect(element.context.observationId).toBe(result.pageSnapshot.observationId);
          expect(element.context.visibleLabels.some((label: any) => label.text.includes("BUDGET-ROW Next"))).toBe(true);
        });
        const { pageSnapshot, ...core } = result;
        expect(Buffer.byteLength(JSON.stringify(core))).toBeLessThanOrEqual(8192);
        expect(Buffer.byteLength(JSON.stringify(pageSnapshot))).toBeLessThanOrEqual(16384);
        return commandResponse("read_artifact", { artifactId: result.$ref, path: ["elements", 24] }, "budget-original");
      },
      request => {
        expect(lastTool(request).result).toMatchObject({ actionable: true, context: { status: "verified", container: { role: "listitem" } } });
        return textResponse("BUDGET_CONTEXT_OK");
      },
      textResponse("预算关联"),
    );
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Find all Process candidates and read the original last candidate");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("BUDGET_CONTEXT_OK", { timeout: 60_000 });
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("text tools require rendered evidence rather than hidden source", async () => {
  test.setTimeout(120_000);
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    await target.evaluate(() => {
      document.body.innerHTML = `<script type="text/plain" id="source">r.ok?'Ready':'Stamp rejected'</script>
        <p id="status">Waiting for stamp</p>
        <div style="display:none"><p id="hidden">Ready</p></div>
        <div style="opacity:0"><p id="transparent">Ready</p></div>
        <div style="visibility:hidden"><p id="invisible">Ready</p></div>
        <p id="mixed">Visible<span style="display:none">Ready</span></p>
        <p id="uncertain">Visible<span style="opacity:0">Ready</span></p>
        <div id="inline">Hello <span style="display:none">secret</span> world</div>
        <pre id="pre"> A <span style="display:none">secret</span> B </pre>
        <div id="translated" style="transform:translateX(1px)">Translated</div>
        <div id="covered" style="position:absolute;top:600px">Covered</div>
        <div style="position:absolute;top:600px;width:300px;height:50px;background:white;z-index:2"></div>
        <div id="custom-empty">Unknown parent<x-empty></x-empty></div>
        <div id="custom-open">Open parent<x-open></x-open></div>
        <div id="custom-closed">Closed parent<x-closed></x-closed></div>
        <div id="custom-hidden">Hidden parent<x-hidden style="display:none"></x-hidden></div>
        <p id="empty"></p><p id="offscreen" style="position:absolute;top:2500px">Offscreen text</p>
        <button id="start">Start real stamp</button>
        <iframe id="child" srcdoc="<p id='frame-status'>Frame ready</p>"></iframe>
        <iframe id="hidden-child" style="opacity:0" srcdoc="<p id='frame-status'>Hidden frame text</p>"></iframe>`;
      document.querySelector('x-open')!.attachShadow({ mode: 'open' }).innerHTML = 'Unknown shadow';
      document.querySelector('x-closed')!.attachShadow({ mode: 'closed' }).innerHTML = 'Unknown shadow';
      document.querySelector('x-hidden')!.attachShadow({ mode: 'closed' }).innerHTML = 'Hidden shadow';
      const generated = document.createElement('button'); generated.id = 'show-generated'; generated.textContent = 'Show generated';
      generated.onclick = () => { const style = document.createElement('style'); style.textContent = 'x-empty::before{content:"additional"}'; document.head.append(style); };
      document.body.append(generated);
      document.querySelector('#start')!.addEventListener('click', () => {
        setTimeout(() => { document.querySelector('#status')!.textContent = 'Ready'; }, 500);
      });
    });
    const css = (value: string) => ({ by: "css", value });
    const steps: { name: string; input: object; expected: Record<string, any> }[] = [
      { name: "verify_state", input: { target: { by: "text", value: "Ready" }, textIncludes: "Ready", timeoutMs: 200 }, expected: { ok: true, result: { verified: false, present: false, actual: null } } },
      { name: "verify_state", input: { target: css("#status"), textIncludes: "Ready" }, expected: { ok: true, result: { verified: false, actual: "Waiting for stamp" } } },
      ...["#source", "#hidden", "#transparent", "#invisible"].flatMap(value => [
        { name: "verify_state", input: { target: css(value), textEquals: "" }, expected: { ok: true, result: { verified: false, present: true, actual: null } } },
        { name: "verify_state", input: { target: css(value), state: "hidden" }, expected: { ok: true, result: { verified: true, actual: false } } },
      ]),
      { name: "read_text", input: { target: css("#source") }, expected: { ok: false, error: { code: "text-unavailable" } } },
      { name: "read_text", input: { target: css("#mixed") }, expected: { ok: true, result: "Visible" } },
      { name: "read_elements", input: { target: css("#mixed") }, expected: { ok: true, result: { items: [{ text: "Visible" }] } } },
      { name: "verify_state", input: { target: css("#mixed"), textIncludes: "Ready" }, expected: { ok: true, result: { verified: false, actual: "Visible" } } },
      { name: "read_text", input: { target: css("#uncertain") }, expected: { ok: false, error: { code: "text-unavailable" } } },
      { name: "verify_state", input: { target: css("#uncertain"), textIncludes: "Ready" }, expected: { ok: true, result: { verified: false, actual: null } } },
      ...[["#inline", "Hello world"], ["#pre", " A  B "], ["#translated", "Translated"]].flatMap(([value, text]) => [
        { name: "read_text", input: { target: css(value!) }, expected: { ok: true, result: text } },
        { name: "verify_state", input: { target: css(value!), textEquals: text }, expected: { ok: true, result: { verified: true, actual: text } } },
      ]),
      { name: "find_elements", input: { target: { by: "text", value: "Unknown parent", exact: true } }, expected: { total: 1 } },
      { name: "find_elements", input: { target: { by: "text", value: "Hidden parent", exact: true } }, expected: { total: 1 } },
      ...["#custom-open", "#custom-closed"].map(value => ({
        name: "read_text", input: { target: css(value) }, expected: { ok: false, error: { code: "text-unavailable" } },
      })),
      { name: "read_text", input: { target: css("#covered") }, expected: { ok: false, error: { code: "text-unavailable" } } },
      { name: "verify_state", input: { target: css("#covered"), textEquals: "Covered" }, expected: { ok: true, result: { verified: false, actual: null } } },
      { name: "read_text", input: { target: css("#offscreen") }, expected: { ok: true, result: "Offscreen text" } },
      { name: "read_text", input: { target: { ...css("#frame-status"), frame: { by: "css", value: "#child" } } }, expected: { ok: true, result: "Frame ready" } },
      { name: "read_text", input: { target: { ...css("#frame-status"), frame: css("#hidden-child") } }, expected: { ok: false, error: { code: "text-unavailable" } } },
      { name: "verify_state", input: { target: { ...css("#frame-status"), frame: css("#hidden-child") }, textEquals: "Hidden frame text" }, expected: { ok: true, result: { verified: false, actual: null } } },
      { name: "click", input: { target: css("#start") }, expected: { ok: true } },
      { name: "verify_state", input: { target: { by: "text", value: "Ready" }, textEquals: "Ready", timeoutMs: 5000 }, expected: { ok: true, result: { verified: true, actual: "Ready", present: true } } },
      { name: "click", input: { target: css("#show-generated") }, expected: { ok: true } },
      { name: "read_text", input: { target: css("#custom-empty") }, expected: { ok: false, error: { code: "text-unavailable" } } },
      { name: "find_elements", input: { target: { by: "text", value: "Unknown parent", exact: true } }, expected: { total: 0 } },
    ];
    responses.push(commandResponse(steps[0]!.name, steps[0]!.input, "rendered-0"));
    steps.forEach((step, index) => responses.push(request => {
      expect(lastTool(request), JSON.stringify(lastTool(request))).toMatchObject(step.expected);
      const next = steps[index + 1];
      return next ? commandResponse(next.name, next.input, `rendered-${index + 1}`) : textResponse("RENDERED_TEXT_OK");
    }));
    responses.push(textResponse("渲染文本回归"));
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Check rendered text evidence");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("RENDERED_TEXT_OK", { timeout: 100_000 });
    expect(await target.locator("#status").innerText()).toBe("Ready");
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("duplicate text queries share current paint work and preserve strictness and paging", async () => {
  test.setTimeout(180_000);
  const { createServer } = await import('node:http');
  const { writeFile } = await import('node:fs/promises');
  let effects = 0;
  const server = createServer((request, response) => {
    if (request.url === '/effects') { response.setHeader('access-control-allow-origin', '*'); response.end(String(effects)); return; }
    if (request.url === '/effect') { effects++; response.end('ok'); return; }
    const n = Number(new URL(request.url!, 'http://fixture').searchParams.get('n'));
    response.setHeader('content-type', 'text/html');
    response.end(`<!doctype html><style>body{margin:8px;background:white;color:black}.grid{display:grid;grid-template-columns:repeat(25,48px)}button{font:10px Arial;height:25px;padding:0;border:1px solid gray}</style><div class="grid">${'<button onclick="fetch(\'/effect\')">Process</button>'.repeat(n)}</div><button id="unique" onclick="fetch('/effect')">Unique</button>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const opened = await openExtension(undefined, { viewport: { width: 1400, height: 900 } });
  try {
    await expect(opened.page.getByTestId('open-settings')).toBeVisible();
    const evidence = await opened.page.evaluate(async ({ dev, origin }) => {
      const { EventLogger } = await import(`${dev}/src/logging.ts`);
      const { createMemoryEventStore } = await import(`${dev}/src/memory-event-store.ts`);
      const { ChromeExecutor } = await import(`${dev}/src/chrome/executor.ts`);
      const { createProgramTools } = await import(`${dev}/src/chrome/tool.ts`);
      const { claimConversationRun } = await import(`${dev}/src/agent/coordinator.ts`);
      const conversationId = crypto.randomUUID();
      const lease = await claimConversationRun(conversationId, undefined, conversationId);
      const logger = new EventLogger({ store: createMemoryEventStore([]) });
      logger.beginRun(conversationId, conversationId);
      const executor = new ChromeExecutor({ logger }); await executor.beginRun();
      const tools = createProgramTools(executor, { logger, conversationId, runSignal: lease.signal });
      const records: any[] = [];
      const check = (v: any, message: string) => { if (!v) throw new Error(message); };
      const originalInspect = executor.inspect.bind(executor);
      let snapshotMs = 0;
      executor.inspect = async (...args: any[]) => {
        const started = performance.now();
        try { return await originalInspect(...args); }
        finally { snapshotMs += performance.now() - started; }
      };
      const call = async (name: string, input: any) => {
        snapshotMs = 0; const start = performance.now();
        const output = await tools[name].execute(input, { toolCallId: crypto.randomUUID(), messages: [] });
        const elapsedMs = performance.now() - start;
        records.push({ name, input, elapsedMs, snapshotMs, nonSnapshotMs: elapsedMs - snapshotMs, output });
        return output;
      };
      const raw = async (output: any) => {
        if (!output.$ref && !output.resultAccess) return output.result ?? output;
        const base = output.resultAccess ?? { artifactId: output.$ref, path: [] };
        const read = (path: any[], offset?: number) => tools.read_artifact.execute({ artifactId: base.artifactId, path: [...base.path, ...path], ...(offset === undefined ? {} : {offset, limit: 100}) }, { toolCallId: crypto.randomUUID(), messages: [] });
        const data: any = {};
        for (const key of ['total', 'hasMore', 'nextCursor']) data[key] = (await read([key])).result;
        data.elements = [];
        let part: any;
        do { part = await read(['elements'], data.elements.length); check(part.ok, JSON.stringify(part)); data.elements.push(...part.result); } while (part.hasMore);
        return data;
      };
      try {
        for (const n of [500]) {
          const tab = await chrome.tabs.create({ url: `${origin}/?n=${n}`, active: false }); const tabId = tab.id!;
          // The real tool chain waits for document load and delivers its snapshot.
          for (const by of ['text', 'role']) for (const limit of [25, 100]) {
            const target = by === 'text' ? { by, value: 'Process', exact: true } : { by, value: 'button', name: 'Process', exact: true };
            let page = await call('find_elements', { tabId, target, limit });
            check(page.ok !== false, JSON.stringify(page));
            let data = await raw(page); check(data.total === n, JSON.stringify(data));
            let count = data.elements.length; const ids = new Set(data.elements.map((item: any) => item.id));
            while (data.hasMore) {
              page = await call('find_elements', { tabId, target, limit, cursor: data.nextCursor });
              check(page.ok !== false, JSON.stringify(page)); data = await raw(page);
              check(data.total === n, JSON.stringify(data)); count += data.elements.length;
              data.elements.forEach((item: any) => ids.add(item.id));
            }
            check(count === n && ids.size === n, `paging ${n}: ${count}/${ids.size}: ${JSON.stringify(page)}`);
          }
          const result = await call('click', { tabId, target: { by: 'text', value: 'Process', exact: true } });
          check(result.error?.code === 'strict-mode' && result.error.effectUnknown === false, JSON.stringify(result));
          check(await (await fetch(`${origin}/effects`)).text() === '0', 'ambiguous click must not dispatch');
          {
            check(result.error.message.includes(`"count":${n}`), result.error.message);
            const followup = await call('click', { tabId, target: { by: 'text', value: 'Unique', exact: true } });
            check(followup.ok, JSON.stringify(followup));
            check(await (await fetch(`${origin}/effects`)).text() === '1', 'unique click dispatches exactly once');
          }
          await chrome.tabs.remove(tabId);
        }
        return records;
      } finally { await executor.endRun(); executor.dispose(); logger.dispose(); lease.finish(); }
    }, { dev: process.env.SURFWAX_DEV_SERVER_URL!, origin: `http://127.0.0.1:${(server.address() as any).port}` });
    expect(effects).toBe(1);
    const path = test.info().outputPath('duplicate-text.json');
    await writeFile(path, JSON.stringify({ effects, records: evidence }, null, 2));
    await test.info().attach('duplicate-text', { path, contentType: 'application/json' });
  } finally { await dispose(opened.context, opened.userDataDirectory, server); }
});

test("native values retain exact UTF-8 through fill, focus, blur and replacement without exposing unpainted values", async () => {
  test.setTimeout(120_000);
  const responses: MockResponse[] = [], wires = new Map<string, any>();
  const provider = await startProvider(responses), opened = await openExtension();
  const initial = ["probe+雪@example.invalid", "FAKE-SSN 000-00-0000", "第一行\nSecond line"];
  const filled = "filled+雪@example.invalid";
  const inspect = (id: string) => commandResponse("inspect_page", { full: true, budget: 16000 }, id);
  const record = (next: any) => (request: any) => {
    for (const message of request.messages.filter((m: any) => m.role === "tool" && ["native-initial","native-focused","native-blurred","native-replaced","native-textarea","native-selection"].includes(m.tool_call_id))) wires.set(message.tool_call_id, JSON.parse(message.content));
    return next;
  };
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    await target.evaluate(([email, ssn, textarea]) => {
      document.body.innerHTML = `<style>body{margin:16px;font:16px Arial;background:white;color:black}input,textarea{width:340px;font:16px Arial}textarea{height:60px}</style>
      <h1>Native values</h1><ul><li>Ordinary outside marker</li></ul>
      <p><label>Email <input id="email" type="text"></label></p>
      <p><label>Fake SSN <input id="ssn" type="text"></label></p>
      <p><label>Notes <textarea id="notes"></textarea></label></p>
      <p><input type="search" aria-label="Search" value="search雪"><input type="email" aria-label="Email type" value="雪@example.invalid"></p>
      <p><input type="tel" aria-label="Telephone" value="123雪"><input type="url" aria-label="URL" value="https://example.invalid/雪"></p>
      <select aria-label="Choice" style="font:16px Arial"><option>CHOICE_LABEL</option><option>UNSELECTED_OPTION_SECRET</option></select>
      <input aria-label="Unproven font" style="font-family:cursive" value="FONT_SECRET">
      <input aria-label="Password" type="password" value="PASSWORD_SECRET">
      <input aria-label="Transparent" style="opacity:0" value="OPACITY_SECRET">
      <input aria-label="Hidden" style="display:none" value="HIDDEN_SECRET">
      <input aria-label="Clipped" style="width:25px" value="CLIPPED_SECRET_TOO_LONG">
      <input aria-label="Masked" style="-webkit-text-security:disc" value="MASKED_SECRET">
      <div style="position:relative"><input aria-label="Covered" value="COVERED_SECRET"><div style="position:absolute;inset:0;background:white;z-index:1"></div></div>`;
      (document.querySelector("#email") as HTMLInputElement).value=email!;
      (document.querySelector("#ssn") as HTMLInputElement).value=ssn!;
      (document.querySelector("#notes") as HTMLTextAreaElement).value=textarea!;
      (window as any).nativeFocusEvents=[];
      for(const event of ["focusin","focusout"]) document.addEventListener(event,e=>(window as any).nativeFocusEvents.push([event,(e.target as HTMLElement).id]));
    }, initial);
    const ax = await opened.context.newCDPSession(target);
    const axBefore = await ax.send("Accessibility.getFullAXTree");
    expect(initial.every(value => axBefore.nodes.some(node => node.value?.value === value))).toBe(true);
    await ax.detach();
    responses.push(inspect("native-initial"), record(commandResponse("fill", {target:{by:"css",value:"#email"},value:filled}, "native-fill")),
      inspect("native-focused"), record(commandResponse("blur_element",{target:{by:"css",value:"#email"}},"native-blur")),
      inspect("native-blurred"), record(commandResponse("fill",{target:{by:"css",value:"#notes"},value:"更新\nTextarea filled"},"native-fill-notes")),
      inspect("native-textarea"),record(textResponse("NATIVE_FIRST_DONE")),textResponse("Native values"));
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    const submit = async (text: string, done: string) => {
      await opened.page.getByTestId("composer-input").fill(text);
      await opened.page.getByTestId("composer-input").press("Enter");
      await expect(opened.page.locator(".markdown-body").last()).toContainText(done,{timeout:80_000});
    };
    await submit("Inspect, fill, inspect focused, blur and inspect.","NATIVE_FIRST_DONE");
    expect(await target.evaluate(()=>(window as any).nativeFocusEvents)).toEqual([["focusin","email"],["focusout","email"],["focusin","notes"]]);
    await target.locator("#email").evaluate(element=>{const replacement=element.cloneNode() as HTMLInputElement;replacement.value="replacement+雪@example.invalid";element.replaceWith(replacement);});
    responses.push(inspect("native-replaced"), record(textResponse("NATIVE_REPLACED_DONE")));
    await submit("Inspect replacement.","NATIVE_REPLACED_DONE");
    await target.locator("#notes").evaluate(element=>(element as HTMLTextAreaElement).setSelectionRange(0,2));
    responses.push(inspect("native-selection"),record(textResponse("NATIVE_SELECTION_DONE")));
    await submit("Inspect the selected textarea.","NATIVE_SELECTION_DONE");
    const events = await readEvents(opened.page);
    const projected: any[] = await opened.page.evaluate(async ({dev,events})=>{
      const {projectConversationMessageEntries}=await import(`${dev}/src/logging.ts`);
      return [...projectConversationMessageEntries(events).values()];
    },{dev:process.env.SURFWAX_DEV_SERVER_URL!,events});
    for(const [id, expected] of [["native-initial",initial],["native-focused",[filled,...initial.slice(1)]],["native-blurred",[filled,...initial.slice(1)]],["native-textarea",[filled,initial[1],"更新\nTextarea filled"]],["native-replaced",["replacement+雪@example.invalid",initial[1],"更新\nTextarea filled"]]] as const){
      const terminal=events.find(e=>e.type==="tool.finished"&&e.toolCallId===id);
      const part=projected.flatMap(e=>e.message.parts).find(p=>p.toolCallId===id);
      for(const output of [terminal?.output,part?.output,wires.get(id)]){
        expect(output, id).toBeTruthy();
        for(const value of [...expected,"search雪","雪@example.invalid","123雪","https://example.invalid/雪"])expect(output.items.some((item:any)=>item.value===value&&!item.valueUnknown),`${id}: ${value}`).toBe(true);
        expect(JSON.stringify(output.items)).toContain("CHOICE_LABEL");
        for(const secret of ["UNSELECTED_OPTION_SECRET","FONT_SECRET","PASSWORD_SECRET","OPACITY_SECRET","HIDDEN_SECRET","CLIPPED_SECRET_TOO_LONG","MASKED_SECRET","COVERED_SECRET"])
          expect(JSON.stringify(output.items),`${id}: ${secret}`).not.toContain(secret);
      }
    }
    const selection=events.find(e=>e.type==="tool.finished"&&e.toolCallId==="native-selection");
    const selectionPart=projected.flatMap(e=>e.message.parts).find(p=>p.toolCallId==="native-selection");
    for(const output of [selection?.output,selectionPart?.output,wires.get("native-selection")]){
      expect(output.items.some((item:any)=>item.role==="textbox"&&item.name==="Notes"&&item.valueUnknown&& !item.value)).toBe(true);
      expect(JSON.stringify(output.items)).not.toContain("Textarea filled");
    }
    await test.info().attach("native-value-chain",{contentType:"application/json",body:Buffer.from(JSON.stringify({axBefore,events,wires:[...wires]},null,2))});
  } finally { await dispose(opened.context,opened.userDataDirectory,provider.server); }
});
