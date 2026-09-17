import { EventLogger } from "./logging";
import { restoreUserScripts } from "./userscripts/persistence";

const eventLogger = new EventLogger();
const guardedTabs = new Map<number, Set<chrome.runtime.Port>>();

function installPageGuard(): void {
  if (document.getElementById("__surf-wax-page-guard")) return;
  const overlay = document.createElement("div");
  overlay.id = "__surf-wax-page-guard";
  overlay.setAttribute("aria-hidden", "true");
  overlay.style.cssText = "all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;background:transparent!important;pointer-events:auto!important;cursor:wait!important";
  for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick", "auxclick", "contextmenu", "touchstart", "touchend", "wheel"]) {
    overlay.addEventListener(type, (event) => {
      event.preventDefault();
      event.stopPropagation();
    }, { passive: false });
  }
  document.documentElement.appendChild(overlay);
}

function removePageGuard(): void {
  document.getElementById("__surf-wax-page-guard")?.remove();
}

async function updatePageGuard(tabId: number, enabled: boolean): Promise<void> {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, func: enabled ? installPageGuard : removePageGuard });
  } catch { /* Chrome does not allow injection into every page. */ }
  if (enabled && !guardedTabs.has(tabId)) void updatePageGuard(tabId, false);
}

chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === "complete" && guardedTabs.has(tabId)) void updatePageGuard(tabId, true);
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "surf-wax-page-guard") return;
  let tabId: number | undefined;
  port.onMessage.addListener((message: { tabId?: unknown }) => {
    if (tabId !== undefined || !Number.isInteger(message?.tabId)) return;
    tabId = message.tabId as number;
    const holders = guardedTabs.get(tabId) ?? new Set<chrome.runtime.Port>();
    holders.add(port);
    guardedTabs.set(tabId, holders);
    void updatePageGuard(tabId, true).then(() => port.postMessage({ ready: true })).catch(() => undefined);
  });
  port.onDisconnect.addListener(() => {
    if (tabId === undefined) return;
    const holders = guardedTabs.get(tabId);
    holders?.delete(port);
    if (holders?.size) return;
    guardedTabs.delete(tabId);
    void updatePageGuard(tabId, false);
  });
});

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
