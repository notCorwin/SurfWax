import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, type MockResponse } from "./fixtures";

function lastTool(request: any): any {
  const content = request.messages.findLast((entry: any) => entry.role === "tool").content;
  return JSON.parse(Array.isArray(content) ? content.find((part: any) => part.type === "text").text : content);
}

test("discovers visible ARIA controls omitted by AX regardless of tab stop and preserves region scope", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses), opened = await openExtension();
  let full: any, scoped: any, pressed: any;
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    await target.evaluate(() => {
      document.body.innerHTML = `<main><span id="external-label">External accessible label</span><span id="duplicate-label">FIRST_DUPLICATE</span><span id="duplicate-label">SECOND_DUPLICATE</span><span id="secret-label" style="display:none">HIDDEN_LABEL_SECRET</span><section id="inside" aria-hidden="true">
        <div role="switch" tabindex="0" aria-checked="true" aria-label="Keyboard switch">Visible on</div>
        <div role="checkbox" tabindex="-1" aria-checked="mixed" aria-label="Programmatic checkbox">Programmatic checkbox</div>
        <div role="button" aria-expanded="true" aria-label="Expanded button">Visible details</div>
        <input id="native-checkbox" type="checkbox" aria-label="Native mixed">
        <div role="checkbox" tabindex="0" aria-labelledby="external-label" aria-checked="false">Visible checkbox caption</div>
        <div role="switch" tabindex="0" aria-labelledby="external-label secret-label" aria-checked="true">Visible partial caption</div>
        <div role="switch" tabindex="0" aria-labelledby="external-label" aria-label="Wrong lower priority" aria-checked="false">Priority caption</div>
        <div role="checkbox" tabindex="0" aria-labelledby="does-not-exist" aria-label="Invalid fallback" aria-checked="false">Invalid caption</div>
        <div role="checkbox" tabindex="0" aria-labelledby="" aria-label="Empty fallback" aria-checked="false">Empty caption</div>
        <div role="checkbox" tabindex="0" id="self-label" aria-labelledby="self-label" aria-checked="false">Self caption</div>
        <div role="checkbox" tabindex="0" aria-labelledby="duplicate-label" aria-checked="false">Duplicate caption</div>
        <div role="checkbox" tabindex="0" aria-labelledby="secret-label" aria-checked="false">Hidden label caption</div>
        <div id="programmatic-label" role="switch" tabindex="0" aria-checked="false">Programmatic caption</div>
        <div role="switch" tabindex="0" aria-label="Hidden switch" style="display:none">Hidden switch</div>
        <div role="heading" tabindex="0">Noninteractive heading</div>
      </section><section aria-hidden="true"><div role="switch" tabindex="0" aria-label="Outside switch">Outside switch</div></section></main>`;
      for (const mode of ["open", "closed"] as const) {
        const host = document.createElement("div");
        document.querySelector("main")!.append(host);
        host.attachShadow({ mode }).innerHTML = `<span id="external-label">${mode} shadow label</span><div aria-hidden="true"><div role="checkbox" tabindex="0" aria-labelledby="external-label" aria-checked="false">Shadow visible caption</div></div>`;
      }
      (document.querySelector("#programmatic-label") as Element).ariaLabelledByElements = [document.querySelector("#external-label")!];
      (document.querySelector("#native-checkbox") as HTMLInputElement).indeterminate = true;
      document.querySelector('[aria-label="Keyboard switch"]')!.addEventListener("keydown", (event) => {
        if ((event as KeyboardEvent).key === " ") (event.currentTarget as Element).setAttribute("aria-checked", "false");
      });
    });
    responses.push(commandResponse("inspect_page", { fields: ["text", "state", "ref", "actions"], budget: 12000 }, "aria-full"), (request) => {
      full = lastTool(request);
      return commandResponse("inspect_page", { budget: 12000, region: { by: "css", value: "#inside" } }, "aria-region");
    }, (request) => {
      scoped = lastTool(request);
      const ref = scoped.items?.find((item: any) => item.line.includes('- switch "Visible on"'))?.ref;
      return ref ? commandResponse("press_key", { target: { ref }, key: "Space" }, "aria-press") : textResponse("ARIA_DOM_DONE");
    }, (request) => { pressed = lastTool(request); return textResponse("ARIA_DOM_DONE"); }, textResponse("Inspect the page"));
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Inspect the controls");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("ARIA_DOM_DONE", { timeout: 45_000 });
    expect(full).toMatchObject({ mode: "full", truncation: { baselineComplete: true } });
    for (const name of ["Visible on", "Programmatic checkbox", "Visible details", "Outside switch"]) {
      const item = full.items.find((entry: any) => entry.line.includes(`"${name}"`));
      expect(item?.ref, JSON.stringify(full.items)).toEqual(expect.any(String));
    }
    expect(full.items.some((item: any) => item.line.includes('- switch "Visible on"'))).toBe(true);
    expect(full.items.some((item: any) => item.line.includes('- checkbox "Programmatic checkbox"') && item.line.includes("checked=mixed"))).toBe(true);
    expect(full.items.some((item: any) => item.line.includes('- switch "Visible on"') && item.line.includes("checked=true"))).toBe(true);
    const keyboard = full.items.find((item: any) => item.line.includes('- switch "Visible on"'));
    expect(keyboard.line).toContain("[actions=press_key]");
    expect(full.items.some((item: any) => item.line.includes('- button "Visible details"') && item.line.includes("expanded=true"))).toBe(true);
    const native = full.items.find((item: any) => item.line.includes("- checkbox") && item.line.includes("[name=unknown]") && item.line.includes("checked=mixed"));
    expect(native?.ref).toEqual(expect.any(String));
    expect(JSON.stringify(full.items)).toContain("Visible on");
    expect(JSON.stringify(full.items)).toContain("Visible details");
    expect(full.items.find((item: any) => item.line.includes('- checkbox "Visible checkbox caption"'))?.ref).toEqual(expect.any(String));
    const partial = full.items.find((item: any) => item.line.includes('- switch "Visible partial caption"'));
    expect(partial?.ref).toEqual(expect.any(String));
    expect(JSON.stringify(full.items)).not.toContain("HIDDEN_LABEL_SECRET");
    expect(JSON.stringify(full.items)).toContain("Visible checkbox caption");
    expect(JSON.stringify(full.items)).toContain("Visible partial caption");
    const priority = full.items.find((item: any) => item.line.includes('- switch "Priority caption"') && item.line.includes("checked=false"));
    expect(priority?.line).not.toContain("Wrong lower priority");
    expect(priority?.ref).toEqual(expect.any(String));
    const programmatic = full.items.find((item: any) => item.line.includes('- switch "Programmatic caption"') && item.line.includes("checked=false"));
    expect(programmatic?.ref).toEqual(expect.any(String));
    for (const name of ["Invalid caption", "Empty caption", "Self caption", "Duplicate caption"]) {
      expect(full.items.find((item: any) => item.line.includes(`- checkbox "${name}"`))?.ref, name).toEqual(expect.any(String));
    }
    expect(JSON.stringify(full.items)).toContain("FIRST_DUPLICATE");
    expect(JSON.stringify(full.items)).toContain("SECOND_DUPLICATE");
    for (const name of ["open shadow label", "closed shadow label"]) expect(JSON.stringify(full.items)).toContain(name);
    const shadows = full.items.filter((item: any) => item.line.includes('- checkbox "Shadow visible caption"'));
    expect(shadows).toHaveLength(2);
    expect(shadows.every((item: any) => typeof item.ref === "string")).toBe(true);
    expect(new Set(shadows.map((item: any) => item.ref)).size).toBe(2);
    const hidden = full.items.find((item: any) => item.line.includes('- checkbox "Hidden label caption"'));
    expect(hidden?.ref).toEqual(expect.any(String));
    for (const label of ["Keyboard switch", "Expanded button", "Native mixed", "Invalid fallback", "Empty fallback", "Wrong lower priority"])
      expect(JSON.stringify(full.items)).not.toContain(label);
    expect(JSON.stringify(full.items)).not.toContain("Hidden switch");
    expect(full.items.some((item: any) => /- heading "Noninteractive heading"/.test(item.line))).toBe(false);
    expect(JSON.stringify(scoped.items)).toContain("Visible on");
    expect(JSON.stringify(scoped.items)).not.toContain("Outside switch");
    expect(JSON.stringify(scoped.items)).not.toContain("External accessible label");
    expect(scoped.items.find((item: any) => item.line.includes('- checkbox "Visible checkbox caption"'))?.ref).toEqual(expect.any(String));
    expect(JSON.stringify(scoped.items)).not.toContain("HIDDEN_LABEL_SECRET");
    expect(pressed).toMatchObject({ ok: true });
    expect(JSON.stringify(pressed.pageSnapshot)).toContain("checked=false");
    expect(await target.locator('[aria-label="Keyboard switch"]').getAttribute("aria-checked")).toBe("false");
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});


test("keeps a visible control actionable when its private labelledby identity repeats", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses), opened = await openExtension();
  let snapshot: any, pressed: any;
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    const expected = Array(64).fill("A").join(" ");
    const nodeCount = await target.evaluate(() => {
      document.body.innerHTML = `<span id="a">A</span><div aria-hidden="true"><div id="repeat-control" role="checkbox" tabindex="0" aria-labelledby="${Array(64).fill("a").join(" ")}" aria-checked="false">Visible content</div></div>`;
      document.getElementById("repeat-control")!.addEventListener("keydown", (event) => {
        if ((event as KeyboardEvent).key === " ") (event.currentTarget as Element).setAttribute("aria-checked", "true");
      });
      return document.querySelectorAll("*").length;
    });
    expect(nodeCount).toBeLessThan(64);
    responses.push(commandResponse("inspect_page", { budget: 12000 }, "repeat-label"), (request) => {
      snapshot = lastTool(request);
      const checkbox = snapshot.items?.find((item: any) => item.line.includes('- checkbox "Visible content"'));
      return commandResponse("press_key", { target: { ref: checkbox?.ref }, key: "Space" }, "repeat-label-press");
    }, (request) => {
      pressed = lastTool(request); return textResponse("REPEAT_LABEL_DONE");
    }, textResponse("Inspect the checkbox"));
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Inspect the checkbox");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("REPEAT_LABEL_DONE", { timeout: 45_000 });
    expect(snapshot).toMatchObject({ mode: "full", truncation: { baselineComplete: true } });
    const checkbox = snapshot.items.find((item: any) => item.line.includes('- checkbox "Visible content"'));
    expect(checkbox?.ref).toEqual(expect.any(String));
    expect(checkbox.line).toContain("checked=false");
    expect(JSON.stringify(snapshot.items)).toContain("Visible content");
    expect(JSON.stringify(snapshot.items)).not.toContain(expected);
    expect(pressed).toMatchObject({ ok: true });
    expect(await target.locator("#repeat-control").getAttribute("aria-checked")).toBe("true");
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
