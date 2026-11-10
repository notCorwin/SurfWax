import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, readEvents, type MockResponse } from "./fixtures";
import { deliveredSemanticState } from "./evaluation/semantic-state";
import { itemLine } from "./snapshot-format";

const lastTool = (request: any) => JSON.parse(request.messages.findLast((entry: any) => entry.role === "tool").content);
const button = (items: any[], name: string) => items.find((item) => itemLine(item).includes(`button "${name}"`));

test("filters transparent effects and empty clip shapes while retaining visible content and labels", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    await target.evaluate(() => {
      document.body.innerHTML = `<main>
        <svg aria-hidden="true" width="0" height="0"><defs><filter id="flood"><feFlood flood-color="red" flood-opacity="1"/></filter></defs></svg>
        <button id="reveal">Reveal effects</button>
        <div data-effect style="filter:opacity(0%) blur(1px)"><button>Filter hidden</button><button style="position:fixed;left:20px;top:100px">Filter fixed hidden</button></div>
        <button data-effect style="filter:url(#flood) opacity(0)">Final filter hidden</button>
        <button style="filter:opacity(0) url(#flood)">SVG filter visible</button>
        <div data-effect style="clip-path:circle(0%)"><button>Circle hidden</button></div>
        <div data-effect style="clip-path:ellipse(0% 50%)"><button>Ellipse hidden</button></div>
        <div data-effect style="clip-path:polygon(0 0,0 0,0 0)"><button>Polygon hidden</button></div>
        <button style="filter:opacity(0.2)">Translucent visible</button>
        <button id="circle-partial" style="clip-path:circle(40%)">Circle partial visible</button>
        <button style="backdrop-filter:opacity(0)">Backdrop visible</button>
        <span id="filter-label" style="filter:opacity(0)">Filter accessible name</span><button id="filter-label-button" aria-labelledby="filter-label"></button>
        <button>Visible text<span style="filter:opacity(0)">Hidden effect text</span></button>
      </main>`;
      document.getElementById("reveal")!.addEventListener("click", () => document.querySelectorAll<HTMLElement>("[data-effect]").forEach((element) => {
        element.style.filter = "none";
        element.style.clipPath = "none";
      }));
    });
    const circleRuns = await target.locator("#circle-partial").evaluate((element) => {
      const text = element.firstChild!, box = element.getBoundingClientRect();
      const cx = box.left + box.width / 2, cy = box.top + box.height / 2;
      const radius = .4 * Math.hypot(box.width, box.height) / Math.SQRT2;
      const range = document.createRange(), runs: string[] = [];
      let run = "";
      for (let index = 0; index < text.textContent!.length; index++) {
        range.setStart(text, index); range.setEnd(text, index + 1);
        const rect = range.getBoundingClientRect();
        const inside = rect.width > 0 && rect.height > 0 && [[rect.left, rect.top], [rect.right, rect.top], [rect.left, rect.bottom], [rect.right, rect.bottom]]
          .every(([x, y]) => Math.hypot(x! - cx, y! - cy) < radius - 1);
        if (inside) run += text.textContent![index];
        else if (run) { runs.push(run.replace(/\s+/g, " ").trim()); run = ""; }
      }
      if (run) runs.push(run.replace(/\s+/g, " ").trim());
      return runs.filter(Boolean);
    });
    let baseline: any;
    responses.push(commandResponse("inspect_page", { full: true, budget: 12000 }, "effects-before"),
      (request) => { baseline = lastTool(request); return commandResponse("inspect_page", { full: true, region: { by: "css", value: "#filter-label-button" }, budget: 12000 }, "effects-hidden-label"); },
      () => commandResponse("inspect_page", { full: true, region: { by: "css", value: "#circle-partial" }, budget: 12000 }, "effects-partial-circle"),
      () => commandResponse("click", { target: { id: button(baseline.items, "Reveal effects")?.id } }, "effects-reveal"),
      () => commandResponse("inspect_page", { since: baseline.observationId, budget: 12000 }, "effects-delta"),
      textResponse("EFFECTS_OK"), textResponse("效果测试"));
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Inspect and reveal the page contents");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("EFFECTS_OK", { timeout: 45_000 });
    const events = await readEvents(opened.page);
    const output = (id: string) => events.find((event) => ["tool.finished", "tool.failed"].includes(event.type) && event.toolCallId === id)?.output;
    const before = output("effects-before"), changed = output("effects-reveal"), delta = output("effects-delta");
    expect(delta).toMatchObject({ mode: "delta", baseObservationId: before.observationId });
    const hidden = ["Filter hidden", "Filter fixed hidden", "Final filter hidden", "Circle hidden", "Ellipse hidden", "Polygon hidden"];
    for (const name of hidden) expect(JSON.stringify(before.items)).not.toContain(name);
    for (const name of ["SVG filter visible", "Translucent visible", "Backdrop visible", "Visible text"]) expect(button(before.items, name)?.id, name).toBeTruthy();
    const partial = output("effects-partial-circle")?.items?.find((item: any) => /\bbutton(?:\s|$)/.test(itemLine(item)) && item.id);
    expect(partial?.id).toEqual(expect.any(String));
    const name = /\bbutton\s+("(?:\\.|[^"\\])*")/.exec(itemLine(partial))?.[1];
    if (name) expect(circleRuns.some((run) => run.includes(JSON.parse(name)))).toBe(true);
    else expect(itemLine(partial)).toContain("[name=unknown]");
    expect(JSON.stringify(before.items)).not.toContain("Hidden effect text");
    expect(JSON.stringify(before.items)).not.toContain("Filter accessible name");
    const anonymous = output("effects-hidden-label");
    expect(anonymous?.items?.some((item: any) => /\bbutton(?:\s|$)/.test(itemLine(item)) && typeof item.id === "string")).toBe(true);
    expect(JSON.stringify(anonymous.items)).not.toContain("Filter accessible name");
    expect(changed).toMatchObject({ ok: true });
    for (const name of hidden) {
      expect(button(deliveredSemanticState(events, changed.pageSnapshot), name)?.id).toBeTruthy();
      expect(button(delta.items, name)?.change).toBe("added");
    }
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
