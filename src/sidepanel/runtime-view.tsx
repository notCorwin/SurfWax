import type { AssistantRuntime, MessageRuntime, ThreadRuntime } from "@assistant-ui/react";
import { createContext, useContext } from "react";

export type MessageView = ReturnType<MessageRuntime["getState"]> & {
  readonly parts: readonly ReturnType<ReturnType<MessageRuntime["getMessagePartByIndex"]>["getState"]>[];
};

/** Read immutable messages lazily, without subscribing a client for every historic part. */
export function createThreadView(thread: ThreadRuntime) {
  let previous: ReturnType<ThreadRuntime["getState"]> | undefined;
  let snapshot: (Omit<ReturnType<ThreadRuntime["getState"]>, "messages"> & { messages: readonly MessageView[] }) | undefined;
  let cache = new WeakMap<object, MessageView>();
  return {
    thread,
    getState() {
      const state = thread.getState();
      if (state === previous) return snapshot!;
      // Branch metadata can change while immutable message bodies stay the same.
      // Re-read it once after a run or an idle edit/branch selection.
      if (!state.isRunning && state.messages !== previous?.messages) cache = new WeakMap();
      const messages = state.messages === previous?.messages ? snapshot!.messages : state.messages.map((message, index) => {
        const cached = cache.get(message);
        const isLast = index === state.messages.length - 1;
        if (cached && cached.index === index && cached.isLast === isLast) return cached;
        const runtime = thread.getMessageByIndex(index);
        const view = { ...runtime.getState(), parts: message.content.map((_, part) => runtime.getMessagePartByIndex(part).getState()) };
        cache.set(message, view);
        return view;
      });
      previous = state;
      snapshot = { ...state, messages };
      return snapshot;
    },
  };
}

export type RuntimeView = ReturnType<typeof createThreadView> & { assistant: AssistantRuntime };
export const RuntimeViewContext = createContext<RuntimeView | undefined>(undefined);
export function useRuntimeView() {
  const view = useContext(RuntimeViewContext);
  if (!view) throw new Error("Runtime view is unavailable");
  return view;
}

/**
 * AUI still owns conversations, composers, branches and its canonical log adapter.
 * Its default store eagerly subscribes every message/part, even outside the
 * virtual viewport. Give that store only command/composer state; our disposable
 * frame projection reads the complete, unchanged runtime for the transcript.
 */
export function commandRuntime(runtime: AssistantRuntime): AssistantRuntime {
  const empty: ReturnType<ThreadRuntime["getState"]>["messages"] = [];
  let previous: ReturnType<ThreadRuntime["getState"]> | undefined;
  let snapshot: ReturnType<ThreadRuntime["getState"]>;
  const getState = () => {
    const state = runtime.thread.getState();
    if (state !== previous) {
      // Chat helpers in extras also carry the full changing message array.
      // They remain available on the raw runtime; visual command clients need
      // only flags, metadata and commands, whose identity stays stable here.
      if (!snapshot || Object.keys(state).some((key) => key !== "messages" && key !== "extras"
        && !Object.is(state[key as keyof typeof state], snapshot[key as keyof typeof state]))) {
        snapshot = { ...state, messages: empty, extras: undefined };
      }
      previous = state;
    }
    return snapshot;
  };
  const thread = new Proxy(runtime.thread, {
    get(target, key) {
      if (key === "getState") return getState;
      return Reflect.get(target, key, target);
    },
  });
  const threads = new Proxy(runtime.threads, {
    get(target, key) { return key === "main" ? thread : Reflect.get(target, key, target); },
  });
  return new Proxy(runtime, {
    get(target, key) { return key === "thread" ? thread : key === "threads" ? threads : Reflect.get(target, key, target); },
  });
}
