import { createContext, useContext, useSyncExternalStore } from "react";
import type { ConversationStore, PanelState } from "./conversation-store";

export type { MessageView, PanelState } from "./conversation-store";
export type RuntimeView = { runtime: ConversationStore; thread: ConversationStore["thread"]; getState: ConversationStore["thread"]["getState"] };
export const RuntimeViewContext = createContext<RuntimeView | undefined>(undefined);
export function useRuntimeView() {
  const view = useContext(RuntimeViewContext);
  if (!view) throw new Error("Conversation view is unavailable");
  return view;
}
export function usePanelRuntime() { return useRuntimeView().runtime; }
export function useThreadState() {
  const runtime = usePanelRuntime();
  return useSyncExternalStore(runtime.thread.subscribe, runtime.thread.getState);
}
/** Select a stable value from the conversation store. */
export function usePanelState<T>(select: (state: PanelState) => T): T {
  const runtime = usePanelRuntime();
  return useSyncExternalStore(runtime.subscribe, () => select(runtime.getState()));
}
