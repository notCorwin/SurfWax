import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, type MockResponse } from "./fixtures";
import { itemLine } from "./snapshot-format";

function lastTool(request: any): any {
  const content = request.messages.findLast((entry: any) => entry.role === "tool").content;
  return JSON.parse(Array.isArray(content) ? content.find((part: any) => part.type === "text").text : content);
}

type Item = { role?: string; name?: string; placeholder?: string | "unknown"; id?: string; actionable?: true };

test("reports only proven visible placeholders and keeps normal controls actionable", async () => {
  test.setTimeout(90_000);
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses), opened = await openExtension();
  let snapshot: any, filled: any, inspectStartedAt = 0, inspectElapsedMs = 0;
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    await target.evaluate(() => {
      document.body.innerHTML = `<style>
        input { display:block; width:350px; height:30px; font:16px monospace; }
        #clipped { width:65px; }
        #transparent::placeholder { opacity:0; }
      </style><main>
        <input id="normal" placeholder="NORMAL_VISIBLE_HINT">
        <input id="labeled" aria-label="Delivery address" placeholder="VISIBLE_ADDRESS_HINT">
        <input id="transparent" aria-label="Transparent control" placeholder="TRANSPARENT_SECRET_TEXT">
        <input id="clipped" aria-label="Clipped control" placeholder="CLIPPED_SECRET_SUFFIX">
        <input id="filled" value="FILLED_VISIBLE_VALUE" placeholder="FILLED_HIDDEN_HINT">
        <section aria-hidden="true"><input id="aria-hidden" placeholder="ARIA_DOM_VISIBLE_HINT"></section>
      </main>`;
    });
    responses.push(
      () => {
        inspectStartedAt = performance.now();
        return commandResponse("inspect_page", { budget: 12000 }, "placeholder-visibility");
      },
      (request) => {
        inspectElapsedMs = performance.now() - inspectStartedAt;
        snapshot = lastTool(request);
        const normal: Item | undefined = snapshot.items?.find((item: Item) => itemLine(item).includes("NORMAL_VISIBLE_HINT") && itemLine(item).includes("textbox"));
        if (!normal?.id) return textResponse("PLACEHOLDER_VISIBILITY_DONE");
        responses.unshift((next) => { filled = lastTool(next); return textResponse("PLACEHOLDER_VISIBILITY_DONE"); });
        return commandResponse("fill", { target: { id: normal.id }, value: "FILLED_FROM_REF" }, "placeholder-fill");
      },
      textResponse("Inspect placeholders"),
    );
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Inspect the placeholders and fill the first input");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("PLACEHOLDER_VISIBILITY_DONE", { timeout: 60_000 });
    console.info(`Six-placeholder inspect provider round trip: ${inspectElapsedMs.toFixed(1)} ms`);

    expect(snapshot).toMatchObject({ mode: "full", truncation: { baselineComplete: true }, items: expect.any(Array) });
    const items: Item[] = snapshot.items;
    const output = JSON.stringify(items);
    expect(output).toContain("NORMAL_VISIBLE_HINT");
    expect(output).toContain("FILLED_VISIBLE_VALUE");
    expect(output).toContain("ARIA_DOM_VISIBLE_HINT");
    for (const hidden of ["TRANSPARENT_SECRET_TEXT", "CLIPPED_SECRET_SUFFIX", "FILLED_HIDDEN_HINT"]) expect(output).not.toContain(hidden);
    const labeled = items.find((item) => itemLine(item).includes('textbox "Delivery address"'));
    expect(itemLine(labeled)).toContain("VISIBLE_ADDRESS_HINT");
    const clipped = items.find((item) => itemLine(item).includes('textbox "Clipped control"'));
    expect(itemLine(clipped)).toContain("[placeholder=unknown]");
    expect(items.find((item) => itemLine(item).includes("NORMAL_VISIBLE_HINT") && itemLine(item).includes("textbox"))?.id).toEqual(expect.any(String));
    expect(filled).toMatchObject({ ok: true });
    expect(await target.locator("#normal").inputValue()).toBe("FILLED_FROM_REF");
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("does not expose a transparent placeholder through an aria-labelledby dependency", async () => {
  test.setTimeout(90_000);
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses), opened = await openExtension();
  let snapshot: any;
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    await target.evaluate(() => {
      document.body.innerHTML = `<style>
        input { display:block; width:350px; height:30px; font:16px monospace; }
        input::placeholder { opacity:0; }
      </style><main id="indirect">
        <input id="source" placeholder="INDIRECT_TRANSPARENT_SECRET">
        <button aria-labelledby="source"></button>
      </main>`;
    });
    responses.push(
      commandResponse("inspect_page", { budget: 12000, region: { by: "css", value: "#indirect" } }, "placeholder-indirect"),
      (request) => { snapshot = lastTool(request); return textResponse("PLACEHOLDER_INDIRECT_DONE"); },
      textResponse("Inspect the related control"),
    );
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Inspect the related controls");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("PLACEHOLDER_INDIRECT_DONE", { timeout: 60_000 });
    expect(snapshot).toEqual(expect.any(Object));
    expect(JSON.stringify(snapshot)).not.toContain("INDIRECT_TRANSPARENT_SECRET");
    if (snapshot.ok === false) expect(snapshot.error?.code).toBe("snapshot-unavailable");
    else expect(snapshot).toMatchObject({ mode: "full", items: expect.any(Array) });
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("updates the snapshot when a placeholder becomes transparent and visible again", async () => {
  test.setTimeout(90_000);
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses), opened = await openExtension();
  let before: any, hidden: any, shown: any, hideClick: any, showClick: any;
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    await target.evaluate(() => {
      document.body.innerHTML = `<style>
        input { display:block; width:350px; height:30px; font:16px monospace; }
        .hide-hint input::placeholder { opacity:0; }
      </style><main><input placeholder="DYNAMIC_VISIBLE_HINT"><button>Toggle hint</button></main>`;
      document.querySelector("button")!.addEventListener("click", () => { document.querySelector("main")!.classList.toggle("hide-hint"); });
    });
    responses.push(
      commandResponse("inspect_page", { budget: 12000 }, "placeholder-before-toggle"),
      (request) => {
        before = lastTool(request);
        const button: Item | undefined = before.items?.find((item: Item) => itemLine(item).includes('- button "Toggle hint"'));
        if (!button?.id) return textResponse("PLACEHOLDER_TOGGLE_DONE");
        responses.unshift(
          (next) => { hideClick = lastTool(next); return commandResponse("inspect_page", { budget: 12000 }, "placeholder-hidden"); },
          (next) => { hidden = lastTool(next); return commandResponse("click", { target: { id: button.id } }, "placeholder-show"); },
          (next) => { showClick = lastTool(next); return commandResponse("inspect_page", { budget: 12000 }, "placeholder-shown"); },
          (next) => { shown = lastTool(next); return textResponse("PLACEHOLDER_TOGGLE_DONE"); },
        );
        return commandResponse("click", { target: { id: button.id } }, "placeholder-hide");
      },
      textResponse("Inspect the changing placeholder"),
    );
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Inspect the hint and toggle its visibility twice");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("PLACEHOLDER_TOGGLE_DONE", { timeout: 60_000 });

    for (const snapshot of [before, hidden, shown]) expect(snapshot).toMatchObject({ mode: "full", items: expect.any(Array) });
    expect(JSON.stringify(before.items)).toContain("DYNAMIC_VISIBLE_HINT");
    expect(JSON.stringify(hidden.items)).not.toContain("DYNAMIC_VISIBLE_HINT");
    expect(JSON.stringify(shown.items)).toContain("DYNAMIC_VISIBLE_HINT");
    expect(hideClick).toMatchObject({ ok: true });
    expect(showClick).toMatchObject({ ok: true });
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("proves child frame placeholders only through fully contained frame owners", async () => {
  test.setTimeout(90_000);
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses), opened = await openExtension();
  let snapshot: any;
  try {
    const target = await opened.context.newPage();
    await target.route("http://cross-frame.test/**", (route) => route.fulfill({ contentType: "text/html", body:
      '<style>input{width:300px;height:30px;font:16px monospace}</style><input placeholder="CROSS_ORIGIN_VISIBLE_HINT">' }));
    await target.goto(`${provider.origin}/target`);
    await target.evaluate(() => {
      const makeFrame = (title: string, html: string) => {
        const frame = document.createElement("iframe"); frame.title = title;
        frame.style.cssText = "display:block;width:450px;height:100px"; frame.srcdoc = html;
        return frame;
      };
      const visible = makeFrame("Visible workspace", '<style>input{width:300px;height:30px;font:16px monospace}</style><input placeholder="FRAME_VISIBLE_HINT">');
      const clipped = makeFrame("Clipped workspace", '<style>input{width:300px;height:30px;font:16px monospace}</style><input aria-label="Clipped frame input" placeholder="FRAME_CLIPPED_HINT">');
      const clip = document.createElement("div"); clip.style.cssText = "width:100px;overflow:hidden"; clip.append(clipped);
      const cross = document.createElement("iframe"); cross.title = "Cross origin workspace";
      cross.style.cssText = "display:block;width:450px;height:100px"; cross.src = "http://cross-frame.test/child";
      const inner = '<style>input{width:300px;height:30px;font:16px monospace}</style><input placeholder="NESTED_VISIBLE_HINT">';
      const nested = makeFrame("Nested workspace", `<iframe title="Inner workspace" style="width:400px;height:70px" srcdoc="${inner.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}"></iframe>`);
      const host = document.createElement("div");
      host.attachShadow({ mode: "open" }).innerHTML = '<div style="width:80px;overflow:hidden"><slot></slot></div>';
      const slotted = makeFrame("Slotted workspace", '<style>input{width:300px;height:30px;font:16px monospace}</style><input aria-label="Slotted frame input" placeholder="SLOTTED_FRAME_CLIPPED_HINT">');
      host.append(slotted);
      const inputHost = document.createElement("div");
      inputHost.attachShadow({ mode: "open" }).innerHTML = '<div style="width:20px;overflow:hidden"><slot></slot></div>';
      const slottedInput = document.createElement("input"); slottedInput.style.cssText = "width:300px;font:16px monospace";
      slottedInput.placeholder = "SLOTTED_INPUT_CLIPPED_HINT"; inputHost.append(slottedInput);
      const closedHost = document.createElement("div");
      closedHost.attachShadow({ mode: "closed" }).innerHTML = '<div style="width:80px;overflow:hidden"><slot></slot></div>';
      const closedFrame = makeFrame("Closed slotted workspace", '<style>input{width:300px;height:30px;font:16px monospace}</style><input aria-label="Closed slotted frame input" placeholder="CLOSED_FRAME_CLIPPED_HINT">');
      const closedInput = document.createElement("input"); closedInput.style.cssText = "width:300px;font:16px monospace";
      closedInput.placeholder = "CLOSED_INPUT_CLIPPED_HINT"; closedHost.append(closedFrame, closedInput);
      document.body.replaceChildren(visible, clip, cross, nested, host, inputHost, closedHost);
    });
    await expect(target.frameLocator('iframe[title="Visible workspace"]').locator("input")).toBeVisible();
    await expect(target.frameLocator('iframe[title="Cross origin workspace"]').locator("input")).toBeVisible();
    await expect(target.frameLocator('iframe[title="Nested workspace"]').frameLocator('iframe[title="Inner workspace"]').locator("input")).toBeVisible();
    responses.push(commandResponse("inspect_page", { budget: 12000 }, "placeholder-child-frame"),
      (request) => { snapshot = lastTool(request); return textResponse("PLACEHOLDER_FRAME_DONE"); },
      textResponse("Inspect the child frame"));
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Inspect the child frame hint");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("PLACEHOLDER_FRAME_DONE", { timeout: 60_000 });

    expect(snapshot).toMatchObject({ mode: "full", items: expect.any(Array) });
    const items: Item[] = snapshot.items;
    expect(JSON.stringify(items)).toContain("FRAME_VISIBLE_HINT");
    expect(JSON.stringify(items)).toContain("CROSS_ORIGIN_VISIBLE_HINT");
    expect(JSON.stringify(items)).toContain("NESTED_VISIBLE_HINT");
    expect(JSON.stringify(items)).not.toContain("FRAME_CLIPPED_HINT");
    expect(JSON.stringify(items)).not.toContain("SLOTTED_FRAME_CLIPPED_HINT");
    expect(JSON.stringify(items)).not.toContain("SLOTTED_INPUT_CLIPPED_HINT");
    expect(JSON.stringify(items)).not.toContain("CLOSED_FRAME_CLIPPED_HINT");
    expect(JSON.stringify(items)).not.toContain("CLOSED_INPUT_CLIPPED_HINT");
    expect(items.find((item) => itemLine(item).includes("Clipped frame input") && itemLine(item).includes("[placeholder=unknown]"))).toBeTruthy();
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
