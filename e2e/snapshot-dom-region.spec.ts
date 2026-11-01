import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, type MockResponse } from "./fixtures";

function lastTool(request: any): any {
  const content = request.messages.findLast((entry: any) => entry.role === "tool").content;
  return JSON.parse(Array.isArray(content) ? content.find((part: any) => part.type === "text").text : content);
}

test("inspects and acts inside AX-ignored regions without confusing same IDs across frames", async () => {
  test.setTimeout(90_000);
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses), opened = await openExtension();
  let rootSnapshot: any, crossSnapshot: any, clicked: any, problem: unknown;
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/complex`);
    const same = target.frameLocator('iframe[src="/same-frame"]');
    const cross = target.frameLocator('iframe[src*="localhost"]');
    await expect(same.locator("body")).toBeVisible();
    await expect(cross.locator("body")).toBeVisible();
    await target.evaluate(() => {
      const root = document.createElement("main");
      root.innerHTML = `<p>ROOT_OUTSIDE_REGION</p>
        <section id="duplicated-region" aria-hidden="true"><p>ROOT_INSIDE_REGION</p>
          <button id="root-action">Root region action</button>
          <p style="display:none">ROOT_HIDDEN_CONTENT</p></section>`;
      document.body.append(root);
      root.querySelector("#root-action")!.addEventListener("click", () => { document.body.dataset.rootClicked = "wrong"; });
    });
    await same.locator("body").evaluate((body) => {
      body.innerHTML = '<main><section id="duplicated-region" aria-hidden="true"><p>SAME_FRAME_REGION</p><button>Same frame action</button></section></main>';
    });
    await cross.locator("body").evaluate((body) => {
      body.innerHTML = `<main><p>CROSS_OUTSIDE_REGION</p>
        <section id="duplicated-region" aria-hidden="true"><p>CROSS_INSIDE_REGION</p>
          <button id="cross-action">Cross region action</button>
          <p style="display:none">CROSS_HIDDEN_CONTENT</p>
          <p style="opacity:0">CROSS_TRANSPARENT_CONTENT</p></section></main>`;
      body.querySelector("#cross-action")!.addEventListener("click", () => { body.dataset.crossClicked = "yes"; });
    });
    await expect(target.locator("#duplicated-region")).toBeVisible();
    await expect(cross.locator("#duplicated-region")).toBeVisible();
    const done = () => textResponse("DOM_REGION_DONE");
    responses.push(
      commandResponse("inspect_page", { budget: 12000, region: { by: "css", value: "#duplicated-region" } }, "dom-region-root"),
      (request) => {
        try { rootSnapshot = lastTool(request); } catch (error) { problem = error; return done(); }
        return commandResponse("inspect_page", { budget: 12000, region: { by: "css", value: "#duplicated-region", frame: { by: "css", value: 'iframe[src*="localhost"]' } } }, "dom-region-cross");
      },
      (request) => {
        try {
          crossSnapshot = lastTool(request);
          const button = crossSnapshot.items?.find((item: any) => item.line.includes('- button "Cross region action"'));
          if (typeof button?.ref !== "string") return done();
          responses.unshift((next) => { try { clicked = lastTool(next); } catch (error) { problem = error; } return done(); });
          return commandResponse("click", { target: { ref: button.ref } }, "dom-region-click");
        } catch (error) { problem = error; return done(); }
      },
      textResponse("Inspect scoped regions"),
    );
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Inspect both scoped regions and activate the cross-origin region");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("DOM_REGION_DONE", { timeout: 60_000 });
    if (problem) throw problem;

    expect(rootSnapshot).toMatchObject({ mode: "full", truncation: { baselineComplete: true }, items: expect.any(Array) });
    const rootItems = JSON.stringify(rootSnapshot.items);
    expect(rootItems).toContain("ROOT_INSIDE_REGION");
    expect(rootItems).toContain("Root region action");
    for (const absent of ["ROOT_OUTSIDE_REGION", "ROOT_HIDDEN_CONTENT", "SAME_FRAME_REGION", "CROSS_INSIDE_REGION", "CROSS_OUTSIDE_REGION"]) expect(rootItems).not.toContain(absent);

    expect(crossSnapshot).toMatchObject({ mode: "full", truncation: { baselineComplete: true }, items: expect.any(Array) });
    const crossItems = JSON.stringify(crossSnapshot.items);
    expect(crossItems).toContain("CROSS_INSIDE_REGION");
    expect(crossItems).toContain("Cross region action");
    for (const absent of ["ROOT_INSIDE_REGION", "ROOT_OUTSIDE_REGION", "SAME_FRAME_REGION", "CROSS_OUTSIDE_REGION", "CROSS_HIDDEN_CONTENT", "CROSS_TRANSPARENT_CONTENT"]) expect(crossItems).not.toContain(absent);
    expect(crossSnapshot.items.find((item: any) => item.line.includes('- button "Cross region action"'))?.ref).toEqual(expect.any(String));
    expect(clicked).toMatchObject({ ok: true });
    expect(await cross.locator("body").getAttribute("data-cross-clicked")).toBe("yes");
    expect(await target.locator("body").getAttribute("data-root-clicked")).toBeNull();
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});

test("uses only the actual visible external label for a scoped input, including in shadow DOM", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses), opened = await openExtension();
  let outerSnapshot: any, shadowSnapshot: any, filled: any, problem: unknown;
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    await target.evaluate(() => {
      document.body.innerHTML = `<main><section aria-hidden="true">
        <label for="shared">OUTER_ASSOCIATED_LABEL</label>
        <label for="other">UNRELATED_OUTER_LABEL</label><input id="other" value="UNRELATED_OUTSIDE_VALUE">
        <label for="hidden-other" style="display:none">HIDDEN_OUTSIDE_LABEL</label>
        <section id="outer-region"><p>OUTER_INSIDE</p><input id="shared" value="OUTER_VALUE"></section>
        <div id="shadow-host"></div>
      </section></main>`;
      document.querySelector("#shadow-host")!.attachShadow({ mode: "open" }).innerHTML = `
        <label for="shared">SHADOW_ASSOCIATED_LABEL</label>
        <label for="unrelated">UNRELATED_SHADOW_LABEL</label>
        <section id="shadow-region"><p>SHADOW_INSIDE</p><input id="shared" value="SHADOW_VALUE"></section>`;
    });
    const done = () => textResponse("DOM_REGION_LABEL_DONE");
    responses.push(
      commandResponse("inspect_page", { budget: 6000, region: { by: "css", value: "#outer-region" } }, "outer-region-label"),
      (request) => {
        try { outerSnapshot = lastTool(request); } catch (error) { problem = error; return done(); }
        return commandResponse("inspect_page", { budget: 6000, region: { by: "css", value: "#shadow-region" } }, "shadow-region-label");
      },
      (request) => {
        try {
          shadowSnapshot = lastTool(request);
          const input = shadowSnapshot.items?.find((item: any) => item.line.includes('textbox "SHADOW_ASSOCIATED_LABEL"') && item.line.includes("SHADOW_VALUE"));
          if (typeof input?.ref !== "string") return done();
          responses.unshift((next) => { try { filled = lastTool(next); } catch (error) { problem = error; } return done(); });
          return commandResponse("fill", { target: { ref: input.ref }, value: "SHADOW_FILLED" }, "shadow-region-fill");
        } catch (error) { problem = error; return done(); }
      },
      textResponse("Inspect scoped labels"),
    );
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Inspect the scoped inputs and fill the shadow input");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("DOM_REGION_LABEL_DONE", { timeout: 45_000 });
    if (problem) throw problem;

    expect(outerSnapshot).toMatchObject({ mode: "full", truncation: { baselineComplete: true }, items: expect.any(Array) });
    const outer = JSON.stringify(outerSnapshot.items);
    expect(outer).toContain("OUTER_INSIDE");
    const outerInput = outerSnapshot.items.find((item: any) => item.line.includes('textbox "OUTER_ASSOCIATED_LABEL"') && item.line.includes("OUTER_VALUE"));
    expect(outerInput?.ref).toEqual(expect.any(String));
    for (const absent of ["SHADOW_ASSOCIATED_LABEL", "SHADOW_INSIDE", "SHADOW_VALUE", "UNRELATED_OUTER_LABEL", "UNRELATED_OUTSIDE_VALUE", "UNRELATED_SHADOW_LABEL", "HIDDEN_OUTSIDE_LABEL"])
      expect(outer).not.toContain(absent);

    expect(shadowSnapshot).toMatchObject({ mode: "full", truncation: { baselineComplete: true }, items: expect.any(Array) });
    const shadow = JSON.stringify(shadowSnapshot.items);
    expect(shadow).toContain("SHADOW_INSIDE");
    const shadowInput = shadowSnapshot.items.find((item: any) => item.line.includes('textbox "SHADOW_ASSOCIATED_LABEL"') && item.line.includes("SHADOW_VALUE"));
    expect(shadowInput?.ref).toEqual(expect.any(String));
    for (const absent of ["OUTER_ASSOCIATED_LABEL", "OUTER_INSIDE", "OUTER_VALUE", "UNRELATED_OUTER_LABEL", "UNRELATED_OUTSIDE_VALUE", "UNRELATED_SHADOW_LABEL", "HIDDEN_OUTSIDE_LABEL"])
      expect(shadow).not.toContain(absent);
    expect(filled).toMatchObject({ ok: true });
    expect(await target.locator("#shadow-host").locator("#shared").inputValue()).toBe("SHADOW_FILLED");
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
