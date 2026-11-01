import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, closeServer, readEvents, type MockResponse } from "./fixtures";
import { multitabFixture, multitabScore } from "./evaluation/multitab-fixture";
import { toolLifecycleEvidence } from "./evaluation/tool-lifecycle";

// Scripted tool calls exercise the extension path; this is not a model benchmark.
test("extension tools transfer between similarly structured popup windows", async () => {
  test.setTimeout(90_000);
  const fixture = await multitabFixture(17), responses: MockResponse[] = [];
  const provider = await startProvider(responses), opened = await openExtension();
  let problem: unknown, finalResult: any, sourceId = 0, destinationId = 0, portalId = 0, code = "", stepNumber = 0;
  const launcher = { by: "css", value: 'iframe[title="Window launcher"]' };
  const frameButton = (name: string) => ({ by: "role", value: "button", name, frame: launcher });
  const next = (name: string, input: object) => commandResponse(name, input, `window-step-${++stepNumber}`);
  const afterTool = (advance: (result: any) => ReturnType<typeof commandResponse> | ReturnType<typeof textResponse>): MockResponse => {
    const receive: MockResponse = (request) => {
      const message = request.messages.findLast((item: any) => item.role === "tool");
      if (!message) { responses.unshift(receive); return textResponse("Transfer"); }
      try {
        const result = JSON.parse(message.content);
        if (result.accepted && result.complete === false || result.terminal === false) {
          const jobId = result.jobId ?? result.id;
          responses.unshift(receive);
          return next("get_job", { jobId, after: result.nextCursor, waitMs: 10_000 });
        }
        if (result.ok === false) throw new Error(`Tool failed: ${JSON.stringify(result)}`);
        const command = advance(result);
        return command;
      } catch (error) { problem = error; return textResponse("WINDOW_TRANSFER_DONE"); }
    };
    return receive;
  };
  try {
    const target = await opened.context.newPage(); await target.goto(fixture.origin);
    responses.push(next("list_tabs", {}), afterTool((result) => {
      const tabs = result.result;
      portalId = tabs.find((tab: any) => tab.url === `${fixture.origin}/`)?.id;
      if (!portalId) throw new Error("Portal tab not found");
      return next("click", { tabId: portalId, target: frameButton("Open source window"), timeoutMs: 20_000 });
    }), afterTool(() => next("click", { tabId: portalId, target: frameButton("Open destination window"), timeoutMs: 20_000 })),
    afterTool(() => next("list_tabs", {})), afterTool((result) => {
      const tabs = result.result;
      sourceId = tabs.find((tab: any) => tab.url?.includes("/window/source"))?.id;
      destinationId = tabs.find((tab: any) => tab.url?.includes("/window/destination"))?.id;
      if (!sourceId || !destinationId || sourceId === destinationId) throw new Error(`Popup tabs not found: ${JSON.stringify(tabs)}`);
      return next("read_text", { tabId: sourceId, target: { by: "css", value: "strong" } });
    }), afterTool((result) => {
      code = result.result;
      if (typeof code !== "string" || !code) throw new Error(`Missing source code: ${JSON.stringify(result)}`);
      return next("fill", { tabId: destinationId, target: { by: "label", value: "Transfer code" }, value: code });
    }), afterTool(() => next("click", { tabId: destinationId, target: { by: "role", value: "button", name: "Submit transfer" }, timeoutMs: 20_000 })),
    afterTool(() => next("verify_state", { tabId: destinationId, target: { by: "css", value: "#status" }, textIncludes: "Transfer submitted", timeoutMs: 10_000 })),
    afterTool((result) => { finalResult = result; return textResponse("WINDOW_TRANSFER_DONE"); }), textResponse("Transfer"));
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill(fixture.prompt);
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("WINDOW_TRANSFER_DONE", { timeout: 75_000 });
    if (problem) throw problem;
    expect(finalResult, JSON.stringify(fixture.evidence())).toMatchObject({ ok: true, result: { verified: true } });
    await expect.poll(() => multitabScore(fixture.evidence())).toBe(true);
    expect(toolLifecycleEvidence(await readEvents(opened.page)).complete).toBe(true);
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); await closeServer(fixture.server); }
});
