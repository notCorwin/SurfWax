import { EventLogger, fromLogValue } from "./logging";
import { BackgroundRunCoordinator } from "./agent/background-coordinator";
import type { RunIdentity } from "./agent/coordinator";
import { recoverBrowserInput } from "./chrome/input-recovery";
import { createHeldInputState, debuggeeKey, heldKeyIdentity, shouldPersistInputState, updateHeldInputState, type HeldInputState } from "./chrome/input-state";
import { targetEditor } from "./chrome/target-editor";
import { requireDebuggee } from "./chrome/debuggee";
import { callUserScripts, restoreUserScripts, serializeUserScripts, USER_SCRIPTS_ERROR_KEY } from "./userscripts/persistence";

const eventLogger = new EventLogger();
const runs = new BackgroundRunCoordinator();
runs.maintenance = true;
const writers = new Set<chrome.runtime.Port>();
const operations = new Set<Promise<unknown>>();
const ownerCleanups = new Map<string, Set<() => Promise<void>>>();
let maintenanceGeneration = 0;
// A worker restart loses transient owners and ports. Reconcile their durable calls.
const bootReady = (async () => {
  const inputEvents = await eventLogger.inputStateEvents();
  // A conversation terminal precedes input cleanup. Recover its input too if
  // the worker stopped between those writes, using the latest canonical state.
  const inputRunIds = [...new Set(inputEvents.flatMap((event) => event.runId ? [event.runId] : []))];
  const inputRecovery = await recoverBrowserInput(inputEvents, inputRunIds, chrome.debugger);
  const latestInput = new Map<string, { runId: string; state: { tabId: number; debuggee: chrome.debugger.Debuggee & { sessionId?: string }; keys?: unknown[]; buttons?: unknown[] } }>();
  for (const event of inputEvents) {
    const state = fromLogValue(event.content, event.valueEncoding) as { tabId: number; debuggee: chrome.debugger.Debuggee & { sessionId?: string }; keys?: unknown[]; buttons?: unknown[] } | null;
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
const inputQueues = new Map<number, Promise<void>>();
async function withSerializedInput<T>(tabId: number, task: () => Promise<T>): Promise<T> {
  const previous = inputQueues.get(tabId) ?? Promise.resolve();
  let release!: () => void;
  const done = new Promise<void>((resolve) => { release = resolve; });
  inputQueues.set(tabId, done);
  await previous;
  try {
    return await task();
  } finally {
    release();
    if (inputQueues.get(tabId) === done) inputQueues.delete(tabId);
  }
}

async function dispatchNativeInput(debuggee: chrome.debugger.Debuggee, command: string, params: Record<string, any>, validate: () => void, onDispatch = () => {}) {
  validate();
  const { surfWaxAtomicClick, ...nativeParams } = params;
  onDispatch();
  if (surfWaxAtomicClick) {
    const moved = chrome.debugger.sendCommand(debuggee, command, { ...nativeParams, type: "mouseMoved", button: "none", buttons: 0, clickCount: 0 });
    const pressed = chrome.debugger.sendCommand(debuggee, command, { ...nativeParams, type: "mousePressed" });
    const released = chrome.debugger.sendCommand(debuggee, command, { ...nativeParams, type: "mouseReleased", buttons: 0 });
    return (await Promise.all([moved, pressed, released]))[2];
  }
  return chrome.debugger.sendCommand(debuggee, command, nativeParams);
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "surf-wax-debugger") return;
  const sessions = new Map<string, chrome.debugger.Debuggee>();
  const runtimeEvaluations = new Map<string, {debuggee:chrome.debugger.Debuggee;count:number}>();
  const heldInput = new Map<string, HeldInputState>();
  let validatedRunId: string | undefined;
  let closed = false;
  const inputReleases = new Map<string, Promise<void>>();
  function releaseHeldInput(inputKey: string): Promise<void> {
    const pending = inputReleases.get(inputKey);
    if (pending) return pending;
    const state = heldInput.get(inputKey);
    if (!state) return Promise.resolve();
    const task = withSerializedInput(state.tabId!, async () => {
      if (heldInput.get(inputKey) !== state) return;
      const failures: string[] = [];
      try {
        for (const [heldKey, params] of [...state.keys]) {
          try {
            await dispatchNativeInput(state.debuggee, "Input.dispatchKeyEvent", { ...params, text: undefined, unmodifiedText: undefined, commands: undefined, type: "keyUp", modifiers: 0 }, () => {});
            if (state.keys.get(heldKey) === params) state.keys.delete(heldKey);
          }
          catch (error) { failures.push(String(error)); }
        }
        for (const [button, params] of [...state.buttons]) {
          try {
            await dispatchNativeInput(state.debuggee, "Input.dispatchMouseEvent", { ...params, type: "mouseReleased", x: state.x, y: state.y, button, buttons: 0, modifiers: 0 }, () => {});
            if (state.buttons.get(button) === params) state.buttons.delete(button);
          }
          catch (error) { failures.push(String(error)); }
        }
        await chrome.debugger.sendCommand(state.debuggee, "Input.cancelDragging", {}).catch((error) => { failures.push(String(error)); });
        if (state.runId) {
          await eventLogger.append({ type: "browser.input.state", runId: state.runId,
            content: { tabId: state.tabId, debuggee: state.debuggee, x: state.x, y: state.y, keys: [...state.keys.values()], buttons: [...state.buttons] } });
          if (failures.length) await eventLogger.append({ type: "browser.input.release-failed", runId: state.runId, content: { tabId: state.tabId, debuggee: state.debuggee }, error: failures });
        }
      } finally {
        if (heldInput.get(inputKey) === state && !state.keys.size && !state.buttons.size) heldInput.delete(inputKey);
      }
    });
    inputReleases.set(inputKey, task);
    void task.finally(() => { if (inputReleases.get(inputKey) === task) inputReleases.delete(inputKey); }).catch(() => undefined);
    return task;
  }
  const onEvent = (source: chrome.debugger.Debuggee, method: string, params?: object) => {
    if (!closed && sessions.has(debuggeeKey(source))) {
      port.postMessage({ event: "onEvent", args: [source, method, params] });
    }
  };
  const onDetach = (source: chrome.debugger.Debuggee, reason: string) => {
    if (!sessions.delete(debuggeeKey(source))) return;
    if (!closed) port.postMessage({ event: "onDetach", args: [source, reason] });
  };
  chrome.debugger.onEvent.addListener(onEvent);
  chrome.debugger.onDetach.addListener(onDetach);
  port.onMessage.addListener((message: { id: string; method: string; args: any[]; operationId?: string; rawCdp?: boolean } & Partial<RunIdentity>) => {
    void track((async () => {
    const { id, method, args } = message;
    const trackedInput = method === "sendCommand" && Array.isArray(args) && ["Input.dispatchKeyEvent", "Input.dispatchMouseEvent"].includes(args[1]);
    let nativeInputAttempted = false;
    try {
      let result: unknown;
      const command = args[1];
      const params = args[2];
      if (message.rawCdp && method === "sendCommand" && params && typeof params === "object"
        && Object.keys(params).some((key) => key.startsWith("surfWax")))
        throw new Error("AutomationError[invalid-protocol-parameter]: surfWax parameters are reserved for internal automation");
      const cleanup = method === "detach" || method === "sendCommand" &&
        (["Network.disable", "Log.disable", "Input.cancelDragging", "Runtime.releaseObjectGroup", "Runtime.terminateExecution"].includes(command) ||
         command === "Page.setInterceptFileChooserDialog" && params?.enabled === false ||
         command === "Input.dispatchKeyEvent" && params?.type === "keyUp" ||
         command === "Input.dispatchMouseEvent" && params?.type === "mouseReleased");
      if (command === "Runtime.terminateExecution" && !sessions.has(debuggeeKey(args[0]))) throw new Error("Execution cleanup requires a debuggee owned by this port");
      if (!cleanup) {
        runs.validate(message as RunIdentity, message.operationId);
        validatedRunId = message.runId!;
        const cleanups = ownerCleanups.get(message.runId!) ?? new Set<() => Promise<void>>();
        cleanups.add(cleanupPort); ownerCleanups.set(message.runId!, cleanups);
      }
      if (closed && !cleanup) throw new DOMException("Side Panel 已关闭", "AbortError");
      if (method === "attach") {
        requireDebuggee(args[0], method);
        if (!sessions.has(debuggeeKey(args[0]))) await chrome.debugger.attach(args[0], args[1]);
        try { if (closed) throw new DOMException("Side Panel 已关闭", "AbortError"); runs.validate(message as RunIdentity); }
        catch (error) { await chrome.debugger.detach(args[0]).catch(() => undefined); throw error; }
        sessions.set(debuggeeKey(args[0]), args[0]);
      } else if (method === "detach") {
        requireDebuggee(args[0], method);
        await Promise.all([...heldInput].filter(([, state]) => debuggeeKey(state.debuggee) === debuggeeKey(args[0])).map(([inputKey]) => releaseHeldInput(inputKey)));
        await chrome.debugger.detach(args[0]);
        sessions.delete(debuggeeKey(args[0]));
      } else {
        const native = (chrome.debugger as unknown as Record<string, (...params: any[]) => Promise<unknown>>)[method];
        if (typeof native !== "function") throw new Error(`Unknown chrome.debugger method: ${method}`);
        if (method !== "getTargets") requireDebuggee(args[0], method);
        const debuggee = args[0] as chrome.debugger.Debuggee;
        const target = debuggee?.targetId ? (await chrome.debugger.getTargets()).find((item) => item.id === debuggee.targetId) : undefined;
        const tabId = debuggee?.tabId ?? target?.tabId;
        const command = args[1] as string;
        const input = method === "sendCommand" && ["Input.dispatchMouseEvent", "Input.dispatchTouchEvent", "Input.dispatchDragEvent", "Input.emulateTouchFromMouseEvent", "Input.dispatchKeyEvent", "Input.insertText"].includes(command) && Number.isInteger(tabId);
        const perform = async () => {
        const type = (args[2] as { type?: string } | undefined)?.type;
        let persistedInput: (() => Promise<unknown>) | undefined;
        let confirmRelease: (() => void) | undefined;
        let rollbackInput: (() => Promise<void>) | undefined;
        try {
          if (!cleanup) { if (closed) throw new DOMException("Side Panel 已关闭", "AbortError"); runs.validate(message as RunIdentity); }
          if (input && ["Input.dispatchKeyEvent", "Input.dispatchMouseEvent"].includes(command)) {
            const inputKey = JSON.stringify(debuggee);
            let state = heldInput.get(inputKey);
            if (!state) { state = createHeldInputState(debuggee, tabId, message.runId ?? validatedRunId); heldInput.set(inputKey, state); }
            else if (!state.keys.size && !state.buttons.size && message.runId) state.runId = message.runId;
            const params = args[2] ?? {};
            const beforeKeys = new Map(state.keys);
            const beforeButtons = new Map(state.buttons);
            const beforePosition = { x: state.x, y: state.y };
            updateHeldInputState(state, command, params, true, message.rawCdp === true);
            const afterKeys = new Map(state.keys);
            const afterButtons = new Map(state.buttons);
            const afterPosition = { x: state.x, y: state.y };
            rollbackInput = async () => {
              for (const [key, value] of afterKeys) {
                if (beforeKeys.get(key) === value || state.keys.get(key) !== value) continue;
                if (beforeKeys.has(key)) state.keys.set(key, beforeKeys.get(key)!); else state.keys.delete(key);
              }
              for (const [button, value] of afterButtons) {
                if (beforeButtons.get(button) === value || state.buttons.get(button) !== value) continue;
                if (beforeButtons.has(button)) state.buttons.set(button, beforeButtons.get(button)!); else state.buttons.delete(button);
              }
              if (state.x === afterPosition.x && state.y === afterPosition.y) Object.assign(state, beforePosition);
              if (persistedInput) await persistedInput();
              if (heldInput.get(inputKey) === state && !state.keys.size && !state.buttons.size) heldInput.delete(inputKey);
            };
            if (command === "Input.dispatchKeyEvent" && params.type === "keyUp") {
              const key = heldKeyIdentity(beforeKeys, params), previous = key ? beforeKeys.get(key) : undefined;
              confirmRelease = () => { if (key && previous && state.keys.get(key) === previous) state.keys.delete(key); };
            } else if (command === "Input.dispatchMouseEvent" && (params.type === "mouseReleased" || params.type === "mousePressed" && params.surfWaxAtomicClick)) {
              const button = params.button ?? (message.rawCdp ? "none" : "left");
              const previous = params.type === "mouseReleased" ? beforeButtons.get(button) : state.buttons.get(button);
              confirmRelease = () => { if (previous && state.buttons.get(button) === previous) state.buttons.delete(button); };
            }
            if (state.runId && (command === "Input.dispatchKeyEvent" || shouldPersistInputState(state, type))) {
              const saved = state;
              const record = (keys: Map<string, Record<string, any>>, buttons: Map<string, Record<string, any>>) => eventLogger.append({
                type: "browser.input.state", runId: saved.runId,
                content: { tabId, debuggee, x: saved.x, y: saved.y, keys: [...keys.values()], buttons: [...buttons] },
              });
              // Persist intent before native input. For releases retain the held
              // state until Chrome confirms it, so a worker crash can finish it.
              persistedInput = () => record(saved.keys, saved.buttons);
              await record(new Map([...beforeKeys, ...saved.keys]), new Map([...beforeButtons, ...saved.buttons]));
              if (!cleanup) runs.validate(message as RunIdentity);
            }
          }
          if (input) {
            const { surfWaxTargetBackendNodeId: target, surfWaxReplaceSelection: replace, ...nativeParams } = args[2] ?? {};
            if (command === "Input.insertText" && target !== undefined) {
              const resolved = await chrome.debugger.sendCommand(debuggee, "DOM.resolveNode", { backendNodeId: target });
              const objectId = (resolved as any)?.object?.objectId;
              if (!objectId) throw new Error("AutomationError[target-unavailable]: Could not resolve the focused node");
              try {
                if (closed || !sessions.has(debuggeeKey(debuggee))) throw new Error("AutomationError[target-unavailable]: Debugger session expired");
                runs.validate(message as RunIdentity);
                const edited = await chrome.debugger.sendCommand(debuggee, "Runtime.callFunctionOn", { objectId,
                  functionDeclaration: `function(text, replace) { return (${targetEditor.toString()})(this, text, replace); }`,
                  arguments: [{ value: String(nativeParams.text ?? "") }, { value: replace === true }], returnByValue: true }) as any;
                if (edited?.exceptionDetails || edited?.result?.value?.ok !== true)
                  throw new Error(`AutomationError[insert-failed]: ${edited?.result?.value?.reason ?? "edit-rejected"}`);
              } finally { await chrome.debugger.sendCommand(debuggee, "Runtime.releaseObject", { objectId }).catch(() => undefined); }
              result = {};
            } else result = await dispatchNativeInput(debuggee, command, nativeParams, () => {
              if (!cleanup) {
                if (closed) throw new DOMException("Side Panel 已关闭", "AbortError");
                runs.validate(message as RunIdentity);
              }
            }, () => { nativeInputAttempted = true; });
          } else {
            const evaluationKey = JSON.stringify(debuggee);
            const evaluation = method === "sendCommand" && ["Runtime.evaluate","Runtime.callFunctionOn"].includes(command);
            if (evaluation) runtimeEvaluations.set(evaluationKey,{debuggee,count:(runtimeEvaluations.get(evaluationKey)?.count ?? 0)+1});
            try {
              if (trackedInput) nativeInputAttempted = true;
              result = await native.apply(chrome.debugger,args);
            }
            finally { if (evaluation) {
              const entry = runtimeEvaluations.get(evaluationKey);
              if (entry && entry.count > 1) entry.count--; else runtimeEvaluations.delete(evaluationKey);
            } }
          }
          confirmRelease?.();
          await persistedInput?.();
        } catch (error) {
          if (trackedInput && !nativeInputAttempted && rollbackInput) {
            try { await rollbackInput(); }
            catch (rollbackError) {
              throw Object.assign(new Error(`AutomationError[input-state-rollback-failed]: ${String(rollbackError)}`), { cause: error });
            }
          }
          throw error;
        }
        };
        if (input) await withSerializedInput(tabId!, perform);
        else await perform();
      }
      if (!closed) port.postMessage({ id, result });
    } catch (error) {
      if (!closed) port.postMessage({ id, error: error instanceof Error ? error.message : String(error),
        ...(trackedInput && !nativeInputAttempted ? { dispatchState: "not-dispatched" } : {}),
        ...((error as any)?.effectUnknown || trackedInput && nativeInputAttempted ? { effectUnknown: true } : {}) });
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
      await Promise.allSettled([...runtimeEvaluations.values()].map(({debuggee}) => chrome.debugger.sendCommand(debuggee,"Runtime.terminateExecution")));
      await Promise.allSettled([...heldInput.keys()].map(releaseHeldInput));
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
// Reconcile when the worker is reloaded too: enabling Allow User Scripts may
// make the API available only after an existing extension context is reloaded.
void restoreSavedUserScripts().catch(() => undefined);
void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// Chrome 138 relies on pagehide/owner-port disconnect; Chrome 142+ adds this signal.
const onClosed = (chrome.sidePanel as unknown as { onClosed?: { addListener: (listener: (info: { windowId: number }) => void) => void } }).onClosed;
onClosed?.addListener(({ windowId }) => {
  void runs.cancelClosedWindow(windowId, async (documentId) => (await chrome.runtime.getContexts({ documentIds: [documentId] })).length > 0);
});
