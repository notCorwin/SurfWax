export async function guardActivePage(signal: AbortSignal): Promise<() => void> {
  if (signal.aborted) return () => undefined;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || signal.aborted) return () => undefined;

  const port = chrome.runtime.connect({ name: "surf-wax-page-guard" });
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let connected = true;
  let released = false;
  const pending = new Map<string, (value: { error?: string }) => void>();
  const bridge = {
    mark: (tabId: number) => new Promise<void>((resolve) => {
      if (!connected || signal.aborted || !Number.isInteger(tabId)) return resolve();
      const id = crypto.randomUUID();
      pending.set(id, ({ error }) => {
        if (error) console.warn(`Surf Wax: ${error}`);
        resolve();
      });
      try { port.postMessage({ id, tabId }); }
      catch { pending.delete(id); resolve(); }
    }),
  };
  (globalThis as Record<string, unknown>).__surfWaxGuard = bridge;
  const release = () => {
    if (released) return;
    released = true;
    if (heartbeat) clearInterval(heartbeat);
    connected = false;
    const debuggerBridge = (globalThis as Record<string, any>).__surfWaxDebugger;
    void debuggerBridge?.call?.("endPointerGestures", []).catch(() => undefined);
    if ((globalThis as Record<string, unknown>).__surfWaxGuard === bridge) delete (globalThis as Record<string, unknown>).__surfWaxGuard;
    for (const done of pending.values()) done({});
    pending.clear();
    port.disconnect();
  };
  signal.addEventListener("abort", release, { once: true });
  port.onMessage.addListener((message: { id?: string; error?: string }) => {
    if (!message.id) return;
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });
  port.onDisconnect.addListener(() => {
    connected = false;
    if (heartbeat) clearInterval(heartbeat);
    for (const done of pending.values()) done({});
    pending.clear();
  });
  try { await bridge.mark(tab.id); }
  catch (error) {
    signal.removeEventListener("abort", release);
    release();
    throw error;
  }
  if (signal.aborted) release();
  else if (connected) heartbeat = setInterval(() => { try { port.postMessage({ ping: true }); } catch { release(); } }, 20_000);
  return () => {
    signal.removeEventListener("abort", release);
    release();
  };
}
