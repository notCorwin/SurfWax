import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, readEvents, type MockResponse } from "./fixtures";
import { deliveredSemanticState } from "./evaluation/semantic-state";
import { itemLine } from "./snapshot-format";

const lastTool = (request: any) => JSON.parse(request.messages.findLast((entry: any) => entry.role === "tool").content);
const button = (items: any[], name: string) => items.find((entry) => itemLine(entry).includes(`button "${name}"`));

test("snapshot follows rendered text visibility and updates when the text is revealed", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    await target.evaluate(() => {
      document.body.innerHTML = `<main>
        <button id="reveal">Reveal painted text</button>
        <button>Visible text<span data-reveal style="color:transparent"> hidden transparent child</span></button>
        <button>Visible size<span data-reveal style="font-size:0"> hidden zero-size child</span></button>
        <p data-reveal style="color:transparent">Standalone transparent text</p>
        <p data-reveal style="font-size:0">Standalone zero-size text</p>
        <p style="text-transform:uppercase">mixed Case sample</p>
        <p style="color:rgba(0,0,0,.2)">Translucent text</p>
        <p style="color:transparent;text-shadow:1px 1px 0 black">Shadow painted text</p>
        <p style="color:transparent;-webkit-text-stroke:1px black">Stroke painted text</p>
        <p id="gradient" style="background:linear-gradient(red,blue);background-clip:text;-webkit-background-clip:text;color:transparent"><span id="gradient-text">Gradient painted text</span></p>
        <span id="label" style="color:transparent">Accessible hidden label</span><button id="transparent-label-button" aria-labelledby="label"></button>
        <button aria-label="Explicit label">Visible button<span style="color:transparent"> hidden explicit child</span></button>
      </main>`;
      document.querySelector("#reveal")!.addEventListener("click", () => {
        document.querySelectorAll<HTMLElement>("[data-reveal]").forEach((element) => {
          element.style.color = "black";
          element.style.fontSize = "16px";
        });
      });
    });
    const painted = await target.locator("#gradient").screenshot();
    await target.locator("#gradient-text").evaluate((element) => { (element as HTMLElement).style.visibility = "hidden"; });
    const notPainted = await target.locator("#gradient").screenshot();
    await target.locator("#gradient-text").evaluate((element) => { (element as HTMLElement).style.removeProperty("visibility"); });
    expect(painted.equals(notPainted)).toBe(false);
    let baseline: any;
    responses.push(
      commandResponse("inspect_page", { full: true, budget: 12000 }, "text-before"),
      (request) => { baseline = lastTool(request); return commandResponse("inspect_page", { full: true, region: { by: "css", value: "#transparent-label-button" }, budget: 12000 }, "text-transparent-label"); },
      () => commandResponse("click", { target: { ref: button(baseline.items, "Reveal painted text")?.ref } }, "text-reveal"),
      () => commandResponse("inspect_page", { since: baseline.observationId, budget: 12000 }, "text-delta"),
      textResponse("TEXT_PAINT_OK"), textResponse("文字检查"),
    );
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Inspect the visible text and reveal the rest");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("TEXT_PAINT_OK", { timeout: 45_000 });
    const events = await readEvents(opened.page);
    const output = (id: string) => events.find((event) => ["tool.finished", "tool.failed"].includes(event.type) && event.toolCallId === id)?.output;
    const before = output("text-before"), changed = output("text-reveal"), delta = output("text-delta");
    expect(before?.mode).toBe("full");
    expect(delta).toMatchObject({ mode: "delta", baseObservationId: before.observationId });
    expect(button(before.items, "Visible text")?.ref).toBeTruthy();
    expect(button(before.items, "Visible size")?.ref).toBeTruthy();
    for (const hidden of ["hidden transparent child", "hidden zero-size child", "Standalone transparent text", "Standalone zero-size text", "hidden explicit child"]) {
      expect(JSON.stringify(before.items)).not.toContain(hidden);
    }
    expect(JSON.stringify(before.items)).not.toContain("Accessible hidden label");
    expect(JSON.stringify(before.items)).not.toContain("Explicit label");
    expect(button(before.items, "Visible button")?.ref).toBeTruthy();
    const transparentLabel = output("text-transparent-label");
    expect(transparentLabel?.items?.some((item: any) => /\bbutton(?:\s|$)/.test(itemLine(item)) && typeof item.ref === "string")).toBe(true);
    expect(JSON.stringify(transparentLabel.items)).not.toContain("Accessible hidden label");
    for (const visible of ["MIXED CASE SAMPLE", "Translucent text", "Shadow painted text", "Stroke painted text", "Gradient painted text"]) {
      expect(JSON.stringify(before.items)).toContain(visible);
    }
    expect(changed).toMatchObject({ ok: true });
    for (const revealed of ["hidden transparent child", "hidden zero-size child", "Standalone transparent text", "Standalone zero-size text"]) {
      expect(JSON.stringify(deliveredSemanticState(events, changed.pageSnapshot))).toContain(revealed);
      expect(delta.items.some((entry: any) => entry.change !== "removed" && itemLine(entry).includes(revealed))).toBe(true);
    }
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

for (const [kind, partial] of [["selection", false], ["selection", true], ["custom-highlight", false], ["custom-highlight", true]] as const) {
  test(`retains transparent text painted by ${kind}${partial ? " over a middle substring" : ""}`, async () => {
    const responses: MockResponse[] = [commandResponse("inspect_page", { full: true, budget: 12000 }, "highlight-snapshot"), textResponse("HIGHLIGHT_OK"), textResponse("高亮检查")];
    const provider = await startProvider(responses);
    const opened = await openExtension();
    try {
      const target = await opened.context.newPage();
      await target.goto(`${provider.origin}/target`);
      const supported = await target.evaluate(({ mode, partial }) => {
        if (mode === "custom-highlight" && (!("highlights" in CSS) || !("Highlight" in window))) return false;
        document.body.innerHTML = `<style>
          #painted::selection { color:black; background-color:yellow; }
          body.no-glyph #painted::selection { color:transparent; }
          #painted::highlight(surfWaxTest) { color:black; background-color:yellow; }
          body.no-glyph #painted::highlight(surfWaxTest) { color:transparent; }
        </style><main><p id="painted" style="color:transparent">${partial ? "HIDDEN_PREFIX Painted highlight text HIDDEN_SUFFIX" : "Painted highlight text"}</p><p style="color:transparent">Unpainted transparent text</p></main>`;
        const range = document.createRange();
        const text = document.getElementById("painted")!.firstChild!;
        if (partial) {
          const start = text.textContent!.indexOf("Painted highlight text");
          range.setStart(text, start);
          range.setEnd(text, start + "Painted highlight text".length);
        } else range.selectNodeContents(text);
        if (mode === "selection") { const selection = getSelection()!; selection.removeAllRanges(); selection.addRange(range); }
        else CSS.highlights.set("surfWaxTest", new Highlight(range));
        return true;
      }, { mode: kind, partial });
      test.skip(!supported, "Chrome does not support the Custom Highlight API");
      // Compare identical highlighted backgrounds with and without the glyph
      // color. This proves that the letters, rather than only a selection
      // rectangle, are actually painted on the current browser.
      const painted = await target.locator("#painted").screenshot();
      await target.evaluate(() => document.body.classList.add("no-glyph"));
      const noGlyph = await target.locator("#painted").screenshot();
      await target.evaluate(() => document.body.classList.remove("no-glyph"));
      expect(painted.equals(noGlyph)).toBe(false);
      await (await configure(opened.context, opened.page, provider.baseURL)).close();
      await target.bringToFront();
      await opened.page.getByTestId("composer-input").fill("Inspect the highlighted page");
      await opened.page.getByTestId("composer-input").press("Enter");
      await expect(opened.page.locator(".markdown-body").last()).toContainText("HIGHLIGHT_OK", { timeout: 45_000 });
      const stillPainted = await target.locator("#painted").screenshot();
      await target.evaluate(() => document.body.classList.add("no-glyph"));
      const stillNoGlyph = await target.locator("#painted").screenshot();
      await target.evaluate(() => document.body.classList.remove("no-glyph"));
      expect(stillPainted.equals(stillNoGlyph)).toBe(false);
      const events = await readEvents(opened.page);
      const result = events.find((event) => event.type === "tool.finished" && event.toolCallId === "highlight-snapshot")?.output;
      expect(JSON.stringify(result?.items)).toContain("Painted highlight text");
      if (partial) {
        expect(JSON.stringify(result?.items)).not.toContain("HIDDEN_PREFIX");
        expect(JSON.stringify(result?.items)).not.toContain("HIDDEN_SUFFIX");
      }
      expect(JSON.stringify(result?.items)).not.toContain("Unpainted transparent text");
    } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
  });
}

for (const kind of ["first-line", "first-letter"] as const) {
  test(`retains text painted by ::${kind} on a transparent base`, async () => {
    const responses: MockResponse[] = [commandResponse("inspect_page", { full: true, budget: 12000 }, "pseudo-snapshot"), textResponse("PSEUDO_OK"), textResponse("伪元素检查")];
    const provider = await startProvider(responses);
    const opened = await openExtension();
    try {
      const target = await opened.context.newPage();
      await target.goto(`${provider.origin}/target`);
      await target.evaluate((mode) => {
        const text = mode === "first-line" ? "Painted first line\nUnpainted later line" : "Xunpainted suffix";
        document.body.innerHTML = `<style>
          #painted::${mode} { color:black; }
          body.no-glyph #painted::${mode} { color:transparent; }
        </style><main><p id="painted" style="color:transparent;white-space:pre-line">${text}</p><p style="color:transparent">Ordinary transparent text</p></main>`;
      }, kind);
      // Only the pseudo-element's color changes; the screenshot difference
      // proves that it paints glyphs despite the transparent base color.
      const painted = await target.locator("#painted").screenshot();
      await target.evaluate(() => document.body.classList.add("no-glyph"));
      const noGlyph = await target.locator("#painted").screenshot();
      await target.evaluate(() => document.body.classList.remove("no-glyph"));
      expect(painted.equals(noGlyph)).toBe(false);
      await (await configure(opened.context, opened.page, provider.baseURL)).close();
      await target.bringToFront();
      await opened.page.getByTestId("composer-input").fill("Inspect the painted text");
      await opened.page.getByTestId("composer-input").press("Enter");
      await expect(opened.page.locator(".markdown-body").last()).toContainText("PSEUDO_OK", { timeout: 45_000 });
      const events = await readEvents(opened.page);
      const result = events.find((event) => event.type === "tool.finished" && event.toolCallId === "pseudo-snapshot")?.output;
      const lines: string[] = (result?.items ?? []).map((entry: any) => itemLine(entry));
      if (kind === "first-line") {
        expect(lines.some((line) => line.includes("Painted first line"))).toBe(true);
        expect(JSON.stringify(lines)).not.toContain("Unpainted later line");
      }
      else {
        expect(lines.some((line) => /StaticText\s+"X"/.test(line))).toBe(true);
        expect(JSON.stringify(lines)).not.toContain("unpainted suffix");
      }
      expect(JSON.stringify(lines)).not.toContain("Ordinary transparent text");
    } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
  });
}

for (const kind of ["uppercase", "text-security"] as const) {
  test(`projects a selected substring after ${kind} transforms it`, async () => {
    const responses: MockResponse[] = [commandResponse("inspect_page", { full: true, budget: 12000 }, "transform-selection"), textResponse("TRANSFORM_SELECTION_OK"), textResponse("文字转换检查")];
    const provider = await startProvider(responses);
    const opened = await openExtension();
    try {
      const target = await opened.context.newPage();
      await target.goto(`${provider.origin}/target`);
      await target.evaluate((mode) => {
        const text = mode === "uppercase" ? "hidden_before maß hidden_after" : "HIDDEN_BEFORE A😀B HIDDEN_AFTER";
        const selected = mode === "uppercase" ? "maß" : "A😀B";
        const transform = mode === "uppercase" ? "text-transform:uppercase" : "-webkit-text-security:disc";
        document.body.innerHTML = `<style>
          #painted::selection { color:black; background-color:yellow; }
          body.no-glyph #painted::selection { color:transparent; }
        </style><main><p id="painted" style="color:transparent;${transform}">${text}</p></main>`;
        const node = document.getElementById("painted")!.firstChild!;
        const start = node.textContent!.indexOf(selected);
        const range = document.createRange();
        range.setStart(node, start); range.setEnd(node, start + selected.length);
        const selection = getSelection()!; selection.removeAllRanges(); selection.addRange(range);
      }, kind);
      const painted = await target.locator("#painted").screenshot();
      await target.evaluate(() => document.body.classList.add("no-glyph"));
      const noGlyph = await target.locator("#painted").screenshot();
      await target.evaluate(() => document.body.classList.remove("no-glyph"));
      expect(painted.equals(noGlyph)).toBe(false);
      await (await configure(opened.context, opened.page, provider.baseURL)).close();
      await target.bringToFront();
      await opened.page.getByTestId("composer-input").fill("Inspect the selected text");
      await opened.page.getByTestId("composer-input").press("Enter");
      await expect(opened.page.locator(".markdown-body").last()).toContainText("TRANSFORM_SELECTION_OK", { timeout: 45_000 });
      const stillPainted = await target.locator("#painted").screenshot();
      await target.evaluate(() => document.body.classList.add("no-glyph"));
      const stillNoGlyph = await target.locator("#painted").screenshot();
      await target.evaluate(() => document.body.classList.remove("no-glyph"));
      expect(stillPainted.equals(stillNoGlyph)).toBe(false);
      const events = await readEvents(opened.page);
      const result = events.find((event) => event.type === "tool.finished" && event.toolCallId === "transform-selection")?.output;
      const textLines: string[] = (result?.items ?? []).map((entry: any) => itemLine(entry)).filter((line: string) => line.includes("- StaticText"));
      const expected = kind === "uppercase" ? "MASS" : "•••";
      expect(textLines).toHaveLength(1);
      expect(textLines[0]).toMatch(new RegExp(`StaticText "${expected}"`));
      expect(JSON.stringify(textLines)).not.toMatch(/HIDDEN_BEFORE|HIDDEN_AFTER/);
    } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
  });
}

test("projects every visible inline fragment in a mixed-size first line", async () => {
  const responses: MockResponse[] = [commandResponse("inspect_page", { full: true, budget: 12000 }, "mixed-first-line"), textResponse("MIXED_FIRST_LINE_OK"), textResponse("首行检查")];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    await target.evaluate(() => {
      document.body.innerHTML = `<style>
        #painted::first-line { color:black; }
        body.no-glyph #painted::first-line { color:transparent; }
      </style><main><p id="painted" style="color:transparent;line-height:40px;width:600px">BASE <span id="big" style="font-size:30px">BIG</span> <sup id="sup">SUP</sup> END<br>HIDDEN SECOND LINE</p></main>`;
    });
    const painted = await Promise.all(["#painted", "#big", "#sup"].map((selector) => target.locator(selector).screenshot()));
    await target.evaluate(() => document.body.classList.add("no-glyph"));
    const noGlyph = await Promise.all(["#painted", "#big", "#sup"].map((selector) => target.locator(selector).screenshot()));
    await target.evaluate(() => document.body.classList.remove("no-glyph"));
    for (let index = 0; index < painted.length; index++) expect(painted[index]!.equals(noGlyph[index]!)).toBe(false);
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Inspect the painted first line");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("MIXED_FIRST_LINE_OK", { timeout: 45_000 });
    const events = await readEvents(opened.page);
    const result = events.find((event) => event.type === "tool.finished" && event.toolCallId === "mixed-first-line")?.output;
    const lines = JSON.stringify(result?.items);
    for (const visible of ["BASE", "BIG", "SUP", "END"]) expect(lines).toContain(visible);
    expect(lines).not.toContain("HIDDEN SECOND LINE");
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("filters transparent generated text but keeps painted pseudo-elements and updates after style changes", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    await target.evaluate(() => {
      document.body.innerHTML = `<style>
        #generated-button::before { content:"Hidden button before "; color:transparent; }
        #generated-button::after { content:" Visible button after"; color:black; }
        #generated-paragraph::before { content:"Hidden standalone before "; color:transparent; }
        #generated-paragraph::after { content:" Visible standalone after"; color:black; }
        body.show-generated #generated-button::before, body.show-generated #generated-paragraph::before { color:black; }
        body.hide-after #generated-paragraph::after { color:transparent; }
      </style><main><button id="reveal-generated">Reveal generated text</button><button id="generated-button">Button body</button><p id="generated-paragraph">Standalone body</p></main>`;
      document.getElementById("reveal-generated")!.addEventListener("click", () => document.body.classList.add("show-generated"));
    });
    // Changing only the generated text colors proves the hidden before text
    // becomes visible and the after text is already painted.
    const initial = await target.locator("#generated-paragraph").screenshot();
    await target.evaluate(() => document.body.classList.add("show-generated"));
    const shown = await target.locator("#generated-paragraph").screenshot();
    await target.evaluate(() => { document.body.classList.remove("show-generated"); document.body.classList.add("hide-after"); });
    const afterHidden = await target.locator("#generated-paragraph").screenshot();
    await target.evaluate(() => document.body.classList.remove("hide-after"));
    expect(initial.equals(shown)).toBe(false);
    expect(initial.equals(afterHidden)).toBe(false);
    let baseline: any;
    responses.push(commandResponse("inspect_page", { full: true, budget: 12000 }, "generated-before"),
      (request) => { baseline = lastTool(request); return commandResponse("click", { target: { ref: button(baseline.items, "Reveal generated text")?.ref } }, "generated-reveal"); },
      () => commandResponse("inspect_page", { since: baseline.observationId, budget: 12000 }, "generated-delta"),
      textResponse("GENERATED_TEXT_OK"), textResponse("生成文字检查"));
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Inspect generated text and reveal the hidden text");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("GENERATED_TEXT_OK", { timeout: 45_000 });
    const events = await readEvents(opened.page);
    const output = (id: string) => events.find((event) => ["tool.finished", "tool.failed"].includes(event.type) && event.toolCallId === id)?.output;
    const before = output("generated-before"), changed = output("generated-reveal"), delta = output("generated-delta");
    expect(delta).toMatchObject({ mode: "delta", baseObservationId: before.observationId });
    expect(before?.mode).toBe("full");
    expect(button(before.items, "Button body Visible button after")?.ref).toBeTruthy();
    for (const visible of ["Standalone body", "Visible standalone after"]) expect(JSON.stringify(before.items)).toContain(visible);
    for (const hidden of ["Hidden button before", "Hidden standalone before"]) expect(JSON.stringify(before.items)).not.toContain(hidden);
    expect(changed).toMatchObject({ ok: true });
    for (const revealed of ["Hidden button before", "Hidden standalone before"]) {
      expect(JSON.stringify(deliveredSemanticState(events, changed.pageSnapshot))).toContain(revealed);
      expect(delta.items.some((entry: any) => entry.change !== "removed" && itemLine(entry).includes(revealed))).toBe(true);
    }
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
