import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, closeServer, readEvents, type MockResponse } from "./fixtures";
import { networkFixture, networkScore } from "./evaluation/network-level-fixture";
import { completedProgramOperations, toolLifecycleEvidence } from "./evaluation/tool-lifecycle";

const lastTool = (request: any) => {
  const content = request.messages.findLast((entry: any) => entry.role === "tool").content;
  return JSON.parse(Array.isArray(content) ? content.find((part: any) => part.type === "text").text : content);
};
const frame = { by: "css", value: 'iframe[title="Response desk"]' };
const button = (name: string) => ({ by: "role", value: "button", name, frame });

// Scripted choices validate the network tool path, not a model's performance.
test("extension distinguishes concurrent same-URL responses using their request references", async () => {
  test.setTimeout(120_000);
  const fixture = await networkFixture(17), responses: MockResponse[] = [];
  const provider = await startProvider(responses), opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(fixture.origin);
    let refs: any[] = [], index = 0, failure: unknown;
    const values = new Map<string, string>();
    const afterFill: MockResponse = (request) => {
      expect(lastTool(request).ok).toBe(true);
      index++;
      if (index < refs.length) {
        responses.unshift(afterRead);
        return commandResponse("read_response", { requestRef: refs[index].requestRef }, `response-${index}`);
      }
      expect(values.size).toBe(6);
      responses.unshift(afterSubmit);
      return commandResponse("click", { target: button("Submit codes") }, "submit");
    };
    const afterRead: MockResponse = (request) => {
      const result = lastTool(request);
      if (!result.ok) { failure = result; return textResponse("NETWORK_IDENTITY_TOOL_FAILED"); }
      expect(result.ok).toBe(true);
      expect(typeof result.result).toBe("string");
      const response = JSON.parse(result.result);
      expect(typeof response.name).toBe("string");
      expect(typeof response.code).toBe("string");
      expect(values.has(response.name)).toBe(false);
      values.set(response.name, response.code);
      responses.unshift(afterFill);
      return commandResponse("fill", { target: { by: "label", value: `${response.name} code`, exact: true, frame }, value: response.code }, `fill-${index}`);
    };
    const afterSubmit: MockResponse = (request) => {
      expect(lastTool(request).ok).toBe(true);
      responses.unshift((request) => { expect(lastTool(request)).toMatchObject({ ok: true, result: { verified: true } }); return textResponse("NETWORK_IDENTITY_TOOL_DONE"); });
      return commandResponse("verify_state", { target: { by: "css", value: "#notice", frame }, textIncludes: "Codes submitted", timeoutMs: 10_000 }, "verify-submit");
    };
    responses.push(
      commandResponse("count_elements", { target: button("Run requests") }, "bind-frame"),
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true, result: 1 }); return commandResponse("list_requests", { limit: 100 }, "start-capture"); },
      (request) => { expect(lastTool(request).ok).toBe(true); return commandResponse("click", { target: button("Run requests") }, "run-requests"); },
      (request) => { expect(lastTool(request).ok).toBe(true); return commandResponse("verify_state", { target: { by: "css", value: "#state", frame }, textIncludes: "Responses ready", timeoutMs: 20_000 }, "wait-responses"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true, result: { verified: true } }); return commandResponse("list_requests", { limit: 100 }, "captured-requests"); },
      (request) => {
        const result = lastTool(request);
        expect(result).toMatchObject({ ok: true, result: { integrity: "complete", hasMore: false } });
        refs = result.result.requests.filter((item: any) => item.method === "POST" && item.url.endsWith("/sample"));
        expect(refs).toHaveLength(6);
        expect(new Set(refs.map((item) => item.requestRef)).size).toBe(6);
        responses.unshift(afterRead);
        return commandResponse("read_response", { requestRef: refs[0].requestRef }, "response-0");
      },
      textResponse("Response desk"),
    );
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill(fixture.prompt);
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText(/NETWORK_IDENTITY_TOOL_(DONE|FAILED)/, { timeout: 100_000 });
    expect(failure, JSON.stringify(failure)).toBeUndefined();
    await expect.poll(() => networkScore(fixture.evidence())).toBe(true);
    const events = await readEvents(opened.page);
    const operations = completedProgramOperations(events);
    expect(operations["net.requests"]).toBeGreaterThanOrEqual(2);
    expect(operations["net.responseBody"]).toBe(6);
    expect(toolLifecycleEvidence(events).complete).toBe(true);
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); await closeServer(fixture.server); }
});
