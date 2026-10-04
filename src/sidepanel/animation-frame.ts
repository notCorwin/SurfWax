import { flushSync } from "react-dom";

/** Share one browser frame and one React commit across response/scroll/UI work. */
export function batchAnimationFrames(scope: Pick<typeof globalThis, "requestAnimationFrame" | "cancelAnimationFrame">,
  batch: (work: () => void) => void = flushSync) {
  const nativeFrame = scope.requestAnimationFrame.bind(scope);
  const nativeCancel = scope.cancelAnimationFrame.bind(scope);
  let nextId = 0;
  let pending: number | undefined;
  const callbacks = new Map<number, FrameRequestCallback>();
  let current = new Map<number, FrameRequestCallback>();
  scope.requestAnimationFrame = (callback) => {
    const id = ++nextId;
    callbacks.set(id, callback);
    if (pending === undefined) pending = nativeFrame((now) => {
      pending = undefined;
      current = new Map(callbacks);
      callbacks.clear();
      batch(() => {
        for (const [id, callback] of current) {
          current.delete(id);
          try { callback(now); } catch (error) { globalThis.reportError(error); }
        }
      });
    });
    return id;
  };
  scope.cancelAnimationFrame = (id) => {
    callbacks.delete(id);
    current.delete(id);
    if (!callbacks.size && pending !== undefined) { nativeCancel(pending); pending = undefined; }
  };
}
