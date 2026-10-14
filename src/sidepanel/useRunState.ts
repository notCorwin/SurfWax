import { usePanelState } from "@/sidepanel/runtime-view";
import { useEffect, useSyncExternalStore } from "react";
import { activeRunIdentity, getRunIdentity, type RunIdentity } from "../agent/coordinator";

let owner: RunIdentity | undefined;
let installed = false;
let revision = 0;
const listeners = new Set<() => void>();

function publish(next: RunIdentity | undefined) {
  if (owner?.runId === next?.runId && owner?.ownerId === next?.ownerId && owner?.generation === next?.generation) return;
  owner = next;
  for (const listener of listeners) listener();
}

function changed(message: { type?: string; identity?: RunIdentity | null }) {
  if (message.type !== "surf-wax:run-state") return;
  revision += 1;
  publish(message.identity ?? undefined);
}

async function refreshOwner() {
  const requestedAt = revision;
  const identity = await activeRunIdentity();
  if (requestedAt === revision) publish(identity);
}

function subscribeOwner(listener: () => void) {
  listeners.add(listener);
  if (!installed) {
    installed = true;
    chrome.runtime.onMessage.addListener(changed);
  }
  void refreshOwner().catch(() => undefined);
  return () => {
    listeners.delete(listener);
    if (!listeners.size && installed) {
      installed = false;
      chrome.runtime.onMessage.removeListener(changed);
    }
  };
}

export function useRunState() {
  const localRunning = usePanelState((state) => state.thread.isRunning);
  const currentOwner = useSyncExternalStore(subscribeOwner, () => owner, () => undefined);
  useEffect(() => {
    const refresh = () => void refreshOwner().catch(() => undefined);
    globalThis.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => { globalThis.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, []);
  return { owner: currentOwner, localRunning, locked: localRunning || Boolean(currentOwner),
    otherRunning: Boolean(currentOwner && !localRunning && currentOwner.runId !== getRunIdentity()?.runId) };
}
