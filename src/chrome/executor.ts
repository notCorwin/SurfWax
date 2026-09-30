import type { EventLogger } from "../logging";
import type { BrowserInput, BrowserSelector, BrowserStep, BrowserTarget, ChromeTarget, ChromeToolInput } from "../types";
import { COMMAND_NAMES, type CommandName } from "./tool";
import { AutomationRuntime } from "./automation";
import { requireDebuggee } from "./debuggee";
import { ensureDownloadPermission } from "./downloads";
import { BrowserDiagnostics } from "./diagnostics";
import { getRunIdentity } from "../agent/coordinator";

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
const RESULT_READER_KEY = "__surfWaxResult";
const STATE_KEY = "__surfWaxExecutionState";
const PAGE_KEY = "__surfWaxPage";
const BROWSER_KEY = "__surfWaxBrowser";
type ExecutionContext = { conversationId?: string; toolCallId?: string; visualEnabled?: boolean; allowDownloads?: boolean; logIdentity?: { runId?: string; toolCallId: string; toolCallIdCanonical: true } };
type BatchProgress = { completed: Array<{ index: number; type: BrowserStep["type"]; result: unknown }>; index: number; startedAt: number };
type ArtifactRef = { id: number; filename: string; mimeType: string; byteLength: number; saved: boolean; downloadId?: number };
type BrowserState = { windowId: number; tabId?: number; origins: Set<string> };
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

export function parseCommandTarget(value: unknown): BrowserTarget {
  if (value && typeof value === "object") return value as BrowserTarget;
  if (typeof value !== "string" || !value.trim()) throw new Error("AutomationError[invalid-target]: target is required");
  const input = value.trim();
  if (/^e\d+$/.test(input)) return { ref: input };
  const locator = /^locator\((.+)\)$/.exec(input);
  if (locator) return { by: "css", value: readQuoted(locator[1]!) };
  const simple = /^getBy(Text|Label|Placeholder|AltText|Title|TestId)\((['"][\s\S]*?['"])(?:\s*,\s*\{([\s\S]*)\})?\)$/.exec(input);
  if (simple) {
    const by = ({ Text: "text", Label: "label", Placeholder: "placeholder", AltText: "alt", Title: "title", TestId: "testId" } as const)[simple[1] as "Text"];
    const options = simple[3]?.trim();
    if (options && !/^exact\s*:\s*(?:true|false)$/.test(options)) throw new Error(`AutomationError[invalid-target]: Unsupported locator expression ${JSON.stringify(input)}; use a structured target or run-code`);
    return { by, value: readQuoted(simple[2]!), ...(options ? { exact: /true$/.test(options) } : {}) };
  }
  const role = /^getByRole\((['"][\s\S]*?['"])(?:\s*,\s*\{([\s\S]*)\})?\)$/.exec(input);
  if (role) {
    const options = role[2] ?? "";
    const name = /\bname\s*:\s*(['"][\s\S]*?['"])(?:\s*,|$)/.exec(options)?.[1];
    const unsupportedOptions = options.replace(/\bname\s*:\s*(['"][\s\S]*?['"])/, "").replace(/\bexact\s*:\s*(?:true|false)/, "").replace(/[\s,]/g, "");
    if (unsupportedOptions) throw new Error(`AutomationError[invalid-target]: Unsupported locator expression ${JSON.stringify(input)}; use a structured target or run-code`);
    return { by: "role", value: readQuoted(role[1]!), ...(name ? { name: readQuoted(name) } : {}), ...(/\bexact\s*:\s*true\b/.test(options) ? { exact: true } : {}) };
  }
  if (/^[A-Za-z_$][\w$]*\s*\(/.test(input)) throw new Error(`AutomationError[invalid-target]: Unsupported locator expression ${JSON.stringify(input)}; use a structured target or run-code`);
  return { by: "css", value: input };
}

function timestamped(prefix: string, extension: string): string {
  return `${prefix}-${new Date().toISOString().replace(/[:.]/g, "-")}.${extension}`;
}

function base64ByteLength(base64: string): number {
  return Math.floor(base64.length * 3 / 4) - (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0);
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
    const browser = globalThis[${JSON.stringify(BROWSER_KEY)}];
    const chrome = undefined;
    const result = await (async () => {
${code}
    })();
    ${resultEnvelope()}
  })()`;
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

function automationExpressionFor(code: string, tabId?: number): string {
  return `(async () => {
    const page = await globalThis[${JSON.stringify(PAGE_KEY)}].create(${tabId === undefined ? "undefined" : tabId});
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
  private readonly targetUrl: string;
  private readonly logger?: EventLogger;
  private port?: chrome.runtime.Port;
  private readonly bridge: Record<string, unknown>;
  private readonly automation: AutomationRuntime;
  private readonly lifetime = { aborted: false };
  private tail: Promise<void> = Promise.resolve();
  private activeDebuggee?: Debuggee;
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

  constructor(options: { chromeApi?: ExecutorChrome; targetUrl?: string; logger?: EventLogger } = {}) {
    this.chromeApi = options.chromeApi ?? globalThis.chrome as ExecutorChrome;
    this.targetUrl = options.targetUrl ?? ensureSidePanelInstanceUrl();
    this.logger = options.logger;
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
      detach: async (debuggee) => {
        await (this.bridge.call as any)("detach", [debuggee]);
        this.bridgedDebuggees.delete(JSON.stringify(debuggee));
      },
      mark: async (tabId) => (globalThis as Record<string, any>).__surfWaxGuard?.mark(tabId),
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
    (globalThis as Record<string, unknown>)[PAGE_KEY] = { create: (tabId?: number) => this.automation.createPage(tabId) };
    (globalThis as Record<string, unknown>)[BROWSER_KEY] = {
      page: async (tabId?: number) => {
        const state = await this.currentBrowserState();
        if (tabId !== undefined) {
          const tab = await this.chromeApi.tabs.get(tabId);
          if (tab.windowId !== state.windowId) throw new Error("CommandError[invalid-tab-id]: Tab is outside the bound window");
          state.tabId = tabId;
        }
        return this.pageFor(state);
      },
      runIn: async (target: ChromeTarget | { tabId: number }, code: string) => {
        if (target && typeof target === "object" && !("kind" in target) && Number.isInteger(target.tabId)) {
          const value = await this.awaitAbort(this.automation.pageValue(target.tabId, pageExpressionFor(code)), this.activeSignal);
          return evaluationValue({ result: { value } }, "page");
        }
        return this.executeNow({ target: target as ChromeTarget, code }, this.activeSignal, this.activeContext);
      },
      cdp: (debuggee: Debuggee) => ({
        send: (method: string, params?: object) => this.bridgeCommand(debuggee, method, params),
        detach: () => (this.bridge.call as any)("detach", [debuggee]),
      }),
      result: (id: number, selection?: { path?: string | Array<string | number>; offset?: number; limit?: number }) => this.logger?.result(id, selection, this.activeContext.conversationId ?? ""),
    };
    (globalThis as Record<string, unknown>)[RESULT_READER_KEY] = (id: number, selection?: { path?: string | Array<string | number>; offset?: number; limit?: number }) => this.logger?.result(id, selection, this.activeContext.conversationId ?? "")
      ?? Promise.reject(new Error("Tool result log is unavailable"));
  }

  execute(input: ChromeToolInput, signal?: AbortSignal, context: ExecutionContext = {}): Promise<unknown> {
    const task = this.tail.then(() => this.executeTimed(input, signal, context));
    this.tail = task.then(() => undefined, () => undefined);
    return task;
  }

  executeBrowser(input: BrowserInput, signal?: AbortSignal, context: ExecutionContext = {}): Promise<unknown> {
    const progress: BatchProgress = { completed: [], index: 0, startedAt: performance.now() };
    return this.enqueueAbortable(
      (combined) => this.executeBrowserTimed(input, combined, context, progress), signal,
      input.mode === "act" ? input.timeoutMs ?? 10_000 : input.mode === "result" ? undefined : input.timeoutMs,
      input.mode !== "result" && input.mode !== "observe",
    ).catch((error) => {
      if (input.mode !== "act") throw error;
      const failure = this.structuredError(error);
      return { ok: false, error: failure, completed: [...progress.completed], failed: progress.index < input.steps.length ? { index: progress.index, step: input.steps[progress.index], error: failure } : null, notRun: input.steps.slice(progress.index + 1), elapsedMs: performance.now() - progress.startedAt };
    });
  }

  /** Internal compatibility path for restored tests/conversations; it is not model-visible. */
  executePage(input: { code: string; tabId?: number; timeoutMs?: number }, signal?: AbortSignal, context: ExecutionContext = {}): Promise<unknown> {
    return this.executeBrowser({ mode: "run", code: `const page = await browser.page(${input.tabId === undefined ? "undefined" : input.tabId});\n${input.code}`, timeoutMs: input.timeoutMs }, signal, context);
  }

  executeCommand(name: CommandName, input: Record<string, any>, signal?: AbortSignal, context: ExecutionContext = {}): Promise<unknown> {
    if (!COMMAND_NAMES.includes(name)) return Promise.reject(new Error(`CommandError[unsupported]: ${name}`));
    return this.enqueueAbortable(
      (combined) => this.executeCommandTimed(name, input, combined, context), signal,
      input.timeoutMs ?? (this.commandNeedsTimeout(name) ? 10_000 : undefined),
      !["snapshot", "find", "tab-list", "requests", "request", "request-headers", "request-body", "response-headers", "response-body"].includes(name),
    );
  }

  private enqueueAbortable<T>(run: (signal?: AbortSignal) => Promise<T>, signal?: AbortSignal, timeoutMs?: number, mayHaveEffect = true): Promise<T> {
    const previous = this.tail;
    let operationStarted = false;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    const started = previous.then(() => {
      const timeout = timeoutMs ? new AbortController() : undefined;
      const timer = timeout ? setTimeout(() => timeout.abort(new DOMException(`Operation timed out after ${timeoutMs}ms`, "TimeoutError")), timeoutMs) : undefined;
      const combined = timeout ? signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal : signal;
      operationStarted = !combined?.aborted;
      const work = run(combined);
      const done = () => { if (timer !== undefined) clearTimeout(timer); release(); };
      void work.then(done, done);
      return { work, combined };
    });
    return this.awaitAbort(started, signal).catch((error) => {
      if (operationStarted && mayHaveEffect && signal?.aborted) Object.assign(error, { effectUnknown: true });
      throw error;
    }).then(({ work, combined }) => this.awaitAbort(work, combined, mayHaveEffect));
  }

  private async executeCommandTimed(name: CommandName, input: Record<string, any>, signal?: AbortSignal, context: ExecutionContext = {}): Promise<unknown> {
    try {
      if (this.disposed) throw new Error("Chrome executor has been disposed");
      throwIfAborted(signal);
      this.automation.setContext({ ...context, signal });
      this.activeSignal = signal;
      this.activeContext = context;
      this.diagnostics.bind(context);
      const result = await this.executeCommandNow(name, input);
      throwIfAborted(signal);
      return result;
    } catch (error) {
      if (signal?.aborted) { await this.stopBrowserOperations(); }
      this.recordExecutionFailure(error, { code: name }, context);
      throw error;
    } finally {
      this.activeSignal = undefined;
      this.activeContext = {};
      await this.automation.clearContext();
    }
  }

  private commandNeedsTimeout(name: CommandName): boolean {
    return name !== "artifact-save";
  }

  private async executeCommandNow(name: CommandName, input: Record<string, any>): Promise<unknown> {
    throwIfAborted(this.activeSignal);
    if (name === "artifact-save") return this.saveArtifact(input.id, input.filename);
    const state = await this.currentBrowserState();
    throwIfAborted(this.activeSignal);
    if (name === "tab-list") return this.tabsOf(state);
    if (name === "tab-new") {
      const tab = await this.chromeApi.tabs.create({ windowId: state.windowId, active: true, ...(input.url ? { url: input.url } : {}) });
      state.tabId = tab.id;
      await this.rememberOrigin(state, tab.url);
      return this.tabsOf(state);
    }
    if (name === "tab-select") return this.selectTab(state, input.index, input.tabId);
    if (name === "tab-close") return this.closeTab(state, input.index, input.tabId);

    const page = await this.pageFor(state);
    throwIfAborted(this.activeSignal);
    const tabId = page.tabId;
    if (name === "goto") return this.withPageStatus(state, await page.goto(input.url));
    if (name === "go-back") return this.withPageStatus(state, await page.goBack());
    if (name === "go-forward") return this.withPageStatus(state, await page.goForward());
    if (name === "reload") return this.withPageStatus(state, await page.reload());
    if (name === "type") {
      await page.insertText(input.text);
      if (input.submit) { throwIfAborted(this.activeSignal); await page.press("Enter"); }
      return this.withPageStatus(state, { performed: true });
    }
    if (name === "press") return this.withPageStatus(state, await page.press(input.key));
    if (name === "keydown" || name === "keyup") {
      await this.automation.keyState(tabId, name, input.key);
      return this.withPageStatus(state, { performed: true });
    }
    if (["mousemove", "mousedown", "mouseup", "mousewheel"].includes(name)) {
      const held = this.inputState(tabId);
      const mask = [...held.buttons].reduce((result, button) => result | (button === "left" ? 1 : button === "right" ? 2 : 4), 0);
      const params = name === "mousemove" ? { type: "mouseMoved", x: input.x, y: input.y, buttons: mask }
        : name === "mousedown" ? { type: "mousePressed", x: held.x, y: held.y, button: input.button ?? "left", buttons: mask | (input.button === "right" ? 2 : input.button === "middle" ? 4 : 1), clickCount: input.clickCount ?? 1 }
        : name === "mouseup" ? { type: "mouseReleased", x: held.x, y: held.y, button: input.button ?? "left", buttons: mask & ~(input.button === "right" ? 2 : input.button === "middle" ? 4 : 1), clickCount: input.clickCount ?? 1 }
        : { type: "mouseWheel", x: held.x, y: held.y, buttons: mask, deltaX: input.dx, deltaY: input.dy };
      await this.bridgeCommand({ tabId }, "Input.dispatchMouseEvent", params);
      return this.withPageStatus(state, { performed: true });
    }
    if (["click", "dblclick", "hover", "fill", "drag", "drop", "select", "upload", "check", "uncheck"].includes(name)) {
      return this.executeInteraction(name, input, page, state);
    }
    if (name === "snapshot") {
      let result = await page.snapshot();
      if (input.depth !== undefined) result = { ...result, snapshot: String(result.snapshot).split("\n").filter((line) => (line.match(/^\s*/)?.[0].length ?? 0) / 2 <= input.depth).join("\n") };
      if (input.target) {
        const text = await this.locatorFor(page, input.target).innerText();
        result = { ...result, snapshot: text };
      }
      if (input.boxes) {
        const refs = [...String(result.snapshot).matchAll(/\[ref=(e\d+)\]/g)].map((match) => match[1]!);
        const entries = await Promise.all(refs.map(async (ref) => [ref, await page.ref(ref).evaluate("el => { const r = el.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; }")]));
        result = { ...result, boxes: Object.fromEntries(entries) };
      }
      if (input.filename || input.save) return { ...result, artifact: await this.storeText(input.filename ?? timestamped("snapshot", "yaml"), result.snapshot, "text/yaml", input.save) };
      return result;
    }
    if (name === "find") {
      const snapshot = await page.snapshot();
      const needle = String(input.text ?? "").toLocaleLowerCase();
      const lines = String(snapshot.snapshot).split("\n");
      const matches = needle ? lines.flatMap((line, i) => line.toLocaleLowerCase().includes(needle) ? lines.slice(Math.max(0, i - 1), i + 2) : []) : lines;
      return { url: snapshot.url, title: snapshot.title, matches: [...new Set(matches)] };
    }
    if (name === "eval") {
      const value = input.target ? await this.locatorFor(page, input.target).evaluate(input.func) : await page.evaluate(input.func);
      if (input.filename || input.save) return { value: null, artifact: await this.storeText(input.filename ?? timestamped("evaluation", "json"), typeof value === "string" ? value : JSON.stringify(value, null, 2), "application/json", input.save) };
      return value;
    }
    if (name === "dialog-accept" || name === "dialog-dismiss") {
      const dialog = this.dialogs.get(tabId);
      if (!dialog) throw new Error("AutomationError[no-dialog]: No dialog is open");
      await this.bridgeCommand({ tabId }, "Page.handleJavaScriptDialog", { accept: name === "dialog-accept", ...(input.prompt === undefined ? {} : { promptText: input.prompt }) });
      this.dialogs.delete(tabId);
      return { handled: true, dialog };
    }
    if (name === "screenshot") return this.captureScreenshot(page, input);
    if (name === "pdf") return this.capturePdf(tabId, input.filename, input.save);
    if (["requests", "request", "request-headers", "request-body", "response-headers", "response-body"].includes(name)) return this.networkCommand(name, tabId, input);
    if (name === "console") return this.consoleCommand(tabId, input);
    if (name === "run-code") return this.runPageCode(tabId, input.code, input.save);
    throw new Error(`CommandError[unsupported]: ${name}`);
  }

  private async executeInteraction(name: string, input: Record<string, any>, page: any, state: BrowserState): Promise<unknown> {
    if (name === "drag") return this.withPageStatus(state, await this.locatorFor(page, input.startTarget).dragTo(this.locatorFor(page, input.endTarget)));
    const subject = this.locatorFor(page, input.target ?? "input[type=file]");
    let result: unknown;
    if (name === "click") result = await subject.click({ button: input.button, modifiers: input.modifiers });
    else if (name === "dblclick") result = await subject.dblclick({ button: input.button, modifiers: input.modifiers });
    else if (name === "hover") result = await subject.hover();
    else if (name === "fill") { result = await subject.fill(input.text); if (input.submit) { throwIfAborted(this.activeSignal); await subject.press("Enter"); } }
    else if (name === "select") result = await subject.selectOption(input.values);
    else if (name === "upload") { const files = await this.normalizeFiles(input.files); throwIfAborted(this.activeSignal); result = input.target ? await subject.setInputFiles(files) : await page.upload(files); }
    else if (name === "check") result = await subject.check();
    else if (name === "uncheck") result = await subject.uncheck();
    else if (name === "drop") {
      const normalized = await this.normalizeFiles(input.files ?? []);
      throwIfAborted(this.activeSignal);
      result = await subject.evaluate(`function(el, payload){
        const transfer = new DataTransfer();
        for (const file of payload.files) { const bytes = file.base64 ? Uint8Array.from(atob(file.base64), c => c.charCodeAt(0)) : new TextEncoder().encode(file.text || ""); transfer.items.add(new File([bytes], file.name, {type:file.mimeType || "application/octet-stream"})); }
        for (const [type, value] of Object.entries(payload.data || {})) transfer.setData(type, value);
        el.dispatchEvent(new DragEvent("drop", {bubbles:true, cancelable:true, dataTransfer:transfer}));
      }`, { files: normalized, data: input.data ?? {} });
    }
    return this.withPageStatus(state, result);
  }

  private locatorFor(page: any, raw: unknown): any {
    const target = parseCommandTarget(raw);
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
    const previous = this.browserState;
    const window = await this.chromeApi.windows.getCurrent({ populate: true });
    if (!Number.isInteger(window.id)) throw new Error("CommandError[no-window]: Could not resolve the current Chrome window");
    const selected = window.tabs?.find((tab) => tab.active) ?? window.tabs?.[0];
    this.browserState = {
      windowId: window.id!,
      tabId: selected?.id,
      origins: previous && previous.windowId === window.id ? previous.origins : new Set<string>(),
    };
    await this.rememberOrigin(this.browserState, selected?.url);
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
    const state = { windowId: window.id!, tabId: selected?.id, origins: new Set<string>() };
    this.browserState = state;
    await this.rememberOrigin(state, selected?.url);
    return state;
  }

  private async tabsOf(state: BrowserState): Promise<Array<{ index: number; current: boolean; id?: number; title?: string; url?: string }>> {
    const tabs = await this.chromeApi.tabs.query({ windowId: state.windowId });
    if (state.tabId === undefined || !tabs.some((tab) => tab.id === state.tabId)) {
      state.tabId = tabs.find((tab) => tab.active)?.id ?? tabs[0]?.id;
      await this.rememberOrigin(state, tabs.find((tab) => tab.id === state.tabId)?.url);
    }
    return tabs.map((tab, index) => ({ index, current: tab.id === state.tabId || !state.tabId && Boolean(tab.active), id: tab.id, title: tab.title, url: tab.url }));
  }

  private async selectTab(state: BrowserState, index?: number, tabId?: number): Promise<unknown> {
    const tabs = await this.chromeApi.tabs.query({ windowId: state.windowId });
    if ((index === undefined) === (tabId === undefined)) throw new Error("CommandError[invalid-tab-target]: Exactly one of tabId or index is required");
    const tab = tabId === undefined ? tabs[index!] : tabs.find((item) => item.id === tabId);
    if (!tab?.id) throw new Error(`CommandError[invalid-tab-${tabId === undefined ? "index" : "id"}]: ${tabId ?? index}`);
    await this.chromeApi.tabs.update(tab.id, { active: true });
    state.tabId = tab.id;
    await this.rememberOrigin(state, tab.url);
    return this.tabsOf(state);
  }

  private async closeTab(state: BrowserState, index?: number, tabId?: number): Promise<unknown> {
    const tabs = await this.chromeApi.tabs.query({ windowId: state.windowId });
    if (index !== undefined && tabId !== undefined) throw new Error("CommandError[invalid-tab-target]: Use tabId or index, not both");
    const tab = tabId !== undefined ? tabs.find((item) => item.id === tabId) : index === undefined ? tabs.find((item) => item.id === state.tabId) ?? tabs.find((item) => item.active) : tabs[index];
    if (!tab?.id) throw new Error(`CommandError[invalid-tab-${tabId === undefined ? "index" : "id"}]: ${String(tabId ?? index)}`);
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
      else await this.rememberOrigin(state, tab.url);
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
    const url = await page.url().catch(() => undefined);
    await this.rememberOrigin(state, url === undefined ? undefined : String(url));
    return page;
  }

  private async rememberOrigin(state: BrowserState, url?: string): Promise<void> {
    if (!url) return;
    try { const parsed = new URL(url); if (["http:", "https:"].includes(parsed.protocol)) state.origins.add(parsed.origin); } catch { /* Internal pages have no clearable origin. */ }
  }

  private async withPageStatus(state: BrowserState, result: unknown): Promise<unknown> {
    const page = await this.pageFor(state);
    const status = { url: await page.url(), title: await page.title(), modal: state.tabId === undefined ? undefined : this.dialogs.get(state.tabId) };
    const tabs = await this.tabsOf(state);
    return { result, page: status, ...(tabs.length > 1 ? { tabs } : {}) };
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
    if (save) {
      throwIfAborted(this.activeSignal);
      try { await ensureDownloadPermission(this.activeSignal, artifact); } catch (error) { throw Object.assign(error instanceof Error ? error : new Error(String(error)), { artifact }); }
      throwIfAborted(this.activeSignal);
    }
    const downloadId = save ? await this.chromeApi.downloads.download({ url: `data:${mimeType};base64,${base64}`, filename, saveAs: false }) : undefined;
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
    try { await ensureDownloadPermission(this.activeSignal, artifact); } catch (error) { throw Object.assign(error instanceof Error ? error : new Error(String(error)), { artifact }); }
    throwIfAborted(this.activeSignal);
    const downloadId = await this.chromeApi.downloads.download({ url: `data:${stored.mimeType};base64,${stored.base64}`, filename, saveAs: false });
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
    return { observationId: observation.observationId, viewport: observation.viewport, artifact, screenshot: { mediaType, artifactId: artifact.id, width: captured.width, height: captured.height, scale: captured.scale, origin: captured.origin }, page: { url: await page.url(), title: await page.title() } };
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

  private async networkCommand(name: string, tabId: number, input: Record<string, any>): Promise<unknown> {
    if (name === "requests") return this.diagnostics.requests(tabId, input);
    const record = await this.diagnostics.request(tabId, Number(input.index));
    if (!record) throw new Error(`CommandError[invalid-request-index]: ${String(input.index)}`);
    let value: unknown;
    if (name === "request-headers") value = record.requestHeaders;
    else if (name === "request-body") value = record.requestBody ?? null;
    else if (name === "response-headers") value = record.responseHeaders ?? {};
    else {
      let body: unknown = null;
      try {
        const response = await this.bridgeCommand(record.debuggee, "Network.getResponseBody", { requestId: record.requestId });
        body = response.base64Encoded ? { base64: response.body } : response.body;
      } catch (error) { body = { unavailable: error instanceof Error ? error.message : String(error) }; }
      value = name === "response-body" ? body : { ...record, responseBody: body };
    }
    if (input.filename || input.save) return { artifact: await this.storeText(input.filename ?? timestamped(name, "json"), typeof value === "string" ? value : JSON.stringify(value, null, 2), "application/json", input.save) };
    return value;
  }

  private consoleCommand(tabId: number, input: Record<string, any>): Promise<unknown> {
    return this.diagnostics.console(tabId, input);
  }

  private async runPageCode(tabId: number, code: string, save = false): Promise<unknown> {
    if (!/^\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.test(code) && !/^\s*(?:async\s+)?function\b/.test(code)) {
      throw new Error("CommandError[invalid-code]: run-code requires one function expression receiving page");
    }
    return this.executeNow({ code: `const page = await browser.page(${tabId});
return await (async (page, chrome, browser, globalThis, self, window, document, location, __surfWaxBrowser, __surfWaxDebugger, __surfWaxResult, __surfWaxResults) => (${code})(page))(page);`, target: { kind: "extension" }, save }, this.activeSignal, { ...this.activeContext, allowDownloads: save });
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
      const tabs = new Set([...this.networkEnabled, ...this.heldInput.keys()]);
      await Promise.all([...tabs].map((tabId) => this.detachTabRuntime(tabId)));
      await this.automation.abortSessions();
      this.diagnostics.clear();
    })();
    this.endingRun = cleanup;
    try { await cleanup; } finally { if (this.endingRun === cleanup) this.endingRun = undefined; }
  }

  async endRun(): Promise<void> {
    await this.stopBrowserOperations();
    this.browserState = undefined;
  }

  private async executeTimed(input: ChromeToolInput, signal?: AbortSignal, context: ExecutionContext = {}): Promise<unknown> {
    const timeout = input.timeoutMs ? new AbortController() : undefined;
    const timer = timeout ? setTimeout(() => timeout.abort(new DOMException(`Operation timed out after ${input.timeoutMs}ms`, "TimeoutError")), input.timeoutMs) : undefined;
    const combined = timeout ? signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal : signal;
    try { return await this.executeNow(input, combined, context); }
    catch (error) {
      this.recordExecutionFailure(error, input, context);
      throw error;
    }
    finally { if (timer !== undefined) clearTimeout(timer); }
  }

  private async executeBrowserTimed(input: BrowserInput, signal?: AbortSignal, context: ExecutionContext = {}, progress?: BatchProgress): Promise<unknown> {
    if (input.mode === "result") {
      throwIfAborted(signal);
      if (!this.logger) throw new Error("Tool result log is unavailable");
      return this.logger.result(input.id, { path: input.path, offset: input.offset, limit: input.limit }, context.conversationId ?? "");
    }
    try {
      if (this.disposed) throw new Error("Chrome executor has been disposed");
      throwIfAborted(signal);
      this.automation.setContext({ ...context, signal });
      this.activeSignal = signal;
      this.activeContext = context;
      this.diagnostics.bind(context);
      if (input.mode === "run") return await this.executeNow({ code: input.code, target: input.target ?? { kind: "extension" }, timeoutMs: input.timeoutMs }, signal, context);
      const state = await this.currentBrowserState();
      if (input.tabId !== undefined) {
        const tab = await this.chromeApi.tabs.get(input.tabId);
        if (tab.windowId !== state.windowId) throw new Error("CommandError[invalid-tab-id]: Tab is outside the bound window");
        state.tabId = input.tabId;
      }
      const page = await this.pageFor(state);
      if (input.mode === "observe") {
        if (input.detail === "visual" && !context.visualEnabled) throw new Error("AutomationError[visual-unavailable]: Image input is disabled or unsupported by the selected model");
        const result = await page.observe(input.detail === "visual" || input.detail === "auto" && context.visualEnabled ? input.detail : "semantic", input.since);
        if (!context.visualEnabled && (result as any).screenshot) throw new Error("AutomationError[visual-unavailable]: Image input is disabled or unsupported by the selected model");
        return !context.visualEnabled && (input.detail ?? "auto") === "auto" && !String((result as any).snapshot).includes("[ref=")
          ? { ...result, visual: { available: false, error: { code: "visual-unavailable", message: "Image input is disabled, unsupported, or unknown for the selected model" } } }
          : result;
      }
      if (input.observationId) await page.ensureObservation(input.observationId);
      return await this.executeSteps(page, input.steps, input.observationId, context.visualEnabled ?? false, progress);
    } catch (error) {
      if (signal?.aborted) { await this.stopBrowserOperations(); }
      const failure = signal?.reason instanceof DOMException && signal.reason.name === "TimeoutError"
        ? new Error(`AutomationError[timeout]: ${JSON.stringify({ timeoutMs: input.timeoutMs ?? 10_000 })}`) : error;
      this.recordExecutionFailure(failure, input, context);
      return { ok: false, error: this.structuredError(failure), completed: [], failed: null, notRun: input.mode === "act" ? input.steps : [] };
    } finally {
      this.activeSignal = undefined;
      this.activeContext = {};
      await this.automation.clearContext();
    }
  }

  private async executeSteps(page: any, steps: BrowserStep[], observationId: string | undefined, visualEnabled: boolean, progress?: BatchProgress): Promise<unknown> {
    const startedAt = performance.now();
    const completed: Array<{ index: number; type: BrowserStep["type"]; result: unknown }> = progress?.completed ?? [];
    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index]!;
      if (progress) progress.index = index;
      try {
        throwIfAborted(this.activeSignal);
        completed.push({ index, type: step.type, result: await this.executeStep(page, step, observationId) });
        if (this.logger && this.activeContext.conversationId && this.activeContext.toolCallId) {
          const saved = await this.logger.append({ type: "tool.progress", conversationId: this.activeContext.conversationId,
            ...(this.activeContext.logIdentity ?? { toolCallId: this.activeContext.toolCallId }),
            content: { nextIndex: index + 1, steps }, output: { completed: [...completed], elapsedMs: performance.now() - startedAt } });
          if (!saved) throw new DOMException("Could not persist the completed act step", "AbortError");
        }
      } catch (error) {
        if (this.activeSignal?.aborted) await this.stopBrowserOperations();
        let observation: unknown;
        if (!this.activeSignal?.aborted) try { observation = await page.observe(visualEnabled ? "auto" : "semantic"); } catch { /* Preserve the original failure. */ }
        return { ok: false, completed, failed: { index, step, error: this.structuredError(error) }, notRun: steps.slice(index + 1), elapsedMs: performance.now() - startedAt, ...(observation ? { observation } : {}) };
      }
    }
    if (progress) progress.index = steps.length;
    return { ok: true, completed, elapsedMs: performance.now() - startedAt };
  }

  private async executeStep(page: any, step: BrowserStep, defaultObservationId?: string): Promise<unknown> {
    if (step.type === "goto") return page.goto(step.url);
    if (step.type === "press" || step.type === "insertText") {
      const subject = step.target ? this.locatorFor(page, step.target) : page;
      return step.type === "press" ? subject.press(step.key) : step.target ? subject.pressSequentially(step.text) : page.insertText(step.text);
    }
    if (step.type === "expect") {
      if (step.url) await page.waitForURL(step.url);
      if (!step.target) return { matched: true };
      const target = this.locatorFor(page, step.target);
      if (step.state) await target.waitFor({ state: step.state });
      if (step.text !== undefined && !String(await target.innerText()).includes(step.text)) throw new Error(`AutomationError[expectation-failed]: Expected text ${JSON.stringify(step.text)}`);
      if (step.value !== undefined && await target.inputValue() !== step.value) throw new Error(`AutomationError[expectation-failed]: Expected value ${JSON.stringify(step.value)}`);
      return { matched: true };
    }
    if (step.type === "drag") return this.locatorFor(page, step.from).dragTo(this.locatorFor(page, step.to));
    const target = this.locatorFor(page, step.target);
    if ("point" in step.target && (step.type === "click" || step.type === "doubleClick" || step.type === "hover")) {
      const point = step.target.point;
      return page.point(point.observationId || defaultObservationId, point.x, point.y, step.type === "doubleClick" ? "dblclick" : step.type, { button: step.button, modifiers: step.modifiers });
    }
    if (step.type === "click") return target.click({ button: step.button, modifiers: step.modifiers });
    if (step.type === "doubleClick") return target.dblclick({ button: step.button, modifiers: step.modifiers });
    if (step.type === "hover") return target.hover();
    if (step.type === "fill") return target.fill(step.value);
    if (step.type === "clear") return target.clear();
    if (step.type === "select") return target.selectOption(step.values);
    if (step.type === "check") return step.checked === false ? target.uncheck() : target.check();
    if (step.type === "upload") return target.setInputFiles(await this.normalizeFiles(step.files));
    throw new Error(`AutomationError[unsupported]: ${JSON.stringify({ step })}`);
  }

  private structuredError(error: unknown): { code: string; message: string; detail?: unknown; effectUnknown?: boolean } {
    const message = error instanceof Error ? error.message : String(error);
    const match = /^AutomationError\[([^\]]+)\]:\s*(.*)$/.exec(message);
    if (!match) return { ...(error && typeof error === "object" && "effectUnknown" in error && error.effectUnknown ? { effectUnknown: true } : {}), code: error instanceof DOMException && error.name === "AbortError" ? "aborted" : error instanceof DOMException && error.name === "TimeoutError" ? "timeout" : "execution-failed", message };
    let detail: unknown;
    try { detail = JSON.parse(match[2]!); } catch { detail = match[2]; }
    return { code: match[1]!, message, detail };
  }

  private recordExecutionFailure(error: unknown, input: ChromeToolInput | BrowserInput, context: ExecutionContext): void {
    const message = error instanceof Error ? error.message : String(error);
    const target = "mode" in input ? { kind: input.mode, tabId: "tabId" in input ? input.tabId : undefined }
      : input.target ?? (input.tabId !== undefined ? { kind: "page", tabId: input.tabId } : { kind: "extension" });
    if (/user gesture|user activation|permission|not allowed|denied/i.test(message)) {
      this.logger?.record({
        type: "interaction.required",
        conversationId: context.conversationId,
        ...context.logIdentity,
        content: { message, target, action: "Complete the browser prompt or required user gesture, then continue this conversation." },
      });
    } else if (/unavailable|not exposed|not installed|not currently|requires/i.test(message)) {
      this.logger?.record({ type: "capability.unavailable", conversationId: context.conversationId, ...context.logIdentity, content: { message, target } });
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.lifetime.aborted = true;
    void this.endRun();
    this.browserState = undefined;
    this.disposed = true;
    if ((globalThis as Record<string, unknown>)[BRIDGE_KEY] === this.bridge) {
      delete (globalThis as Record<string, unknown>)[BRIDGE_KEY];
      delete (globalThis as Record<string, unknown>)[RESULT_READER_KEY];
      delete (globalThis as Record<string, unknown>)[PAGE_KEY];
      delete (globalThis as Record<string, unknown>)[BROWSER_KEY];
    }
    this.automation.dispose();
    const sessions = [this.activeDebuggee].filter((item): item is Debuggee => Boolean(item));
    this.activeDebuggee = undefined;
    for (const debuggee of sessions) void this.chromeApi.debugger.detach(debuggee).catch(() => undefined);
    this.port?.disconnect();
  }

  private async executeNow(input: ChromeToolInput, signal?: AbortSignal, context: ExecutionContext = {}): Promise<unknown> {
    if (this.disposed) throw new Error("Chrome executor has been disposed");
    throwIfAborted(signal);

    const target = this.normalizeTarget(input);
    this.logger?.record({ type: "tool.route", conversationId: context.conversationId, content: { target } });

    if (target.kind === "page") {
      if (!Number.isInteger(target.tabId) && !target.targetId) throw new Error("A page target requires tabId or targetId. Query chrome.tabs or chrome.debugger.getTargets first.");
      if (Number.isInteger(target.tabId)) await (globalThis as Record<string, any>).__surfWaxGuard?.mark(target.tabId);
      throwIfAborted(signal);
      if (target.tabId !== undefined && target.frameId === undefined && target.documentId === undefined && !target.targetId && !target.sessionId
        && (target.world === undefined || target.world === "MAIN") && this.automation.hasSession(target.tabId)) {
        const value = await this.awaitAbort(this.automation.pageValue(target.tabId, pageExpressionFor(input.code)), signal);
        return evaluationValue({ result: { value } }, "page");
      }
      if (target.world === "USER_SCRIPT") return this.evaluateUserScript(target, input.code, signal);
      if (target.world === "ISOLATED") return this.evaluateIsolated(target, input.code, signal);
      if (target.targetId) return this.evaluateCdpPage(target, input.code, signal);
      return this.evaluate({ tabId: target.tabId }, pageExpressionFor(input.code), signal, "page");
    }

    const targets = await this.chromeApi.debugger.getTargets();
    if (this.disposed) throw abortError();
    throwIfAborted(signal);
    const panelTarget = targets.find((candidate) => candidate.url === this.targetUrl && candidate.id);
    if (!panelTarget?.id) throw new Error(`Side Panel DevTools target not found: ${this.targetUrl}`);
    return this.evaluate({ targetId: panelTarget.id }, expressionFor(input.code), signal, "extension", input.save);
  }

  private normalizeTarget(input: ChromeToolInput): ChromeTarget {
    if (input.tabId !== undefined) return { kind: "page", tabId: input.tabId, world: input.world ?? "MAIN" };
    const target = input.target ?? { kind: "extension" as const };
    if (!["auto", "extension", "page"].includes(target.kind)) throw new Error(`CommandError[unsupported-target]: ${target.kind}`);
    if (target.kind !== "auto") return target;
    if (target.tabId !== undefined || target.targetId !== undefined) return { ...target, kind: "page", world: target.world ?? "MAIN" };
    if (/\b(?:chrome\.|__surfWaxResult\b)/.test(input.code) || !/\b(?:document|window|location|navigator)\b/.test(input.code)) return { kind: "extension" };
    throw new Error("Automatic target selection is ambiguous. Select extension or page explicitly.");
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
    return (this.bridge.call as any)("sendCommand", [debuggee, method, input]);
  }

  private async evaluateIsolated(target: ChromeTarget, code: string, signal?: AbortSignal): Promise<unknown> {
    if (target.documentId) throw new Error("ISOLATED execution cannot resolve documentId directly. Use frameId, targetId/sessionId, or USER_SCRIPT.");
    const debuggee: Debuggee = target.targetId
      ? { targetId: target.targetId, ...(target.sessionId ? { sessionId: target.sessionId } : {}) } as Debuggee
      : { tabId: target.tabId! };
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

  private async evaluateUserScript(target: ChromeTarget, code: string, signal?: AbortSignal): Promise<unknown> {
    if (!this.chromeApi.userScripts?.execute) throw new Error("Allow User Scripts 未开启，或 Chrome 不支持该操作。");
    if (target.frameId !== undefined && target.documentId) throw new Error("Specify frameId or documentId, not both.");
    const tabId = target.tabId ?? (target.targetId ? (await this.chromeApi.debugger.getTargets()).find((item) => item.id === target.targetId)?.tabId : undefined);
    if (!Number.isInteger(tabId)) throw new Error("USER_SCRIPT execution requires a page tabId or resolvable targetId.");
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

  private async evaluateCdpPage(target: ChromeTarget, code: string, signal?: AbortSignal): Promise<unknown> {
    const debuggee = { ...(target.targetId ? { targetId: target.targetId } : { tabId: target.tabId }), ...(target.sessionId ? { sessionId: target.sessionId } : {}) } as Debuggee;
    const response = await this.bridgeCommand(debuggee, "Runtime.evaluate", {
      expression: pageExpressionFor(code), awaitPromise: true, returnByValue: true, userGesture: true,
    });
    throwIfAborted(signal);
    const error = evaluationError(response);
    if (error) throw error;
    return evaluationValue(response, "page");
  }

  private async awaitAbort<T>(task: Promise<T>, signal?: AbortSignal, effectUnknown = false): Promise<T> {
    if (!signal) return task;
    if (signal.aborted) throw interruptionError(signal, effectUnknown);
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(interruptionError(signal, effectUnknown));
      signal.addEventListener("abort", abort, { once: true });
      void task.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  }

  private async evaluate(debuggee: Debuggee, expression: string, signal?: AbortSignal, scope = "extension", allowDownloads = false): Promise<unknown> {
    let attached = false;
    const state = { lifetime: this.lifetime, run: { aborted: false, allowDownloads } };
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
    }
  }
}
