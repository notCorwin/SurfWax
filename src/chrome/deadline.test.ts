import { afterEach, describe, expect, it, vi } from "vitest";
import { scheduleDeadline } from "./deadline";

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
