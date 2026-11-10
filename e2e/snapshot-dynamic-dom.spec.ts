import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, type MockResponse } from "./fixtures";
import { itemLine } from "./snapshot-format";

test.use({ screenshot: "off", trace: "off" });

function lastTool(request: any): any {
  const message = request.messages.findLast((entry: any) => entry.role === "tool");
  const content = Array.isArray(message.content) ? message.content.find((part: any) => part.type === "text").text : message.content;
  return JSON.parse(content);
}

function lines(snapshot: any): any[] {
  return snapshot?.items ?? [];
}

test("a changing visible clock does not block a stable button or replay its click", async () => {
  test.setTimeout(90_000);
  const responses: MockResponse[] = [], provider = await startProvider(responses), opened = await openExtension();
  let observed: any, action: any;
  try {
    const target = await opened.context.newPage();
    await target.setViewportSize({ width: 1200, height: 800 });
    await target.goto(`${provider.origin}/target`);
    await target.evaluate(() => {
      document.body.innerHTML = `<style>body{font:16px monospace}#clock{display:inline-block;width:10ch}</style><main><output id="clock">TICK_00000</output><button id="stable">Save once</button><output id="count">COUNT_0</output></main>`;
      const ballast = document.createElement("div"); ballast.hidden = true;
      ballast.innerHTML = "<span>unchanged</span>".repeat(4000); document.body.append(ballast);
      let tick = 0, count = 0;
      setInterval(() => { document.querySelector("#clock")!.textContent = `TICK_${String(++tick % 100000).padStart(5, "0")}`; }, 1);
      document.querySelector("#stable")!.addEventListener("click", () => { document.querySelector("#count")!.textContent = `COUNT_${++count}`; });
    });
    responses.push(
      commandResponse("inspect_page", { budget: 12000, fields: ["text", "state", "ref"] }, "dynamic-inspect"),
      (request) => {
        observed = lastTool(request);
        const stable = lines(observed).find((item) => itemLine(item)?.includes('button "Save once"'));
        return commandResponse("click", { target: stable?.ref ? { ref: stable.ref } : { by: "role", value: "button", name: "Save once" } }, "dynamic-click");
      },
      (request) => { action = lastTool(request); return textResponse("DYNAMIC_CLOCK_DONE"); },
      textResponse("Dynamic page"),
    );
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Inspect the clock and click Save once");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("DYNAMIC_CLOCK_DONE", { timeout: 70_000 });
    expect(observed).toMatchObject({ partial: true, items: expect.any(Array) });
    expect(lines(observed).find((item) => itemLine(item)?.includes('button "Save once"'))?.ref).toEqual(expect.any(String));
    expect(action).toMatchObject({ ok: true });
    await expect(target.locator("#count")).toHaveText("COUNT_1");
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("a changing external label does not produce a stale actionable button name", async () => {
  test.setTimeout(90_000);
  const responses: MockResponse[] = [], provider = await startProvider(responses), opened = await openExtension();
  let observed: any;
  try {
    const target = await opened.context.newPage();
    await target.setViewportSize({ width: 1200, height: 800 });
    await target.goto(`${provider.origin}/target`);
    await target.evaluate(() => {
      document.body.innerHTML = `<style>body{font:16px monospace}#label{display:inline-block;width:12ch}</style><main><section><span id="label">LABEL_00000</span></section><section><button aria-labelledby="label"></button><button>Independent</button></section></main>`;
      const ballast = document.createElement("div"); ballast.hidden = true;
      ballast.innerHTML = "<span>unchanged</span>".repeat(4000); document.body.append(ballast);
      let tick = 0;
      setInterval(() => { document.querySelector("#label")!.textContent = `LABEL_${String(++tick % 100000).padStart(5, "0")}`; }, 1);
    });
    responses.push(
      commandResponse("inspect_page", { budget: 12000, fields: ["text", "state", "ref"] }, "dynamic-label-inspect"),
      (request) => { observed = lastTool(request); return textResponse("DYNAMIC_LABEL_DONE"); },
      textResponse("Dynamic label"),
    );
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Inspect both buttons");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("DYNAMIC_LABEL_DONE", { timeout: 70_000 });
    expect(observed).toMatchObject({ partial: true, items: expect.any(Array) });
    const buttons = lines(observed).filter((item) => /\bbutton(?:\s|$)/.test(itemLine(item)));
    expect(buttons.find((item) => itemLine(item).includes('"Independent"'))?.ref).toEqual(expect.any(String));
    const changingButton = buttons.find((item) => itemLine(item).includes("[name=unknown]"));
    expect(changingButton).toBeDefined();
    expect(changingButton?.ref).toBeUndefined();
    expect(buttons.some((item) => itemLine(item).includes("LABEL_"))).toBe(false);
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

for (const kind of ["native-label", "geometry", "ellipsis", "ellipsis-replace", "contenteditable"] as const) {
  test(`handles dynamic ${kind} without exposing stale evidence`, async () => {
    test.setTimeout(90_000);
    const responses: MockResponse[] = [], provider = await startProvider(responses), opened = await openExtension();
    let observed: any;
    try {
      const target = await opened.context.newPage();
      await target.setViewportSize({ width: 1200, height: 800 });
      await target.goto(`${provider.origin}/target`);
      await target.evaluate((kind) => {
        const content = {
          "native-label": '<label id="changing" for="field">NATIVE_00000</label><input id="field">',
          geometry: '<span id="changing" style="display:inline-block;width:80px">MOVING</span><button>Moving neighbor</button>',
          ellipsis: '<button id="changing" style="display:inline-block;width:6ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">ELLIPSIS_VALUE_00000</button>',
          "ellipsis-replace": '<button id="changing" style="display:inline-block;width:6ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">ELLIPSIS_VALUE_00000</button>',
          contenteditable: '<div id="changing" role="textbox" contenteditable="true">EDITABLE_00000</div>',
        }[kind];
        document.body.innerHTML = `<style>body{font:16px monospace}</style><main>${content}<button>Independent</button></main>`;
        const ballast = document.createElement("div"); ballast.hidden = true;
        ballast.innerHTML = "<span>unchanged</span>".repeat(4000); document.body.append(ballast);
        let tick = 0;
        setInterval(() => {
          const changing = document.querySelector<HTMLElement>("#changing")!;
          const value = String(++tick % 100000).padStart(5, "0");
          if (kind === "geometry") { changing.style.width = `${80 + tick % 500}px`; changing.textContent = `MOVING_${value}`; }
          else if (kind === "ellipsis") changing.firstChild!.nodeValue = `ELLIPSIS_VALUE_${value}`;
          else changing.textContent = `${{ "native-label": "NATIVE", "ellipsis-replace": "ELLIPSIS_VALUE", contenteditable: "EDITABLE" }[kind]}_${value}`;
        }, 1);
      }, kind);
      responses.push(
        commandResponse("inspect_page", { budget: 12000, fields: ["text", "state", "ref"] }, `dynamic-${kind}-inspect`),
        (request) => { observed = lastTool(request); return textResponse(`DYNAMIC_${kind}_DONE`); },
        textResponse("Dynamic content"),
      );
      await (await configure(opened.context, opened.page, provider.baseURL)).close();
      await target.bringToFront();
      await opened.page.getByTestId("composer-input").fill("Inspect the changing page");
      await opened.page.getByTestId("composer-input").press("Enter");
      await expect(opened.page.locator(".markdown-body").last()).toContainText(`DYNAMIC_${kind}_DONE`, { timeout: 70_000 });
      await test.info().attach("dynamic-observation", { body: JSON.stringify({ kind, observed }), contentType: "application/json" });
      if (observed?.limitations) {
        expect(observed).toMatchObject({ partial: true, limitations: expect.stringContaining("Read-only"), items: expect.any(Array) });
        expect(lines(observed).every((item) => !item.ref)).toBe(true);
        expect(lines(observed).some((item) => itemLine(item).includes("Independent"))).toBe(true);
        return;
      }
      if (kind === "geometry" && observed?.ok === false) {
        expect(observed.error.code).toBe("snapshot-unavailable");
        return;
      }
      expect(observed).toMatchObject({ partial: true, items: expect.any(Array) });
      const items = lines(observed);
      expect(items.find((item) => itemLine(item)?.includes('button "Independent"'))?.ref).toEqual(expect.any(String));
      if (kind === "geometry") {
        expect(items.find((item) => itemLine(item)?.includes('button "Moving neighbor"'))?.ref).toBeUndefined();
      } else if (kind === "native-label") {
        const field = items.find((item) => /\btextbox\b/.test(itemLine(item)));
        expect(itemLine(field)).toContain("[name=unknown]");
        expect(field?.ref).toBeUndefined();
        expect(itemLine(field)).not.toContain("NATIVE_");
      } else if (kind === "ellipsis" || kind === "ellipsis-replace") {
        const button = items.find((item) => /\bbutton\b/.test(itemLine(item)) && !itemLine(item).includes('"Independent"'));
        expect(itemLine(button)).toContain("[name=unknown]");
        expect(button?.ref).toBeUndefined();
        expect(itemLine(button)).not.toContain("ELLIP");
      } else {
        const editable = items.find((item) => /\btextbox\b/.test(itemLine(item)));
        expect(editable).toBeDefined();
        expect(editable?.ref).toBeUndefined();
        expect(itemLine(editable)).not.toContain("EDITABLE_");
      }
    } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
  });
}

test("a partial action-reference cursor survives dynamic text replacement but expires on static geometry changes", async () => {
  test.setTimeout(90_000);
  const responses: MockResponse[] = [], provider = await startProvider(responses), opened = await openExtension();
  let first: any, continuation: any, action: any, stale: any;
  try {
    const target = await opened.context.newPage();
    await target.setViewportSize({ width: 1200, height: 800 });
    await target.goto(`${provider.origin}/target`);
    await target.evaluate(() => {
      document.body.innerHTML = '<style>body{font:16px monospace}p{margin:0}#clock{display:inline-block;width:12ch}</style><main><output id="clock">TICK_00000</output><button id="move">Move</button><p id="anchor">STATIC_ANCHOR</p></main>';
      const main = document.querySelector("main")!;
      for (let i = 0; i < 20; i++) { const p = document.createElement("p"); p.textContent = `ROW_${i}_VISIBLE`; main.append(p); }
      const ballast = document.createElement("div"); ballast.hidden = true;
      ballast.innerHTML = "<span>unchanged</span>".repeat(1000); document.body.append(ballast);
      let tick = 0;
      setInterval(() => { document.querySelector("#clock")!.textContent = `TICK_${String(++tick % 100000).padStart(5, "0")}`; }, 1);
      document.querySelector("#move")!.addEventListener("click", () => { document.querySelector<HTMLElement>("#anchor")!.style.marginLeft = "80px"; });
    });
    responses.push(
      commandResponse("inspect_page", { fields: ["text", "state", "ref"], budget: 12000, limit: 2 }, "dynamic-page-first"),
      (request) => { first = lastTool(request); return commandResponse("inspect_page", { cursor: first?.nextCursor ?? "missing", budget: 12000, limit: 2 }, "dynamic-page-next"); },
      (request) => { continuation = lastTool(request); return commandResponse("click", { target: { by: "css", value: "#move" } }, "dynamic-page-move"); },
      (request) => { action = lastTool(request); return commandResponse("inspect_page", { cursor: first?.nextCursor ?? "missing", budget: 12000, limit: 2 }, "dynamic-page-stale"); },
      (request) => { stale = lastTool(request); return textResponse("DYNAMIC_CURSOR_DONE"); },
      textResponse("Dynamic pagination"),
    );
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Read and continue the changing page");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("DYNAMIC_CURSOR_DONE", { timeout: 70_000 });
    expect(first).toMatchObject({ partial: true, nextCursor: expect.any(String), items: expect.any(Array) });
    expect(continuation).toMatchObject({ partial: true, observationId: first.observationId, items: expect.any(Array) });
    expect(action).toMatchObject({ ok: true });
    expect(stale).toMatchObject({ ok: false, error: { code: "stale-observation" } });
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
