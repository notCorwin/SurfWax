import { useLayoutEffect, useMemo, useState } from "react";
import { useRuntimeView } from "./runtime-view";

/** A disposable projection: the runtime and event log retain every stream update. */
export function createFrameView<T>(source: { getState(): T; subscribe(listener: () => void): () => void },
  schedule: typeof requestAnimationFrame = (callback) => requestAnimationFrame(callback),
  cancel: typeof cancelAnimationFrame = (id) => cancelAnimationFrame(id)) {
  let snapshot = source.getState();
  let frame: number | undefined;
  let unsubscribe: (() => void) | undefined;
  const listeners = new Set<() => void>();
  const changed = () => {
    if (frame !== undefined) return;
    frame = schedule(() => {
      frame = undefined;
      const next = source.getState();
      if (Object.is(snapshot, next)) return;
      snapshot = next;
      for (const listener of listeners) listener();
    });
  };
  const detach = () => {
    unsubscribe?.(); unsubscribe = undefined;
    if (frame !== undefined) cancel(frame);
    frame = undefined;
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (!unsubscribe) { snapshot = source.getState(); unsubscribe = source.subscribe(changed); }
      return () => { listeners.delete(listener); if (!listeners.size) detach(); };
    },
    dispose() { detach(); listeners.clear(); },
  };
}

export function useFrameThread() {
  const runtime = useRuntimeView();
  const view = useMemo(() => createFrameView({
    getState: () => runtime.getState(),
    subscribe: (listener) => runtime.thread.subscribe(listener),
  }), [runtime]);
  const [snapshot, setSnapshot] = useState(view.getSnapshot);
  useLayoutEffect(() => {
    const publish = () => setSnapshot(view.getSnapshot());
    const unsubscribe = view.subscribe(publish);
    publish();
    return () => { unsubscribe(); view.dispose(); };
  }, [view]);
  // This is an immutable display projection, not the canonical store. Normal
  // state updates let React batch it with the other updates in the same RAF,
  // instead of forcing a synchronous commit before those callbacks execute.
  return snapshot;
}
