import { EventLogger, fromLogValue } from "./logging";
import { BackgroundRunCoordinator } from "./agent/background-coordinator";
import type { RunIdentity } from "./agent/coordinator";
import { recoverBrowserInput } from "./chrome/input-recovery";
import { requireDebuggee } from "./chrome/debuggee";
import { callUserScripts, restoreUserScripts, serializeUserScripts, USER_SCRIPTS_ERROR_KEY } from "./userscripts/persistence";

const eventLogger = new EventLogger();
const runs = new BackgroundRunCoordinator();
runs.maintenance = true;
const writers = new Set<chrome.runtime.Port>();
const operations = new Set<Promise<unknown>>();
const ownerCleanups = new Map<string, Set<() => Promise<void>>>();
let maintenanceGeneration = 0;
// A worker restart loses transient owners and ports. Reconcile their durable
// calls and remove guards left in documents before accepting another owner.
const bootReady = (async () => {
  const tabs = await chrome.tabs.query({});
  await Promise.allSettled(tabs.filter((tab) => tab.id !== undefined).map((tab) =>
    chrome.scripting.executeScript({ target: { tabId: tab.id!, allFrames: true }, func: removePageGuard })));
  const inputEvents = await eventLogger.inputStateEvents();
  // A conversation terminal precedes input cleanup. Recover its input too if
  // the worker stopped between those writes, using the latest canonical state.
  const inputRunIds = [...new Set(inputEvents.flatMap((event) => event.runId ? [event.runId] : []))];
  const inputRecovery = await recoverBrowserInput(inputEvents, inputRunIds, chrome.debugger);
  const latestInput = new Map<string, { runId: string; state: { tabId: number; debuggee: chrome.debugger.Debuggee & { sessionId?: string }; keys?: unknown[]; buttons?: unknown[] } }>();
  for (const event of inputEvents) {
    const state = fromLogValue(event.content) as { tabId: number; debuggee: chrome.debugger.Debuggee & { sessionId?: string }; keys?: unknown[]; buttons?: unknown[] } | null;
    if (!event.runId || !state || !Number.isInteger(state.tabId) || !state.debuggee) continue;
    latestInput.set(JSON.stringify([event.runId, state.tabId, state.debuggee.sessionId]), { runId: event.runId, state });
  }
  const failedTabs = new Set(inputRecovery.failures.map((failure) => failure.tabId));
  for (const { runId, state } of latestInput.values()) {
    if (failedTabs.has(state.tabId) || !(state.keys?.length || state.buttons?.length)) continue;
    await eventLogger.append({ type: "browser.input.state", runId, content: { ...state, keys: [], buttons: [] } });
  }
  if (inputRecovery.recovered || inputRecovery.failures.length) await eventLogger.append({ type: "browser.input.recovered", output: inputRecovery });
  await eventLogger.recoverDanglingRuns([], "worker-restarted");
})().finally(() => { runs.maintenance = false; });
function broadcastRunState(): void {
  void chrome.runtime.sendMessage({ type: "surf-wax:run-state", identity: runs.identity() ?? null }).catch(() => undefined);
}
function track<T>(task: Promise<T>): Promise<T> {
  operations.add(task);
  void task.finally(() => operations.delete(task)).catch(() => undefined);
  return task;
}
function savedInputNeeded(state: { buttons: Map<string, unknown> }, type: unknown): boolean {
  return state.buttons.size > 0 || type === "mousePressed" || type === "mouseReleased";
}
function writerBarrier(port: chrome.runtime.Port): Promise<void> {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const timeout = setTimeout(() => finish(new Error("日志写入方未响应维护请求。")), 10_000);
    const finish = (error?: unknown) => { clearTimeout(timeout); port.onMessage.removeListener(reply); port.onDisconnect.removeListener(disconnect); error ? reject(error) : resolve(); };
    const reply = (message: { id?: string; ok?: boolean; error?: string }) => { if (message.id === id) finish(message.ok ? undefined : new Error(message.error)); };
    const disconnect = () => finish();
    port.onMessage.addListener(reply); port.onDisconnect.addListener(disconnect);
    try { port.postMessage({ type: "prepare-clear", id, generation: maintenanceGeneration }); } catch { finish(); }
  });
}
let clearing: Promise<void> | undefined;
async function clearEventLog(): Promise<void> {
  runs.maintenance = true;
  maintenanceGeneration += 1;
  runs.cancel(undefined, "log-cleared");
  try {
    await Promise.all([...writers].map(writerBarrier));
    await Promise.allSettled([...operations]);
    await Promise.allSettled([...guardUpdates.values()]);
    await serializeUserScripts(async () => undefined);
    eventLogger.stop();
    await eventLogger.flush();
    await eventLogger.clear();
    for (const writer of writers) { try { writer.postMessage({ type: "clear-complete" }); } catch { /* closed */ } }
  } catch (error) {
    for (const writer of writers) { try { writer.postMessage({ type: "clear-failed" }); } catch { /* closed */ } }
    throw error;
  } finally { eventLogger.resume(); runs.maintenance = false; }
}
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "surf-wax-log-writer") {
    writers.add(port);
    void bootReady.then(() => {
      if (writers.has(port)) port.postMessage({ type: "writer-ready", paused: runs.maintenance, generation: maintenanceGeneration });
    }).catch((error) => {
      if (writers.has(port)) { try { port.postMessage({ type: "writer-error", error: `后台初始化失败，请重新加载扩展后重试：${error instanceof Error ? error.message : String(error)}` }); } catch { /* Writer closed. */ } }
      console.error(error);
    });
    port.onDisconnect.addListener(() => writers.delete(port));
    return;
  }
  if (port.name !== "surf-wax-run-owner") return;
  let connected = true;
  port.onMessage.addListener((message) => {
    if (message.type === "claim") {
      void bootReady.then(() => {
        if (!connected) return;
        try { port.postMessage({ type: "claimed", ...runs.claim(port, message) }); broadcastRunState(); }
        catch (error) { port.postMessage({ type: "claimed", error: String(error) }); }
      }).catch((error) => { if (connected) { try { port.postMessage({ type: "claimed", error: `后台初始化失败：${error instanceof Error ? error.message : String(error)}` }); } catch { /* Owner closed. */ } } });
    }
    if (message.type === "cancelled") runs.cancel(port, "user-interrupted");
    if (message.type === "finished") { const released = runs.release(port); if (released) { ownerCleanups.delete(released.runId); broadcastRunState(); } }
  });
  port.onDisconnect.addListener(() => {
    connected = false;
    const identity = runs.identity();
    if (!identity || !runs.owns(port)) return;
    runs.cancel(port, "owner-disconnected");
    void track((async () => {
      await Promise.allSettled([...(ownerCleanups.get(identity.runId) ?? [])].map((cleanup) => cleanup()));
      ownerCleanups.delete(identity.runId);
      const owner = runs.release(port);
      if (!owner) return;
      broadcastRunState();
      await eventLogger.closePendingTools(owner.runId, owner.conversationId, "owner-disconnected");
      await eventLogger.recoverDanglingRuns(async () => runs.identity() ? [runs.identity()!.runId] : []);
    })()).catch(console.error);
  });
});
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return;
  if (message?.type === "surf-wax:run-status") { void bootReady.then(() => respond({ identity: runs.identity() }), (error) => respond({ error: String(error) })); return true; }
  if (message?.type !== "side-agent:clear-log") return;
  clearing ??= bootReady.then(clearEventLog).finally(() => { clearing = undefined; });
  void clearing.then(() => respond({ ok: true }), (error) => respond({ ok: false, error: String(error) }));
  return true;
});
const guardedTabs = new Map<number, Set<chrome.runtime.Port>>();
const bypassedTabs = new Map<number, number>();
const guardUpdates = new Map<number, Promise<void>>();

function warnPageGuard(tabId: number, error: unknown): string {
  eventLogger.record({ type: "page-guard.failed", content: { tabId }, error });
  const detail = `标签页 ${tabId} 无法启用防点击保护；智能体仍可继续运行。`;
  void chrome.runtime.sendMessage({ type: "surf-wax:guard-warning", tabId }).catch(() => undefined);
  return detail;
}

function installPageGuard(): void {
  const key = "__surfWaxBlocker";
  if ((globalThis as Record<string, unknown>)[key]) return;
  const overlay = document.createElement("div");
  overlay.id = "__surf-wax-page-guard";
  overlay.setAttribute("aria-hidden", "true");
  overlay.style.cssText = "all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;background:transparent!important;pointer-events:auto!important;cursor:wait!important";
  const types = ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick", "auxclick", "contextmenu", "touchstart", "touchend", "wheel", "keydown", "keyup", "keypress", "beforeinput", "input", "paste", "cut", "drop", "dragstart"];
  const block = (event: Event) => { if (event.isTrusted) { event.preventDefault(); event.stopImmediatePropagation(); } };
  for (const type of types) document.addEventListener(type, block, { capture: true, passive: false });
  (globalThis as Record<string, unknown>)[key] = () => { for (const type of types) document.removeEventListener(type, block, true); overlay.remove(); delete (globalThis as Record<string, unknown>)[key]; };
  document.documentElement.appendChild(overlay);
}
function removePageGuard(): void {
  ((globalThis as Record<string, unknown>).__surfWaxBlocker as (() => void) | undefined)?.();
  document.getElementById("__surf-wax-page-guard")?.remove();
}

async function updatePageGuard(tabId: number): Promise<void> {
  const task = (guardUpdates.get(tabId) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    const enabled = guardedTabs.has(tabId) && !bypassedTabs.has(tabId);
    try {
      await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: enabled ? installPageGuard : removePageGuard });
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
  port.onMessage.addListener((message: { tabId?: unknown; id?: string } & Partial<RunIdentity>) => {
    if (message.tabId !== undefined) { try { runs.validate(message as RunIdentity); } catch { reply({ id: message.id, error: "运行所有权已失效。" }); return; } }
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
  const heldInput = new Map<string, { debuggee: chrome.debugger.Debuggee; tabId?: number; runId?: string; x: number; y: number; keys: Map<string, Record<string, any>>; buttons: Map<string, Record<string, any>> }>();
  let validatedRunId: string | undefined;
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
  const inputReleases = new Map<string, Promise<void>>();
  function releaseHeldInput(inputKey: string): Promise<void> {
    const pending = inputReleases.get(inputKey);
    if (pending) return pending;
    const state = heldInput.get(inputKey);
    if (!state) return Promise.resolve();
    const task = (async () => {
      const failures: string[] = [];
      if (state.tabId !== undefined) await bypassPageGuard(state.tabId, true);
      try {
        for (const [heldKey, params] of [...state.keys]) {
          try { await chrome.debugger.sendCommand(state.debuggee, "Input.dispatchKeyEvent", { ...params, text: undefined, unmodifiedText: undefined, type: "keyUp", modifiers: 0 }); state.keys.delete(heldKey); }
          catch (error) { failures.push(String(error)); }
        }
        for (const [button, params] of [...state.buttons]) {
          try { await chrome.debugger.sendCommand(state.debuggee, "Input.dispatchMouseEvent", { ...params, type: "mouseReleased", x: state.x, y: state.y, button, buttons: 0, modifiers: 0 }); state.buttons.delete(button); }
          catch (error) { failures.push(String(error)); }
        }
        await chrome.debugger.sendCommand(state.debuggee, "Input.cancelDragging", {}).catch((error) => { failures.push(String(error)); });
        if (state.runId) {
          await eventLogger.append({ type: "browser.input.state", runId: state.runId,
            content: { tabId: state.tabId, debuggee: state.debuggee, x: state.x, y: state.y, keys: [...state.keys.values()], buttons: [...state.buttons] } });
          if (failures.length) await eventLogger.append({ type: "browser.input.release-failed", runId: state.runId, content: { tabId: state.tabId, debuggee: state.debuggee }, error: failures });
        }
      } finally {
        heldInput.delete(inputKey);
        if (state.tabId !== undefined) await bypassPageGuard(state.tabId, false);
      }
    })();
    inputReleases.set(inputKey, task);
    void task.finally(() => { if (inputReleases.get(inputKey) === task) inputReleases.delete(inputKey); }).catch(() => undefined);
    return task;
  }
  const onEvent = (source: chrome.debugger.Debuggee, method: string, params?: object) => {
    if (!closed && sessions.has(key(source))) port.postMessage({ event: "onEvent", args: [source, method, params] });
  };
  const onDetach = (source: chrome.debugger.Debuggee, reason: string) => {
    if (!sessions.delete(key(source))) return;
    if (!closed) port.postMessage({ event: "onDetach", args: [source, reason] });
  };
  chrome.debugger.onEvent.addListener(onEvent);
  chrome.debugger.onDetach.addListener(onDetach);
  port.onMessage.addListener((message: { id: string; method: string; args: any[]; operationId?: string } & Partial<RunIdentity>) => {
    void track((async () => {
    const { id, method, args } = message;
    try {
      let result: unknown;
      const command = args[1];
      const params = args[2];
      const cleanup = method === "detach" || method === "endPointerGestures" || method === "sendCommand" &&
        (["Network.disable", "Log.disable", "Input.cancelDragging", "Runtime.releaseObjectGroup"].includes(command) ||
         command === "Page.setInterceptFileChooserDialog" && params?.enabled === false ||
         command === "Input.dispatchKeyEvent" && params?.type === "keyUp" ||
         command === "Input.dispatchMouseEvent" && params?.type === "mouseReleased");
      if (!cleanup) {
        runs.validate(message as RunIdentity, message.operationId);
        validatedRunId = message.runId!;
        const cleanups = ownerCleanups.get(message.runId!) ?? new Set<() => Promise<void>>();
        cleanups.add(cleanupPort); ownerCleanups.set(message.runId!, cleanups);
      }
      if (closed && !cleanup) throw new DOMException("Side Panel 已关闭", "AbortError");
      if (method === "attach") {
        requireDebuggee(args[0], method);
        if (!sessions.has(key(args[0]))) await chrome.debugger.attach(args[0], args[1]);
        try { if (closed) throw new DOMException("Side Panel 已关闭", "AbortError"); runs.validate(message as RunIdentity); }
        catch (error) { await chrome.debugger.detach(args[0]).catch(() => undefined); throw error; }
        sessions.set(key(args[0]), args[0]);
      } else if (method === "detach") {
        requireDebuggee(args[0], method);
        await Promise.all([...heldInput].filter(([, state]) => key(state.debuggee) === key(args[0])).map(([inputKey]) => releaseHeldInput(inputKey)));
        await chrome.debugger.detach(args[0]);
        sessions.delete(key(args[0]));
      } else if (method === "endPointerGestures") {
        await Promise.all([...pointerGestures].map((tabId) => endGesture(tabId)));
      } else {
        const native = (chrome.debugger as unknown as Record<string, (...params: any[]) => Promise<unknown>>)[method];
        if (typeof native !== "function") throw new Error(`Unknown chrome.debugger method: ${method}`);
        if (method !== "getTargets") requireDebuggee(args[0], method);
        const debuggee = args[0] as chrome.debugger.Debuggee;
        const target = debuggee?.targetId ? (await chrome.debugger.getTargets()).find((item) => item.id === debuggee.targetId) : undefined;
        const tabId = debuggee?.tabId ?? target?.tabId;
        const command = args[1] as string;
        const input = method === "sendCommand" && ["Input.dispatchMouseEvent", "Input.dispatchTouchEvent", "Input.dispatchDragEvent", "Input.emulateTouchFromMouseEvent", "Input.dispatchKeyEvent", "Input.insertText"].includes(command) && Number.isInteger(tabId);
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
        let persistedInput: (() => Promise<unknown>) | undefined;
        try {
          if (!cleanup) { if (closed) throw new DOMException("Side Panel 已关闭", "AbortError"); runs.validate(message as RunIdentity); }
          if (input && ["Input.dispatchKeyEvent", "Input.dispatchMouseEvent"].includes(command)) {
            const inputKey = JSON.stringify(debuggee);
            let state = heldInput.get(inputKey);
            if (!state) { state = { debuggee, tabId, runId: message.runId ?? validatedRunId, x: 0, y: 0, keys: new Map(), buttons: new Map() }; heldInput.set(inputKey, state); }
            else if (!state.keys.size && !state.buttons.size && message.runId) state.runId = message.runId;
            const params = args[2] ?? {};
            const beforeKeys = new Map(state.keys);
            const beforeButtons = new Map(state.buttons);
            if (Number.isFinite(params.x)) state.x = params.x;
            if (Number.isFinite(params.y)) state.y = params.y;
            if (command === "Input.dispatchKeyEvent") { if (type === "keyUp") state.keys.delete(params.key); else state.keys.set(params.key, { ...params }); }
            if (command === "Input.dispatchMouseEvent") { if (type === "mousePressed") state.buttons.set(params.button ?? "left", { ...params }); else if (type === "mouseReleased") state.buttons.delete(params.button ?? "left"); }
            if (state.runId && (command === "Input.dispatchKeyEvent" || savedInputNeeded(state, type))) {
              const saved = state;
              const record = (keys: Map<string, Record<string, any>>, buttons: Map<string, Record<string, any>>) => eventLogger.append({
                type: "browser.input.state", runId: saved.runId,
                content: { tabId, debuggee, x: saved.x, y: saved.y, keys: [...keys.values()], buttons: [...buttons] },
              });
              // Persist intent before native input. For releases retain the held
              // state until Chrome confirms it, so a worker crash can finish it.
              await record(new Map([...beforeKeys, ...saved.keys]), new Map([...beforeButtons, ...saved.buttons]));
              persistedInput = () => record(saved.keys, saved.buttons);
              if (!cleanup) runs.validate(message as RunIdentity);
            }
          }
          result = await native.apply(chrome.debugger, args);
          await persistedInput?.();
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
    })());
  });
  let cleanupTask: Promise<void> | undefined;
  async function cleanupPort(): Promise<void> {
    if (cleanupTask) return cleanupTask;
    closed = true;
    chrome.debugger.onEvent.removeListener(onEvent);
    chrome.debugger.onDetach.removeListener(onDetach);
    const debuggees = [...sessions.values()];
    sessions.clear();
    cleanupTask = track((async () => {
      await Promise.allSettled([...heldInput.keys()].map(releaseHeldInput));
      await Promise.all([...pointerGestures].map((tabId) => endGesture(tabId)));
      await Promise.all(debuggees.map((debuggee) => chrome.debugger.detach(debuggee).catch(() => undefined)));
    })());
    void cleanupTask.finally(() => { try { port.disconnect(); } catch { /* Already disconnected. */ } });
    return cleanupTask;
  }
  port.onDisconnect.addListener(() => { void cleanupPort(); });
});

async function restoreSavedUserScripts(): Promise<boolean> {
  try {
    const restored = await serializeUserScripts(() => restoreUserScripts({ logger: eventLogger }));
    if (restored) await chrome.storage.local.remove(USER_SCRIPTS_ERROR_KEY);
    return restored;
  } catch (error) {
    await chrome.storage.local.set({ [USER_SCRIPTS_ERROR_KEY]: error instanceof Error ? error.message : String(error) });
    eventLogger.record({ type: "userscript.restore-failed", content: null, error });
    throw error;
  }
}

chrome.runtime.onMessage.addListener((message: { type?: string; method?: string; args?: unknown[]; operationId?: string } & Partial<RunIdentity>, sender, sendResponse) => {
  if (message?.type !== "surf-wax:user-scripts" || sender.id !== chrome.runtime.id) return;
  void (async () => {
    if (runs.maintenance) throw new Error("日志正在维护。");
    const identity = message.runId ? message as RunIdentity : undefined;
    if (identity) runs.validate(identity, message.operationId);
    if (message.method === "restore") return restoreSavedUserScripts();
    return track(callUserScripts(message.method ?? "", message.args ?? [], {
      logger: eventLogger, beforeExecute: () => { if (identity) runs.validate(identity); else if (runs.maintenance) throw new Error("日志正在维护。"); },
    }));
  })()
    .then((result) => sendResponse({ ok: true, result }), (error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  return true;
});

function discardJevConfig(): void {
  void chrome.storage.local.remove("side-agent:jev-config").catch((error) => {
    eventLogger.record({ type: "legacy-config.clear-failed", content: null, error });
  });
}

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  void restoreSavedUserScripts().catch(() => undefined);
  discardJevConfig();
});

chrome.runtime.onStartup.addListener(() => {
  void restoreSavedUserScripts().catch(() => undefined);
  discardJevConfig();
});
void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// Chrome 138 relies on pagehide/owner-port disconnect; Chrome 142+ adds this signal.
const onClosed = (chrome.sidePanel as unknown as { onClosed?: { addListener: (listener: (info: { windowId: number }) => void) => void } }).onClosed;
onClosed?.addListener(({ windowId }) => {
  void runs.cancelClosedWindow(windowId, async (documentId) => (await chrome.runtime.getContexts({ documentIds: [documentId] })).length > 0);
});
