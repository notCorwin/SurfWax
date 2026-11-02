import { usePanelState } from "@/sidepanel/runtime-view";
import { useEffect, useSyncExternalStore } from "react";
import { activeRunIdentity, getRunIdentity, type RunIdentity } from "../agent/coordinator";

let owner: RunIdentity | undefined;
let ownerError: unknown;
let snapshot: { owner: RunIdentity | undefined; error: unknown } = { owner, error: ownerError };
let installed = false;
let revision = 0;
const listeners = new Set<() => void>();
function notify() { snapshot = { owner, error: ownerError }; for (const listener of listeners) listener(); }

function publish(next: RunIdentity | undefined) {
  if (owner?.runId === next?.runId && owner?.ownerId === next?.ownerId && owner?.generation === next?.generation) return;
  owner = next;
  notify();
}

function changed(message: { type?: string; identity?: RunIdentity | null }) {
  if (message.type !== "surf-wax:run-state") return;
  revision += 1;
  if (ownerError !== undefined) { ownerError = undefined; notify(); }
  publish(message.identity ?? undefined);
}

async function refreshOwner() {
  const requestedAt = revision;
  try {
    const identity = await activeRunIdentity();
    if (requestedAt === revision) {
      if (ownerError !== undefined) { ownerError = undefined; notify(); }
      publish(identity);
    }
  } catch (error) {
    if (requestedAt !== revision) return;
    if (String(ownerError) !== String(error)) { ownerError = error; notify(); }
  }
}

function subscribeOwner(listener: () => void) {
  listeners.add(listener);
  if (!installed) {
    installed = true;
    chrome.runtime.onMessage.addListener(changed);
  }
  void refreshOwner();
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
  const { owner: currentOwner, error } = useSyncExternalStore(subscribeOwner, () => snapshot, () => snapshot);
  useEffect(() => {
    const refresh = () => void refreshOwner();
    globalThis.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => { globalThis.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, []);
  return { owner: currentOwner, error, localRunning, locked: localRunning || Boolean(currentOwner),
    otherRunning: Boolean(currentOwner && !localRunning && currentOwner.runId !== getRunIdentity()?.runId) };
}
