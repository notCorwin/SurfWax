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
const context = { conversationId: "program-test" };
afterEach(() => vi.useRealTimers());

describe("canonical browser jobs", () => {
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
    const first: any = await jobs.query(
      { action: "wait", id, waitMs: 100, limit: 1 },
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
      await jobs.query(
        { action: "wait", id, waitMs: 100 },
        context.conversationId,
      ),
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
    const result: any = await jobs.query(
      { action: "wait", id, waitMs: 100 },
      context.conversationId,
    );
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
      await jobs.query(
        { action: "wait", id, waitMs: 100 },
        context.conversationId,
      ),
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
