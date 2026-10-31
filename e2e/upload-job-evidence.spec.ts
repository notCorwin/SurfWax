import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, readEvents, type MockResponse } from "./fixtures";
import { browserJobsSettled } from "./evaluation/job-evidence";
import { evaluateResultEvidence } from "./evaluation/result-evidence";
import { toolLifecycleEvidence } from "./evaluation/tool-lifecycle";
import { fromLogValue } from "../src/logging";

// Exercise the target-input upload path, which creates a job even when it
// returns synchronously. The local provider issues fixed calls, not an LLM.
test("target upload cannot pass evaluation if its job states are missing", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses), opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/automation`);
    await target.evaluate(() => {
      const input = document.createElement("input");
      input.type = "file"; input.id = "upload-target";
      input.onchange = async () => {
        document.body.dataset.received = input.files?.[0]?.name;
        document.body.dataset.content = await input.files?.[0]?.text() ?? "";
      };
      document.body.append(input);
    });
    responses.push(
      commandResponse("create_text_artifact", { filename: "report.txt", text: "abc" }, "create-upload"),
      (request) => {
        const message = request.messages.findLast((item: any) => item.role === "tool");
        const result = JSON.parse(message.content);
        return commandResponse("upload_file", { target: { by: "css", value: "#upload-target" }, artifactId: result.result.id }, "target-upload");
      },
      textResponse("UPLOAD_EVIDENCE_DONE"), textResponse("Upload"),
    );
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Upload the report");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("UPLOAD_EVIDENCE_DONE");
    await expect(target.locator("body")).toHaveAttribute("data-received", "report.txt");
    await expect(target.locator("body")).toHaveAttribute("data-content", "abc");

    const events = await readEvents(opened.page);
    const terminal = events.find((event) => event.type === "tool.finished" && event.toolCallId === "target-upload");
    expect(terminal).toBeDefined();
    expect(fromLogValue(terminal.input, terminal.valueEncoding)).toMatchObject({ target: { by: "css", value: "#upload-target" } });
    expect(fromLogValue(terminal.output, terminal.valueEncoding)).toMatchObject({ ok: true, state: "succeeded", jobId: expect.any(String) });
    const jobStates = events.filter((event) => event.type === "browser.job.state" && event.toolCallId === "target-upload");
    expect(jobStates.length).toBeGreaterThan(0);
    expect(browserJobsSettled(events)).toBe(true);

    // Simulate only the missing job-state records; business and tool lifecycle
    // remain successful and cannot establish that the job settled.
    const incomplete = events.filter((event) => !(event.type === "browser.job.state" && event.toolCallId === "target-upload"));
    const lifecycle = toolLifecycleEvidence(incomplete).complete;
    expect(lifecycle).toBe(true);
    const jobsSettled = browserJobsSettled(incomplete);
    expect(jobsSettled).toBeNull();
    expect(evaluateResultEvidence({ outcome: "conversation.finished", networkSettled: true, ledgerDrained: true, logComplete: true,
      jobsSettled, business: true, interaction: { applicable: false }, lifecycle })).toMatchObject({ classification: "unknown", passed: false, reasons: ["jobs_unknown"] });
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});
