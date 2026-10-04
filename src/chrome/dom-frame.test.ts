import { afterEach, expect, it, vi } from "vitest";
import { waitForDocumentFrame } from "./dom-frame";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
it("uses a real animation frame and clears the fallback timer", async () => {
  vi.useFakeTimers();
  let callback!: FrameRequestCallback;
  vi.stubGlobal("requestAnimationFrame", vi.fn((next) => { callback = next; return 7; }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const pending = waitForDocumentFrame();
  callback(16.67); await pending;
  expect(vi.getTimerCount()).toBe(0);
  expect(cancelAnimationFrame).not.toHaveBeenCalled();
});
it("keeps actionability progressing when Chrome suspends a child frame", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 7));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const done = vi.fn();
  const pending = waitForDocumentFrame().then(done);
  await vi.advanceTimersByTimeAsync(49); expect(done).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); await pending;
  expect(done).toHaveBeenCalledOnce(); expect(cancelAnimationFrame).toHaveBeenCalledExactlyOnceWith(7);
  expect(vi.getTimerCount()).toBe(0);
});
