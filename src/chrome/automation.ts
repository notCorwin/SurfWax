import type { EventLogger } from "../logging";

type Debuggee = chrome.debugger.Debuggee & { sessionId?: string };
type Command = (debuggee: Debuggee, method: string, params?: object) => Promise<any>;
type RunContext = { signal?: AbortSignal; conversationId?: string; toolCallId?: string };
type Waiter = { resolve: (value: any) => void; reject: (error: Error) => void };
type Query = {
  kind: "role" | "text" | "label" | "placeholder" | "alt" | "title" | "testId" | "css" | "frame";
  value: string;
  name?: string;
  exact?: boolean;
};
type LocatorSpec = { queries: Query[]; index?: number; ref?: string; hasText?: string; has?: LocatorSpec };
type WaitState = "attached" | "detached" | "visible" | "hidden" | "enabled" | "editable" | "checked";
type RefRecord = { backendNodeId: number; frameId?: string; debuggee: Debuggee; role: string; name: string; generation: number };
type SnapshotLine = { id: string; line: string };
type ObservationRecord = {
  observationId: string;
  tabId: number;
  documentId: number;
  url: string;
  title: string;
  lines: SnapshotLine[];
  viewport: { x: number; y: number; width: number; height: number; scale: number };
  image?: { width: number; height: number; scale: number };
};
type Session = {
  tabId: number;
  debuggee: Debuggee;
  ready?: Promise<void>;
  generation: number;
  nextRef: number;
  refs: Map<string, RefRecord>;
  refsByNode: Map<string, string>;
  frames: Map<string, Debuggee>;
  frameReady: Map<string, Promise<void>>;
  frameParents: Map<string, string | undefined>;
  lifecycle: Set<string>;
  rootFrameId?: string;
  lastSnapshot?: SnapshotLine[];
};

type Candidate = { role: string; name: string; tag?: string; text?: string; ref?: string; backendNodeId?: number; debuggee?: Debuggee };
type ElementState = {
  x: number;
  y: number;
  visible: boolean;
  stable: boolean;
  enabled: boolean;
  editable: boolean;
  receivesEvents: boolean;
  checked: boolean;
  connected: boolean;
};

class AutomationError extends Error {
  constructor(readonly code: string, readonly detail: Record<string, unknown>) {
    super(`AutomationError[${code}]: ${JSON.stringify(detail)}`);
    this.name = "AutomationError";
  }
}

function automationError(code: string, detail: Record<string, unknown>): AutomationError {
  return new AutomationError(code, detail);
}

const INTERACTIVE_ROLES = new Set([
  "button", "checkbox", "combobox", "gridcell", "link", "listbox", "menuitem", "menuitemcheckbox",
  "menuitemradio", "option", "radio", "searchbox", "slider", "spinbutton", "switch", "tab", "textbox", "treeitem",
]);

const RESOLVER_SOURCE = String.raw`function(spec, metadata) {
  const normalize = value => String(value ?? "").replace(/\s+/g, " ").trim();
  const roleOf = el => el.getAttribute("role") || ({
    A: el.hasAttribute("href") ? "link" : "generic", BUTTON: "button", SELECT: "combobox", TEXTAREA: "textbox",
    OPTION: "option", IMG: "img", SUMMARY: "button", FORM: "form", TABLE: "table", TR: "row", TD: "cell", TH: "columnheader",
    H1: "heading", H2: "heading", H3: "heading", H4: "heading", H5: "heading", H6: "heading", NAV: "navigation", MAIN: "main",
    ARTICLE: "article", ASIDE: "complementary", FOOTER: "contentinfo", HEADER: "banner", UL: "list", OL: "list", LI: "listitem", DIALOG: "dialog", PROGRESS: "progressbar",
  }[el.tagName] || (el.tagName === "INPUT" ? ({ checkbox: "checkbox", radio: "radio", range: "slider", number: "spinbutton", search: "searchbox", button: "button", submit: "button", reset: "button" }[el.type] || "textbox") : "generic"));
  const nameOf = el => normalize(el.getAttribute("aria-label") || (() => {
    const ids = el.getAttribute("aria-labelledby");
    return ids && ids.split(/\s+/).map(id => document.getElementById(id)?.textContent || "").join(" ");
  })() || (el.labels ? [...el.labels].map(label => label.textContent).join(" ") : "") || el.getAttribute("alt") || el.getAttribute("title") || el.textContent || el.value);
  const roots = root => {
    const out = [root];
    for (const el of root.querySelectorAll?.("*") || []) if (el.shadowRoot) out.push(...roots(el.shadowRoot));
    return out;
  };
  const all = root => roots(root).flatMap(item => [...(item.querySelectorAll?.("*") || [])]);
  const visibleText = el => normalize(el.innerText === undefined ? el.textContent : el.innerText);
  const matches = (el, query) => {
    const equal = (actual, expected) => query.exact ? normalize(actual) === normalize(expected) : normalize(actual).toLowerCase().includes(normalize(expected).toLowerCase());
    if (query.kind === "role") return roleOf(el) === query.value && (!query.name || equal(nameOf(el), query.name));
    if (query.kind === "text") return equal(visibleText(el), query.value) && ![...el.children].some(child => equal(visibleText(child), query.value));
    if (query.kind === "label") {
      const labelledBy = el.getAttribute("aria-labelledby");
      const label = el.getAttribute("aria-label") || (labelledBy ? labelledBy.split(/\s+/).map(id => document.getElementById(id)?.textContent || "").join(" ") : "") || (el.labels ? [...el.labels].map(item => item.textContent).join(" ") : "");
      return Boolean(label) && equal(label, query.value);
    }
    if (query.kind === "placeholder") return equal(el.getAttribute("placeholder"), query.value);
    if (query.kind === "alt") return equal(el.getAttribute("alt"), query.value);
    if (query.kind === "title") return equal(el.getAttribute("title"), query.value);
    if (query.kind === "testId") return el.getAttribute("data-testid") === query.value;
    return false;
  };
  const query = (root, item) => item.kind === "css" || item.kind === "frame"
    ? roots(root).flatMap(part => [...part.querySelectorAll(item.value)])
    : all(root).filter(el => matches(el, item));
  const resolve = (root, locator) => {
    let current = [root];
    for (const item of locator.queries) {
      const found = current.flatMap(node => query(node, item));
      if (item.kind === "frame") {
        current = found.map(frame => { try { return frame.contentDocument; } catch { return null; } }).filter(Boolean);
      } else current = found;
    }
    if (locator.hasText) current = current.filter(el => visibleText(el).toLowerCase().includes(normalize(locator.hasText).toLowerCase()));
    if (locator.has) current = current.filter(el => resolve(el, locator.has).length > 0);
    if (locator.index !== undefined) current = current.at(locator.index < 0 ? current.length + locator.index : locator.index) ? [current.at(locator.index < 0 ? current.length + locator.index : locator.index)] : [];
    return [...new Set(current)];
  };
  const result = resolve(document, spec);
  if (!metadata) return result[0] || null;
  return result.map(el => ({ role: roleOf(el), name: nameOf(el), tag: el.tagName.toLowerCase(), text: visibleText(el).slice(0, 120) }));
}`;

function abortError(): DOMException {
  return new DOMException("Operation aborted", "AbortError");
}

function signalError(signal: AbortSignal): unknown {
  const reason = signal.reason;
  return reason && typeof reason === "object" && typeof reason.name === "string" ? reason : abortError();
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signalError(signal);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    const abort = () => { clearTimeout(timer); reject(signalError(signal)); };
    signal.addEventListener("abort", abort, { once: true });
  });
}

function axValue(value: any): string {
  return typeof value?.value === "string" || typeof value?.value === "number" || typeof value?.value === "boolean" ? String(value.value) : "";
}

function quote(value: string): string {
  return JSON.stringify(value.replace(/\s+/g, " ").trim());
}

function jpegSize(base64: string): { width: number; height: number } | undefined {
  const binary = atob(base64);
  for (let offset = 2; offset + 8 < binary.length;) {
    if (binary.charCodeAt(offset) !== 0xff) { offset += 1; continue; }
    const marker = binary.charCodeAt(offset + 1);
    const length = binary.charCodeAt(offset + 2) * 256 + binary.charCodeAt(offset + 3);
    if (marker >= 0xc0 && marker <= 0xc3) return {
      height: binary.charCodeAt(offset + 5) * 256 + binary.charCodeAt(offset + 6),
      width: binary.charCodeAt(offset + 7) * 256 + binary.charCodeAt(offset + 8),
    };
    offset += Math.max(2, length + 2);
  }
}

export class AutomationRuntime {
  private readonly sessions = new Map<number, Session>();
  private readonly objectDebuggees = new Map<string, Debuggee>();
  private context: RunContext = {};
  private readonly waiters = new Map<number, Map<string, Set<Waiter>>>();
  private lastWait?: { locator: LocatorSpec; state?: ElementState; matches?: number; candidates?: Candidate[]; documentId: number; reason: string; attempt: number };
  private lastAttemptLog?: { reason: string; at: number };
  private readonly observations = new Map<string, ObservationRecord>();
  private readonly axRoots = new Map<string, number>();

  private waitDiagnostic() { return this.lastWait; }

  private recordAttempt(session: Session, locator: LocatorSpec, attempt: number, reason: string, candidates: Candidate[], state?: ElementState): void {
    const summary = candidates.slice(0, 5).map(({ role, name, tag, text, ref }) => ({ role, name, tag, text, ref }));
    this.lastWait = { locator, matches: candidates.length, candidates: summary, state, documentId: session.generation, reason, attempt };
    const now = performance.now();
    if (attempt !== 1 && this.lastAttemptLog?.reason === reason && now - this.lastAttemptLog.at < 1_000) return;
    this.lastAttemptLog = { reason, at: now };
    this.options.logger?.record({
      type: "automation.action.attempt",
      conversationId: this.context.conversationId,
      toolCallId: this.context.toolCallId,
      content: { attempt, reason, candidateCount: candidates.length, candidates: summary, documentId: session.generation, locator },
    });
  }

  constructor(private readonly options: {
    chromeApi: typeof chrome;
    command: Command;
    detach: (debuggee: Debuggee) => Promise<void>;
    mark: (tabId: number) => Promise<void>;
    logger?: EventLogger;
  }) {}

  setContext(context: RunContext): void { this.context = context; }
  hasSession(tabId: number): boolean { return this.sessions.has(tabId); }
  async clearContext(): Promise<void> {
    this.context = {};
    const debuggees = new Map<string, Debuggee>();
    for (const session of this.sessions.values()) {
      debuggees.set(JSON.stringify(session.debuggee), session.debuggee);
      for (const debuggee of session.frames.values()) debuggees.set(JSON.stringify(debuggee), debuggee);
    }
    await Promise.all([...debuggees.values()].map((debuggee) => this.options.command(debuggee, "Runtime.releaseObjectGroup", { objectGroup: "surf-wax-automation" }).catch(() => undefined)));
    this.objectDebuggees.clear();
  }

  async createPage(tabId?: number): Promise<PageFacade> {
    const resolved = tabId ?? (await this.options.chromeApi.tabs.query({ active: true, currentWindow: true }))[0]?.id;
    if (!Number.isInteger(resolved)) throw new Error("browser.page() could not find an active tab; pass tabId explicitly.");
    await this.session(resolved!);
    return new PageFacade(this, resolved!);
  }

  handleEvent(source: Debuggee, method: string, params: any): void {
    const tabId = source.tabId;
    if (!Number.isInteger(tabId)) return;
    const session = this.sessions.get(tabId!);
    if (method === "Target.attachedToTarget" && params?.targetInfo?.type === "iframe" && session) {
      const debuggee = { tabId, sessionId: params.sessionId } as Debuggee;
      session.frames.set(params.targetInfo.targetId, debuggee);
      const ready = (async () => {
        for (const domain of ["Page", "Runtime", "DOM", "Accessibility"]) await this.options.command(debuggee, `${domain}.enable`, {});
        await this.options.command(debuggee, "Page.setLifecycleEventsEnabled", { enabled: true });
      })();
      void ready.catch(() => undefined);
      session.frameReady.set(params.sessionId, ready);
    }
    if (method === "Page.frameAttached" && params?.frameId && session) {
      session.frames.set(params.frameId, source);
      session.frameParents.set(params.frameId, params.parentFrameId);
    }
    if (method === "Page.frameNavigated" && params?.frame?.id && session) {
      session.frames.set(params.frame.id, source);
      session.frameParents.set(params.frame.id, params.frame.parentId);
      if (!params.frame.parentId) session.rootFrameId = params.frame.id;
      this.invalidate(session);
    }
    if ((method === "Page.navigatedWithinDocument" || method === "DOM.documentUpdated" || method === "Runtime.executionContextsCleared") && session) {
      this.invalidate(session);
    }
    if (method === "Page.frameDetached" && params?.frameId && session) {
      session.frames.delete(params.frameId);
      session.frameParents.delete(params.frameId);
      this.invalidate(session);
    }
    if (method === "Target.detachedFromTarget" && params?.sessionId && session) {
      session.frameReady.delete(params.sessionId);
      for (const [frameId, debuggee] of session.frames) {
        if (debuggee.sessionId === params.sessionId) {
          session.frames.delete(frameId);
          session.frameParents.delete(frameId);
        }
      }
      this.invalidate(session);
    }
    if (session && method === "Page.lifecycleEvent" && params?.name) session.lifecycle.add(params.name);
    if (session && method === "Page.domContentEventFired") session.lifecycle.add("DOMContentLoaded");
    if (session && method === "Page.loadEventFired") session.lifecycle.add("load");
    if (session && method === "Page.frameStartedLoading" && params?.frameId === session.rootFrameId) {
      session.lifecycle.clear();
    }
    const kind = method === "Page.javascriptDialogOpening" ? "dialog" : method === "Page.downloadWillBegin" ? "download" : undefined;
    if (kind) this.resolveWaiters(tabId!, kind, params);
  }

  private invalidate(session: Session): void {
    session.generation += 1;
    session.refs.clear();
    session.refsByNode.clear();
    session.lastSnapshot = undefined;
    this.objectDebuggees.clear();
    this.axRoots.clear();
  }

  handleDetach(source: Debuggee): void {
    if (Number.isInteger(source.tabId)) this.sessions.delete(source.tabId!);
  }

  async abortSessions(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    this.objectDebuggees.clear();
    this.observations.clear();
    this.axRoots.clear();
    for (const events of this.waiters.values()) for (const waiters of events.values()) for (const waiter of waiters) waiter.reject(abortError());
    this.waiters.clear();
    await Promise.all(sessions.map(async (session) => {
      await this.options.command(session.debuggee, "Input.cancelDragging", {}).catch(() => undefined);
      await this.options.detach(session.debuggee).catch(() => undefined);
    }));
  }

  dispose(): void { void this.abortSessions(); }

  locator(tabId: number, query: Query): LocatorFacade { return new LocatorFacade(this, tabId, { queries: [query] }); }
  ref(tabId: number, ref: string): LocatorFacade { return new LocatorFacade(this, tabId, { queries: [], ref }); }

  async snapshot(tabId: number): Promise<{ url: string; title: string; snapshot: string }> {
    return this.action(tabId, "snapshot", null, async () => {
      const session = await this.session(tabId);
      const captured = await this.captureSnapshot(session);
      session.lastSnapshot = captured.lines;
      return { url: captured.url, title: captured.title, documentId: session.generation, snapshot: captured.lines.map(({ line }) => line).join("\n") };
    });
  }

  async observe(tabId: number, detail: "auto" | "semantic" | "visual" = "auto", since?: string): Promise<Record<string, unknown>> {
    return this.action(tabId, "observe", null, async () => {
      const session = await this.session(tabId);
      const captured = await this.captureSnapshot(session);
      const viewport = await this.pageValue(tabId, "({x:scrollX,y:scrollY,width:innerWidth,height:innerHeight,scale:devicePixelRatio})") as ObservationRecord["viewport"];
      const observationId = globalThis.crypto.randomUUID();
      const previous = since ? this.observations.get(since) : undefined;
      if (since && (!previous || previous.tabId !== tabId || previous.documentId !== session.generation)) {
        throw automationError("stale-observation", { observationId: since, reason: "expired-document" });
      }
      const record: ObservationRecord = { observationId, tabId, documentId: session.generation, ...captured, viewport };
      session.lastSnapshot = captured.lines;
      const before = new Map(previous?.lines.map((item) => [item.id, item.line]));
      const after = new Map(captured.lines.map((item) => [item.id, item.line]));
      const changes = previous ? {
        added: captured.lines.filter(({ id }) => !before.has(id)).map(({ line }) => line),
        removed: previous.lines.filter(({ id }) => !after.has(id)).map(({ line }) => line),
        updated: captured.lines.flatMap(({ id, line }) => before.has(id) && before.get(id) !== line ? [{ before: before.get(id), after: line }] : []),
      } : undefined;
      const result: Record<string, unknown> = {
        observationId, documentId: session.generation, url: captured.url, title: captured.title, viewport,
        snapshot: captured.lines.map(({ line }) => line).join("\n"), ...(changes ? { changes } : {}),
      };
      if (detail === "visual" || detail === "auto" && !captured.lines.some(({ line }) => line.includes("[ref="))) {
        const screenshot = await this.options.command(session.debuggee, "Page.captureScreenshot", {
          format: "jpeg", quality: 70, fromSurface: true, captureBeyondViewport: false,
        });
        const size = typeof screenshot.data === "string" ? jpegSize(screenshot.data) : undefined;
        const image = { width: size?.width ?? viewport.width, height: size?.height ?? viewport.height, scale: size?.width && viewport.width ? size.width / viewport.width : 1 };
        record.image = image;
        result.screenshot = { mediaType: "image/jpeg", data: screenshot.data, ...image };
      }
      this.observations.set(observationId, record);
      while (this.observations.size > 32) this.observations.delete(this.observations.keys().next().value!);
      return result;
    });
  }

  async point(tabId: number, observationId: string, x: number, y: number, operation: "click" | "dblclick" | "hover"): Promise<Record<string, unknown>> {
    const session = await this.session(tabId);
    return this.action(tabId, operation, null, async () => {
      const observation = this.observations.get(observationId);
      if (!observation || observation.tabId !== tabId || observation.documentId !== session.generation) {
        throw automationError("stale-observation", { observationId, reason: "expired-document" });
      }
      const viewport = await this.pageValue(tabId, "({x:scrollX,y:scrollY,width:innerWidth,height:innerHeight,scale:devicePixelRatio})") as ObservationRecord["viewport"];
      if (viewport.x !== observation.viewport.x || viewport.y !== observation.viewport.y || viewport.width !== observation.viewport.width || viewport.height !== observation.viewport.height || viewport.scale !== observation.viewport.scale) {
        throw automationError("stale-observation", { observationId, reason: "viewport-changed", before: observation.viewport, after: viewport });
      }
      const scale = observation.image?.scale ?? 1;
      const cssX = x / scale; const cssY = y / scale;
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > (observation.image?.width ?? viewport.width) || y > (observation.image?.height ?? viewport.height)) {
        throw automationError("invalid-point", { observationId, x, y, viewport });
      }
      await this.options.command(session.debuggee, "Input.dispatchMouseEvent", { type: "mouseMoved", x: cssX, y: cssY });
      if (operation !== "hover") {
        const count = operation === "dblclick" ? 2 : 1;
        for (let clickCount = 1; clickCount <= count; clickCount += 1) {
          await this.options.command(session.debuggee, "Input.dispatchMouseEvent", { type: "mousePressed", x: cssX, y: cssY, button: "left", clickCount });
          await this.options.command(session.debuggee, "Input.dispatchMouseEvent", { type: "mouseReleased", x: cssX, y: cssY, button: "left", clickCount });
        }
      }
      return this.afterAction(session);
    });
  }

  async ensureObservation(tabId: number, observationId: string): Promise<void> {
    const session = await this.session(tabId);
    const observation = this.observations.get(observationId);
    if (!observation || observation.tabId !== tabId || observation.documentId !== session.generation) {
      throw automationError("stale-observation", { observationId, reason: "expired-document" });
    }
  }

  async keyboard(tabId: number, operation: "press" | "insertText", value: string): Promise<Record<string, unknown>> {
    const session = await this.session(tabId);
    return this.action(tabId, operation, null, async () => {
      if (operation === "press") await this.press(session, value);
      else await this.options.command(session.debuggee, "Input.insertText", { text: value });
      return this.afterAction(session);
    });
  }

  async navigate(tabId: number, method: string, params?: object): Promise<unknown> {
    const session = await this.session(tabId);
    return this.action(tabId, method, null, async () => {
      const result = await this.options.command(session.debuggee, method, params);
      if (result?.errorText) throw automationError("navigation-interrupted", { method, errorText: result.errorText, url: (params as { url?: string } | undefined)?.url });
      await this.waitForReady(session);
      return { result, ...(await this.afterAction(session)) };
    });
  }

  async history(tabId: number, delta: -1 | 1): Promise<unknown> {
    const session = await this.session(tabId);
    return this.action(tabId, delta < 0 ? "goBack" : "goForward", null, async () => {
      const history = await this.options.command(session.debuggee, "Page.getNavigationHistory", {});
      const entry = history.entries?.[history.currentIndex + delta];
      if (!entry) return null;
      await this.options.command(session.debuggee, "Page.navigateToHistoryEntry", { entryId: entry.id });
      await this.waitForReady(session);
      return this.afterAction(session);
    });
  }

  async pageValue(tabId: number, expression: string): Promise<unknown> {
    const session = await this.session(tabId);
    const response = await this.options.command(session.debuggee, "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    return response.result?.value;
  }

  async waitUntil(test: () => Promise<boolean>): Promise<void> {
    while (!await test()) await delay(50, this.context.signal);
  }

  async waitForLoadState(tabId: number, state: "domcontentloaded" | "load" = "load"): Promise<void> {
    const session = await this.session(tabId);
    const lifecycle = state === "domcontentloaded" ? "DOMContentLoaded" : "load";
    await this.waitUntil(async () => {
      if (session.lifecycle.has(lifecycle)) return true;
      const ready = await this.pageValue(tabId, "document.readyState").catch(() => undefined);
      return state === "domcontentloaded" ? ready === "interactive" || ready === "complete" : ready === "complete";
    });
  }

  waitForEvent(tabId: number, kind: "dialog" | "popup" | "download"): Promise<any> {
    throwIfAborted(this.context.signal);
    if (kind === "popup") return new Promise((resolve, reject) => {
      const signal = this.context.signal;
      const event = this.options.chromeApi.tabs.onCreated;
      const cleanup = () => { signal?.removeEventListener("abort", abort); event.removeListener(created as never); };
      const abort = () => { cleanup(); reject(abortError()); };
      const created = (item: chrome.tabs.Tab) => {
        if (item.openerTabId !== tabId) return;
        cleanup();
        resolve(new PageFacade(this, item.id!));
      };
      signal?.addEventListener("abort", abort, { once: true });
      event.addListener(created as never);
    });
    return new Promise((resolve, reject) => {
      const events = this.waiters.get(tabId) ?? new Map();
      const waiters = events.get(kind) ?? new Set<Waiter>();
      const done = (value: any) => { cleanup(); resolve(kind === "dialog" ? this.dialog(tabId, value) : value); };
      const abort = () => { cleanup(); reject(abortError()); };
      const waiter = { resolve: done, reject };
      const cleanup = () => { waiters.delete(waiter); this.context.signal?.removeEventListener("abort", abort); };
      waiters.add(waiter); events.set(kind, waiters); this.waiters.set(tabId, events);
      this.context.signal?.addEventListener("abort", abort, { once: true });
    });
  }

  private dialog(tabId: number, event: any) {
    return {
      type: () => event.type,
      message: () => event.message,
      defaultValue: () => event.defaultPrompt,
      accept: (promptText?: string) => this.session(tabId).then((s) => this.options.command(s.debuggee, "Page.handleJavaScriptDialog", { accept: true, ...(promptText === undefined ? {} : { promptText }) })),
      dismiss: () => this.session(tabId).then((s) => this.options.command(s.debuggee, "Page.handleJavaScriptDialog", { accept: false })),
    };
  }

  private resolveWaiters(tabId: number, kind: string, value: unknown): void {
    const waiters = this.waiters.get(tabId)?.get(kind);
    if (!waiters) return;
    for (const waiter of [...waiters]) waiter.resolve(value);
  }

  async locatorValue(tabId: number, spec: LocatorSpec, operation: string, args: unknown[] = []): Promise<unknown> {
    const session = await this.session(tabId);
    return this.action(tabId, operation, spec, async () => {
      if (operation === "count") return (await this.resolveMetadata(session, spec)).length;
      if (operation === "waitFor") {
        await this.waitForLocatorState(session, spec, ((args[0] as { state?: WaitState } | undefined)?.state ?? "visible"));
        return this.afterAction(session);
      }
      if (["isVisible", "isEnabled", "isChecked"].includes(operation)) {
        const matches = await this.resolveMetadata(session, spec);
        if (!matches.length) return false;
        this.assertStrict(spec, matches);
        const objectId = await this.resolveOnce(session, spec);
        if (!objectId) return false;
        const state = await this.elementState(this.objectSession(session, objectId), objectId);
        return operation === "isVisible" ? state.visible : operation === "isEnabled" ? state.enabled : state.checked;
      }
      if (["textContent", "innerText", "inputValue", "getAttribute"].includes(operation)) {
        const objectId = await this.resolveOne(session, spec);
        const targetSession = this.objectSession(session, objectId);
        const property = operation === "inputValue" ? "value" : operation;
        return this.callOn(targetSession, objectId, `function(name){ return name === "getAttribute" ? this.getAttribute(arguments[1]) : this[name]; }`, [property, args[0]]);
      }
      if (operation === "evaluate") {
        const objectId = await this.resolveOne(session, spec);
        const targetSession = this.objectSession(session, objectId);
        const source = typeof args[0] === "function" ? String(args[0]) : String(args[0]);
        return this.callOn(targetSession, objectId, `function(arg){ return (${source})(this,arg); }`, [args[1]]);
      }
      if (operation === "scrollIntoViewIfNeeded") {
        const { objectId, targetSession } = await this.waitActionableLocator(session, spec, false, false, true, false);
        const node = await this.describe(targetSession, objectId);
        await this.options.command(targetSession.debuggee, "DOM.scrollIntoViewIfNeeded", { backendNodeId: node.backendNodeId });
        return this.afterAction(session);
      }
      if (operation === "focus" || operation === "blur") {
        const objectId = await this.resolveOne(session, spec);
        const targetSession = this.objectSession(session, objectId);
        if (operation === "focus") {
          const node = await this.describe(targetSession, objectId);
          await this.options.command(targetSession.debuggee, "DOM.focus", { backendNodeId: node.backendNodeId });
        } else await this.callOn(targetSession, objectId, "function(){ this.blur(); }");
        return this.afterAction(session);
      }
      if (operation === "fill" || operation === "clear") {
        const { objectId, targetSession } = await this.waitActionableLocator(session, spec, true, false);
        const value = operation === "clear" ? "" : String(args[0] ?? "");
        const node = await this.describe(targetSession, objectId);
        await this.options.command(targetSession.debuggee, "DOM.focus", { backendNodeId: node.backendNodeId });
        await this.options.command(targetSession.debuggee, "Input.dispatchKeyEvent", { type: "rawKeyDown", key: "a", code: "KeyA", commands: ["selectAll"] });
        await this.options.command(targetSession.debuggee, "Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA" });
        await this.options.command(targetSession.debuggee, "Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Backspace", code: "Backspace" });
        await this.options.command(targetSession.debuggee, "Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace" });
        if (value) await this.options.command(targetSession.debuggee, "Input.insertText", { text: value });
        return this.afterAction(session);
      }
      if (operation === "press" || operation === "pressSequentially") {
        const { objectId, targetSession } = await this.waitActionableLocator(session, spec, operation === "pressSequentially", false, false, operation === "pressSequentially");
        const node = await this.describe(targetSession, objectId);
        await this.options.command(targetSession.debuggee, "DOM.focus", { backendNodeId: node.backendNodeId });
        if (operation === "pressSequentially") {
          for (const character of String(args[0] ?? "")) await this.options.command(targetSession.debuggee, "Input.insertText", { text: character });
        } else await this.press(targetSession, String(args[0] ?? ""));
        return this.afterAction(session);
      }
      if (operation === "selectOption") {
        const { objectId, targetSession } = await this.waitActionableLocator(session, spec, false, false);
        const values = Array.isArray(args[0]) ? args[0].map(String) : [String(args[0])];
        const selected = await this.callOn(targetSession, objectId, `function(values){
          for (const option of this.options) option.selected = values.includes(option.value) || values.includes(option.label);
          this.dispatchEvent(new Event("input", { bubbles: true })); this.dispatchEvent(new Event("change", { bubbles: true }));
          return [...this.selectedOptions].map(option => option.value);
        }`, [values]);
        return { selected, ...(await this.afterAction(session)) };
      }
      if (operation === "setInputFiles") {
        const objectId = await this.resolveOne(session, spec);
        const targetSession = this.objectSession(session, objectId);
        const requested = Array.isArray(args[0]) ? args[0] : [args[0]];
        for (const file of requested as any[]) {
          if (!file || typeof file !== "object" || typeof file.name !== "string" || !("text" in file || "base64" in file || "url" in file) || "path" in file) {
            throw new Error("setInputFiles accepts { name, mimeType?, text | base64 | url }; local paths are not supported.");
          }
        }
        const files = await Promise.all(requested.map(async (file: any) => {
          if (file?.url) {
            const response = await fetch(file.url);
            if (!response.ok) throw new Error(`Could not fetch upload URL: ${response.status}`);
            const bytes = new Uint8Array(await response.arrayBuffer());
            let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte);
            return { name: file.name || new URL(file.url).pathname.split("/").pop() || "file", mimeType: file.mimeType || response.headers.get("content-type") || "application/octet-stream", base64: btoa(binary) };
          }
          return file;
        }));
        await this.callOn(targetSession, objectId, `function(files){
          const transfer = new DataTransfer();
          for (const file of files) {
            const bytes = file.base64 ? Uint8Array.from(atob(file.base64), c => c.charCodeAt(0)) : new TextEncoder().encode(file.text || "");
            transfer.items.add(new File([bytes], file.name, { type: file.mimeType || "application/octet-stream" }));
          }
          this.files = transfer.files; this.dispatchEvent(new Event("input", { bubbles: true })); this.dispatchEvent(new Event("change", { bubbles: true }));
        }`, [files]);
        return this.afterAction(session);
      }
      if (operation === "check" || operation === "uncheck") {
        const { objectId, targetSession } = await this.waitActionableLocator(session, spec, false, true);
        const desired = operation === "check";
        const checked = await this.callOn(targetSession, objectId, "function(){ return Boolean(this.checked); }");
        if (checked !== desired) await this.pointer(session, spec, "click");
        await this.waitForLocatorState(session, spec, "checked", desired);
        return this.afterAction(session);
      }
      if (operation === "dragTo") {
        const target = args[0] as LocatorFacade;
        const from = await this.waitActionableLocator(session, spec, false, true, true, false);
        const to = await this.waitActionableLocator(session, target.spec, false, true, true, false);
        const start = await this.toRootPoint(session, from.targetSession, from.state);
        const end = await this.toRootPoint(session, to.targetSession, to.state);
        await this.options.command(session.debuggee, "Input.dispatchMouseEvent", { type: "mouseMoved", ...start });
        await this.options.command(session.debuggee, "Input.dispatchMouseEvent", { type: "mousePressed", ...start, button: "left", clickCount: 1 });
        await this.options.command(session.debuggee, "Input.dispatchMouseEvent", { type: "mouseMoved", ...end, button: "left" });
        await this.options.command(session.debuggee, "Input.dispatchMouseEvent", { type: "mouseReleased", ...end, button: "left", clickCount: 1 });
        return this.afterAction(session);
      }
      if (["click", "dblclick", "hover"].includes(operation)) {
        await this.pointer(session, spec, operation);
        return this.afterAction(session);
      }
      throw automationError("unsupported", { operation, locator: spec });
    });
  }

  private async session(tabId: number): Promise<Session> {
    let session = this.sessions.get(tabId);
    if (!session) {
      session = {
        tabId,
        debuggee: { tabId },
        generation: 0,
        nextRef: 1,
        refs: new Map(),
        refsByNode: new Map(),
        frames: new Map(),
        frameReady: new Map(),
        frameParents: new Map(),
        lifecycle: new Set(),
      };
      this.sessions.set(tabId, session);
    }
    await this.options.mark(tabId);
    session.ready ??= (async () => {
      for (const domain of ["Page", "Runtime", "DOM", "Accessibility"]) await this.options.command(session!.debuggee, `${domain}.enable`, {});
      await this.options.command(session!.debuggee, "Page.setLifecycleEventsEnabled", { enabled: true });
      await this.options.command(session!.debuggee, "Target.setAutoAttach", { autoAttach: true, flatten: true, waitForDebuggerOnStart: false });
      const tree = await this.options.command(session!.debuggee, "Page.getFrameTree", {});
      const add = (item: any, parentId?: string) => {
        const frameId = item?.frame?.id;
        if (!frameId) return;
        session!.frames.set(frameId, session!.debuggee);
        session!.frameParents.set(frameId, parentId);
        if (!parentId) session!.rootFrameId = frameId;
        for (const child of item.childFrames ?? []) add(child, frameId);
      };
      add(tree?.frameTree);
    })().catch((error) => { session!.ready = undefined; throw error; });
    await session.ready;
    return session;
  }

  private async resolveMetadata(session: Session, spec: LocatorSpec): Promise<Candidate[]> {
    if (spec.ref) {
      const ref = session.refs.get(spec.ref);
      if (!ref || ref.generation !== session.generation) throw automationError("stale-ref", { ref: spec.ref, reason: "expired-document" });
      try {
        await this.options.command(ref.debuggee, "DOM.resolveNode", { backendNodeId: ref.backendNodeId });
        return [{ role: ref.role, name: ref.name, ref: spec.ref }];
      } catch {
        const rebound = await this.rebindRef(session, spec.ref, ref);
        return [{ role: rebound.role, name: rebound.name, ref: spec.ref }];
      }
    }
    const scoped = await this.locatorScope(session, spec);
    if (this.usesNativeAccessibility(scoped.spec)) return this.resolveAccessibility(scoped.debuggee, scoped.spec);
    return await this.evaluateIn(scoped.debuggee, `(${RESOLVER_SOURCE})(${JSON.stringify(scoped.spec)}, true)`) as Candidate[];
  }

  private async resolveOne(session: Session, spec: LocatorSpec): Promise<string> {
    let attempt = 0;
    while (true) {
      throwIfAborted(this.context.signal);
      let candidates: Candidate[] = [];
      const resolved = await this.resolveOnce(session, spec, (matches) => { candidates = matches; });
      this.recordAttempt(session, spec, ++attempt, resolved ? "resolved" : "no-candidate", candidates);
      if (resolved) return resolved;
      await delay(50, this.context.signal);
    }
  }

  private async resolveOnce(session: Session, spec: LocatorSpec, observe?: (matches: Candidate[]) => void): Promise<string | undefined> {
    if (spec.ref) {
      const ref = session.refs.get(spec.ref);
      if (!ref || ref.generation !== session.generation) throw automationError("stale-ref", { ref: spec.ref, reason: "expired-document" });
      observe?.([{ role: ref.role, name: ref.name, ref: spec.ref }]);
      try {
        const response = await this.options.command(ref.debuggee, "DOM.resolveNode", { backendNodeId: ref.backendNodeId, objectGroup: "surf-wax-automation" });
        if (!response.object?.objectId) throw new Error("missing objectId");
        this.objectDebuggees.set(response.object.objectId, ref.debuggee);
        return response.object.objectId;
      } catch {
        const rebound = await this.rebindRef(session, spec.ref, ref);
        const response = await this.options.command(rebound.debuggee, "DOM.resolveNode", { backendNodeId: rebound.backendNodeId, objectGroup: "surf-wax-automation" });
        if (!response.object?.objectId) throw automationError("detached", { ref: spec.ref, reason: "node-removed" });
        this.objectDebuggees.set(response.object.objectId, rebound.debuggee);
        return response.object.objectId;
      }
    }
    const scoped = await this.locatorScope(session, spec);
    if (this.usesNativeAccessibility(scoped.spec)) {
      const matches = await this.resolveAccessibility(scoped.debuggee, scoped.spec);
      observe?.(matches);
      this.assertStrict(spec, matches);
      const match = matches[0];
      if (!match?.backendNodeId) return undefined;
      try {
        const response = await this.options.command(scoped.debuggee, "DOM.resolveNode", { backendNodeId: match.backendNodeId, objectGroup: "surf-wax-automation" });
        if (!response.object?.objectId) return undefined;
        this.objectDebuggees.set(response.object.objectId, scoped.debuggee);
        return response.object.objectId;
      } catch { return undefined; }
    }
    const matches = await this.evaluateIn(scoped.debuggee, `(${RESOLVER_SOURCE})(${JSON.stringify(scoped.spec)}, true)`) as Candidate[];
    observe?.(matches);
    this.assertStrict(spec, matches);
    if (!matches.length) return undefined;
    const response = await this.options.command(scoped.debuggee, "Runtime.evaluate", {
      expression: `(${RESOLVER_SOURCE})(${JSON.stringify(scoped.spec)}, false)`, returnByValue: false, objectGroup: "surf-wax-automation",
    });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    if (!response.result?.objectId) return undefined;
    this.objectDebuggees.set(response.result.objectId, scoped.debuggee);
    return response.result.objectId;
  }

  private assertStrict(spec: LocatorSpec, matches: Candidate[]): void {
    if (matches.length <= 1) return;
    throw automationError("strict-mode", { locator: spec, count: matches.length, candidates: matches.slice(0, 10) });
  }

  private usesNativeAccessibility(spec: LocatorSpec): boolean {
    return !spec.has && !spec.hasText && spec.queries.length === 1 && ["role", "label"].includes(spec.queries[0]!.kind);
  }

  private async resolveAccessibility(debuggee: Debuggee, spec: LocatorSpec): Promise<Candidate[]> {
    const query = spec.queries[0]!;
    const key = JSON.stringify(debuggee);
    let nodeId = this.axRoots.get(key);
    if (nodeId === undefined) {
      nodeId = (await this.options.command(debuggee, "DOM.getDocument", { depth: 0 })).root?.nodeId;
      if (nodeId === undefined) throw automationError("detached", { reason: "missing-document-root" });
      this.axRoots.set(key, nodeId);
    }
    const tree = await this.options.command(debuggee, "Accessibility.queryAXTree", query.kind === "role"
      ? { nodeId, role: query.value, ...(query.name ? { accessibleName: query.name } : {}) }
      : { nodeId, accessibleName: query.value });
    const controls = new Set(["button", "checkbox", "combobox", "listbox", "option", "radio", "searchbox", "slider", "spinbutton", "switch", "textbox"]);
    const normalize = (value: unknown) => String(value ?? "").replace(/\s+/g, " ").trim();
    const equal = (actual: string, expected: string) => query.exact ? actual === expected : actual.toLocaleLowerCase().includes(expected.toLocaleLowerCase());
    let matches = (tree.nodes ?? []).flatMap((node: any): Candidate[] => {
      if (node.ignored || !node.backendDOMNodeId) return [];
      const role = axValue(node.role);
      const name = normalize(axValue(node.name));
      const expected = normalize(query.kind === "role" ? query.name ?? "" : query.value);
      if (query.kind === "role" && (role !== query.value || expected && !equal(name, expected))) return [];
      if (query.kind === "label" && (!controls.has(role) || !equal(name, expected))) return [];
      return [{ role, name, backendNodeId: node.backendDOMNodeId, debuggee }];
    });
    if (spec.index !== undefined) {
      const index = spec.index < 0 ? matches.length + spec.index : spec.index;
      matches = matches[index] ? [matches[index]!] : [];
    }
    return matches;
  }

  private async rebindRef(session: Session, id: string, ref: RefRecord): Promise<RefRecord> {
    if (ref.generation !== session.generation) throw automationError("stale-ref", { ref: id, reason: "expired-document" });
    const matches = await this.resolveAccessibility(ref.debuggee, { queries: [{ kind: "role", value: ref.role, name: ref.name, exact: true }] });
    if (matches.length !== 1 || !matches[0]?.backendNodeId) {
      throw automationError(matches.length > 1 ? "ambiguous-ref" : "detached", { ref: id, role: ref.role, name: ref.name, candidates: matches.slice(0, 10) });
    }
    const rebound = { ...ref, backendNodeId: matches[0].backendNodeId };
    session.refs.set(id, rebound);
    return rebound;
  }

  private async locatorScope(session: Session, spec: LocatorSpec): Promise<{ debuggee: Debuggee; spec: LocatorSpec }> {
    let debuggee = session.debuggee;
    let scoped = spec;
    while (true) {
      const frameIndex = scoped.queries.findIndex((query) => query.kind === "frame");
      if (frameIndex < 0) return { debuggee, spec: scoped };
      const frame = scoped.queries[frameIndex]!;
      const ownerSpec: LocatorSpec = { queries: [...scoped.queries.slice(0, frameIndex), { ...frame, kind: "css" }] };
      const ownerId = await this.resolveDirect(debuggee, ownerSpec);
      const owner = (await this.options.command(debuggee, "DOM.describeNode", { objectId: ownerId })).node;
      const child = owner?.frameId ? session.frames.get(owner.frameId) : undefined;
      if (!child?.sessionId) return { debuggee, spec: scoped };
      await session.frameReady.get(child.sessionId);
      debuggee = child;
      scoped = { ...scoped, queries: scoped.queries.slice(frameIndex + 1) };
    }
  }

  private async resolveDirect(debuggee: Debuggee, spec: LocatorSpec): Promise<string> {
    while (true) {
      throwIfAborted(this.context.signal);
      const matches = await this.evaluateIn(debuggee, `(${RESOLVER_SOURCE})(${JSON.stringify(spec)}, true)`) as any[];
      if (matches.length > 1) throw automationError("strict-mode", { locator: spec, count: matches.length, candidates: matches.slice(0, 10) });
      if (matches.length === 1) {
        const response = await this.options.command(debuggee, "Runtime.evaluate", { expression: `(${RESOLVER_SOURCE})(${JSON.stringify(spec)}, false)`, returnByValue: false, objectGroup: "surf-wax-automation" });
        if (response.result?.objectId) return response.result.objectId;
      }
      await delay(50, this.context.signal);
    }
  }

  private async evaluateIn(debuggee: Debuggee, expression: string): Promise<unknown> {
    const response = await this.options.command(debuggee, "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    return response.result?.value;
  }

  private objectSession(session: Session, objectId: string): Session {
    const debuggee = this.objectDebuggees.get(objectId);
    return debuggee ? { ...session, debuggee } : session;
  }

  private async describe(session: Session, objectId: string): Promise<any> {
    return (await this.options.command(session.debuggee, "DOM.describeNode", { objectId })).node;
  }

  private async callOn(session: Session, objectId: string, functionDeclaration: string, args: unknown[] = []): Promise<any> {
    const response = await this.options.command(session.debuggee, "Runtime.callFunctionOn", {
      objectId, functionDeclaration, arguments: args.map((value) => ({ value })), awaitPromise: true, returnByValue: true,
    });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    return response.result?.value;
  }

  private async elementState(session: Session, objectId: string): Promise<ElementState> {
    return this.callOn(session, objectId, `async function(){
      if (!this.isConnected) return { connected: false, x: 0, y: 0, visible: false, stable: false, enabled: false, editable: false, receivesEvents: false, checked: false };
      this.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      const first = this.getBoundingClientRect(); await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); const rect = this.getBoundingClientRect();
      const style = getComputedStyle(this); let x = rect.left + rect.width / 2; let y = rect.top + rect.height / 2;
      const guard = document.getElementById("__surf-wax-page-guard"); const pointerEvents = guard?.style.getPropertyValue("pointer-events"); const pointerPriority = guard?.style.getPropertyPriority("pointer-events");
      if (guard) guard.style.setProperty("pointer-events", "none", "important");
      let hit = this.ownerDocument.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      while (hit?.shadowRoot) { const nested = hit.shadowRoot.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2); if (!nested || nested === hit) break; hit = nested; }
      if (guard) guard.style.setProperty("pointer-events", pointerEvents || "auto", pointerPriority || "important");
      let view = this.ownerDocument.defaultView;
      while (view?.frameElement) { const frame = view.frameElement.getBoundingClientRect(); x += frame.left; y += frame.top; view = view.parent; }
      const disabled = Boolean(this.disabled || this.closest("fieldset:disabled") || this.closest('[aria-disabled="true"]'));
      const editable = !disabled && !this.readOnly && this.getAttribute("aria-readonly") !== "true" && (this.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(this.tagName));
      return { connected: true, x, y, visible: rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none", stable: first.x === rect.x && first.y === rect.y && first.width === rect.width && first.height === rect.height, enabled: !disabled, editable, receivesEvents: Boolean(hit && (hit === this || this.contains(hit))), checked: Boolean(this.checked) };
    }`);
  }

  private async waitForLocatorState(session: Session, spec: LocatorSpec, state: WaitState, checked = true): Promise<void> {
    let attempt = 0;
    while (true) {
      throwIfAborted(this.context.signal);
      let matches: Candidate[];
      try { matches = await this.resolveMetadata(session, spec); }
      catch (error) {
        if (error instanceof AutomationError && error.code === "detached" && (state === "detached" || state === "hidden")) return;
        throw error;
      }
      this.assertStrict(spec, matches);
      attempt += 1;
      if (!matches.length) {
        this.recordAttempt(session, spec, attempt, "no-candidate", matches);
        if (state === "detached" || state === "hidden") return;
        await delay(50, this.context.signal);
        continue;
      }
      if (state === "attached") { this.recordAttempt(session, spec, attempt, "attached", matches); return; }
      const objectId = await this.resolveOnce(session, spec);
      if (!objectId) { await delay(50, this.context.signal); continue; }
      const value = await this.elementState(this.objectSession(session, objectId), objectId).catch(() => undefined);
      this.recordAttempt(session, spec, attempt, value?.connected ? `checking-${state}` : "detached", matches, value);
      if (!value?.connected) {
        if (state === "detached" || state === "hidden") return;
      } else if (state === "visible" && value.visible || state === "hidden" && !value.visible || state === "enabled" && value.enabled || state === "editable" && value.editable || state === "checked" && value.checked === checked) return;
      await delay(50, this.context.signal);
    }
  }

  private async waitActionableLocator(session: Session, spec: LocatorSpec, editable: boolean, pointer: boolean, stable = pointer, enabled = true): Promise<{ objectId: string; targetSession: Session; state: ElementState }> {
    let attempt = 0;
    while (true) {
      throwIfAborted(this.context.signal);
      let candidates: Candidate[] = [];
      const objectId = await this.resolveOnce(session, spec, (matches) => { candidates = matches; });
      attempt += 1;
      if (!objectId) { this.recordAttempt(session, spec, attempt, "no-candidate", candidates); await delay(50, this.context.signal); continue; }
      const targetSession = this.objectSession(session, objectId);
      const state = await this.elementState(targetSession, objectId).catch((error) => {
        if (spec.ref) throw automationError("detached", { ref: spec.ref, reason: error instanceof Error ? error.message : String(error) });
        return undefined;
      });
      const reason = !state?.connected ? "detached" : !state.visible ? "not-visible" : stable && !state.stable ? "not-stable" : enabled && !state.enabled ? "disabled" : editable && !state.editable ? "not-editable" : pointer && !state.receivesEvents ? "intercepted" : "actionable";
      this.recordAttempt(session, spec, attempt, reason, candidates, state);
      if (spec.ref && !state?.connected) throw automationError("detached", { ref: spec.ref, reason: "node-removed" });
      if (state?.connected && state.visible && (!stable || state.stable) && (!enabled || state.enabled) && (!editable || state.editable) && (!pointer || state.receivesEvents)) return { objectId, targetSession, state };
      await delay(50, this.context.signal);
    }
  }

  private async toRootPoint(session: Session, targetSession: Session, state: ElementState): Promise<{ x: number; y: number }> {
    let x = state.x;
    let y = state.y;
    let debuggee = targetSession.debuggee;
    while (debuggee.sessionId) {
      const frameId = [...session.frames].find(([, item]) => item.sessionId === debuggee.sessionId)?.[0];
      if (!frameId) throw automationError("frame-detached", { sessionId: debuggee.sessionId });
      const parentId = session.frameParents.get(frameId);
      const parent = parentId ? session.frames.get(parentId) ?? session.debuggee : session.debuggee;
      const owner = await this.options.command(parent, "DOM.getFrameOwner", { frameId });
      const model = await this.options.command(parent, "DOM.getBoxModel", { backendNodeId: owner.backendNodeId });
      const size = await this.evaluateIn(debuggee, "({width:innerWidth,height:innerHeight})") as { width: number; height: number };
      const quad = model?.model?.content as number[] | undefined;
      if (!quad?.length || !size.width || !size.height) throw automationError("frame-detached", { frameId, reason: "missing-frame-geometry" });
      const u = x / size.width; const v = y / size.height;
      x = quad[0]! + u * (quad[2]! - quad[0]!) + v * (quad[6]! - quad[0]!);
      y = quad[1]! + u * (quad[3]! - quad[1]!) + v * (quad[7]! - quad[1]!);
      debuggee = parent;
    }
    return { x, y };
  }

  private async pointer(session: Session, spec: LocatorSpec, operation: string): Promise<void> {
    const target = await this.waitActionableLocator(session, spec, false, true, true, operation !== "hover");
    const state = await this.toRootPoint(session, target.targetSession, target.state);
    if (operation === "hover") {
      await this.options.command(session.debuggee, "Input.dispatchMouseEvent", { type: "mouseMoved", x: state.x, y: state.y });
      return;
    }
    const count = operation === "dblclick" ? 2 : 1;
    for (let clickCount = 1; clickCount <= count; clickCount += 1) {
      await this.options.command(session.debuggee, "Input.dispatchMouseEvent", { type: "mousePressed", x: state.x, y: state.y, button: "left", clickCount });
      await this.options.command(session.debuggee, "Input.dispatchMouseEvent", { type: "mouseReleased", x: state.x, y: state.y, button: "left", clickCount });
    }
  }

  private async press(session: Session, chord: string): Promise<void> {
    const parts = chord.split("+"); const key = parts.pop() || "";
    const modifiers = parts.reduce((mask, part) => mask | (/alt/i.test(part) ? 1 : /control/i.test(part) ? 2 : /meta/i.test(part) ? 4 : /shift/i.test(part) ? 8 : 0), 0);
    const codes: Record<string, string> = { Enter: "Enter", Tab: "Tab", Escape: "Escape", Backspace: "Backspace", Delete: "Delete", ArrowUp: "ArrowUp", ArrowDown: "ArrowDown", ArrowLeft: "ArrowLeft", ArrowRight: "ArrowRight", Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown", Space: "Space" };
    const code = codes[key] ?? (key.length === 1 && /[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : key.length === 1 && /\d/.test(key) ? `Digit${key}` : key);
    const text = key.length === 1 && modifiers === 0 ? key : undefined;
    await this.options.command(session.debuggee, "Input.dispatchKeyEvent", { type: "rawKeyDown", key: key === "Space" ? " " : key, code, modifiers, ...(text ? { text } : {}) });
    await this.options.command(session.debuggee, "Input.dispatchKeyEvent", { type: "keyUp", key: key === "Space" ? " " : key, code, modifiers });
  }

  private async waitForReady(session: Session): Promise<void> {
    while (true) {
      throwIfAborted(this.context.signal);
      try { if (await this.pageValue(session.tabId, "document.readyState !== 'loading'")) return; } catch { /* Navigation swaps the context. */ }
      await delay(50, this.context.signal);
    }
  }

  private async captureSnapshot(session: Session): Promise<{ url: string; title: string; lines: SnapshotLine[] }> {
    while (true) {
      throwIfAborted(this.context.signal);
      const generation = session.generation;
      const depthOf = (frameId: string) => { let depth = 0; let current = session.frameParents.get(frameId); while (current) { depth += 1; current = session.frameParents.get(current); } return depth; };
      const childFrames = [...session.frames]
        .filter(([, debuggee]) => debuggee.sessionId)
        .map(([frameId, debuggee]) => ({ frameId, debuggee, depth: depthOf(frameId) }))
        .filter((item, index, all) => all.findIndex((other) => other.debuggee.sessionId === item.debuggee.sessionId) === index)
        .sort((left, right) => left.depth - right.depth);
      const debuggees = [{ debuggee: session.debuggee, frameId: undefined as string | undefined, depth: 0 }, ...childFrames];
      const [trees, info] = await Promise.all([
        Promise.all(debuggees.map(async (item) => ({ ...item, tree: await this.options.command(item.debuggee, "Accessibility.getFullAXTree", {}) }))),
        this.pageValue(session.tabId, "({url:location.href,title:document.title})") as Promise<{ url: string; title: string }>,
      ]);
      if (generation !== session.generation) { await delay(0, this.context.signal); continue; }
      const lines: SnapshotLine[] = [];
      const render = (nodes: any[], debuggee: Debuggee, frameLabel?: string, frameDepth = 0) => {
        const byId = new Map(nodes.map((node) => [node.nodeId, node]));
        const scope = debuggee.sessionId ?? session.rootFrameId ?? "root";
        if (frameLabel) lines.push({ id: `${scope}:frame`, line: `${"  ".repeat(frameDepth)}- iframe [frame=${frameLabel}]` });
        const visit = (node: any, depth: number) => {
          if (!node || node.ignored) { for (const child of node?.childIds ?? []) visit(byId.get(child), depth); return; }
          const role = axValue(node.role); const name = axValue(node.name); const value = axValue(node.value);
          if (role && role !== "none" && role !== "generic" && role !== "InlineTextBox") {
            let ref = "";
            const identity = `${scope}:${node.backendDOMNodeId ?? node.nodeId}`;
            if (node.backendDOMNodeId && (INTERACTIVE_ROLES.has(role) || node.properties?.some((property: any) => property.name === "focusable" && property.value?.value))) {
              ref = session.refsByNode.get(identity) ?? `e${session.nextRef++}`;
              session.refsByNode.set(identity, ref);
              session.refs.set(ref, { backendNodeId: node.backendDOMNodeId, frameId: node.frameId, debuggee, role, name, generation });
            }
            const properties = Object.fromEntries((node.properties ?? []).map((property: any) => [property.name, property.value?.value]));
            const state = ["checked", "disabled", "expanded", "pressed", "selected", "required", "readonly"].filter((key) => properties[key] !== undefined).map((key) => `${key}=${properties[key]}`).join(" ");
            const actions = !ref ? "" : ["textbox", "searchbox", "spinbutton"].includes(role) ? "click,fill,clear,press,insertText"
              : ["checkbox", "radio", "switch"].includes(role) ? "click,check"
              : ["combobox", "listbox"].includes(role) ? "click,select" : "click,doubleClick,hover";
            lines.push({ id: identity, line: `${"  ".repeat(depth)}- ${role}${name ? ` ${quote(name)}` : ""}${ref ? ` [ref=${ref}] [actions=${actions}]` : ""}${state ? ` [${state}]` : ""}${value && value !== name ? `: ${value}` : ""}` });
            depth += 1;
          }
          for (const child of node.childIds ?? []) visit(byId.get(child), depth);
        };
        const root = nodes.find((node) => !node.parentId) ?? nodes[0];
        visit(root, frameLabel ? frameDepth + 1 : 0);
      };
      for (const { debuggee, frameId, depth, tree } of trees) render(tree.nodes ?? [], debuggee, frameId, depth);
      if (generation === session.generation) return { ...info, lines };
    }
  }

  private async afterAction(session: Session): Promise<Record<string, unknown>> {
    const info = await this.pageValue(session.tabId, "({url:location.href,title:document.title})") as { url: string; title: string };
    return { performed: true, ...info, documentId: session.generation };
  }

  private async action<T>(tabId: number, operation: string, locator: LocatorSpec | null, run: () => Promise<T>): Promise<T> {
    const startedAt = performance.now();
    this.lastWait = undefined;
    this.lastAttemptLog = undefined;
    this.options.logger?.record({ type: "automation.action.started", conversationId: this.context.conversationId, toolCallId: this.context.toolCallId, content: { tabId, operation, locator } });
    try {
      const result = await run();
      this.options.logger?.record({ type: "automation.action.finished", conversationId: this.context.conversationId, toolCallId: this.context.toolCallId, content: { tabId, operation, locator }, output: result, latencyMs: performance.now() - startedAt });
      return result;
    } catch (error) {
      const lastWait = this.waitDiagnostic();
      const failure = error && typeof error === "object" && (error as { name?: string }).name === "TimeoutError"
        ? automationError(lastWait?.state?.receivesEvents === false ? "intercepted" : "timeout", { operation, locator, lastObservation: lastWait ?? null })
        : error;
      this.options.logger?.record({
        type: "automation.action.failed",
        conversationId: this.context.conversationId,
        toolCallId: this.context.toolCallId,
        content: { tabId, operation, locator, ...(failure instanceof AutomationError ? { diagnostic: { code: failure.code, ...failure.detail } } : {}) },
        error: failure,
        latencyMs: performance.now() - startedAt,
      });
      throw failure;
    }
  }
}

export class PageFacade {
  constructor(private readonly runtime: AutomationRuntime, readonly tabId: number) {}
  snapshot() { return this.runtime.snapshot(this.tabId); }
  observe(detail: "auto" | "semantic" | "visual" = "auto", since?: string) { return this.runtime.observe(this.tabId, detail, since); }
  ensureObservation(observationId: string) { return this.runtime.ensureObservation(this.tabId, observationId); }
  point(observationId: string, x: number, y: number, operation: "click" | "dblclick" | "hover") { return this.runtime.point(this.tabId, observationId, x, y, operation); }
  press(key: string) { return this.runtime.keyboard(this.tabId, "press", key); }
  insertText(text: string) { return this.runtime.keyboard(this.tabId, "insertText", text); }
  ref(ref: string) { return this.runtime.ref(this.tabId, ref); }
  locator(value: string) { return this.runtime.locator(this.tabId, { kind: "css", value }); }
  getByRole(value: string, options: { name?: string; exact?: boolean } = {}) { return this.runtime.locator(this.tabId, { kind: "role", value, ...options }); }
  getByText(value: string, options: { exact?: boolean } = {}) { return this.runtime.locator(this.tabId, { kind: "text", value, ...options }); }
  getByLabel(value: string, options: { exact?: boolean } = {}) { return this.runtime.locator(this.tabId, { kind: "label", value, ...options }); }
  getByPlaceholder(value: string, options: { exact?: boolean } = {}) { return this.runtime.locator(this.tabId, { kind: "placeholder", value, ...options }); }
  getByAltText(value: string, options: { exact?: boolean } = {}) { return this.runtime.locator(this.tabId, { kind: "alt", value, ...options }); }
  getByTitle(value: string, options: { exact?: boolean } = {}) { return this.runtime.locator(this.tabId, { kind: "title", value, ...options }); }
  getByTestId(value: string) { return this.runtime.locator(this.tabId, { kind: "testId", value, exact: true }); }
  frameLocator(value: string) { return this.runtime.locator(this.tabId, { kind: "frame", value }); }
  goto(url: string) { return this.runtime.navigate(this.tabId, "Page.navigate", { url }); }
  reload() { return this.runtime.navigate(this.tabId, "Page.reload"); }
  goBack() { return this.runtime.history(this.tabId, -1); }
  goForward() { return this.runtime.history(this.tabId, 1); }
  url() { return this.runtime.pageValue(this.tabId, "location.href"); }
  title() { return this.runtime.pageValue(this.tabId, "document.title"); }
  waitForURL(value: string | RegExp) { return this.runtime.waitUntil(() => this.url().then((url) => typeof value === "string" ? String(url).includes(value) : value.test(String(url)))); }
  waitForLoadState(state: "domcontentloaded" | "load" = "load") { return this.runtime.waitForLoadState(this.tabId, state); }
  waitForEvent(kind: "dialog" | "popup" | "download") { return this.runtime.waitForEvent(this.tabId, kind); }
  evaluate(fn: ((arg?: unknown) => unknown) | string, arg?: unknown) { return this.runtime.pageValue(this.tabId, `(${typeof fn === "function" ? String(fn) : fn})(${JSON.stringify(arg)})`); }
}

export class LocatorFacade {
  constructor(private readonly runtime: AutomationRuntime, readonly tabId: number, readonly spec: LocatorSpec) {}
  private chain(query: Query) { return new LocatorFacade(this.runtime, this.tabId, { ...this.spec, queries: [...this.spec.queries, query] }); }
  locator(value: string) { return this.chain({ kind: "css", value }); }
  frameLocator(value: string) { return this.chain({ kind: "frame", value }); }
  getByRole(value: string, options: { name?: string; exact?: boolean } = {}) { return this.chain({ kind: "role", value, ...options }); }
  getByText(value: string, options: { exact?: boolean } = {}) { return this.chain({ kind: "text", value, ...options }); }
  getByLabel(value: string, options: { exact?: boolean } = {}) { return this.chain({ kind: "label", value, ...options }); }
  getByPlaceholder(value: string, options: { exact?: boolean } = {}) { return this.chain({ kind: "placeholder", value, ...options }); }
  getByAltText(value: string, options: { exact?: boolean } = {}) { return this.chain({ kind: "alt", value, ...options }); }
  getByTitle(value: string, options: { exact?: boolean } = {}) { return this.chain({ kind: "title", value, ...options }); }
  getByTestId(value: string) { return this.chain({ kind: "testId", value, exact: true }); }
  filter(options: { hasText?: string; has?: LocatorFacade }) { return new LocatorFacade(this.runtime, this.tabId, { ...this.spec, hasText: options.hasText, has: options.has?.spec }); }
  first() { return this.nth(0); }
  last() { return this.nth(-1); }
  nth(index: number) { return new LocatorFacade(this.runtime, this.tabId, { ...this.spec, index }); }
  count() { return this.run("count"); }
  waitFor(options: { state?: WaitState } = {}) { return this.run("waitFor", options); }
  click() { return this.run("click"); }
  dblclick() { return this.run("dblclick"); }
  hover() { return this.run("hover"); }
  fill(value: string) { return this.run("fill", value); }
  clear() { return this.run("clear"); }
  press(key: string) { return this.run("press", key); }
  pressSequentially(text: string) { return this.run("pressSequentially", text); }
  check() { return this.run("check"); }
  uncheck() { return this.run("uncheck"); }
  selectOption(value: string | string[]) { return this.run("selectOption", value); }
  dragTo(target: LocatorFacade) { return this.run("dragTo", target); }
  setInputFiles(files: unknown) { return this.run("setInputFiles", files); }
  focus() { return this.run("focus"); }
  blur() { return this.run("blur"); }
  scrollIntoViewIfNeeded() { return this.run("scrollIntoViewIfNeeded"); }
  textContent() { return this.run("textContent"); }
  innerText() { return this.run("innerText"); }
  inputValue() { return this.run("inputValue"); }
  getAttribute(name: string) { return this.run("getAttribute", name); }
  isVisible() { return this.run("isVisible"); }
  isEnabled() { return this.run("isEnabled"); }
  isChecked() { return this.run("isChecked"); }
  evaluate(fn: ((element: Element, arg?: unknown) => unknown) | string, arg?: unknown) { return this.run("evaluate", fn, arg); }
  private run(operation: string, ...args: unknown[]) { return this.runtime.locatorValue(this.tabId, this.spec, operation, args); }
}
