import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, type MockResponse } from "./fixtures";

function lastTool(request: any): any {
  const content = request.messages.findLast((entry: any) => entry.role === "tool").content;
  return JSON.parse(Array.isArray(content) ? content.find((part: any) => part.type === "text").text : content);
}

test("retains exact visible DOM text and operates a native input omitted by AX", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  let snapshot: any, filled: any, problem: unknown;
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    await target.evaluate(() => {
      document.body.innerHTML = `<main>
        <h1>DOM fusion probe</h1>
        <section aria-hidden="true">
          <button><span>NoSpaceA</span><span>NoSpaceB</span></button>
          <button><span>SpacedA</span> <span>SpacedB</span></button>
          <label for="dom-input">Visible input label</label>
          <input id="dom-input" value="INITIAL_INPUT_VALUE">
          <p id="before">VISIBLE_BEFORE_CHANGE</p>
          <p id="after" style="display:none">VISIBLE_AFTER_CHANGE</p>
          <p style="display:none">HIDDEN_DISPLAY_CONTENT</p>
          <p style="opacity:0">HIDDEN_TRANSPARENT_CONTENT</p>
          <div style="height:0;width:0;overflow:hidden"><p>HIDDEN_CLIPPED_CONTENT</p></div>
        </section>
      </main>`;
      document.querySelector("#dom-input")!.addEventListener("input", () => {
        (document.querySelector("#before") as HTMLElement).style.display = "none";
        (document.querySelector("#after") as HTMLElement).style.display = "block";
      });
    });
    const done = () => textResponse("DOM_FUSION_PROBE_DONE");
    responses.push(commandResponse("inspect_page", { budget: 6000 }, "dom-fusion-inspect"), (request) => {
      try {
        snapshot = lastTool(request);
        const input = snapshot.items?.find((item: any) => /- textbox(?:\s|:)/.test(item.line) && item.line.includes("INITIAL_INPUT_VALUE"));
        if (typeof input?.ref !== "string") return done();
        responses.unshift((next) => { try { filled = lastTool(next); } catch (error) { problem = error; } return done(); });
        return commandResponse("fill", { target: { ref: input.ref }, value: "UPDATED_INPUT_VALUE" }, "dom-fusion-fill");
      } catch (error) { problem = error; return done(); }
    }, textResponse("Inspect visible content"));
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Inspect the page and fill the visible input");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("DOM_FUSION_PROBE_DONE", { timeout: 45_000 });
    if (problem) throw problem;
    expect(snapshot).toMatchObject({ mode: "full", truncation: { baselineComplete: true }, items: expect.any(Array) });
    const lines = snapshot.items.map((item: any) => item.line as string);
    expect.soft(lines.some((line: string) => line.includes('- button "NoSpaceANoSpaceB"'))).toBe(true);
    expect.soft(lines.some((line: string) => line.includes('- button "SpacedA SpacedB"'))).toBe(true);
    expect.soft(lines.some((line: string) => line.includes("Visible input label"))).toBe(true);
    const input = snapshot.items.find((item: any) => /- textbox(?:\s|:)/.test(item.line) && item.line.includes("INITIAL_INPUT_VALUE"));
    expect.soft(input?.ref).toEqual(expect.any(String));
    const initial = JSON.stringify(snapshot.items);
    expect.soft(initial).toContain("VISIBLE_BEFORE_CHANGE");
    for (const hidden of ["VISIBLE_AFTER_CHANGE", "HIDDEN_DISPLAY_CONTENT", "HIDDEN_TRANSPARENT_CONTENT", "HIDDEN_CLIPPED_CONTENT"])
      expect.soft(initial).not.toContain(hidden);
    expect.soft(filled).toMatchObject({ ok: true, pageSnapshot: { items: expect.any(Array) } });
    if (filled?.ok) {
      expect(await target.locator("#dom-input").inputValue()).toBe("UPDATED_INPUT_VALUE");
      const changed = JSON.stringify(filled.pageSnapshot.items);
      expect(changed).toContain("UPDATED_INPUT_VALUE");
      expect(changed).toContain("VISIBLE_AFTER_CHANGE");
      for (const hidden of ["VISIBLE_BEFORE_CHANGE", "HIDDEN_DISPLAY_CONTENT", "HIDDEN_TRANSPARENT_CONTENT", "HIDDEN_CLIPPED_CONTENT"])
        expect(changed).not.toContain(hidden);
    }
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
