import type { EventLogger } from "../logging";
import type { BrowserInput, BrowserSelector, BrowserStep, BrowserTarget, ChromeTarget, ChromeToolInput } from "../types";
import type { CommandName } from "./tool";
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
type CommandSession = { name: string; windowId: number; tabId?: number; owned: boolean; origins: Set<string> };
type NetworkRecord = {
  requestId: string; method: string; url: string; requestHeaders: Record<string, string>; requestBody?: string;
  status?: number; statusText?: string; responseHeaders?: Record<string, string>; failed?: string; resourceType?: string;
};
type RouteRule = { pattern: string; status?: number; body?: string; contentType?: string; headers?: Record<string, string>; removeHeaders?: string[] };

function abortError(): DOMException {
  return new DOMException("Operation aborted", "AbortError");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function unsupported(command: string): Error {
  return new Error(`CommandError[unsupported-in-extension]: ${command} requires a Playwright CLI or test-runner process`);
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

function globPattern(pattern: string): string {
  return pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*");
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
  private readonly commandSessions = new Map<string, CommandSession>();
  private readonly network = new Map<number, NetworkRecord[]>();
  private readonly networkEnabled = new Set<number>();
  private readonly routes = new Map<number, RouteRule[]>();
  private readonly consoleMessages = new Map<number, Array<{ level: string; text: string; timestamp?: number }>>();
  private readonly dialogs = new Map<number, { type: string; message: string; defaultPrompt?: string }>();
  private readonly traceWaiters = new Map<number, (stream?: string) => void>();
  private readonly tracingTabs = new Set<number>();
  private readonly videoStates = new Map<number, {
    filename: string; canvas: HTMLCanvasElement; context: CanvasRenderingContext2D; recorder: MediaRecorder; chunks: Blob[];
    stopped: Promise<Blob>; stop: () => void; actions?: { durationMs: number; position: string; cursor: string }; overlay?: { title: string; description?: string; until: number };
  }>();

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
      page: (tabId?: number) => this.automation.createPage(tabId),
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
      result: (id: number, selection?: { path?: string | Array<string | number>; offset?: number; limit?: number }) => this.logger?.result(id, selection),
    };
    (globalThis as Record<string, unknown>)[RESULT_READER_KEY] = (id: number, selection?: { path?: string | Array<string | number>; offset?: number; limit?: number }) => this.logger?.result(id, selection)
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

  executeCommand(name: CommandName, input: Record<string, any>, signal?: AbortSignal, context: ExecutionContext = {}): Promise<unknown> {
    const task = this.tail.then(() => this.executeCommandTimed(name, input, signal, context));
    this.tail = task.then(() => undefined, () => undefined);
    return task;
  }

  private async executeCommandTimed(name: CommandName, input: Record<string, any>, signal?: AbortSignal, context: ExecutionContext = {}): Promise<unknown> {
    const timeoutMs = input.timeoutMs ?? (this.commandNeedsTimeout(name) ? 10_000 : undefined);
    const timeout = timeoutMs ? new AbortController() : undefined;
    const timer = timeout ? setTimeout(() => timeout.abort(new DOMException(`Operation timed out after ${timeoutMs}ms`, "TimeoutError")), timeoutMs) : undefined;
    const combined = timeout ? signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal : signal;
    try {
      if (this.disposed) throw new Error("Chrome executor has been disposed");
      throwIfAborted(combined);
      await this.initialize();
      this.automation.setContext({ ...context, signal: combined });
      this.activeSignal = combined;
      this.activeContext = context;
      const result = await this.executeCommandNow(name, input);
      return result;
    } catch (error) {
      if (combined?.aborted) await this.automation.abortSessions();
      this.recordExecutionFailure(error, { code: name }, context);
      throw error;
    } finally {
      this.activeSignal = undefined;
      this.activeContext = {};
      await this.automation.clearContext();
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private commandNeedsTimeout(name: CommandName): boolean {
    return !["recording-start", "recording-stop", "tracing-start", "tracing-stop", "video-start", "video-stop", "video-chapter", "video-show-actions", "video-hide-actions", "list", "close-all", "kill-all"].includes(name);
  }

  private async executeCommandNow(name: CommandName, input: Record<string, any>): Promise<unknown> {
    throwIfAborted(this.activeSignal);
    if (["install", "install-browser", "pause-at", "resume", "step-over"].includes(name)) throw unsupported(name);
    if (name === "open") return this.openSession(input.session ?? "default", input.url);
    if (name === "attach") return this.attachSession(input.session ?? "default", input.name);
    if (name === "list") return this.listSessions();
    if (name === "close-all" || name === "kill-all") return this.closeAllSessions();

    const session = await this.commandSession(input.session ?? "default");
    if (name === "close") return this.closeSession(session);
    if (name === "detach") return this.detachSession(session);
    if (name === "show") {
      await this.chromeApi.windows.update(session.windowId, { focused: true });
      return this.sessionStatus(session);
    }
    if (name === "tab-list") return this.tabsOf(session);
    if (name === "tab-new") {
      const tab = await this.chromeApi.tabs.create({ windowId: session.windowId, active: true, ...(input.url ? { url: input.url } : {}) });
      session.tabId = tab.id;
      await this.rememberOrigin(session, tab.url);
      return this.tabsOf(session);
    }
    if (name === "tab-select") return this.selectTab(session, input.index);
    if (name === "tab-close") return this.closeTab(session, input.index);

    const page = await this.pageFor(session);
    const tabId = page.tabId;
    await this.annotateVideo(tabId, name, input);
    if (name === "goto") return this.withPageStatus(session, await page.goto(input.url));
    if (name === "go-back") return this.withPageStatus(session, await page.goBack());
    if (name === "go-forward") return this.withPageStatus(session, await page.goForward());
    if (name === "reload") return this.withPageStatus(session, await page.reload());
    if (name === "type") {
      await page.insertText(input.text);
      if (input.submit) await page.press("Enter");
      return this.withPageStatus(session, { performed: true });
    }
    if (name === "press") return this.withPageStatus(session, await page.press(input.key));
    if (name === "keydown" || name === "keyup") {
      await this.bridgeCommand({ tabId }, "Input.dispatchKeyEvent", { type: name === "keydown" ? "rawKeyDown" : "keyUp", key: input.key, code: input.key });
      return this.withPageStatus(session, { performed: true });
    }
    if (["mousemove", "mousedown", "mouseup", "mousewheel"].includes(name)) {
      const params = name === "mousemove" ? { type: "mouseMoved", x: input.x, y: input.y }
        : name === "mousedown" ? { type: "mousePressed", button: input.button ?? "left", clickCount: 1 }
        : name === "mouseup" ? { type: "mouseReleased", button: input.button ?? "left", clickCount: 1 }
        : { type: "mouseWheel", x: 0, y: 0, deltaX: input.dx, deltaY: input.dy };
      await this.bridgeCommand({ tabId }, "Input.dispatchMouseEvent", params);
      return this.withPageStatus(session, { performed: true });
    }
    if (["click", "dblclick", "hover", "fill", "drag", "drop", "select", "upload", "check", "uncheck"].includes(name)) {
      return this.executeInteraction(name, input, page, session);
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
      if (input.filename) return { ...result, artifact: await this.downloadText(input.filename, result.snapshot, "text/yaml") };
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
      if (input.filename) return { value: null, artifact: await this.downloadText(input.filename, typeof value === "string" ? value : JSON.stringify(value, null, 2), "application/json") };
      return value;
    }
    if (name === "dialog-accept" || name === "dialog-dismiss") {
      const dialog = this.dialogs.get(tabId);
      if (!dialog) throw new Error("AutomationError[no-dialog]: No dialog is open");
      await this.bridgeCommand({ tabId }, "Page.handleJavaScriptDialog", { accept: name === "dialog-accept", ...(input.prompt === undefined ? {} : { promptText: input.prompt }) });
      this.dialogs.delete(tabId);
      return { handled: true, dialog };
    }
    if (name === "resize") {
      await this.bridgeCommand({ tabId }, "Emulation.setDeviceMetricsOverride", { width: input.width, height: input.height, deviceScaleFactor: 1, mobile: false });
      return { width: input.width, height: input.height };
    }
    if (name === "delete-data") return this.deleteSessionData(session);
    if (name === "screenshot") return this.captureScreenshot(session, page, input);
    if (name === "pdf") return this.capturePdf(tabId, input.filename);
    if (name === "state-save") return this.saveState(session, page, input.filename ?? timestamped("storage-state", "json"));
    if (name === "state-load") return this.loadState(session, page, input.filename);
    if (name.startsWith("localstorage-") || name.startsWith("sessionstorage-")) return this.storageCommand(name, page, input);
    if (name.startsWith("cookie-")) return this.cookieCommand(name, session, page, input);
    if (["requests", "request", "request-headers", "request-body", "response-headers", "response-body", "route", "route-list", "unroute", "network-state-set"].includes(name)) return this.networkCommand(name, session, tabId, input);
    if (name === "console") return this.consoleCommand(tabId, input);
    if (name === "run-code") return this.runPageCode(tabId, input.code);
    if (name === "recording-start" || name === "recording-stop") return this.recordingCommand(name, page);
    if (name === "tracing-start" || name === "tracing-stop") return this.tracingCommand(name, tabId, input.filename);
    if (name.startsWith("video-")) return this.videoCommand(name, tabId, input);
    if (name === "generate-locator") return this.generateLocator(page, input.target);
    if (name === "highlight") return this.highlight(page, input);
    throw new Error(`CommandError[unsupported]: ${name}`);
  }

  private async executeInteraction(name: string, input: Record<string, any>, page: any, session: CommandSession): Promise<unknown> {
    if (name === "drag") return this.withPageStatus(session, await this.locatorFor(page, input.startTarget).dragTo(this.locatorFor(page, input.endTarget)));
    const subject = this.locatorFor(page, input.target ?? "input[type=file]");
    let result: unknown;
    if (name === "click") result = await subject.click({ button: input.button, modifiers: input.modifiers });
    else if (name === "dblclick") result = await subject.dblclick({ button: input.button, modifiers: input.modifiers });
    else if (name === "hover") result = await subject.hover();
    else if (name === "fill") { result = await subject.fill(input.text); if (input.submit) await subject.press("Enter"); }
    else if (name === "select") result = await subject.selectOption(input.values);
    else if (name === "upload") result = await subject.setInputFiles(input.files);
    else if (name === "check") result = await subject.check();
    else if (name === "uncheck") result = await subject.uncheck();
    else if (name === "drop") {
      const normalized = await this.normalizeFiles(input.files ?? []);
      result = await subject.evaluate(`function(el, payload){
        const transfer = new DataTransfer();
        for (const file of payload.files) { const bytes = file.base64 ? Uint8Array.from(atob(file.base64), c => c.charCodeAt(0)) : new TextEncoder().encode(file.text || ""); transfer.items.add(new File([bytes], file.name, {type:file.mimeType || "application/octet-stream"})); }
        for (const [type, value] of Object.entries(payload.data || {})) transfer.setData(type, value);
        el.dispatchEvent(new DragEvent("drop", {bubbles:true, cancelable:true, dataTransfer:transfer}));
      }`, { files: normalized, data: input.data ?? {} });
    }
    return this.withPageStatus(session, result);
  }

  private locatorFor(page: any, raw: unknown): any {
    const target = parseCommandTarget(raw);
    if ("point" in target) return { click: () => page.point(target.point.observationId, target.point.x, target.point.y, "click"), dblclick: () => page.point(target.point.observationId, target.point.x, target.point.y, "dblclick"), hover: () => page.point(target.point.observationId, target.point.x, target.point.y, "hover") };
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

  private async commandSession(name: string): Promise<CommandSession> {
    const existing = this.commandSessions.get(name);
    if (existing) {
      const window = await this.chromeApi.windows.get(existing.windowId).catch(() => undefined);
      if (window) return existing;
      this.commandSessions.delete(name);
    }
    const window = await this.chromeApi.windows.getCurrent({ populate: true });
    if (!Number.isInteger(window.id)) throw new Error("CommandError[no-window]: Could not resolve the current Chrome window");
    const selected = window.tabs?.find((tab) => tab.active) ?? window.tabs?.[0];
    const session = { name, windowId: window.id!, tabId: selected?.id, owned: false, origins: new Set<string>() };
    this.commandSessions.set(name, session);
    await this.rememberOrigin(session, selected?.url);
    return session;
  }

  private async openSession(name: string, url?: string): Promise<unknown> {
    const previous = this.commandSessions.get(name);
    if (previous?.owned) await this.chromeApi.windows.remove(previous.windowId).catch(() => undefined);
    const window = await this.chromeApi.windows.create({ focused: true, ...(url ? { url } : {}) });
    if (!window || !Number.isInteger(window.id)) throw new Error("CommandError[open-failed]: Chrome did not return a window id");
    const selected = window.tabs?.find((tab) => tab.active) ?? window.tabs?.[0];
    const session = { name, windowId: window.id!, tabId: selected?.id, owned: true, origins: new Set<string>() };
    this.commandSessions.set(name, session);
    await this.rememberOrigin(session, selected?.url ?? url);
    return this.sessionStatus(session);
  }

  private async attachSession(sessionName: string, targetName: string): Promise<unknown> {
    const match = /^chrome-(\d+)$/.exec(targetName);
    if (!match) throw new Error(`CommandError[invalid-session-target]: Use a chrome-<windowId> name returned by list; received ${JSON.stringify(targetName)}`);
    const windowId = Number(match[1]);
    const window = await this.chromeApi.windows.get(windowId, { populate: true }).catch(() => undefined);
    if (!window) throw new Error(`CommandError[window-unavailable]: ${targetName}`);
    const selected = window.tabs?.find((tab) => tab.active) ?? window.tabs?.[0];
    const session = { name: sessionName, windowId, tabId: selected?.id, owned: false, origins: new Set<string>() };
    this.commandSessions.set(sessionName, session);
    await this.rememberOrigin(session, selected?.url);
    return this.sessionStatus(session);
  }

  private async closeSession(session: CommandSession): Promise<unknown> {
    if (!session.owned) throw new Error("CommandError[attached-session]: detach an attached Chrome window instead of closing it");
    await this.chromeApi.windows.remove(session.windowId);
    this.commandSessions.delete(session.name);
    return { closed: session.name };
  }

  private async detachSession(session: CommandSession): Promise<unknown> {
    if (session.tabId !== undefined) await this.detachTabRuntime(session.tabId);
    this.commandSessions.delete(session.name);
    return { detached: session.name, windowId: session.windowId };
  }

  private async closeAllSessions(): Promise<unknown> {
    const owned = [...this.commandSessions.values()].filter((session) => session.owned);
    await Promise.all(owned.map((session) => this.chromeApi.windows.remove(session.windowId).catch(() => undefined)));
    for (const session of [...this.commandSessions.values()]) if (session.tabId !== undefined) await this.detachTabRuntime(session.tabId);
    this.commandSessions.clear();
    return { closed: owned.map((session) => session.name) };
  }

  private async listSessions(): Promise<unknown> {
    const windows = await this.chromeApi.windows.getAll({ populate: true });
    return {
      sessions: await Promise.all([...this.commandSessions.values()].map((session) => this.sessionStatus(session))),
      available: windows.filter((window) => Number.isInteger(window.id)).map((window) => ({ name: `chrome-${window.id}`, windowId: window.id, focused: window.focused, tabs: window.tabs?.length ?? 0, url: window.tabs?.find((tab) => tab.active)?.url })),
    };
  }

  private async sessionStatus(session: CommandSession): Promise<unknown> {
    return { name: session.name, windowId: session.windowId, owned: session.owned, currentTabId: session.tabId, tabs: await this.tabsOf(session) };
  }

  private async tabsOf(session: CommandSession): Promise<Array<{ index: number; current: boolean; id?: number; title?: string; url?: string }>> {
    const tabs = await this.chromeApi.tabs.query({ windowId: session.windowId });
    return tabs.map((tab, index) => ({ index, current: tab.id === session.tabId || !session.tabId && Boolean(tab.active), id: tab.id, title: tab.title, url: tab.url }));
  }

  private async selectTab(session: CommandSession, index: number): Promise<unknown> {
    const tabs = await this.chromeApi.tabs.query({ windowId: session.windowId });
    const tab = tabs[index];
    if (!tab?.id) throw new Error(`CommandError[invalid-tab-index]: ${index}`);
    await this.chromeApi.tabs.update(tab.id, { active: true });
    await this.chromeApi.windows.update(session.windowId, { focused: true });
    session.tabId = tab.id;
    await this.rememberOrigin(session, tab.url);
    return this.tabsOf(session);
  }

  private async closeTab(session: CommandSession, index?: number): Promise<unknown> {
    const tabs = await this.chromeApi.tabs.query({ windowId: session.windowId });
    const tab = index === undefined ? tabs.find((item) => item.id === session.tabId) ?? tabs.find((item) => item.active) : tabs[index];
    if (!tab?.id) throw new Error(`CommandError[invalid-tab-index]: ${String(index)}`);
    await this.chromeApi.tabs.remove(tab.id);
    const remaining = await this.chromeApi.tabs.query({ windowId: session.windowId });
    session.tabId = remaining.find((item) => item.active)?.id ?? remaining[0]?.id;
    return this.tabsOf(session);
  }

  private async pageFor(session: CommandSession): Promise<any> {
    let tabId = session.tabId;
    if (tabId !== undefined) {
      const tab = await this.chromeApi.tabs.get(tabId).catch(() => undefined);
      if (!tab || tab.windowId !== session.windowId) tabId = undefined;
      else await this.rememberOrigin(session, tab.url);
    }
    if (tabId === undefined) {
      const tabs = await this.chromeApi.tabs.query({ active: true, windowId: session.windowId });
      tabId = tabs[0]?.id;
    }
    if (!Number.isInteger(tabId)) throw new Error("CommandError[no-tab]: The session has no controllable tab");
    const resolvedTabId = tabId as number;
    session.tabId = resolvedTabId;
    const page = await this.automation.createPage(resolvedTabId);
    await this.enableObservation(resolvedTabId);
    const url = await page.url().catch(() => undefined);
    await this.rememberOrigin(session, url === undefined ? undefined : String(url));
    return page;
  }

  private async rememberOrigin(session: CommandSession, url?: string): Promise<void> {
    if (!url) return;
    try { const parsed = new URL(url); if (["http:", "https:"].includes(parsed.protocol)) session.origins.add(parsed.origin); } catch { /* Internal pages have no clearable origin. */ }
  }

  private async withPageStatus(session: CommandSession, result: unknown): Promise<unknown> {
    const page = await this.pageFor(session);
    const status = { url: await page.url(), title: await page.title(), modal: session.tabId === undefined ? undefined : this.dialogs.get(session.tabId) };
    const tabs = await this.tabsOf(session);
    return { result, page: status, ...(tabs.length > 1 ? { tabs } : {}) };
  }

  private async downloadBase64(filename: string, base64: string, mimeType: string): Promise<{ filename: string; mimeType: string; downloadId: number }> {
    const downloadId = await this.chromeApi.downloads.download({ url: `data:${mimeType};base64,${base64}`, filename, saveAs: false });
    return { filename, mimeType, downloadId };
  }

  private async downloadText(filename: string, text: string, mimeType: string): Promise<{ filename: string; mimeType: string; downloadId: number }> {
    const bytes = new TextEncoder().encode(text);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return this.downloadBase64(filename, btoa(binary), mimeType);
  }

  private async normalizeFiles(files: any[]): Promise<any[]> {
    return Promise.all(files.map(async (file) => {
      if (!file.url) return file;
      const response = await fetch(file.url);
      if (!response.ok) throw new Error(`Could not fetch upload URL: ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return { name: file.name, mimeType: file.mimeType || response.headers.get("content-type") || "application/octet-stream", base64: btoa(binary) };
    }));
  }

  private async captureScreenshot(session: CommandSession, page: any, input: Record<string, any>): Promise<unknown> {
    const format = input.type ?? (String(input.filename ?? "").match(/\.(jpe?g|webp)$/i)?.[1]?.replace("jpg", "jpeg") || "png");
    const observation = !input.target && !input.fullPage ? await page.observe("visual") : undefined;
    if (observation && format === "jpeg") {
      const screenshot = observation.screenshot;
      const filename = input.filename ?? timestamped("page", "jpg");
      const artifact = await this.downloadBase64(filename, screenshot.data, screenshot.mediaType);
      return { ...observation, artifact, session: session.name };
    }
    const params: Record<string, unknown> = { format, fromSurface: true, captureBeyondViewport: Boolean(input.fullPage) };
    if (input.fullPage) {
      const metrics = await this.bridgeCommand({ tabId: page.tabId }, "Page.getLayoutMetrics", {});
      if (metrics.contentSize) params.clip = { ...metrics.contentSize, scale: 1 };
    } else if (input.target) {
      const box = await this.locatorFor(page, input.target).evaluate("el => { const r = el.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; }");
      params.clip = { ...box, scale: input.hires ? await page.evaluate("() => devicePixelRatio") : 1 };
    }
    const captured = await this.bridgeCommand({ tabId: page.tabId }, "Page.captureScreenshot", params);
    const mediaType = `image/${format}`;
    const filename = input.filename ?? timestamped("page", format === "jpeg" ? "jpg" : format);
    const artifact = await this.downloadBase64(filename, captured.data, mediaType);
    return { ...(observation ? { observationId: observation.observationId, viewport: observation.viewport } : {}), artifact, screenshot: { mediaType, data: captured.data }, page: { url: await page.url(), title: await page.title() }, session: session.name };
  }

  private async capturePdf(tabId: number, requested?: string): Promise<unknown> {
    const result = await this.bridgeCommand({ tabId }, "Page.printToPDF", { printBackground: true, transferMode: "ReturnAsBase64" });
    const filename = requested ?? timestamped("page", "pdf");
    return { artifact: await this.downloadBase64(filename, result.data, "application/pdf") };
  }

  private async storageCommand(name: string, page: any, input: Record<string, any>): Promise<unknown> {
    const storage = name.startsWith("localstorage") ? "localStorage" : "sessionStorage";
    const action = name.slice(name.indexOf("-") + 1);
    if (action === "list") return page.evaluate(`() => Object.fromEntries(Object.entries(${storage}))`);
    if (action === "get") return page.evaluate(`key => ${storage}.getItem(key)`, input.key);
    if (action === "set") return page.evaluate(`entry => { ${storage}.setItem(entry.key, entry.value); return true; }`, { key: input.key, value: input.value });
    if (action === "delete") return page.evaluate(`key => { ${storage}.removeItem(key); return true; }`, input.key);
    return page.evaluate(`() => { ${storage}.clear(); return true; }`);
  }

  private async cookieCommand(name: string, session: CommandSession, page: any, input: Record<string, any>): Promise<unknown> {
    const url = String(await page.url());
    if (name === "cookie-list") {
      const cookies = await this.chromeApi.cookies.getAll(input.domain ? { domain: input.domain } : { url });
      return input.path ? cookies.filter((cookie) => cookie.path === input.path) : cookies;
    }
    if (name === "cookie-get") return this.chromeApi.cookies.get({ url, name: input.name });
    if (name === "cookie-set") return this.chromeApi.cookies.set({
      url, name: input.name, value: input.value, ...(input.domain ? { domain: input.domain } : {}), path: input.path ?? "/",
      ...(input.expires === undefined ? {} : { expirationDate: input.expires }), ...(input.httpOnly === undefined ? {} : { httpOnly: input.httpOnly }),
      ...(input.secure === undefined ? {} : { secure: input.secure }), ...(input.sameSite ? { sameSite: input.sameSite.toLowerCase() as chrome.cookies.SameSiteStatus } : {}),
    });
    if (name === "cookie-delete") return this.chromeApi.cookies.remove({ url, name: input.name });
    const cookies = (await Promise.all([...session.origins].map((origin) => this.chromeApi.cookies.getAll({ url: origin })))).flat();
    await Promise.all(cookies.map((cookie) => this.chromeApi.cookies.remove({ url: `${cookie.secure ? "https" : "http"}://${cookie.domain.replace(/^\./, "")}${cookie.path}`, name: cookie.name, storeId: cookie.storeId }).catch(() => undefined)));
    return { cleared: cookies.length };
  }

  private async deleteSessionData(session: CommandSession): Promise<unknown> {
    const origins = [...session.origins];
    if (origins.length) await this.chromeApi.browsingData.remove({ origins: origins as [string, ...string[]] }, { cache: true, cacheStorage: true, cookies: true, fileSystems: true, indexedDB: true, localStorage: true, serviceWorkers: true, webSQL: true });
    return { deletedOrigins: origins };
  }

  private async saveState(session: CommandSession, page: any, filename: string): Promise<unknown> {
    const cookies = (await Promise.all([...session.origins].map((origin) => this.chromeApi.cookies.getAll({ url: origin })))).flat();
    const origin = new URL(String(await page.url())).origin;
    const localStorage = await page.evaluate("() => Object.fromEntries(Object.entries(window.localStorage))");
    const state = { cookies, origins: [{ origin, localStorage }] };
    await this.chromeApi.storage.local.set({ [`side-agent:browser-state:${filename}`]: state });
    return { state, artifact: await this.downloadText(filename, JSON.stringify(state, null, 2), "application/json") };
  }

  private async loadState(session: CommandSession, page: any, filename: string): Promise<unknown> {
    const key = `side-agent:browser-state:${filename}`;
    const state = (await this.chromeApi.storage.local.get(key))[key] as any;
    if (!state) throw new Error(`CommandError[state-unavailable]: No saved state named ${JSON.stringify(filename)}`);
    await Promise.all((state.cookies ?? []).map((cookie: chrome.cookies.Cookie) => this.chromeApi.cookies.set({
      url: `${cookie.secure ? "https" : "http"}://${cookie.domain.replace(/^\./, "")}${cookie.path}`, name: cookie.name, value: cookie.value,
      domain: cookie.domain, path: cookie.path, secure: cookie.secure, httpOnly: cookie.httpOnly, sameSite: cookie.sameSite, ...(cookie.expirationDate ? { expirationDate: cookie.expirationDate } : {}),
    })));
    const current = new URL(String(await page.url())).origin;
    const saved = state.origins?.find((item: any) => item.origin === current);
    if (saved) await page.evaluate("values => { localStorage.clear(); for (const [key,value] of Object.entries(values)) localStorage.setItem(key, String(value)); }", saved.localStorage);
    session.origins.add(current);
    return { loaded: filename, cookies: state.cookies?.length ?? 0, origin: current };
  }

  private async enableObservation(tabId: number): Promise<void> {
    if (this.networkEnabled.has(tabId)) return;
    this.networkEnabled.add(tabId);
    await Promise.all([
      this.bridgeCommand({ tabId }, "Network.enable", {}),
      this.bridgeCommand({ tabId }, "Runtime.enable", {}),
      this.bridgeCommand({ tabId }, "Log.enable", {}),
      this.bridgeCommand({ tabId }, "Page.setInterceptFileChooserDialog", { enabled: true }),
    ]).catch((error) => { this.networkEnabled.delete(tabId); throw error; });
  }

  private async handleCommandEvent(source: Debuggee, method: string, params: any): Promise<void> {
    const tabId = source.tabId;
    if (!Number.isInteger(tabId)) return;
    if (method === "Page.javascriptDialogOpening") this.dialogs.set(tabId!, { type: params.type, message: params.message, defaultPrompt: params.defaultPrompt });
    if (method === "Page.javascriptDialogClosed") this.dialogs.delete(tabId!);
    if (method === "Page.frameNavigated" && !params?.frame?.parentId) {
      this.network.set(tabId!, []);
      this.consoleMessages.set(tabId!, []);
    }
    if (method === "Network.requestWillBeSent") {
      const records = this.network.get(tabId!) ?? [];
      const existing = records.find((record) => record.requestId === params.requestId);
      const record = existing ?? { requestId: params.requestId, method: params.request.method, url: params.request.url, requestHeaders: params.request.headers ?? {} };
      Object.assign(record, { method: params.request.method, url: params.request.url, requestHeaders: params.request.headers ?? {}, requestBody: params.request.postData, resourceType: params.type });
      if (!existing) records.push(record);
      this.network.set(tabId!, records);
    }
    if (method === "Network.responseReceived") {
      const record = this.network.get(tabId!)?.find((item) => item.requestId === params.requestId);
      if (record) Object.assign(record, { status: params.response.status, statusText: params.response.statusText, responseHeaders: params.response.headers ?? {}, resourceType: params.type ?? record.resourceType });
    }
    if (method === "Network.loadingFailed") {
      const record = this.network.get(tabId!)?.find((item) => item.requestId === params.requestId);
      if (record) record.failed = params.errorText;
    }
    if (method === "Runtime.consoleAPICalled") {
      const messages = this.consoleMessages.get(tabId!) ?? [];
      messages.push({ level: params.type === "warning" ? "warning" : params.type, text: (params.args ?? []).map((arg: any) => arg.value ?? arg.description ?? arg.type).join(" "), timestamp: params.timestamp });
      this.consoleMessages.set(tabId!, messages);
    }
    if (method === "Log.entryAdded") {
      const messages = this.consoleMessages.get(tabId!) ?? [];
      messages.push({ level: params.entry.level === "warning" ? "warning" : params.entry.level, text: params.entry.text, timestamp: params.entry.timestamp });
      this.consoleMessages.set(tabId!, messages);
    }
    if (method === "Fetch.requestPaused") await this.handlePausedRequest(tabId!, params);
    if (method === "Tracing.tracingComplete") this.traceWaiters.get(tabId!)?.(params.stream);
    if (method === "Page.screencastFrame") await this.handleVideoFrame(tabId!, params);
  }

  private async handlePausedRequest(tabId: number, event: any): Promise<void> {
    const rules = this.routes.get(tabId) ?? [];
    const rule = rules.find((candidate) => new RegExp(`^${globPattern(candidate.pattern)}$`).test(event.request.url));
    if (!rule) { await this.bridgeCommand({ tabId }, "Fetch.continueRequest", { requestId: event.requestId }); return; }
    if (rule.body !== undefined || rule.status !== undefined) {
      const headers = Object.entries({ ...(rule.contentType ? { "content-type": rule.contentType } : {}), ...(rule.headers ?? {}) }).map(([name, value]) => ({ name, value }));
      const body = new TextEncoder().encode(rule.body ?? "");
      let binary = ""; for (const byte of body) binary += String.fromCharCode(byte);
      await this.bridgeCommand({ tabId }, "Fetch.fulfillRequest", { requestId: event.requestId, responseCode: rule.status ?? 200, responseHeaders: headers, body: btoa(binary) });
      return;
    }
    const removed = new Set((rule.removeHeaders ?? []).map((name) => name.toLocaleLowerCase()));
    const headers = Object.entries({ ...event.request.headers, ...(rule.headers ?? {}) }).filter(([name]) => !removed.has(name.toLocaleLowerCase())).map(([name, value]) => ({ name, value: String(value) }));
    await this.bridgeCommand({ tabId }, "Fetch.continueRequest", { requestId: event.requestId, headers });
  }

  private async networkCommand(name: string, _session: CommandSession, tabId: number, input: Record<string, any>): Promise<unknown> {
    if (name === "requests") {
      const records = this.network.get(tabId) ?? [];
      if (input.clear) { this.network.set(tabId, []); return { cleared: true }; }
      const matcher = input.filter ? new RegExp(input.filter) : undefined;
      return records.flatMap((record, offset) => {
        const isStatic = ["Image", "Font", "Stylesheet", "Script", "Media"].includes(record.resourceType ?? "") && !record.failed && (record.status ?? 0) < 400;
        return (!input.static && isStatic) || matcher && !matcher.test(record.url) ? [] : [{ index: offset + 1, method: record.method, url: record.url, status: record.failed ? "FAILED" : record.status, statusText: record.failed ?? record.statusText }];
      });
    }
    if (name === "route-list") return this.routes.get(tabId) ?? [];
    if (name === "route") {
      const rules = this.routes.get(tabId) ?? [];
      rules.push({ pattern: input.pattern, status: input.status, body: input.body, contentType: input.contentType, headers: input.headers, removeHeaders: input.removeHeaders });
      this.routes.set(tabId, rules);
      await this.bridgeCommand({ tabId }, "Fetch.enable", { patterns: rules.map((rule) => ({ urlPattern: rule.pattern })) });
      return rules;
    }
    if (name === "unroute") {
      const rules = input.pattern ? (this.routes.get(tabId) ?? []).filter((rule) => rule.pattern !== input.pattern) : [];
      this.routes.set(tabId, rules);
      if (rules.length) await this.bridgeCommand({ tabId }, "Fetch.enable", { patterns: rules.map((rule) => ({ urlPattern: rule.pattern })) });
      else await this.bridgeCommand({ tabId }, "Fetch.disable", {});
      return rules;
    }
    if (name === "network-state-set") {
      const offline = input.state === "offline";
      await this.bridgeCommand({ tabId }, "Network.emulateNetworkConditions", { offline, latency: 0, downloadThroughput: offline ? 0 : -1, uploadThroughput: offline ? 0 : -1 });
      return { state: input.state };
    }
    const record = (this.network.get(tabId) ?? [])[Number(input.index) - 1];
    if (!record) throw new Error(`CommandError[invalid-request-index]: ${String(input.index)}`);
    let value: unknown;
    if (name === "request-headers") value = record.requestHeaders;
    else if (name === "request-body") value = record.requestBody ?? null;
    else if (name === "response-headers") value = record.responseHeaders ?? {};
    else {
      let body: unknown = null;
      try {
        const response = await this.bridgeCommand({ tabId }, "Network.getResponseBody", { requestId: record.requestId });
        body = response.base64Encoded ? { base64: response.body } : response.body;
      } catch (error) { body = { unavailable: error instanceof Error ? error.message : String(error) }; }
      value = name === "response-body" ? body : { ...record, responseBody: body };
    }
    if (input.filename) return { artifact: await this.downloadText(input.filename, typeof value === "string" ? value : JSON.stringify(value, null, 2), "application/json") };
    return value;
  }

  private consoleCommand(tabId: number, input: Record<string, any>): unknown {
    const messages = this.consoleMessages.get(tabId) ?? [];
    if (input.clear) { this.consoleMessages.set(tabId, []); return { cleared: true }; }
    const rank: Record<string, number> = { debug: 0, info: 1, log: 1, warning: 2, error: 3, assert: 3 };
    const minimum = rank[input.minLevel ?? "info"] ?? 1;
    return messages.filter((message) => (rank[message.level] ?? 1) >= minimum);
  }

  private async runPageCode(tabId: number, code: string): Promise<unknown> {
    if (!/^\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.test(code) && !/^\s*(?:async\s+)?function\b/.test(code)) {
      throw new Error("CommandError[invalid-code]: run-code requires one function expression receiving page");
    }
    return this.executeNow({ code: `const page = await browser.page(${tabId});
return await (async (page, chrome, browser, globalThis, self, window, document, location, __surfWaxBrowser, __surfWaxDebugger, __surfWaxResult, __surfWaxResults) => (${code})(page))(page);`, target: { kind: "extension" } }, this.activeSignal, this.activeContext);
  }

  private async recordingCommand(name: string, page: any): Promise<unknown> {
    if (name === "recording-start") {
      await page.evaluate(`() => {
        globalThis.__surfWaxRecordedActions = [];
        globalThis.__surfWaxRecorderAbort?.abort();
        const controller = new AbortController(); globalThis.__surfWaxRecorderAbort = controller;
        const locator = el => el.getAttribute("data-testid") ? "getByTestId(" + JSON.stringify(el.getAttribute("data-testid")) + ")"
          : el.getAttribute("aria-label") ? "getByLabel(" + JSON.stringify(el.getAttribute("aria-label")) + ")"
          : el.id ? "locator(" + JSON.stringify("#" + CSS.escape(el.id)) + ")"
          : "getByText(" + JSON.stringify((el.innerText || el.textContent || el.tagName).trim().slice(0, 80)) + ")";
        addEventListener("click", event => globalThis.__surfWaxRecordedActions.push({type:"click", locator:locator(event.target)}), {capture:true, signal:controller.signal});
        addEventListener("change", event => { if ("value" in event.target) globalThis.__surfWaxRecordedActions.push({type:"fill", locator:locator(event.target), value:event.target.value}); }, {capture:true, signal:controller.signal});
        addEventListener("keydown", event => { if (["Enter","Escape","Tab"].includes(event.key)) globalThis.__surfWaxRecordedActions.push({type:"press", locator:locator(event.target), key:event.key}); }, {capture:true, signal:controller.signal});
        return true;
      }`);
      return { recording: true };
    }
    const actions = await page.evaluate(`() => { globalThis.__surfWaxRecorderAbort?.abort(); const actions = globalThis.__surfWaxRecordedActions || []; delete globalThis.__surfWaxRecorderAbort; delete globalThis.__surfWaxRecordedActions; return actions; }`) as any[];
    const code = actions.map((action) => action.type === "fill" ? `await page.${action.locator}.fill(${JSON.stringify(action.value)});`
      : action.type === "press" ? `await page.${action.locator}.press(${JSON.stringify(action.key)});`
      : `await page.${action.locator}.click();`).join("\n");
    return { recording: false, actions, code };
  }

  private async tracingCommand(name: string, tabId: number, requested?: string): Promise<unknown> {
    if (name === "tracing-start") {
      if (this.tracingTabs.has(tabId)) throw new Error("CommandError[trace-active]: A trace is already recording");
      await this.bridgeCommand({ tabId }, "Tracing.start", { transferMode: "ReturnAsStream", categories: "-* ,devtools.timeline,blink.user_timing,loading,disabled-by-default-devtools.screenshot".replace("-* ,", "-*,") });
      this.tracingTabs.add(tabId);
      return { tracing: true };
    }
    if (!this.tracingTabs.has(tabId)) throw new Error("CommandError[trace-inactive]: No trace is recording");
    const stream = new Promise<string | undefined>((resolve) => this.traceWaiters.set(tabId, resolve));
    await this.bridgeCommand({ tabId }, "Tracing.end", {});
    const handle = await this.awaitAbort(stream, this.activeSignal);
    this.traceWaiters.delete(tabId); this.tracingTabs.delete(tabId);
    if (!handle) throw new Error("CommandError[trace-failed]: Chrome returned no trace stream");
    let trace = "";
    while (true) {
      const chunk = await this.bridgeCommand({ tabId }, "IO.read", { handle });
      trace += chunk.data ?? "";
      if (chunk.eof) break;
    }
    await this.bridgeCommand({ tabId }, "IO.close", { handle }).catch(() => undefined);
    const filename = requested ?? timestamped("trace", "json");
    const networkName = filename.replace(/\.[^.]+$/, "") + ".network.json";
    return {
      trace: await this.downloadText(filename, trace, "application/json"),
      network: await this.downloadText(networkName, JSON.stringify(this.network.get(tabId) ?? [], null, 2), "application/json"),
    };
  }

  private async videoCommand(name: string, tabId: number, input: Record<string, any>): Promise<unknown> {
    if (name === "video-start") return this.startVideo(tabId, input);
    const state = this.videoStates.get(tabId);
    if (!state) throw new Error("CommandError[video-inactive]: No video is recording");
    if (name === "video-show-actions") {
      state.actions = { durationMs: input.durationMs ?? 500, position: input.position ?? "top-right", cursor: input.cursor ?? "pointer" };
      return { actions: true, ...state.actions };
    }
    if (name === "video-hide-actions") { state.actions = undefined; return { actions: false }; }
    if (name === "video-chapter") {
      const duration = input.durationMs ?? 2_000;
      state.overlay = { title: input.title, description: input.description, until: performance.now() + duration };
      await new Promise((resolve) => setTimeout(resolve, duration));
      state.overlay = undefined;
      return { chapter: input.title, durationMs: duration };
    }
    await this.bridgeCommand({ tabId }, "Page.stopScreencast", {}).catch(() => undefined);
    state.stop();
    const blob = await state.stopped;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte);
    this.videoStates.delete(tabId);
    return { artifact: await this.downloadBase64(state.filename, btoa(binary), "video/webm") };
  }

  private async startVideo(tabId: number, input: Record<string, any>): Promise<unknown> {
    if (this.videoStates.has(tabId)) throw new Error("CommandError[video-active]: A video is already recording");
    if (typeof document === "undefined" || typeof MediaRecorder === "undefined") throw new Error("CommandError[video-unavailable]: MediaRecorder is unavailable in this extension context");
    const canvas = document.createElement("canvas");
    canvas.width = input.width ?? 800; canvas.height = input.height ?? 600;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("CommandError[video-unavailable]: Canvas 2D is unavailable");
    const recorder = new MediaRecorder(canvas.captureStream(12), { mimeType: "video/webm" });
    const chunks: Blob[] = [];
    let finish!: (blob: Blob) => void;
    const stopped = new Promise<Blob>((resolve) => { finish = resolve; });
    recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
    recorder.onstop = () => finish(new Blob(chunks, { type: "video/webm" }));
    recorder.start(1_000);
    this.videoStates.set(tabId, { filename: input.filename ?? timestamped("video", "webm"), canvas, context, recorder, chunks, stopped, stop: () => recorder.stop() });
    await this.bridgeCommand({ tabId }, "Page.startScreencast", { format: "jpeg", quality: 75, maxWidth: canvas.width, maxHeight: canvas.height, everyNthFrame: 1 });
    return { recording: true, filename: this.videoStates.get(tabId)!.filename, width: canvas.width, height: canvas.height };
  }

  private async handleVideoFrame(tabId: number, event: any): Promise<void> {
    const state = this.videoStates.get(tabId);
    try {
      if (!state) return;
      const image = await new Promise<HTMLImageElement>((resolve, reject) => { const item = new Image(); item.onload = () => resolve(item); item.onerror = reject; item.src = `data:image/jpeg;base64,${event.data}`; });
      state.context.drawImage(image, 0, 0, state.canvas.width, state.canvas.height);
      if (state.overlay && state.overlay.until > performance.now()) {
        state.context.fillStyle = "rgba(0,0,0,.72)"; state.context.fillRect(0, 0, state.canvas.width, state.canvas.height);
        state.context.fillStyle = "white"; state.context.textAlign = "center"; state.context.font = "bold 32px sans-serif"; state.context.fillText(state.overlay.title, state.canvas.width / 2, state.canvas.height / 2);
        if (state.overlay.description) { state.context.font = "18px sans-serif"; state.context.fillText(state.overlay.description, state.canvas.width / 2, state.canvas.height / 2 + 36); }
      }
    } finally {
      await this.bridgeCommand({ tabId }, "Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => undefined);
    }
  }

  private async annotateVideo(tabId: number, name: string, input: Record<string, any>): Promise<void> {
    const state = this.videoStates.get(tabId);
    if (!state?.actions || name.startsWith("video-")) return;
    state.overlay = { title: `${name}${input.target ? ` ${typeof input.target === "string" ? input.target : JSON.stringify(input.target)}` : ""}`, until: performance.now() + state.actions.durationMs };
  }

  private async generateLocator(page: any, raw: unknown): Promise<unknown> {
    if (typeof raw === "string" && /^(?:getBy|locator\()/.test(raw)) return raw;
    const target = parseCommandTarget(raw);
    if ("ref" in target) {
      const snapshot = await page.snapshot();
      const line = String(snapshot.snapshot).split("\n").find((item) => item.includes(`[ref=${target.ref}]`));
      const match = line && /^\s*-\s+(\S+)(?:\s+"([^"]*)")?/.exec(line);
      return match ? `getByRole(${JSON.stringify(match[1])}, { name: ${JSON.stringify(match[2] ?? "")} })` : `ref(${JSON.stringify(target.ref)})`;
    }
    if ("point" in target) return `point(${target.point.x}, ${target.point.y})`;
    const method = { role: "getByRole", text: "getByText", label: "getByLabel", placeholder: "getByPlaceholder", alt: "getByAltText", title: "getByTitle", testId: "getByTestId", css: "locator" }[target.by];
    return target.by === "role" ? `${method}(${JSON.stringify(target.value)}${target.name ? `, { name: ${JSON.stringify(target.name)} }` : ""})` : `${method}(${JSON.stringify(target.value)})`;
  }

  private async highlight(page: any, input: Record<string, any>): Promise<unknown> {
    if (input.hide && !input.target) return page.evaluate("() => { for (const el of document.querySelectorAll('[data-surf-wax-highlight]')) { el.style.outline = el.dataset.surfWaxOutline || ''; delete el.dataset.surfWaxHighlight; delete el.dataset.surfWaxOutline; } return true; }");
    const locator = this.locatorFor(page, input.target);
    return locator.evaluate(`function(el, options){
      if (options.hide) { el.style.outline = el.dataset.surfWaxOutline || ""; delete el.dataset.surfWaxHighlight; delete el.dataset.surfWaxOutline; return true; }
      if (!el.dataset.surfWaxHighlight) el.dataset.surfWaxOutline = el.style.outline || "";
      el.dataset.surfWaxHighlight = "true"; el.style.outline = options.style || "3px solid #ff3b30"; return true;
    }`, { hide: input.hide, style: input.style });
  }

  private async detachTabRuntime(tabId: number): Promise<void> {
    await this.bridgeCommand({ tabId }, "Fetch.disable", {}).catch(() => undefined);
    await this.bridgeCommand({ tabId }, "Page.stopScreencast", {}).catch(() => undefined);
    const video = this.videoStates.get(tabId);
    if (video && video.recorder.state !== "inactive") video.stop();
    this.videoStates.delete(tabId); this.routes.delete(tabId); this.network.delete(tabId); this.consoleMessages.delete(tabId); this.dialogs.delete(tabId); this.networkEnabled.delete(tabId); this.tracingTabs.delete(tabId); this.traceWaiters.delete(tabId);
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
    if (input.mode === "result") {
      if (!this.logger) throw new Error("Tool result log is unavailable");
      return this.logger.result(input.id, { path: input.path, offset: input.offset, limit: input.limit });
    }
    const timeoutMs = input.timeoutMs ?? (input.mode === "act" ? 10_000 : undefined);
    const timeout = timeoutMs ? new AbortController() : undefined;
    const timer = timeout ? setTimeout(() => timeout.abort(new DOMException(`Operation timed out after ${timeoutMs}ms`, "TimeoutError")), timeoutMs) : undefined;
    const combined = timeout ? signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal : signal;
    try {
      if (this.disposed) throw new Error("Chrome executor has been disposed");
      throwIfAborted(combined);
      await this.initialize();
      this.automation.setContext({ ...context, signal: combined });
      this.activeSignal = combined;
      this.activeContext = context;
      if (input.mode === "run") return await this.executeNow({ code: input.code, target: input.target ?? { kind: "extension" }, timeoutMs }, combined, context);
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
      const failure = timeout?.signal.aborted && !signal?.aborted ? new Error(`AutomationError[timeout]: ${JSON.stringify({ timeoutMs })}`) : error;
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
    this.lifetime.aborted = true;
    for (const [tabId, video] of this.videoStates) {
      if (video.recorder.state !== "inactive") video.stop();
      void this.bridgeCommand({ tabId }, "Page.stopScreencast", {}).catch(() => undefined);
    }
    this.videoStates.clear();
    this.routes.clear();
    this.network.clear();
    this.consoleMessages.clear();
    this.dialogs.clear();
    this.traceWaiters.clear();
    this.tracingTabs.clear();
    this.commandSessions.clear();
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
      if (target.tabId !== undefined && target.frameId === undefined && target.documentId === undefined && !target.targetId && !target.sessionId
        && (target.world === undefined || target.world === "MAIN") && this.automation.hasSession(target.tabId)) {
        const value = await this.awaitAbort(this.automation.pageValue(target.tabId, pageExpressionFor(input.code)), signal);
        return evaluationValue({ result: { value } }, "page");
      }
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
