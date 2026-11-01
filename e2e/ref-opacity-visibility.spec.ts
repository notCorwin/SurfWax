import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, type MockResponse } from "./fixtures";

function lastTool(request: any): any {
  const content = request.messages.findLast((entry: any) => entry.role === "tool").content;
  return JSON.parse(Array.isArray(content) ? content.find((part: any) => part.type === "text").text : content);
}

test("old refs reject transparent ancestors across shadow and frames, then work when visible", async () => {
  test.setTimeout(90_000);
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses), opened = await openExtension();
  const refs: Record<string, string> = {}, hidden: any[] = [], visible: any[] = [];
  let initial: any, found: any, far: any, toggledOff: any, toggledOn: any, problem: unknown;
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/complex`);
    const same = target.frameLocator('iframe[src="/same-frame"]');
    const cross = target.frameLocator('iframe[src*="localhost"]');
    await expect(same.locator("body")).toBeVisible(); await expect(cross.locator("body")).toBeVisible();
    await target.evaluate(() => {
      const root = document.createElement("main");
      root.innerHTML = `<button id="toggle">Toggle opacity</button><div id="root-owner"><button id="root-action">Root target</button></div><div id="shadow-owner"></div><div style="position:absolute;top:2000px"><button id="far">Far target</button></div>`;
      document.body.prepend(root);
      root.querySelector("#root-action")!.addEventListener("click", () => { document.body.dataset.rootClicked = String(Number(document.body.dataset.rootClicked || 0) + 1); });
      root.querySelector("#far")!.addEventListener("click", () => { document.body.dataset.farClicked = "yes"; });
      const host = root.querySelector("#shadow-owner")!;
      host.attachShadow({ mode: "open" }).innerHTML = '<button>Shadow target</button>';
      host.shadowRoot!.querySelector("button")!.addEventListener("click", () => { document.body.dataset.shadowClicked = String(Number(document.body.dataset.shadowClicked || 0) + 1); });
      let hidden = false;
      root.querySelector("#toggle")!.addEventListener("click", () => {
        hidden = !hidden;
        for (const element of [root.querySelector("#root-owner")!, host, ...document.querySelectorAll("iframe")]) (element as HTMLElement).style.opacity = hidden ? "0" : "1";
      });
    });
    await same.locator("body").evaluate((body) => { body.innerHTML = '<button>Same frame target</button>'; body.querySelector("button")!.addEventListener("click", () => { body.dataset.clicked = String(Number(body.dataset.clicked || 0) + 1); }); });
    await cross.locator("body").evaluate((body) => { body.innerHTML = '<button>Cross frame target</button>'; body.querySelector("button")!.addEventListener("click", () => { body.dataset.clicked = String(Number(body.dataset.clicked || 0) + 1); }); });
    const done = () => textResponse("REF_OPACITY_DONE");
    const names = ["Root target", "Shadow target", "Same frame target", "Cross frame target"];
    responses.push(commandResponse("inspect_page", { budget: 12000 }, "opacity-inspect"), (request) => {
      try {
        initial = lastTool(request);
        for (const name of [...names, "Toggle opacity", "Far target"]) refs[name] = initial.items?.find((item: any) => item.line.includes(`button "${name}"`))?.ref ?? "";
        if (Object.values(refs).some((ref) => !ref)) return done();
        const steps: MockResponse[] = [
          (next) => { found = lastTool(next); refs["Same frame target"] = found.elements?.[0]?.ref ?? "";
            return refs["Same frame target"] ? commandResponse("click", { target: { ref: refs["Far target"] }, timeoutMs: 3000 }, "offscreen-click") : done(); },
          (next) => { far = lastTool(next); return commandResponse("click", { target: { ref: refs["Toggle opacity"] }, timeoutMs: 3000 }, "opacity-hide"); },
          (next) => { toggledOff = lastTool(next); return commandResponse("click", { target: { ref: refs[names[0]!] }, timeoutMs: 1200 }, "hidden-root"); },
          ...names.slice(1).map((name, index): MockResponse => (next) => { hidden.push(lastTool(next)); return commandResponse("click", { target: { ref: refs[name] }, timeoutMs: 1200 }, `hidden-${index + 1}`); }),
          (next) => { hidden.push(lastTool(next)); return commandResponse("click", { target: { ref: refs["Toggle opacity"] }, timeoutMs: 1200 }, "opacity-show"); },
          (next) => { toggledOn = lastTool(next); return commandResponse("click", { target: { ref: refs[names[0]!] }, timeoutMs: 3000 }, "visible-root"); },
          ...names.slice(1).map((name, index): MockResponse => (next) => { visible.push(lastTool(next)); return commandResponse("click", { target: { ref: refs[name] }, timeoutMs: 3000 }, `visible-${index + 1}`); }),
          (next) => { visible.push(lastTool(next)); return done(); },
        ];
        responses.unshift(...steps);
        return commandResponse("find_elements", { target: { by: "role", value: "button", name: "Same frame target", frame: { by: "css", value: 'iframe[src="/same-frame"]' } }, limit: 1 }, "same-frame-search");
      } catch (error) { problem = error; return done(); }
    }, textResponse("Check targets"));
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Check the targets before and after they become transparent");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("REF_OPACITY_DONE", { timeout: 75_000 });
    if (problem) throw problem;
    expect(initial).toMatchObject({ mode: "full", truncation: { baselineComplete: true } });
    expect(found).toMatchObject({ elements: [{ ref: expect.any(String) }] });
    expect(far).toMatchObject({ ok: true }); expect(await target.locator("body").getAttribute("data-far-clicked")).toBe("yes");
    expect(toggledOff).toMatchObject({ ok: true }); expect(toggledOn).toMatchObject({ ok: true });
    expect(hidden).toHaveLength(4);
    for (const result of hidden) expect(result).toMatchObject({ ok: false, error: { code: "not-visible" } });
    expect(visible).toHaveLength(4);
    for (const result of visible) expect(result).toMatchObject({ ok: true });
    expect(await target.locator("body").getAttribute("data-root-clicked")).toBe("1");
    expect(await target.locator("body").getAttribute("data-shadow-clicked")).toBe("1");
    expect(await same.locator("body").getAttribute("data-clicked")).toBe("1");
    expect(await cross.locator("body").getAttribute("data-clicked")).toBe("1");
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
