import { afterEach, describe, expect, it, vi } from "vitest";
import { EventLogger, fromLogValue, type LogEvent } from "../logging";
import { BrowserJobs } from "./jobs";
import { ProgramScope } from "./program";

function log() {
  const events: LogEvent[] = [];
  const logger = new EventLogger({
    store: {
      async append(event: Omit<LogEvent, "id">) {
        const saved = { ...event, id: events.length + 1 };
        events.push(saved);
        return saved;
      },
      async all() {
        return [...events];
      },
      async clear() {
        events.length = 0;
      },
    },
  });
  return { logger, events };
}
function indexedLog() {
  const events: LogEvent[] = [];
  const byTypes = vi.fn(async (types: readonly string[], conversationId?: string, afterId = -1, limit = Infinity) =>
    events.filter((event) => event.id > afterId && types.includes(event.type) && (!conversationId || event.conversationId === conversationId)).slice(0, limit));
  const getMany = vi.fn(async (ids: readonly number[]) => ids.map((id) => events.find((event) => event.id === id)));
  const store = {
    async append(event: Omit<LogEvent, "id">) { const saved = { ...event, id: events.length + 1 }; events.push(saved); return saved; },
    async all() { return [...events]; }, byTypes, getMany,
  };
  const logger = new EventLogger({ store });
  return { logger, store, events, byTypes, getMany };
}
const context = { conversationId: "program-test" };
afterEach(() => vi.useRealTimers());

describe("canonical browser jobs", () => {
  it("catches up incrementally, batches event reads, and coalesces concurrent readers", async () => {
    const { logger, byTypes, getMany } = indexedLog();
    const jobs = new BrowserJobs(logger);
    await logger.append({ type: "browser.job.state", ...context, content: { jobId: "long", state: "running" } });
    for (let index = 0; index < 280; index++) await logger.append({ type: "browser.job.progress", ...context, content: { jobId: "long", index }, output: "x".repeat(1024) });
    await logger.append({ type: "browser.job.state", ...context, content: { jobId: "long", state: "succeeded" }, output: "done" });
    const baseline: any = await jobs.query({ action: "status", id: "long", limit: 500 }, context.conversationId);
    expect(baseline.events).toHaveLength(282);
    byTypes.mockClear(); getMany.mockClear();
    await Promise.all(Array.from({ length: 20 }, () => jobs.query({ action: "status", id: "long", after: baseline.nextCursor }, context.conversationId)));
    const reads = byTypes.mock.calls.filter(([types]) => types.includes("browser.job.progress"));
    expect(reads.length).toBeLessThanOrEqual(2);
    expect(reads.every(([, conversationId, afterId]) => conversationId === context.conversationId && afterId === baseline.nextCursor)).toBe(true);
    expect(getMany.mock.calls.every(([ids]) => ids.length === 1)).toBe(true);
    await logger.append({ type: "browser.job.progress", ...context, content: { jobId: "long", index: 280 } });
    const delta: any = await jobs.query({ action: "status", id: "long", after: baseline.nextCursor }, context.conversationId);
    expect(delta.events).toMatchObject([{ index: 280 }]);
  });

  it("rechecks a shared catch-up when a second reader starts after an append", async () => {
    const { logger } = indexedLog();
    const jobs = new BrowserJobs(logger);
    await logger.append({ type: "browser.job.state", ...context, content: { jobId: "shared", state: "succeeded" } });
    await jobs.query({ action: "status", id: "shared" }, context.conversationId);
    const original = logger.jobEventsSince.bind(logger);
    let captured!: () => void, release!: () => void;
    const ready = new Promise<void>((resolve) => { captured = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let first = true;
    vi.spyOn(logger, "jobEventsSince").mockImplementation(async (...args) => {
      const page = await original(...args);
      if (first) { first = false; captured(); await gate; }
      return page;
    });
    const one = jobs.query({ action: "status", id: "shared" }, context.conversationId);
    await ready;
    await logger.append({ type: "browser.job.progress", ...context, content: { jobId: "shared", value: "new" } });
    const two = jobs.query({ action: "status", id: "shared" }, context.conversationId);
    release();
    const [, second]: any[] = await Promise.all([one, two]);
    expect(second.events).toContainEqual(expect.objectContaining({ value: "new" }));
  });

  it("lets earlier readers finish while later readers trigger another catch-up", async () => {
    const { logger } = indexedLog();
    const jobs = new BrowserJobs(logger);
    await logger.append({ type: "browser.job.state", ...context, content: { jobId: "job", state: "succeeded" } });
    const original = logger.jobEventsSince.bind(logger);
    let releaseFirst!: () => void, releaseSecond!: () => void, firstReady!: () => void, secondReady!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
    const firstStarted = new Promise<void>((resolve) => { firstReady = resolve; });
    const secondStarted = new Promise<void>((resolve) => { secondReady = resolve; });
    let calls = 0;
    vi.spyOn(logger, "jobEventsSince").mockImplementation(async (...args) => {
      const page = await original(...args);
      if (++calls === 1) { firstReady(); await firstGate; }
      else if (calls === 2) { secondReady(); await secondGate; }
      return page;
    });
    const first = jobs.query({ action: "status", id: "job" }, context.conversationId);
    await firstStarted;
    const second = jobs.query({ action: "status", id: "job" }, context.conversationId);
    releaseFirst();
    await secondStarted;
    expect(await first).toMatchObject({ state: "succeeded" });
    releaseSecond();
    expect(await second).toMatchObject({ state: "succeeded" });
  });

  it("keeps pagination complete after ID-cache eviction and invalidates it on log clear", async () => {
    const { logger } = indexedLog();
    const jobs = new BrowserJobs(logger, { maxIndexedEvents: 1 });
    await logger.append({ type: "browser.job.state", ...context, content: { jobId: "old", state: "running" } });
    await logger.append({ type: "browser.job.progress", ...context, content: { jobId: "other", value: 9 } });
    await logger.append({ type: "browser.job.progress", ...context, content: { jobId: "old", value: 1 } });
    await logger.append({ type: "browser.job.progress", ...context, content: { jobId: "old", value: 2 } });
    await logger.append({ type: "browser.job.state", ...context, content: { jobId: "old", state: "succeeded" }, output: "old-result" });
    const first: any = await jobs.query({ action: "status", id: "old", limit: 2 }, context.conversationId);
    expect(first.events).toMatchObject([{ state: "running" }, { value: 1 }]);
    expect(first.hasMore).toBe(true);
    const second: any = await jobs.query({ action: "status", id: "old", after: first.nextCursor, limit: 2 }, context.conversationId);
    expect(second.events).toMatchObject([{ value: 2 }, { state: "succeeded" }]);
    expect(second.hasMore).toBe(false);
    await logger.clear();
    await expect(jobs.query({ action: "status", id: "old" }, context.conversationId)).rejects.toThrow("unavailable");
    await logger.append({ type: "browser.job.state", ...context, content: { jobId: "old", state: "succeeded" }, output: "new-result" });
    const fresh: any = await jobs.query({ action: "status", id: "old" }, context.conversationId);
    expect(fresh.events).toHaveLength(1);
    expect(fresh.result).toBe("new-result");
  });

  it("does not resurrect a recovered job when its clear epoch changes before the conditional append", async () => {
    const { logger, events } = indexedLog();
    const jobs = new BrowserJobs(logger);
    await logger.append({ type: "browser.job.state", ...context, content: { jobId: "lost", state: "running" } });
    const append = logger.appendIfEpoch.bind(logger);
    let reached!: () => void, release!: () => void;
    const ready = new Promise<void>((resolve) => { reached = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(logger, "appendIfEpoch").mockImplementation(async (record, epoch, expectedId) => { reached(); await gate; return append(record, epoch, expectedId); });
    const querying = jobs.query({ action: "status", id: "lost" }, context.conversationId);
    await ready;
    await logger.clear();
    release();
    await expect(querying).rejects.toThrow("unavailable");
    expect(events.filter((event) => (fromLogValue(event.content) as any)?.state === "interrupted")).toHaveLength(0);
  });

  it("does not overwrite a terminal event that commits before the recovery CAS", async () => {
    const { logger, store, events } = indexedLog();
    const jobs = new BrowserJobs(logger);
    await logger.append({ type: "browser.job.state", ...context, content: { jobId: "lost", state: "running" } });
    const append = logger.appendIfEpoch.bind(logger);
    let reached!: () => void, release!: () => void;
    const ready = new Promise<void>((resolve) => { reached = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(logger, "appendIfEpoch").mockImplementation(async (record, epoch, expectedId) => { reached(); await gate; return append(record, epoch, expectedId); });
    const querying = jobs.query({ action: "status", id: "lost" }, context.conversationId);
    await ready;
    await new EventLogger({ store }).append({ type: "browser.job.state", ...context, content: { jobId: "lost", state: "succeeded" }, output: "done" });
    release();
    expect(await querying).toMatchObject({ state: "succeeded", terminal: true, result: "done" });
    expect(events.filter((event) => (fromLogValue(event.content) as any)?.state === "interrupted")).toHaveLength(0);
  });

  it("does not report an abandoned job as live when recovery cannot be persisted", async () => {
    const { logger } = indexedLog();
    const jobs = new BrowserJobs(logger);
    await logger.append({ type: "browser.job.state", ...context, content: { jobId: "lost", state: "running" } });
    logger.stop();
    await expect(jobs.query({ action: "status", id: "lost" }, context.conversationId)).rejects.toThrow("Could not persist job recovery");
  });

  it("discards a page if the log is cleared while its event IDs are being read", async () => {
    const { logger, getMany } = indexedLog();
    const jobs = new BrowserJobs(logger);
    await logger.append({ type: "browser.job.state", ...context, content: { jobId: "old", state: "succeeded" }, output: "secret" });
    await jobs.query({ action: "status", id: "old" }, context.conversationId);
    const original = getMany.getMockImplementation()!;
    let captured!: () => void, release!: () => void;
    const ready = new Promise<void>((resolve) => { captured = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    getMany.mockImplementation(async (ids) => { const result = await original(ids); captured(); await gate; return result; });
    const querying = jobs.query({ action: "status", id: "old" }, context.conversationId);
    await ready;
    await logger.clear();
    release();
    await expect(querying).rejects.toThrow("unavailable");
  });
  it("never misidentifies a queued job as host-lost while its start is still publishing", async () => {
    const { logger, events } = log();
    const jobs = new BrowserJobs(logger);
    const append = logger.append.bind(logger);
    let release!: () => void;
    let published!: () => void;
    const queued = new Promise<void>((resolve) => { published = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(logger, "append").mockImplementation(async (record) => {
      const event = await append(record);
      if (record.type === "browser.job.state" && (record.content as any)?.state === "queued") {
        published();
        await gate;
      }
      return event;
    });
    const execute = vi.fn(async () => undefined);
    const starting = jobs.start(context, undefined, execute);
    await queued;
    const id = (fromLogValue(events[0]!.content) as any).jobId;
    expect(await jobs.query({ action: "list" }, context.conversationId)).toEqual({ jobs: [{ id, state: "queued" }] });
    expect(await jobs.query({ action: "cancel", id }, context.conversationId)).toMatchObject({ state: "queued", terminal: false });
    release();
    expect(await starting).toBe(id);
    expect(await jobs.completion(id, context.conversationId)).toMatchObject({ state: "cancelled", terminal: true });
    expect(execute).not.toHaveBeenCalled();
    expect(events.filter((event) => (fromLogValue(event.content) as any)?.state === "interrupted")).toHaveLength(0);
  });

  it("does not overwrite a real terminal result when a reader holds an older running snapshot", async () => {
    const { logger, events } = log();
    const jobs = new BrowserJobs(logger);
    let finish!: () => void;
    const id = await jobs.start(context, undefined, async (_signal, _id, started) => {
      await started();
      await new Promise<void>((resolve) => { finish = resolve; });
      return "done";
    });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    const original = logger.jobEventsSince.bind(logger);
    let read!: () => void;
    let release!: () => void;
    const captured = new Promise<void>((resolve) => { read = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let first = true;
    vi.spyOn(logger, "jobEventsSince").mockImplementation(async (conversationId, afterId, limit) => {
      const snapshot = await original(conversationId, afterId, limit);
      if (first) { first = false; read(); await gate; }
      return snapshot;
    });
    const querying = jobs.query({ action: "status", id }, context.conversationId);
    await captured;
    finish();
    await vi.waitFor(() => expect(events.some((event) => (fromLogValue(event.content) as any)?.state === "succeeded")).toBe(true));
    release();
    expect(await querying).toMatchObject({ state: "succeeded", terminal: true, result: "done" });
    expect(events.filter((event) => (fromLogValue(event.content) as any)?.state === "interrupted")).toHaveLength(0);
  });

  it("rechecks abandoned-job candidates and deduplicates concurrent recovery", async () => {
    const { logger, events } = log();
    await logger.append({ type: "browser.job.state", ...context, content: { jobId: "lost", state: "running" } });
    const jobs = new BrowserJobs(logger);
    await Promise.all([
      jobs.query({ action: "status", id: "lost" }, context.conversationId),
      jobs.query({ action: "list" }, context.conversationId),
    ]);
    expect(events.filter((event) => (fromLogValue(event.content) as any)?.state === "interrupted")).toHaveLength(1);
  });

  it("rechecks the durable state before recovering an apparently lost job", async () => {
    const { logger, events } = log();
    await logger.append({ type: "browser.job.state", ...context, content: { jobId: "old", state: "running" } });
    const jobs = new BrowserJobs(logger);
    const original = logger.jobEventsSince.bind(logger);
    let read!: () => void;
    let release!: () => void;
    const captured = new Promise<void>((resolve) => { read = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let first = true;
    vi.spyOn(logger, "jobEventsSince").mockImplementation(async (conversationId, afterId, limit) => {
      const snapshot = await original(conversationId, afterId, limit);
      if (first) { first = false; read(); await gate; }
      return snapshot;
    });
    const querying = jobs.query({ action: "status", id: "old" }, context.conversationId);
    await captured;
    await logger.append({ type: "browser.job.state", ...context, content: { jobId: "old", state: "succeeded" }, output: "saved" });
    release();
    expect(await querying).toMatchObject({ state: "succeeded", terminal: true, result: "saved" });
    expect(events.filter((event) => (fromLogValue(event.content) as any)?.state === "interrupted")).toHaveLength(0);
  });

  it("returns unread progress immediately and waits for the next matching receipt", async () => {
    const { logger } = log();
    const jobs = new BrowserJobs(logger);
    let finish!: () => void;
    const id = await jobs.start(context, undefined, async (_signal, _id, started) => {
      await started();
      await new Promise<void>((resolve) => { finish = resolve; });
    });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    const baseline: any = await jobs.query({ action: "status", id }, context.conversationId);
    await logger.append({ type: "browser.job.progress", ...context, content: { jobId: id, operation: "first" } });
    const unread: any = await jobs.query({ action: "wait", id, after: baseline.nextCursor, waitMs: 10_000 }, context.conversationId);
    expect(unread.events).toMatchObject([{ operation: "first" }]);
    let returned = false;
    const waiting = jobs.query({ action: "wait", id, after: unread.nextCursor, waitMs: 10_000 }, context.conversationId).then((result) => { returned = true; return result; });
    await logger.append({ type: "browser.job.progress", conversationId: "another", content: { jobId: id, operation: "unrelated" } });
    await logger.append({ type: "browser.job.progress", ...context, content: { jobId: "other-job", operation: "unrelated" } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(returned).toBe(false);
    await logger.append({ type: "browser.job.progress", ...context, content: { jobId: id, operation: "second" } });
    expect(await waiting).toMatchObject({ state: "running", terminal: false, events: [{ operation: "second" }] });
    finish();
    await jobs.completion(id, context.conversationId);
  });

  it("removes its subscription on cancellation", async () => {
    const { logger } = log();
    const jobs = new BrowserJobs(logger);
    let finish!: () => void;
    const id = await jobs.start(context, undefined, async (_signal, _id, started) => {
      await started();
      await new Promise<void>((resolve) => { finish = resolve; });
    });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    const baseline: any = await jobs.query({ action: "status", id }, context.conversationId);
    const subscribe = logger.subscribe.bind(logger);
    const removed = vi.fn();
    vi.spyOn(logger, "subscribe").mockImplementation((listener) => {
      const unsubscribe = subscribe(listener);
      return () => { removed(); unsubscribe(); };
    });
    const controller = new AbortController();
    const waiting = jobs.query({ action: "wait", id, after: baseline.nextCursor, waitMs: 10_000 }, context.conversationId, controller.signal);
    controller.abort(new DOMException("cancelled", "AbortError"));
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    expect(removed).toHaveBeenCalledOnce();
    finish();
    await jobs.completion(id, context.conversationId);
  });

  it("does not miss a receipt committed between subscription and the initial read", async () => {
    const { logger } = log();
    const jobs = new BrowserJobs(logger);
    let finish!: () => void;
    const id = await jobs.start(context, undefined, async (_signal, _id, started) => {
      await started();
      await new Promise<void>((resolve) => { finish = resolve; });
    });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    const baseline: any = await jobs.query({ action: "status", id }, context.conversationId);
    const original = logger.jobEventsSince.bind(logger);
    let read!: () => void;
    let release!: () => void;
    const captured = new Promise<void>((resolve) => { read = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let first = true;
    vi.spyOn(logger, "jobEventsSince").mockImplementation(async (conversationId, afterId, limit) => {
      const snapshot = await original(conversationId, afterId, limit);
      if (first) { first = false; read(); await gate; }
      return snapshot;
    });
    const waiting = jobs.query({ action: "wait", id, after: baseline.nextCursor, waitMs: 10_000 }, context.conversationId);
    await captured;
    await logger.append({ type: "browser.job.progress", ...context, content: { jobId: id, operation: "during-read" } });
    release();
    expect(await waiting).toMatchObject({ terminal: false, events: [{ operation: "during-read" }] });
    finish();
    await jobs.completion(id, context.conversationId);
  });
  it("returns cursor slices and rejects jobs owned by another conversation", async () => {
    const { logger } = log();
    const jobs = new BrowserJobs(logger);
    const id = await jobs.start(
      context,
      undefined,
      async (_signal, _id, started) => {
        await started();
        return { value: 7 };
      },
    );
    await jobs.completion(id, context.conversationId);
    const first: any = await jobs.query(
      { action: "status", id, limit: 1 },
      context.conversationId,
    );
    expect(first).toMatchObject({
      state: "succeeded",
      ok: true,
      result: { value: 7 },
      hasMore: true,
    });
    const rest: any = await jobs.query(
      { action: "status", id, after: first.nextCursor },
      context.conversationId,
    );
    expect(
      rest.events.every((event: any) => event.cursor > first.nextCursor),
    ).toBe(true);
    expect(rest.hasMore).toBe(false);
    await expect(
      jobs.query({ action: "cancel", id }, "other-conversation"),
    ).rejects.toThrow("unavailable");
  });
  it("honors a wait longer than 30 seconds without cancelling the job", async () => {
    const { logger } = log();
    const jobs = new BrowserJobs(logger);
    let finish!: () => void;
    const id = await jobs.start(context, undefined, async (_signal, _id, started) => {
      await started();
      await new Promise<void>((resolve) => { finish = resolve; });
    });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    const baseline: any = await jobs.query({ action: "status", id }, context.conversationId);
    vi.useFakeTimers();
    let returned = false;
    const waiting = jobs.query({ action: "wait", id, after: baseline.nextCursor, waitMs: 60_000 }, context.conversationId).then((value) => { returned = true; return value; });
    await vi.advanceTimersByTimeAsync(30_001);
    expect(returned).toBe(false);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(await waiting).toMatchObject({ state: "running", terminal: false });
    finish();
    await jobs.settle(context.conversationId);
  });
  it("keeps cancellation pending until the execution host completes cleanup and never rolls back", async () => {
    const { logger } = log();
    const jobs = new BrowserJobs(logger);
    let cleaned!: () => void;
    let effects = 0;
    const id = await jobs.start(
      context,
      undefined,
      async (signal, _id, started) => {
        await started();
        effects++;
        await new Promise<void>((resolve) => {
          cleaned = resolve;
        });
        signal.throwIfAborted();
      },
    );
    await vi.waitFor(() => expect(effects).toBe(1));
    expect(
      await jobs.query({ action: "cancel", id }, context.conversationId),
    ).toMatchObject({ state: "running", terminal: false, rollback: false });
    cleaned();
    expect(
      await jobs.completion(id, context.conversationId),
    ).toMatchObject({ state: "cancelled", terminal: true, ok: false });
    expect(effects).toBe(1);
  });
  it("projects a lost host as interrupted and preserves partial receipts without replay", async () => {
    const { logger, events } = log();
    await logger.append({
      type: "browser.job.state",
      ...context,
      content: { jobId: "lost", state: "running" },
    });
    await logger.append({
      type: "browser.job.progress",
      ...context,
      content: {
        jobId: "lost",
        sequence: 1,
        operation: "click",
        state: "completed",
      },
    });
    const recovered = new BrowserJobs(logger);
    expect(
      await recovered.query(
        { action: "status", id: "lost" },
        context.conversationId,
      ),
    ).toMatchObject({
      state: "interrupted",
      result: {
        error: { code: "host-lost", retryable: false, effectUnknown: true },
      },
    });
    await recovered.query(
      { action: "status", id: "lost" },
      context.conversationId,
    );
    expect(
      events.filter((event) => event.type === "browser.job.state"),
    ).toHaveLength(2);
  });
  it("returns the exact failed step error alongside partial progress", async () => {
    const { logger } = log();
    const jobs = new BrowserJobs(logger);
    const id = await jobs.start(
      context,
      undefined,
      async (signal, id, started) => {
        await started();
        const scope = new ProgramScope(signal, id, context, logger);
        await scope.call("first", () => ({ performed: true }), false);
        await scope.check(false, "outcome did not match");
      },
    );
    const result: any = await jobs.completion(id, context.conversationId);
    expect(result.events).toContainEqual(
      expect.objectContaining({
        operation: "first",
        state: "completed",
        output: { performed: true },
      }),
    );
    expect(result.events).toContainEqual(
      expect.objectContaining({
        operation: "check",
        state: "not-dispatched",
        error: expect.objectContaining({ message: "outcome did not match" }),
      }),
    );
  });
  it("reports timeout as failure and cleans bounded wait timers", async () => {
    const { logger } = log();
    const jobs = new BrowserJobs(logger);
    const id = await jobs.start(context, undefined, async () => {
      throw new DOMException("deadline", "TimeoutError");
    });
    expect(
      await jobs.completion(id, context.conversationId),
    ).toMatchObject({
      state: "failed",
      result: { error: { code: "timeout", retryable: false } },
    });
  });
});

describe("revocable program capabilities", () => {
  it("serializes mutations, subscribes before them, and separates dispatch from verification", async () => {
    const { logger, events } = log();
    const scope = new ProgramScope(
      new AbortController().signal,
      "job",
      context,
      logger,
    );
    const order: string[] = [];
    let notify!: () => void;
    const waiting = scope.call(
      "waitForEvent",
      () => {
        order.push("subscribe");
        return new Promise<void>((resolve) => {
          notify = resolve;
        });
      },
      false,
      false,
      true,
    );
    const first = scope.call("fill", async () => {
      await Promise.all([scope.dispatched(), scope.dispatched()]);
      order.push("fill");
      await Promise.resolve();
      notify();
      return { performed: true };
    });
    const second = scope.call("click", async () => {
      await scope.dispatched();
      order.push("click");
    });
    await Promise.all([waiting, first, second]);
    await scope.check(order.join() === "subscribe,fill,click");
    await scope.finish();
    expect(scope.effectUnknown).toBe(false);
    expect(
      events.filter((event) => {
        const content = fromLogValue(event.content) as any;
        return (
          content.operation === "fill" && content.state === "dispatched-unknown"
        );
      }),
    ).toHaveLength(1);
    expect(events.map((event) => fromLogValue(event.content))).toContainEqual(
      expect.objectContaining({ operation: "check", state: "verified" }),
    );
    expect(events.map((event) => fromLogValue(event.content))).toContainEqual(
      expect.objectContaining({
        operation: "fill",
        state: "dispatched-unknown",
      }),
    );
    expect(() => scope.call("late", () => order.push("late"))).toThrow(
      "expired",
    );
  });
  it("distinguishes rejected preconditions from uncertain dispatched effects and prevents queued late effects", async () => {
    const { logger, events } = log();
    const controller = new AbortController();
    const scope = new ProgramScope(controller.signal, "job", context, logger);
    await expect(
      scope.call("precondition", () => {
        throw new Error("strict match");
      }),
    ).rejects.toThrow("strict match");
    expect(scope.effectUnknown).toBe(false);
    let release!: () => void;
    const late = vi.fn();
    const first = scope.call("click", async () => {
      await scope.dispatched();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      scope.guard();
    });
    const queued = scope.call("late", late);
    const failure = expect(first).rejects.toBeDefined();
    const queuedFailure = expect(queued).rejects.toBeDefined();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    controller.abort(new DOMException("cancel", "AbortError"));
    scope.revoke();
    release();
    await Promise.all([failure, queuedFailure]);
    expect(late).not.toHaveBeenCalled();
    expect(scope.effectUnknown).toBe(true);
    expect(events.map((event) => fromLogValue(event.content))).toContainEqual(
      expect.objectContaining({
        operation: "precondition",
        state: "not-dispatched",
      }),
    );
  });
});
