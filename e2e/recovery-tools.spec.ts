import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, closeServer, readEvents, type MockResponse } from "./fixtures";
import { recoveryFixture, recoveryScore } from "./evaluation/recovery-fixture";
import { toolLifecycleEvidence } from "./evaluation/tool-lifecycle";

// This exercises the actual extension tools with scripted choices, not a model.
test("extension tools verify a committed write after its response is lost", async () => {
  test.setTimeout(90_000);
  const fixture = await recoveryFixture(17);
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(fixture.origin);
    const frame = { by: "css", value: 'iframe[title="Transaction desk"]' };
    const reference = fixture.evidence().expectedReference;
    const status = { by: "css", value: "#status", frame };
    const last = (request: any) => JSON.parse(request.messages.findLast((message: any) => message.role === "tool").content);
    responses.push(
      commandResponse("fill", { target: { by: "label", value: "Transaction reference", frame }, value: reference }, "recovery-fill"),
      commandResponse("click", { target: { by: "role", value: "button", name: "Submit transaction", frame } }, "recovery-submit"),
      commandResponse("verify_state", { target: status, textIncludes: "Confirmation unavailable", timeoutMs: 10_000 }, "recovery-unknown"),
      (request) => { expect(last(request)).toMatchObject({ ok: true, result: { verified: true } }); return commandResponse("click", { target: { by: "role", value: "button", name: "Check status", frame } }, "recovery-check"); },
      commandResponse("verify_state", { target: status, textIncludes: `Completed ${reference}`, timeoutMs: 10_000 }, "recovery-verify"),
      (request) => { expect(last(request)).toMatchObject({ ok: true, result: { verified: true } }); return textResponse("RECOVERY_TOOL_PATH_DONE"); },
      textResponse("Transaction"),
    );
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill(fixture.prompt);
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("RECOVERY_TOOL_PATH_DONE", { timeout: 60_000 });
    expect(recoveryScore(fixture.evidence())).toBe(true);
    expect(toolLifecycleEvidence(await readEvents(opened.page)).complete).toBe(true);
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
    await closeServer(fixture.server);
  }
});
