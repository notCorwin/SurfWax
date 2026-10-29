import { describe, expect, it, vi } from "vitest";
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
    const page = await diagnostics.requests(1, { offset: 0, limit: 2 }) as any;
    expect(page).toMatchObject({ integrity: "complete", hasMore: true, nextOffset: 2 });
    const listed = page.requests;
    expect(listed).toEqual([
      { requestRef: expect.any(String), method: "POST", url: "https://test/1", status: undefined, statusText: undefined },
      { requestRef: expect.any(String), method: "POST", url: "https://test/2", status: undefined, statusText: undefined },
    ]);
    expect(await diagnostics.request(1, listed[0].requestRef)).toMatchObject({ requestBody: "body 1", requestHeaders: { secret: "raw" } });
  });
  it("keeps identical request IDs in distinct frame sessions separate and clears only the active epoch", async () => {
    const { diagnostics } = harness();
    diagnostics.handle({ tabId: 1, sessionId: "frame-a" }, "Network.requestWillBeSent", request(1));
    diagnostics.handle({ tabId: 1, sessionId: "frame-b" }, "Network.requestWillBeSent", request(1));
    diagnostics.handle({ tabId: 1, sessionId: "frame-b" }, "Network.responseReceived", { requestId: "1", response: { status: 201, headers: { response: "b" } } });
    const [a, b] = (await diagnostics.requests(1, {}) as any).requests;
    expect(a.requestRef).not.toBe(b.requestRef);
    expect(await diagnostics.request(1, a.requestRef)).toMatchObject({ debuggee: { tabId: 1, sessionId: "frame-a" } });
    expect(await diagnostics.request(1, b.requestRef)).toMatchObject({ debuggee: { tabId: 1, sessionId: "frame-b" }, status: 201 });
    await expect(diagnostics.request(2, a.requestRef)).rejects.toMatchObject({ code: "stale-request" });
    diagnostics.handle({ tabId: 1, sessionId: "frame-a" }, "Page.frameNavigated", { frame: { id: "iframe-root" } });
    expect((await diagnostics.requests(1, {}) as any).requests).toHaveLength(2);
    diagnostics.handle({ tabId: 1 }, "Page.frameNavigated", { frame: { id: "root" } });
    expect((await diagnostics.requests(1, {}) as any).requests).toEqual([]);
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
    const [record] = (await diagnostics.requests(1, {}) as any).requests;
    expect(await diagnostics.request(1, record.requestRef)).toMatchObject({ requestHeaders: { Cookie: "complete" }, responseHeaders: { "Set-Cookie": "raw" } });
  });

  it("rejects a previous document's reference even when Chrome reuses request IDs and indexes", async () => {
    const { diagnostics } = harness();
    diagnostics.handle({ tabId: 1 }, "Network.requestWillBeSent", request(1));
    const [before] = (await diagnostics.requests(1, {}) as any).requests;
    diagnostics.handle({ tabId: 1 }, "Page.frameNavigated", { frame: { id: "root" } });
    diagnostics.handle({ tabId: 1 }, "Network.requestWillBeSent", { ...request(1), request: { method: "GET", url: "https://test/new", headers: {} } });
    const [after] = (await diagnostics.requests(1, {}) as any).requests;
    expect(after.requestRef).not.toBe(before.requestRef);
    await expect(diagnostics.request(1, before.requestRef)).rejects.toMatchObject({ code: "stale-request" });
    await expect(diagnostics.request(1, after.requestRef)).resolves.toMatchObject({ url: "https://test/new" });
  });

  it("gives redirects separate references and never exposes a later hop as the earlier body", async () => {
    const { diagnostics } = harness();
    diagnostics.handle({ tabId: 1 }, "Network.requestWillBeSent", request(1));
    const [first] = (await diagnostics.requests(1, {}) as any).requests;
    diagnostics.handle({ tabId: 1 }, "Network.requestWillBeSent", { ...request(1), request: { method: "GET", url: "https://test/final", headers: {} }, redirectResponse: { status: 302 } });
    const [old, next] = (await diagnostics.requests(1, {}) as any).requests;
    expect(old).toMatchObject({ requestRef: first.requestRef, superseded: true });
    expect(next.requestRef).not.toBe(first.requestRef);
    await expect(diagnostics.request(1, first.requestRef)).rejects.toMatchObject({ code: "stale-request" });
    await expect(diagnostics.request(1, next.requestRef)).resolves.toMatchObject({ url: "https://test/final" });
  });

  it("invalidates a detached frame or child session without invalidating unrelated sources", async () => {
    const { diagnostics } = harness();
    diagnostics.handle({ tabId: 1, sessionId: "a" }, "Network.requestWillBeSent", { ...request(1), frameId: "frame-a" });
    diagnostics.handle({ tabId: 1, sessionId: "b" }, "Network.requestWillBeSent", { ...request(1), frameId: "frame-b" });
    const [a, b] = (await diagnostics.requests(1, {}) as any).requests;
    diagnostics.handle({ tabId: 1 }, "Page.frameDetached", { frameId: "frame-a" });
    await expect(diagnostics.request(1, a.requestRef)).rejects.toMatchObject({ code: "stale-request" });
    await expect(diagnostics.request(1, b.requestRef)).resolves.toMatchObject({ debuggee: { sessionId: "b" } });
    diagnostics.handle({ tabId: 1 }, "Target.detachedFromTarget", { sessionId: "b" });
    await expect(diagnostics.request(1, b.requestRef)).rejects.toMatchObject({ code: "stale-request" });
  });

  it.each(["redirect", "detach"] as const)("does not return an evicted old request when %s happens during log replay", async (change) => {
    const { diagnostics, logger } = harness();
    diagnostics.handle({ tabId: 1, sessionId: "child" }, "Network.requestWillBeSent", request(1));
    const [first] = (await diagnostics.requests(1, {}) as any).requests;
    for (let index = 2; index <= 1001; index++) diagnostics.handle({ tabId: 1 }, "Network.requestWillBeSent", request(index));
    await logger.flush();
    const original = logger.diagnosticEventsSnapshot.bind(logger);
    let entered!: () => void; let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    vi.spyOn(logger, "diagnosticEventsSnapshot").mockImplementation(async (conversation) => {
      const events = await original(conversation);
      if (++calls === 1) { entered(); await held; }
      return events;
    });
    const pending = diagnostics.request(1, first.requestRef);
    await started;
    if (change === "redirect") diagnostics.handle({ tabId: 1, sessionId: "child" }, "Network.requestWillBeSent", { ...request(1), redirectResponse: { status: 302 } });
    else diagnostics.handle({ tabId: 1 }, "Target.detachedFromTarget", { sessionId: "child" });
    release();
    await expect(pending).rejects.toMatchObject({ code: "stale-request" });
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it.each(["redirect", "detach"] as const)("fails closed if the log omits an already observed %s", async (change) => {
    const { diagnostics, logger } = harness();
    diagnostics.handle({ tabId: 1, sessionId: "child" }, "Network.requestWillBeSent", request(1));
    const [first] = (await diagnostics.requests(1, {}) as any).requests;
    for (let index = 2; index <= 1001; index++) diagnostics.handle({ tabId: 1 }, "Network.requestWillBeSent", request(index));
    await logger.flush();
    const oldEvents = await logger.diagnosticEventsSnapshot("conversation");
    if (change === "redirect") diagnostics.handle({ tabId: 1, sessionId: "child" }, "Network.requestWillBeSent", { ...request(1), redirectResponse: { status: 302 } });
    else diagnostics.handle({ tabId: 1 }, "Target.detachedFromTarget", { sessionId: "child" });
    // Diagnostic telemetry is best effort; it may not contain the latest
    // event. The live identity guard must reject an outdated reconstruction.
    vi.spyOn(logger, "diagnosticEventsSnapshot").mockResolvedValue(oldEvents);
    await expect(diagnostics.request(1, first.requestRef)).rejects.toMatchObject({ code: "stale-request" });
  });

  it("shares a cold log replay across concurrent requests and reuses bounded entries during unrelated traffic", async () => {
    const { diagnostics, logger } = harness();
    diagnostics.handle({ tabId: 1 }, "Network.requestWillBeSent", request(1));
    const [first] = (await diagnostics.requests(1, {}) as any).requests;
    for (let index = 2; index <= 1001; index++) diagnostics.handle({ tabId: 1 }, "Network.requestWillBeSent", request(index));
    await logger.flush();
    const reads = vi.spyOn(logger, "diagnosticEventsSnapshot");
    const [a, b] = await Promise.all([diagnostics.request(1, first.requestRef), diagnostics.request(1, first.requestRef)]);
    expect(a.requestRef).toBe(b.requestRef);
    expect(reads).toHaveBeenCalledTimes(1);
    diagnostics.handle({ tabId: 1 }, "Network.requestWillBeSent", request(1002));
    await diagnostics.request(1, first.requestRef);
    expect(reads).toHaveBeenCalledTimes(1);
    await diagnostics.requests(1, { offset: 0, limit: 2 });
    await diagnostics.requests(1, { offset: 0, limit: 2 });
    expect(reads).toHaveBeenCalledTimes(2);
  });

  it("cancels a waiting historical replay without cancelling shared work", async () => {
    const { diagnostics, logger } = harness();
    diagnostics.handle({ tabId: 1 }, "Network.requestWillBeSent", request(1));
    const [first] = (await diagnostics.requests(1, {}) as any).requests;
    for (let index = 2; index <= 1001; index++) diagnostics.handle({ tabId: 1 }, "Network.requestWillBeSent", request(index));
    await logger.flush();
    const original = logger.diagnosticEventsSnapshot.bind(logger);
    let entered!: () => void; let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const reads = vi.spyOn(logger, "diagnosticEventsSnapshot").mockImplementation(async (conversation) => { entered(); await held; return original(conversation); });
    const controller = new AbortController();
    const cancelled = diagnostics.request(1, first.requestRef, controller.signal);
    await started;
    const other = diagnostics.request(1, first.requestRef);
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    release();
    await expect(other).resolves.toMatchObject({ requestRef: first.requestRef });
    expect(reads).toHaveBeenCalledOnce();
  });

  it.each(["missing", "reordered", "duplicate"] as const)("reports %s replay events without claiming full history", async (problem) => {
    const { diagnostics, logger } = harness();
    for (let index = 1; index <= 1001; index++) diagnostics.handle({ tabId: 1 }, "Network.requestWillBeSent", request(index));
    await logger.flush();
    const original = logger.diagnosticEventsSnapshot.bind(logger);
    vi.spyOn(logger, "diagnosticEventsSnapshot").mockImplementation(async (conversation) => {
      const snapshot = await original(conversation), events = [...snapshot.value];
      if (problem === "missing") events.splice(20, 1);
      else if (problem === "reordered") [events[20], events[21]] = [events[21]!, events[20]!];
      else events.splice(21, 0, events[20]!);
      return { ...snapshot, value: events };
    });
    const first = await diagnostics.requests(1, { limit: 2 }) as any;
    expect(first).toMatchObject({ integrity: "incomplete", reason: "diagnostic-log-incomplete", hasMore: true, nextOffset: 2 });
    const end = await diagnostics.requests(1, { offset: 5000, limit: 2 }) as any;
    expect(end).toMatchObject({ requests: [], integrity: "incomplete", hasMore: null });
    expect(end).not.toHaveProperty("nextOffset");
  });

  it("keeps the known live tail if its diagnostic events were dropped", async () => {
    const { diagnostics, logger } = harness();
    for (let index = 1; index <= 1001; index++) diagnostics.handle({ tabId: 1 }, "Network.requestWillBeSent", request(index));
    await logger.flush();
    const original = logger.diagnosticEventsSnapshot.bind(logger);
    vi.spyOn(logger, "diagnosticEventsSnapshot").mockImplementation(async (conversation) => {
      const snapshot = await original(conversation);
      return { ...snapshot, value: snapshot.value.filter((event) => (event.content as any)?.revision !== 1001) };
    });
    const page = await diagnostics.requests(1, { offset: 1000, limit: 2 }) as any;
    expect(page).toMatchObject({ integrity: "incomplete", hasMore: null, requests: [{ url: "https://test/1001" }] });
  });

  it("invalidates cached historical pages after another logger clears the canonical log", async () => {
    const { diagnostics, logger, events } = harness();
    const other = new EventLogger({ store: {
      async append(event) { const saved = { ...event, id: events.length + 1 }; events.push(saved); return saved; },
      async all() { return events; }, async clear() { events.splice(0); },
    } });
    for (let index = 1; index <= 1001; index++) diagnostics.handle({ tabId: 1 }, "Network.requestWillBeSent", request(index));
    await logger.flush();
    const before = await diagnostics.requests(1, { limit: 1 }) as any;
    expect(before).toMatchObject({ integrity: "complete", requests: [{ url: "https://test/1" }] });
    await other.clear();
    const after = await diagnostics.requests(1, { limit: 1 }) as any;
    expect(after).toMatchObject({ integrity: "incomplete", reason: "diagnostic-log-incomplete", requests: [{ url: "https://test/2" }] });
  });

  it("includes console.clear in replay ordering and isolates conversation/run ownership", async () => {
    const { diagnostics, logger } = harness();
    diagnostics.bind({ conversationId: "conversation", logIdentity: { runId: "one", toolCallId: "call", toolCallIdCanonical: true } });
    for (let index = 1; index <= 500; index++) diagnostics.handle({ tabId: 1 }, "Network.requestWillBeSent", request(index));
    await diagnostics.console(1, { clear: true });
    for (let index = 501; index <= 1001; index++) diagnostics.handle({ tabId: 1 }, "Network.requestWillBeSent", request(index));
    await logger.flush();
    const page = await diagnostics.requests(1, { limit: 1 }) as any;
    expect(page).toMatchObject({ integrity: "complete", requests: [{ url: "https://test/1" }] });
    diagnostics.bind({ conversationId: "conversation", logIdentity: { runId: "two", toolCallId: "call", toolCallIdCanonical: true } });
    await expect(diagnostics.request(1, page.requests[0].requestRef)).rejects.toMatchObject({ code: "stale-request" });
    expect(await diagnostics.requests(1, {})).toMatchObject({ requests: [], integrity: "complete", hasMore: false });
    diagnostics.bind({ conversationId: "other", logIdentity: { runId: "two", toolCallId: "call", toolCallIdCanonical: true } });
    expect(await diagnostics.requests(1, {})).toMatchObject({ requests: [], integrity: "complete", hasMore: false });
  });

  it("does not mistake other tabs' interleaved events for a gap in this tab's capture", async () => {
    const { diagnostics, logger } = harness();
    for (let index = 1; index <= 1001; index++) {
      diagnostics.handle({ tabId: 1 }, "Network.requestWillBeSent", request(index));
      if (index % 20 === 0) diagnostics.handle({ tabId: 2 }, "Network.requestWillBeSent", request(index));
    }
    await logger.flush();
    expect(await diagnostics.requests(1, { limit: 1 })).toMatchObject({ integrity: "complete", requests: [{ url: "https://test/1" }] });
  });

  it("reports unavailable historical telemetry and keeps live results", async () => {
    const { diagnostics, logger } = harness();
    for (let index = 1; index <= 1001; index++) diagnostics.handle({ tabId: 1 }, "Network.requestWillBeSent", request(index));
    vi.spyOn(logger, "diagnosticEventsSnapshot").mockRejectedValue(new Error("storage unavailable"));
    expect(await diagnostics.requests(1, { offset: 1000 })).toMatchObject({ requests: [], integrity: "incomplete", reason: "diagnostic-log-unavailable", hasMore: null });
    expect((await diagnostics.requests(1, { limit: 1 }) as any).requests[0].url).toBe("https://test/2");
    await expect(diagnostics.requests(1, { limit: 101 })).rejects.toThrow("limit");
  });
});
