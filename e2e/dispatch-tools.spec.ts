import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, closeServer, type MockResponse } from "./fixtures";
import { sequenceFixture, sequenceInteractionScore, sequenceScore } from "./evaluation/sequence-fixture";
import { dispatchFixture, dispatchScore } from "./evaluation/dispatch-fixture";

// A scripted tool execution contract, not a measurement of model performance.
test("extension tools can complete the dispatch capability level", async () => {
  test.setTimeout(120_000);
  const fixture = await sequenceFixture(17);
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(fixture.origin);
    const expected = fixture.evidence().expected;
    const last = (request: any) => JSON.parse(request.messages.findLast((entry: any) => entry.role === "tool").content);
    responses.push(
      commandResponse("list_frames", {}, "dispatch-frames"),
      (request) => {
        const frameRef = last(request).frames?.find((frame: any) => frame.url.endsWith("/editor"))?.frameRef;
        expect(frameRef).toEqual(expect.any(String));
        const frame = { ref: frameRef };
        responses.unshift((request) => {
          const result = last(request);
          expect(result.ok).toBe(true);
          const current = result.result.items.map((item: any) => item.text).filter((name: string) => expected.sequence.includes(name));
          expect(current).toHaveLength(expected.sequence.length);
          const commands: Array<{name: string; input: object; id: string}> = [];
          for (let i = 0; i < expected.sequence.length; i++) {
            const name = expected.sequence[i], initial = current.indexOf(name);
            expect(initial).toBeGreaterThanOrEqual(i);
            for (let j = initial; j > i; j--) {
              commands.push({ name: "press_key", input: { target: { by: "role", value: "button", name, exact: true, frame }, key: "ArrowUp" }, id: `move-${commands.length}` });
              [current[j - 1], current[j]] = [current[j], current[j - 1]];
            }
          }
          commands.push(
            { name: "fill", input: { target: { by: "label", value: "Dispatch reference", frame }, value: expected.reference }, id: "reference" },
            { name: "check_element", input: { target: { by: "label", value: "Confirm dispatch", frame } }, id: "confirm" },
            { name: "click", input: { target: { by: "role", value: "button", name: "Send dispatch", frame } }, id: "dispatch" },
          );
          const advance: MockResponse = (request) => {
            expect(last(request).ok).toBe(true);
            const next = commands.shift();
            if (!next) return textResponse("DISPATCH_TOOL_PATH_DONE");
            responses.unshift(advance);
            return commandResponse(next.name, next.input, next.id);
          };
          const first = commands.shift()!;
          responses.unshift(advance);
          return commandResponse(first.name, first.input, first.id);
        });
        return commandResponse("read_elements", { target: { by: "role", value: "button", frame } }, "dispatch-order");
      },
      textResponse("Dispatch"),
    );
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill(fixture.prompt);
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("DISPATCH_TOOL_PATH_DONE", { timeout: 100_000 });
    await expect.poll(() => sequenceScore(fixture.evidence())).toBe(true);
    expect(sequenceInteractionScore(fixture.evidence())).toBe(true);
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
    await closeServer(fixture.server);
  }
});

test("extension tools can complete the popup and dialog capability level", async () => {
  test.setTimeout(120_000);
  const fixture = await dispatchFixture(17);
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    // Prevent Playwright from automatically dismissing dialogs on new pages;
    // the extension owns the actual response.
    opened.context.on("page", (popup) => popup.on("dialog", () => {}));
    const target = await opened.context.newPage();
    await target.goto(fixture.origin);
    let jobId = "", polls = 0, code = "", subscriptionId = "";
    const last = (request: any) => JSON.parse(request.messages.findLast((entry: any) => entry.role === "tool").content);
    const poll: MockResponse = (request) => {
      const result = last(request);
      if (result.terminal || result.state === "succeeded") {
        expect(result).toMatchObject({ ok: true, state: "succeeded" });
        return textResponse("REVIEW_TOOL_PATH_DONE");
      }
      responses.unshift(poll);
      return commandResponse("get_job", { jobId, after: result.nextCursor, waitMs: 10_000 }, `review-poll-${++polls}`);
    };
    responses.push(
      commandResponse("subscribe_event", { kind: "popup" }, "subscribe-popup"),
      (request) => {
        subscriptionId = last(request).subscriptionId;
        expect(subscriptionId).toEqual(expect.any(String));
        return commandResponse("click", { target: { by: "role", value: "button", name: "Open dispatch review", frame: { by: "css", value: 'iframe[title="Dispatch desk"]' } } }, "open-review");
      },
      (request) => { expect(last(request).ok).toBe(true); return commandResponse("wait_event", { subscriptionId, waitMs: 10_000 }, "wait-popup"); },
      (request) => {
        const popup = last(request).events.find((event: any) => event.kind === "popup");
        expect(popup?.payload.tabId).toEqual(expect.any(Number));
        const tabId = popup.payload.tabId;
        responses.unshift((request) => {
          const result = last(request);
          expect(result).toMatchObject({ ok: true, result: expect.any(String) });
          code = result.result;
          return commandResponse("click", { tabId, target: { by: "role", value: "button", name: "Confirm dispatch" }, timeoutMs: 30_000 }, "review-click");
        });
        return commandResponse("read_text", { tabId, target: { by: "css", value: "strong" } }, "read-code");
      },
      (request) => {
        const result = last(request);
        expect(result).toMatchObject({ accepted: true, state: "blocked", blockedBy: { kind: "dialog", type: "prompt" } });
        jobId = result.jobId;
        return commandResponse("handle_dialog", { dialogId: result.blockedBy.dialogId, accept: true, prompt: code }, "review-answer");
      },
      (request) => {
        expect(last(request)).toMatchObject({ state: "completed" });
        responses.unshift(poll);
        return commandResponse("get_job", { jobId, waitMs: 10_000 }, "review-job");
      },
      textResponse("Dispatch review"),
    );
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill(fixture.prompt);
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("REVIEW_TOOL_PATH_DONE", { timeout: 100_000 });
    await expect.poll(() => dispatchScore(fixture.evidence())).toBe(true);
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
    await closeServer(fixture.server);
  }
});
