import { EventLogger } from "./logging";
import { restoreUserScripts } from "./userscripts/persistence";

const eventLogger = new EventLogger();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "surf-wax-debugger") return;
  const sessions = new Map<string, chrome.debugger.Debuggee>();
  let closed = false;
  const key = (debuggee: chrome.debugger.Debuggee) => debuggee.targetId
    ? `target:${debuggee.targetId}` : debuggee.tabId !== undefined ? `tab:${debuggee.tabId}` : `extension:${debuggee.extensionId}`;
  const onEvent = (source: chrome.debugger.Debuggee, method: string, params?: object) => {
    if (!closed && sessions.has(key(source))) port.postMessage({ event: "onEvent", args: [source, method, params] });
  };
  const onDetach = (source: chrome.debugger.Debuggee, reason: string) => {
    if (!sessions.delete(key(source))) return;
    if (!closed) port.postMessage({ event: "onDetach", args: [source, reason] });
  };
  chrome.debugger.onEvent.addListener(onEvent);
  chrome.debugger.onDetach.addListener(onDetach);
  port.onMessage.addListener(async (message: { id: string; method: string; args: any[] }) => {
    const { id, method, args } = message;
    try {
      let result: unknown;
      if (method === "attach") {
        await chrome.debugger.attach(args[0], args[1]);
        if (closed) await chrome.debugger.detach(args[0]);
        else sessions.set(key(args[0]), args[0]);
      } else if (method === "detach") {
        await chrome.debugger.detach(args[0]);
        sessions.delete(key(args[0]));
      } else {
        const native = (chrome.debugger as unknown as Record<string, (...params: any[]) => Promise<unknown>>)[method];
        if (typeof native !== "function") throw new Error(`Unknown chrome.debugger method: ${method}`);
        result = await native.apply(chrome.debugger, args);
      }
      if (!closed) port.postMessage({ id, result });
    } catch (error) {
      if (!closed) port.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
    }
  });
  port.onDisconnect.addListener(() => {
    closed = true;
    chrome.debugger.onEvent.removeListener(onEvent);
    chrome.debugger.onDetach.removeListener(onDetach);
    for (const debuggee of sessions.values()) void chrome.debugger.detach(debuggee).catch(() => undefined);
    sessions.clear();
  });
});

function restore(): void {
  void restoreUserScripts({ logger: eventLogger }).catch((error) => {
    eventLogger.record({ type: "userscript.restore-failed", content: null, error });
  });
}

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  restore();
});

chrome.runtime.onStartup.addListener(() => restore());
void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
