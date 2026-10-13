import { usePanelState } from "@/sidepanel/runtime-view";
import { useEffect, useState } from "react";
import { activeRunIdentity, type RunIdentity } from "../agent/coordinator";

export function useRunState() {
  const localRunning = usePanelState((state) => state.thread.isRunning);
  const [owner, setOwner] = useState<RunIdentity>();
  useEffect(() => {
    let active = true;
    let revision = 0;
    const changed = (message: { type?: string; identity?: RunIdentity | null }) => {
      if (message.type !== "surf-wax:run-state") return;
      revision += 1;
      setOwner(message.identity ?? undefined);
    };
    chrome.runtime.onMessage.addListener(changed);
    const requestedAt = revision;
    void activeRunIdentity().then((identity) => { if (active && requestedAt === revision) setOwner(identity); }).catch(() => undefined);
    return () => { active = false; chrome.runtime.onMessage.removeListener(changed); };
  }, []);
  return { owner, localRunning, locked: localRunning || Boolean(owner) };
}
