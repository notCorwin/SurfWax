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
/** Command controls select stable values; token updates render only through the frame projection. */
export function usePanelState<T>(select: (state: PanelState) => T): T {
  const runtime = usePanelRuntime();
  return useSyncExternalStore(runtime.subscribe, () => select(runtime.getState()));
}
