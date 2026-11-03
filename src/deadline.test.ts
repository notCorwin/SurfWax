import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeadline, scheduleDeadline } from "./deadline";

describe("scheduleDeadline", () => {
  afterEach(() => vi.useRealTimers());

  it("waits through a 32-bit timer boundary before firing", () => {
    vi.useFakeTimers();
    const done = vi.fn();
    scheduleDeadline(2_147_483_647 + 123, done);
    vi.advanceTimersByTime(2_147_483_647);
    expect(done).not.toHaveBeenCalled();
    vi.advanceTimersByTime(122);
    expect(done).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(done).toHaveBeenCalledOnce();
  });

  it("fires ordinary deadlines once and cancels either timer segment", () => {
    vi.useFakeTimers();
    const done = vi.fn();
    scheduleDeadline(50, done);
    vi.advanceTimersByTime(50);
    expect(done).toHaveBeenCalledOnce();
    const cancelFirst = scheduleDeadline(2_147_483_647 + 50, done);
    cancelFirst();
    vi.advanceTimersByTime(2_147_483_647 + 50);
    expect(done).toHaveBeenCalledOnce();
    const cancelSecond = scheduleDeadline(2_147_483_647 + 50, done);
    vi.advanceTimersByTime(2_147_483_647);
    cancelSecond();
    vi.advanceTimersByTime(50);
    expect(done).toHaveBeenCalledOnce();
  });

  it("does not shorten a deadline when the wall clock changes", () => {
    vi.useFakeTimers();
    const done = vi.fn();
    scheduleDeadline(50, done);
    vi.setSystemTime(Date.now() + 60_000);
    vi.advanceTimersByTime(49);
    expect(done).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(done).toHaveBeenCalledOnce();
  });
});

describe("operation deadlines", () => {
  afterEach(() => vi.useRealTimers());
  it("bounds a promise that never settles and exposes cancellation to its owner", async () => {
    vi.useFakeTimers();
    const deadline = createDeadline(50, undefined, "Tool test");
    const pending = deadline.wait(new Promise<never>(() => {}));
    const failed = expect(pending).rejects.toMatchObject({ name: "TimeoutError", message: "Tool test timed out after 50ms" });
    await vi.advanceTimersByTimeAsync(50);
    await failed;
    expect(deadline.signal.aborted).toBe(true);
    deadline.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("forwards parent cancellation and releases its abort listener after completion", async () => {
    const parent = new AbortController();
    const deadline = createDeadline(1000, parent.signal);
    expect(await deadline.wait(Promise.resolve(42))).toBe(42);
    parent.abort(new DOMException("Stopped", "AbortError"));
    await expect(deadline.wait(Promise.resolve(43))).rejects.toMatchObject({ name: "AbortError", message: "Stopped" });
    deadline.dispose();
  });
});
