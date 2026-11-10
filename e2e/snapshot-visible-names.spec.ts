import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configureWithImages, readEvents, type MockResponse } from "./fixtures";
import { deliveredSemanticState } from "./evaluation/semantic-state";
import { itemLine } from "./snapshot-format";

function lastTool(request: any): any {
  const message = request.messages.findLast((entry: any) => entry.role === "tool");
  if (!message) throw new Error("Missing tool result");
  const content = Array.isArray(message.content) ? message.content.find((part: any) => part.type === "text")?.text : message.content;
  return JSON.parse(content);
}

const named = (items: any[], role: string, text: string) => items.find((item) => itemLine(item).includes(`${role} "${text}"`));

test("snapshots use painted names while retaining private action identity", async () => {
  test.setTimeout(120_000);
  const responses: MockResponse[] = [], provider = await startProvider(responses), opened = await openExtension();
  let baseline: any, changed: any, delta: any, stale: any, iconPage: any, iconClick: any, domClick: any, scoped: any, ellipsisPage: any, ellipsisCapture: any, problem: unknown;
  const requireRef = (item: any, label: string): string => {
    if (typeof item?.ref !== "string") throw new Error(`No actionable ref for ${label}`);
    return item.ref;
  };
  const step = (callback: (request: any) => ReturnType<typeof commandResponse>): MockResponse => (request) => {
    try { return callback(request); }
    catch (error) { problem = error; return textResponse("VISIBLE_NAMES_DONE"); }
  };
  try {
    const target = await opened.context.newPage();
    await target.setViewportSize({ width: 1280, height: 900 });
    await target.goto(`${provider.origin}/target`);
    await target.evaluate(() => {
      document.body.innerHTML = `<style>
        button { display:block; margin:4px; appearance:none; background:white; color:black; border:1px solid black; outline:none; box-shadow:none; }
        #ellipsized { width:130px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font:16px monospace; }
        #icon { width:40px; height:40px; }
      </style><main>
        <span id="hidden-label" style="display:none">SECRET_HIDDEN_LABEL</span>
        <span id="external-label">OUTSIDE_VISIBLE_LABEL</span>
        <button id="trigger" aria-label="SECRET_TRIGGER_LABEL">Visible trigger</button>
        <button id="labelled" aria-labelledby="hidden-label">Visible labelled button</button>
        <button id="dynamic" aria-label="SECRET_DYNAMIC_LABEL">Visible before change</button>
        <button id="identity" aria-label="SECRET_IDENTITY_BEFORE">Identity target</button>
        <button id="icon" aria-label="SECRET_ICON_LABEL"><svg width="14" height="14" aria-hidden="true"><circle cx="7" cy="7" r="6"></circle></svg></button>
        <button id="ellipsized">VISIBLE_PREFIX_${"x".repeat(60)}_SECRET_ELLIPSIZED_SUFFIX_A</button>
        <section aria-hidden="true"><div id="dom-button" role="button" tabindex="0" aria-label="SECRET_DOM_LABEL">Visible DOM control</div></section>
        <section id="scoped"><button aria-labelledby="external-label">Inside visible caption</button></section>
      </main>`;
      document.querySelector("#trigger")!.addEventListener("click", () => {
        document.body.dataset.triggered = "yes";
        document.querySelector("#dynamic")!.textContent = "Visible after change";
        document.querySelector("#identity")!.setAttribute("aria-label", "SECRET_IDENTITY_AFTER");
      });
      document.querySelector("#icon")!.addEventListener("click", () => { document.body.dataset.icon = "yes"; });
      document.querySelector("#dom-button")!.addEventListener("click", () => { document.body.dataset.dom = "yes"; });
      document.querySelector("#identity")!.addEventListener("click", () => { document.body.dataset.identity = "wrong"; });
    });

    // Independently establish that the long suffix does not change the pixels.
    const ellipsis = target.locator("#ellipsized");
    const beforePixels = await ellipsis.screenshot();
    await ellipsis.evaluate((element) => { element.textContent = element.textContent!.replace("SUFFIX_A", "SUFFIX_B"); });
    const afterPixels = await ellipsis.screenshot();
    expect(afterPixels.equals(beforePixels)).toBe(true);
    await ellipsis.evaluate((element) => { element.textContent = element.textContent!.replace("SUFFIX_B", "SUFFIX_A"); });

    responses.push(
      commandResponse("inspect_page", { full: true, budget: 12000 }, "visible-names-baseline"),
      step((request) => {
        baseline = lastTool(request);
        expect(baseline).toMatchObject({ mode: "full", items: expect.any(Array), truncation: { baselineComplete: true } });
        const text = JSON.stringify(baseline.items);
        for (const secret of ["SECRET_TRIGGER_LABEL", "SECRET_HIDDEN_LABEL", "SECRET_DYNAMIC_LABEL", "SECRET_IDENTITY_BEFORE", "SECRET_ICON_LABEL", "SECRET_DOM_LABEL", "SECRET_ELLIPSIZED_SUFFIX_A"]) {
          expect(text).not.toContain(secret);
        }
        for (const visible of ["Visible trigger", "Visible labelled button", "Visible before change", "Identity target", "Visible DOM control", "Inside visible caption", "OUTSIDE_VISIBLE_LABEL"]) {
          expect(text).toContain(visible);
        }
        return commandResponse("click", { target: { ref: requireRef(named(baseline.items, "button", "Visible trigger"), "Visible trigger") } }, "visible-names-change");
      }),
      step((request) => { changed = lastTool(request); return commandResponse("inspect_page", { since: baseline.observationId, budget: 12000 }, "visible-names-delta"); }),
      step((request) => { delta = lastTool(request); return commandResponse("click", { target: { ref: requireRef(named(baseline.items, "button", "Identity target"), "Identity target") } }, "visible-names-stale"); }),
      step((request) => { stale = lastTool(request); return commandResponse("inspect_page", { full: true, region: { by: "css", value: "#icon" }, budget: 12000 }, "visible-names-icon"); }),
      step((request) => {
        iconPage = lastTool(request);
        const icon = iconPage.items.find((item: any) => /\bbutton(?:\s|$)/.test(itemLine(item)) && item.ref);
        return commandResponse("click", { target: { ref: requireRef(icon, "icon button") } }, "visible-names-icon-click");
      }),
      step((request) => { iconClick = lastTool(request); return commandResponse("click", { target: { ref: requireRef(named(baseline.items, "button", "Visible DOM control"), "Visible DOM control") } }, "visible-names-dom-click"); }),
      step((request) => { domClick = lastTool(request); return commandResponse("inspect_page", { full: true, region: { by: "css", value: "#scoped" }, budget: 12000 }, "visible-names-scoped"); }),
      step((request) => { scoped = lastTool(request); return commandResponse("inspect_page", { full: true, region: { by: "css", value: "#ellipsized" }, budget: 12000 }, "visible-names-ellipsis"); }),
      step((request) => {
        ellipsisPage = lastTool(request);
        const row = ellipsisPage.items.find((item: any) => /\bbutton(?:\s|$)/.test(itemLine(item)));
        expect(row).toEqual(expect.any(Object));
        expect(itemLine(row)).not.toContain("SECRET_ELLIPSIZED_SUFFIX_A");
        expect(itemLine(row).includes("VISIBLE_PR") || itemLine(row).includes("[name=unknown]")).toBe(true);
        return itemLine(row).includes("[name=unknown]")
          ? commandResponse("take_screenshot", { target: { by: "css", value: "#ellipsized" } }, "visible-names-ellipsis-image")
          : textResponse("VISIBLE_NAMES_DONE");
      }),
      step((request) => { ellipsisCapture = lastTool(request); return textResponse("VISIBLE_NAMES_DONE"); }),
      textResponse("Inspect the visible controls"),
    );
    await (await configureWithImages(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Inspect visible names and operate the controls");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("VISIBLE_NAMES_DONE", { timeout: 100_000 });
    if (problem) throw problem;
    const events = await readEvents(opened.page);

    expect(named(baseline.items, "button", "Visible trigger")?.ref).toEqual(expect.any(String));
    expect(named(baseline.items, "button", "Visible DOM control")?.ref).toEqual(expect.any(String));
    expect(changed).toMatchObject({ ok: true });
    expect(JSON.stringify(deliveredSemanticState(events, changed.pageSnapshot))).toContain("Visible after change");
    expect(JSON.stringify(changed.pageSnapshot.items)).not.toContain("SECRET_IDENTITY_AFTER");
    expect(delta).toMatchObject({ mode: "delta", baseObservationId: baseline.observationId });
    expect(delta.items.some((item: any) => item.change !== "removed" && itemLine(item).includes("Visible after change"))).toBe(true);
    expect(stale).toMatchObject({ ok: false, error: { code: "stale-ref" } });
    expect(JSON.stringify(iconPage.items)).not.toContain("SECRET_ICON_LABEL");
    expect(iconPage.items.some((item: any) => /\bbutton(?:\s|$)/.test(itemLine(item)) && typeof item.ref === "string")).toBe(true);
    expect(iconClick).toMatchObject({ ok: true });
    expect(domClick).toMatchObject({ ok: true });
    expect(JSON.stringify(scoped.items)).toContain("Inside visible caption");
    expect(JSON.stringify(scoped.items)).not.toContain("OUTSIDE_VISIBLE_LABEL");
    if (ellipsisCapture) expect(ellipsisCapture).toMatchObject({ ok: true, result: { screenshot: { mediaType: "image/png" } } });
    expect(await target.locator("body").getAttribute("data-triggered")).toBe("yes");
    expect(await target.locator("body").getAttribute("data-icon")).toBe("yes");
    expect(await target.locator("body").getAttribute("data-dom")).toBe("yes");
    expect(await target.locator("body").getAttribute("data-identity")).toBeNull();
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
