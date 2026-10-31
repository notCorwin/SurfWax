import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, type MockResponse } from "./fixtures";

const lastTool = (request: any) => {
  const content = request.messages.findLast((entry: any) => entry.role === "tool").content;
  return JSON.parse(Array.isArray(content) ? content.find((part: any) => part.type === "text").text : content);
};

test("honors inherited and overridden disabled state across shadow roots and slots", async () => {
  test.setTimeout(90_000);
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    await target.evaluate(() => {
      document.body.innerHTML = `<div id="outer" aria-disabled="true"></div>
        <div id="slotted"><button slot="action" id="slotted-disabled">Slotted disabled</button></div>
        <div id="slot-override" aria-disabled="true"><button slot="action" id="slotted-enabled">Slotted enabled</button></div>
        <fieldset disabled><legend><input id="legend"></legend><input id="fieldset" aria-disabled="false"></fieldset>`;
      const outer = document.querySelector("#outer")!.attachShadow({ mode: "open" });
      outer.innerHTML = '<div id="nested-host"></div><button id="override" aria-disabled="FALSE">Enabled override</button><button id="invalid" aria-disabled="bad">Invalid override</button>';
      outer.querySelector("#nested-host")!.attachShadow({ mode: "open" }).innerHTML = '<button id="nested-disabled">Nested disabled</button>';
      document.querySelector("#slotted")!.attachShadow({ mode: "open" }).innerHTML = '<div aria-disabled="true"><slot name="action"></slot></div>';
      document.querySelector("#slot-override")!.attachShadow({ mode: "open" }).innerHTML = '<div aria-disabled="false"><slot name="action"></slot></div>';
      document.addEventListener("click", () => { document.body.dataset.clicks = String(Number(document.body.dataset.clicks || 0) + 1); });
    });
    const css = (value: string) => ({ by: "css", value });
    const cases: Array<[string, "enabled" | "disabled", boolean]> = [
      ["#nested-disabled", "disabled", false], ["#override", "enabled", true], ["#invalid", "disabled", false],
      ["#slotted-disabled", "disabled", false], ["#slotted-enabled", "enabled", true],
      ["#legend", "enabled", true], ["#fieldset", "disabled", false],
    ];
    responses.push(commandResponse("verify_state", { target: css(cases[0]![0]), state: cases[0]![1] }, "verify-0"));
    for (let index = 0; index < cases.length; index++) {
      responses.push((request) => {
        expect(lastTool(request)).toMatchObject({ ok: true, result: { verified: true, present: true, actual: cases[index]![2] } });
        const next = cases[index + 1];
        return next ? commandResponse("verify_state", { target: css(next[0]), state: next[1] }, `verify-${index + 1}`)
          : commandResponse("click", { target: css("#nested-disabled"), timeoutMs: 1200 }, "click-disabled");
      });
    }
    responses.push(
      (request) => { expect(lastTool(request)).toMatchObject({ ok: false }); return commandResponse("click", { target: css("#override") }, "click-enabled"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true }); return textResponse("ARIA_DISABLED_SHADOW_OK"); },
      textResponse("禁用状态"),
    );
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Check disabled states and click the enabled control");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("ARIA_DISABLED_SHADOW_OK", { timeout: 60_000 });
    await expect(target.locator("body")).toHaveAttribute("data-clicks", "1");
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
