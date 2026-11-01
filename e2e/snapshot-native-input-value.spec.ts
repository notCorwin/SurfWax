import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, type MockResponse } from "./fixtures";

function lastTool(request: any): any {
  const content = request.messages.findLast((entry: any) => entry.role === "tool").content;
  return JSON.parse(Array.isArray(content) ? content.find((part: any) => part.type === "text").text : content);
}

const value = "NATIVE_INPUT_VALUE_7F46B";
const occurrences = (snapshot: any, text: string) => JSON.stringify(snapshot.items ?? []).split(text).length - 1;

test("keeps each native input value once without collapsing independent frame and page text", async () => {
  test.setTimeout(90_000);
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses), opened = await openExtension();
  let initial: any, region: any, filled: any, blurred: any, updated: any;
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    await target.evaluate((text) => {
      document.body.innerHTML = `<input id="native" aria-label="Native field" value="${text}" style="display:block;width:320px;font:16px monospace">
        <span id="independent" style="display:block;width:320px;height:25px;overflow:hidden;white-space:nowrap;font:16px monospace">${text}</span>
        <iframe title="Child field" style="width:400px;height:100px" srcdoc="&lt;input aria-label='Child field' value='${text}' style='width:320px;font:16px monospace'&gt;"></iframe>`;
    }, value);
    await expect(target.frameLocator('iframe[title="Child field"]').locator("input")).toBeVisible();
    // Changing only the final character must change rendered pixels in both
    // inputs; the expected complete values are not hidden behind a clip.
    for (const input of [target.locator("#native"), target.frameLocator('iframe[title="Child field"]').locator("input")]) {
      const before = await input.screenshot();
      await input.evaluate((element: HTMLInputElement) => { element.value = element.value.slice(0, -1) + "C"; });
      expect((await input.screenshot()).equals(before)).toBe(false);
      await input.evaluate((element: HTMLInputElement, text) => { element.value = text; }, value);
    }
    responses.push(commandResponse("inspect_page", { budget: 12000 }, "native-initial"), (request) => {
      initial = lastTool(request);
      const ref = initial.items?.find((item: any) => item.line.includes("textbox") && item.line.includes(value))?.ref;
      if (!ref) return textResponse("NATIVE_INPUT_DONE");
      responses.unshift(
        (next) => { region = lastTool(next); return commandResponse("fill", { target: { ref }, value: "CHANGED_NATIVE_VALUE" }, "native-fill"); },
        (next) => { filled = lastTool(next); return commandResponse("blur_element", { target: { ref } }, "native-blur"); },
        (next) => { blurred = lastTool(next); return commandResponse("inspect_page", { budget: 12000 }, "native-updated"); },
        (next) => { updated = lastTool(next); return textResponse("NATIVE_INPUT_DONE"); },
      );
      return commandResponse("inspect_page", { budget: 12000, region: { by: "css", value: "#native" } }, "native-region");
    }, textResponse("Inspect the values"));
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Inspect the fields and update the first");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("NATIVE_INPUT_DONE", { timeout: 60_000 });
    expect(initial).toMatchObject({ mode: "full", truncation: { baselineComplete: true } });
    expect(JSON.stringify(initial.items)).not.toContain("Native field");
    expect(occurrences(initial, value)).toBe(3);
    expect(region).toMatchObject({ mode: "full" });
    expect(occurrences(region, value)).toBe(1);
    expect(filled).toMatchObject({ ok: true });
    expect(blurred).toMatchObject({ ok: true });
    expect(await target.locator("#native").inputValue()).toBe("CHANGED_NATIVE_VALUE");
    expect(occurrences(updated, "CHANGED_NATIVE_VALUE")).toBe(1);
    expect(occurrences(updated, value)).toBe(2);
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
