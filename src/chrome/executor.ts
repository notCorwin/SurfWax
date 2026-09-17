import type { EventLogger } from "../logging";
import type { ChromeToolInput } from "../types";
import { restoreUserScripts, snapshotUserScripts } from "../userscripts/persistence";

type Debuggee = chrome.debugger.Debuggee;
type DebuggerTarget = chrome.debugger.TargetInfo;
type DebuggerApi = {
  getTargets(): Promise<DebuggerTarget[]>;
  attach(debuggee: Debuggee, requiredVersion: string): Promise<void>;
  detach(debuggee: Debuggee): Promise<void>;
  sendCommand(debuggee: Debuggee, method: string, commandParams?: object): Promise<object>;
};
type ExecutorChrome = typeof chrome & { debugger: DebuggerApi };

const BRIDGE_KEY = "__surfWaxDebugger";
const RESULTS_KEY = "__surfWaxResults";
const RESULT_READER_KEY = "__surfWaxResult";
const STATE_KEY = "__surfWaxExecutionState";

function abortError(): DOMException {
  return new DOMException("Operation aborted", "AbortError");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

export function ensureSidePanelInstanceUrl(): string {
  const url = new URL(globalThis.location.href);
  if (!url.hash.startsWith("#side-agent-instance=")) {
    url.hash = `side-agent-instance=${globalThis.crypto.randomUUID()}`;
    globalThis.history.replaceState(null, "", url.href);
  }
  return url.href;
}

function expressionFor(code: string): string {
  return `(async () => {
    const __nativeChrome = globalThis.chrome;
    const __bridge = globalThis[${JSON.stringify(BRIDGE_KEY)}];
    const __state = globalThis[${JSON.stringify(STATE_KEY)}];
    const __guard = globalThis.__surfWaxGuard;
    const __mark = async (tabId) => { if (Number.isInteger(tabId)) await __guard?.mark(tabId); };
    const __pageApi = (name) => new Proxy(__nativeChrome[name], {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        if (name === "tabs" && property === "connect") return (...args) => {
          void __mark(args[0]);
          return Reflect.apply(value, target, args);
        };
        if (name === "tabs" && !["update", "create", "reload", "goBack", "goForward", "sendMessage", "move", "remove", "discard", "duplicate", "group", "ungroup", "highlight", "captureVisibleTab"].includes(property)) return value;
        return async (...args) => {
          if (name === "scripting" || name === "userScripts" && property === "execute") await __mark(args[0]?.target?.tabId);
          if (name === "pageCapture" && property === "saveAsMHTML") await __mark(args[0]?.tabId);
          if (name === "tabs" && property !== "captureVisibleTab") await __mark(args[0]);
          if (name === "tabs" && property === "captureVisibleTab") {
            const [active] = await __nativeChrome.tabs.query({ active: true, ...(Number.isInteger(args[0]) ? { windowId: args[0] } : { currentWindow: true }) });
            await __mark(active?.id);
          }
          const result = name === "userScripts" && ["register", "update", "unregister", "configureWorld", "resetWorldConfiguration"].includes(property)
            ? await __bridge.call("userScripts", [property, ...args]) : await Reflect.apply(value, target, args);
          if (name === "tabs" && property === "create") await __mark(result?.id);
          if (name === "tabs" && property === "update" && !Number.isInteger(args[0])) await __mark(result?.id);
          return result;
        };
      }
    });
    const __debugger = new Proxy(__nativeChrome.debugger, {
      get(target, property, receiver) {
        if (property === "onEvent" || property === "onDetach") return __bridge[property];
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? (...args) => {
          if (property !== "detach" && (__state.run.aborted || __state.lifetime.aborted)) throw new DOMException("Operation aborted", "AbortError");
          return (async () => {
            if (property === "attach" || property === "sendCommand") {
              let tabId = args[0]?.tabId;
              if (!Number.isInteger(tabId) && args[0]?.targetId) {
                const targets = await __nativeChrome.debugger.getTargets();
                tabId = targets.find((item) => item.id === args[0].targetId)?.tabId;
              }
              await __mark(tabId);
            }
            return __bridge.call(property, args);
          })().then(async (result) => {
            if (property !== "detach" && (__state.run.aborted || __state.lifetime.aborted)) {
              if (property === "attach") await __bridge.call("detach", [args[0]]).catch(() => undefined);
              throw new DOMException("Operation aborted", "AbortError");
            }
            return result;
          });
        } : value;
      }
    });
    const chrome = new Proxy(__nativeChrome, {
      get(target, property, receiver) {
        return property === "debugger" ? __debugger
          : ["scripting", "userScripts", "tabs", "pageCapture"].includes(property) && target[property] ? __pageApi(property)
          : Reflect.get(target, property, receiver);
      }
    });
    const result = await (async () => {
${code}
    })();
    ${resultEnvelope()}
  })()`;
}

function resultEnvelope(): string {
  return `
    const seen = new WeakSet();
    const transferable = (value) => {
      if (value === null || typeof value === "string" || typeof value === "boolean") return true;
      if (typeof value === "number") return Number.isFinite(value);
      if (typeof value !== "object" || seen.has(value)) return false;
      const isArray = Array.isArray(value);
      const prototype = Object.getPrototypeOf(value);
      if (!isArray && prototype !== Object.prototype && prototype !== null) return false;
      seen.add(value);
      const keys = Reflect.ownKeys(value);
      const valid = (!isArray || keys.length === value.length + 1) && keys.every((key) => {
        if (isArray && key === "length") return true;
        if (typeof key !== "string" || (isArray && (!Object.hasOwn(value, key) || !/^(0|[1-9]\\d*)$/.test(key)))) return false;
        const property = Object.getOwnPropertyDescriptor(value, key);
        return property?.enumerable && "value" in property && transferable(property.value);
      });
      seen.delete(value);
      return valid;
    };
    try {
      if (transferable(result)) return { kind: "value", value: result };
    } catch { /* A getter can throw; keep the original value available for inspection. */ }
    const values = globalThis[${JSON.stringify(RESULTS_KEY)}] ??= new Map();
    const id = crypto.randomUUID();
    values.set(id, result);
    let preview;
    try { preview = String(result); } catch { preview = "[unprintable value]"; }
    return { kind: "reference", id, type: typeof result, preview };
  `;
}

function pageExpressionFor(code: string): string {
  return `(async () => {
    const result = await (async () => {
${code}
    })();
    ${resultEnvelope()}
  })()`;
}

function evaluationError(response: any): Error | undefined {
  const details = response?.exceptionDetails;
  if (!details) return undefined;
  const description = details.exception?.description;
  const value = details.exception?.value;
  return new Error(typeof description === "string" ? description : typeof value === "string" ? value : details.text || "JavaScript execution failed");
}

function evaluationValue(response: any, scope: "panel" | "page" = "panel"): unknown {
  const remote = response?.result;
  if (!remote || typeof remote !== "object") return remote;
  const result = remote.value;
  if (result?.kind === "value") return result.value;
  if (result?.kind === "reference") return {
    $ref: result.id,
    type: result.type,
    preview: result.preview,
    access: `globalThis.${RESULTS_KEY}.get(${JSON.stringify(result.id)})`,
    scope,
  };
  return Object.prototype.hasOwnProperty.call(remote, "value") ? result : remote;
}

export class ChromeExecutor {
  private readonly chromeApi: ExecutorChrome;
  private readonly targetUrl: string;
  private readonly logger?: EventLogger;
  private port?: chrome.runtime.Port;
  private readonly bridge: Record<string, unknown>;
  private readonly lifetime = { aborted: false };
  private tail: Promise<void> = Promise.resolve();
  private initialized?: Promise<void>;
  private activeDebuggee?: Debuggee;
  private disposed = false;

  constructor(options: { chromeApi?: ExecutorChrome; targetUrl?: string; logger?: EventLogger } = {}) {
    this.chromeApi = options.chromeApi ?? globalThis.chrome as ExecutorChrome;
    this.targetUrl = options.targetUrl ?? ensureSidePanelInstanceUrl();
    this.logger = options.logger;
    if (!this.chromeApi?.debugger) throw new Error("Chrome extension debugger API is unavailable");
    const pending = new Map<string, { resolve: (value: unknown) => void; reject: (reason: Error) => void }>();
    const listeners = { onEvent: new Set<(...args: any[]) => void>(), onDetach: new Set<(...args: any[]) => void>() };
    const event = (name: keyof typeof listeners) => ({
      addListener: (listener: (...args: any[]) => void) => listeners[name].add(listener),
      removeListener: (listener: (...args: any[]) => void) => listeners[name].delete(listener),
      hasListener: (listener: (...args: any[]) => void) => listeners[name].has(listener),
      hasListeners: () => listeners[name].size > 0,
    });
    const disconnect = (port: chrome.runtime.Port, error: Error) => {
      if (this.port !== port) return;
      this.port = undefined;
      for (const request of pending.values()) request.reject(this.disposed ? abortError() : error);
      pending.clear();
    };
    const connect = () => {
      const port = this.chromeApi.runtime?.connect?.({ name: "surf-wax-debugger" });
      if (!port) return undefined;
      this.port = port;
      port.onMessage.addListener((message: { id?: string; event?: keyof typeof listeners; args?: any[]; result?: unknown; error?: string }) => {
        if (this.port !== port) return;
        if (message.event && listeners[message.event]) {
          for (const listener of listeners[message.event]) listener(...(message.args ?? []));
        } else if (message.id) {
          const request = pending.get(message.id);
          pending.delete(message.id);
          if (message.error) request?.reject(new Error(message.error));
          else request?.resolve(message.result);
        }
      });
      port.onDisconnect.addListener(() => disconnect(port, new Error("Debugger bridge disconnected")));
      return port;
    };
    this.bridge = {
      onEvent: event("onEvent"),
      onDetach: event("onDetach"),
      call: async (method: string, args: unknown[]) => {
        if (this.disposed) throw abortError();
        const port = this.port ?? connect();
        if (!port) {
          if (method === "userScripts") return Reflect.apply((this.chromeApi.userScripts as any)[args[0] as string], this.chromeApi.userScripts, args.slice(1));
          if (method === "restoreUserScripts") return restoreUserScripts({ chromeApi: this.chromeApi, logger: this.logger });
          if (method === "snapshotUserScripts") return snapshotUserScripts({ chromeApi: this.chromeApi, logger: this.logger });
          return Reflect.apply((this.chromeApi.debugger as any)[method], this.chromeApi.debugger, args);
        }
        return new Promise((resolve, reject) => {
          const id = globalThis.crypto.randomUUID();
          pending.set(id, { resolve, reject });
          try { port.postMessage({ id, method, args }); }
          catch (error) {
            disconnect(port, error instanceof Error ? error : new Error(String(error)));
            try { port.disconnect(); } catch { /* The extension context may already be gone. */ }
            reject(error);
          }
        });
      },
    };
    (globalThis as Record<string, unknown>)[BRIDGE_KEY] = this.bridge;
    (globalThis as Record<string, unknown>)[RESULT_READER_KEY] = (id: number) => this.logger?.result(id)
      ?? Promise.reject(new Error("Tool result log is unavailable"));
  }

  execute(input: ChromeToolInput, signal?: AbortSignal): Promise<unknown> {
    const task = this.tail.then(() => this.executeNow(input, signal));
    this.tail = task.then(() => undefined, () => undefined);
    return task;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.lifetime.aborted = true;
    if ((globalThis as Record<string, unknown>)[BRIDGE_KEY] === this.bridge) {
      delete (globalThis as Record<string, unknown>)[BRIDGE_KEY];
      delete (globalThis as Record<string, unknown>)[RESULT_READER_KEY];
    }
    const sessions = [this.activeDebuggee].filter((item): item is Debuggee => Boolean(item));
    this.activeDebuggee = undefined;
    for (const debuggee of sessions) void this.chromeApi.debugger.detach(debuggee).catch(() => undefined);
    this.port?.disconnect();
  }

  private async initialize(): Promise<void> {
    this.initialized ??= (async () => {
      const call = this.bridge.call as (method: string, args: unknown[]) => Promise<unknown>;
      try { await call("restoreUserScripts", []); }
      catch (error) {
        if (this.port || this.disposed || !this.chromeApi.runtime?.connect) throw error;
        await call("restoreUserScripts", []);
      }
    })().catch((error) => {
      this.initialized = undefined;
      throw error;
    });
    return this.initialized;
  }

  private async executeNow(input: ChromeToolInput, signal?: AbortSignal): Promise<unknown> {
    if (this.disposed) throw new Error("Chrome executor has been disposed");
    throwIfAborted(signal);
    await this.initialize();
    throwIfAborted(signal);

    if (input.tabId !== undefined) {
      await (globalThis as Record<string, any>).__surfWaxGuard?.mark(input.tabId);
      throwIfAborted(signal);
      if (this.chromeApi.userScripts?.execute) {
        const result = await this.awaitAbort(
          this.chromeApi.userScripts.execute({
            target: { tabId: input.tabId },
            world: input.world ?? "MAIN",
            js: [{ code: pageExpressionFor(input.code) }],
            injectImmediately: true,
          }),
          signal,
        );
        throwIfAborted(signal);
        const first = result[0];
        if (!first) throw new Error(`No injection result for tab ${input.tabId}`);
        if (first.error) throw new Error(first.error);
        return evaluationValue({ result: { value: first.result } }, "page");
      }
      if (input.world === "USER_SCRIPT") throw new Error("Allow User Scripts is unavailable; USER_SCRIPT execution requires Chrome userScripts.execute");
      return this.evaluate({ tabId: input.tabId }, pageExpressionFor(input.code), signal, "page");
    }

    const targets = await this.chromeApi.debugger.getTargets();
    if (this.disposed) throw abortError();
    throwIfAborted(signal);
    const target = targets.find((candidate) => candidate.url === this.targetUrl && candidate.id);
    if (!target?.id) throw new Error(`Side Panel DevTools target not found: ${this.targetUrl}`);
    return this.evaluate({ targetId: target.id }, expressionFor(input.code), signal, "panel");
  }

  private async awaitAbort<T>(task: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return task;
    throwIfAborted(signal);
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(abortError());
      signal.addEventListener("abort", abort, { once: true });
      void task.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  }

  private async evaluate(debuggee: Debuggee, expression: string, signal?: AbortSignal, scope: "panel" | "page" = "panel"): Promise<unknown> {
    let attached = false;
    const state = { lifetime: this.lifetime, run: { aborted: false } };
    let rejectAbort: ((error: DOMException) => void) | undefined;
    const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
    const onAbort = () => {
      state.run.aborted = true;
      if (attached) void this.chromeApi.debugger.detach(debuggee).catch(() => undefined);
      rejectAbort?.(abortError());
    };
    try {
      throwIfAborted(signal);
      await this.chromeApi.debugger.attach(debuggee, "1.3");
      attached = true;
      this.activeDebuggee = debuggee;
      if (this.disposed) throw abortError();
      throwIfAborted(signal);
      signal?.addEventListener("abort", onAbort, { once: true });
      (globalThis as Record<string, unknown>)[STATE_KEY] = state;
      const evaluation = this.chromeApi.debugger.sendCommand(debuggee, "Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      });
      const response = signal
        ? await Promise.race([evaluation, aborted])
        : await evaluation;
      if (this.disposed) throw abortError();
      throwIfAborted(signal);
      const error = evaluationError(response);
      if (error) throw error;
      return evaluationValue(response, scope);
    } finally {
      signal?.removeEventListener("abort", onAbort);
      if ((globalThis as Record<string, unknown>)[STATE_KEY] === state) delete (globalThis as Record<string, unknown>)[STATE_KEY];
      if (attached) {
        try {
          await this.chromeApi.debugger.detach(debuggee);
        } catch { /* Closing the target may already have detached it. */ }
      }
      if (this.activeDebuggee === debuggee) this.activeDebuggee = undefined;
      try {
        await (this.bridge.call as (method: string, args: unknown[]) => Promise<unknown>)("snapshotUserScripts", []);
      } catch (error) {
        this.logger?.record({ type: "userscript.snapshot-failed", content: null, error });
      }
    }
  }
}
