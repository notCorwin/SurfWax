import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, closeServer, readEvents, type MockResponse } from "./fixtures";
import { networkContextFixture, networkContextScore } from "./evaluation/network-context-fixture";
import { browserJobsSettled } from "./evaluation/job-evidence";
import { toolLifecycleEvidence } from "./evaluation/tool-lifecycle";

const lastTool = (request: any) => {
  const content = request.messages.findLast((entry: any) => entry.role === "tool").content;
  return JSON.parse(Array.isArray(content) ? content.find((part: any) => part.type === "text").text : content);
};

// Scripted choices validate both request contexts without an external model.
for (const seed of [17, 72]) test(`combines a page session with a cross-origin extension fetch (seed ${seed})`, async () => {
  test.setTimeout(120_000);
  const fixture = await networkContextFixture(seed), responses: MockResponse[] = [];
  const provider = await startProvider(responses), opened = await openExtension();
  let publicUrl = "", privateCode = "", publicCode = "";
  try {
    const target = await opened.context.newPage(); await target.goto(fixture.origin);
    responses.push(
      commandResponse("read_text", { target: { by: "css", value: "#public-url" } }, "public-url"),
      (request) => { const result = lastTool(request); expect(result.ok).toBe(true); publicUrl = result.result; return commandResponse("read_text", { target: { by: "css", value: "#private-url" } }, "private-url"); },
      (request) => { const result = lastTool(request); expect(result.ok).toBe(true); return commandResponse("send_request", { context: "page", url: result.result }, "private-fetch"); },
      (request) => { const result = lastTool(request); expect(result).toMatchObject({ ok: true, result: { status: 200 } }); privateCode = JSON.parse(result.result.body).code; return commandResponse("send_request", { context: "extension", url: publicUrl }, "public-fetch"); },
      (request) => { const result = lastTool(request); expect(result).toMatchObject({ ok: true, result: { status: 200 } }); publicCode = JSON.parse(result.result.body).code; return commandResponse("fill", { target: { by: "label", value: "Private code" }, value: privateCode }, "private-fill"); },
      (request) => { expect(lastTool(request).ok).toBe(true); return commandResponse("fill", { target: { by: "label", value: "Public code" }, value: publicCode }, "public-fill"); },
      (request) => { expect(lastTool(request).ok).toBe(true); return commandResponse("click", { target: { by: "role", value: "button", name: "Submit codes" } }, "submit"); },
      (request) => { expect(lastTool(request).ok).toBe(true); return commandResponse("verify_state", { target: { by: "css", value: "#status" }, textIncludes: "Submitted", timeoutMs: 10_000 }, "verify-submit"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true, result: { verified: true } }); return textResponse("NETWORK_CONTEXT_DONE"); },
      textResponse("Network desk"),
    );
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill(fixture.prompt);
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("NETWORK_CONTEXT_DONE", { timeout: 100_000 });
    expect(networkContextScore(fixture.evidence()), JSON.stringify(fixture.evidence())).toBe(true);
    const events = await readEvents(opened.page);
    expect(browserJobsSettled(events)).toBe(true);
    expect(toolLifecycleEvidence(events).complete).toBe(true);
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
    await closeServer(fixture.privateServer); await closeServer(fixture.publicServer);
  }
});
