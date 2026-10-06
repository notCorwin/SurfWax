import type { EventLogger } from "../logging";
import type { BrowserTarget, PageExecutionTarget } from "../types";
import { AutomationRuntime } from "./automation";
import { requireDebuggee } from "./debuggee";
import { downloadArtifact } from "./downloads";
import { BrowserDiagnostics } from "./diagnostics";
import { getRunIdentity } from "../agent/coordinator";
import { BrowserJobs, type JobQuery } from "./jobs";
import { ProgramScope } from "./program";
import type { InspectOptions } from "./automation";
import { callUserScript } from "./script-client";
import { executeSandboxProgram } from "./program-host";

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
type ExecutionContext = { conversationId?: string; toolCallId?: string; visualEnabled?: boolean; logIdentity?: { runId?: string; toolCallId: string; toolCallIdCanonical: true } };
type ArtifactRef = { id: number; filename: string; mimeType: string; byteLength: number; saved: boolean; downloadId?: number };
type BrowserState = { windowId: number; tabId?: number };
export type BrowserContext = {
  windowId: number;
  tabs: Array<{ index: number; tabId?: number; current: boolean; title?: string; url?: string }>;
};

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
  if (/^(?:t\d+d\d+)?e\d+$/.test(input)) return { ref: input };
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
  private readonly diagnostics: BrowserDiagnostics;
  private readonly networkEnabled = new Set<number>();
  private readonly dialogs = new Map<number, { type: string; message: string; defaultPrompt?: string }>();
  private readonly heldInput = new Map<number, { x: number; y: number; buttons: Set<string>; keys: Map<string, Record<string, unknown>> }>();
  private readonly jobs: BrowserJobs;
  private programScope?: ProgramScope;
  private readonly programEvaluations = new Map<string, { debuggee: Debuggee; count: number }>();
  private readonly programHost: typeof executeSandboxProgram;

  constructor(options: { chromeApi?: ExecutorChrome; logger?: EventLogger; programHost?: typeof executeSandboxProgram } = {}) {
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
      onDispatch: () => this.programScope?.dispatched() ?? Promise.resolve(),
      logger: this.logger,
    });
    listeners.onEvent.add((source, method, params) => {
      this.automation.handleEvent(source, method, params);
      void this.handleCommandEvent(source, method, params);
    });
    listeners.onDetach.add((source) => {
      this.bridgedDebuggees.delete(JSON.stringify(source));
      this.automation.handleDetach(source);
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
    }, signal, input.timeoutMs ?? 10000, false);
  }

  async runProgram(input: { code: string; background?: boolean; timeoutMs?: number }, signal?: AbortSignal, context: ExecutionContext = {}): Promise<unknown> {
    if (!context.conversationId || !this.logger) throw new Error("Programs require a conversation and canonical event log");
    const jobContext = { conversationId: context.conversationId, logIdentity: context.logIdentity };
    const id = await this.jobs.start(jobContext, signal, (combined, jobId, started) => this.enqueueAbortable(async (deadline) => {
      if (this.disposed) throw new Error("Chrome executor has been disposed");
      await started();
      const lifetime = new AbortController();
      const programSignal = AbortSignal.any([deadline ?? combined, lifetime.signal]);
      this.activeSignal = programSignal; this.activeContext = context;
      this.automation.setContext({ ...context, signal: programSignal }); this.diagnostics.bind(context);
      const scope = new ProgramScope(programSignal, jobId, jobContext, this.logger!);
      this.programScope = scope;
      try {
        scope.guard();
        const state = await this.currentBrowserState();
        const page = await this.programPage(await this.pageFor(state), scope);
        const capabilities = this.programCapabilities(page, state, scope);
        scope.guard();
        const result = await this.programHost(input.code, capabilities, programSignal);
        await scope.finish(); (deadline ?? combined).throwIfAborted();
        return result;
      } catch (error) {
        scope.revoke(); lifetime.abort("program-ended");
        await this.stopBrowserOperations();
        await scope.finish();
        if (scope.effectUnknown && error && typeof error === "object") Object.assign(error, { effectUnknown: true });
        throw error;
      } finally {
        scope.revoke(); lifetime.abort("program-ended");
        if (this.programScope === scope) this.programScope = undefined;
        this.activeSignal = undefined; this.activeContext = {};
        await this.automation.clearContext();
      }
    }, combined, input.timeoutMs ?? (input.background ? 300000 : 10000), false, true));
    if (input.background) return { jobId: id, state: "queued", accepted: true, complete: false };
    while (true) {
      const status = await this.jobs.query({ action: "wait", id, waitMs: 1000 }, context.conversationId, signal) as any;
      if (status.terminal) return { jobId: id, ok: status.ok, state: status.state, result: status.result, receipts: { action: "status", id, after: 0 } };
    }
  }

  queryJobs(input: JobQuery, signal?: AbortSignal, context: ExecutionContext = {}): Promise<unknown> {
    if (!context.conversationId) return Promise.reject(new Error("Jobs require a conversation"));
    // Deliberately bypass tail: a running program must never block status/wait/cancel.
    return this.jobs.query(input, context.conversationId, signal);
  }

  private async boundPage(tabId: number, state: BrowserState): Promise<any> {
    const tab = await this.chromeApi.tabs.get(tabId);
    if (!tab || tab.windowId !== state.windowId) throw new Error("CommandError[invalid-tab-id]: Tab is outside the bound window");
    return this.pageFor({ windowId: state.windowId, tabId });
  }

  private async programPage(raw: any, scope: ProgramScope): Promise<any> {
    const page = scope.wrap(raw);
    const call = (name: string, invoke: () => Promise<unknown>) => scope.call(name, invoke);
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
      if (key === "snapshot") return () => scope.call("page.snapshot", () => raw.inspect({ budget: Number.MAX_SAFE_INTEGER }), false);
      if (key === "observe") return (detail = "semantic", since?: string) => detail === "visual" ? call("page.observe.visual", async () => {
        if (!this.activeContext.visualEnabled) throw new Error("AutomationError[visual-unavailable]: Image input unavailable");
        return this.captureScreenshot(raw, {});
      }) : scope.call("page.observe", () => raw.inspect({ since }), false);
      if (key === "inspect") return (options = {}, region?: unknown) => scope.call("page.inspect", () => raw.inspect(options, scope.unwrap(region)), false);
      if (key === "waitForEvent") return (kind: "dialog" | "popup" | "download" | "filechooser") => scope.call("page.waitForEvent", () => raw.waitForEvent(kind).then(async (event: any) => {
        if (kind === "popup") return this.programPage(await this.boundPage(event.tabId, await this.currentBrowserState()), scope);
        return event && typeof event === "object" && (event.setFiles || event.accept) ? scope.wrap(event, "event") : event;
      }), false, false, true);
      if (key === "keyboard") return keyboard;
      if (key === "mouse") return mouse;
      if (key === "screenshot") return (options = {}) => call("page.screenshot", async () => {
        if (!this.activeContext.visualEnabled) throw new Error("AutomationError[visual-unavailable]: Image input unavailable");
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

  private programCapabilities(page: any, state: BrowserState, scope: ProgramScope) {
    const call = (name: string, effect: boolean, invoke: () => unknown | Promise<unknown>) => scope.call(name, invoke, effect);
    const scripts = Object.fromEntries(["list", "read", "create", "edit", "setEnabled"].map((method) => [method, (...args: any[]) => call(`scripts.${method}`, !["list", "read"].includes(method),
      () => callUserScript(method, method === "edit" ? [{ id: args[0], changes: args[1] }] : method === "setEnabled" ? [{ id: args[0], enabled: args[1] }] : args, scope.signal, () => scope.dispatched()))]));
    const browser = {
      page: (tabId: number) => call("browser.page", false, async () => this.programPage(await this.boundPage(tabId, state), scope)),
      tabs: {
        list: () => call("tabs.list", false, () => this.tabsOf(state)),
        open: (url?: string) => call("tabs.open", true, async () => { await scope.dispatched(); const tab = await this.chromeApi.tabs.create({ windowId: state.windowId, active: true, ...(url ? { url } : {}) }); return this.programPage(await this.boundPage(tab.id!, state), scope); }),
        select: (tabId: number) => call("tabs.select", true, async () => { await this.boundPage(tabId, state); await scope.dispatched(); return this.selectTab(state, tabId); }),
        close: (tabId: number) => call("tabs.close", true, async () => { await this.boundPage(tabId, state); await scope.dispatched(); return this.closeTab(state, tabId); }),
      },
      scripts,
      runIn: (target: PageExecutionTarget, code: string) => call("browser.runIn", true, async () => {
        if (target.kind !== "page" || target.tabId === undefined || "targetId" in target || "sessionId" in target) throw new Error("runIn supports explicit page tabId and MAIN/ISOLATED/USER_SCRIPT worlds; use frameLocator for frame interaction");
        if (!["MAIN", "ISOLATED", "USER_SCRIPT"].includes(target.world ?? "")) throw new Error("runIn requires an explicit MAIN, ISOLATED, or USER_SCRIPT execution world");
        await this.boundPage(target.tabId, state);
        if (target.world !== "USER_SCRIPT" && (target.documentId || target.frameId !== undefined && target.frameId !== 0)) throw new Error("MAIN/ISOLATED runIn supports the root document; use USER_SCRIPT documentId/frameId or frameLocator.evaluate for frames");
        await scope.dispatched();
        return this.executePageWorld(target, code, scope.signal, this.activeContext);
      }),
    };
    const fetchResult = async (response: Response) => ({ url: response.url, status: response.status, ok: response.ok, headers: Object.fromEntries(response.headers), body: await response.text() });
    const net = {
      fetch: (input: { context: "page" | "extension"; url: string; tabId?: number; init?: RequestInit }) => call(`net.fetch.${input.context}`, true, async () => {
        if (input.context === "extension") { await scope.dispatched(); return fetchResult(await fetch(input.url, { ...input.init, signal: scope.signal })); }
        if (input.context !== "page") throw new Error("net.fetch requires explicit page or extension context");
        const raw = await this.boundPage(input.tabId ?? page.tabId, state);
        await scope.dispatched();
        return raw.evaluate(`async payload => { const response = await fetch(payload.url, payload.init); return { url:response.url,status:response.status,ok:response.ok,headers:Object.fromEntries(response.headers),body:await response.text() }; }`, { url: input.url, init: input.init });
      }),
      requests: (options: Record<string, any> = {}, tabId = page.tabId) => call("net.requests", false, async () => { await this.boundPage(tabId, state); return this.diagnostics.requests(tabId, options); }),
      request: (index: number, tabId = page.tabId) => call("net.request", false, async () => { await this.boundPage(tabId, state); return this.readRequest(tabId, index); }),
      responseBody: (index: number, tabId = page.tabId) => call("net.responseBody", false, async () => { await this.boundPage(tabId, state); return this.readRequest(tabId, index, true); }),
      console: (options: Record<string, any> = {}, tabId = page.tabId) => call("net.console", false, async () => { await this.boundPage(tabId, state); return this.diagnostics.console(tabId, options); }),
    };
    const protocol = { sessions: (tabId = page.tabId) => call("protocol.sessions", false, async () => {
      await this.boundPage(tabId,state); return this.automation.observationDebuggees(tabId);
    }), send: (target: { tabId: number; sessionId?: string }, method: string, params?: object) => call(`protocol.${method}`, true, async () => {
      if (!/^(Page|DOM|Runtime|Accessibility|Network|Log|Input)\.[A-Za-z]+$/.test(method)) throw new Error("Unsupported CDP domain; allowed: Page, DOM, Runtime, Accessibility, Network, Log, Input");
      await this.boundPage(target.tabId, state);
      if (target.sessionId && !(await this.automation.observationDebuggees(target.tabId)).some((item) => item.sessionId === target.sessionId)) throw new Error("CDP session is not owned by the selected tab");
      await scope.dispatched();
      return this.bridgeCommand(target, method, params);
    }) };
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
    let scope = target.frame ? page.frameLocator(target.frame.value) : page;
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
    const window = await this.chromeApi.windows.getCurrent({ populate: true });
    if (!Number.isInteger(window.id)) throw new Error("CommandError[no-window]: Could not resolve the current Chrome window");
    const selected = window.tabs?.find((tab) => tab.active) ?? window.tabs?.[0];
    this.browserState = {
      windowId: window.id!,
      tabId: selected?.id,
    };
    return this.browserContext();
  }

  async browserContext(): Promise<BrowserContext> {
    const state = await this.currentBrowserState();
    const tabs = await this.tabsOf(state);
    return { windowId: state.windowId, tabs: tabs.map(({ index, id, current, title, url }) => ({ index, tabId: id, current, title, url })) };
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

  private async tabsOf(state: BrowserState): Promise<Array<{ index: number; current: boolean; id?: number; title?: string; url?: string }>> {
    const tabs = await this.chromeApi.tabs.query({ windowId: state.windowId });
    if (state.tabId === undefined || !tabs.some((tab) => tab.id === state.tabId)) {
      state.tabId = tabs.find((tab) => tab.active)?.id ?? tabs[0]?.id;
    }
    return tabs.map((tab, index) => ({ index, current: tab.id === state.tabId || !state.tabId && Boolean(tab.active), id: tab.id, title: tab.title, url: tab.url }));
  }

  private async selectTab(state: BrowserState, tabId: number): Promise<unknown> {
    const tabs = await this.chromeApi.tabs.query({ windowId: state.windowId });
    const tab = tabs.find((item) => item.id === tabId);
    if (!tab?.id) throw new Error(`CommandError[invalid-tab-id]: ${tabId}`);
    await this.chromeApi.tabs.update(tab.id, { active: true });
    state.tabId = tab.id;
    return this.tabsOf(state);
  }

  private async closeTab(state: BrowserState, tabId: number): Promise<unknown> {
    const tabs = await this.chromeApi.tabs.query({ windowId: state.windowId });
    const tab = tabs.find((item) => item.id === tabId);
    if (!tab?.id) throw new Error(`CommandError[invalid-tab-id]: ${tabId}`);
    await this.detachTabRuntime(tab.id);
    await this.chromeApi.tabs.remove(tab.id);
    const remaining = await this.chromeApi.tabs.query({ windowId: state.windowId });
    state.tabId = remaining.find((item) => item.active)?.id ?? remaining[0]?.id;
    return this.tabsOf(state);
  }

  private async pageFor(state: BrowserState): Promise<any> {
    let tabId = state.tabId;
    if (tabId !== undefined) {
      const tab = await this.chromeApi.tabs.get(tabId).catch(() => undefined);
      if (!tab || tab.windowId !== state.windowId) tabId = undefined;
    }
    if (tabId === undefined) {
      const tabs = await this.chromeApi.tabs.query({ active: true, windowId: state.windowId });
      tabId = tabs[0]?.id;
    }
    if (!Number.isInteger(tabId)) throw new Error("CommandError[no-tab]: The current Chrome window has no controllable tab");
    const resolvedTabId = tabId as number;
    state.tabId = resolvedTabId;
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
    if (method === "Page.javascriptDialogOpening") this.dialogs.set(tabId!, { type: params.type, message: params.message, defaultPrompt: params.defaultPrompt });
    if (method === "Page.javascriptDialogClosed") this.dialogs.delete(tabId!);
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

  private async readRequest(tabId: number, index: number, bodyOnly = false): Promise<unknown> {
    const record = await this.diagnostics.request(tabId, index);
    if (!record) throw new Error(`CommandError[invalid-request-index]: ${index}`);
    let body: unknown;
    try {
      const response = await this.bridgeCommand(record.debuggee, "Network.getResponseBody", { requestId: record.requestId });
      body = response.base64Encoded ? { base64: response.body } : response.body;
    } catch (error) { body = { unavailable: error instanceof Error ? error.message : String(error) }; }
    return bodyOnly ? body : { ...record, responseBody: body };
  }

  private async detachTabRuntime(tabId: number): Promise<void> {
    await this.releaseInput(tabId);
    if (this.networkEnabled.has(tabId)) await Promise.all([
      this.bridgeCommand({ tabId }, "Network.disable", {}).catch(() => undefined),
      this.bridgeCommand({ tabId }, "Log.disable", {}).catch(() => undefined),
      this.bridgeCommand({ tabId }, "Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => undefined),
    ]);
    this.diagnostics.remove(tabId); this.dialogs.delete(tabId); this.networkEnabled.delete(tabId);
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
    await this.jobs.settle();
    await this.stopBrowserOperations();
    this.browserState = undefined;
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
    const tracked = Boolean(this.programScope && ["Runtime.evaluate", "Runtime.callFunctionOn"].includes(method));
    if (tracked) this.programEvaluations.set(key, {debuggee,count:(this.programEvaluations.get(key)?.count ?? 0)+1});
    let result: any;
    try { result = await (this.bridge.call as any)("sendCommand", [debuggee, method, input]); }
    finally { if (tracked) {
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
