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
type RefRecord = { backendNodeId: number; frameId?: string; debuggee: Debuggee; role: string; name: string; generation: number };
type Session = {
  tabId: number;
  debuggee: Debuggee;
  ready?: Promise<void>;
  generation: number;
  nextRef: number;
  refs: Map<string, RefRecord>;
  refsByNode: Map<string, string>;
  frames: Map<string, Debuggee>;
  lastSnapshot?: string[];
};

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
    ARTICLE: "article", UL: "list", OL: "list", LI: "listitem", DIALOG: "dialog", PROGRESS: "progressbar",
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
  const matches = (el, query) => {
    const equal = (actual, expected) => query.exact ? normalize(actual) === normalize(expected) : normalize(actual).toLowerCase().includes(normalize(expected).toLowerCase());
    if (query.kind === "role") return roleOf(el) === query.value && (!query.name || equal(nameOf(el), query.name));
    if (query.kind === "text") return equal(el.textContent, query.value) && ![...el.children].some(child => equal(child.textContent, query.value));
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
    if (locator.hasText) current = current.filter(el => normalize(el.textContent).toLowerCase().includes(normalize(locator.hasText).toLowerCase()));
    if (locator.has) current = current.filter(el => resolve(el, locator.has).length > 0);
    if (locator.index !== undefined) current = current.at(locator.index < 0 ? current.length + locator.index : locator.index) ? [current.at(locator.index < 0 ? current.length + locator.index : locator.index)] : [];
    return [...new Set(current)];
  };
  const result = resolve(document, spec);
  if (!metadata) return result[0] || null;
  return result.map(el => ({ role: roleOf(el), name: nameOf(el), tag: el.tagName.toLowerCase(), text: normalize(el.textContent).slice(0, 120) }));
}`;

function abortError(): DOMException {
  return new DOMException("Operation aborted", "AbortError");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    const abort = () => { clearTimeout(timer); reject(abortError()); };
    signal.addEventListener("abort", abort, { once: true });
  });
}

function axValue(value: any): string {
  return typeof value?.value === "string" || typeof value?.value === "number" || typeof value?.value === "boolean" ? String(value.value) : "";
}

function quote(value: string): string {
  return JSON.stringify(value.replace(/\s+/g, " ").trim());
}

export class AutomationRuntime {
  private readonly sessions = new Map<number, Session>();
  private readonly objectDebuggees = new Map<string, Debuggee>();
  private context: RunContext = {};
  private readonly waiters = new Map<number, Map<string, Set<Waiter>>>();

  constructor(private readonly options: {
    chromeApi: typeof chrome;
    command: Command;
    detach: (debuggee: Debuggee) => Promise<void>;
    mark: (tabId: number) => Promise<void>;
    logger?: EventLogger;
  }) {}

  setContext(context: RunContext): void { this.context = context; }
  clearContext(): void { this.context = {}; }

  async createPage(tabId?: number): Promise<PageFacade> {
    const resolved = tabId ?? (await this.options.chromeApi.tabs.query({ active: true, currentWindow: true }))[0]?.id;
    if (!Number.isInteger(resolved)) throw new Error("page() could not find an active tab; pass tabId explicitly.");
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
      for (const domain of ["Page", "Runtime", "DOM", "Accessibility"]) void this.options.command(debuggee, `${domain}.enable`, {}).catch(() => undefined);
    }
    if (method === "Page.frameNavigated" && params?.frame?.id && session) session.frames.set(params.frame.id, source);
    if (method === "Page.frameNavigated" && !source.sessionId && !params?.frame?.parentId && session) {
      session.generation += 1;
      session.refs.clear();
      session.refsByNode.clear();
      session.lastSnapshot = undefined;
    }
    const kind = method === "Page.javascriptDialogOpening" ? "dialog" : undefined;
    if (kind) this.resolveWaiters(tabId!, kind, params);
  }

  handleDetach(source: Debuggee): void {
    if (Number.isInteger(source.tabId)) this.sessions.delete(source.tabId!);
  }

  async abortSessions(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    this.objectDebuggees.clear();
    for (const events of this.waiters.values()) for (const waiters of events.values()) for (const waiter of waiters) waiter.reject(abortError());
    this.waiters.clear();
    await Promise.all(sessions.map((session) => this.options.detach(session.debuggee).catch(() => undefined)));
  }

  dispose(): void { void this.abortSessions(); }

  locator(tabId: number, query: Query): LocatorFacade { return new LocatorFacade(this, tabId, { queries: [query] }); }
  ref(tabId: number, ref: string): LocatorFacade { return new LocatorFacade(this, tabId, { queries: [], ref }); }

  async snapshot(tabId: number): Promise<{ url: string; title: string; snapshot: string }> {
    return this.action(tabId, "snapshot", null, async () => {
      const session = await this.session(tabId);
      const captured = await this.captureSnapshot(session);
      session.lastSnapshot = captured.lines;
      return { url: captured.url, title: captured.title, snapshot: captured.lines.join("\n") };
    });
  }

  async navigate(tabId: number, method: string, params?: object): Promise<unknown> {
    const session = await this.session(tabId);
    return this.action(tabId, method, null, async () => {
      const result = await this.options.command(session.debuggee, method, params);
      if (result?.errorText) throw new Error(result.errorText);
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

  waitForEvent(tabId: number, kind: "dialog" | "popup" | "download"): Promise<any> {
    throwIfAborted(this.context.signal);
    if (kind === "download" || kind === "popup") return new Promise((resolve, reject) => {
      const signal = this.context.signal;
      const event = kind === "download" ? this.options.chromeApi.downloads.onCreated : this.options.chromeApi.tabs.onCreated;
      const cleanup = () => { signal?.removeEventListener("abort", abort); event.removeListener(created as never); };
      const abort = () => { cleanup(); reject(abortError()); };
      const created = (item: chrome.downloads.DownloadItem | chrome.tabs.Tab) => {
        if (kind === "popup" && (item as chrome.tabs.Tab).openerTabId !== tabId) return;
        cleanup();
        resolve(kind === "popup" ? new PageFacade(this, (item as chrome.tabs.Tab).id!) : item);
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
      if (operation === "waitFor") { await this.resolveOne(session, spec); return this.afterAction(session); }
      if (["isVisible", "isEnabled", "isChecked"].includes(operation)) {
        const matches = await this.resolveMetadata(session, spec);
        if (!matches.length) return false;
        if (matches.length > 1) throw new Error(`AutomationError[strict-mode]: locator matched ${matches.length} elements: ${JSON.stringify(matches.slice(0, 10))}`);
        const objectId = await this.resolveOne(session, spec);
        const state = await this.elementState(this.objectSession(session, objectId), objectId);
        return operation === "isVisible" ? state.visible : operation === "isEnabled" ? state.enabled : state.checked;
      }
      const objectId = await this.resolveOne(session, spec);
      const targetSession = this.objectSession(session, objectId);
      if (["textContent", "innerText", "inputValue", "getAttribute"].includes(operation)) {
        const property = operation === "inputValue" ? "value" : operation;
        return this.callOn(targetSession, objectId, `function(name){ return name === "getAttribute" ? this.getAttribute(arguments[1]) : this[name]; }`, [property, args[0]]);
      }
      if (operation === "evaluate") {
        const source = typeof args[0] === "function" ? String(args[0]) : String(args[0]);
        return this.callOn(targetSession, objectId, `function(arg){ return (${source})(this,arg); }`, [args[1]]);
      }
      if (operation === "scrollIntoViewIfNeeded") {
        const node = await this.describe(targetSession, objectId);
        await this.options.command(targetSession.debuggee, "DOM.scrollIntoViewIfNeeded", { backendNodeId: node.backendNodeId });
        return this.afterAction(session);
      }
      if (operation === "focus" || operation === "blur") {
        if (operation === "focus") {
          const node = await this.describe(targetSession, objectId);
          await this.options.command(targetSession.debuggee, "DOM.focus", { backendNodeId: node.backendNodeId });
        } else await this.callOn(targetSession, objectId, "function(){ this.blur(); }");
        return this.afterAction(session);
      }
      if (operation === "fill" || operation === "clear") {
        await this.waitActionable(targetSession, objectId, true, false);
        const value = operation === "clear" ? "" : String(args[0] ?? "");
        await this.callOn(targetSession, objectId, `function(value){
          this.focus();
          if (this.isContentEditable) { this.textContent = value; }
          else { const proto = Object.getPrototypeOf(this); const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set; setter ? setter.call(this, value) : this.value = value; }
          this.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
          this.dispatchEvent(new Event("change", { bubbles: true }));
        }`, [value]);
        return this.afterAction(session);
      }
      if (operation === "press" || operation === "pressSequentially") {
        await this.waitActionable(targetSession, objectId, true, false);
        await this.callOn(targetSession, objectId, "function(){ this.focus(); }");
        if (operation === "pressSequentially") {
          for (const character of String(args[0] ?? "")) await this.options.command(targetSession.debuggee, "Input.insertText", { text: character });
        } else await this.press(targetSession, String(args[0] ?? ""));
        return this.afterAction(session);
      }
      if (operation === "selectOption") {
        await this.waitActionable(targetSession, objectId, false, false);
        const values = Array.isArray(args[0]) ? args[0].map(String) : [String(args[0])];
        const selected = await this.callOn(targetSession, objectId, `function(values){
          for (const option of this.options) option.selected = values.includes(option.value) || values.includes(option.label);
          this.dispatchEvent(new Event("input", { bubbles: true })); this.dispatchEvent(new Event("change", { bubbles: true }));
          return [...this.selectedOptions].map(option => option.value);
        }`, [values]);
        return { selected, ...(await this.afterAction(session)) };
      }
      if (operation === "setInputFiles") {
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
        const desired = operation === "check";
        const checked = await this.callOn(targetSession, objectId, "function(){ return Boolean(this.checked); }");
        if (checked !== desired) await this.pointer(targetSession, objectId, "click");
        const actual = await this.callOn(targetSession, objectId, "function(){ return Boolean(this.checked); }");
        if (actual !== desired) throw new Error(`AutomationError[state-mismatch]: element did not become ${desired ? "checked" : "unchecked"}`);
        return this.afterAction(session);
      }
      if (operation === "dragTo") {
        const target = args[0] as LocatorFacade;
        const targetId = await this.resolveOne(session, target.spec);
        const dragSession = this.objectSession(session, targetId);
        if (JSON.stringify(targetSession.debuggee) !== JSON.stringify(dragSession.debuggee)) throw new Error("dragTo requires both elements to be in the same frame.");
        const from = await this.waitActionable(targetSession, objectId, false, true);
        const to = await this.waitActionable(dragSession, targetId, false, true);
        await this.options.command(targetSession.debuggee, "Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x, y: from.y });
        await this.options.command(targetSession.debuggee, "Input.dispatchMouseEvent", { type: "mousePressed", x: from.x, y: from.y, button: "left", clickCount: 1 });
        await this.options.command(targetSession.debuggee, "Input.dispatchMouseEvent", { type: "mouseMoved", x: to.x, y: to.y, button: "left" });
        await this.options.command(targetSession.debuggee, "Input.dispatchMouseEvent", { type: "mouseReleased", x: to.x, y: to.y, button: "left", clickCount: 1 });
        return this.afterAction(session);
      }
      if (["click", "dblclick", "hover"].includes(operation)) {
        await this.pointer(targetSession, objectId, operation);
        return this.afterAction(session);
      }
      throw new Error(`Unsupported locator operation: ${operation}`);
    });
  }

  private async session(tabId: number): Promise<Session> {
    let session = this.sessions.get(tabId);
    if (!session) {
      session = { tabId, debuggee: { tabId }, generation: 0, nextRef: 1, refs: new Map(), refsByNode: new Map(), frames: new Map() };
      this.sessions.set(tabId, session);
    }
    await this.options.mark(tabId);
    session.ready ??= (async () => {
      for (const domain of ["Page", "Runtime", "DOM", "Accessibility"]) await this.options.command(session!.debuggee, `${domain}.enable`, {});
      await this.options.command(session!.debuggee, "Target.setAutoAttach", { autoAttach: true, flatten: true, waitForDebuggerOnStart: false });
    })().catch((error) => { session!.ready = undefined; throw error; });
    await session.ready;
    return session;
  }

  private async resolveMetadata(session: Session, spec: LocatorSpec): Promise<any[]> {
    if (spec.ref) {
      const ref = session.refs.get(spec.ref);
      if (!ref || ref.generation !== session.generation) throw new Error(`AutomationError[stale-ref]: ${spec.ref} belongs to an expired document; take a new snapshot.`);
      try {
        await this.options.command(ref.debuggee, "DOM.resolveNode", { backendNodeId: ref.backendNodeId });
        return [{ role: ref.role, name: ref.name, ref: spec.ref }];
      } catch {
        const healed = await this.evaluateIn(ref.debuggee, `(${RESOLVER_SOURCE})(${JSON.stringify({ queries: [{ kind: "role", value: ref.role, name: ref.name, exact: true }] })}, true)`) as any[];
        if (healed.length !== 1) throw new Error(`AutomationError[stale-ref]: ${spec.ref} could not be uniquely restored.`);
        return healed;
      }
    }
    const scoped = await this.locatorScope(session, spec);
    return await this.evaluateIn(scoped.debuggee, `(${RESOLVER_SOURCE})(${JSON.stringify(scoped.spec)}, true)`) as any[];
  }

  private async resolveOne(session: Session, spec: LocatorSpec): Promise<string> {
    if (spec.ref) {
      const ref = session.refs.get(spec.ref);
      if (!ref || ref.generation !== session.generation) throw new Error(`AutomationError[stale-ref]: ${spec.ref} belongs to an expired document; take a new snapshot.`);
      try {
        const resolved = await this.options.command(ref.debuggee, "DOM.resolveNode", { backendNodeId: ref.backendNodeId, objectGroup: "surf-wax-automation" });
        if (resolved.object?.objectId) {
          this.objectDebuggees.set(resolved.object.objectId, ref.debuggee);
          return resolved.object.objectId;
        }
      } catch { /* Fall through to the unique semantic fingerprint. */ }
      const objectId = await this.resolveDirect(ref.debuggee, { queries: [{ kind: "role", value: ref.role, name: ref.name, exact: true }] });
      this.objectDebuggees.set(objectId, ref.debuggee);
      return objectId;
    }
    const scoped = await this.locatorScope(session, spec);
    while (true) {
      throwIfAborted(this.context.signal);
      const matches = await this.evaluateIn(scoped.debuggee, `(${RESOLVER_SOURCE})(${JSON.stringify(scoped.spec)}, true)`) as any[];
      if (matches.length > 1) throw new Error(`AutomationError[strict-mode]: locator matched ${matches.length} elements: ${JSON.stringify(matches)}`);
      if (matches.length === 1) {
        const response = await this.options.command(scoped.debuggee, "Runtime.evaluate", {
          expression: `(${RESOLVER_SOURCE})(${JSON.stringify(scoped.spec)}, false)`, returnByValue: false, objectGroup: "surf-wax-automation",
        });
        if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
        if (response.result?.objectId) {
          this.objectDebuggees.set(response.result.objectId, scoped.debuggee);
          return response.result.objectId;
        }
      }
      await delay(50, this.context.signal);
    }
  }

  private async locatorScope(session: Session, spec: LocatorSpec): Promise<{ debuggee: Debuggee; spec: LocatorSpec }> {
    const frameIndex = spec.queries.findIndex((query) => query.kind === "frame");
    if (frameIndex < 0) return { debuggee: session.debuggee, spec };
    const frame = spec.queries[frameIndex]!;
    const ownerSpec: LocatorSpec = { queries: [...spec.queries.slice(0, frameIndex), { ...frame, kind: "css" }] };
    const ownerId = await this.resolveDirect(session.debuggee, ownerSpec);
    const owner = (await this.options.command(session.debuggee, "DOM.describeNode", { objectId: ownerId })).node;
    const child = owner?.frameId ? session.frames.get(owner.frameId) : undefined;
    if (!child?.sessionId) return { debuggee: session.debuggee, spec };
    return { debuggee: child, spec: { ...spec, queries: spec.queries.slice(frameIndex + 1) } };
  }

  private async resolveDirect(debuggee: Debuggee, spec: LocatorSpec): Promise<string> {
    while (true) {
      throwIfAborted(this.context.signal);
      const matches = await this.evaluateIn(debuggee, `(${RESOLVER_SOURCE})(${JSON.stringify(spec)}, true)`) as any[];
      if (matches.length > 1) throw new Error(`AutomationError[strict-mode]: frame locator matched ${matches.length} elements: ${JSON.stringify(matches.slice(0, 10))}`);
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

  private async elementState(session: Session, objectId: string): Promise<any> {
    return this.callOn(session, objectId, `async function(){
      this.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      const first = this.getBoundingClientRect(); await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); const rect = this.getBoundingClientRect();
      const style = getComputedStyle(this); const x = rect.left + rect.width / 2; const y = rect.top + rect.height / 2;
      const guard = document.getElementById("__surf-wax-page-guard"); const pointerEvents = guard?.style.getPropertyValue("pointer-events"); const pointerPriority = guard?.style.getPropertyPriority("pointer-events");
      if (guard) guard.style.setProperty("pointer-events", "none", "important");
      const hit = document.elementFromPoint(x, y);
      if (guard) guard.style.setProperty("pointer-events", pointerEvents || "auto", pointerPriority || "important");
      return { x, y, visible: rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none", stable: first.x === rect.x && first.y === rect.y && first.width === rect.width && first.height === rect.height, enabled: !this.disabled && this.getAttribute("aria-disabled") !== "true", editable: !this.readOnly && this.getAttribute("aria-readonly") !== "true", receivesEvents: Boolean(hit && (hit === this || this.contains(hit))), checked: Boolean(this.checked) };
    }`);
  }

  private async waitActionable(session: Session, objectId: string, editable: boolean, pointer: boolean): Promise<any> {
    while (true) {
      throwIfAborted(this.context.signal);
      const state = await this.elementState(session, objectId);
      if (state.visible && state.stable && state.enabled && (!editable || state.editable) && (!pointer || state.receivesEvents)) return state;
      await delay(50, this.context.signal);
    }
  }

  private async pointer(session: Session, objectId: string, operation: string): Promise<void> {
    const state = await this.waitActionable(session, objectId, false, true);
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
    await this.options.command(session.debuggee, "Input.dispatchKeyEvent", { type: "keyDown", key, code: key, modifiers });
    await this.options.command(session.debuggee, "Input.dispatchKeyEvent", { type: "keyUp", key, code: key, modifiers });
  }

  private async waitForReady(session: Session): Promise<void> {
    while (true) {
      throwIfAborted(this.context.signal);
      try { if (await this.pageValue(session.tabId, "document.readyState !== 'loading'")) return; } catch { /* Navigation swaps the context. */ }
      await delay(50, this.context.signal);
    }
  }

  private async settle(session: Session): Promise<void> {
    try { await this.pageValue(session.tabId, `new Promise(resolve => { let version=0,last=-1,quiet=0; const observer=new MutationObserver(()=>version++); observer.observe(document,{subtree:true,childList:true,attributes:true,characterData:true}); const tick=()=>requestAnimationFrame(()=>{quiet=version===last?quiet+1:0;last=version;if(quiet>=2){observer.disconnect();resolve(true);}else tick();});tick();})`); }
    catch { await this.waitForReady(session); }
  }

  private async captureSnapshot(session: Session): Promise<{ url: string; title: string; lines: string[] }> {
    const debuggees = [session.debuggee, ...new Map([...session.frames.values()].filter((debuggee) => debuggee.sessionId).map((debuggee) => [debuggee.sessionId!, debuggee])).values()];
    const [trees, info] = await Promise.all([
      Promise.all(debuggees.map(async (debuggee) => ({ debuggee, tree: await this.options.command(debuggee, "Accessibility.getFullAXTree", {}) }))),
      this.pageValue(session.tabId, "({url:location.href,title:document.title})") as Promise<{ url: string; title: string }>,
    ]);
    const lines: string[] = [];
    const render = (nodes: any[], debuggee: Debuggee, frameLabel?: string) => {
      const byId = new Map(nodes.map((node) => [node.nodeId, node]));
      if (frameLabel) lines.push(`- iframe [frame=${frameLabel}]`);
      const visit = (node: any, depth: number) => {
      if (!node || node.ignored) { for (const child of node?.childIds ?? []) visit(byId.get(child), depth); return; }
      const role = axValue(node.role); const name = axValue(node.name); const value = axValue(node.value);
      if (role && role !== "none" && role !== "generic" && role !== "InlineTextBox") {
        let ref = "";
        if (node.backendDOMNodeId && (INTERACTIVE_ROLES.has(role) || node.properties?.some((property: any) => property.name === "focusable" && property.value?.value))) {
          const key = `${node.frameId ?? "root"}:${node.backendDOMNodeId}`;
          ref = session.refsByNode.get(key) ?? `e${session.nextRef++}`;
          session.refsByNode.set(key, ref);
          session.refs.set(ref, { backendNodeId: node.backendDOMNodeId, frameId: node.frameId, debuggee, role, name, generation: session.generation });
        }
        const properties = Object.fromEntries((node.properties ?? []).map((property: any) => [property.name, property.value?.value]));
        const state = ["checked", "disabled", "expanded", "pressed", "selected", "required", "readonly"].filter((key) => properties[key] !== undefined).map((key) => `${key}=${properties[key]}`).join(" ");
        lines.push(`${"  ".repeat(depth)}- ${role}${name ? ` ${quote(name)}` : ""}${ref ? ` [ref=${ref}]` : ""}${state ? ` [${state}]` : ""}${value && value !== name ? `: ${value}` : ""}`);
        depth += 1;
      }
      for (const child of node.childIds ?? []) visit(byId.get(child), depth);
      };
      const root = nodes.find((node) => !node.parentId) ?? nodes[0];
      visit(root, frameLabel ? 1 : 0);
    };
    for (const { debuggee, tree } of trees) render(tree.nodes ?? [], debuggee, debuggee.sessionId);
    return { ...info, lines };
  }

  private async afterAction(session: Session): Promise<Record<string, unknown>> {
    await this.settle(session);
    const captured = await this.captureSnapshot(session);
    const previous = session.lastSnapshot;
    session.lastSnapshot = captured.lines;
    if (!previous) return { url: captured.url, title: captured.title, snapshot: captured.lines.join("\n") };
    const before = new Set(previous); const after = new Set(captured.lines);
    return { url: captured.url, title: captured.title, changes: { added: captured.lines.filter((line) => !before.has(line)), removed: previous.filter((line) => !after.has(line)) } };
  }

  private async action<T>(tabId: number, operation: string, locator: LocatorSpec | null, run: () => Promise<T>): Promise<T> {
    const startedAt = performance.now();
    this.options.logger?.record({ type: "automation.action.started", conversationId: this.context.conversationId, toolCallId: this.context.toolCallId, content: { tabId, operation, locator } });
    try {
      const result = await run();
      this.options.logger?.record({ type: "automation.action.finished", conversationId: this.context.conversationId, toolCallId: this.context.toolCallId, content: { tabId, operation, locator }, output: result, latencyMs: performance.now() - startedAt });
      return result;
    } catch (error) {
      this.options.logger?.record({ type: "automation.action.failed", conversationId: this.context.conversationId, toolCallId: this.context.toolCallId, content: { tabId, operation, locator }, error, latencyMs: performance.now() - startedAt });
      throw error;
    }
  }
}

export class PageFacade {
  constructor(private readonly runtime: AutomationRuntime, readonly tabId: number) {}
  snapshot() { return this.runtime.snapshot(this.tabId); }
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
  waitForLoadState() { return this.runtime.waitUntil(() => this.runtime.pageValue(this.tabId, "document.readyState !== 'loading'") as Promise<boolean>); }
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
  waitFor() { return this.run("waitFor"); }
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
