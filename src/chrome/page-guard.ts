export async function guardActivePage(signal: AbortSignal): Promise<() => void> {
  if (signal.aborted) return () => undefined;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || signal.aborted) return () => undefined;

  const port = chrome.runtime.connect({ name: "surf-wax-page-guard" });
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let connected = true;
  const release = () => {
    if (heartbeat) clearInterval(heartbeat);
    port.disconnect();
  };
  signal.addEventListener("abort", release, { once: true });
  const ready = new Promise<void>((resolve) => {
    port.onMessage.addListener(() => resolve());
    port.onDisconnect.addListener(() => {
      connected = false;
      if (heartbeat) clearInterval(heartbeat);
      resolve();
    });
  });
  try { port.postMessage({ tabId: tab.id }); }
  catch (error) {
    signal.removeEventListener("abort", release);
    release();
    throw error;
  }
  await ready;
  if (signal.aborted) release();
  else if (connected) heartbeat = setInterval(() => port.postMessage({ ping: true }), 20_000);
  return () => {
    signal.removeEventListener("abort", release);
    release();
  };
}
