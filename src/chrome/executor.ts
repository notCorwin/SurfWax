import type { EventLogger } from "../logging";
import type { BrowserTarget, PageExecutionTarget } from "../types";
import { AutomationRuntime, FILE_UPLOAD_FUNCTION, LocatorFacade } from "./automation";
import { requireDebuggee } from "./debuggee";
import { downloadArtifact } from "./downloads";
import { listDownloads as queryDownloads, type DownloadListInput } from "./download-query";
import { BrowserDiagnostics } from "./diagnostics";
import { getRunIdentity, type RunIdentity } from "../agent/coordinator";
import { BrowserJobs, type JobQuery } from "./jobs";
import { ProgramScope, type OperationObserver } from "./program";
import { ForegroundBlockers, type BlockerJob, type BlockerOperation } from "./foreground-blockers";
import type { InspectOptions } from "./automation";
import { callUserScript } from "./script-client";
import { executeSandboxProgram } from "./program-host";
import { estimateProgramTimeoutMs } from "./program-timeout";
import { EventSubscriptions, type BrowserEventKind, type EventOwner } from "./event-subscriptions";

type Debuggee = chrome.debugger.Debuggee & { sessionId?: string };
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
type ExecutionContext = { runSignal?: AbortSignal; conversationId?: string; toolCallId?: string; visualEnabled?: boolean; logIdentity?: { runId?: string; toolCallId: string; toolCallIdCanonical: true } };
type ArtifactRef = { id: number; filename: string; mimeType: string; byteLength: number; saved: boolean; downloadId?: number };
type BrowserState = { windowId: number; tabId?: number };
type ProgramPages = { get(tabId: number, initial?: any): Promise<any>; invalidate(tabId: number): void; dispose(): void };
export type BrowserContext = {
  windowId: number;
  tabs: Array<{ index: number; tabId?: number; windowId?: number; current: boolean; title?: string; url?: string }>;
};

function dialogSourceKey(source: Debuggee): string {
  return JSON.stringify([source.tabId, source.sessionId ?? null]);
}

function abortError(): DOMException {
  return new DOMException("Operation aborted", "AbortError");
}

function interruptionError(signal: AbortSignal, effectUnknown = false): DOMException {
  const reason = signal.reason;
  const error = reason instanceof DOMException && reason.name === "TimeoutError"
    ? new DOMException(reason.message, "TimeoutError")
    : new DOMException(reason instanceof Error ? reason.message : reason === undefined ? "Operation aborted" : String(reason), "AbortError");
  if (effectUnknown) Object.assign(error, { effectUnknown: true });
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw interruptionError(signal);
}

function readQuoted(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"')) return JSON.parse(trimmed);
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, "\\");
  throw new Error(`AutomationError[invalid-target]: Expected a quoted locator argument: ${value}`);
}

export function parseLocatorTarget(value: unknown): BrowserTarget {
  if (value && typeof value === "object") return value as BrowserTarget;
  if (typeof value !== "string" || !value.trim()) throw new Error("AutomationError[invalid-target]: target is required");
  const input = value.trim();
  if (/^(?:t\d+s[a-f0-9]+d\d+)?e\d+$/.test(input)) return { ref: input };
  const locator = /^locator\((.+)\)$/.exec(input);
  if (locator) return { by: "css", value: readQuoted(locator[1]!) };
  const simple = /^getBy(Text|Label|Placeholder|AltText|Title|TestId)\((['"][\s\S]*?['"])(?:\s*,\s*\{([\s\S]*)\})?\)$/.exec(input);
  if (simple) {
    const by = ({ Text: "text", Label: "label", Placeholder: "placeholder", AltText: "alt", Title: "title", TestId: "testId" } as const)[simple[1] as "Text"];
    const options = simple[3]?.trim();
    if (options && !/^exact\s*:\s*(?:true|false)$/.test(options)) throw new Error(`AutomationError[invalid-target]: Unsupported locator expression ${JSON.stringify(input)}; use a structured target or run`);
    return { by, value: readQuoted(simple[2]!), ...(options ? { exact: /true$/.test(options) } : {}) };
  }
  const role = /^getByRole\((['"][\s\S]*?['"])(?:\s*,\s*\{([\s\S]*)\})?\)$/.exec(input);
  if (role) {
    const options = role[2] ?? "";
    const name = /\bname\s*:\s*(['"][\s\S]*?['"])(?:\s*,|$)/.exec(options)?.[1];
    const unsupportedOptions = options.replace(/\bname\s*:\s*(['"][\s\S]*?['"])/, "").replace(/\bexact\s*:\s*(?:true|false)/, "").replace(/[\s,]/g, "");
    if (unsupportedOptions) throw new Error(`AutomationError[invalid-target]: Unsupported locator expression ${JSON.stringify(input)}; use a structured target or run`);
    return { by: "role", value: readQuoted(role[1]!), ...(name ? { name: readQuoted(name) } : {}), ...(/\bexact\s*:\s*true\b/.test(options) ? { exact: true } : {}) };
  }
  if (/^[A-Za-z_$][\w$]*\s*\(/.test(input)) throw new Error(`AutomationError[invalid-target]: Unsupported locator expression ${JSON.stringify(input)}; use a structured target or run`);
  return { by: "css", value: input };
}

function timestamped(prefix: string, extension: string): string {
  return `${prefix}-${new Date().toISOString().replace(/[:.]/g, "-")}.${extension}`;
}

function base64ByteLength(base64: string): number {
  return Math.floor(base64.length * 3 / 4) - (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0);
}

function resultEnvelope(): string {
  return `
    globalThis.__surfWaxObject ??= (id) => {
      const values = globalThis[${JSON.stringify(RESULTS_KEY)}];
      if (!values?.has(id)) throw new Error("Object reference expired with its execution context or document");
      return values.get(id);
    };
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

function evaluationValue(response: any, scope = "extension"): unknown {
  const remote = response?.result;
  if (!remote || typeof remote !== "object") return remote;
  const result = remote.value;
  if (result?.kind === "value") return result.value;
  if (result?.kind === "reference") return {
    $ref: result.id,
    ref: result.id,
    type: result.type,
    preview: result.preview,
    access: `globalThis.__surfWaxObject(${JSON.stringify(result.id)})`,
    host: scope,
    contextId: scope,
    expiresAt: null,
    scope,
  };
  return Object.prototype.hasOwnProperty.call(remote, "value") ? result : remote;
}

export class ChromeExecutor {
  private readonly chromeApi: ExecutorChrome;
  private readonly logger?: EventLogger;
  private port?: chrome.runtime.Port;
  private readonly bridge: Record<string, unknown>;
  private readonly automation: AutomationRuntime;
  private tail: Promise<void> = Promise.resolve();
  private readonly bridgedDebuggees = new Set<string>();
  private disposed = false;
  private activeSignal?: AbortSignal;
  private activeContext: ExecutionContext = {};
  private browserState?: BrowserState;
  private endingRun?: Promise<void>;
  private runFinishing?: Promise<void>;
  private readonly diagnostics: BrowserDiagnostics;
  private readonly networkEnabled = new Set<number>();
  private readonly eventSubscriptions = new EventSubscriptions();
  private readonly chooserHandles = new WeakMap<object, string>();
  private eventOwner?: EventOwner;
  private eventLease?: RunIdentity;
  private eventEpoch = 0;
  private readonly readRunIdentity: () => RunIdentity | undefined;
  private readonly dialogQueues = new Map<string, string[]>();
  private popupListener?: (tab: chrome.tabs.Tab) => void;
  private tabRemovedListener?: (tabId: number) => void;
  private readonly heldInput = new Map<number, { x: number; y: number; buttons: Set<string>; keys: Map<string, Record<string, unknown>> }>();
  private readonly jobs: BrowserJobs;
  private readonly blockerContexts = new Map<string, { context: ExecutionContext; owner: EventOwner }>();
  private readonly blockers = new ForegroundBlockers(async (evidence) => {
    const item = this.blockerContexts.get(evidence.jobId);
    if (!item || !this.logger) throw new Error("Blocker job no longer exists");
    this.runOwnerFor(item.context);
    const event = await this.logger.append({ type: "browser.job.progress", conversationId: evidence.owner.conversationId,
      ...item.context.logIdentity, content: { jobId: evidence.jobId, operation: "dialog-blocked", state: "blocked", dialogId: evidence.dialog.dialogId, source: evidence.dialog.source }, output: evidence });
    if (!event) throw new Error("Could not persist dialog blocker evidence");
    return event.id;
  });
  private readonly pendingBackground = new Map<string, { conversationId: string; terminalObserved: boolean }>();
  private backgroundEpoch = 0;
  private programScope?: ProgramScope;
  private readonly programEvaluations = new Map<string, { debuggee: Debuggee; count: number }>();
  private readonly programHost: typeof executeSandboxProgram;

  constructor(options: { chromeApi?: ExecutorChrome; logger?: EventLogger; programHost?: typeof executeSandboxProgram; runIdentity?: () => RunIdentity | undefined } = {}) {
    this.readRunIdentity = options.runIdentity ?? getRunIdentity;
    this.chromeApi = options.chromeApi ?? globalThis.chrome as ExecutorChrome;
    this.logger = options.logger;
    this.jobs = new BrowserJobs(this.logger);
    this.programHost = options.programHost ?? executeSandboxProgram;
    this.diagnostics = new BrowserDiagnostics(this.logger);
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
      this.bridgedDebuggees.clear();
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
        if (["attach", "detach", "sendCommand"].includes(method)) requireDebuggee(args[0], method);
        const port = this.port ?? connect();
        if (!port) {
          return Reflect.apply((this.chromeApi.debugger as any)[method], this.chromeApi.debugger, args);
        }
        return new Promise((resolve, reject) => {
          const id = globalThis.crypto.randomUUID();
          pending.set(id, { resolve, reject });
          try { port.postMessage({ id, method, args, ...getRunIdentity(), operationId: crypto.randomUUID() }); }
          catch (error) {
            disconnect(port, error instanceof Error ? error : new Error(String(error)));
            try { port.disconnect(); } catch { /* The extension context may already be gone. */ }
            reject(error);
          }
        });
      },
    };
    this.automation = new AutomationRuntime({
      chromeApi: this.chromeApi,
      command: (debuggee, method, params) => {
        const releaseInput = method === "Input.dispatchMouseEvent" && (params as { type?: string } | undefined)?.type === "mouseReleased"
          || method === "Input.dispatchKeyEvent" && (params as { type?: string } | undefined)?.type === "keyUp";
        if (method !== "Input.cancelDragging" && method !== "Runtime.releaseObjectGroup" && !releaseInput) throwIfAborted(this.activeSignal);
        return this.bridgeCommand(debuggee, method, params);
      },
      atomicClick: typeof this.chromeApi.runtime?.connect === "function" ? (debuggee, params) => {
        throwIfAborted(this.activeSignal);
        return this.bridgeCommand(debuggee, "Input.dispatchMouseEvent", { ...params, type: "mousePressed", surfWaxAtomicClick: true });
      } : undefined,
      hitTest: typeof this.chromeApi.runtime?.connect === "function" ? (debuggee, params) => {
        throwIfAborted(this.activeSignal);
        return this.bridgeCommand(debuggee, "Runtime.callFunctionOn", { ...params, surfWaxHitTest: true });
      } : undefined,
      detach: async (debuggee) => {
        await (this.bridge.call as any)("detach", [debuggee]);
        this.bridgedDebuggees.delete(JSON.stringify(debuggee));
      },
      mark: async (tabId) => (globalThis as Record<string, any>).__surfWaxGuard?.mark(tabId),
      refreshGuard: async (tabId) => (globalThis as Record<string, any>).__surfWaxGuard?.refresh(tabId),
      onDispatch: () => this.programScope?.dispatched() ?? Promise.resolve(),
      claimChooser: (chooser) => {
        const owner = this.eventOwner;
        if (!owner) return undefined;
        const id = this.chooserHandles.get(chooser);
        if (!id) throw new Error("CommandError[stale-chooser]: File chooser was not captured in this run");
        const claim = this.eventSubscriptions.claimChooser(owner, id);
        const epoch = this.eventEpoch;
        return {
          assert: () => {
            if (epoch !== this.eventEpoch || this.disposed || this.eventOwner !== owner) throw new Error("CommandError[event-owner-expired]: File chooser run expired");
            this.eventSubscriptions.assertChooserClaim(owner, claim.id, claim.claimId);
          },
          finish: (outcome) => this.eventSubscriptions.finishChooser(owner, claim.id, claim.claimId, outcome),
        };
      },
      respondDialog: async (id, _source, accept, prompt) => {
        if (!id) throw new Error("CommandError[dialog-unavailable]: Dialog was not captured in this run");
        await this.programScope?.dispatched();
        return this.handleDialog({ dialogId: id, accept, ...(prompt === undefined ? {} : { prompt }) }, this.activeSignal, this.activeContext);
      },
      logger: this.logger,
    });
    listeners.onEvent.add((source, method, params) => {
      if (method === "Page.javascriptDialogOpening") {
        // Register the exact dialog before resolving program waiters so their
        // handles cannot accidentally respond to a later dialog on this source.
        const captured = { ...params };
        void this.handleCommandEvent(source, method, captured);
        this.automation.handleEvent(source, method, captured);
      } else {
        this.automation.handleEvent(source, method, params);
        void this.handleCommandEvent(source, method, params);
      }
    });
    listeners.onDetach.add((source) => {
      this.bridgedDebuggees.delete(JSON.stringify(source));
      this.automation.handleDetach(source);
      if (this.eventOwner && Number.isInteger(source.tabId)) {
        if (!source.sessionId) this.closeEventTab(source.tabId!, "debugger-detached");
        else this.closeEventSource(source.tabId!, source.sessionId);
      }
      if (Number.isInteger(source.tabId)) {
        if (source.sessionId) this.diagnostics.handle({ tabId: source.tabId }, "Target.detachedFromTarget", { sessionId: source.sessionId });
        else this.diagnostics.remove(source.tabId!);
      }
    });
    (globalThis as Record<string, unknown>)[BRIDGE_KEY] = this.bridge;
  }

  inspect(input: InspectOptions & { tabId?: number; region?: unknown; image?: boolean; timeoutMs?: number }, signal?: AbortSignal, context: ExecutionContext = {}): Promise<unknown> {
    return this.enqueueAbortable(async (combined) => {
      this.activeSignal = combined; this.activeContext = context;
      this.automation.setContext({ ...context, signal: combined });
      try {
        const state = await this.currentBrowserState();
        const page = input.tabId === undefined ? await this.pageFor(state) : await this.boundPage(input.tabId, state);
        if (input.image) {
          if (!context.visualEnabled) throw new Error("AutomationError[visual-unavailable]: Image input is disabled or unsupported by the selected model");
          return await this.captureScreenshot(page, { target: input.region });
        }
        const region = input.region === undefined ? undefined : this.locatorFor(page, input.region);
        return await page.inspect(input, region);
      } finally { this.activeSignal = undefined; this.activeContext = {}; await this.automation.clearContext(); }
    }, signal, input.timeoutMs, false);
  }

  listFrames(input: { tabId?: number; cursor?: string; limit?: number; timeoutMs?: number }, signal?: AbortSignal, context: ExecutionContext = {}): Promise<unknown> {
    const signals = [signal, context.runSignal].filter((item): item is AbortSignal => item !== undefined);
    const effectiveSignal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
    return this.enqueueAbortable(async (combined) => {
      this.activeSignal = combined; this.activeContext = context;
      this.automation.setContext({ ...context, signal: combined });
      try {
        const state = await this.currentBrowserState();
        throwIfAborted(combined);
        const page = input.tabId === undefined ? await this.pageFor(state) : await this.boundPage(input.tabId, state);
        throwIfAborted(combined);
        return await this.automation.listFrames(page.tabId, { cursor: input.cursor, limit: input.limit });
      } finally { this.activeSignal = undefined; this.activeContext = {}; await this.automation.clearContext(); }
    }, effectiveSignal, input.timeoutMs, false);
  }

  findElements(input: { target: unknown; tabId?: number; cursor?: string; limit?: number; timeoutMs?: number }, signal?: AbortSignal, context: ExecutionContext = {}): Promise<unknown> {
    const signals = [signal, context.runSignal].filter((item): item is AbortSignal => item !== undefined);
    const effectiveSignal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
    return this.enqueueAbortable(async (combined) => {
      this.activeSignal = combined; this.activeContext = context;
      this.automation.setContext({ ...context, signal: combined });
      try {
        const state = await this.currentBrowserState();
        throwIfAborted(combined);
        const page = input.tabId === undefined ? await this.pageFor(state) : await this.boundPage(input.tabId, state);
        throwIfAborted(combined);
        const locator = this.locatorFor(page, input.target);
        if (!locator?.spec) throw new Error("AutomationError[invalid-target]: Search requires a locator target");
        return await this.automation.findElements(page.tabId, locator, { cursor: input.cursor, limit: input.limit });
      } finally { this.activeSignal = undefined; this.activeContext = {}; await this.automation.clearContext(); }
    }, effectiveSignal, input.timeoutMs, false);
  }

  async runProgram(input: { code: string; background?: boolean; timeoutMs?: number }, signal?: AbortSignal, context: ExecutionContext = {}): Promise<unknown> {
    if (!context.conversationId || !this.logger) throw new Error("Programs require a conversation and canonical event log");
    if (input.background) this.runOwnerFor(context);
    const epoch = this.backgroundEpoch;
    const jobContext = { conversationId: context.conversationId, logIdentity: context.logIdentity };
    const controller = new AbortController();
    const forwardTool = () => controller.abort(signal?.reason);
    const forwardRun = () => controller.abort(context.runSignal?.reason);
    if (signal) { if (signal.aborted) forwardTool(); else signal.addEventListener("abort", forwardTool, { once: true }); }
    if (context.runSignal) { if (context.runSignal.aborted) forwardRun(); else context.runSignal.addEventListener("abort", forwardRun, { once: true }); }
    const cleanupSignals = () => { signal?.removeEventListener("abort", forwardTool); context.runSignal?.removeEventListener("abort", forwardRun); };
    const jobSignal = controller.signal;
    let blocker: BlockerJob | undefined;
    let ready!: (job: BlockerJob | undefined) => void;
    const blockerReady = new Promise<BlockerJob | undefined>((resolve) => { ready = resolve; });
    const timeoutMs = input.timeoutMs ?? estimateProgramTimeoutMs(input.code);
    const id = await this.awaitAbort(this.jobs.start(jobContext, jobSignal, (combined, jobId, started) => this.enqueueAbortable(async (deadline) => {
      if (this.disposed) throw new Error("Chrome executor has been disposed");
      if (input.background) this.runOwnerFor(context);
      await started();
      (deadline ?? combined).throwIfAborted();
      const lifetime = new AbortController();
      const programSignal = AbortSignal.any([deadline ?? combined, lifetime.signal]);
      this.activeSignal = programSignal; this.activeContext = context;
      this.automation.setContext({ ...context, signal: programSignal }); this.diagnostics.bind(context);
      let owner: EventOwner | undefined;
      if (this.eventLease) {
        owner = this.eventOwnerFor(context, true);
        this.ensureEventListeners("dialog");
        if (!input.background) {
          blocker = this.blockers.begin(owner, jobId);
          this.blockerContexts.set(jobId, { context, owner });
        }
      }
      ready(blocker);
      const checkDialog = (source: { tabId: number }) => {
        const dialog = owner && this.blockers.knownDialogs(owner, source.tabId)[0];
        if (dialog) throw new Error(`CommandError[dialog-open]: Dialog ${dialog.dialogId} is open in tab ${source.tabId}; handle it before dispatching`);
      };
      const observer: OperationObserver | undefined = owner && blocker ? {
        start: (operation, source) => { checkDialog(source); return this.blockers.startOperation(blocker!, operation, source); },
        dispatched: (handle, source) => { checkDialog(source); this.blockers.markDispatched(handle as BlockerOperation, source); },
        end: (handle) => this.blockers.endOperation(handle as BlockerOperation),
      } : undefined;
      const scope = new ProgramScope(programSignal, jobId, jobContext, this.logger!, observer);
      this.programScope = scope;
      let pages: ProgramPages | undefined;
      let stoppedBrowser = false;
      const stopBrowser = async () => {
        if (stoppedBrowser) return;
        stoppedBrowser = true;
        await this.stopBrowserOperations();
      };
      try {
        scope.guard();
        const state = await this.currentBrowserState();
        let raw: Awaited<ReturnType<ChromeExecutor["pageFor"]>>;
        if (Number.isSafeInteger(state.tabId)) {
          await scope.call("page.bind", async () => { raw = await this.pageFor(state); return { tabId: raw.tabId }; }, false, false, false, false, { tabId: state.tabId! });
        } else raw = await this.pageFor(state);
        pages = this.programPages(scope, state);
        const page = await pages.get(raw!.tabId, raw);
        const capabilities = this.programCapabilities(page, state, scope, pages);
        scope.guard();
        if (input.background) this.runOwnerFor(context);
        const result = await this.programHost(input.code, capabilities, programSignal);
        // User code may abandon a losing Promise.race branch. Revoke its
        // capabilities before terminating in-flight browser work.
        const requiresStop = scope.hasPending || scope.effectUnknown;
        scope.revoke(); lifetime.abort("program-ended");
        if (requiresStop) await stopBrowser();
        await scope.finish(); (deadline ?? combined).throwIfAborted();
        if (scope.effectUnknown) throw Object.assign(new Error("Program finished with uncertain browser effects; inspect the page before continuing"), { effectUnknown: true });
        return result;
      } catch (error) {
        const requiresStop = programSignal.aborted || scope.hasPending || scope.effectUnknown
          || Boolean(error && typeof error === "object" && "effectUnknown" in error && error.effectUnknown);
        scope.revoke(); lifetime.abort("program-ended");
        if (requiresStop) await stopBrowser();
        else await this.releaseHeldInputs();
        await scope.finish();
        const failure = error && typeof error === "object" ? error
          : Object.assign(new DOMException(String(error ?? programSignal.reason ?? "Operation aborted"), programSignal.aborted ? "AbortError" : "Error"), { cause: error });
        if (scope.effectUnknown) Object.assign(failure, { effectUnknown: true });
        throw failure;
      } finally {
        pages?.dispose();
        scope.revoke(); lifetime.abort("program-ended");
        if (blocker) this.blockers.settle(blocker);
        this.blockerContexts.delete(jobId);
        if (this.programScope === scope) this.programScope = undefined;
        this.activeSignal = undefined; this.activeContext = {};
        await this.automation.clearContext();
      }
    }, combined, timeoutMs, false, true)), controller.signal).catch((error) => { cleanupSignals(); throw error; });
    if (input.background) {
      try {
        controller.signal.throwIfAborted();
        if (this.disposed || epoch !== this.backgroundEpoch) throw new DOMException("Run ended before the background job was accepted", "AbortError");
        this.runOwnerFor(context);
      } catch (error) { controller.abort(error); cleanupSignals(); throw error; }
      signal?.removeEventListener("abort", forwardTool);
      void this.jobs.waitForOwner(id, context.conversationId).then(cleanupSignals, cleanupSignals);
      this.pendingBackground.set(id, { conversationId: context.conversationId, terminalObserved: false });
      return { jobId: id, state: "queued", accepted: true, complete: false, timeoutMs, timeoutSource: input.timeoutMs === undefined ? "estimated" : "explicit" };
    }
    const completion = this.jobs.completion(id, context.conversationId) as Promise<any>;
    void completion.then(cleanupSignals, cleanupSignals);
    const outcome = await this.awaitAbort(Promise.race([
      completion.then((status) => ({ kind: "complete" as const, status })),
      blockerReady.then(async (job) => job ? { kind: "blocker" as const, value: await this.blockers.wait(job) } : { kind: "complete" as const, status: await completion }),
    ]), controller.signal);
    if (outcome.kind === "blocker" && outcome.value.status === "blocked") {
      signal?.throwIfAborted();
      context.runSignal?.throwIfAborted();
      this.runOwnerFor(context);
      if (this.disposed || epoch !== this.backgroundEpoch) throw new DOMException("Run ended before the job was accepted", "AbortError");
      signal?.removeEventListener("abort", forwardTool);
      this.pendingBackground.set(id, { conversationId: context.conversationId, terminalObserved: false });
      return { jobId: id, state: "blocked", accepted: true, complete: false, blockedBy: { kind: "dialog", ...outcome.value.dialog, evidenceId: outcome.value.evidenceId }, timeoutMs, timeoutSource: input.timeoutMs === undefined ? "estimated" : "explicit" };
    }
    if (outcome.kind === "blocker" && outcome.value.status === "persistence-failed") {
      controller.abort(outcome.value.error);
      throw Object.assign(new Error("Could not persist dialog blocker evidence"), { cause: outcome.value.error, effectUnknown: true });
    }
    const status = outcome.kind === "complete" ? outcome.status : await completion;
    if (!status.terminal) throw new Error("CommandError[job-not-terminal]: Program host ended without a terminal receipt");
    return { jobId: id, ok: status.ok, state: status.state, result: status.result, timeoutMs, timeoutSource: input.timeoutMs === undefined ? "estimated" : "explicit", receipts: { tool: "get_job", jobId: id, after: 0 } };
  }

  pendingBackgroundJobs(): readonly string[] {
    return [...this.pendingBackground.keys()];
  }

  acknowledgeBackgroundJob(jobId: string, conversationId: string): boolean {
    const pending = this.pendingBackground.get(jobId);
    if (!pending || pending.conversationId !== conversationId || !pending.terminalObserved) return false;
    return this.pendingBackground.delete(jobId);
  }

  async queryJobs(input: JobQuery, signal?: AbortSignal, context: ExecutionContext = {}): Promise<unknown> {
    if (!context.conversationId) throw new Error("Jobs require a conversation");
    // Deliberately bypass tail: a running program must never block status/wait/cancel.
    const result = await this.jobs.query(input, context.conversationId, signal);
    const pending = input.id ? this.pendingBackground.get(input.id) : undefined;
    if (input.action !== "list" && pending?.conversationId === context.conversationId
      && result && typeof result === "object" && "terminal" in result && result.terminal === true) pending.terminalObserved = true;
    return result;
  }

  async readArtifact(input: { artifactId: number; path?: (string | number)[]; offset?: number; limit?: number; timeoutMs?: number }, signal?: AbortSignal, context: ExecutionContext = {}): Promise<unknown> {
    if (!this.logger || !context.conversationId) throw new Error("Artifacts require a conversation and canonical event log");
    const timeout = input.timeoutMs === undefined ? undefined : new AbortController();
    const deadline = input.timeoutMs === undefined ? undefined : Date.now() + input.timeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      if (!timeout || deadline === undefined) return;
      const remaining = deadline - Date.now();
      if (remaining <= 0) timeout.abort(new DOMException(`Artifact read timed out after ${input.timeoutMs}ms`, "TimeoutError"));
      else timer = setTimeout(schedule, Math.min(remaining, 2_147_483_647));
    };
    schedule();
    const signals = [signal, context.runSignal, timeout?.signal].filter((item): item is AbortSignal => item !== undefined);
    const combined = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
    try {
      throwIfAborted(combined);
      const result = await this.awaitAbort(this.logger.result(input.artifactId, { path: input.path, offset: input.offset, limit: input.limit }, context.conversationId), combined);
      return { ok: true, result };
    } finally { if (timer !== undefined) clearTimeout(timer); }
  }

  listDownloads(input: DownloadListInput, signal?: AbortSignal): Promise<unknown> {
    return queryDownloads(this.chromeApi, input, signal);
  }

  private runOwnerFor(context: ExecutionContext): EventOwner {
    const runId = context.logIdentity?.runId;
    if (!context.conversationId || !runId) throw new Error("CommandError[event-owner-unavailable]: Event subscriptions require a conversation and active run");
    const identity = this.readRunIdentity();
    const lease = this.eventLease;
    if (!identity || !lease || identity.runId !== runId || lease.runId !== runId || identity.ownerId !== lease.ownerId || identity.generation !== lease.generation)
      throw new Error("CommandError[event-owner-expired]: Event run ownership expired");
    return { conversationId: context.conversationId, runId };
  }

  private eventOwnerFor(context: ExecutionContext, initialize = false): EventOwner {
    const owner = this.runOwnerFor(context);
    if (this.eventOwner && (this.eventOwner.conversationId !== owner.conversationId || this.eventOwner.runId !== owner.runId)) throw new Error("CommandError[event-owner-expired]: Event run ownership expired");
    if (initialize && !this.eventOwner) this.eventOwner = owner;
    return owner;
  }

  private ensureEventListeners(kind: BrowserEventKind): void {
    if (kind === "popup" && !this.popupListener) {
      if (!this.chromeApi.tabs?.onCreated) throw new Error("CommandError[event-unavailable]: Popup events are unavailable");
      this.popupListener = (tab) => {
        const owner = this.eventOwner;
        if (!owner || !Number.isInteger(tab.id) || !Number.isInteger(tab.openerTabId)) return;
        this.eventSubscriptions.publish(owner, { kind: "popup", source: { tabId: tab.openerTabId! }, payload: { tabId: tab.id, windowId: tab.windowId, url: tab.url } });
      };
      this.chromeApi.tabs.onCreated.addListener(this.popupListener);
    }
    if (!this.tabRemovedListener && this.chromeApi.tabs?.onRemoved) {
      this.tabRemovedListener = (tabId) => this.closeEventTab(tabId, "tab-closed");
      this.chromeApi.tabs.onRemoved.addListener(this.tabRemovedListener);
    }
  }

  subscribeEvent(input: { tabId?: number; kind: BrowserEventKind; timeoutMs?: number }, signal?: AbortSignal, context: ExecutionContext = {}): Promise<unknown> {
    const epoch = this.eventEpoch;
    return this.enqueueAbortable(async (combined) => {
      const owner = this.eventOwnerFor(context);
      const state = await this.currentBrowserState();
      throwIfAborted(combined);
      const tabId = input.tabId ?? state.tabId;
      if (!Number.isInteger(tabId)) throw new Error("CommandError[no-bound-tab]: Select a tab before subscribing");
      if (input.tabId === undefined) await this.pageFor(state); else await this.boundPage(tabId!, state);
      throwIfAborted(combined);
      const tab = await this.chromeApi.tabs.get(tabId!).catch(() => undefined);
      throwIfAborted(combined);
      if (!tab) throw new Error("CommandError[invalid-tab-id]: Tab closed before event subscription");
      if (this.eventEpoch !== epoch || this.disposed) throw new Error("CommandError[event-owner-expired]: Event run ownership expired");
      this.eventOwnerFor(context, true);
      this.ensureEventListeners(input.kind);
      const subscription = this.eventSubscriptions.subscribe({ owner, tabId: tabId!, kinds: [input.kind] });
      return { ...subscription, tabId, kind: input.kind };
    }, signal, input.timeoutMs, false);
  }

  waitEvent(input: { subscriptionId: string; after?: number; limit?: number; waitMs?: number }, signal?: AbortSignal, context: ExecutionContext = {}): Promise<unknown> {
    const owner = this.eventOwnerFor(context);
    return this.eventSubscriptions.read({ owner, ...input, signal });
  }

  async unsubscribeEvent(input: { subscriptionId: string }, signal?: AbortSignal, context: ExecutionContext = {}): Promise<unknown> {
    throwIfAborted(signal);
    const owner = this.eventOwnerFor(context);
    this.eventSubscriptions.unsubscribe(owner, input.subscriptionId);
    return { subscriptionId: input.subscriptionId, closed: "unsubscribed" };
  }

  async handleDialog(input: { dialogId: string; accept: boolean; prompt?: string }, signal?: AbortSignal, context: ExecutionContext = {}): Promise<unknown> {
    const signals = [signal, context.runSignal].filter((item): item is AbortSignal => item !== undefined);
    const combined = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
    throwIfAborted(combined);
    const owner = this.eventOwnerFor(context);
    if (!this.logger || !context.logIdentity) throw new Error("CommandError[dialog-log-unavailable]: Dialog handling requires a canonical event log");
    const dialog = this.eventSubscriptions.claimDialog(owner, input.dialogId);
    let dispatched = false;
    let handled = false;
    let intent: Promise<unknown> | undefined;
    const progress = (state: string) => ({ type: "browser.dialog.progress" as const, conversationId: owner.conversationId, ...context.logIdentity,
      content: { dialogId: dialog.id, claimId: dialog.claimId, source: dialog.source, state, accept: input.accept } });
    try {
      if (input.prompt !== undefined && (!input.accept || dialog.type !== "prompt")) throw new Error("CommandError[invalid-dialog-prompt]: prompt is only valid when accepting a prompt dialog");
      intent = this.logger.append(progress("dispatched-unknown"));
      const receipt = await this.awaitAbort(intent, combined);
      if (!receipt) throw new DOMException("Could not persist dialog dispatch intent", "AbortError");
      throwIfAborted(combined);
      this.eventOwnerFor(context);
      if (!this.eventOwner || this.disposed) throw new Error("CommandError[event-owner-expired]: Event run ownership expired");
      // A dialog can close while persistence is pending. Check its exact claim
      // immediately before sending; never target a later dialog on this source.
      this.eventSubscriptions.assertDialogClaim(owner, dialog.id, dialog.claimId);
      const params = { accept: input.accept, ...(input.prompt === undefined ? {} : { promptText: input.prompt }) };
      dispatched = true;
      const pending = (this.bridge.call as any)("sendCommand", [dialog.source, "Page.handleJavaScriptDialog", params]) as Promise<unknown>;
      await this.awaitAbort(pending, combined, true);
      this.eventSubscriptions.finishDialog(owner, dialog.id, dialog.claimId, "handled");
      handled = true;
      const finished = await this.awaitAbort(this.logger.append(progress("completed")), combined, true);
      if (!finished) throw new Error("Could not persist dialog completion");
      return { dialogId: dialog.id, accepted: input.accept, state: "completed" };
    } catch (error) {
      if (!handled) this.eventSubscriptions.finishDialog(owner, dialog.id, dialog.claimId, dispatched ? "uncertain" : "not-dispatched");
      if (!dispatched && intent) {
        // An aborted intent may become durable later. Settle it after that write
        // with the same claim ID, without delaying an already cancelled call.
        const correction = intent.then((receipt) => receipt ? this.logger!.append(progress("not-dispatched")) : undefined).catch(() => undefined);
        if (!combined?.aborted) await this.awaitAbort(correction, combined);
      }
      if (dispatched && error && typeof error === "object") Object.assign(error, { effectUnknown: true });
      throw error;
    }
  }

  /** Reply outside the browser queue, handing off the live job if page handlers open a dialog. */
  async uploadChooser(input: { chooserId: string; artifactId: number | number[]; timeoutMs?: number }, signal?: AbortSignal, context: ExecutionContext = {}): Promise<unknown> {
    throwIfAborted(signal);
    const owner = this.eventOwnerFor(context);
    if (!this.logger || !context.logIdentity) throw new Error("CommandError[chooser-log-unavailable]: File chooser handling requires a canonical event log");
    const epoch = this.backgroundEpoch;
    const controller = new AbortController();
    const forwardTool = () => controller.abort(signal?.reason);
    const forwardRun = () => controller.abort(context.runSignal?.reason);
    if (signal) { if (signal.aborted) forwardTool(); else signal.addEventListener("abort", forwardTool, { once: true }); }
    if (context.runSignal) { if (context.runSignal.aborted) forwardRun(); else context.runSignal.addEventListener("abort", forwardRun, { once: true }); }
    const cleanupSignals = () => { signal?.removeEventListener("abort", forwardTool); context.runSignal?.removeEventListener("abort", forwardRun); };
    let ready!: (blocker: BlockerJob) => void;
    const blockerReady = new Promise<BlockerJob>((resolve) => { ready = resolve; });
    let result: unknown;
    let failure: unknown;
    let failed = false;
    let returned = false;
    let didDispatch = false;
    const wait = async <T>(task: Promise<T>): Promise<T> => {
      try { return await this.awaitAbort(task, controller.signal); }
      catch (error) {
        if (controller.signal.aborted && didDispatch && error && typeof error === "object") Object.assign(error, { effectUnknown: true });
        throw error;
      }
    };
    let id: string;
    try {
      id = await wait(this.jobs.start({ conversationId: owner.conversationId, logIdentity: context.logIdentity }, controller.signal, async (combined, jobId, started) => {
        let blocker: BlockerJob | undefined;
        try {
          await started();
          this.eventOwnerFor(context);
          blocker = this.blockers.begin(owner, jobId);
          this.blockerContexts.set(jobId, { context, owner });
          ready(blocker);
          result = await this.runChooserUpload(input, combined, context, blocker, () => { didDispatch = true; });
          returned = true;
          return result;
        } catch (error) {
          failed = true;
          failure = error;
          throw error;
        } finally {
          if (blocker) this.blockers.settle(blocker);
          this.blockerContexts.delete(jobId);
        }
      }));
    } catch (error) { cleanupSignals(); throw error; }
    const completion = this.jobs.completion(id, owner.conversationId);
    void completion.then(cleanupSignals, cleanupSignals);
    const outcome = await wait(Promise.race([
      completion.then(() => ({ kind: "complete" as const })),
      blockerReady.then(async (blocker) => ({ kind: "blocker" as const, value: await this.blockers.wait(blocker) })),
    ]));
    if (outcome.kind === "blocker" && outcome.value.status === "blocked") {
      if (signal?.aborted || context.runSignal?.aborted || this.disposed || epoch !== this.backgroundEpoch) {
        controller.abort(signal?.reason ?? context.runSignal?.reason ?? "run-ended");
        throw interruptionError(controller.signal, didDispatch);
      }
      try { this.runOwnerFor(context); }
      catch (error) {
        controller.abort(error);
        throw Object.assign(error instanceof Error ? error : new Error(String(error)), didDispatch ? { effectUnknown: true } : {});
      }
      signal?.removeEventListener("abort", forwardTool);
      this.pendingBackground.set(id, { conversationId: owner.conversationId, terminalObserved: false });
      return { jobId: id, state: "blocked", accepted: true, complete: false, blockedBy: { kind: "dialog", ...outcome.value.dialog, evidenceId: outcome.value.evidenceId } };
    }
    if (outcome.kind === "blocker" && outcome.value.status === "persistence-failed") {
      controller.abort(outcome.value.error);
      throw Object.assign(new Error("Could not persist dialog blocker evidence"), { cause: outcome.value.error, effectUnknown: true });
    }
    await wait(completion);
    if (failed) throw failure;
    if (controller.signal.aborted) throw Object.assign(abortError(), returned ? { effectUnknown: true } : {});
    return result;
  }

  private async runChooserUpload(input: { chooserId: string; artifactId: number | number[]; timeoutMs?: number }, signal: AbortSignal, context: ExecutionContext, blocker: BlockerJob, markDispatched: () => void): Promise<unknown> {
    throwIfAborted(signal);
    const owner = this.eventOwnerFor(context);
    if (!this.logger || !context.logIdentity) throw new Error("CommandError[chooser-log-unavailable]: File chooser handling requires a canonical event log");
    const ids = Array.isArray(input.artifactId) ? input.artifactId : [input.artifactId];
    if (!ids.length || ids.some((id) => !Number.isSafeInteger(id) || id < 1)) throw new Error("CommandError[invalid-artifact]: Artifact IDs must be positive integers");
    if (input.timeoutMs !== undefined && (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1)) throw new Error("CommandError[invalid-timeout]: timeoutMs must be positive");
    const chooser = this.eventSubscriptions.claimChooser(owner, input.chooserId);
    const openDialog = this.blockers.knownDialogs(owner, chooser.source.tabId)[0];
    if (openDialog) {
      this.eventSubscriptions.finishChooser(owner, chooser.id, chooser.claimId, "not-dispatched");
      throw new Error(`CommandError[dialog-open]: Dialog ${openDialog.dialogId} is open in tab ${chooser.source.tabId}; handle it before dispatching`);
    }
    const operation = this.blockers.startOperation(blocker, "upload_file", chooser.source);
    let dispatched = false;
    let claimOpen = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let resolveNode: Promise<any> | undefined;
    let intentReceipt: Promise<unknown> | undefined;
    const deadline = input.timeoutMs === undefined ? undefined : Date.now() + input.timeoutMs;
    const timeout = deadline === undefined ? undefined : new AbortController();
    const effectiveSignal = timeout ? signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal : signal;
    const scheduleTimeout = () => {
      if (deadline === undefined || !timeout) return;
      const remaining = deadline - Date.now();
      if (remaining <= 0) timeout.abort(new DOMException(`File chooser operation timed out after ${input.timeoutMs}ms`, "TimeoutError"));
      else timer = setTimeout(scheduleTimeout, Math.min(remaining, 2_147_483_647));
    };
    scheduleTimeout();
    const group = `surf-wax-chooser-${crypto.randomUUID()}`;
    const releaseGroup = () => (this.bridge.call as any)("sendCommand", [chooser.source, "Runtime.releaseObjectGroup", { objectGroup: group }]).catch(() => undefined);
    const guard = () => {
      throwIfAborted(effectiveSignal);
      this.eventOwnerFor(context);
      if (this.disposed || !this.eventOwner) throw new Error("CommandError[event-owner-expired]: File chooser run expired");
      this.eventSubscriptions.assertChooserClaim(owner, chooser.id, chooser.claimId);
    };
    try {
      if (chooser.mode !== "selectMultiple" && ids.length > 1) throw new Error("CommandError[invalid-file-count]: File chooser accepts only one file");
      const reads = new Map<number, Promise<unknown>>();
      for (const id of ids) if (!reads.has(id)) reads.set(id, this.logger.result(id, {}, owner.conversationId));
      const artifacts = await this.awaitAbort(Promise.all(ids.map((id) => reads.get(id)!)), effectiveSignal);
      guard();
      const files = artifacts.map((value) => {
        const artifact = value as { filename?: unknown; mimeType?: unknown; base64?: unknown } | null;
        if (!artifact || typeof artifact.filename !== "string" || typeof artifact.mimeType !== "string" || typeof artifact.base64 !== "string") throw new Error("CommandError[invalid-artifact]: The artifact has no available file bytes");
        return { name: artifact.filename, mimeType: artifact.mimeType, base64: artifact.base64 };
      });
      resolveNode = (this.bridge.call as any)("sendCommand", [chooser.source, "DOM.resolveNode", { backendNodeId: chooser.backendNodeId, objectGroup: group }]);
      const node = await this.awaitAbort(resolveNode!, effectiveSignal);
      guard();
      const objectId = node?.object?.objectId;
      if (typeof objectId !== "string") throw new Error("CommandError[stale-chooser]: File chooser input is no longer available");
      intentReceipt = this.logger.append({ type: "browser.chooser.progress", conversationId: owner.conversationId, ...context.logIdentity,
        content: { chooserId: chooser.id, source: chooser.source, artifactIds: ids, state: "dispatched-unknown" } });
      const receipt = await this.awaitAbort(intentReceipt, effectiveSignal);
      if (!receipt) throw new DOMException("Could not persist file chooser dispatch intent", "AbortError");
      guard();
      const dialog = this.blockers.knownDialogs(owner, chooser.source.tabId)[0];
      if (dialog) throw new Error(`CommandError[dialog-open]: Dialog ${dialog.dialogId} is open in tab ${chooser.source.tabId}; handle it before dispatching`);
      this.blockers.markDispatched(operation, chooser.source);
      dispatched = true;
      markDispatched();
      const pending = (this.bridge.call as any)("sendCommand", [chooser.source, "Runtime.callFunctionOn", {
        objectId, functionDeclaration: FILE_UPLOAD_FUNCTION, arguments: [{ value: files }], awaitPromise: true, returnByValue: true,
      }]) as Promise<any>;
      const response = await this.awaitAbort(pending, effectiveSignal, true);
      if (response?.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || "File upload failed");
      this.eventSubscriptions.finishChooser(owner, chooser.id, chooser.claimId, "handled");
      claimOpen = false;
      this.automation.forgetChooser(chooser.source, chooser.backendNodeId);
      const completed = await this.awaitAbort(this.logger.append({ type: "browser.chooser.progress", conversationId: owner.conversationId, ...context.logIdentity,
        content: { chooserId: chooser.id, source: chooser.source, artifactIds: ids, state: "completed" } }), effectiveSignal, true);
      if (!completed) throw new Error("Could not persist file chooser completion");
      return { chooserId: chooser.id, artifactIds: ids, state: "completed" };
    } catch (error) {
      if (claimOpen) this.eventSubscriptions.finishChooser(owner, chooser.id, chooser.claimId, dispatched ? "uncertain" : "not-dispatched");
      if (!dispatched && intentReceipt) {
        // The intent write may complete after cancellation. Serialize the
        // correction behind it so a late write cannot imply a dispatch.
        const correction = intentReceipt.then((receipt) => receipt ? this.logger!.append({ type: "browser.chooser.progress", conversationId: owner.conversationId, ...context.logIdentity,
          content: { chooserId: chooser.id, source: chooser.source, artifactIds: ids, state: "not-dispatched" } }) : undefined).catch(() => undefined);
        if (!effectiveSignal.aborted) await correction;
      }
      if (dispatched && error && typeof error === "object") Object.assign(error, { effectUnknown: true });
      throw error;
    } finally {
      this.blockers.endOperation(operation);
      if (timer !== undefined) clearTimeout(timer);
      // A cancelled resolve may complete late and create its remote object after
      // cleanup was requested; release only after that command has settled.
      if (resolveNode) void resolveNode.then(releaseGroup, releaseGroup);
    }
  }

  private closeEventSource(tabId: number, sessionId?: string): void {
    const owner = this.eventOwner;
    const key = dialogSourceKey({ tabId, ...(sessionId ? { sessionId } : {}) });
    const ids = this.dialogQueues.get(key) ?? [];
    if (owner) for (const id of ids) { this.eventSubscriptions.closeDialog(owner, id); this.blockers.closeDialog(owner, id); }
    if (owner) this.eventSubscriptions.closeChoosers(owner, tabId, sessionId);
    this.dialogQueues.delete(key);
  }

  private closeEventTab(tabId: number, reason: string): void {
    const owner = this.eventOwner;
    if (owner) this.eventSubscriptions.closeTab(owner, tabId, reason);
    for (const key of this.dialogQueues.keys()) if (JSON.parse(key)[0] === tabId) { if (owner) for (const id of this.dialogQueues.get(key) ?? []) this.blockers.closeDialog(owner, id); this.dialogQueues.delete(key); }
  }

  private closeEventRun(): void {
    this.eventEpoch += 1;
    this.eventLease = undefined;
    if (this.eventOwner) { this.eventSubscriptions.closeOwner(this.eventOwner); this.blockers.closeOwner(this.eventOwner); }
    this.eventOwner = undefined;
    this.dialogQueues.clear();
    if (this.popupListener) this.chromeApi.tabs.onCreated.removeListener(this.popupListener);
    if (this.tabRemovedListener) this.chromeApi.tabs.onRemoved.removeListener(this.tabRemovedListener);
    this.popupListener = undefined;
    this.tabRemovedListener = undefined;
  }

  private async boundPage(tabId: number, state: BrowserState): Promise<any> {
    const tab = await this.chromeApi.tabs.get(tabId);
    if (!tab || !Number.isInteger(tab.windowId)) throw new Error("CommandError[invalid-tab-id]: Tab is unavailable");
    return this.pageFor({ windowId: tab.windowId!, tabId });
  }

  /** Program page handles belong to a debugger-session incarnation, never just a tab ID. */
  private programPages(scope: ProgramScope, state: BrowserState): ProgramPages {
    type Entry = { live: boolean; session?: object; promise: Promise<any> };
    const entries = new Map<number, Entry>();
    let disposed = false;
    const invalidate = (tabId: number) => { const entry = entries.get(tabId); if (entry) { entry.live = false; entries.delete(tabId); } };
    const onRemoved = (tabId: number) => invalidate(tabId);
    this.chromeApi.tabs?.onRemoved?.addListener(onRemoved);
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      this.chromeApi.tabs?.onRemoved?.removeListener(onRemoved);
      scope.signal.removeEventListener("abort", dispose);
      for (const entry of entries.values()) entry.live = false;
      entries.clear();
    };
    scope.signal.addEventListener("abort", dispose, { once: true });
    const get = async (tabId: number, initial?: any): Promise<any> => {
      scope.guard();
      const tab = await this.chromeApi.tabs.get(tabId).catch(() => undefined);
      scope.guard();
      if (!tab || !Number.isInteger(tab.windowId)) {
        invalidate(tabId);
        throw new Error("CommandError[invalid-tab-id]: Tab is unavailable");
      }
      const prior = entries.get(tabId);
      if (prior && prior.live && (!prior.session || prior.session === this.automation.sessionIdentity(tabId))) return prior.promise;
      invalidate(tabId);
      const entry: Entry = { live: true, promise: Promise.resolve(undefined) };
      entries.set(tabId, entry);
      entry.promise = (async () => {
        const raw = initial ?? await this.boundPage(tabId, state);
        scope.guard();
        if (!entry.live || entries.get(tabId) !== entry) throw new Error("CommandError[stale-page]: Tab was closed while acquiring a page handle");
        const identity = this.automation.sessionIdentity(tabId);
        if (!identity) throw new Error("CommandError[stale-page]: Browser session is unavailable");
        entry.session = identity;
        const assertLive = () => {
          scope.guard();
          if (!entry.live || this.automation.sessionIdentity(tabId) !== identity)
            throw new Error("CommandError[stale-page]: Browser session changed; acquire a new page handle");
        };
        const page = await this.programPage(raw, scope, assertLive, get);
        assertLive();
        return page;
      })().catch((error) => { if (entries.get(tabId) === entry) invalidate(tabId); throw error; });
      return entry.promise;
    };
    if (scope.signal.aborted) dispose();
    return { get, invalidate, dispose };
  }

  private async programPage(raw: any, scope: ProgramScope, assertLive: () => void, getPage: (tabId: number) => Promise<any>): Promise<any> {
    // Locator chains are created lazily in the worker. Guard both the page and
    // each derived locator at invocation, including queued calls after detach.
    const guarded = <T extends object>(subject: T): T => new Proxy(subject, { get(target, key) {
      if (target instanceof LocatorFacade && key === "spec") assertLive();
      const value = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        assertLive();
        const result = Reflect.apply(value, target, args);
        return result instanceof LocatorFacade ? guarded(result) : result;
      };
    } });
    const page = scope.wrap(guarded(raw));
    const call = (name: string, invoke: () => Promise<unknown>) => scope.call(name, () => { assertLive(); return invoke(); }, true, false, false, true, { tabId: raw.tabId });
    const keyboard = {
      press: (key: string) => page.press(key), insertText: (text: string) => page.insertText(text),
      down: (key: string) => call("keyboard.down", () => this.automation.keyState(raw.tabId, "keydown", key)),
      up: (key: string) => call("keyboard.up", () => this.automation.keyState(raw.tabId, "keyup", key)),
    };
    const mouse = {
      move: (x: number, y: number) => call("mouse.move", () => this.bridgeCommand({ tabId: raw.tabId }, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y })),
      down: (button = "left") => call("mouse.down", () => this.bridgeCommand({ tabId: raw.tabId }, "Input.dispatchMouseEvent", { type: "mousePressed", button, clickCount: 1 })),
      up: (button = "left") => call("mouse.up", () => this.bridgeCommand({ tabId: raw.tabId }, "Input.dispatchMouseEvent", { type: "mouseReleased", button, clickCount: 1 })),
      wheel: (dx: number, dy: number) => call("mouse.wheel", () => this.bridgeCommand({ tabId: raw.tabId }, "Input.dispatchMouseEvent", { type: "mouseWheel", deltaX: dx, deltaY: dy })),
    };
    return new Proxy(page, { get: (target, key) => {
      if (key === "snapshot") return () => scope.call("page.snapshot", () => { assertLive(); return raw.inspect({ budget: Number.MAX_SAFE_INTEGER }); }, false, false, false, false, { tabId: raw.tabId });
      if (key === "observe") return (detail = "semantic", since?: string) => detail === "visual" ? call("page.observe.visual", async () => {
        if (!this.activeContext.visualEnabled) throw new Error("AutomationError[visual-unavailable]: Image input unavailable");
        return this.captureScreenshot(raw, {});
      }) : scope.call("page.observe", () => { assertLive(); return raw.inspect({ since }); }, false, false, false, false, { tabId: raw.tabId });
      if (key === "inspect") return (options = {}, region?: unknown) => scope.call("page.inspect", () => { assertLive(); return raw.inspect(options, scope.unwrap(region)); }, false, false, false, false, { tabId: raw.tabId });
      if (key === "waitForEvent") return (kind: "dialog" | "popup" | "download" | "filechooser") => scope.call("page.waitForEvent", () => { assertLive(); return raw.waitForEvent(kind).then(async (event: any) => {
        if (kind === "popup") return getPage(event.tabId);
        return event && typeof event === "object" && (event.setFiles || event.accept) ? scope.wrap(event, "event") : event;
      }); }, false, false, true);
      if (key === "keyboard") return keyboard;
      if (key === "mouse") return mouse;
      if (key === "screenshot") return (options = {}) => call("page.screenshot", async () => {
        return this.captureScreenshot(raw, options);
      });
      if (key === "pdf") return (options: { filename?: string; save?: boolean } = {}) => call("page.pdf", () => this.capturePdf(raw.tabId, options.filename, options.save));
      if (key === "drop") return (target: unknown, options: { files?: any[]; data?: Record<string, string> }) => call("page.drop", async () => {
        const files = await this.normalizeFiles(options.files ?? []);
        return this.locatorFor(raw, target).evaluate(`(el, payload) => {
          const transfer = new DataTransfer();
          for (const file of payload.files) { const bytes = file.base64 ? Uint8Array.from(atob(file.base64), c => c.charCodeAt(0)) : new TextEncoder().encode(file.text || ""); transfer.items.add(new File([bytes], file.name, {type:file.mimeType || "application/octet-stream"})); }
          for (const [type, value] of Object.entries(payload.data)) transfer.setData(type, value);
          el.dispatchEvent(new DragEvent("drop", { bubbles:true, cancelable:true, dataTransfer:transfer }));
        }`, { files, data: options.data ?? {} });
      });
      return Reflect.get(target, key);
    } });
  }

  private programCapabilities(page: any, state: BrowserState, scope: ProgramScope, pages: ProgramPages) {
    const call = (name: string, effect: boolean, invoke: () => unknown | Promise<unknown>, source?: { tabId: number; sessionId?: string }) => scope.call(name, invoke, effect, false, false, effect, source);
    const sourceFor = (tabId: number | undefined, sessionId?: string) => Number.isSafeInteger(tabId) ? { tabId: tabId!, ...(sessionId ? { sessionId } : {}) } : undefined;
    const scripts = Object.fromEntries(["list", "read", "create", "edit", "setEnabled", "delete"].map((method) => [method, (...args: any[]) => call(`scripts.${method}`, !["list", "read"].includes(method),
      () => callUserScript(method, method === "edit" ? [{ id: args[0], changes: args[1] }] : method === "setEnabled" ? [{ id: args[0], enabled: args[1] }] : method === "delete" ? [{ id: args[0] }] : args, scope.signal, () => scope.dispatched()))]));
    const browser = {
      page: (tabId: number) => call("browser.page", false, () => pages.get(tabId), sourceFor(tabId)),
      tabs: {
        list: () => call("tabs.list", false, () => this.tabsOf(state)),
        open: (url?: string) => call("tabs.open", true, async () => { await scope.dispatched(); const tab = await this.chromeApi.tabs.create({ windowId: state.windowId, active: true, ...(url ? { url } : {}) }); return pages.get(tab.id!); }),
        select: (tabId: number) => call("tabs.select", true, async () => { await this.boundPage(tabId, state); await scope.dispatched(); return this.selectTab(state, tabId); }),
        close: (tabId: number) => call("tabs.close", true, async () => { await this.boundPage(tabId, state); await scope.dispatched(); const result = await this.closeTab(state, tabId); pages.invalidate(tabId); return result; }),
      },
      scripts,
      runIn: (target: PageExecutionTarget, code: string) => call("browser.runIn", true, async () => {
        if (target.kind !== "page" || target.tabId === undefined || "targetId" in target || "sessionId" in target) throw new Error("runIn supports explicit page tabId and MAIN/ISOLATED/USER_SCRIPT worlds; use frameLocator for frame interaction");
        if (!["MAIN", "ISOLATED", "USER_SCRIPT"].includes(target.world ?? "")) throw new Error("runIn requires an explicit MAIN, ISOLATED, or USER_SCRIPT execution world");
        await this.boundPage(target.tabId, state);
        if (target.world !== "USER_SCRIPT" && (target.documentId || target.frameId !== undefined && target.frameId !== 0)) throw new Error("MAIN/ISOLATED runIn supports the root document; use USER_SCRIPT documentId/frameId or frameLocator.evaluate for frames");
        await scope.dispatched();
        return this.executePageWorld(target, code, scope.signal, this.activeContext);
      }, sourceFor(target.tabId)),
    };
    const fetchResult = async (response: Response) => ({ url: response.url, status: response.status, ok: response.ok, headers: Object.fromEntries(response.headers), body: await response.text() });
    const net = {
      fetch: (input: { context: "page" | "extension"; url: string; tabId?: number; init?: RequestInit }) => call(`net.fetch.${input.context}`, true, async () => {
        if (input.context === "extension") { await scope.dispatched(); return fetchResult(await fetch(input.url, { ...input.init, signal: scope.signal })); }
        if (input.context !== "page") throw new Error("net.fetch requires explicit page or extension context");
        const raw = await this.boundPage(input.tabId ?? page.tabId, state);
        await scope.dispatched();
        return raw.evaluate(`async payload => { const response = await fetch(payload.url, payload.init); return { url:response.url,status:response.status,ok:response.ok,headers:Object.fromEntries(response.headers),body:await response.text() }; }`, { url: input.url, init: input.init });
      }, input.context === "page" ? sourceFor(input.tabId ?? page.tabId) : undefined),
      requests: (options: Record<string, any> = {}, tabId = page.tabId) => call("net.requests", false, async () => { await this.boundPage(tabId, state); return this.diagnostics.requests(tabId, options, scope.signal); }),
      request: (ref: string, tabId = page.tabId) => call("net.request", false, async () => { await this.boundPage(tabId, state); return this.readRequest(tabId, ref, false, scope.signal); }),
      responseBody: (ref: string, tabId = page.tabId) => call("net.responseBody", false, async () => { await this.boundPage(tabId, state); return this.readRequest(tabId, ref, true, scope.signal); }),
      console: (options: Record<string, any> = {}, tabId = page.tabId) => call("net.console", false, async () => { await this.boundPage(tabId, state); return this.diagnostics.console(tabId, options, scope.signal); }),
    };
    const protocol = { sessions: (tabId = page.tabId) => call("protocol.sessions", false, async () => {
      await this.boundPage(tabId,state); return this.automation.observationDebuggees(tabId);
    }), send: (target: { tabId: number; sessionId?: string }, method: string, params?: object) => call(`protocol.${method}`, true, async () => {
      await this.boundPage(target.tabId, state);
      if (target.sessionId && !(await this.automation.observationDebuggees(target.tabId)).some((item) => item.sessionId === target.sessionId)) throw new Error("CDP session is not owned by the selected tab");
      await scope.dispatched();
      return this.bridgeCommand(target, method, params);
    }, method === "Page.handleJavaScriptDialog" ? undefined : sourceFor(target.tabId, target.sessionId)) };
    const artifacts = {
      read: (id: number, selection = {}) => call("artifacts.read", false, () => this.logger!.result(id, selection, this.activeContext.conversationId)),
      save: (id: number, filename?: string) => call("artifacts.save", true, () => this.saveArtifact(id, filename)),
      text: (filename: string, text: string, mimeType = "text/plain", save = false) => call("artifacts.text", save, () => this.storeText(filename, text, mimeType, save)),
    };
    return { page, browser, net, protocol, artifacts, signal: scope.signal,
      emit: (value: unknown) => scope.emit(value), check: (condition: unknown, message?: string) => scope.check(condition, message), sleep: (ms: number) => scope.sleep(ms) };
  }

  private enqueueAbortable<T>(run: (signal?: AbortSignal) => Promise<T>, signal?: AbortSignal, timeoutMs?: number, mayHaveEffect = true, awaitCleanup = false): Promise<T> {
    const previous = this.tail;
    let operationStarted = false;
    let cleanup: Promise<T> | undefined;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    const started = previous.then(() => {
      const timeout = timeoutMs ? new AbortController() : undefined;
      const timer = timeout ? setTimeout(() => timeout.abort(new DOMException(`Operation timed out after ${timeoutMs}ms`, "TimeoutError")), timeoutMs) : undefined;
      const combined = timeout ? signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal : signal;
      const clearDeadline = () => { if (timer !== undefined) clearTimeout(timer); };
      if (combined?.aborted) { clearDeadline(); release(); combined.throwIfAborted(); }
      operationStarted = true;
      const work = Promise.resolve().then(() => run(combined));
      cleanup = work;
      const done = () => { clearDeadline(); release(); };
      void work.then(done, done);
      return { work, combined };
    });
    return this.awaitAbort(started, signal).catch(async (error) => {
      if (awaitCleanup && operationStarted) await cleanup?.catch(() => undefined);
      if (operationStarted && mayHaveEffect && signal?.aborted) Object.assign(error, { effectUnknown: true });
      throw error;
    }).then(({ work, combined }) => awaitCleanup ? work : this.awaitAbort(work, combined, mayHaveEffect));
  }

  private locatorFor(page: any, raw: unknown): any {
    const target = parseLocatorTarget(raw);
    if ("point" in target) return { click: (options?: unknown) => page.point(target.point.observationId, target.point.x, target.point.y, "click", options), dblclick: (options?: unknown) => page.point(target.point.observationId, target.point.x, target.point.y, "dblclick", options), hover: () => page.point(target.point.observationId, target.point.x, target.point.y, "hover") };
    if ("ref" in target) return page.ref(target.ref);
    let scope = target.frame ? "ref" in target.frame ? page.frameRef(target.frame.ref) : page.frameLocator(target.frame.value) : page;
    const options = { exact: target.exact };
    let locator = target.by === "role" ? scope.getByRole(target.value, { ...options, name: target.name })
      : target.by === "text" ? scope.getByText(target.value, options)
      : target.by === "label" ? scope.getByLabel(target.value, options)
      : target.by === "placeholder" ? scope.getByPlaceholder(target.value, options)
      : target.by === "alt" ? scope.getByAltText(target.value, options)
      : target.by === "title" ? scope.getByTitle(target.value, options)
      : target.by === "testId" ? scope.getByTestId(target.value)
      : scope.locator(target.value);
    if (target.index !== undefined) locator = locator.nth(target.index);
    return locator;
  }

  async beginRun(): Promise<BrowserContext> {
    if (this.runFinishing) await this.runFinishing;
    if (this.disposed) throw new Error("Chrome executor has been disposed");
    const epoch = this.eventEpoch;
    const identity = this.readRunIdentity();
    const window = await this.chromeApi.windows.getCurrent({ populate: true });
    const currentIdentity = this.readRunIdentity();
    if (epoch !== this.eventEpoch || identity && (!currentIdentity || identity.runId !== currentIdentity.runId || identity.ownerId !== currentIdentity.ownerId || identity.generation !== currentIdentity.generation))
      throw new Error("CommandError[event-owner-expired]: Run ownership expired during initialization");
    if (!Number.isInteger(window.id)) throw new Error("CommandError[no-window]: Could not resolve the current Chrome window");
    const selected = window.tabs?.find((tab) => tab.active) ?? window.tabs?.[0];
    this.browserState = {
      windowId: window.id!,
      tabId: selected?.id,
    };
    this.eventLease = identity;
    return this.browserContext();
  }

  async browserContext(): Promise<BrowserContext> {
    const state = this.browserState ?? await this.currentBrowserState();
    const tabs = await this.tabsOf(state);
    return { windowId: state.windowId, tabs: tabs.map(({ index, id, windowId, current, title, url }) => ({ index, tabId: id, windowId, current, title, url })) };
  }

  /** Tab management remains available even when the previously bound tab or window disappeared. */
  listTabs(signal?: AbortSignal, timeoutMs?: number): Promise<unknown> {
    return this.enqueueAbortable(async (combined) => {
      throwIfAborted(combined);
      const state = this.browserState ?? await this.currentBrowserState();
      throwIfAborted(combined);
      return this.tabsOf(state);
    }, signal, timeoutMs, false);
  }

  switchTab(tabId: number, signal?: AbortSignal, timeoutMs?: number): Promise<unknown> {
    return this.enqueueAbortable(async (combined) => {
      throwIfAborted(combined);
      const state = this.browserState ?? await this.currentBrowserState();
      throwIfAborted(combined);
      return this.selectTab(state, tabId, combined);
    }, signal, timeoutMs);
  }

  private async currentBrowserState(): Promise<BrowserState> {
    const existing = this.browserState;
    if (existing) {
      const window = await this.chromeApi.windows.get(existing.windowId).catch(() => undefined);
      if (window) return existing;
      throw new Error("CommandError[window-closed]: The bound Chrome window was closed");
    }
    const window = await this.chromeApi.windows.getCurrent({ populate: true });
    if (!Number.isInteger(window.id)) throw new Error("CommandError[no-window]: Could not resolve the current Chrome window");
    const selected = window.tabs?.find((tab) => tab.active) ?? window.tabs?.[0];
    const state = { windowId: window.id!, tabId: selected?.id };
    this.browserState = state;
    return state;
  }

  private async tabsOf(state: BrowserState): Promise<Array<{ index: number; current: boolean; id?: number; windowId?: number; title?: string; url?: string }>> {
    const tabs = await this.chromeApi.tabs.query({});
    return tabs.map((tab, index) => ({ index, current: state.tabId !== undefined && tab.id === state.tabId, id: tab.id, windowId: tab.windowId, title: tab.title, url: tab.url }));
  }

  private async selectTab(state: BrowserState, tabId: number, signal?: AbortSignal): Promise<unknown> {
    const tabs = await this.chromeApi.tabs.query({});
    throwIfAborted(signal);
    const tab = tabs.find((item) => item.id === tabId);
    if (!tab?.id) throw new Error(`CommandError[invalid-tab-id]: ${tabId}`);
    await this.chromeApi.tabs.update(tab.id, { active: true });
    if (Number.isInteger(tab.windowId)) state.windowId = tab.windowId!;
    state.tabId = tab.id;
    return this.tabsOf(state);
  }

  private async closeTab(state: BrowserState, tabId: number): Promise<unknown> {
    const tabs = await this.chromeApi.tabs.query({});
    const tab = tabs.find((item) => item.id === tabId);
    if (!tab?.id) throw new Error(`CommandError[invalid-tab-id]: ${tabId}`);
    await this.detachTabRuntime(tab.id);
    await this.chromeApi.tabs.remove(tab.id);
    if (state.tabId === tab.id) state.tabId = undefined;
    return this.tabsOf(state);
  }

  private async pageFor(state: BrowserState): Promise<any> {
    const tabId = state.tabId;
    if (!Number.isInteger(tabId)) throw new Error("CommandError[no-bound-tab]: Select a tab before interacting with a page");
    const tab = await this.chromeApi.tabs.get(tabId!).catch(() => undefined);
    if (!tab) throw new Error(`CommandError[bound-tab-closed]: Bound tab ${tabId} is unavailable; list tabs and select one explicitly`);
    const resolvedTabId = tabId as number;
    const page = await this.automation.createPage(resolvedTabId);
    await this.enableObservation(resolvedTabId);
    return page;
  }

  private async storeArtifact(filename: string, base64: string, mimeType: string, save = false): Promise<ArtifactRef> {
    if (!this.logger || !this.activeContext.conversationId) throw new Error("CommandError[artifact-log-unavailable]: The canonical event log is unavailable");
    const byteLength = base64ByteLength(base64);
    const event = await this.logger.append({
      type: "tool.result.data",
      conversationId: this.activeContext.conversationId,
      toolCallId: this.activeContext.toolCallId,
      ...this.activeContext.logIdentity,
      content: { filename, mimeType, byteLength },
      output: { filename, mimeType, base64 },
    });
    if (!event) throw new Error("CommandError[artifact-log-unavailable]: The canonical event log stopped accepting events");
    const artifact = { id: event.id, filename, mimeType, byteLength, saved: false };
    if (save && this.programScope) await this.programScope.dispatched();
    const downloadId = save ? await downloadArtifact(this.chromeApi, artifact, base64, this.activeSignal) : undefined;
    return { id: event.id, filename, mimeType, byteLength, saved: save, ...(downloadId === undefined ? {} : { downloadId }) };
  }

  private async storeText(filename: string, text: string, mimeType: string, save = false): Promise<ArtifactRef> {
    const bytes = new TextEncoder().encode(text);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return this.storeArtifact(filename, btoa(binary), mimeType, save);
  }

  private async saveArtifact(id: number, requested?: string): Promise<{ artifact: ArtifactRef }> {
    if (!this.logger) throw new Error("CommandError[artifact-log-unavailable]: The canonical event log is unavailable");
    const stored = await this.logger.result(id, {}, this.activeContext.conversationId ?? "") as { filename?: unknown; mimeType?: unknown; base64?: unknown };
    if (typeof stored?.base64 !== "string" || typeof stored.mimeType !== "string" || typeof stored.filename !== "string") {
      throw new Error(`CommandError[invalid-artifact]: Artifact ${id} has no downloadable data`);
    }
    const filename = requested ?? stored.filename;
    throwIfAborted(this.activeSignal);
    const artifact = { id, filename, mimeType: stored.mimeType, byteLength: base64ByteLength(stored.base64), saved: false };
    const referenced = await this.logger.append({ type: "browser.artifact.used", conversationId: this.activeContext.conversationId,
      toolCallId: this.activeContext.toolCallId, ...this.activeContext.logIdentity, content: { artifactId: id } });
    if (!referenced) throw new DOMException("Could not persist artifact ownership", "AbortError");
    throwIfAborted(this.activeSignal);
    if (this.programScope) await this.programScope.dispatched();
    const downloadId = await downloadArtifact(this.chromeApi, artifact, stored.base64, this.activeSignal);
    return { artifact: { id, filename, mimeType: stored.mimeType, byteLength: base64ByteLength(stored.base64), saved: true, downloadId } };
  }

  private async normalizeFiles(files: any[]): Promise<any[]> {
    return Promise.all(files.map(async (file) => {
      if (file.artifactId !== undefined) {
        if (!this.logger) throw new Error("CommandError[artifact-log-unavailable]: The canonical event log is unavailable");
        const stored = await this.logger.result(file.artifactId, {}, this.activeContext.conversationId ?? "") as { mimeType?: unknown; base64?: unknown };
        if (typeof stored?.base64 !== "string") throw new Error(`CommandError[invalid-artifact]: Artifact ${file.artifactId} has no file data`);
        return { name: file.name, mimeType: file.mimeType || (typeof stored.mimeType === "string" ? stored.mimeType : "application/octet-stream"), base64: stored.base64 };
      }
      if (!file.url) return file;
      if (this.programScope) await this.programScope.dispatched();
      const response = await fetch(file.url, { signal: this.activeSignal });
      if (!response.ok) throw new Error(`Could not fetch upload URL: ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return { name: file.name, mimeType: file.mimeType || response.headers.get("content-type") || "application/octet-stream", base64: btoa(binary) };
    }));
  }

  private async captureScreenshot(page: any, input: Record<string, any>): Promise<unknown> {
    const format = input.type ?? (String(input.filename ?? "").match(/\.(jpe?g|webp)$/i)?.[1]?.replace("jpg", "jpeg") || "png");
    const params: Record<string, unknown> = { format, fromSurface: true, captureBeyondViewport: Boolean(input.fullPage) };
    if (input.fullPage) {
      const metrics = await this.bridgeCommand({ tabId: page.tabId }, "Page.getLayoutMetrics", {});
      const contentSize = metrics.cssContentSize ?? metrics.contentSize;
      if (contentSize) params.clip = { ...contentSize, scale: 1 };
    } else if (input.target) {
      const box = await this.locatorFor(page, input.target).evaluate("el => { const r = el.getBoundingClientRect(); return {x:r.x + scrollX,y:r.y + scrollY,width:r.width,height:r.height}; }");
      params.clip = { ...box, scale: input.hires ? await page.evaluate("() => devicePixelRatio") : 1 };
    }
    const observation = await page.observe("visual", undefined, params);
    const captured = observation.screenshot;
    const mediaType = `image/${format}`;
    const filename = input.filename ?? timestamped("page", format === "jpeg" ? "jpg" : format);
    const artifact = await this.storeArtifact(filename, captured.data, mediaType, input.save);
    return { observationId: observation.observationId, tabId: page.tabId, documentId: observation.documentId, viewport: observation.viewport, artifact, screenshot: { mediaType, artifactId: artifact.id, width: captured.width, height: captured.height, scale: captured.scale, origin: captured.origin }, page: { url: observation.url, title: observation.title } };
  }

  private async capturePdf(tabId: number, requested?: string, save = false): Promise<unknown> {
    const result = await this.bridgeCommand({ tabId }, "Page.printToPDF", { printBackground: true, transferMode: "ReturnAsBase64" });
    const filename = requested ?? timestamped("page", "pdf");
    return { artifact: await this.storeArtifact(filename, result.data, "application/pdf", save) };
  }

  private async enableObservation(tabId: number): Promise<void> {
    if (this.networkEnabled.has(tabId)) return;
    this.networkEnabled.add(tabId);
    const debuggees = await this.automation.observationDebuggees(tabId);
    await Promise.all([
      ...debuggees.flatMap((debuggee) => [this.bridgeCommand(debuggee, "Network.enable", {}), this.bridgeCommand(debuggee, "Log.enable", {}), this.bridgeCommand(debuggee, "Page.setInterceptFileChooserDialog", { enabled: true })]),
    ]).catch((error) => { this.networkEnabled.delete(tabId); throw error; });
  }

  private async handleCommandEvent(source: Debuggee, method: string, params: any): Promise<void> {
    const tabId = source.tabId;
    if (!Number.isInteger(tabId)) return;
    const owner = this.eventOwner;
    const eventSource = { tabId: tabId!, ...(source.sessionId ? { sessionId: source.sessionId } : {}) };
    const sourceKey = dialogSourceKey(eventSource);
    if (method === "Target.detachedFromTarget" && typeof params?.sessionId === "string") this.closeEventSource(tabId!, params.sessionId);
    if (owner && ["Page.frameNavigated", "Page.frameDetached", "DOM.documentUpdated", "Runtime.executionContextsCleared"].includes(method)) this.eventSubscriptions.closeChoosers(owner, tabId!);
    if (method === "Page.javascriptDialogOpening" && owner) {
      const dialog = this.eventSubscriptions.registerDialog({ owner, source: eventSource, type: params.type, message: params.message, defaultPrompt: params.defaultPrompt });
      params.surfWaxDialogId = dialog.id;
      const queue = this.dialogQueues.get(sourceKey) ?? [];
      queue.push(dialog.id); this.dialogQueues.set(sourceKey, queue);
      this.eventSubscriptions.publish(owner, { kind: "dialog", source: eventSource, payload: { dialogId: dialog.id, type: dialog.type, message: dialog.message, defaultPrompt: dialog.defaultPrompt } });
      void this.blockers.observeDialog(owner, { dialogId: dialog.id, source: eventSource, type: dialog.type, message: dialog.message, ...(dialog.defaultPrompt === undefined ? {} : { defaultPrompt: dialog.defaultPrompt }) });
    }
    if (method === "Page.javascriptDialogClosed") {
      const queue = this.dialogQueues.get(sourceKey);
      const id = queue?.shift();
      if (id && owner) { this.eventSubscriptions.closeDialog(owner, id); this.blockers.closeDialog(owner, id); }
      if (!queue?.length) this.dialogQueues.delete(sourceKey);
    }
    if (method === "Page.fileChooserOpened" && owner) {
      this.eventSubscriptions.closeChoosers(owner, tabId!);
      if (Number.isSafeInteger(params?.backendNodeId) && params.backendNodeId > 0 && ["selectSingle", "selectMultiple"].includes(params.mode)) {
        const chooser = this.eventSubscriptions.registerChooser({ owner, source: eventSource, backendNodeId: params.backendNodeId, mode: params.mode });
        const record = this.automation.currentChooser(eventSource, params.backendNodeId);
        if (record) this.chooserHandles.set(record, chooser.id);
        this.eventSubscriptions.publish(owner, { kind: "filechooser", source: eventSource, payload: { chooserId: chooser.id, mode: chooser.mode } });
      } else {
        this.eventSubscriptions.publish(owner, { kind: "filechooser", source: eventSource, payload: { unavailable: "missing-chooser-node-or-mode" } });
      }
    }
    const kind: BrowserEventKind | undefined = method === "Page.downloadWillBegin" ? "download"
      : method === "Network.requestWillBeSent" ? "request" : method === "Network.responseReceived" ? "response"
      : method === "Runtime.consoleAPICalled" || method === "Log.entryAdded" ? "console" : undefined;
    if (kind && owner) this.eventSubscriptions.publish(owner, { kind, source: eventSource, payload: params });
    if (!this.networkEnabled.has(tabId!)) return;
    this.diagnostics.handle(source, method, params);
    if (method === "Target.attachedToTarget" && params?.targetInfo?.type === "iframe") {
      const debuggee = { tabId, sessionId: params.sessionId };
      await Promise.all([
        ...["Network", "Log"].map((domain) => this.bridgeCommand(debuggee, `${domain}.enable`, {}).catch(() => undefined)),
        this.bridgeCommand(debuggee, "Page.setInterceptFileChooserDialog", { enabled: true }).catch(() => undefined),
      ]);
    }
  }

  private async readRequest(tabId: number, ref: string, bodyOnly = false, signal?: AbortSignal): Promise<unknown> {
    const record = await this.diagnostics.request(tabId, ref, signal);
    const assertCurrent = async () => {
      const current = await this.diagnostics.request(tabId, ref, signal);
      if (current.requestId !== record.requestId || current.debuggee.sessionId !== record.debuggee.sessionId)
        throw Object.assign(new Error("Request source changed"), { code: "stale-request" });
      if (record.debuggee.sessionId) {
        const sources = await this.awaitAbort(this.automation.observationDebuggees(tabId), signal);
        if (!sources.some((source) => source.sessionId === record.debuggee.sessionId))
          throw Object.assign(new Error("Request source is no longer attached"), { code: "stale-request" });
        // The source lookup itself can race with a navigation or redirect.
        await this.diagnostics.request(tabId, ref, signal);
      }
    };
    await assertCurrent();
    signal?.throwIfAborted();
    let body: unknown;
    try {
      const response = await this.awaitAbort(this.bridgeCommand(record.debuggee, "Network.getResponseBody", { requestId: record.requestId }), signal);
      body = response.base64Encoded ? { base64: response.body } : response.body;
    } catch (error) { body = { unavailable: error instanceof Error ? error.message : String(error) }; }
    // A CDP reply can arrive after the request was redirected, the page
    // navigated, or its child session detached. Never return it under an old ref.
    await assertCurrent();
    return bodyOnly ? body : { ...record, responseBody: body };
  }

  private async detachTabRuntime(tabId: number): Promise<void> {
    await this.releaseInput(tabId);
    if (this.networkEnabled.has(tabId)) await Promise.all([
      this.bridgeCommand({ tabId }, "Network.disable", {}).catch(() => undefined),
      this.bridgeCommand({ tabId }, "Log.disable", {}).catch(() => undefined),
      this.bridgeCommand({ tabId }, "Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => undefined),
    ]);
    this.closeEventTab(tabId, "debugger-detached");
    this.diagnostics.remove(tabId); this.networkEnabled.delete(tabId);
  }

  /** Release physical input after a definite failure without dropping sessions. */
  private async releaseHeldInputs(): Promise<void> {
    await Promise.all([...this.heldInput].map(async ([tabId, state]) => {
      if (state.buttons.size) await this.bridgeCommand({ tabId }, "Input.cancelDragging", {}).catch(() => undefined);
      await this.releaseInput(tabId);
    }));
  }

  private async stopBrowserOperations(): Promise<void> {
    if (this.endingRun) return this.endingRun;
    const cleanup = (async () => {
      await Promise.all([...this.programEvaluations.values()].map(({debuggee}) => this.bridgeCommand(debuggee,"Runtime.terminateExecution").catch(() => undefined)));
      const tabs = new Set([...this.networkEnabled, ...this.heldInput.keys()]);
      await Promise.all([...tabs].map((tabId) => this.detachTabRuntime(tabId)));
      await this.automation.abortSessions();
      this.diagnostics.clear();
    })();
    this.endingRun = cleanup;
    try { await cleanup; } finally { if (this.endingRun === cleanup) this.endingRun = undefined; }
  }

  async endRun(): Promise<void> {
    if (this.runFinishing) return this.runFinishing;
    this.backgroundEpoch += 1;
    this.pendingBackground.clear();
    this.closeEventRun();
    const closing = (async () => {
      this.jobs.cancelAll("run-ended");
      await this.jobs.settle();
      await this.stopBrowserOperations();
      this.browserState = undefined;
    })();
    this.runFinishing = closing;
    try { await closing; } finally { if (this.runFinishing === closing) this.runFinishing = undefined; }
  }

  dispose(): void {
    if (this.disposed) return;
    void this.endRun();
    this.browserState = undefined;
    this.disposed = true;
    if ((globalThis as Record<string, unknown>)[BRIDGE_KEY] === this.bridge) {
      delete (globalThis as Record<string, unknown>)[BRIDGE_KEY];
    }
    this.automation.dispose();
    this.port?.disconnect();
  }

  private async executePageWorld(target: PageExecutionTarget, code: string, signal?: AbortSignal, context: ExecutionContext = {}): Promise<unknown> {
    if (this.disposed) throw new Error("Chrome executor has been disposed");
    throwIfAborted(signal);
    this.logger?.record({ type: "tool.route", conversationId: context.conversationId, content: { target } });
    await (globalThis as Record<string, any>).__surfWaxGuard?.mark(target.tabId);
    throwIfAborted(signal);
    if (target.world === "USER_SCRIPT") return this.evaluateUserScript(target, code, signal);
    if (target.world === "ISOLATED") return this.evaluateIsolated(target, code, signal);
    const value = await this.awaitAbort(this.automation.pageValue(target.tabId, pageExpressionFor(code)), signal, true);
    return evaluationValue({ result: { value } }, "page");
  }

  private async bridgeDebuggee(debuggee: Debuggee): Promise<void> {
    const key = JSON.stringify(debuggee);
    if (this.bridgedDebuggees.has(key)) return;
    if (debuggee.sessionId) {
      this.bridgedDebuggees.add(key);
      return;
    }
    await (this.bridge.call as any)("attach", [debuggee, "1.3"]);
    this.bridgedDebuggees.add(key);
    await (this.bridge.call as any)("sendCommand", [debuggee, "Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
      filter: [{ type: "iframe", exclude: false }],
    }]).catch(() => undefined);
  }

  private inputState(tabId: number) {
    let state = this.heldInput.get(tabId);
    if (!state) { state = { x: 0, y: 0, buttons: new Set<string>(), keys: new Map<string, Record<string, unknown>>() }; this.heldInput.set(tabId, state); }
    return state;
  }

  private async releaseInput(tabId: number): Promise<void> {
    const state = this.heldInput.get(tabId);
    if (!state) return;
    for (const [key, params] of [...state.keys]) await this.bridgeCommand({ tabId }, "Input.dispatchKeyEvent", { ...params, type: "keyUp", key }).catch(() => undefined);
    for (const button of [...state.buttons]) await this.bridgeCommand({ tabId }, "Input.dispatchMouseEvent", { type: "mouseReleased", x: state.x, y: state.y, button, buttons: 0, clickCount: 1 }).catch(() => undefined);
    this.heldInput.delete(tabId);
  }

  private async bridgeCommand(debuggee: Debuggee, method: string, params?: object): Promise<any> {
    if (/^(Input\.|DOM\.(focus|scrollIntoViewIfNeeded)|Page\.(navigate|reload|navigateToHistoryEntry|handleJavaScriptDialog))/.test(method) && !this.activeSignal?.aborted) await this.programScope?.dispatched();
    await this.bridgeDebuggee(debuggee);
    let input = params as Record<string, any> | undefined;
    if (debuggee.tabId !== undefined && input && method.startsWith("Input.")) {
      const state = this.inputState(debuggee.tabId);
      const modifierBit = (key: string) => key === "Alt" ? 1 : key === "Control" ? 2 : key === "Meta" ? 4 : key === "Shift" ? 8 : 0;
      const heldModifiers = [...state.keys.keys()].reduce((mask, key) => mask | modifierBit(key), 0);
      if (method === "Input.dispatchMouseEvent") {
        if (Number.isFinite(input.x)) state.x = input.x;
        if (Number.isFinite(input.y)) state.y = input.y;
        if (input.type === "mousePressed") state.buttons.add(input.button ?? "left");
        if (input.type === "mouseReleased") state.buttons.delete(input.button ?? "left");
        const buttons = [...state.buttons].reduce((mask, button) => mask | (button === "left" ? 1 : button === "right" ? 2 : 4), 0);
        input = { x: state.x, y: state.y, ...input, buttons, modifiers: (input.modifiers ?? 0) | heldModifiers };
      }
      if (method === "Input.dispatchKeyEvent") {
        const ownModifier = modifierBit(input.key);
        const released = input.type === "keyUp" ? ownModifier : 0;
        input = { ...input, modifiers: ((input.modifiers ?? 0) | heldModifiers | ownModifier) & ~released };
        if (input.text && input.modifiers & 7) delete input.text;
        else if (input.text && input.modifiers & 8) input.text = input.text.toUpperCase();
        if (input.type === "keyUp") state.keys.delete(input.key);
        else state.keys.set(input.key, { ...input });
      }
    }
    const key = JSON.stringify(debuggee);
    const dialogOwner = method === "Page.handleJavaScriptDialog" ? this.eventOwner : undefined;
    const dialogId = dialogOwner ? this.dialogQueues.get(dialogSourceKey(debuggee))?.[0] : undefined;
    const dialogClaim = dialogOwner && dialogId ? this.eventSubscriptions.claimDialog(dialogOwner, dialogId) : undefined;
    const tracked = Boolean(this.programScope && ["Runtime.evaluate", "Runtime.callFunctionOn"].includes(method));
    if (tracked) this.programEvaluations.set(key, {debuggee,count:(this.programEvaluations.get(key)?.count ?? 0)+1});
    let result: any;
    try {
      result = await (this.bridge.call as any)("sendCommand", [debuggee, method, input]);
      if (dialogOwner && dialogClaim) this.eventSubscriptions.finishDialog(dialogOwner, dialogClaim.id, dialogClaim.claimId, "handled");
    } catch (error) {
      if (dialogOwner && dialogClaim) this.eventSubscriptions.finishDialog(dialogOwner, dialogClaim.id, dialogClaim.claimId, "uncertain");
      throw error;
    } finally { if (tracked) {
      const entry = this.programEvaluations.get(key);
      if (entry && entry.count > 1) entry.count--; else this.programEvaluations.delete(key);
    } }
    if (debuggee.tabId !== undefined && input?.surfWaxAtomicClick) this.inputState(debuggee.tabId).buttons.delete(input.button ?? "left");
    return result;
  }

  private async evaluateIsolated(target: PageExecutionTarget, code: string, signal?: AbortSignal): Promise<unknown> {
    if (target.documentId) throw new Error("ISOLATED execution cannot resolve documentId directly. Use frameId, targetId/sessionId, or USER_SCRIPT.");
    const debuggee: Debuggee = { tabId: target.tabId };
    throwIfAborted(signal);
    const tree = await this.bridgeCommand(debuggee, "Page.getFrameTree");
    const rootFrameId = tree?.frameTree?.frame?.id;
    if (target.frameId !== undefined && target.frameId !== 0) {
      throw new Error("ISOLATED execution for a non-root Chrome frameId requires a CDP targetId/sessionId. Discover it with Target.setAutoAttach and retry.");
    }
    if (!rootFrameId) throw new Error("CDP did not return a root frame for the page target.");
    const world = await this.bridgeCommand(debuggee, "Page.createIsolatedWorld", { frameId: rootFrameId, worldName: "surf-wax", grantUniveralAccess: true });
    const response = await this.bridgeCommand(debuggee, "Runtime.evaluate", {
      expression: pageExpressionFor(code), contextId: world.executionContextId, awaitPromise: true, returnByValue: true, userGesture: true,
    });
    throwIfAborted(signal);
    const error = evaluationError(response);
    if (error) throw error;
    return evaluationValue(response, "page");
  }

  private async evaluateUserScript(target: PageExecutionTarget, code: string, signal?: AbortSignal): Promise<unknown> {
    if (!this.chromeApi.userScripts?.execute) throw new Error("Allow User Scripts 未开启，或 Chrome 不支持该操作。");
    if (target.frameId !== undefined && target.documentId) throw new Error("Specify frameId or documentId, not both.");
    const tabId = target.tabId;
    if (!Number.isInteger(tabId)) throw new Error("USER_SCRIPT execution requires a page tabId.");
    throwIfAborted(signal);
    const injections = await this.awaitAbort(this.chromeApi.userScripts.execute({
      target: { tabId: tabId!, ...(target.frameId !== undefined ? { frameIds: [target.frameId] } : target.documentId ? { documentIds: [target.documentId] } : {}) },
      js: [{ code: pageExpressionFor(code) }], world: "USER_SCRIPT", injectImmediately: true,
    }), signal, true);
    const results = injections.map((injection) => {
      if (injection.error) throw new Error(injection.error);
      return { documentId: injection.documentId, frameId: injection.frameId, result: evaluationValue({ result: { value: injection.result } }, "user-script") };
    });
    return results.length === 1 ? results[0]!.result : results;
  }

  private async awaitAbort<T>(task: Promise<T>, signal?: AbortSignal, effectUnknown = false): Promise<T> {
    if (!signal) return task;
    if (signal.aborted) { void task.catch(() => undefined); throw interruptionError(signal, effectUnknown); }
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(interruptionError(signal, effectUnknown));
      signal.addEventListener("abort", abort, { once: true });
      void task.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  }

}
