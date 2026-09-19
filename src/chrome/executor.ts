import type { EventLogger } from "../logging";
import type { BrowserInput, BrowserSelector, BrowserStep, BrowserTarget, ChromeTarget, ChromeToolInput } from "../types";
import { restoreUserScripts, snapshotUserScripts } from "../userscripts/persistence";
import { AutomationRuntime } from "./automation";
import { requireDebuggee } from "./debuggee";

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
type ExecutionContext = { conversationId?: string; toolCallId?: string; visualEnabled?: boolean };

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
    const browser = globalThis[${JSON.stringify(BROWSER_KEY)}];
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
        return property === "capabilities" ? async () => {
          const report = await __bridge.call("capabilities", []);
          report.web = {
            languageModel: "LanguageModel" in globalThis,
            summarizer: "Summarizer" in globalThis,
            translator: "Translator" in globalThis,
            languageDetector: "LanguageDetector" in globalThis,
            webMcp: Boolean(document.modelContext),
          };
          return report;
        }
          : property === "debugger" ? __debugger
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
  private initialized?: Promise<void>;
  private activeDebuggee?: Debuggee;
  private readonly bridgedDebuggees = new Set<string>();
  private disposed = false;
  private activeSignal?: AbortSignal;
  private activeContext: ExecutionContext = {};

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
    this.automation = new AutomationRuntime({
      chromeApi: this.chromeApi,
      command: (debuggee, method, params) => this.bridgeCommand(debuggee, method, params),
      detach: async (debuggee) => {
        await (this.bridge.call as any)("detach", [debuggee]);
        this.bridgedDebuggees.delete(JSON.stringify(debuggee));
      },
      mark: async (tabId) => (globalThis as Record<string, any>).__surfWaxGuard?.mark(tabId),
      logger: this.logger,
    });
    listeners.onEvent.add((source, method, params) => this.automation.handleEvent(source, method, params));
    listeners.onDetach.add((source) => {
      this.bridgedDebuggees.delete(JSON.stringify(source));
      this.automation.handleDetach(source);
    });
    (globalThis as Record<string, unknown>)[BRIDGE_KEY] = this.bridge;
    (globalThis as Record<string, unknown>)[PAGE_KEY] = { create: (tabId?: number) => this.automation.createPage(tabId) };
    (globalThis as Record<string, unknown>)[BROWSER_KEY] = {
      page: (tabId?: number) => this.automation.createPage(tabId),
      runIn: (target: ChromeTarget, code: string) => this.executeNow({ target, code }, this.activeSignal, this.activeContext),
      cdp: (debuggee: Debuggee) => ({
        send: (method: string, params?: object) => this.bridgeCommand(debuggee, method, params),
        detach: () => (this.bridge.call as any)("detach", [debuggee]),
      }),
      result: (id: number, selection?: { path?: Array<string | number>; offset?: number; limit?: number }) => this.logger?.result(id, selection),
    };
    (globalThis as Record<string, unknown>)[RESULT_READER_KEY] = (id: number, selection?: { path?: Array<string | number>; offset?: number; limit?: number }) => this.logger?.result(id, selection)
      ?? Promise.reject(new Error("Tool result log is unavailable"));
  }

  execute(input: ChromeToolInput, signal?: AbortSignal, context: ExecutionContext = {}): Promise<unknown> {
    const task = this.tail.then(() => this.executeTimed(input, signal, context));
    this.tail = task.then(() => undefined, () => undefined);
    return task;
  }

  executeBrowser(input: BrowserInput, signal?: AbortSignal, context: ExecutionContext = {}): Promise<unknown> {
    const task = this.tail.then(() => this.executeBrowserTimed(input, signal, context));
    this.tail = task.then(() => undefined, () => undefined);
    return task;
  }

  /** Internal compatibility path for restored tests/conversations; it is not model-visible. */
  executePage(input: { code: string; tabId?: number; timeoutMs?: number }, signal?: AbortSignal, context: ExecutionContext = {}): Promise<unknown> {
    return this.executeBrowser({ mode: "run", code: `const page = await browser.page(${input.tabId === undefined ? "undefined" : input.tabId});\n${input.code}`, timeoutMs: input.timeoutMs }, signal, context);
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

  private async executeBrowserTimed(input: BrowserInput, signal?: AbortSignal, context: ExecutionContext = {}): Promise<unknown> {
    const timeout = input.timeoutMs ? new AbortController() : undefined;
    const timer = timeout ? setTimeout(() => timeout.abort(new DOMException(`Operation timed out after ${input.timeoutMs}ms`, "TimeoutError")), input.timeoutMs) : undefined;
    const combined = timeout ? signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal : signal;
    try {
      if (this.disposed) throw new Error("Chrome executor has been disposed");
      throwIfAborted(combined);
      await this.initialize();
      this.automation.setContext({ ...context, signal: combined });
      this.activeSignal = combined;
      this.activeContext = context;
      if (input.mode === "run") return await this.executeNow({ code: input.code, target: { kind: "extension" }, timeoutMs: input.timeoutMs }, combined, context);
      const page = await this.automation.createPage(input.tabId);
      if (input.mode === "observe") {
        if (input.detail === "visual" && !context.visualEnabled) throw new Error("AutomationError[visual-unavailable]: Image input is disabled or unsupported by the selected model");
        const result = await page.observe(input.detail === "visual" || input.detail === "auto" && context.visualEnabled ? input.detail : "semantic", input.since);
        if (!context.visualEnabled && (result as any).screenshot) throw new Error("AutomationError[visual-unavailable]: Image input is disabled or unsupported by the selected model");
        return !context.visualEnabled && (input.detail ?? "auto") === "auto" && !String((result as any).snapshot).includes("[ref=")
          ? { ...result, visual: { available: false, error: { code: "visual-unavailable", message: "Image input is disabled, unsupported, or unknown for the selected model" } } }
          : result;
      }
      if (input.observationId) await page.ensureObservation(input.observationId);
      return await this.executeSteps(page, input.steps, input.observationId, context.visualEnabled ?? false);
    } catch (error) {
      if (combined?.aborted) await this.automation.abortSessions();
      const failure = timeout?.signal.aborted && !signal?.aborted ? new Error(`AutomationError[timeout]: ${JSON.stringify({ timeoutMs: input.timeoutMs })}`) : error;
      this.recordExecutionFailure(failure, input, context);
      return { ok: false, error: this.structuredError(failure), completed: [], failed: null, notRun: input.mode === "act" ? input.steps : [] };
    } finally {
      this.activeSignal = undefined;
      this.activeContext = {};
      await this.automation.clearContext();
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async executeSteps(page: any, steps: BrowserStep[], observationId: string | undefined, visualEnabled: boolean): Promise<unknown> {
    const startedAt = performance.now();
    const completed: Array<{ index: number; type: BrowserStep["type"]; result: unknown }> = [];
    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index]!;
      try {
        completed.push({ index, type: step.type, result: await this.executeStep(page, step, observationId) });
      } catch (error) {
        if (this.activeSignal?.aborted) await this.automation.abortSessions();
        let observation: unknown;
        if (!this.activeSignal?.aborted) try { observation = await page.observe(visualEnabled ? "auto" : "semantic"); } catch { /* Preserve the original failure. */ }
        return { ok: false, completed, failed: { index, step, error: this.structuredError(error) }, notRun: steps.slice(index + 1), elapsedMs: performance.now() - startedAt, ...(observation ? { observation } : {}) };
      }
    }
    return { ok: true, completed, elapsedMs: performance.now() - startedAt };
  }

  private locator(page: any, target: BrowserTarget): any {
    if ("point" in target) return target;
    if ("ref" in target) return page.ref(target.ref);
    const selector = target as BrowserSelector;
    let scope = selector.frame ? page.frameLocator(selector.frame.value) : page;
    const options = { exact: selector.exact };
    let locator = selector.by === "role" ? scope.getByRole(selector.value, { ...options, name: selector.name })
      : selector.by === "text" ? scope.getByText(selector.value, options)
      : selector.by === "label" ? scope.getByLabel(selector.value, options)
      : selector.by === "placeholder" ? scope.getByPlaceholder(selector.value, options)
      : selector.by === "alt" ? scope.getByAltText(selector.value, options)
      : selector.by === "title" ? scope.getByTitle(selector.value, options)
      : selector.by === "testId" ? scope.getByTestId(selector.value)
      : scope.locator(selector.value);
    if (selector.index !== undefined) locator = locator.nth(selector.index);
    return locator;
  }

  private async executeStep(page: any, step: BrowserStep, defaultObservationId?: string): Promise<unknown> {
    if (step.type === "goto") return page.goto(step.url);
    if (step.type === "press" || step.type === "insertText") {
      const subject = step.target ? this.locator(page, step.target) : page;
      return step.type === "press" ? subject.press(step.key) : step.target ? subject.pressSequentially(step.text) : page.insertText(step.text);
    }
    if (step.type === "expect") {
      if (step.url) await page.waitForURL(step.url);
      if (!step.target) return { matched: true };
      const target = this.locator(page, step.target);
      if (step.state) await target.waitFor({ state: step.state });
      if (step.text !== undefined && !String(await target.innerText()).includes(step.text)) throw new Error(`AutomationError[expectation-failed]: Expected text ${JSON.stringify(step.text)}`);
      if (step.value !== undefined && await target.inputValue() !== step.value) throw new Error(`AutomationError[expectation-failed]: Expected value ${JSON.stringify(step.value)}`);
      return { matched: true };
    }
    if (step.type === "drag") return this.locator(page, step.from).dragTo(this.locator(page, step.to));
    const target = this.locator(page, step.target);
    if ("point" in step.target && ["click", "doubleClick", "hover"].includes(step.type)) {
      const point = step.target.point;
      return page.point(point.observationId || defaultObservationId, point.x, point.y, step.type === "doubleClick" ? "dblclick" : step.type);
    }
    if (step.type === "click") return target.click();
    if (step.type === "doubleClick") return target.dblclick();
    if (step.type === "hover") return target.hover();
    if (step.type === "fill") return target.fill(step.value);
    if (step.type === "clear") return target.clear();
    if (step.type === "select") return target.selectOption(step.values);
    if (step.type === "check") return step.checked === false ? target.uncheck() : target.check();
    if (step.type === "upload") return target.setInputFiles(step.files);
    throw new Error(`AutomationError[unsupported]: ${JSON.stringify({ step })}`);
  }

  private structuredError(error: unknown): { code: string; message: string; detail?: unknown } {
    const message = error instanceof Error ? error.message : String(error);
    const match = /^AutomationError\[([^\]]+)\]:\s*(.*)$/.exec(message);
    if (!match) return { code: error instanceof DOMException && error.name === "AbortError" ? "aborted" : error instanceof DOMException && error.name === "TimeoutError" ? "timeout" : "execution-failed", message };
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
        content: { message, target, action: "Complete the browser prompt or required user gesture, then continue this conversation." },
      });
    } else if (/unavailable|not exposed|not installed|not currently|requires/i.test(message)) {
      this.logger?.record({ type: "capability.unavailable", conversationId: context.conversationId, content: { message, target } });
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.lifetime.aborted = true;
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

  private async executeNow(input: ChromeToolInput, signal?: AbortSignal, context: ExecutionContext = {}): Promise<unknown> {
    if (this.disposed) throw new Error("Chrome executor has been disposed");
    throwIfAborted(signal);
    await this.initialize();
    throwIfAborted(signal);

    const target = this.normalizeTarget(input);
    this.logger?.record({ type: "tool.route", conversationId: context.conversationId, content: { target } });

    if (target.kind === "page") {
      if (!Number.isInteger(target.tabId) && !target.targetId) throw new Error("A page target requires tabId or targetId. Query chrome.tabs or chrome.debugger.getTargets first.");
      if (Number.isInteger(target.tabId)) await (globalThis as Record<string, any>).__surfWaxGuard?.mark(target.tabId);
      throwIfAborted(signal);
      if (target.tabId !== undefined && target.world !== "ISOLATED" && this.chromeApi.userScripts?.execute) {
        const targetSpec = target.documentId
          ? { tabId: target.tabId!, documentIds: [target.documentId] }
          : target.frameId !== undefined ? { tabId: target.tabId!, frameIds: [target.frameId] } : { tabId: target.tabId! };
        const result = await this.awaitAbort(
          this.chromeApi.userScripts.execute({
            target: targetSpec,
            world: target.world ?? "MAIN",
            js: [{ code: pageExpressionFor(input.code) }],
            injectImmediately: true,
          }),
          signal,
        );
        throwIfAborted(signal);
        const first = result[0];
        if (!first) throw new Error(`No injection result for tab ${target.tabId}`);
        if (first.error) throw new Error(first.error);
        const value = evaluationValue({ result: { value: first.result } }, "page") as any;
        if (value?.ref && first.documentId) value.documentId = first.documentId;
        return value;
      }
      if (target.world === "USER_SCRIPT") throw new Error("Chrome User Scripts is disabled. Enable Allow User Scripts on the extension details page and reload the side panel.");
      if (target.world === "ISOLATED") return this.evaluateIsolated(target, input.code, signal);
      if (target.targetId) return this.evaluateCdpPage(target, input.code, signal);
      return this.evaluate({ tabId: target.tabId }, pageExpressionFor(input.code), signal, "page");
    }

    if (target.kind === "offscreen") {
      await this.ensureOffscreen();
      return this.evaluateHostTarget("offscreen.html", input.code, signal, "offscreen", target.targetId);
    }

    if (target.kind === "devtools") {
      return this.evaluateHostTarget("devtools.html", input.code, signal, "devtools", target.targetId);
    }

    if (target.kind === "service-worker") {
      return this.evaluateWorker(input.code, signal, target.targetId);
    }

    const targets = await this.chromeApi.debugger.getTargets();
    if (this.disposed) throw abortError();
    throwIfAborted(signal);
    const panelTarget = targets.find((candidate) => candidate.url === this.targetUrl && candidate.id);
    if (!panelTarget?.id) throw new Error(`Side Panel DevTools target not found: ${this.targetUrl}`);
    return this.evaluate({ targetId: panelTarget.id }, expressionFor(input.code), signal, "extension");
  }

  private normalizeTarget(input: ChromeToolInput): ChromeTarget {
    if (input.tabId !== undefined) return { kind: "page", tabId: input.tabId, world: input.world ?? "MAIN" };
    const target = input.target ?? { kind: "extension" as const };
    if (target.kind !== "auto") return target;
    if (target.tabId !== undefined || target.targetId !== undefined) return { ...target, kind: "page", world: target.world ?? "MAIN" };
    if (/\b(?:chrome\.|__surfWaxResult\b)/.test(input.code) || !/\b(?:document|window|location|navigator)\b/.test(input.code)) return { kind: "extension" };
    throw new Error("Automatic target selection is ambiguous. Retry with target.kind set to extension, page, service-worker, offscreen, or devtools.");
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
      filter: [{ type: "iframe", exclude: false }, { type: "worker", exclude: false }, { type: "shared_worker", exclude: false }],
    }]).catch(() => undefined);
  }

  private async bridgeCommand(debuggee: Debuggee, method: string, params?: object): Promise<any> {
    await this.bridgeDebuggee(debuggee);
    return (this.bridge.call as any)("sendCommand", [debuggee, method, params]);
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

  private async ensureOffscreen(): Promise<void> {
    if (!this.chromeApi.offscreen) throw new Error("The offscreen API is unavailable in this Chrome version.");
    const contexts = await this.chromeApi.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [this.chromeApi.runtime.getURL("offscreen.html")] });
    if (contexts.length) return;
    await this.chromeApi.offscreen.createDocument({ url: "offscreen.html", reasons: ["DOM_PARSER"], justification: "Run browser-agent Web APIs that require a document." });
  }

  private async evaluateHostTarget(path: string, code: string, signal: AbortSignal | undefined, kind: string, targetId?: string): Promise<unknown> {
    const url = this.chromeApi.runtime.getURL(path);
    const targets = await this.chromeApi.debugger.getTargets();
    const target = targetId ? targets.find((item) => item.id === targetId) : targets.find((item) => item.url.startsWith(url));
    if (!target?.id) throw new Error(`${kind} host is unavailable. ${kind === "devtools" ? "Open DevTools for a tab and retry." : "Reload the extension and retry."}`);
    return this.evaluate({ targetId: target.id }, pageExpressionFor(code), signal, kind);
  }

  private async evaluateWorker(code: string, signal?: AbortSignal, targetId?: string): Promise<unknown> {
    const target = (await this.chromeApi.debugger.getTargets()).find((item) => targetId ? item.id === targetId : item.type === "worker" && item.url.includes("background"));
    if (!target?.id) throw new Error("The extension Service Worker is not currently exposed as a debuggable target.");
    try { return await this.evaluate({ targetId: target.id }, pageExpressionFor(code), signal, "service-worker"); }
    catch (error) { throw new Error(`Service Worker execution is unavailable in this browser session: ${error instanceof Error ? error.message : String(error)}. Desktop builds may launch Chrome with --silent-debugger-extension-api.`); }
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

  private async evaluate(debuggee: Debuggee, expression: string, signal?: AbortSignal, scope = "extension"): Promise<unknown> {
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
