import { ScriptRegistrationError } from "./userscripts/diagnostic";
import { createDeadline } from "./deadline";
import { EventLogger, fromLogValue } from "./logging";
import { safeDiagnosticError } from "./diagnostic-error";
import { BackgroundRunCoordinator } from "./agent/background-coordinator";
import type { RunIdentity } from "./agent/coordinator";
import { recoverBrowserInput } from "./chrome/input-recovery";
import { createHeldInputState, debuggeeKey, heldKeyIdentity, shouldPersistInputState, updateHeldInputState, type HeldInputState } from "./chrome/input-state";
import { targetEditor } from "./chrome/target-editor";
import { encodeBridgeError } from "./chrome/bridge-error";
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
    const settling = createDeadline(2_000, undefined, "Background maintenance cleanup");
    try { await settling.wait(Promise.allSettled([...operations])); } finally { settling.dispose(); }
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
  let releasing: Promise<void> | undefined;
  const releaseOwner = (reason: "finished" | "owner-disconnected"): Promise<void> => {
    if (releasing) return releasing;
    const identity = runs.identity();
    if (!identity || !runs.owns(port)) return Promise.resolve();
    runs.cancel(port, reason === "finished" ? "run-finished" : reason);
    return releasing = track((async () => {
      const cleanups = [...(ownerCleanups.get(identity.runId) ?? [])];
      const results = await Promise.allSettled(cleanups.map(cleanup => cleanup()));
      results.forEach((result, index) => {
        if (result.status === "rejected") eventLogger.telemetry({ type: "run.cleanup.failed", runId: identity.runId,
          content: { operation: reason, cleanupIndex: index, cleanupCount: cleanups.length, effectUnknown: true }, error: safeDiagnosticError(result.reason) });
      });
      ownerCleanups.delete(identity.runId);
      const owner = runs.release(port);
      if (!owner) return;
      broadcastRunState();
      if (reason !== "finished") {
        await eventLogger.closePendingTools(owner.runId, owner.conversationId, reason);
        await eventLogger.recoverDanglingRuns(async () => runs.identity() ? [runs.identity()!.runId] : []);
      }
    })());
  };
  port.onMessage.addListener((message) => {
    if (message.type === "claim") {
      void bootReady.then(() => {
        if (!connected) return;
        try { port.postMessage({ type: "claimed", ...runs.claim(port, message) }); broadcastRunState(); }
        catch (error) { port.postMessage({ type: "claimed", error: String(error) }); }
      }).catch((error) => { if (connected) { try { port.postMessage({ type: "claimed", error: `后台初始化失败：${error instanceof Error ? error.message : String(error)}` }); } catch { /* Owner closed. */ } } });
    }
    if (message.type === "cancelled") runs.cancel(port, "user-interrupted");
    if (message.type === "finished") void releaseOwner("finished").catch(console.error);
  });
  port.onDisconnect.addListener(() => {
    connected = false;
    void releaseOwner("owner-disconnected").catch(console.error);
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

// A lease survives the UI cleanup deadline until every operation issued by the
// old port and its final detach has settled.
type DebuggerLease = { recovery: Map<string, () => Promise<void>> };
const debuggerLeases = new Map<string, DebuggerLease>();
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "surf-wax-debugger") return;
  const lease: DebuggerLease = { recovery: new Map() };
  const leaseKeys = new Set<string>();
  const operations = new Map<string, Set<Promise<void>>>();
  const resources = new Map<string, string>();
  async function resourceKey(debuggee: chrome.debugger.Debuggee): Promise<string> {
    if (debuggee.extensionId !== undefined) return `extension:${debuggee.extensionId}`;
    const target = (await chrome.debugger.getTargets()).find(item => debuggee.tabId !== undefined ? item.tabId === debuggee.tabId : item.id === debuggee.targetId);
    const resource = debuggee.tabId !== undefined ? `tab:${debuggee.tabId}`
      : target?.tabId !== undefined ? `tab:${target.tabId}`
      : target?.extensionId !== undefined ? `extension:${target.extensionId}` : `target:${debuggee.targetId}`;
    resources.set(debuggeeKey(debuggee), resource);
    if (target) resources.set(`target:${target.id}`, resource);
    if (target?.tabId !== undefined) resources.set(`tab:${target.tabId}`, resource);
    return resource;
  }
  const sessions = new Map<string, chrome.debugger.Debuggee>();
  const pendingDetaches = new Map<string, chrome.debugger.Debuggee>();
  const ownsDebuggee = (debuggee: chrome.debugger.Debuggee) => sessions.has(resources.get(debuggeeKey(debuggee)) ?? debuggeeKey(debuggee));
  const runtimeEvaluations = new Map<string, {debuggee:chrome.debugger.Debuggee;count:number}>();
  const heldInput = new Map<string, HeldInputState>();
  let validatedRunId: string | undefined;
  let validatedIdentity: RunIdentity | undefined;
  let closed = false;
  let cleanupExpired = false;
  const pendingAttaches = new Map<string, chrome.debugger.Debuggee>();
  const guardCleanup = () => { if (cleanupExpired) throw new DOMException("已撤销旧调试连接的清理能力。", "AbortError"); };
  const sendCommand = async (debuggee: chrome.debugger.Debuggee, method: string, params?: Record<string, unknown>) => {
    guardCleanup();
    return chrome.debugger.sendCommand(debuggee, method, params);
  };
  const detach = async (debuggee: chrome.debugger.Debuggee) => {
    guardCleanup();
    return chrome.debugger.detach(debuggee);
  };
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
          guardCleanup();
          try {
            await dispatchNativeInput(state.debuggee, "Input.dispatchKeyEvent", { ...params, text: undefined, unmodifiedText: undefined, commands: undefined, type: "keyUp", modifiers: 0 }, guardCleanup);
            if (state.keys.get(heldKey) === params) state.keys.delete(heldKey);
          }
          catch (error) { failures.push(String(error)); }
        }
        for (const [button, params] of [...state.buttons]) {
          guardCleanup();
          try {
            await dispatchNativeInput(state.debuggee, "Input.dispatchMouseEvent", { ...params, type: "mouseReleased", x: state.x, y: state.y, button, buttons: 0, modifiers: 0 }, guardCleanup);
            if (state.buttons.get(button) === params) state.buttons.delete(button);
          }
          catch (error) { failures.push(String(error)); }
        }
        guardCleanup();
        await sendCommand(state.debuggee, "Input.cancelDragging", {}).catch((error) => { failures.push(String(error)); });
        guardCleanup();
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
    if (!closed && ownsDebuggee(source)) {
      try { port.postMessage({ event: "onEvent", args: [source, method, params] }); } catch { /* Port disconnected. */ }
    }
  };
  const onDetach = (source: chrome.debugger.Debuggee, reason: string) => {
    if (!sessions.delete(resources.get(debuggeeKey(source)) ?? debuggeeKey(source))) return;
    if (!closed) try { port.postMessage({ event: "onDetach", args: [source, reason] }); } catch { /* Port disconnected. */ }
  };
  chrome.debugger.onEvent.addListener(onEvent);
  chrome.debugger.onDetach.addListener(onDetach);
  port.onMessage.addListener((message: { id: string; method: string; args: any[]; operationId?: string; rawCdp?: boolean } & Partial<RunIdentity>) => {
    const operation = track((async () => {
    const { id, method, args } = message;
    const trackedInput = method === "sendCommand" && Array.isArray(args) && ["Input.dispatchKeyEvent", "Input.dispatchMouseEvent"].includes(args[1]);
    let nativeInputAttempted = false;
    try {
      let result: unknown;
      guardCleanup();
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
      if (closed) throw new DOMException("Side Panel 已关闭", "AbortError");
      if (cleanup && (!validatedIdentity || message.runId !== validatedIdentity.runId || message.ownerId !== validatedIdentity.ownerId || message.generation !== validatedIdentity.generation))
        throw new Error("Cleanup requires the owning run identity");
      if (cleanup && (!args[0] || !ownsDebuggee(args[0])))
        throw new Error("Cleanup requires a debuggee owned by this port");
      if (!cleanup) {
        runs.validate(message as RunIdentity, message.operationId);
        validatedRunId = message.runId!;
        validatedIdentity = { runId: message.runId!, ownerId: message.ownerId!, generation: message.generation! };
        const cleanups = ownerCleanups.get(message.runId!) ?? new Set<() => Promise<void>>();
        cleanups.add(cleanupPort); ownerCleanups.set(message.runId!, cleanups);
      }
      if (closed && !cleanup) throw new DOMException("Side Panel 已关闭", "AbortError");
      if (method === "attach") {
        requireDebuggee(args[0], method);
        const resource = await resourceKey(args[0]);
        if (closed) throw new DOMException("Side Panel 已关闭", "AbortError");
        runs.validate(message as RunIdentity);
        const previous = debuggerLeases.get(resource);
        if (previous && previous !== lease) {
          await previous.recovery.get(resource)?.();
          if (closed) throw new DOMException("Side Panel 已关闭", "AbortError");
          runs.validate(message as RunIdentity);
          if (debuggerLeases.has(resource) && debuggerLeases.get(resource) !== lease)
            throw new Error("AutomationError[resource-cleaning]: 调试资源仍在清理，请稍后重试或关闭目标页。");
        }
        debuggerLeases.set(resource, lease); leaseKeys.add(resource);
        resources.set(debuggeeKey(args[0]), resource);
        if (pendingAttaches.has(resource) || pendingDetaches.has(resource))
          throw new Error("AutomationError[resource-busy]: 调试连接正在连接或断开，请稍后重试。");
        if (!ownsDebuggee(args[0])) {
          pendingAttaches.set(resource, args[0]);
          try { await chrome.debugger.attach(args[0], args[1]); }
          finally { pendingAttaches.delete(resource); }
        }
        try { if (closed) throw new DOMException("Side Panel 已关闭", "AbortError"); runs.validate(message as RunIdentity); }
        catch (error) { if (!cleanupExpired) await detach(args[0]).catch(() => undefined); throw error; }
        sessions.set(resource, sessions.get(resource) ?? args[0]);
      } else if (method === "detach") {
        requireDebuggee(args[0], method);
        const resource = resources.get(debuggeeKey(args[0]))!;
        if (pendingDetaches.has(resource)) throw new Error("AutomationError[resource-busy]: 调试连接正在断开，请稍后重试。");
        const detaching = args[0];
        const pending = [...operations].filter(([key]) => resources.get(key) === resource).flatMap(([, tasks]) => [...tasks]);
        pendingDetaches.set(resource, detaching);
        try {
          await Promise.all([...heldInput].filter(([, state]) => resources.get(debuggeeKey(state.debuggee)) === resource).map(([inputKey]) => releaseHeldInput(inputKey)));
          await detach(args[0]);
          sessions.delete(resource);
        } finally {
          // Returning from detach need not wait for old command callbacks, but
          // reattachment must: a delayed native command could reach a new session.
          void Promise.allSettled(pending).then(() => {
            if (pendingDetaches.get(resource) === detaching) pendingDetaches.delete(resource);
          });
        }
      } else {
        const native = (chrome.debugger as unknown as Record<string, (...params: any[]) => Promise<unknown>>)[method];
        if (typeof native !== "function") throw new Error(`Unknown chrome.debugger method: ${method}`);
        if (method !== "getTargets") {
          requireDebuggee(args[0], method);
          if (!ownsDebuggee(args[0])) throw new Error("Debugger session is not owned by this port");
        }
        const debuggee = args[0] as chrome.debugger.Debuggee;
        const sessionResource = debuggee && (resources.get(debuggeeKey(debuggee)) ?? debuggeeKey(debuggee));
        const session = sessions.get(sessionResource);
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
          guardCleanup();
          if (method !== "getTargets" && (sessions.get(sessionResource) !== session || !session))
            throw new Error("Debugger session expired before command dispatch");
          if (!cleanup && pendingDetaches.has(sessionResource))
            throw new Error("AutomationError[resource-busy]: 调试连接正在断开，请稍后重试。");
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
              guardCleanup();
              if (!cleanup) runs.validate(message as RunIdentity);
            }
          }
          if (input) {
            const { surfWaxTargetBackendNodeId: target, surfWaxReplaceSelection: replace, ...nativeParams } = args[2] ?? {};
            if (command === "Input.insertText" && target !== undefined) {
              const resolved = await sendCommand(debuggee, "DOM.resolveNode", { backendNodeId: target });
              const objectId = (resolved as any)?.object?.objectId;
              if (!objectId) throw new Error("AutomationError[target-unavailable]: Could not resolve the focused node");
              try {
                if (closed || !ownsDebuggee(debuggee)) throw new Error("AutomationError[target-unavailable]: Debugger session expired");
                runs.validate(message as RunIdentity);
                const edited = await sendCommand(debuggee, "Runtime.callFunctionOn", { objectId,
                  functionDeclaration: `function(text, replace) { return (${targetEditor.toString()})(this, text, replace); }`,
                  arguments: [{ value: String(nativeParams.text ?? "") }, { value: replace === true }], returnByValue: true }) as any;
                if (edited?.exceptionDetails || edited?.result?.value?.ok !== true)
                  throw new Error(`AutomationError[insert-failed]: ${edited?.result?.value?.reason ?? "edit-rejected"}`);
              } finally { await sendCommand(debuggee, "Runtime.releaseObject", { objectId }).catch(() => undefined); }
              result = {};
            } else result = await dispatchNativeInput(debuggee, command, nativeParams, () => {
              guardCleanup();
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
              guardCleanup();
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
      if (!closed) try { port.postMessage({ id, error: error instanceof Error ? error.message : String(error), errorDetails: encodeBridgeError(error),
        ...(trackedInput && !nativeInputAttempted ? { dispatchState: "not-dispatched" } : {}),
        ...((error as any)?.effectUnknown || trackedInput && nativeInputAttempted ? { effectUnknown: true } : {}) }); } catch { /* Port disconnected. */ }
    }
    })());
    const key = message.args?.[0] && typeof message.args[0] === "object" ? debuggeeKey(message.args[0]) : "";
    const pending = operations.get(key) ?? new Set<Promise<void>>();
    pending.add(operation); operations.set(key, pending);
    void operation.finally(() => pending.delete(operation)).catch(() => undefined);
  });
  let cleanupTask: Promise<void> | undefined;
  async function cleanupPort(): Promise<void> {
    if (cleanupTask) return cleanupTask;
    closed = true;
    chrome.debugger.onEvent.removeListener(onEvent);
    chrome.debugger.onDetach.removeListener(onDetach);
    const debuggees = [...new Map([...sessions.values(), ...pendingAttaches.values(), ...pendingDetaches.values(), ...[...runtimeEvaluations.values()].map(entry => entry.debuggee), ...[...heldInput.values()].map(state => state.debuggee)].map(debuggee => [debuggeeKey(debuggee), debuggee])).values()];
    sessions.clear();
    const deadline = createDeadline(2_000, undefined, "Background debugger cleanup");
    const report = (step: string, target: unknown, error: unknown) => eventLogger.telemetry({ type: "run.cleanup.failed", runId: validatedRunId,
      content: { operation: "debugger-cleanup", step, target, effectUnknown: true,
        ...(step === "final-detach" ? { recovery: "关闭目标页以释放调试连接，或稍后重试该页面的操作。" } : {}) }, error: safeDiagnosticError(error) });
    const workByResource = [...leaseKeys].map(resource => {
      const belongs = (debuggee: chrome.debugger.Debuggee) => resources.get(debuggeeKey(debuggee)) === resource;
      const targets = debuggees.filter(belongs);
      const work = (async () => {
        await Promise.all([...runtimeEvaluations.values()].filter(entry => belongs(entry.debuggee)).map(({debuggee}) => sendCommand(debuggee,"Runtime.terminateExecution").catch(error => report("terminate-execution", debuggee, error))));
        guardCleanup();
        await Promise.all([...heldInput].filter(([, state]) => belongs(state.debuggee)).map(([key]) => releaseHeldInput(key).catch(error => report("release-input", key, error))));
        guardCleanup();
        // A self-closed target can remain in input/cleanup bookkeeping. The
        // finalization below decides whether teardown is unresolved, after all
        // old native operations settle; this first rejection is not that proof.
        await Promise.all(targets.map(debuggee => detach(debuggee).catch(() => undefined)));
      })();
      const finalized = (async () => {
        const pending = [...operations].filter(([key]) => resources.get(key) === resource).flatMap(([, tasks]) => [...tasks]);
        await Promise.allSettled([...pending, work]);
        // An attach can finish after cleanup was revoked. Detach once more only
        // after all old native calls settle, while this port still holds the lease.
        let finalizing: Promise<void> | undefined;
        const finalize = (): Promise<void> => finalizing ??= (async () => {
          if (debuggerLeases.get(resource) !== lease) return;
          let failed = false;
          let currentTargets: Promise<chrome.debugger.TargetInfo[] | undefined> | undefined;
          await Promise.all(targets.map(async debuggee => {
            try { await chrome.debugger.detach(debuggee); }
            catch (error) {
              const kind = debuggee.tabId !== undefined ? "tab" : debuggee.extensionId !== undefined ? "extension" : "target";
              const id = debuggee.tabId ?? debuggee.extensionId ?? debuggee.targetId;
              // attached can also describe another CDP client. This exact native
              // rejection confirms this extension no longer owns the session.
              if (error instanceof Error && error.message === `Debugger is not attached to the ${kind} with id: ${id}.`) return;
              const current = await (currentTargets ??= chrome.debugger.getTargets().catch(() => undefined));
              const target = current?.find(item => debuggee.tabId !== undefined ? item.tabId === debuggee.tabId
                : debuggee.extensionId !== undefined ? item.extensionId === debuggee.extensionId : item.id === debuggee.targetId);
              // Chrome also rejects detach when the target is already gone or
              // detached. Confirm that state instead of trusting error text.
              if (current && (!target || !target.attached)) return;
              failed = true;
              report("final-detach", debuggee, error);
            }
          }));
          if (!failed && debuggerLeases.get(resource) === lease) debuggerLeases.delete(resource);
        })().finally(() => { finalizing = undefined; });
        // Recovery is available only after all old native calls have settled.
        // A later attachment retries this final detach, sharing its in-flight
        // promise; no new session is admitted until completion is confirmed.
        lease.recovery.set(resource, finalize);
        await finalize();
      })().catch(error => report("final-detach", targets, error));
      // The same deadline also covers old calls and their final detach. An
      // unresolved native call must retain both quarantine and an unknown result.
      return finalized;
    });
    const work = Promise.all(workByResource).then(() => undefined);
    cleanupTask = track(deadline.wait(work).catch(error => {
      // Revoke before releasing ownership: a late continuation must never
      // release a new run's keys or detach a newly attached debugger.
      cleanupExpired = true;
      const affectedTabs = new Set([...heldInput.values()].flatMap(state => state.tabId === undefined ? [] : [state.tabId]));
      for (const debuggee of debuggees) if (debuggee.tabId !== undefined) affectedTabs.add(debuggee.tabId);
      for (const tabId of affectedTabs) inputQueues.delete(tabId);

      report("cleanup-timeout", debuggees, error);
    }).finally(() => {
      cleanupExpired = true;
      deadline.dispose();
      try { port.disconnect(); } catch { /* Already disconnected. */ }
    }));
    return cleanupTask;
  }
  port.onDisconnect.addListener(() => { void cleanupPort().catch(() => undefined); });
});

async function restoreSavedUserScripts(): Promise<boolean> {
  try {
    const restored = await serializeUserScripts(() => restoreUserScripts({ logger: eventLogger }));
    if (restored) await chrome.storage.local.remove(USER_SCRIPTS_ERROR_KEY);
    return restored;
  } catch (error) {
    await chrome.storage.local.set({ [USER_SCRIPTS_ERROR_KEY]: error instanceof Error ? error.message : String(error) });
    eventLogger.telemetry({ type: "userscript.restore-failed", content: null, error });
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
    .then((result) => sendResponse({ ok: true, result }), (error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error), diagnostic: error instanceof ScriptRegistrationError ? error.diagnostic : undefined }));
  return true;
});

function discardJevConfig(): void {
  void chrome.storage.local.remove("side-agent:jev-config").catch((error) => {
    eventLogger.telemetry({ type: "legacy-config.clear-failed", content: null, error });
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
