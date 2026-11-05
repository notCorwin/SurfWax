import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";
import { test, commandResponse, configure, dispose, openExtension, readEvents, startProvider, textResponse, type MockResponse } from "./fixtures";

// This tests enforcement of a supplied review verdict, not model judgment.
// The separate browser read is real; the reviewer is explicitly deterministic.
test("completion review rejection keeps the task open until the observed result is delivered", { tag: "@user-journey" }, async () => {
  const code = `RECEIPT-${randomUUID()}`;
  let observed = "", evidenceId = "", rejected = false, problem: unknown;
  const toolResult = (request: any) => {
    const content = request.messages.findLast((message: any) => message.role === "tool").content;
    return JSON.parse(Array.isArray(content) ? content.find((part: any) => part.type === "text").text : content);
  };
  const responses: MockResponse[] = [
    commandResponse("read_text", { target: { by: "css", value: "main" } }, "read-receipt"),
    request => {
      const result = toolResult(request);
      observed = result.result; evidenceId = result.evidenceId;
      return commandResponse("complete_goal", { taskType: "browser", status: "completed", evidence: [{ evidenceId, observation: "The page was read." }] }, "premature-completion", "I have read the page.");
    },
    request => {
      try {
        expect(toolResult(request)).toMatchObject({ ok: false, error: { code: "goal-incomplete" } });
        rejected = true;
      } catch (error) { problem = error; }
      return commandResponse("complete_goal", { taskType: "browser", status: "completed", evidence: [{ evidenceId, observation: observed }] }, "delivered-completion", `Page receipt: ${observed}`);
    },
    textResponse("Receipt task"),
  ];
  const provider = await startProvider(responses, 0, undefined, undefined, 0, 0, [
    JSON.stringify({ accept: false, reason: "The requested receipt has not been delivered to the user.", remaining: ["State the exact observed receipt in the answer."] }),
    JSON.stringify({ accept: true, reason: "The observed receipt is now in the answer.", remaining: [] }),
  ]);
  const opened = await openExtension();
  try {
    await (await configure(opened.context, opened.page, provider.baseURL, undefined, { goalMode: true })).close();
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    await target.locator("main").evaluate((element, value) => { element.textContent = value; }, code);
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Read the page receipt and report its exact value to me before completing.");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".assistant-message").filter({ hasText: `Page receipt: ${code}` })).toBeVisible({ timeout: 20_000 });
    if (problem) throw problem;
    expect(rejected).toBe(true);
    expect(observed).toBe(code);
    await expect(opened.page.getByRole("switch", { name: "目标模式" })).toBeEnabled();
    const events = await readEvents(opened.page);
    const premature = events.filter(event => event.toolCallId?.endsWith("premature-completion") && ["tool.finished", "tool.failed"].includes(event.type));
    expect(premature).toHaveLength(1);
    expect(premature[0]).toMatchObject({ type: "tool.failed", output: { ok: false, error: { code: "goal-incomplete" } } });
    const delivered = events.filter(event => event.toolCallId?.endsWith("delivered-completion") && ["tool.finished", "tool.failed"].includes(event.type));
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ type: "tool.finished", output: { ok: true } });
    expect(events.filter(event => event.type === "conversation.finished")).toHaveLength(1);
    expect(events.find(event => event.type === "conversation.finished")!.id).toBeGreaterThan(delivered[0].id);
    await test.info().attach("completion-verdict-events", { body: JSON.stringify(events), contentType: "application/json" });
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
