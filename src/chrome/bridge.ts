import type { ChromeToolInput, ChromeToolOutput, JsonValue } from "../types";
import { HandleStore, resolveHandles, serializeError, serializeValue } from "./serializer";
import type { UserScriptRegistry } from "../userscripts/registry";

type ChromeEvent = {
  addListener(listener: (...args: unknown[]) => void): void;
  removeListener(listener: (...args: unknown[]) => void): void;
};

type DebuggerSession = {
  tabId: number;
  sessionId?: string;
};

type DebuggerApi = {
  attach(debuggee: DebuggerSession, version: string): Promise<void>;
  detach(debuggee: DebuggerSession): Promise<void>;
  sendCommand(debuggee: DebuggerSession, command: string, params?: unknown): Promise<unknown>;
  onDetach?: ChromeEvent;
};

type ChromeRuntime = typeof chrome & {
  runtime?: typeof chrome.runtime;
};

export type ChromeBridgeOptions = {
  chromeApi?: ChromeRuntime;
  userScripts?: UserScriptRegistry;
};

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function isDebuggerDetachedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:debugger|target).*\b(?:not attached|detached)\b|\bnot attached\b/i.test(message);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Operation aborted", "AbortError");
}

function resolvePath(root: unknown, path: string): { owner: any; key: string; value: any } {
  const segments = path.split(".").filter(Boolean);
  if (!segments.length) throw new Error("Chrome API path cannot be empty");

  let owner: any = root;
  for (const segment of segments.slice(0, -1)) {
    if (owner == null || !(segment in owner)) {
      throw new Error(`Chrome API path not found: ${path}`);
    }
    owner = owner[segment];
  }

  const key = segments.at(-1)!;
  if (owner == null || !(key in owner)) throw new Error(`Chrome API path not found: ${path}`);
  return { owner, key, value: owner[key] };
}

function isPartialMatch(actual: unknown, expected: unknown): boolean {
  if (expected === undefined) return true;
  if (Object.is(actual, expected)) return true;
  if (Array.isArray(expected)) {
    return Array.isArray(actual)
      && expected.length <= actual.length
      && expected.every((item, index) => isPartialMatch(actual[index], item));
  }
  if (expected && typeof expected === "object") {
    if (!actual || typeof actual !== "object") return false;
    return Object.entries(expected).every(([key, value]) =>
      isPartialMatch((actual as Record<string, unknown>)[key], value),
    );
  }
  return false;
}

function normalizeArguments(args: unknown[], handles: HandleStore): unknown[] {
  return (args ?? []).map((arg) => resolveHandles(arg, handles));
}

export class ChromeBridge {
  readonly handles = new HandleStore();

  private readonly chromeApi: ChromeRuntime;
  private readonly userScripts?: UserScriptRegistry;
  private readonly debuggerSessions = new Map<number, DebuggerSession>();
  private readonly pendingAttaches = new Map<number, Promise<DebuggerSession>>();
  private readonly pendingWaits = new Set<() => void>();
  private pendingExecutions?: Promise<void>;
  private readonly debuggerDetachEvent?: ChromeEvent;
  private readonly handleDebuggerDetach = (...args: unknown[]): void => {
    const source = args[0];
    if (!source || typeof source !== "object") return;

    const tabId = (source as { tabId?: unknown }).tabId;
    if (typeof tabId !== "number") return;
    const current = this.debuggerSessions.get(tabId);
    if (!current) return;

    const sessionId = (source as { sessionId?: unknown }).sessionId;
    if (typeof sessionId === "string" && current.sessionId && sessionId !== current.sessionId) return;
    this.debuggerSessions.delete(tabId);
  };
  private disposed = false;

  constructor(options: ChromeBridgeOptions = {}) {
    this.chromeApi = options.chromeApi ?? (globalThis.chrome as ChromeRuntime);
    this.userScripts = options.userScripts;
    if (!this.chromeApi) throw new Error("Chrome extension APIs are unavailable");

    this.debuggerDetachEvent = (this.chromeApi as { debugger?: DebuggerApi }).debugger?.onDetach;
    this.debuggerDetachEvent?.addListener(this.handleDebuggerDetach);
  }

  async execute(input: ChromeToolInput, signal?: AbortSignal): Promise<ChromeToolOutput> {
    const previous = this.pendingExecutions;
    const task = previous
      ? previous.then(() => this.executeNow(input, signal))
      : this.executeNow(input, signal);
    const tail = task.then(() => undefined, () => undefined);
    this.pendingExecutions = tail;
    void tail.then(() => {
      if (this.pendingExecutions === tail) this.pendingExecutions = undefined;
    });
    return previous ? this.abortable(task, signal) : task;
  }

  private async executeNow(input: ChromeToolInput, signal?: AbortSignal): Promise<ChromeToolOutput> {
    if (this.disposed) return this.failure("BridgeDisposedError", "Chrome bridge has been disposed");
    try {
      throwIfAborted(signal);
      let value: unknown;
      switch (input.operation) {
        case "describe":
          value = await this.describe(input.path);
          break;
        case "call":
          value = await this.call(input, signal);
          break;
        case "waitEvent":
          value = await this.waitEvent(input, signal);
          break;
        case "cdp":
          value = await this.cdp(input, signal);
          break;
        default:
          throw new Error("Unsupported Chrome operation");
      }
      return { ok: true, value: serializeValue(value, this.handles) };
    } catch (error) {
      if (isAbortError(error)) throw error;
      return this.failure(
        error instanceof Error ? error.name : "ChromeBridgeError",
        error instanceof Error ? error.message : String(error),
        serializeError(error, this.handles),
      );
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.debuggerDetachEvent?.removeListener(this.handleDebuggerDetach);
    for (const cancel of this.pendingWaits) cancel();
    this.pendingWaits.clear();

    const debuggerApi = (this.chromeApi as { debugger?: DebuggerApi }).debugger;
    const sessions = [...this.debuggerSessions.values()];
    if (debuggerApi?.detach) {
      for (const session of sessions) {
        void this.detachAfterDispose(debuggerApi, session);
      }
    }
    this.debuggerSessions.clear();
    this.pendingAttaches.clear();
    this.handles.clear();
  }

  private failure(name: string, message: string, details?: JsonValue): ChromeToolOutput {
    return { ok: false, error: { name, message, details } };
  }

  private async describe(path?: string): Promise<unknown> {
    const root = path ? resolvePath(this.chromeApi, path).value : this.chromeApi;
    const value = asObject(root);
    const properties = Object.getOwnPropertyNames(value).map((name) => {
      const item = value[name];
      const kind = typeof item === "function"
        ? "method"
        : item && typeof item === "object" && typeof (item as ChromeEvent).addListener === "function"
          ? "event"
          : item && typeof item === "object"
            ? "namespace"
            : typeof item;
      return { name, kind };
    });

    let permissions: unknown = undefined;
    const permissionsApi = (this.chromeApi as any).permissions;
    if (permissionsApi?.getAll) permissions = await permissionsApi.getAll();

    return { path: path ?? "chrome", properties, permissions, handles: this.handles.describe() };
  }

  private async call(input: Extract<ChromeToolInput, { operation: "call" }>, signal?: AbortSignal): Promise<unknown> {
    if (!input.path) throw new Error("call requires path");
    const args = normalizeArguments(input.args, this.handles);
    throwIfAborted(signal);

    if (!input.receiver && this.userScripts) {
      const managed = await this.userScripts.handleAgentCall(input.path, args, signal);
      if (managed.handled) return managed.value;
    }

    const receiver = input.receiver ? this.handles.resolve(input.receiver) : this.chromeApi;
    const { owner, value } = resolvePath(receiver, input.path);
    if (typeof value !== "function") throw new Error(`Chrome API path is not callable: ${input.path}`);

    if (input.callbackMode === "callback") {
      return this.callWithCallback(owner, value, args, signal);
    }

    const result = value.apply(owner, args);
    return result && typeof result.then === "function" ? await this.abortable(result, signal) : result;
  }

  private callWithCallback(
    owner: unknown,
    method: (...args: unknown[]) => unknown,
    args: unknown[],
    signal?: AbortSignal,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const onAbort = () => {
        if (!settled) {
          settled = true;
          reject(new DOMException("Operation aborted", "AbortError"));
        }
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const callback = (...values: unknown[]) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        const lastError = (this.chromeApi as any).runtime?.lastError;
        if (lastError) {
          reject(new Error(lastError.message || "Chrome API callback failed"));
          return;
        }
        resolve(values.length <= 1 ? values[0] : values);
      };

      try {
        method.apply(owner, [...args, callback]);
      } catch (error) {
        if (!settled) {
          settled = true;
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        }
      }
    });
  }

  private waitEvent(input: Extract<ChromeToolInput, { operation: "waitEvent" }>, signal?: AbortSignal): Promise<unknown> {
    if (!input.eventPath) throw new Error("waitEvent requires eventPath");
    const event = resolvePath(this.chromeApi, input.eventPath).value as ChromeEvent;
    if (!event || typeof event.addListener !== "function" || typeof event.removeListener !== "function") {
      throw new Error(`Path is not a Chrome Event: ${input.eventPath}`);
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        event.removeListener(listener);
        this.pendingWaits.delete(cancel);
        signal?.removeEventListener("abort", onAbort);
      };
      const cancel = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new DOMException("Operation aborted", "AbortError"));
      };
      const onAbort = () => {
        cancel();
      };
      const listener = (...args: unknown[]) => {
        if (settled || !isPartialMatch(args, input.match)) return;
        settled = true;
        cleanup();
        resolve(args.length <= 1 ? args[0] : args);
      };

      this.pendingWaits.add(cancel);
      event.addListener(listener);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }

  private async cdp(input: Extract<ChromeToolInput, { operation: "cdp" }>, signal?: AbortSignal): Promise<unknown> {
    if (typeof input.tabId !== "number") throw new Error("cdp requires tabId");
    const debuggerApi = (this.chromeApi as { debugger?: DebuggerApi }).debugger;
    if (!debuggerApi) throw new Error("chrome.debugger is unavailable or not permitted");
    const session: DebuggerSession = { tabId: input.tabId, ...(input.sessionId ? { sessionId: input.sessionId } : {}) };
    this.assertActive(signal);

    if (input.action === "attach") {
      const attached = await this.attachSession(debuggerApi, session, signal);
      return { attached: true, ...attached };
    }

    if (input.action === "detach") {
      try {
        await debuggerApi.detach(session);
      } catch (error) {
        throwIfAborted(signal);
        throw error;
      }
      this.assertActive(signal);
      this.debuggerSessions.delete(input.tabId);
      return { detached: true, ...session };
    }

    if (!input.command) throw new Error("cdp send requires command");
    const activeSession = await this.attachSession(debuggerApi, session, signal);
    return this.sendWithRecovery(debuggerApi, activeSession, input, signal);
  }

  private assertActive(signal?: AbortSignal): void {
    throwIfAborted(signal);
    if (this.disposed) throw new Error("Chrome bridge has been disposed");
  }

  private abortable<T>(value: PromiseLike<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return Promise.resolve(value);
    return new Promise((resolve, reject) => {
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        reject(new DOMException("Operation aborted", "AbortError"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      Promise.resolve(value).then((result) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      }, (error) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(error);
      });
      if (signal.aborted) onAbort();
    });
  }

  private async attachSession(
    debuggerApi: DebuggerApi,
    requestedSession: DebuggerSession,
    signal?: AbortSignal,
  ): Promise<DebuggerSession> {
    this.assertActive(signal);
    const current = this.debuggerSessions.get(requestedSession.tabId);
    if (current) {
      return { ...current, ...(requestedSession.sessionId ? { sessionId: requestedSession.sessionId } : {}) };
    }

    let pending = this.pendingAttaches.get(requestedSession.tabId);
    if (!pending) {
      const session: DebuggerSession = { tabId: requestedSession.tabId };
      pending = (async () => {
        await debuggerApi.attach(session, "1.3");
        if (this.disposed) {
          await Promise.resolve(debuggerApi.detach(session)).catch(() => undefined);
          throw new Error("Chrome bridge has been disposed");
        }
        this.debuggerSessions.set(session.tabId, session);
        return session;
      })();
      this.pendingAttaches.set(requestedSession.tabId, pending);
    }

    try {
      const attached = await pending;
      this.assertActive(signal);
      return { ...attached, ...(requestedSession.sessionId ? { sessionId: requestedSession.sessionId } : {}) };
    } catch (error) {
      throwIfAborted(signal);
      throw error;
    } finally {
      if (this.pendingAttaches.get(requestedSession.tabId) === pending) {
        this.pendingAttaches.delete(requestedSession.tabId);
      }
    }
  }

  private async sendWithRecovery(
    debuggerApi: DebuggerApi,
    session: DebuggerSession,
    input: Extract<ChromeToolInput, { operation: "cdp"; action: "send" }>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    try {
      return await this.sendCommand(debuggerApi, session, input, signal);
    } catch (error) {
      this.assertActive(signal);
      const current = this.debuggerSessions.get(session.tabId);
      const stale = !current || isDebuggerDetachedError(error);
      if (!stale) throw error;

      if (current === session || !session.sessionId || !current?.sessionId || current.sessionId === session.sessionId) {
        this.debuggerSessions.delete(session.tabId);
      }
      const recovered = await this.attachSession(debuggerApi, session, signal);
      return this.sendCommand(debuggerApi, recovered, input, signal);
    }
  }

  private async sendCommand(
    debuggerApi: DebuggerApi,
    session: DebuggerSession,
    input: Extract<ChromeToolInput, { operation: "cdp"; action: "send" }>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const result = input.params === undefined
      ? await debuggerApi.sendCommand(session, input.command)
      : await debuggerApi.sendCommand(session, input.command, resolveHandles(input.params, this.handles));
    this.assertActive(signal);
    return result;
  }

  private async detachAfterDispose(debuggerApi: DebuggerApi, session: DebuggerSession): Promise<void> {
    try {
      await debuggerApi.detach(session);
      if (this.disposed) return;
    } catch {
      return;
    }
  }
}
