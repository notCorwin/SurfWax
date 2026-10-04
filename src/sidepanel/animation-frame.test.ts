import { expect, it, vi } from "vitest";
import { batchAnimationFrames } from "./animation-frame";

it("batches UI work in one native frame and preserves cancellation inside that frame", () => {
  const native: FrameRequestCallback[] = [];
  const scope = { requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => { native.push(callback); return native.length; }), cancelAnimationFrame: vi.fn() };
  const request = scope.requestAnimationFrame;
  const batch = vi.fn((work: () => void) => work());
  batchAnimationFrames(scope, batch);
  const first = vi.fn(() => { scope.cancelAnimationFrame(cancelled); scope.requestAnimationFrame(later); });
  const never = vi.fn(), later = vi.fn(), last = vi.fn();
  scope.requestAnimationFrame(first);
  const cancelled = scope.requestAnimationFrame(never);
  scope.requestAnimationFrame(last);
  expect(request).toHaveBeenCalledOnce();
  native[0]!(8.33);
  expect(batch).toHaveBeenCalledOnce();
  expect(first).toHaveBeenCalledWith(8.33); expect(last).toHaveBeenCalledWith(8.33);
  expect(never).not.toHaveBeenCalled(); expect(later).not.toHaveBeenCalled();
  native[1]!(16.66); expect(later).toHaveBeenCalledWith(16.66);
});
