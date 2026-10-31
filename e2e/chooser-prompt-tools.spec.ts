import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, closeServer, readEvents, type MockResponse } from "./fixtures";
import { chooserPromptFixture, chooserPromptScore } from "./evaluation/chooser-prompt-fixture";
import { toolLifecycleEvidence } from "./evaluation/tool-lifecycle";

// This scripted provider exercises the extension event and job handoff, not model capability.
for (const seed of [17, 72]) test(`extension handles an intake chooser that opens a prompt across jobs (seed ${seed})`, async () => {
  test.setTimeout(90_000);
  const fixture = await chooserPromptFixture(seed);
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(fixture.origin);
    // Leave dialog ownership with the extension instead of Playwright auto-dismissing it.
    target.on("dialog", () => {});
    const expected = fixture.evidence().expected;
    let artifactId = 0, subscriptionId = "", clickJobId = "", uploadJobId = "", polls = 0;
    let error: unknown;
    const done = () => textResponse("CHOOSER_PROMPT_TOOL_DONE");
    const afterTool = (handler: (result: any) => ReturnType<typeof commandResponse>): MockResponse => {
      const step: MockResponse = (request) => {
        const message = request.messages.findLast((entry: any) => entry.role === "tool");
        if (!message) { responses.unshift(step); return textResponse("Receipt"); }
        try { return handler(JSON.parse(message.content)); } catch (cause) { error = cause; return done(); }
      };
      return step;
    };
    const pollClick: MockResponse = afterTool((result) => {
      if (result.terminal) { expect(result).toMatchObject({ ok: true, state: "succeeded" }); return done(); }
      responses.unshift(pollClick);
      return commandResponse("get_job", { jobId: clickJobId, after: result.nextCursor, waitMs: 10_000 }, `receipt-click-poll-${++polls}`);
    });
    const pollUpload: MockResponse = afterTool((result) => {
      if (result.terminal) {
        expect(result).toMatchObject({ ok: true, state: "succeeded" });
        responses.unshift(pollClick);
        return commandResponse("get_job", { jobId: clickJobId }, "receipt-click-job");
      }
      responses.unshift(pollUpload);
      return commandResponse("get_job", { jobId: uploadJobId, after: result.nextCursor, waitMs: 10_000 }, `receipt-upload-poll-${++polls}`);
    });
    responses.push(
      commandResponse("create_text_artifact", { filename: expected.name, text: expected.contents }, "receipt-artifact"),
      afterTool((result) => { artifactId = result.result.id; expect(artifactId).toEqual(expect.any(Number)); return commandResponse("subscribe_event", { kind: "filechooser" }, "receipt-subscribe"); }),
      afterTool((result) => { subscriptionId = result.subscriptionId; expect(subscriptionId).toEqual(expect.any(String)); return commandResponse("click", { target: { by: "role", value: "button", name: "Choose receipt", frame: { by: "css", value: 'iframe[title="Intake desk"]' } }, background: true, timeoutMs: 30_000 }, "receipt-open"); }),
      afterTool((result) => { expect(result).toMatchObject({ accepted: true, complete: false }); clickJobId = result.jobId; return commandResponse("wait_event", { subscriptionId, waitMs: 10_000 }, "receipt-wait"); }),
      afterTool((result) => {
        const event = Array.isArray(result.events) ? result.events.find((item: any) => item.kind === "filechooser") : undefined;
        if (!event) {
          responses.unshift(afterTool((job) => {
            error = new Error(`No file chooser event: ${JSON.stringify({ wait: result, job })}`);
            return done();
          }));
          return commandResponse("get_job", { jobId: clickJobId, waitMs: 1000 }, "receipt-diagnose");
        }
        expect(event.source.sessionId).toEqual(expect.any(String));
        expect(event.payload.chooserId).toEqual(expect.any(String));
        return commandResponse("upload_file", { chooserId: event.payload.chooserId, artifactId, timeoutMs: 30_000 }, "receipt-upload");
      }),
      afterTool((result) => {
        expect(result).toMatchObject({ accepted: true, complete: false, state: "blocked", blockedBy: { kind: "dialog", type: "prompt" } });
        uploadJobId = result.jobId;
        return commandResponse("handle_dialog", { dialogId: result.blockedBy.dialogId, accept: true, prompt: expected.answer }, "receipt-answer");
      }),
      afterTool((result) => { expect(result).toMatchObject({ state: "completed" }); responses.unshift(pollUpload); return commandResponse("get_job", { jobId: uploadJobId }, "receipt-upload-job"); }),
      textResponse("Receipt"),
    );
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill(fixture.prompt);
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("CHOOSER_PROMPT_TOOL_DONE", { timeout: 70_000 });
    if (error) throw error;
    await expect.poll(() => chooserPromptScore(fixture.evidence())).toBe(true);
    const events = await readEvents(opened.page);
    expect(toolLifecycleEvidence(events).complete).toBe(true);
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); await closeServer(fixture.server); }
});
