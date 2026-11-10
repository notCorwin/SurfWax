import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, type MockResponse } from "./fixtures";
import { itemLine } from "./snapshot-format";

function lastTool(request: any): any {
  const content = request.messages.findLast((entry: any) => entry.role === "tool").content;
  return JSON.parse(Array.isArray(content) ? content.find((part: any) => part.type === "text").text : content);
}

type Item = { role?: string; name?: string; depth?: number; actions?: readonly string[]; ref?: string };
const hasClickAction = (line: string) => /\[actions=[^\]]*\bclick\b/.test(line);

/** Find an exposed focus-only node either directly by name or through its text child. */
function focusOnlyControl(items: Item[]): Item | undefined {
  const textIndex = items.findIndex((item) => itemLine(item).includes("Focus only text"));
  if (textIndex < 0) return undefined;
  const text = items[textIndex]!;
  if (/- generic(?:\s|$)/.test(itemLine(text))) return text;
  const depth = itemLine(text).length - itemLine(text).trimStart().length;
  for (let index = textIndex - 1; index >= 0; index--) {
    const item = items[index]!, parentDepth = itemLine(item).length - itemLine(item).trimStart().length;
    if (parentDepth >= depth) continue;
    return /- generic(?:\s|$)/.test(itemLine(item)) ? item : undefined;
  }
  return undefined;
}

test("supplements visible custom controls omitted from AX without inventing clickability", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses), opened = await openExtension();
  let snapshot: any, roleClick: any, genericClick: any;
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    await target.evaluate(() => {
      document.body.innerHTML = `<style>
        .control { display:block; width:240px; height:40px; border:1px solid; }
      </style><main><h1>Custom controls</h1><section aria-hidden="true">
        <div id="role-button" class="control" role="button" tabindex="0">Custom role button</div>
        <div id="generic-click" class="control">Generic clickable</div>
        <div id="focus-only" class="control" tabindex="0">Focus only text</div>
        <div class="control" role="button" tabindex="0" style="display:none">Hidden custom button</div>
        <div class="control" style="opacity:0">Hidden generic clickable</div>
      </section></main>`;
      document.getElementById("role-button")!.addEventListener("click", () => { document.body.dataset.roleClicked = "yes"; });
      document.getElementById("generic-click")!.addEventListener("click", () => { document.body.dataset.genericClicked = "yes"; });
      document.querySelector<HTMLElement>('[style="opacity:0"]')!.addEventListener("click", () => { document.body.dataset.hiddenClicked = "wrong"; });
    });
    await expect(target.locator("#role-button")).toBeVisible();
    await expect(target.locator("#generic-click")).toBeVisible();
    responses.push(
      commandResponse("inspect_page", { fields: ["text", "state", "ref", "actions"], budget: 12000 }, "custom-controls-inspect"),
      (request) => {
        snapshot = lastTool(request);
        const items: Item[] = Array.isArray(snapshot.items) ? snapshot.items : [];
        const role = items.find((item) => itemLine(item).includes('- button "Custom role button"'));
        const generic = items.find((item) => itemLine(item).includes('- generic "Generic clickable"'));
        if (!role?.ref || !generic?.ref) return textResponse("CUSTOM_CONTROLS_DONE");
        responses.unshift(
          (next) => { roleClick = lastTool(next); return commandResponse("click", { target: { ref: generic.ref } }, "custom-generic-click"); },
          (next) => { genericClick = lastTool(next); return textResponse("CUSTOM_CONTROLS_DONE"); },
        );
        return commandResponse("click", { target: { ref: role.ref } }, "custom-role-click");
      },
      textResponse("Inspect custom controls"),
    );
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Inspect and activate both visible controls");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("CUSTOM_CONTROLS_DONE", { timeout: 45_000 });

    expect(snapshot).toMatchObject({ mode: "full", truncation: { baselineComplete: true } });
    const items: Item[] = snapshot.items;
    const role = items.find((item) => itemLine(item).includes('- button "Custom role button"'));
    const generic = items.find((item) => itemLine(item).includes('- generic "Generic clickable"'));
    expect(role?.ref).toEqual(expect.any(String));
    expect(generic?.ref).toEqual(expect.any(String));
    expect(hasClickAction(itemLine(role!))).toBe(true);
    expect(hasClickAction(itemLine(generic!))).toBe(true);
    const focus = focusOnlyControl(items);
    if (focus) expect(hasClickAction(itemLine(focus))).toBe(false);
    expect(JSON.stringify(items)).not.toContain("Hidden custom button");
    expect(JSON.stringify(items)).not.toContain("Hidden generic clickable");
    expect(roleClick).toMatchObject({ ok: true });
    expect(genericClick).toMatchObject({ ok: true });
    expect(await target.locator("body").getAttribute("data-role-clicked")).toBe("yes");
    expect(await target.locator("body").getAttribute("data-generic-clicked")).toBe("yes");
    expect(await target.locator("body").getAttribute("data-hidden-clicked")).toBeNull();
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});
