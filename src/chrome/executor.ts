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

const TRACK_DEBUGGER_KEY = "__sideAgentRuntimeTrackDebugger";

function abortError(): DOMException {
  return new DOMException("Operation aborted", "AbortError");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function debuggeeKey(debuggee: Debuggee): string {
  if (debuggee.targetId) return `target:${debuggee.targetId}`;
  if (debuggee.tabId !== undefined) return `tab:${debuggee.tabId}`;
  return `extension:${debuggee.extensionId ?? ""}`;
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
    const __trackDebugger = globalThis[${JSON.stringify(TRACK_DEBUGGER_KEY)}];
    const __debugger = new Proxy(__nativeChrome.debugger, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (property === "attach") return async (debuggee, version) => {
          const result = await value.call(target, debuggee, version);
          __trackDebugger?.(debuggee, true);
          return result;
        };
        if (property === "detach") return async (debuggee) => {
          const result = await value.call(target, debuggee);
          __trackDebugger?.(debuggee, false);
          return result;
        };
        return typeof value === "function" ? value.bind(target) : value;
      }
    });
    const chrome = new Proxy(__nativeChrome, {
      get(target, property, receiver) {
        return property === "debugger" ? __debugger : Reflect.get(target, property, receiver);
      }
    });
    return await (async () => {
${code}
    })();
  })()`;
}

function evaluationError(response: any): Error | undefined {
  const details = response?.exceptionDetails;
  if (!details) return undefined;
  const description = details.exception?.description;
  const value = details.exception?.value;
  return new Error(typeof description === "string" ? description : typeof value === "string" ? value : details.text || "JavaScript execution failed");
}

function evaluationValue(response: any): unknown {
  const remote = response?.result;
  if (!remote || typeof remote !== "object") return remote;
  return Object.prototype.hasOwnProperty.call(remote, "value") ? remote.value : remote;
}

export class ChromeExecutor {
  private readonly chromeApi: ExecutorChrome;
  private readonly targetUrl: string;
  private readonly logger?: EventLogger;
  private readonly trackedDebuggees = new Map<string, Debuggee>();
  private tail: Promise<void> = Promise.resolve();
  private initialized?: Promise<void>;
  private activeDebuggee?: Debuggee;
  private disposed = false;
  private readonly trackDebugger = (debuggee: Debuggee, attached: boolean): void => {
    const key = debuggeeKey(debuggee);
    if (attached) this.trackedDebuggees.set(key, { ...debuggee });
    else this.trackedDebuggees.delete(key);
  };

  constructor(options: { chromeApi?: ExecutorChrome; targetUrl?: string; logger?: EventLogger } = {}) {
    this.chromeApi = options.chromeApi ?? globalThis.chrome as ExecutorChrome;
    this.targetUrl = options.targetUrl ?? ensureSidePanelInstanceUrl();
    this.logger = options.logger;
    if (!this.chromeApi?.debugger) throw new Error("Chrome extension debugger API is unavailable");
    (globalThis as Record<string, unknown>)[TRACK_DEBUGGER_KEY] = this.trackDebugger;
  }

  execute(input: ChromeToolInput, signal?: AbortSignal): Promise<unknown> {
    const task = this.tail.then(() => this.executeNow(input, signal));
    this.tail = task.then(() => undefined, () => undefined);
    return task;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if ((globalThis as Record<string, unknown>)[TRACK_DEBUGGER_KEY] === this.trackDebugger) {
      delete (globalThis as Record<string, unknown>)[TRACK_DEBUGGER_KEY];
    }
    const sessions = [this.activeDebuggee, ...this.trackedDebuggees.values()].filter((item): item is Debuggee => Boolean(item));
    this.activeDebuggee = undefined;
    this.trackedDebuggees.clear();
    for (const debuggee of sessions) void this.chromeApi.debugger.detach(debuggee).catch(() => undefined);
    void snapshotUserScripts({ chromeApi: this.chromeApi, logger: this.logger }).catch(() => undefined);
  }

  private async initialize(): Promise<void> {
    this.initialized ??= restoreUserScripts({ chromeApi: this.chromeApi, logger: this.logger }).then(() => undefined);
    return this.initialized;
  }

  private async executeNow(input: ChromeToolInput, signal?: AbortSignal): Promise<unknown> {
    if (this.disposed) throw new Error("Chrome executor has been disposed");
    throwIfAborted(signal);
    await this.initialize();
    throwIfAborted(signal);

    const targets = await this.chromeApi.debugger.getTargets();
    const target = targets.find((candidate) => candidate.url === this.targetUrl && candidate.id);
    if (!target?.id) throw new Error(`Side Panel DevTools target not found: ${this.targetUrl}`);
    const debuggee: Debuggee = { targetId: target.id };
    await this.chromeApi.debugger.attach(debuggee, "1.3");
    this.activeDebuggee = debuggee;

    let rejectAbort: ((error: DOMException) => void) | undefined;
    const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
    const onAbort = () => {
      void this.chromeApi.debugger.detach(debuggee).catch(() => undefined);
      rejectAbort?.(abortError());
    };
    try {
      signal?.addEventListener("abort", onAbort, { once: true });
      throwIfAborted(signal);
      const evaluation = this.chromeApi.debugger.sendCommand(debuggee, "Runtime.evaluate", {
        expression: expressionFor(input.code),
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      });
      const response = signal
        ? await Promise.race([evaluation, aborted])
        : await evaluation;
      throwIfAborted(signal);
      const error = evaluationError(response);
      if (error) throw error;
      return evaluationValue(response);
    } finally {
      signal?.removeEventListener("abort", onAbort);
      await snapshotUserScripts({ chromeApi: this.chromeApi, logger: this.logger });
      await this.chromeApi.debugger.detach(debuggee).catch(() => undefined);
      if (this.activeDebuggee === debuggee) this.activeDebuggee = undefined;
    }
  }
}
