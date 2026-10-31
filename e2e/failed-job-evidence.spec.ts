import { expect } from "@playwright/test";
import { test, queuedToolResponse, textResponse, startProvider, openExtension, configure, dispose, readEvents, type MockResponse } from "./fixtures";
import { fromLogValue } from "../src/logging";
import { browserJobsSettled } from "./evaluation/job-evidence";
import { evaluateResultEvidence } from "./evaluation/result-evidence";
import { toolLifecycleEvidence } from "./evaluation/tool-lifecycle";

// The first real job fails without a browser effect; the scheduler rejects the
// second call before creating any job. The provider does not use a real LLM.
test("failed program jobs need terminal evidence while undispatched failures do not", async () => {
  test.setTimeout(90_000);
  const responses: MockResponse[] = [
    queuedToolResponse("throw new Error('known failure');", "return 7;"),
    textResponse("FAILED_JOB_EVIDENCE_DONE"), textResponse("Failure evidence"),
  ];
  const provider = await startProvider(responses), opened = await openExtension();
  try {
    const target = await opened.context.newPage(); await target.goto(`${provider.origin}/automation`);
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Run the two programs");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("FAILED_JOB_EVIDENCE_DONE", { timeout: 70_000 });
    const events = await readEvents(opened.page);
    const failed = events.find((event) => event.type === "tool.failed" && event.toolCallId === "call-queued-0");
    const rejected = events.find((event) => event.type === "tool.failed" && event.toolCallId === "call-queued-1");
    expect(failed).toBeDefined(); expect(rejected).toBeDefined();
    expect(fromLogValue(failed.output, failed.valueEncoding)).toMatchObject({ jobId: expect.any(String), ok: false, state: "failed", error: { code: "execution-failed", message: "known failure" } });
    expect(fromLogValue(rejected.output, rejected.valueEncoding)).toMatchObject({ ok: false, error: { code: "prior-action-failed" } });
    expect(events.filter((event) => event.type === "browser.job.state" && event.toolCallId === "call-queued-1")).toHaveLength(0);
    expect(browserJobsSettled([rejected])).toBe(true);
    const states = events.filter((event) => event.type === "browser.job.state" && event.toolCallId === "call-queued-0");
    expect(states.length).toBeGreaterThan(0);
    expect(browserJobsSettled(events)).toBe(true);

    const incomplete = events.filter((event) => !(event.type === "browser.job.state" && event.toolCallId === "call-queued-0"));
    const lifecycle = toolLifecycleEvidence(incomplete).complete;
    expect(lifecycle).toBe(true);
    expect(browserJobsSettled(incomplete)).toBeNull();
    expect(evaluateResultEvidence({ outcome: "conversation.finished", networkSettled: true, ledgerDrained: true, logComplete: true,
      business: true, interaction: { applicable: false }, lifecycle, jobsSettled: browserJobsSettled(incomplete) }))
      .toMatchObject({ classification: "unknown", passed: false, reasons: ["jobs_unknown"] });
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
