import { EventLogger } from "./logging";
import { callUserScripts, restoreUserScripts, serializeUserScripts, snapshotUserScripts, USER_SCRIPTS_ERROR_KEY } from "./userscripts/persistence";

const eventLogger = new EventLogger();
const guardedTabs = new Map<number, Set<chrome.runtime.Port>>();
const bypassedTabs = new Map<number, number>();
const guardUpdates = new Map<number, Promise<void>>();

function warnPageGuard(tabId: number, error: unknown): string {
  eventLogger.record({ type: "page-guard.failed", content: { tabId }, error });
  const detail = `标签页 ${tabId} 无法启用防点击保护；智能体仍可继续运行。`;
  void chrome.runtime.sendMessage({ type: "surf-wax:guard-warning", detail }).catch(() => undefined);
  return detail;
}

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

async function updatePageGuard(tabId: number): Promise<void> {
  const task = (guardUpdates.get(tabId) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    const enabled = guardedTabs.has(tabId) && !bypassedTabs.has(tabId);
    try {
      await chrome.scripting.executeScript({ target: { tabId }, func: enabled ? installPageGuard : removePageGuard });
    } catch (error) {
      if (enabled) throw error;
    }
  });
  guardUpdates.set(tabId, task);
  try { await task; }
  finally { if (guardUpdates.get(tabId) === task) guardUpdates.delete(tabId); }
}

async function bypassPageGuard(tabId: number, enabled: boolean): Promise<void> {
  const count = (bypassedTabs.get(tabId) ?? 0) + (enabled ? 1 : -1);
  if (count > 0) bypassedTabs.set(tabId, count);
  else bypassedTabs.delete(tabId);
  if (guardedTabs.has(tabId)) await updatePageGuard(tabId).catch(() => undefined);
}

chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === "complete" && guardedTabs.has(tabId)) void updatePageGuard(tabId).catch((error) => {
    warnPageGuard(tabId, error);
  });
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "surf-wax-page-guard") return;
  const held = new Set<number>();
  const reply = (message: object) => { try { port.postMessage(message); } catch { /* The panel has closed. */ } };
  port.onMessage.addListener((message: { tabId?: unknown; id?: string }) => {
    if (!Number.isInteger(message?.tabId)) return;
    const tabId = message.tabId as number;
    if (held.has(tabId)) {
      reply({ id: message.id, ready: true });
      return;
    }
    held.add(tabId);
    const holders = guardedTabs.get(tabId) ?? new Set<chrome.runtime.Port>();
    holders.add(port);
    guardedTabs.set(tabId, holders);
    void updatePageGuard(tabId).then(
      () => reply({ id: message.id, ready: true }),
      (error) => {
        reply({ id: message.id, error: warnPageGuard(tabId, error) });
      },
    );
  });
  port.onDisconnect.addListener(() => {
    for (const tabId of held) {
      const holders = guardedTabs.get(tabId);
      holders?.delete(port);
      if (holders?.size) continue;
      guardedTabs.delete(tabId);
      void updatePageGuard(tabId);
    }
  });
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "surf-wax-debugger") return;
  const sessions = new Map<string, chrome.debugger.Debuggee>();
  const pointerGestures = new Set<number>();
  const gestureTimers = new Map<number, ReturnType<typeof setTimeout>>();
  const endGesture = async (tabId: number) => {
    if (!pointerGestures.delete(tabId)) return;
    clearTimeout(gestureTimers.get(tabId));
    gestureTimers.delete(tabId);
    await bypassPageGuard(tabId, false).catch(() => undefined);
  };
  const keepGesture = (tabId: number) => {
    clearTimeout(gestureTimers.get(tabId));
    gestureTimers.set(tabId, setTimeout(() => void endGesture(tabId), 10_000));
  };
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
      } else if (method === "userScripts") {
        result = await callUserScripts(args[0], args.slice(1), { logger: eventLogger });
      } else if (method === "restoreUserScripts") {
        result = await restoreQueued();
      } else if (method === "snapshotUserScripts") {
        result = await serializeUserScripts(() => snapshotUserScripts({ logger: eventLogger }));
      } else if (method === "endPointerGestures") {
        await Promise.all([...pointerGestures].map((tabId) => endGesture(tabId)));
      } else {
        const native = (chrome.debugger as unknown as Record<string, (...params: any[]) => Promise<unknown>>)[method];
        if (typeof native !== "function") throw new Error(`Unknown chrome.debugger method: ${method}`);
        const debuggee = args[0] as chrome.debugger.Debuggee;
        const target = debuggee?.targetId ? (await chrome.debugger.getTargets()).find((item) => item.id === debuggee.targetId) : undefined;
        const tabId = debuggee?.tabId ?? target?.tabId;
        const command = args[1] as string;
        const input = method === "sendCommand" && ["Input.dispatchMouseEvent", "Input.dispatchTouchEvent", "Input.dispatchDragEvent", "Input.emulateTouchFromMouseEvent"].includes(command) && Number.isInteger(tabId);
        const type = (args[2] as { type?: string } | undefined)?.type;
        const start = input && (type === "mousePressed" || type === "touchStart");
        const end = input && (type === "mouseReleased" || type === "touchEnd" || type === "touchCancel");
        const temporary = input && !start && !end && !pointerGestures.has(tabId!);
        if ((start && !pointerGestures.has(tabId!)) || temporary) {
          await bypassPageGuard(tabId!, true);
          if (start) pointerGestures.add(tabId!);
        }
        if (input && pointerGestures.has(tabId!)) keepGesture(tabId!);
        let succeeded = false;
        try {
          result = await native.apply(chrome.debugger, args);
          succeeded = true;
        } finally {
          if (temporary) await bypassPageGuard(tabId!, false).catch(() => undefined);
          if (input && (end || (start && !succeeded))) await endGesture(tabId!);
        }
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
    for (const tabId of pointerGestures) void endGesture(tabId);
    sessions.clear();
  });
});

function restore(): void {
  void restoreQueued().catch(() => undefined);
}

async function restoreQueued(): Promise<boolean> {
  try {
    const restored = await serializeUserScripts(() => restoreUserScripts({ logger: eventLogger }));
    if (restored) await chrome.storage.local.remove(USER_SCRIPTS_ERROR_KEY);
    return restored;
  } catch (error) {
    eventLogger.record({ type: "userscript.restore-failed", content: null, error });
    await chrome.storage.local.set({ [USER_SCRIPTS_ERROR_KEY]: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

chrome.runtime.onMessage.addListener((message: { type?: string; method?: string; args?: unknown[] }, _sender, respond) => {
  if (message?.type !== "surf-wax:user-scripts") return false;
  const task = message.method === "restore" ? restoreQueued() : callUserScripts(message.method ?? "", message.args ?? [], { logger: eventLogger });
  void task.then(
    (result) => respond({ ok: true, result }),
    (error) => respond({ ok: false, error: error instanceof Error ? error.message : String(error) }),
  );
  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  restore();
});

chrome.runtime.onStartup.addListener(() => restore());
void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
