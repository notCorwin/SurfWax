import { describe, expect, it } from "vitest";
import { EventLogger, type LogEvent } from "../logging";
import { BrowserDiagnostics } from "./diagnostics";

function harness() {
  const events: LogEvent[] = [];
  const logger = new EventLogger({ store: { async append(event) { const saved = { ...event, id: events.length + 1 }; events.push(saved); return saved; }, async all() { return events; }, async clear() { events.splice(0); } } });
  const diagnostics = new BrowserDiagnostics(logger);
  diagnostics.bind({ conversationId: "conversation" });
  return { diagnostics, logger, events };
}
function request(index: number) { return { requestId: `${index}`, request: { method: "POST", url: `https://test/${index}`, headers: { secret: "raw" }, postData: `body ${index}` }, type: "Fetch" }; }

describe("BrowserDiagnostics", () => {
  it("keeps diagnostic events in the operation's original phase", async () => {
    const { diagnostics, logger, events } = harness();
    logger.beginRun("conversation", "run"); logger.setRunPhase("run", 1);
    diagnostics.bind({ conversationId: "conversation", toolCallId: "request", logIdentity: logger.toolIdentity("conversation", "request") });
    logger.setRunPhase("run", 2);
    diagnostics.handle({ tabId: 1 }, "Network.requestWillBeSent", request(1));
    await logger.flush();
    expect(events[0]).toMatchObject({ runId: "run", toolCallId: "1:request" });
  });

  it("persists raw events, limits cache memory and restores old pages of requests from the canonical log", async () => {
    const { diagnostics, logger, events } = harness();
    for (let index = 1; index <= 1005; index += 1) diagnostics.handle({ tabId: 1 }, "Network.requestWillBeSent", request(index));
    expect((diagnostics as any).tabs.get(1).network).toHaveLength(1000);
    const raw = request(1);
    await logger.flush();
    expect(events).toHaveLength(1005);
    expect(events[0]?.output).toEqual(raw);
    expect(await diagnostics.requests(1, { offset: 0, limit: 2 })).toEqual([
      { index: 1, method: "POST", url: "https://test/1", status: undefined, statusText: undefined },
      { index: 2, method: "POST", url: "https://test/2", status: undefined, statusText: undefined },
    ]);
    expect(await diagnostics.request(1, 1)).toMatchObject({ requestBody: "body 1", requestHeaders: { secret: "raw" } });
  });
  it("keeps identical request IDs in distinct frame sessions separate and clears only the active epoch", async () => {
    const { diagnostics } = harness();
    diagnostics.handle({ tabId: 1, sessionId: "frame-a" }, "Network.requestWillBeSent", request(1));
    diagnostics.handle({ tabId: 1, sessionId: "frame-b" }, "Network.requestWillBeSent", request(1));
    diagnostics.handle({ tabId: 1, sessionId: "frame-b" }, "Network.responseReceived", { requestId: "1", response: { status: 201, headers: { response: "b" } } });
    expect(await diagnostics.request(1, 1)).toMatchObject({ debuggee: { tabId: 1, sessionId: "frame-a" } });
    expect(await diagnostics.request(1, 2)).toMatchObject({ debuggee: { tabId: 1, sessionId: "frame-b" }, status: 201 });
    diagnostics.handle({ tabId: 1, sessionId: "frame-a" }, "Page.frameNavigated", { frame: { id: "iframe-root" } });
    expect(await diagnostics.requests(1, {})).toHaveLength(2);
    diagnostics.handle({ tabId: 1 }, "Page.frameNavigated", { frame: { id: "root" } });
    expect(await diagnostics.requests(1, {})).toEqual([]);
  });
  it("paginates console output, honors severity, and leaves the raw argument objects in the log", async () => {
    const { diagnostics, logger, events } = harness();
    const params = { type: "warning", timestamp: 1, args: [{ value: "raw" }, { type: "object", description: "Object", objectId: "remote" }] };
    diagnostics.handle({ tabId: 1 }, "Runtime.consoleAPICalled", params);
    diagnostics.handle({ tabId: 1 }, "Log.entryAdded", { entry: { level: "error", text: "failure", timestamp: 2 } });
    expect(await diagnostics.console(1, { minLevel: "error", limit: 1 })).toEqual([{ index: 2, level: "error", text: "failure", timestamp: 2 }]);
    await logger.flush();
    expect(events[0]?.output).toEqual(params);
  });
  it("retains extra headers delivered before the request event in the originating frame session", async () => {
    const { diagnostics } = harness();
    diagnostics.handle({ tabId: 1, sessionId: "frame" }, "Network.requestWillBeSentExtraInfo", { requestId: "1", headers: { Cookie: "complete" } });
    diagnostics.handle({ tabId: 1, sessionId: "frame" }, "Network.responseReceivedExtraInfo", { requestId: "1", headers: { "Set-Cookie": "raw" } });
    diagnostics.handle({ tabId: 1, sessionId: "frame" }, "Network.requestWillBeSent", request(1));
    diagnostics.handle({ tabId: 1, sessionId: "frame" }, "Network.responseReceived", { requestId: "1", response: { status: 200, headers: { "content-type": "text/plain" } } });
    expect(await diagnostics.request(1, 1)).toMatchObject({ requestHeaders: { Cookie: "complete" }, responseHeaders: { "Set-Cookie": "raw" } });
  });
});
