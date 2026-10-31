import { afterEach, describe, expect, it, vi } from "vitest";
import { EventLogger, fromLogValue, type LogEvent } from "../logging";
import { ChromeExecutor } from "./executor";
import { LocatorFacade } from "./automation";
import { ProgramScope } from "./program";
import { DeferredProgramPage, PROGRAM_EVENT_INVOKE, ProgramHandles } from "./program-handles";
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function fakeChrome(responses: Array<object | (() => Promise<object>)> = []) {
  const stored: Record<string, unknown> = {};
  const calls: string[] = [];
  const debuggerApi = {
    getTargets: vi.fn(async () => [{ id: "target-1", type: "page", title: "Surf Wax", url: "chrome-extension://id/sidepanel.html#test", attached: false }]),
    attach: vi.fn(async (_debuggee: unknown, _version: string) => { calls.push("attach"); }),
    detach: vi.fn(async (_debuggee: unknown) => { calls.push("detach"); }),
    sendCommand: vi.fn(async (_debuggee: unknown, _method: string, _params?: { expression?: string }) => {
      calls.push("evaluate");
      const next = responses.shift() ?? { result: { value: null } };
      return typeof next === "function" ? next() : next;
    }),
  };
  const chromeApi = {
    debugger: debuggerApi,
    storage: { local: {
      async get(keys: string | string[]) {
        const list = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(list.map((key) => [key, stored[key]]));
      },
      async set(items: Record<string, unknown>) { Object.assign(stored, items); },
    } },
    userScripts: {
      getScripts: vi.fn(async () => []),
      register: vi.fn(async () => undefined),
      unregister: vi.fn(async () => undefined),
    },
    downloads: { download: vi.fn(async () => 17) },
  };
  return { calls, debuggerApi, chromeApi };
}

function fakePort(onPost: (message: { id: string; method: string }, reply: (message: object) => void, drop: () => void) => void = (message, reply) => reply({ id: message.id })) {
  let receive!: (message: object) => void;
  let disconnected!: () => void;
  const drop = () => disconnected();
  const port = {
    onMessage: { addListener: vi.fn((listener) => { receive = listener; }) },
    onDisconnect: { addListener: vi.fn((listener) => { disconnected = listener; }) },
    postMessage: vi.fn((message: { id: string; method: string }) => onPost(message, receive, drop)),
    disconnect: vi.fn(drop),
  };
  return { port, drop };
}

function memoryLog() {
  const events: LogEvent[] = [];
  const logger = new EventLogger({ store: {
    async append(event) { const stored = { ...event, id: events.length + 1 }; events.push(stored); return stored; },
    async all() { return [...events]; }, async clear() { events.length = 0; },
  } });
  return { logger, events };
}
function programHarness(work: (capabilities: any, signal: AbortSignal) => Promise<unknown>, fake = fakeChrome(), lazy = false) {
  const log = memoryLog();
  let runIdentity: { runId: string; ownerId: string; generation: number } | undefined = { runId: "run", ownerId: "owner", generation: 1 };
  const tabs = [{ id: 41, windowId: 7, active: true, title: "Current" }, { id: 42, windowId: 7, active: false }, { id: 99, windowId: 9 }] as chrome.tabs.Tab[];
  const sessions = new Map<number, object>();
  const listeners = new Set<(tabId: number) => void>();
  const onRemoved = { addListener: vi.fn((listener: (tabId: number) => void) => listeners.add(listener)), removeListener: vi.fn((listener: (tabId: number) => void) => listeners.delete(listener)), emit: (id: number) => { sessions.delete(id); for (const listener of listeners) listener(id); } };
  Object.assign(fake.chromeApi, {
    windows: { getCurrent: vi.fn(async () => ({ id: 7, tabs })), get: vi.fn(async () => ({ id: 7 })), update: vi.fn(), create: vi.fn(), remove: vi.fn() },
    tabs: { get: vi.fn(async (id: number) => tabs.find(tab => tab.id === id)), query: vi.fn(async () => tabs,
      ),
      update: vi.fn(async (id: number) => { tabs.forEach(tab => { tab.active = tab.id === id; }); }),
      create: vi.fn(async (input: any) => { const tab = { id: 43, ...input }; tabs.push(tab); return tab; }),
      remove: vi.fn(async (id: number) => { const index = tabs.findIndex(tab => tab.id === id); if (index >= 0) tabs.splice(index, 1); onRemoved.emit(id); }), onRemoved,
    },
  });
  const executor = new ChromeExecutor({ chromeApi: fake.chromeApi as never, logger: log.logger, runIdentity: () => runIdentity, programHost: async (_code, caps, signal) => {
    if (!lazy && caps.page instanceof DeferredProgramPage) caps = { ...caps, page: await caps.page.bind() };
    return work(caps, signal);
  } });
  const raw: any = {
    tabId: 41, inspect: vi.fn(async () => ({ snapshot: "Current [ref=t41d1e1]" })),
    url: vi.fn(async () => "https://example.com"), title: vi.fn(async () => "Current"),
    observe: vi.fn(async () => ({ observationId: "capture", documentId: 1, url: "https://example.com", title: "Current", viewport: {}, screenshot: { data: "eA==", width: 1, height: 1, scale: 1, origin: { x: 0, y: 0 } } })),
    goto: vi.fn(async (url: string) => { await (executor as any).programScope.dispatched(); return { performed: true, url }; }),
    evaluate: vi.fn(async () => { await (executor as any).programScope.dispatched(); return 42; }),
  };
  (executor as any).pageFor = vi.fn(async (state: any) => ({ ...raw, tabId: state.tabId }));
  (executor as any).automation.sessionIdentity = (id: number) => { if (!tabs.some(tab => tab.id === id)) return undefined; if (!sessions.has(id)) sessions.set(id, {}); return sessions.get(id); };
  return { ...log, fake, tabs, raw, executor, sessions, onRemoved, listeners, setRunIdentity: (value: typeof runIdentity) => { runIdentity = value; }, run: (signal?: AbortSignal, input: { timeoutMs?: number; background?: boolean } = {}) => executor.runProgram({ code: "fixture program", ...input }, signal, { conversationId: "conversation", visualEnabled: true, ...(input.background ? { logIdentity: { runId: "run", toolCallId: "1:program", toolCallIdCanonical: true as const } } : {}) }) };
}

describe("ChromeExecutor programs", () => {
  it("runs page-independent operations without a bound tab or a live bound window", async () => {
    let action: "artifact" | "open" | "page" = "artifact";
    const h = programHarness(async ({ page, browser, artifacts }) => {
      if (action === "artifact") return artifacts.text("report.txt", "data", "text/plain");
      if (action === "open") return browser.tabs.open("https://example.com");
      return page.bind();
    }, fakeChrome(), true);
    (h.executor as any).browserState = { windowId: 7, tabId: undefined };
    (h.fake.chromeApi as any).windows.get.mockRejectedValue(new Error("window closed"));
    expect(await h.run()).toMatchObject({ ok: true, result: { filename: "report.txt" } });
    expect((h.executor as any).pageFor).not.toHaveBeenCalled();
    action = "open";
    expect(await h.run()).toMatchObject({ ok: false, result: { error: { code: "window-closed" } } });
    expect((h.fake.chromeApi as any).tabs.create).not.toHaveBeenCalled();
    action = "page";
    expect(await h.run()).toMatchObject({ ok: false, result: { error: { code: "no-bound-tab" } } });
    h.executor.dispose();
  });
  it("reuses each live page within a program, including concurrent requests, but not across programs", async () => {
    let previous: unknown;
    const h = programHarness(async ({ page, browser }) => {
      expect(await browser.page(41)).toBe(page);
      const concurrent = await Promise.all(Array.from({ length: 30 }, () => browser.page(42)));
      expect(concurrent.every(value => value === concurrent[0])).toBe(true);
      for (let i = 0; i < 30; i++) expect(await browser.page(42)).toBe(concurrent[0]);
      if (previous) expect(concurrent[0]).not.toBe(previous);
      previous = concurrent[0];
      return true;
    });
    expect(await h.run()).toMatchObject({ ok: true, result: true });
    expect(await h.run()).toMatchObject({ ok: true, result: true });
    expect((h.executor as any).pageFor.mock.calls.map(([state]: any[]) => state.tabId)).toEqual([41, 42, 41, 42]);
    expect(h.listeners.size).toBe(0);
    h.executor.dispose();
  });

  it("rejects page and locator handles after a session changes", async () => {
    const h = programHarness(async ({ browser }) => {
      const old = await browser.page(42);
      const locator = old.locator("button");
      const url = old.url;
      const handles = new ProgramHandles();
      const oldId = handles.remember(old, 42);
      const locatorId = handles.remember(locator, 42);
      h.sessions.set(42, {});
      await expect(url()).rejects.toThrow("stale-page");
      await expect(locator.count()).rejects.toThrow("stale-page");
      expect(() => handles.remember(old, 42)).toThrow("stale-page");
      expect(() => handles.remember(locator, 42)).toThrow("stale-page");
      const fresh = await browser.page(42);
      expect(fresh).not.toBe(old);
      const freshId = handles.remember(fresh, 42);
      expect(() => handles.resolve(oldId)).toThrow("stale-page");
      expect(() => handles.resolve(locatorId)).toThrow("stale-page");
      expect(handles.resolve(freshId)).toBe(fresh);
      expect(await fresh.url()).toBe("https://example.com");
      return true;
    });
    h.raw.locator = () => new LocatorFacade((h.executor as any).automation, 42, { queries: [{ kind: "css", value: "button" }] });
    expect(await h.run()).toMatchObject({ ok: true, result: true });
    h.executor.dispose();
  });

  it("invalidates a removed tab and never reuses its old handle for a replacement", async () => {
    const h = programHarness(async ({ browser }) => {
      const old = await browser.page(42);
      h.tabs.splice(h.tabs.findIndex(tab => tab.id === 42), 1);
      // The Chrome removal event may arrive after the tab is already gone.
      await expect(browser.page(42)).rejects.toThrow("invalid-tab-id");
      await expect(old.url()).rejects.toThrow("stale-page");
      h.onRemoved.emit(42);
      h.tabs.push({ id: 42, windowId: 7 } as chrome.tabs.Tab);
      const fresh = await browser.page(42);
      expect(fresh).not.toBe(old);
      await expect(old.url()).rejects.toThrow("stale-page");
      return true;
    });
    expect(await h.run()).toMatchObject({ ok: true, result: true });
    h.executor.dispose();
  });

  it("rejects an acquisition if the tab closes while its page is binding", async () => {
    let start!: () => void; let release!: () => void;
    const started = new Promise<void>(resolve => { start = resolve; });
    const hold = new Promise<void>(resolve => { release = resolve; });
    const h = programHarness(async ({ browser }) => {
      const pending = browser.page(42);
      await started;
      h.onRemoved.emit(42);
      release();
      await expect(pending).rejects.toThrow("stale-page");
      const fresh = await browser.page(42);
      expect(await fresh.url()).toBe("https://example.com");
      return true;
    });
    const original = (h.executor as any).pageFor;
    let blocked = false;
    (h.executor as any).pageFor = vi.fn(async (state: any) => {
      if (state.tabId === 42 && !blocked) { blocked = true; start(); await hold; }
      return original(state);
    });
    expect(await h.run()).toMatchObject({ ok: true, result: true });
    h.executor.dispose();
  });

  it.each(["navigation", "redirect"] as const)("rejects a response body if %s invalidates its request while CDP is in flight", async (change) => {
    const h = programHarness(async () => undefined);
    const diagnostics = (h.executor as any).diagnostics;
    diagnostics.bind({ conversationId: "conversation" });
    const first = { requestId: "same", request: { method: "GET", url: "https://old.test/", headers: {} }, type: "Fetch" };
    diagnostics.handle({ tabId: 41 }, "Network.requestWillBeSent", first);
    const [entry] = (await diagnostics.requests(41, {}) as any).requests;
    let release!: (value: unknown) => void; let notify!: () => void;
    const started = new Promise<void>((resolve) => { notify = resolve; });
    (h.executor as any).bridgeCommand = vi.fn((_source: unknown, method: string) => method === "Network.getResponseBody"
      ? new Promise((resolve) => { release = resolve; notify(); }) : Promise.resolve({}));
    const pending = (h.executor as any).readRequest(41, entry.requestRef, true);
    await started;
    if (change === "navigation") diagnostics.handle({ tabId: 41 }, "Page.frameNavigated", { frame: { id: "root" } });
    else diagnostics.handle({ tabId: 41 }, "Network.requestWillBeSent", { ...first, request: { ...first.request, url: "https://new.test/" }, redirectResponse: { status: 302 } });
    release({ body: "old-or-new", base64Encoded: false });
    await expect(pending).rejects.toMatchObject({ code: "stale-request" });
    h.executor.dispose();
  });

  it("rejects an in-flight response when its originating child session detaches", async () => {
    const h = programHarness(async () => undefined);
    const diagnostics = (h.executor as any).diagnostics;
    diagnostics.bind({ conversationId: "conversation" });
    diagnostics.handle({ tabId: 41, sessionId: "child" }, "Network.requestWillBeSent", { requestId: "same", request: { method: "GET", url: "https://frame.test/", headers: {} }, type: "Fetch" });
    const [entry] = (await diagnostics.requests(41, {}) as any).requests;
    let release!: (value: unknown) => void; let notify!: () => void;
    const started = new Promise<void>((resolve) => { notify = resolve; });
    (h.executor as any).automation.observationDebuggees = vi.fn(async () => [{ tabId: 41 }, { tabId: 41, sessionId: "child" }]);
    (h.executor as any).bridgeCommand = vi.fn((_source: unknown, method: string) => method === "Network.getResponseBody"
      ? new Promise((resolve) => { release = resolve; notify(); }) : Promise.resolve({}));
    const pending = (h.executor as any).readRequest(41, entry.requestRef, true);
    await started;
    diagnostics.handle({ tabId: 41 }, "Target.detachedFromTarget", { sessionId: "child" });
    release({ body: "stale", base64Encoded: false });
    await expect(pending).rejects.toMatchObject({ code: "stale-request" });
    h.executor.dispose();
  });

  it("awaits foreground completion without rescanning the job log for every progress receipt", async () => {
    const h = programHarness(async ({ emit }) => {
      for (let index = 0; index < 50; index++) await emit(index);
      return "finished";
    });
    const reads = vi.spyOn(h.logger, "jobEvents");
    expect(await h.run()).toMatchObject({ ok: true, state: "succeeded", result: "finished" });
    expect(reads.mock.calls.length).toBeLessThanOrEqual(3);
    const binding = h.events.find((event) => event.type === "browser.job.progress" && (fromLogValue(event.content) as any)?.operation === "page.bind" && (fromLogValue(event.content) as any)?.state === "completed");
    expect(fromLogValue(binding?.output)).toEqual({ tabId: 41 });
    h.executor.dispose();
  });
  it.each(["screenshot", "pdf"] as const)("saves %s after durable capture through the program facade", async (name) => {
    const h = programHarness(async ({ page }) => name === "screenshot" ? page.screenshot({ filename: "capture.png", save: true }) : page.pdf({ filename: "capture.pdf", save: true }));
    h.fake.debuggerApi.sendCommand.mockImplementation(async (_debuggee, method) => method === "Page.printToPDF" ? { data: "eA==" } : {});
    h.fake.chromeApi.downloads.download.mockImplementationOnce(async () => {
      expect(h.events.filter(event => event.type === "tool.result.data")).toHaveLength(1); return 17;
    });
    expect(await h.run()).toMatchObject({ ok: true, state: "succeeded", result: { artifact: { saved: true, downloadId: 17 } } });
    expect(h.fake.chromeApi.downloads.download).toHaveBeenCalledTimes(1); h.executor.dispose();
  });
  it("retains a failed-download artifact and explicitly saves the existing bytes without recapturing", async () => {
    let retry = false; let id = 0;
    const h = programHarness(async ({ page, artifacts }) => retry ? artifacts.save(id) : page.screenshot({ filename: "retained.png", save: true }));
    h.fake.chromeApi.downloads.download.mockRejectedValueOnce(new Error("Download failed"));
    expect(await h.run()).toMatchObject({ ok: false, result: { error: { message: "Download failed" } } });
    const artifact = h.events.find(event => event.type === "tool.result.data")!; id = artifact.id; retry = true;
    expect(await h.run()).toMatchObject({ ok: true, result: { artifact: { id, filename: "retained.png", saved: true, downloadId: 17 } } });
    expect(h.events.filter(event => event.type === "tool.result.data")).toHaveLength(1);
    expect(h.raw.observe).toHaveBeenCalledTimes(1); expect(h.fake.chromeApi.downloads.download).toHaveBeenCalledTimes(2); h.executor.dispose();
  });
  it.each(["screenshot", "pdf"] as const)("honors an explicit timeout while saving %s", async (name) => {
    vi.useFakeTimers();
    const h = programHarness(async ({ page }) => name === "screenshot" ? page.screenshot({ save: true }) : page.pdf({ save: true }));
    h.fake.debuggerApi.sendCommand.mockImplementation(async (_debuggee, method) => method === "Page.printToPDF" ? { data: "eA==" } : {});
    let finish!: () => void;
    h.fake.chromeApi.downloads.download.mockImplementationOnce(() => new Promise<number>(resolve => { finish = () => resolve(17); }));
    const pending = h.run(undefined, { timeoutMs: 10_000 });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    await vi.advanceTimersByTimeAsync(10000);
    expect(await pending).toMatchObject({ ok: false, result: { error: { code: "timeout", effectUnknown: true } } });
    finish(); await (h.executor as any).tail; h.executor.dispose();
    await vi.advanceTimersByTimeAsync(1); expect(vi.getTimerCount()).toBe(0);
  });
  it("selects a stable tab without focusing or creating a Chrome window", async () => {
    const h = programHarness(async ({ browser }) => browser.tabs.select(42));
    expect(await h.run()).toMatchObject({ ok: true, result: [{ id: 41, current: false }, { id: 42, current: true }, { id: 99, current: false }] });
    expect((h.fake.chromeApi as any).tabs.update).toHaveBeenCalledWith(42, { active: true });
    expect((h.fake.chromeApi as any).windows.update).not.toHaveBeenCalled(); h.executor.dispose();
  });
  it("keeps the bound tab when closing another, and clears it when closing the bound tab", async () => {
    let target = 42;
    const h = programHarness(async ({ browser }) => browser.tabs.close(target));
    expect(await h.run()).toMatchObject({ ok: true });
    expect((h.executor as any).browserState.tabId).toBe(41);
    target = 41;
    expect(await h.run()).toMatchObject({ ok: true });
    expect((h.executor as any).browserState.tabId).toBeUndefined();
    expect(await h.executor.listTabs()).toEqual([expect.objectContaining({ id: 99, current: false })]);
    await h.executor.switchTab(99);
    expect((h.executor as any).browserState).toEqual({ windowId: 9, tabId: 99 });
    h.executor.dispose();
  });
  it("lists tabs and explicitly recovers after an externally closed binding or window", async () => {
    const fake = fakeChrome();
    const tabs = [{ id: 41, windowId: 7, active: true }, { id: 99, windowId: 9, active: true }] as chrome.tabs.Tab[];
    Object.assign(fake.chromeApi, {
      windows: { getCurrent: vi.fn(async () => ({ id: 7, tabs: [tabs[0]] })), get: vi.fn(async () => { throw new Error("window closed"); }) },
      tabs: { query: vi.fn(async () => tabs), get: vi.fn(async (id: number) => tabs.find(tab => tab.id === id)), update: vi.fn(async () => undefined) },
    });
    const executor = new ChromeExecutor({ chromeApi: fake.chromeApi as never });
    (executor as any).browserState = { windowId: 7, tabId: 41 };
    tabs.shift();
    await expect(executor.listTabs()).resolves.toEqual([expect.objectContaining({ id: 99, current: false })]);
    await expect(executor.browserContext()).resolves.toMatchObject({ windowId: 7, tabs: [{ tabId: 99, current: false }] });
    expect((executor as any).browserState).toEqual({ windowId: 7, tabId: 41 });
    await expect((executor as any).pageFor((executor as any).browserState)).rejects.toThrow("bound-tab-closed");
    await expect(executor.switchTab(99)).resolves.toEqual([expect.objectContaining({ id: 99, current: true })]);
    expect((executor as any).browserState).toEqual({ windowId: 9, tabId: 99 });
    expect((fake.chromeApi as any).tabs.update).toHaveBeenCalledWith(99, { active: true });
    executor.dispose();
  });
  it("does not change binding when switch is cancelled while tab discovery is pending", async () => {
    const fake = fakeChrome();
    let complete!: (tabs: chrome.tabs.Tab[]) => void;
    Object.assign(fake.chromeApi, { tabs: { query: vi.fn(() => new Promise(resolve => { complete = resolve; })), update: vi.fn() } });
    const executor = new ChromeExecutor({ chromeApi: fake.chromeApi as never });
    (executor as any).browserState = { windowId: 7, tabId: 41 };
    const controller = new AbortController();
    const pending = executor.switchTab(99, controller.signal);
    await vi.waitFor(() => expect(complete).toBeTypeOf("function"));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    complete([{ id: 99, windowId: 9 } as chrome.tabs.Tab]);
    await (executor as any).tail;
    expect((fake.chromeApi as any).tabs.update).not.toHaveBeenCalled();
    expect((executor as any).browserState).toEqual({ windowId: 7, tabId: 41 });
    executor.dispose();
  });
  it("reports cancellation promptly while delayed tab creation settles, keeping the binding for recovery", async () => {
    let finish!: (tab: chrome.tabs.Tab) => void;
    const h = programHarness(async ({ browser }, signal) => { if (signal.aborted) signal.throwIfAborted(); return browser.tabs.open("https://example.com/next"); });
    (h.fake.chromeApi as any).tabs.create.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const controller = new AbortController(); const pending = h.run(controller.signal);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function")); controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect((h.fake.chromeApi as any).windows.getCurrent).toHaveBeenCalledTimes(1);
    const tab = { id: 43, windowId: 7, active: true } as chrome.tabs.Tab; h.tabs.push(tab); finish(tab);
    await (h.executor as any).tail;
    expect((h.executor as any).browserState).toMatchObject({ windowId: 7, tabId: 41 });
    await h.executor.endRun(); expect((h.executor as any).browserState).toBeUndefined(); h.executor.dispose();
  });
  it("selects IDs across windows after reorder, rejects missing tabs, and exposes no legacy routing methods", async () => {
    let tabId = 41; const h = programHarness(async ({ browser }) => browser.tabs.select(tabId));
    h.tabs.reverse(); expect(await h.run()).toMatchObject({ ok: true });
    expect((h.fake.chromeApi as any).tabs.update).toHaveBeenCalledWith(41, { active: true });
    tabId = 99; expect(await h.run()).toMatchObject({ ok: true });
    tabId = 999; expect(await h.run()).toMatchObject({ ok: false, result: { error: { message: expect.stringContaining("invalid-tab-id") } } });
    for (const name of ["execute", "executeCommand", "executeBrowser", "executePage", "executeCommandNow", "runPageCode"]) expect(h.executor).not.toHaveProperty(name);
    expect(h.fake.debuggerApi.getTargets).not.toHaveBeenCalled(); h.executor.dispose();
  });
  it("preserves completed receipts when cancellation interrupts a later operation and prevents later effects", async () => {
    const third = vi.fn(); const controller = new AbortController(); let second!: () => void;
    const h = programHarness(async ({ page }) => { await page.goto("https://test/1"); await page.evaluate("pending"); third(); });
    h.raw.evaluate.mockImplementationOnce(async () => { await (h.executor as any).programScope.dispatched(); await new Promise<void>(resolve => { second = resolve; }); controller.signal.throwIfAborted(); });
    const pending = h.run(controller.signal); await vi.waitFor(() => expect(second).toBeTypeOf("function")); controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" }); second(); await (h.executor as any).tail;
    expect(h.events.map(event => fromLogValue(event.content))).toContainEqual(expect.objectContaining({ operation: "page.goto", state: "completed" }));
    expect(h.events.map(event => fromLogValue(event.content))).toContainEqual(expect.objectContaining({ operation: "page.evaluate", state: "dispatched-unknown" }));
    expect(third).not.toHaveBeenCalled(); h.executor.dispose();
  });
  it("durably saves completed progress with frozen tool identity before the next mutation", async () => {
    const events: any[] = []; let release!: () => void;
    const append = vi.fn(async (event: any) => { events.push(event); if (event.content.operation === "first" && event.content.state === "completed") await new Promise<void>(resolve => { release = resolve; }); return { id: events.length }; });
    const scope = new ProgramScope(new AbortController().signal, "job", { conversationId: "conversation", logIdentity: { runId: "run", toolCallId: "1:batch", toolCallIdCanonical: true } }, { append } as unknown as EventLogger);
    const first = vi.fn(async () => { await scope.dispatched(); return { performed: true }; }); const second = vi.fn();
    const pending = Promise.all([scope.call("first", first), scope.call("second", second)]);
    await vi.waitFor(() => expect(release).toBeTypeOf("function")); expect(second).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({ type: "browser.job.progress", runId: "run", toolCallId: "1:batch", toolCallIdCanonical: true, content: { operation: "first", state: "completed" }, output: { performed: true } });
    release(); await pending; expect(first).toHaveBeenCalledTimes(1); expect(second).toHaveBeenCalledTimes(1); scope.revoke();
  });
  it("does not dispatch another program operation when maintenance refuses its receipt", async () => {
    const append = vi.fn(async () => undefined); const effect = vi.fn();
    const scope = new ProgramScope(new AbortController().signal, "job", { conversationId: "conversation" }, { append } as unknown as EventLogger);
    await expect(scope.call("first", effect)).rejects.toMatchObject({ name: "AbortError" });
    expect(effect).not.toHaveBeenCalled(); scope.revoke();
    expect(() => scope.call("second", effect)).toThrow("expired"); expect(effect).not.toHaveBeenCalled();
  });
  it("navigates and creates new tabs only in the bound window", async () => {
    const h = programHarness(async ({ page, browser }) => { await page.goto("https://example.com/after"); const next = await browser.tabs.open("https://example.com/new"); return next.tabId; });
    expect(await h.run()).toMatchObject({ ok: true, result: 43 }); expect(h.raw.goto).toHaveBeenCalledWith("https://example.com/after");
    expect((h.fake.chromeApi as any).tabs.create).toHaveBeenCalledWith({ windowId: 7, active: true, url: "https://example.com/new" });
    expect((h.fake.chromeApi as any).windows.create).not.toHaveBeenCalled(); expect((h.fake.chromeApi as any).windows.remove).not.toHaveBeenCalled(); h.executor.dispose();
  });
  it("returns by-value program results without discovering or evaluating the Side Panel target", async () => {
    const h = programHarness(async ({ page, browser }) => ({ title: await page.title(), tabs: (await browser.tabs.list()).length }));
    expect(await h.run()).toMatchObject({ ok: true, result: { title: "Current", tabs: 3 } });
    expect(h.fake.debuggerApi.getTargets).not.toHaveBeenCalled(); expect(h.fake.debuggerApi.sendCommand).not.toHaveBeenCalled();
    expect((globalThis as any).__surfWaxBrowser).toBeUndefined(); expect((globalThis as any).__surfWaxPage).toBeUndefined(); expect((globalThis as any).__surfWaxResult).toBeUndefined(); h.executor.dispose();
  });
  it("composes page methods through the bound program capabilities", async () => {
    const h = programHarness(async ({ page }) => { await page.goto("https://example.com"); return await page.inspect(); });
    expect(await h.run()).toMatchObject({ ok: true, result: { snapshot: "Current [ref=t41d1e1]" } });
    expect(h.events.map(event => fromLogValue(event.content))).toContainEqual(expect.objectContaining({ operation: "page.goto", state: "completed" })); h.executor.dispose();
  });
  it("runs explicit MAIN code through the existing page session without a fallback host", async () => {
    const h = programHarness(async ({ browser }) => browser.runIn({ kind: "page", tabId: 41, world: "MAIN" }, "return document.title"));
    const pageValue = vi.fn(async () => ({ kind: "value", value: "Automation Target" })); (h.executor as any).automation.pageValue = pageValue;
    expect(await h.run()).toMatchObject({ ok: true, result: "Automation Target" });
    expect(pageValue).toHaveBeenCalledWith(41, expect.stringContaining("return document.title")); expect(h.fake.debuggerApi.getTargets).not.toHaveBeenCalled(); h.executor.dispose();
  });
  it("returns a page timeout with unknown effects and cleans the pending evaluation", async () => {
    const h = programHarness(async ({ browser }) => browser.runIn({ kind: "page", tabId: 41, world: "MAIN" }, "await new Promise(() => {})"));
    (h.executor as any).automation.pageValue = () => new Promise(() => undefined);
    expect(await h.run(undefined, { timeoutMs: 5 })).toMatchObject({ ok: false, result: { error: { code: "timeout", effectUnknown: true } } }); h.executor.dispose();
  });
  it("serializes whole programs through one queue", async () => {
    let finish!: () => void; const order: string[] = []; let index = 0;
    const h = programHarness(async () => { const n = ++index; order.push(`start${n}`); if (n === 1) await new Promise<void>(resolve => { finish = resolve; }); order.push(`end${n}`); return n; });
    const first = h.run(); const second = h.run(); await vi.waitFor(() => expect(finish).toBeTypeOf("function")); expect(order).toEqual(["start1"]);
    finish(); expect(await first).toMatchObject({ ok: true, result: 1 }); expect(await second).toMatchObject({ ok: true, result: 2 }); expect(order).toEqual(["start1", "end1", "start2", "end2"]); h.executor.dispose();
  });
  it("propagates native page exceptions and keeps document-scoped object references", async () => {
    const h = programHarness(async ({ browser }) => browser.runIn({ kind: "page", tabId: 41, world: "MAIN" }, "return 1n"));
    const pageValue = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce({ kind: "reference", id: "ref-1", type: "bigint", preview: "1" }); (h.executor as any).automation.pageValue = pageValue;
    expect(await h.run()).toMatchObject({ ok: false, result: { error: { message: "boom" } } });
    expect(await h.run()).toMatchObject({ ok: true, result: { $ref: "ref-1", access: 'globalThis.__surfWaxObject("ref-1")', scope: "page", host: "page" } });
    expect(pageValue).toHaveBeenCalledTimes(2); h.executor.dispose();
  });
  it("keeps MAIN and USER_SCRIPT execution explicit, including native frame/document ownership", async () => {
    let world = "MAIN";
    const h = programHarness(async ({ browser }) => browser.runIn({ kind: "page", tabId: 41, world, ...(world === "USER_SCRIPT" ? { documentId: "doc" } : {}) }, "return document.title"));
    (h.executor as any).automation.pageValue = vi.fn(async () => ({ kind: "value", value: "CDP" }));
    const execute = vi.fn(async () => [{ documentId: "doc", frameId: 0, result: { kind: "value", value: "USER" } }]); (h.fake.chromeApi.userScripts as any).execute = execute;
    expect(await h.run()).toMatchObject({ ok: true, result: "CDP" }); world = "USER_SCRIPT"; expect(await h.run()).toMatchObject({ ok: true, result: "USER" });
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ target: { tabId: 41, documentIds: ["doc"] }, world: "USER_SCRIPT", injectImmediately: true })); h.executor.dispose();
  });
  it("reads historical canonical result slices without an execution context and rejects other conversations", async () => {
    let foreign = false; let id = 0;
    const h = programHarness(async ({ artifacts }) => artifacts.read(id, { path: ["observation", "snapshot"], offset: 1, limit: 3 }));
    id = (await h.logger.append({ type: "tool.result.data", conversationId: "conversation", output: { observation: { snapshot: "abcdef" } } }))!.id;
    expect(await h.run()).toMatchObject({ ok: true, result: "bcd" }); foreign = true;
    id = (await h.logger.append({ type: "tool.result.data", conversationId: "other", output: { observation: { snapshot: "abcdef" } } }))!.id;
    expect(await h.run()).toMatchObject({ ok: false, result: { error: { message: expect.stringContaining("unavailable") } } });
    expect(foreign).toBe(true); expect(h.fake.debuggerApi.getTargets).not.toHaveBeenCalled(); h.executor.dispose();
  });
  it("stores internal artifacts, saves explicitly, reuses uploads and rejects foreign reads/saves", async () => {
    let foreignId = 0;
    const h = programHarness(async ({ artifacts }) => { const internal = await artifacts.text("internal.txt", "hello"); const saved = await artifacts.text("saved.txt", "x", "text/plain", true); return { internal, saved }; });
    const result: any = await h.run(); expect(result).toMatchObject({ ok: true, result: { internal: { byteLength: 5, saved: false }, saved: { saved: true, downloadId: 17 } } });
    const id = result.result.internal.id; (h.executor as any).activeContext = { conversationId: "conversation" };
    expect(await (h.executor as any).normalizeFiles([{ name: "upload.txt", artifactId: id }])).toEqual([{ name: "upload.txt", mimeType: "text/plain", base64: "aGVsbG8=" }]);
    foreignId = (await h.logger.append({ type: "tool.result.data", conversationId: "other", output: { filename: "foreign.txt", mimeType: "text/plain", base64: "eA==" } }))!.id;
    await expect((h.executor as any).normalizeFiles([{ name: "foreign.txt", artifactId: foreignId }])).rejects.toThrow("unavailable");
    await expect((h.executor as any).saveArtifact(foreignId)).rejects.toThrow("unavailable");
    expect(await (h.executor as any).saveArtifact(id)).toMatchObject({ artifact: { id, filename: "internal.txt", saved: true, downloadId: 17 } });
    expect(h.fake.chromeApi.downloads.download).toHaveBeenCalledTimes(2); h.executor.dispose();
  });
  it("exposes no raw Chrome API or execution globals through program capabilities", async () => {
    const h = programHarness(async (caps) => {
      for (const name of ["chrome", "__surfWaxBrowser", "__surfWaxDebugger", "__surfWaxResult"]) expect(caps).not.toHaveProperty(name);
      expect(caps.browser).not.toHaveProperty("cdp"); return Object.keys(caps).sort();
    });
    expect(await h.run()).toMatchObject({ ok: true, result: ["artifacts", "browser", "check", "emit", "net", "page", "protocol", "sleep"] }); h.executor.dispose();
  });
  it("applies an estimated program deadline and honors an explicit deadline", async () => {
    const h = programHarness(async () => 1); const timer = vi.spyOn(globalThis, "setTimeout");
    expect(await h.run()).toMatchObject({ ok: true, timeoutMs: 30000, timeoutSource: "estimated" }); expect(timer.mock.calls.some(([, delay]) => delay === 30000)).toBe(true);
    expect(await h.run(undefined, { timeoutMs: 37 })).toMatchObject({ ok: true, timeoutMs: 37, timeoutSource: "explicit" }); expect(timer.mock.calls.some(([, delay]) => delay === 37)).toBe(true);
    timer.mockRestore(); h.executor.dispose();
  });
  it("never retries a failed world or silently substitutes an available MAIN host for USER_SCRIPT", async () => {
    let world = "USER_SCRIPT";
    const h = programHarness(async ({ browser }) => browser.runIn({ kind: "page", tabId: 41, world }, "return document.title"));
    const pageValue = vi.fn().mockRejectedValue(new Error("page failed")); (h.executor as any).automation.pageValue = pageValue;
    expect(await h.run()).toMatchObject({ ok: false, result: { error: { message: expect.stringContaining("Allow User Scripts") } } });
    expect(pageValue).not.toHaveBeenCalled(); world = "MAIN";
    expect(await h.run()).toMatchObject({ ok: false, result: { error: { message: "page failed" } } }); expect(pageValue).toHaveBeenCalledTimes(1); h.executor.dispose();
  });
  it.each([
    ["queued", "tool", false], ["running", "tool", false],
    ["queued", "run", false], ["running", "run", false],
    ["queued", "tool", true], ["queued", "run", true],
  ] as const)("returns on %s persistence stalled when the %s is cancelled (background=%s)", async (state, source, background) => {
    const host = vi.fn(async () => "unexpected");
    const h = programHarness(host);
    if (background) await h.executor.beginRun();
    const append = h.logger.append.bind(h.logger);
    let resume!: () => void; let notify!: () => void;
    const held = new Promise<void>((resolve) => { resume = resolve; });
    const entered = new Promise<void>((resolve) => { notify = resolve; });
    vi.spyOn(h.logger, "append").mockImplementation(async (record) => {
      if (record.type === "browser.job.state" && (record.content as any)?.state === state) { notify(); await held; }
      return append(record);
    });
    const tool = new AbortController(); const run = new AbortController();
    const pending = h.executor.runProgram({ code: "test", background }, tool.signal, {
      conversationId: "conversation", runSignal: run.signal,
      logIdentity: { runId: "run", toolCallId: "1:test", toolCallIdCanonical: true },
    });
    await entered;
    (source === "tool" ? tool : run).abort("cancelled");
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(host).not.toHaveBeenCalled();
    resume();
    await h.executor.endRun();
    expect(host).not.toHaveBeenCalled();
    expect(h.executor.pendingBackgroundJobs()).toEqual([]);
    expect(h.events.filter((event) => event.type === "browser.job.state").map((event) => (fromLogValue(event.content) as any).state)).toContain("cancelled");
    h.executor.dispose();
  });

  it("detaches the tool signal after background acceptance while keeping the run signal", async () => {
    let release!: () => void;
    const h = programHarness(async (_caps, signal) => { await new Promise<void>((resolve) => { release = resolve; }); signal.throwIfAborted(); return "done"; });
    await h.executor.beginRun();
    const tool = new AbortController(); const run = new AbortController();
    const accepted = await h.executor.runProgram({ code: "test", background: true }, tool.signal, {
      conversationId: "conversation", runSignal: run.signal,
      logIdentity: { runId: "run", toolCallId: "1:test", toolCallIdCanonical: true },
    }) as any;
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    tool.abort(); release();
    await expect((h.executor as any).jobs.completion(accepted.jobId, "conversation")).resolves.toMatchObject({ state: "succeeded" });
    await h.executor.endRun(); h.executor.dispose();
  });

  it("cancels an accepted background job when its run signal aborts", async () => {
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const h = programHarness(async (_caps, signal) => {
      started();
      await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    });
    await h.executor.beginRun();
    const run = new AbortController();
    const accepted: any = await h.executor.runProgram({ code: "test", background: true }, undefined, {
      conversationId: "conversation", runSignal: run.signal,
      logIdentity: { runId: "run", toolCallId: "1:test", toolCallIdCanonical: true },
    });
    await ready;
    run.abort("cancel-run");
    await expect((h.executor as any).jobs.completion(accepted.jobId, "conversation")).resolves.toMatchObject({ state: "cancelled", terminal: true });
    await h.executor.endRun(); h.executor.dispose();
  });

  it("aborts element search from the run signal before dispatching after slow page binding", async () => {
    const h = programHarness(async () => undefined);
    let resume!: () => void; let entered!: () => void;
    const hold = new Promise<void>((resolve) => { resume = resolve; }); const binding = new Promise<void>((resolve) => { entered = resolve; });
    (h.executor as any).pageFor = vi.fn(async () => { entered(); await hold; return h.raw; });
    const search = vi.spyOn((h.executor as any).automation, "findElements");
    const run = new AbortController();
    const pending = h.executor.findElements({ target: { by: "css", value: "button" } }, undefined, { conversationId: "conversation", runSignal: run.signal });
    await binding; run.abort("cancelled");
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    resume(); await (h.executor as any).tail;
    expect(search).not.toHaveBeenCalled(); h.executor.dispose();
  });

  it("preserves browser sessions and subscriptions after a definite pre-dispatch failure while releasing held input", async () => {
    const h = programHarness(async ({ page }) => page.goto("https://example.test"));
    await h.executor.beginRun();
    const context = { conversationId: "conversation", logIdentity: { runId: "run", toolCallId: "1:test", toolCallIdCanonical: true as const } };
    const subscription: any = await h.executor.subscribeEvent({ kind: "dialog" }, undefined, context);
    h.raw.goto = vi.fn(async () => { throw new Error("AutomationError[detached]: target was removed"); });
    (h.executor as any).heldInput.set(41, { x: 10, y: 20, buttons: new Set(["left"]), keys: new Map([["Shift", { key: "Shift" }]]) });
    const abortSessions = vi.spyOn((h.executor as any).automation, "abortSessions");
    const result: any = await h.executor.runProgram({ code: "test" }, undefined, context);
    expect(result).toMatchObject({ ok: false, state: "failed", result: { error: { code: "detached" } } });
    expect(result.result.error.effectUnknown).toBeUndefined();
    expect(abortSessions).not.toHaveBeenCalled();
    expect(h.fake.debuggerApi.sendCommand).toHaveBeenCalledWith({ tabId: 41 }, "Input.cancelDragging", {});
    expect(h.fake.debuggerApi.sendCommand).toHaveBeenCalledWith({ tabId: 41 }, "Input.dispatchKeyEvent", expect.objectContaining({ type: "keyUp", key: "Shift" }));
    expect(h.fake.debuggerApi.sendCommand).toHaveBeenCalledWith({ tabId: 41 }, "Input.dispatchMouseEvent", expect.objectContaining({ type: "mouseReleased", button: "left" }));
    expect((h.executor as any).heldInput.size).toBe(0);
    await (h.executor as any).handleCommandEvent({ tabId: 41 }, "Page.javascriptDialogOpening", { type: "confirm", message: "Still subscribed" });
    await expect(h.executor.waitEvent({ subscriptionId: subscription.subscriptionId }, undefined, context)).resolves.toMatchObject({ events: [{ payload: { message: "Still subscribed" } }] });
    await h.executor.endRun(); h.executor.dispose();
  });

  it("fully stops an abandoned in-flight RPC when the program fails", async () => {
    let started!: () => void; let release!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const h = programHarness(async ({ page }) => { void page.goto("https://example.test").catch(() => undefined); await entered; throw new Error("Program failed"); });
    h.raw.goto = vi.fn(async () => { started(); await held; return "late"; });
    const stop = vi.spyOn(h.executor as any, "stopBrowserOperations").mockImplementation(async () => { release(); });
    const result: any = await h.run();
    expect(result).toMatchObject({ ok: false, state: "failed" });
    expect(stop).toHaveBeenCalledOnce();
    stop.mockRestore(); h.executor.dispose();
  });

  it("fails with uncertain effects when a successful program abandons a dispatched RPC", async () => {
    let started!: () => void; let release!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const h = programHarness(async ({ page }) => { void page.goto("https://example.test").catch(() => undefined); await entered; return "finished"; });
    h.raw.goto = vi.fn(async () => { await (h.executor as any).programScope.dispatched(); started(); await held; return "late"; });
    const stop = vi.spyOn(h.executor as any, "stopBrowserOperations").mockImplementation(async () => { release(); });
    const result: any = await h.run();
    expect(stop).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ ok: false, state: "failed", result: { error: { effectUnknown: true } } });
    stop.mockRestore(); h.executor.dispose();
  });

  it("fully stops after an uncertain failure even after its RPC has settled", async () => {
    const failure = Object.assign(new Error("Unknown browser effect"), { effectUnknown: true });
    const h = programHarness(async () => { throw failure; });
    const stop = vi.spyOn(h.executor as any, "stopBrowserOperations").mockImplementation(async () => undefined);
    expect(await h.run()).toMatchObject({ ok: false, result: { error: { effectUnknown: true } } });
    expect(stop).toHaveBeenCalledOnce();
    stop.mockRestore(); h.executor.dispose();
  });

  it("does not start queued programs when their owner aborts", async () => {
    const controller = new AbortController(); let finish!: () => void; const host = vi.fn(async (_caps: any, signal: AbortSignal) => { await new Promise<void>(resolve => { finish = resolve; }); signal.throwIfAborted(); });
    const h = programHarness(host); const first = h.run(controller.signal); const second = h.run(controller.signal);
    await vi.waitFor(() => expect(host).toHaveBeenCalledTimes(1)); controller.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" }); await expect(second).rejects.toMatchObject({ name: "AbortError" }); finish(); await (h.executor as any).tail;
    expect(host).toHaveBeenCalledTimes(1); h.executor.dispose();
  });
  it("keeps stable tab targets across calls without querying the Side Panel DevTools target", async () => {
    const h = programHarness(async ({ page }) => page.title()); expect(await h.run()).toMatchObject({ ok: true, result: "Current" }); expect(await h.run()).toMatchObject({ ok: true, result: "Current" });
    expect(h.fake.debuggerApi.getTargets).not.toHaveBeenCalled(); expect((h.executor as any).pageFor.mock.calls.map(([state]: any[]) => state.tabId)).toEqual([41, 41]); h.executor.dispose();
  });
  it("prevents queued work after disposal and records interruption", async () => {
    let finish!: () => void; const host = vi.fn(async (_caps: any, signal: AbortSignal) => { await new Promise<void>(resolve => { finish = resolve; }); signal.throwIfAborted(); });
    const h = programHarness(host); const first = h.run(); const second = h.run(); await vi.waitFor(() => expect(host).toHaveBeenCalledTimes(1)); h.executor.dispose(); finish();
    expect(await first).toMatchObject({ ok: false }); expect(await second).toMatchObject({ ok: false }); expect(host).toHaveBeenCalledTimes(1);
  });
  it("terminates tracked page evaluations and releases inputs on abort", async () => {
    const fake = fakeChrome(); const executor = new ChromeExecutor({ chromeApi: fake.chromeApi as never });
    (executor as any).programEvaluations.set('tab', { debuggee: { tabId: 41 }, count: 1 });
    await (executor as any).stopBrowserOperations();
    expect(fake.debuggerApi.sendCommand).toHaveBeenCalledWith({ tabId: 41 }, "Runtime.terminateExecution", undefined); executor.dispose();
  });
  it("does not initialize a page after queued execution is aborted", async () => {
    const h = programHarness(async () => 1); let release!: () => void; (h.executor as any).tail = new Promise<void>(resolve => { release = resolve; });
    const controller = new AbortController(); const pending = h.run(controller.signal); controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" }); release(); await (h.executor as any).tail;
    expect((h.executor as any).pageFor).not.toHaveBeenCalled(); expect(h.fake.debuggerApi.attach).not.toHaveBeenCalled(); h.executor.dispose();
  });
  it("never invokes the program host if abort arrives during page initialization", async () => {
    const host = vi.fn(async () => 1); const h = programHarness(host); let finish!: (page: object) => void;
    (h.executor as any).pageFor = vi.fn(() => new Promise(resolve => { finish = resolve; })); const controller = new AbortController(); const pending = h.run(controller.signal);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function")); controller.abort(); await expect(pending).rejects.toMatchObject({ name: "AbortError" }); finish(h.raw); await (h.executor as any).tail;
    expect(host).not.toHaveBeenCalled(); h.executor.dispose();
  });
  it("does not snapshot or register user scripts after ordinary execution", async () => {
    const h = programHarness(async () => 42); expect(await h.run()).toMatchObject({ ok: true, result: 42 });
    expect(h.fake.chromeApi.userScripts.getScripts).not.toHaveBeenCalled(); expect(h.fake.chromeApi.userScripts.register).not.toHaveBeenCalled(); h.executor.dispose();
  });
  it("does not mark work canceled while still queued as an uncertain side effect", async () => {
    const fake = fakeChrome();
    const executor = new ChromeExecutor({ chromeApi: fake.chromeApi as never });
    let releaseQueue!: () => void;
    (executor as any).tail = new Promise<void>((resolve) => { releaseQueue = resolve; });
    const run = vi.fn(async (signal: AbortSignal) => {
      if (signal.aborted) throw new DOMException(String(signal.reason), "AbortError");
    });
    const controller = new AbortController();
    const pending = (executor as any).enqueueAbortable(run, controller.signal);
    controller.abort("sidepanel-closed");
    await expect(pending).rejects.toMatchObject({ name: "AbortError", message: "sidepanel-closed" });
    await expect(pending).rejects.not.toHaveProperty("effectUnknown");
    expect(run).not.toHaveBeenCalled();
    releaseQueue(); await (executor as any).tail; executor.dispose();
  });
  it.each(["user-interrupted", "sidepanel-closed", "owner-disconnected"])("keeps the abort reason %s while returning before unresolved browser work", async (reason) => {
    const fake = fakeChrome();
    const executor = new ChromeExecutor({ chromeApi: fake.chromeApi as never });
    let finish!: () => void;
    const work = new Promise<void>((resolve) => { finish = resolve; });
    const controller = new AbortController();
    const pending = (executor as any).awaitAbort(work, controller.signal, true);
    controller.abort(reason);
    await expect(pending).rejects.toMatchObject({ name: "AbortError", message: reason, effectUnknown: true });
    finish(); executor.dispose();
  });
  it("rebinds each run to the active tab and keeps that target stable within the run", async () => {
    const fake = fakeChrome();
    const tabs: chrome.tabs.Tab[] = [
      { id: 41, windowId: 7, active: true, title: "First", url: "https://example.com/first" } as chrome.tabs.Tab,
      { id: 42, windowId: 7, active: false, title: "Second", url: "https://example.com/second" } as chrome.tabs.Tab,
    ];
    Object.assign(fake.chromeApi, {
      windows: {
        getCurrent: vi.fn(async () => ({ id: 7, tabs })),
        get: vi.fn(async () => ({ id: 7 })),
      },
      tabs: {
        get: vi.fn(async (tabId: number) => tabs.find((tab) => tab.id === tabId)),
        query: vi.fn(async ({ windowId, active }: chrome.tabs.QueryInfo = {}) => tabs.filter((tab) => (windowId === undefined || tab.windowId === windowId) && (!active || tab.active))),
      },
    });
    const executor = new ChromeExecutor({ chromeApi: fake.chromeApi as never });

    await expect(executor.beginRun()).resolves.toMatchObject({ tabs: [
      { index: 0, current: true, title: "First", url: "https://example.com/first" },
      { index: 1, current: false, title: "Second", url: "https://example.com/second" },
    ] });
    tabs[0]!.active = false;
    tabs[1]!.active = true;
    expect((await executor.browserContext()).tabs[0]!.current).toBe(true);
    expect((await executor.beginRun()).tabs[1]!.current).toBe(true);

    tabs.splice(1, 1);
    tabs[0]!.active = true;
    expect((await executor.browserContext()).tabs[0]!.current).toBe(false);
    await expect((executor as any).pageFor((executor as any).browserState)).rejects.toThrow("bound-tab-closed");
    executor.dispose();
  });

  it("retains the stored artifact when canceled during logging without starting a download", async () => {
    const fake = fakeChrome();
    const controller = new AbortController();
    const logger = { append: vi.fn(async () => {
      controller.abort(new DOMException("sidepanel-closed", "AbortError"));
      return { id: 7 };
    }) } as unknown as EventLogger;
    const executor = new ChromeExecutor({ chromeApi: fake.chromeApi as never, logger });
    (executor as any).activeContext = { conversationId: "conversation" };
    (executor as any).activeSignal = controller.signal;
    await expect((executor as any).storeArtifact("screen.png", "eA==", "image/png", true)).rejects.toMatchObject({ artifact: { id: 7, filename: "screen.png", saved: false } });
    expect(logger.append).toHaveBeenCalledTimes(1);
    expect(fake.chromeApi.downloads.download).not.toHaveBeenCalled();
    executor.dispose();
  });

  it("releases held mouse buttons and keyboard keys at the current pointer location", async () => {
    const fake = fakeChrome();
    const executor = new ChromeExecutor({ chromeApi: fake.chromeApi as never });
    await (executor as any).bridgeCommand({ tabId: 41 }, "Input.dispatchMouseEvent", { type: "mouseMoved", x: 90, y: 40 });
    await (executor as any).bridgeCommand({ tabId: 41 }, "Input.dispatchMouseEvent", { type: "mousePressed", x: 90, y: 40, button: "right" });
    await (executor as any).bridgeCommand({ tabId: 41 }, "Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Shift", code: "ShiftLeft" });
    expect(fake.debuggerApi.sendCommand).toHaveBeenCalledWith({ tabId: 41 }, "Input.dispatchKeyEvent", expect.objectContaining({ type: "rawKeyDown", key: "Shift", modifiers: 8 }));
    await executor.endRun();
    expect(fake.debuggerApi.sendCommand).toHaveBeenCalledWith({ tabId: 41 }, "Input.dispatchKeyEvent", expect.objectContaining({ type: "keyUp", key: "Shift", modifiers: 0 }));
    expect(fake.debuggerApi.sendCommand).toHaveBeenCalledWith({ tabId: 41 }, "Input.dispatchMouseEvent", expect.objectContaining({ type: "mouseReleased", x: 90, y: 40, button: "right" }));
    executor.dispose();
  });

  it("retains failed key and button releases for cleanup retry", async () => {
    const fake = fakeChrome();
    const { logger, events } = memoryLog();
    let failRelease = true;
    fake.debuggerApi.sendCommand.mockImplementation(async (_source: any, method: string, params: any) => {
      if (failRelease && (method === "Input.dispatchKeyEvent" && params?.type === "keyUp"
        || method === "Input.dispatchMouseEvent" && params?.type === "mouseReleased")) throw new Error("release failed");
      return {};
    });
    const executor = new ChromeExecutor({ chromeApi: fake.chromeApi as never, logger });
    const send = (method: string, params: object) => (executor as any).bridgeCommand({ tabId: 41 }, method, params);
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", text: "a", commands: ["selectAll"] });
    await send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", x: 8, y: 9 });
    await expect(send("Input.dispatchKeyEvent", { type: "keyUp", key: "a" })).rejects.toThrow("release failed");
    await expect(send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left" })).rejects.toThrow("release failed");
    const state = (executor as any).heldInput.get(41);
    expect([...state.keys.values()]).toContainEqual(expect.objectContaining({ key: "a", code: "KeyA" }));
    expect(state.buttons.has("left")).toBe(true);
    expect(fake.debuggerApi.sendCommand).toHaveBeenLastCalledWith({ tabId: 41 }, "Input.dispatchMouseEvent", expect.objectContaining({ type: "mouseReleased", buttons: 0 }));
    await (executor as any).releaseInput(41);
    await logger.flush();
    expect((executor as any).heldInput.get(41)).toBe(state);
    expect(events.some(event => event.type === "browser.input.cleanup.failed")).toBe(true);
    expect(fake.debuggerApi.sendCommand).toHaveBeenCalledWith({ tabId: 41 }, "Input.dispatchKeyEvent", expect.objectContaining({ type: "keyUp", key: "a", text: undefined, commands: undefined }));
    failRelease = false;
    await (executor as any).releaseInput(41);
    expect((executor as any).heldInput.has(41)).toBe(false);
    await executor.endRun(); executor.dispose();
  });

  it("serializes input releases and later presses within a tab", async () => {
    const fake = fakeChrome();
    let completeKey!: () => void, completeButton!: () => void;
    let startedKey!: () => void, startedButton!: () => void;
    const keyStarted = new Promise<void>(resolve => { startedKey = resolve; });
    const buttonStarted = new Promise<void>(resolve => { startedButton = resolve; });
    fake.debuggerApi.sendCommand.mockImplementation(async (_source: any, method: string, params: any) => {
      if (method === "Input.dispatchKeyEvent" && params?.type === "keyUp") {
        startedKey(); await new Promise<void>(resolve => { completeKey = resolve; });
      }
      if (method === "Input.dispatchMouseEvent" && params?.type === "mouseReleased") {
        startedButton(); await new Promise<void>(resolve => { completeButton = resolve; });
      }
      return {};
    });
    const executor = new ChromeExecutor({ chromeApi: fake.chromeApi as never });
    const send = (method: string, params: object) => (executor as any).bridgeCommand({ tabId: 41 }, method, params);
    await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Shift", code: "ShiftLeft" });
    await send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left" });
    const keyUp = send("Input.dispatchKeyEvent", { type: "keyUp", key: "Shift" });
    const mouseUp = send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left" });
    await keyStarted;
    const nextKey = send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Shift", code: "ShiftLeft" });
    const nextButton = send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left" });
    completeKey();
    await buttonStarted;
    completeButton();
    await Promise.all([keyUp, mouseUp, nextKey, nextButton]);
    const state = (executor as any).heldInput.get(41);
    expect([...state.keys.values()]).toContainEqual(expect.objectContaining({ key: "Shift", code: "ShiftLeft" }));
    expect(state.buttons.has("left")).toBe(true);
    fake.debuggerApi.sendCommand.mockResolvedValue({});
    await executor.endRun(); executor.dispose();
  });

  it("presses chords in order while preserving previously held modifiers", async () => {
    const fake = fakeChrome(); const executor = new ChromeExecutor({ chromeApi: fake.chromeApi as never });
    const press = (chord: string, signal?: AbortSignal) => (executor as any).pressChord({ tabId: 41 }, chord, signal);
    const send = (params: object) => (executor as any).bridgeCommand({ tabId: 41 }, "Input.dispatchKeyEvent", params);
    await press("Control+a");
    const events = () => fake.debuggerApi.sendCommand.mock.calls.filter(([, method]) => method === "Input.dispatchKeyEvent").map(([, , params]: any[]) => [params.type, params.key, params.modifiers]);
    expect(events()).toEqual([["rawKeyDown", "Control", 2], ["keyDown", "a", 2], ["keyUp", "a", 2], ["keyUp", "Control", 0]]);
    fake.debuggerApi.sendCommand.mockClear();
    await send({ type: "rawKeyDown", key: "Control", code: "ControlLeft" });
    await press("Control+a");
    expect(events()).toEqual([["rawKeyDown", "Control", 2], ["keyDown", "a", 2], ["keyUp", "a", 2]]);
    expect([...((executor as any).heldInput.get(41).keys.values())]).toContainEqual(expect.objectContaining({ key: "Control", code: "ControlLeft" }));
    await executor.endRun(); executor.dispose();
  });

  it("applies Mac native editing commands after resolving held modifiers", async () => {
    vi.stubGlobal("navigator", { platform: "MacIntel" });
    const fake = fakeChrome(), executor = new ChromeExecutor({ chromeApi: fake.chromeApi as never });
    const send = (params: object) => (executor as any).bridgeCommand({ tabId: 41 }, "Input.dispatchKeyEvent", params);
    await send({ type: "rawKeyDown", key: "Meta", code: "MetaLeft" });
    await (executor as any).pressChord({ tabId: 41 }, "a");
    expect(fake.debuggerApi.sendCommand).toHaveBeenCalledWith({ tabId: 41 }, "Input.dispatchKeyEvent", expect.objectContaining({ key: "a", code: "KeyA", modifiers: 4, commands: ["selectAll"] }));
    const released = fake.debuggerApi.sendCommand.mock.calls.filter(([, method, params]: any[]) => method === "Input.dispatchKeyEvent" && params.type === "keyUp");
    expect(released.every(([, , params]: any[]) => params.commands === undefined)).toBe(true);
    await send({ type: "keyDown", key: "z", code: "KeyZ", commands: ["customCommand"] });
    expect(fake.debuggerApi.sendCommand).toHaveBeenLastCalledWith({ tabId: 41 }, "Input.dispatchKeyEvent", expect.objectContaining({ commands: ["customCommand"] }));
    await (executor as any).bridgeCommand({ tabId: 41 }, "Input.dispatchKeyEvent", { type: "rawKeyDown", key: "a", code: "KeyA", modifiers: 4 }, true);
    expect(fake.debuggerApi.sendCommand.mock.lastCall?.[2]).not.toHaveProperty("commands");
    await executor.endRun(); executor.dispose();
  });

  it("passes explicit raw CDP mouse and keyboard fields through unchanged", async () => {
    const fake = fakeChrome(), executor = new ChromeExecutor({ chromeApi: fake.chromeApi as never });
    const send = (method: string, params: object, raw = false) => (executor as any).bridgeCommand({ tabId: 41 }, method, params, raw);
    await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Shift", code: "ShiftLeft" });
    const mouse = { type: "mouseMoved", x: 12, y: 18, buttons: 1, modifiers: 0, force: 0.5 };
    const key = { type: "keyDown", key: "a", code: "KeyA", text: "a", modifiers: 0, windowsVirtualKeyCode: 65 };
    await send("Input.dispatchMouseEvent", mouse, true);
    await send("Input.dispatchKeyEvent", key, true);
    expect(fake.debuggerApi.sendCommand).toHaveBeenCalledWith({ tabId: 41 }, "Input.dispatchMouseEvent", mouse);
    expect(fake.debuggerApi.sendCommand).toHaveBeenCalledWith({ tabId: 41 }, "Input.dispatchKeyEvent", key);
    await executor.endRun(); executor.dispose();
  });

  it("preserves separate raw physical modifiers when sending a chord and cleaning up", async () => {
    const fake = fakeChrome(), executor = new ChromeExecutor({ chromeApi: fake.chromeApi as never });
    const send = (params: object) => (executor as any).bridgeCommand({ tabId: 41 }, "Input.dispatchKeyEvent", params, true);
    await send({ type: "rawKeyDown", code: "ShiftLeft", key: "Shift", modifiers: 8 });
    await send({ type: "rawKeyDown", code: "ShiftRight", key: "Shift", modifiers: 8 });
    await send({ type: "keyUp", code: "ShiftLeft", key: "Shift", modifiers: 8 });
    fake.debuggerApi.sendCommand.mockClear();
    await (executor as any).pressChord({ tabId: 41 }, "Shift+a");
    const calls = fake.debuggerApi.sendCommand.mock.calls.filter(([, method]) => method === "Input.dispatchKeyEvent").map(([, , params]: any[]) => params);
    expect(calls.map((params) => [params.type, params.key, params.modifiers])).toEqual([["keyDown", "a", 8], ["keyUp", "a", 8]]);
    expect([...((executor as any).heldInput.get(41).keys.values())]).toEqual([expect.objectContaining({ code: "ShiftRight" })]);
    await (executor as any).releaseInput(41);
    expect(fake.debuggerApi.sendCommand).toHaveBeenCalledWith({ tabId: 41 }, "Input.dispatchKeyEvent", expect.objectContaining({ type: "keyUp", code: "ShiftRight", key: "Shift" }));
    await executor.endRun(); executor.dispose();
  });

  it("cleans up raw keys that identify themselves only by physical code", async () => {
    const fake = fakeChrome(), executor = new ChromeExecutor({ chromeApi: fake.chromeApi as never });
    await (executor as any).bridgeCommand({ tabId: 41 }, "Input.dispatchKeyEvent", { type: "rawKeyDown", code: "KeyA", windowsVirtualKeyCode: 65 }, true);
    await (executor as any).releaseInput(41);
    expect(fake.debuggerApi.sendCommand).toHaveBeenCalledWith({ tabId: 41 }, "Input.dispatchKeyEvent", expect.objectContaining({ type: "keyUp", code: "KeyA", windowsVirtualKeyCode: 65 }));
    const release = fake.debuggerApi.sendCommand.mock.calls.find(([, method, params]: any[]) => method === "Input.dispatchKeyEvent" && params.type === "keyUp")![2];
    expect(release).not.toHaveProperty("key");
    await executor.endRun(); executor.dispose();
  });

  it("rejects internal automation fields supplied to raw CDP", async () => {
    const fake = fakeChrome(), executor = new ChromeExecutor({ chromeApi: fake.chromeApi as never });
    await expect((executor as any).bridgeCommand({ tabId: 41 }, "Input.dispatchMouseEvent", { type: "mousePressed", x: 1, y: 2, surfWaxAtomicClick: true }, true))
      .rejects.toThrow("AutomationError[invalid-protocol-parameter]");
    expect(fake.debuggerApi.sendCommand).not.toHaveBeenCalled();
    await executor.endRun(); executor.dispose();
  });

  it("marks raw CDP separately from the caller's protocol parameters across the bridge", async () => {
    const fake = fakeChrome();
    const { port } = fakePort((message, reply) => reply({ id: message.id, result: {} }));
    Object.assign(fake.chromeApi, { runtime: { connect: () => port } });
    const executor = new ChromeExecutor({ chromeApi: fake.chromeApi as never });
    const params = { type: "mouseMoved", x: 12, y: 18, buttons: 1, modifiers: 0 };
    await (executor as any).bridgeCommand({ tabId: 41 }, "Input.dispatchMouseEvent", params, true);
    const message = port.postMessage.mock.calls.map(([value]) => value as any).find((value) => value.args?.[1] === "Input.dispatchMouseEvent");
    expect(message).toMatchObject({ rawCdp: true, args: [{ tabId: 41 }, "Input.dispatchMouseEvent", params] });
    await executor.endRun(); executor.dispose();
  });

  it("releases only chord-owned keys after cancellation", async () => {
    const fake = fakeChrome(); const executor = new ChromeExecutor({ chromeApi: fake.chromeApi as never });
    const controller = new AbortController();
    fake.debuggerApi.sendCommand.mockImplementation(async (_source: any, method: string, params: any) => {
      if (method === "Input.dispatchKeyEvent" && params.type === "rawKeyDown" && params.key === "Shift") controller.abort();
      return {};
    });
    await expect((executor as any).pressChord({ tabId: 41 }, "Control+Shift+a", controller.signal)).rejects.toMatchObject({ name: "AbortError", effectUnknown: true });
    expect(fake.debuggerApi.sendCommand.mock.calls.filter(([, method]) => method === "Input.dispatchKeyEvent").map(([, , params]: any[]) => [params.type, params.key])).toEqual([
      ["rawKeyDown", "Control"], ["rawKeyDown", "Shift"], ["keyUp", "Shift"], ["keyUp", "Control"],
    ]);
    await executor.endRun(); executor.dispose();
  });

  it("cancels a queued chord promptly without bypassing the earlier input", async () => {
    const fake = fakeChrome(); const executor = new ChromeExecutor({ chromeApi: fake.chromeApi as never });
    let started!: () => void, finish!: () => void;
    const pending = new Promise<void>((resolve) => { started = resolve; });
    fake.debuggerApi.sendCommand.mockImplementation(async (_source: any, method: string, params: any) => {
      if (method === "Input.dispatchKeyEvent" && params.key === "x" && params.type === "rawKeyDown") {
        started(); await new Promise<void>((resolve) => { finish = resolve; });
      }
      return {};
    });
    const send = (params: object) => (executor as any).bridgeCommand({ tabId: 41 }, "Input.dispatchKeyEvent", params);
    const first = send({ type: "rawKeyDown", key: "x" }); await pending;
    const controller = new AbortController();
    const cancelled = (executor as any).pressChord({ tabId: 41 }, "Control+a", controller.signal);
    controller.abort(); await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    const later = send({ type: "rawKeyDown", key: "z" });
    expect(fake.debuggerApi.sendCommand.mock.calls.some(([, method, params]: any[]) => method === "Input.dispatchKeyEvent" && params.key === "z")).toBe(false);
    finish(); await Promise.all([first, later]);
    expect(fake.debuggerApi.sendCommand.mock.calls.some(([, method, params]: any[]) => method === "Input.dispatchKeyEvent" && params.key === "Control")).toBe(false);
    await executor.endRun(); executor.dispose();
  });

  it("preserves a previously held modifier when chord dispatch fails", async () => {
    const fake = fakeChrome(); const executor = new ChromeExecutor({ chromeApi: fake.chromeApi as never });
    const send = (params: object) => (executor as any).bridgeCommand({ tabId: 41 }, "Input.dispatchKeyEvent", params);
    await send({ type: "rawKeyDown", key: "Control" });
    fake.debuggerApi.sendCommand.mockImplementation(async (_source: any, method: string, params: any) => {
      if (method === "Input.dispatchKeyEvent" && params.key === "a" && params.type === "keyDown") throw new Error("uncertain keydown");
      return {};
    });
    await expect((executor as any).pressChord({ tabId: 41 }, "Control+Shift+a")).rejects.toMatchObject({ message: "uncertain keydown", effectUnknown: true });
    expect(fake.debuggerApi.sendCommand.mock.calls.filter(([, method, params]: any[]) => method === "Input.dispatchKeyEvent" && params.type === "keyUp").map(([, , params]: any[]) => params.key)).toEqual(["a", "Shift"]);
    expect([...((executor as any).heldInput.get(41).keys.values())]).toEqual([expect.objectContaining({ key: "Control" })]);
    fake.debuggerApi.sendCommand.mockResolvedValue({}); await executor.endRun(); executor.dispose();
  });

  it("does not release a chord key that the background proves was never dispatched", async () => {
    const fake = fakeChrome();
    const { port } = fakePort((message: any, reply) => {
      const params = message.args?.[2];
      if (message.method === "sendCommand" && params?.key === "a" && params.type === "keyDown")
        reply({ id: message.id, error: "authorization failed", dispatchState: "not-dispatched" });
      else reply({ id: message.id, result: {} });
    });
    Object.assign(fake.chromeApi, { runtime: { connect: () => port } });
    const executor = new ChromeExecutor({ chromeApi: fake.chromeApi as never });
    await expect((executor as any).pressChord({ tabId: 41 }, "Shift+a")).rejects.toMatchObject({ message: "authorization failed", dispatchState: "not-dispatched", effectUnknown: true });
    const events = port.postMessage.mock.calls.map(([message]: any[]) => message).filter((message: any) => message.args?.[1] === "Input.dispatchKeyEvent").map((message: any) => [message.args[2].type, message.args[2].key]);
    expect(events).toEqual([["rawKeyDown", "Shift"], ["keyDown", "a"], ["keyUp", "Shift"]]);
    expect((executor as any).heldInput.get(41).keys.size).toBe(0);
    await executor.endRun(); executor.dispose();
  });

  it("retains uncertain input for cleanup when no trusted dispatch state is returned", async () => {
    const fake = fakeChrome();
    const { port } = fakePort((message: any, reply) => {
      const params = message.args?.[2];
      if (message.method === "sendCommand" && params?.key === "a" && params.type === "keyDown")
        reply({ id: message.id, error: "response was lost" });
      else reply({ id: message.id, result: {} });
    });
    Object.assign(fake.chromeApi, { runtime: { connect: () => port } });
    const executor = new ChromeExecutor({ chromeApi: fake.chromeApi as never });
    await expect((executor as any).pressChord({ tabId: 41 }, "a")).rejects.toMatchObject({ message: "response was lost", effectUnknown: true });
    const events = port.postMessage.mock.calls.map(([message]: any[]) => message).filter((message: any) => message.args?.[1] === "Input.dispatchKeyEvent").map((message: any) => [message.args[2].type, message.args[2].key]);
    expect(events).toEqual([["keyDown", "a"], ["keyUp", "a"]]);
    await executor.endRun(); executor.dispose();
  });

  it("marks a lost bridge response as uncertain and retains the input intent", async () => {
    const fake = fakeChrome();
    const { port } = fakePort((message: any, reply, drop) => {
      const params = message.args?.[2];
      if (message.method === "sendCommand" && params?.key === "a" && params.type === "keyDown") drop();
      else reply({ id: message.id, result: {} });
    });
    Object.assign(fake.chromeApi, { runtime: { connect: () => port } });
    const executor = new ChromeExecutor({ chromeApi: fake.chromeApi as never });
    await expect((executor as any).bridgeCommand({ tabId: 41 }, "Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", text: "a" }))
      .rejects.toMatchObject({ message: "Debugger bridge disconnected", effectUnknown: true });
    const state = (executor as any).heldInput.get(41);
    expect([...state.keys.values()]).toContainEqual(expect.objectContaining({ key: "a", code: "KeyA" }));
    state.keys.clear(); await executor.endRun(); executor.dispose();
  });

  it("does not roll back a newer held-key version on a delayed not-dispatched response", async () => {
    const fake = fakeChrome();
    let fail!: (message: object) => void, started!: () => void;
    const waiting = new Promise<void>((resolve) => { started = resolve; });
    const { port } = fakePort((message: any, reply) => {
      const params = message.args?.[2];
      if (message.method === "sendCommand" && params?.key === "a" && params.type === "keyDown") {
        fail = (value) => reply({ id: message.id, ...value }); started();
      } else reply({ id: message.id, result: {} });
    });
    Object.assign(fake.chromeApi, { runtime: { connect: () => port } });
    const executor = new ChromeExecutor({ chromeApi: fake.chromeApi as never });
    const pending = (executor as any).bridgeCommandUnlocked({ tabId: 41 }, "Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", text: "a" });
    await waiting;
    const state = (executor as any).heldInput.get(41), newer = { type: "keyDown", key: "a", code: "KeyA", text: "newer" };
    state.keys.set("code:KeyA", newer);
    fail({ error: "not dispatched", dispatchState: "not-dispatched" });
    await expect(pending).rejects.toMatchObject({ dispatchState: "not-dispatched" });
    expect(state.keys.get("code:KeyA")).toBe(newer);
    state.keys.clear(); await executor.endRun(); executor.dispose();
  });

  it("keeps a modifier active when the other physical modifier is released", async () => {
    const fake = fakeChrome(), executor = new ChromeExecutor({ chromeApi: fake.chromeApi as never });
    const send = (params: object) => (executor as any).bridgeCommand({ tabId: 41 }, "Input.dispatchKeyEvent", params, true);
    await send({ type: "rawKeyDown", key: "Shift", code: "ShiftLeft", modifiers: 8 });
    await send({ type: "rawKeyDown", key: "Shift", code: "ShiftRight", modifiers: 8 });
    await (executor as any).bridgeCommand({ tabId: 41 }, "Input.dispatchKeyEvent", { type: "keyUp", key: "Shift", code: "ShiftLeft", modifiers: 8 });
    expect(fake.debuggerApi.sendCommand).toHaveBeenLastCalledWith({ tabId: 41 }, "Input.dispatchKeyEvent", expect.objectContaining({ type: "keyUp", code: "ShiftLeft", modifiers: 8 }));
    await (executor as any).bridgeCommand({ tabId: 41 }, "Input.dispatchKeyEvent", { type: "keyUp", key: "Shift", code: "ShiftRight", modifiers: 8 });
    expect(fake.debuggerApi.sendCommand).toHaveBeenLastCalledWith({ tabId: 41 }, "Input.dispatchKeyEvent", expect.objectContaining({ type: "keyUp", code: "ShiftRight", modifiers: 0 }));
    await executor.endRun(); executor.dispose();
  });

  it("does not send the main chord key after its target loses focus", async () => {
    const fake = fakeChrome(); const executor = new ChromeExecutor({ chromeApi: fake.chromeApi as never });
    const assertFocus = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("focus lost"));
    await expect((executor as any).pressChord({ tabId: 41 }, "Control+a", undefined, assertFocus)).rejects.toMatchObject({ message: "focus lost", effectUnknown: true });
    expect(fake.debuggerApi.sendCommand.mock.calls.filter(([, method]: any[]) => method === "Input.dispatchKeyEvent").map(([, , params]: any[]) => [params.type, params.key])).toEqual([["rawKeyDown", "Control"], ["keyUp", "Control"]]);
    await executor.endRun(); executor.dispose();
  });

  it("does not retain char-only input as a held key", async () => {
    const fake = fakeChrome();
    const executor = new ChromeExecutor({ chromeApi: fake.chromeApi as never });
    await (executor as any).bridgeCommand({ tabId: 41 }, "Input.dispatchKeyEvent", { type: "char", text: "é" });
    expect((executor as any).heldInput.get(41).keys.size).toBe(0);
    await executor.endRun(); executor.dispose();
  });

  it("routes agent debugger calls through a panel-owned background port", async () => {
    const fake = fakeChrome();
    const { port } = fakePort();
    (fake.chromeApi as any).runtime = { connect: vi.fn(() => port) };
    const executor = new ChromeExecutor({ chromeApi: fake.chromeApi as never });
    expect((fake.chromeApi as any).runtime.connect).not.toHaveBeenCalled();
    const bridge = (globalThis as Record<string, any>).__surfWaxDebugger;
    await expect(bridge.call("attach", [{}, "1.3"])).rejects.toThrow("verify the queried tab or target exists");
    expect(port.postMessage).not.toHaveBeenCalled();
    await bridge.call("attach", [{ tabId: 15 }, "1.3"]);
    await bridge.call("attach", [{ targetId: "target-1" }, "1.3"]);
    expect(port.postMessage).toHaveBeenNthCalledWith(1, expect.objectContaining({ method: "attach", args: [{ tabId: 15 }, "1.3"] }));
    expect(port.postMessage).toHaveBeenNthCalledWith(2, expect.objectContaining({ method: "attach", args: [{ targetId: "target-1" }, "1.3"] }));
    expect(fake.debuggerApi.attach).not.toHaveBeenCalled();
    executor.dispose();
    expect(port.disconnect).toHaveBeenCalled();
  });

  it("preserves uncertain effects from debugger bridge errors", async () => {
    const fake = fakeChrome();
    const { port } = fakePort((message, reply) => reply({ id: message.id, error: "AutomationError[input-failed]: input failed", effectUnknown: true }));
    (fake.chromeApi as any).runtime = { connect: vi.fn(() => port) };
    const executor = new ChromeExecutor({ chromeApi: fake.chromeApi as never });
    const bridge = (globalThis as Record<string, any>).__surfWaxDebugger;
    await expect(bridge.call("getTargets", [])).rejects.toMatchObject({ message: expect.stringContaining("input-failed"), effectUnknown: true });
    executor.dispose();
  });

  it("reconnects after an idle background port disconnects", async () => {
    const fake = fakeChrome();
    const first = fakePort();
    const second = fakePort();
    const connect = vi.fn().mockReturnValueOnce(first.port).mockReturnValueOnce(second.port);
    (fake.chromeApi as any).runtime = { connect };
    const executor = new ChromeExecutor({ chromeApi: fake.chromeApi as never });
    const bridge = (globalThis as Record<string, any>).__surfWaxDebugger;
    await bridge.call("getTargets", []);
    first.drop();
    await bridge.call("getTargets", []);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(first.port.postMessage).toHaveBeenCalledTimes(1);
    expect(second.port.postMessage).toHaveBeenCalledTimes(1);
    executor.dispose();
    await expect(bridge.call("getTargets", [])).rejects.toMatchObject({ name: "AbortError" });
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("does not replay a command whose port disconnects while it is pending", async () => {
    const fake = fakeChrome();
    const first = fakePort(() => undefined);
    const second = fakePort();
    const connect = vi.fn().mockReturnValueOnce(first.port).mockReturnValueOnce(second.port);
    (fake.chromeApi as any).runtime = { connect };
    const executor = new ChromeExecutor({ chromeApi: fake.chromeApi as never });
    const bridge = (globalThis as Record<string, any>).__surfWaxDebugger;
    const running = bridge.call("attach", [{ tabId: 15 }, "1.3"]);
    first.drop();
    await expect(running).rejects.toThrow("Debugger bridge disconnected");
    expect(connect).toHaveBeenCalledTimes(1);
    await bridge.call("getTargets", []);
    expect(first.port.postMessage).toHaveBeenCalledTimes(1);
    expect(second.port.postMessage).toHaveBeenCalledTimes(1);
    executor.dispose();
  });

});

describe("cross-call browser events", () => {
  const owner = { conversationId: "conversation", logIdentity: { runId: "run", toolCallId: "1:event", toolCallIdCanonical: true as const } };
  const otherOwner = { conversationId: "conversation", logIdentity: { runId: "other-run", toolCallId: "1:event", toolCallIdCanonical: true as const } };

  it("uploads ordered artifacts to a captured chooser while a background action occupies the queue", async () => {
    let finish!: () => void;
    const h = programHarness(async () => new Promise<void>((resolve) => { finish = resolve; }));
    await h.executor.beginRun();
    const subscription: any = await h.executor.subscribeEvent({ kind: "filechooser" }, undefined, owner);
    const first = await h.logger.append({ type: "tool.result.data", conversationId: "conversation", output: { filename: "one.txt", mimeType: "text/plain", base64: "b25l" } });
    const second = await h.logger.append({ type: "tool.result.data", conversationId: "conversation", output: { filename: "two.txt", mimeType: "text/plain", base64: "dHdv" } });
    const job: any = await h.run(undefined, { background: true });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    const source = { tabId: 41, sessionId: "frame" };
    await (h.executor as any).handleCommandEvent(source, "Page.fileChooserOpened", { backendNodeId: 77, mode: "selectMultiple" });
    const event: any = await h.executor.waitEvent({ subscriptionId: subscription.subscriptionId }, undefined, owner);
    const chooserId = event.events[0].payload.chooserId;
    expect(event).toMatchObject({ events: [{ kind: "filechooser", source, payload: { chooserId, mode: "selectMultiple" } }] });
    h.fake.debuggerApi.sendCommand.mockImplementation(async (_source: any, method: string) => {
      if (method === "DOM.resolveNode") return { object: { objectId: "input-object" } };
      if (method === "Runtime.callFunctionOn") expect(h.events.some((entry) => entry.type === "browser.chooser.progress" && (entry.content as any)?.state === "dispatched-unknown")).toBe(true);
      return { result: { value: null } };
    });
    await expect(h.executor.uploadChooser({ chooserId, artifactId: [first!.id, second!.id, first!.id] }, undefined, owner)).resolves.toMatchObject({ chooserId, artifactIds: [first!.id, second!.id, first!.id], state: "completed" });
    expect(h.fake.debuggerApi.sendCommand).toHaveBeenCalledWith(source, "DOM.resolveNode", expect.objectContaining({ backendNodeId: 77 }));
    expect(h.fake.debuggerApi.sendCommand).toHaveBeenCalledWith(source, "Runtime.callFunctionOn", expect.objectContaining({ objectId: "input-object", arguments: [{ value: [
      { name: "one.txt", mimeType: "text/plain", base64: "b25l" }, { name: "two.txt", mimeType: "text/plain", base64: "dHdv" }, { name: "one.txt", mimeType: "text/plain", base64: "b25l" },
    ] }] }));
    expect(h.events.filter((entry) => entry.type === "browser.chooser.progress").map((entry) => (entry.content as any).state)).toEqual(["dispatched-unknown", "completed"]);
    await expect(h.executor.uploadChooser({ chooserId, artifactId: first!.id }, undefined, owner)).rejects.toThrow("handled");
    finish();
    await vi.waitFor(async () => expect(await h.executor.queryJobs({ action: "status", id: job.jobId }, undefined, owner)).toMatchObject({ terminal: true, ok: true }));
    await h.executor.endRun(); h.executor.dispose();
  });

  it("rejects too many files and another conversation's artifact before dispatch", async () => {
    const h = programHarness(async () => undefined);
    await h.executor.beginRun();
    const subscription: any = await h.executor.subscribeEvent({ kind: "filechooser" }, undefined, owner);
    const own = await h.logger.append({ type: "tool.result.data", conversationId: "conversation", output: { filename: "own", mimeType: "text/plain", base64: "YQ==" } });
    const foreign = await h.logger.append({ type: "tool.result.data", conversationId: "other", output: { filename: "foreign", mimeType: "text/plain", base64: "Yg==" } });
    await (h.executor as any).handleCommandEvent({ tabId: 41 }, "Page.fileChooserOpened", { backendNodeId: 77, mode: "selectSingle" });
    const event: any = await h.executor.waitEvent({ subscriptionId: subscription.subscriptionId }, undefined, owner);
    const chooserId = event.events[0].payload.chooserId;
    await expect(h.executor.uploadChooser({ chooserId, artifactId: [own!.id, own!.id] }, undefined, owner)).rejects.toThrow("invalid-file-count");
    await expect(h.executor.uploadChooser({ chooserId, artifactId: foreign!.id }, undefined, owner)).rejects.toThrow("unavailable");
    expect(h.fake.debuggerApi.sendCommand).not.toHaveBeenCalledWith(expect.anything(), "Runtime.callFunctionOn", expect.anything());
    expect(h.events.filter((entry) => entry.type === "browser.chooser.progress")).toHaveLength(0);
    await h.executor.endRun(); h.executor.dispose();
  });

  it("releases a pre-dispatch cancellation and fences a post-dispatch unknown outcome", async () => {
    const h = programHarness(async () => undefined);
    await h.executor.beginRun();
    const subscription: any = await h.executor.subscribeEvent({ kind: "filechooser" }, undefined, owner);
    const artifact = await h.logger.append({ type: "tool.result.data", conversationId: "conversation", output: { filename: "file", mimeType: "text/plain", base64: "YQ==" } });
    await (h.executor as any).handleCommandEvent({ tabId: 41 }, "Page.fileChooserOpened", { backendNodeId: 77, mode: "selectSingle" });
    const event: any = await h.executor.waitEvent({ subscriptionId: subscription.subscriptionId }, undefined, owner);
    const chooserId = event.events[0].payload.chooserId;
    const result = h.logger.result.bind(h.logger);
    let resumeRead!: () => void;
    const held = new Promise<void>((resolve) => { resumeRead = resolve; });
    const reading = vi.spyOn(h.logger, "result").mockImplementationOnce(async (...args) => { await held; return result(...args); });
    const before = new AbortController();
    const pendingRead = h.executor.uploadChooser({ chooserId, artifactId: artifact!.id }, before.signal, owner);
    await vi.waitFor(() => expect(reading).toHaveBeenCalledOnce());
    before.abort("before-dispatch");
    await expect(pendingRead).rejects.toMatchObject({ name: "AbortError" });
    expect(h.fake.debuggerApi.sendCommand).not.toHaveBeenCalledWith(expect.anything(), "Runtime.callFunctionOn", expect.anything());
    resumeRead();
    let finishCommand!: () => void;
    h.fake.debuggerApi.sendCommand.mockImplementation(async (_source: any, method: string) => {
      if (method === "DOM.resolveNode") return { object: { objectId: "input" } };
      if (method === "Runtime.callFunctionOn") return new Promise<object>((resolve) => { finishCommand = () => resolve({ result: { value: null } }); });
      return {};
    });
    const after = new AbortController();
    const pendingDispatch = h.executor.uploadChooser({ chooserId, artifactId: artifact!.id }, after.signal, owner);
    await vi.waitFor(() => expect(finishCommand).toBeTypeOf("function"));
    after.abort("after-dispatch");
    await expect(pendingDispatch).rejects.toMatchObject({ name: "AbortError", effectUnknown: true });
    await expect(h.executor.uploadChooser({ chooserId, artifactId: artifact!.id }, undefined, owner)).rejects.toThrow("uncertain");
    finishCommand();
    await h.executor.endRun(); h.executor.dispose();
  });

  it("honors chooser timeout while artifact data is still being read", async () => {
    const h = programHarness(async () => undefined);
    await h.executor.beginRun();
    const subscription: any = await h.executor.subscribeEvent({ kind: "filechooser" }, undefined, owner);
    const artifact = await h.logger.append({ type: "tool.result.data", conversationId: "conversation", output: { filename: "file", mimeType: "text/plain", base64: "YQ==" } });
    await (h.executor as any).handleCommandEvent({ tabId: 41 }, "Page.fileChooserOpened", { backendNodeId: 77, mode: "selectSingle" });
    const event: any = await h.executor.waitEvent({ subscriptionId: subscription.subscriptionId }, undefined, owner);
    const chooserId = event.events[0].payload.chooserId;
    const result = h.logger.result.bind(h.logger);
    let resume!: () => void;
    const held = new Promise<void>((resolve) => { resume = resolve; });
    const read = vi.spyOn(h.logger, "result").mockImplementationOnce(async (...args) => { await held; return result(...args); });
    vi.useFakeTimers();
    const pending = h.executor.uploadChooser({ chooserId, artifactId: artifact!.id, timeoutMs: 50 }, undefined, owner).catch((error) => error);
    await vi.advanceTimersByTimeAsync(51);
    const error = await pending;
    expect(error).toMatchObject({ name: "TimeoutError" });
    expect((error as { effectUnknown?: boolean }).effectUnknown).toBeUndefined();
    expect(read).toHaveBeenCalledOnce();
    expect(h.fake.debuggerApi.sendCommand).not.toHaveBeenCalledWith(expect.anything(), "Runtime.callFunctionOn", expect.anything());
    resume();
    vi.useRealTimers();
    await h.executor.endRun(); h.executor.dispose();
  });

  it("invalidates a chooser on navigation, source detach and run end before dispatch", async () => {
    const h = programHarness(async () => undefined);
    await h.executor.beginRun();
    const subscription: any = await h.executor.subscribeEvent({ kind: "filechooser" }, undefined, owner);
    const artifact = await h.logger.append({ type: "tool.result.data", conversationId: "conversation", output: { filename: "file", mimeType: "text/plain", base64: "YQ==" } });
    const source = { tabId: 41, sessionId: "frame" };
    await (h.executor as any).handleCommandEvent(source, "Page.fileChooserOpened", { backendNodeId: 77, mode: "selectSingle" });
    const event: any = await h.executor.waitEvent({ subscriptionId: subscription.subscriptionId }, undefined, owner);
    const chooserId = event.events[0].payload.chooserId;
    await (h.executor as any).handleCommandEvent(source, "Page.frameNavigated", { frame: { id: "frame" } });
    await expect(h.executor.uploadChooser({ chooserId, artifactId: artifact!.id }, undefined, owner)).rejects.toThrow("unavailable");
    await h.executor.endRun();
    await expect(h.executor.uploadChooser({ chooserId, artifactId: artifact!.id }, undefined, owner)).rejects.toThrow("expired");
    expect(h.fake.debuggerApi.sendCommand).not.toHaveBeenCalledWith(expect.anything(), "Runtime.callFunctionOn", expect.anything());
    h.executor.dispose();
  });

  it.each(["same-process", "cross-process"])("retains a chooser when an unrelated %s sibling navigates", async (kind) => {
    const h = programHarness(async () => undefined);
    await h.executor.beginRun();
    const subscription: any = await h.executor.subscribeEvent({ kind: "filechooser" }, undefined, owner);
    const artifact = await h.logger.append({ type: "tool.result.data", conversationId: "conversation", output: { filename: "file", mimeType: "text/plain", base64: "YQ==" } });
    const runtime = (h.executor as any).automation;
    const session = { frameParents: new Map(), frames: new Map() };
    runtime.sessions.set(41, session);
    const root = { tabId: 41 }, sibling = kind === "same-process" ? root : { tabId: 41, sessionId: "sibling" };
    const chooserSource = kind === "same-process" ? root : { tabId: 41, sessionId: "chooser" };
    for (const [frame, parent, debuggee] of [["root", undefined, root], ["sibling", "root", sibling], ["chooser", "root", chooserSource]] as const) {
      session.frameParents.set(frame, parent); session.frames.set(frame, debuggee);
    }
    const opened = { backendNodeId: 77, frameId: "chooser", mode: "selectSingle" };
    runtime.handleEvent(chooserSource, "Page.fileChooserOpened", opened);
    await (h.executor as any).handleCommandEvent(chooserSource, "Page.fileChooserOpened", opened);
    const event: any = await h.executor.waitEvent({ subscriptionId: subscription.subscriptionId }, undefined, owner);
    const chooserId = event.events[0].payload.chooserId;
    const navigation = { frame: { id: "sibling", parentId: "root" } };
    await (h.executor as any).handleCommandEvent(sibling, "Page.frameNavigated", navigation);
    h.fake.debuggerApi.sendCommand.mockImplementation(async (_source: any, method: string) => method === "DOM.resolveNode"
      ? { object: { objectId: "input-object" } } : { result: { value: null } });
    await expect(h.executor.uploadChooser({ chooserId, artifactId: artifact!.id }, undefined, owner)).resolves.toMatchObject({ state: "completed" });
    runtime.sessions.delete(41);
    await h.executor.endRun(); h.executor.dispose();
  });

  it("invalidates a nested chooser when its ancestor frame navigates", async () => {
    const h = programHarness(async () => undefined);
    await h.executor.beginRun();
    const subscription: any = await h.executor.subscribeEvent({ kind: "filechooser" }, undefined, owner);
    const artifact = await h.logger.append({ type: "tool.result.data", conversationId: "conversation", output: { filename: "file", mimeType: "text/plain", base64: "YQ==" } });
    const runtime = (h.executor as any).automation, session = { frameParents: new Map(), frames: new Map() };
    runtime.sessions.set(41, session);
    const root = { tabId: 41 }, parent = { tabId: 41, sessionId: "parent" }, child = { tabId: 41, sessionId: "child" };
    for (const [frame, ancestor, debuggee] of [["root", undefined, root], ["parent", "root", parent], ["child", "parent", child]] as const) {
      session.frameParents.set(frame, ancestor); session.frames.set(frame, debuggee);
    }
    const opened = { backendNodeId: 77, frameId: "child", mode: "selectSingle" };
    runtime.handleEvent(child, "Page.fileChooserOpened", opened);
    await (h.executor as any).handleCommandEvent(child, "Page.fileChooserOpened", opened);
    const event: any = await h.executor.waitEvent({ subscriptionId: subscription.subscriptionId }, undefined, owner);
    const navigation = { frame: { id: "parent", parentId: "root" } };
    await (h.executor as any).handleCommandEvent(parent, "Page.frameNavigated", navigation);
    await expect(h.executor.uploadChooser({ chooserId: event.events[0].payload.chooserId, artifactId: artifact!.id }, undefined, owner)).rejects.toThrow("unavailable");
    runtime.sessions.delete(41);
    await h.executor.endRun(); h.executor.dispose();
  });

  it("uses target ancestry conservatively when OOPIF frame parents are unavailable", async () => {
    const h = programHarness(async () => undefined);
    const runtime = (h.executor as any).automation;
    const session = { frameParents: new Map(), frames: new Map(), targetParents: new Map() };
    runtime.sessions.set(41, session);
    const root = { tabId: 41 }, a = { tabId: 41, sessionId: "a" }, b = { tabId: 41, sessionId: "b" }, c = { tabId: 41, sessionId: "c" };
    session.frames.set("a-frame", a); session.frames.set("b-frame", b); session.frames.set("c-frame", c);
    session.targetParents.set("a", undefined); session.targetParents.set("b", "a"); session.targetParents.set("c", undefined);
    const chooser = { frameId: "nested-frame", source: b };
    expect(runtime.chooserAffected(root, "Target.detachedFromTarget", { sessionId: "a" }, chooser)).toBe(true);
    expect(runtime.chooserAffected(root, "Target.detachedFromTarget", { sessionId: "c" }, chooser)).toBe(false);
    expect(runtime.chooserAffected(root, "Target.detachedFromTarget", { sessionId: "a" }, { frameId: "same-process-child", source: a })).toBe(true);
    session.targetParents.delete("b");
    expect(runtime.chooserAffected(root, "Target.detachedFromTarget", { sessionId: "c" }, chooser)).toBe(true);
    runtime.sessions.delete(41); h.executor.dispose();
  });

  it("never substitutes a later chooser when the same input opens twice", async () => {
    const h = programHarness(async () => undefined);
    await h.executor.beginRun();
    const subscription: any = await h.executor.subscribeEvent({ kind: "filechooser" }, undefined, owner);
    const automation = (h.executor as any).automation;
    const source = { tabId: 41 };
    const params = { backendNodeId: 77, mode: "selectSingle" };
    automation.handleEvent(source, "Page.fileChooserOpened", params);
    await (h.executor as any).handleCommandEvent(source, "Page.fileChooserOpened", params);
    const first = automation.currentChooser(source, 77);
    const prior: any = await h.executor.waitEvent({ subscriptionId: subscription.subscriptionId }, undefined, owner);
    automation.handleEvent(source, "Page.fileChooserOpened", params);
    await (h.executor as any).handleCommandEvent(source, "Page.fileChooserOpened", params);
    const second = automation.currentChooser(source, 77);
    const next: any = await h.executor.waitEvent({ subscriptionId: subscription.subscriptionId, after: prior.nextCursor }, undefined, owner);
    expect(next.events[0].payload.chooserId).not.toBe(prior.events[0].payload.chooserId);
    expect(first).not.toBe(second);
    expect(() => automation.options.claimChooser(first)).toThrow("unavailable");
    const claim = automation.options.claimChooser(second);
    expect(() => claim.assert()).not.toThrow();
    claim.finish("not-dispatched");
    await h.executor.endRun(); h.executor.dispose();
  });

  it("does not dispatch an old chooser after its run ends while artifact reading is pending", async () => {
    const h = programHarness(async () => undefined);
    await h.executor.beginRun();
    const subscription: any = await h.executor.subscribeEvent({ kind: "filechooser" }, undefined, owner);
    const artifact = await h.logger.append({ type: "tool.result.data", conversationId: "conversation", output: { filename: "file", mimeType: "text/plain", base64: "YQ==" } });
    await (h.executor as any).handleCommandEvent({ tabId: 41 }, "Page.fileChooserOpened", { backendNodeId: 77, mode: "selectSingle" });
    const event: any = await h.executor.waitEvent({ subscriptionId: subscription.subscriptionId }, undefined, owner);
    const chooserId = event.events[0].payload.chooserId;
    const result = h.logger.result.bind(h.logger);
    let resume!: () => void;
    const held = new Promise<void>((resolve) => { resume = resolve; });
    const read = vi.spyOn(h.logger, "result").mockImplementationOnce(async (...args) => { await held; return result(...args); });
    const pending = h.executor.uploadChooser({ chooserId, artifactId: artifact!.id }, undefined, owner);
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    await h.executor.endRun();
    resume();
    await expect(pending).rejects.toThrow("run-ended");
    expect(h.fake.debuggerApi.sendCommand).not.toHaveBeenCalledWith(expect.anything(), "Runtime.callFunctionOn", expect.anything());
    h.executor.dispose();
  });

  it("subscribes after page readiness and routes CDP events by kind and owner", async () => {
    const h = programHarness(async () => undefined);
    await h.executor.beginRun();
    let ready!: () => void;
    const original = (h.executor as any).pageFor;
    (h.executor as any).pageFor = vi.fn(async (state: unknown) => { await new Promise<void>((resolve) => { ready = resolve; }); return original(state); });
    const creating = h.executor.subscribeEvent({ kind: "request" }, undefined, owner) as Promise<any>;
    await vi.waitFor(() => expect(ready).toBeTypeOf("function"));
    let completed = false;
    void creating.then(() => { completed = true; });
    expect(completed).toBe(false);
    ready();
    const subscription = await creating;
    expect(subscription).toMatchObject({ tabId: 41, kind: "request", cursor: 0 });
    const pending = h.executor.waitEvent({ subscriptionId: subscription.subscriptionId, waitMs: 5_000 }, undefined, owner);
    await (h.executor as any).handleCommandEvent({ tabId: 42 }, "Network.requestWillBeSent", { requestId: "wrong", request: { url: "https://other.test" } });
    await (h.executor as any).handleCommandEvent({ tabId: 41, sessionId: "child" }, "Network.requestWillBeSent", { requestId: "request-1", request: { url: "https://example.test" } });
    expect(await pending).toMatchObject({ events: [{ kind: "request", source: { tabId: 41, sessionId: "child" }, payload: { requestId: "request-1" } }] });
    expect(() => h.executor.waitEvent({ subscriptionId: subscription.subscriptionId }, undefined, otherOwner)).toThrow("ownership expired");
    await h.executor.unsubscribeEvent({ subscriptionId: subscription.subscriptionId }, undefined, owner);
    await expect(h.executor.waitEvent({ subscriptionId: subscription.subscriptionId }, undefined, owner)).rejects.toThrow("unavailable");
    await h.executor.endRun(); h.executor.dispose();
  });

  it("handles a dialog in its source session while a background program occupies the action queue", async () => {
    let finish!: () => void;
    const h = programHarness(async () => new Promise<void>((resolve) => { finish = resolve; }));
    await h.executor.beginRun();
    const subscription: any = await h.executor.subscribeEvent({ kind: "dialog" }, undefined, owner);
    const job: any = await h.run(undefined, { background: true });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    const waiting = h.executor.waitEvent({ subscriptionId: subscription.subscriptionId, waitMs: 5_000 }, undefined, owner);
    await (h.executor as any).handleCommandEvent({ tabId: 41, sessionId: "frame" }, "Page.javascriptDialogOpening", { type: "prompt", message: "Name?", defaultPrompt: "Ada" });
    const event: any = await waiting;
    const dialogId = event.events[0].payload.dialogId;
    h.fake.debuggerApi.sendCommand.mockImplementation(async (_source: any, method: string) => {
      if (method === "Page.handleJavaScriptDialog") expect(h.events.some((entry) => entry.type === "browser.dialog.progress" && (entry.content as any)?.state === "dispatched-unknown")).toBe(true);
      return {};
    });
    await expect(h.executor.handleDialog({ dialogId, accept: true, prompt: "Grace" }, undefined, owner)).resolves.toMatchObject({ accepted: true, state: "completed" });
    expect(h.fake.debuggerApi.sendCommand).toHaveBeenCalledWith({ tabId: 41, sessionId: "frame" }, "Page.handleJavaScriptDialog", { accept: true, promptText: "Grace" });
    expect(h.events.filter((entry) => entry.type === "browser.dialog.progress").map((entry) => (entry.content as any).state)).toEqual(["dispatched-unknown", "completed"]);
    finish();
    await vi.waitFor(async () => {
      const terminal = await h.executor.queryJobs({ action: "status", id: job.jobId }, undefined, owner);
      expect(terminal).toMatchObject({ terminal: true, ok: true });
    });
    await h.executor.endRun(); h.executor.dispose();
  });

  it.each(["tool", "run"] as const)("cancels a dialog intent stalled in persistence using the %s signal", async (source) => {
    const h = programHarness(async () => undefined);
    await h.executor.beginRun();
    const subscription: any = await h.executor.subscribeEvent({ kind: "dialog" }, undefined, owner);
    await (h.executor as any).handleCommandEvent({ tabId: 41 }, "Page.javascriptDialogOpening", { type: "confirm", message: "Proceed?" });
    const event: any = await h.executor.waitEvent({ subscriptionId: subscription.subscriptionId }, undefined, owner);
    const dialogId = event.events[0].payload.dialogId;
    const append = h.logger.append.bind(h.logger);
    let resume!: () => void; let entered!: () => void; let heldOnce = false;
    const hold = new Promise<void>((resolve) => { resume = resolve; });
    const writing = new Promise<void>((resolve) => { entered = resolve; });
    vi.spyOn(h.logger, "append").mockImplementation(async (record) => {
      if (!heldOnce && record.type === "browser.dialog.progress" && (record.content as any)?.state === "dispatched-unknown") { heldOnce = true; entered(); await hold; }
      return append(record);
    });
    const tool = new AbortController(); const run = new AbortController();
    const pending = h.executor.handleDialog({ dialogId, accept: true }, tool.signal, { ...owner, runSignal: run.signal });
    await writing; (source === "tool" ? tool : run).abort("cancelled");
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(h.fake.debuggerApi.sendCommand).not.toHaveBeenCalledWith(expect.anything(), "Page.handleJavaScriptDialog", expect.anything());
    // The unsent first claim is released; a later legitimate attempt may win.
    await expect(h.executor.handleDialog({ dialogId, accept: false }, undefined, owner)).resolves.toMatchObject({ state: "completed" });
    resume();
    await vi.waitFor(() => expect(h.events.filter((entry) => entry.type === "browser.dialog.progress").map((entry) => fromLogValue(entry.content))).toContainEqual(expect.objectContaining({ state: "not-dispatched", claimId: 1 })));
    const records = h.events.filter((entry) => entry.type === "browser.dialog.progress").map((entry) => fromLogValue(entry.content) as any);
    expect(records.filter((entry) => entry.claimId === 1).map((entry) => entry.state)).toEqual(["dispatched-unknown", "not-dispatched"]);
    expect(records.filter((entry) => entry.claimId === 2).map((entry) => entry.state)).toEqual(["dispatched-unknown", "completed"]);
    expect(h.fake.debuggerApi.sendCommand.mock.calls.filter(([, method]) => method === "Page.handleJavaScriptDialog")).toHaveLength(1);
    await h.executor.endRun(); h.executor.dispose();
  });

  it("does not dispatch an old dialog claim after its dialog closes and another opens", async () => {
    const h = programHarness(async () => undefined);
    await h.executor.beginRun();
    const subscription: any = await h.executor.subscribeEvent({ kind: "dialog" }, undefined, owner);
    const source = { tabId: 41, sessionId: "frame" };
    await (h.executor as any).handleCommandEvent(source, "Page.javascriptDialogOpening", { type: "confirm", message: "First" });
    const first: any = await h.executor.waitEvent({ subscriptionId: subscription.subscriptionId }, undefined, owner);
    const append = h.logger.append.bind(h.logger);
    let resume!: () => void; let entered!: () => void; let heldOnce = false;
    const hold = new Promise<void>((resolve) => { resume = resolve; }); const writing = new Promise<void>((resolve) => { entered = resolve; });
    vi.spyOn(h.logger, "append").mockImplementation(async (record) => {
      if (!heldOnce && record.type === "browser.dialog.progress" && (record.content as any)?.state === "dispatched-unknown") { heldOnce = true; entered(); await hold; }
      return append(record);
    });
    const pending = h.executor.handleDialog({ dialogId: first.events[0].payload.dialogId, accept: true }, undefined, owner);
    await writing;
    await (h.executor as any).handleCommandEvent(source, "Page.javascriptDialogClosed", {});
    await (h.executor as any).handleCommandEvent(source, "Page.javascriptDialogOpening", { type: "confirm", message: "Second" });
    const second: any = await h.executor.waitEvent({ subscriptionId: subscription.subscriptionId, after: first.nextCursor }, undefined, owner);
    resume(); await expect(pending).rejects.toThrow("unavailable");
    expect(h.fake.debuggerApi.sendCommand).not.toHaveBeenCalledWith(expect.anything(), "Page.handleJavaScriptDialog", expect.anything());
    await expect(h.executor.handleDialog({ dialogId: second.events[0].payload.dialogId, accept: false }, undefined, owner)).resolves.toMatchObject({ state: "completed" });
    const records = h.events.filter((entry) => entry.type === "browser.dialog.progress").map((entry) => fromLogValue(entry.content) as any);
    expect(records.filter((entry) => entry.dialogId === first.events[0].payload.dialogId).map((entry) => entry.state)).toEqual(["dispatched-unknown", "not-dispatched"]);
    await h.executor.endRun(); h.executor.dispose();
  });

  it.each(["tool", "run"] as const)("does not retry an in-flight dialog command cancelled by the %s signal", async (source) => {
    const h = programHarness(async () => undefined);
    await h.executor.beginRun();
    const subscription: any = await h.executor.subscribeEvent({ kind: "dialog" }, undefined, owner);
    await (h.executor as any).handleCommandEvent({ tabId: 41 }, "Page.javascriptDialogOpening", { type: "confirm", message: "Proceed?" });
    const event: any = await h.executor.waitEvent({ subscriptionId: subscription.subscriptionId }, undefined, owner);
    const dialogId = event.events[0].payload.dialogId;
    let resume!: () => void; let entered!: () => void;
    const hold = new Promise<void>((resolve) => { resume = resolve; }); const sending = new Promise<void>((resolve) => { entered = resolve; });
    h.fake.debuggerApi.sendCommand.mockImplementation(async (_debuggee, method) => { if (method === "Page.handleJavaScriptDialog") { entered(); await hold; } return {}; });
    const tool = new AbortController(); const run = new AbortController();
    const pending = h.executor.handleDialog({ dialogId, accept: true }, tool.signal, { ...owner, runSignal: run.signal });
    await sending; (source === "tool" ? tool : run).abort("cancelled");
    await expect(pending).rejects.toMatchObject({ name: "AbortError", effectUnknown: true });
    await expect(h.executor.handleDialog({ dialogId, accept: true }, undefined, owner)).rejects.toThrow("uncertain");
    resume(); await Promise.resolve();
    expect(h.fake.debuggerApi.sendCommand.mock.calls.filter(([, method]) => method === "Page.handleJavaScriptDialog")).toHaveLength(1);
    const records = h.events.filter((entry) => entry.type === "browser.dialog.progress").map((entry) => fromLogValue(entry.content) as any);
    expect(records.map((entry) => entry.state)).toEqual(["dispatched-unknown"]);
    await h.executor.endRun(); h.executor.dispose();
  });

  it.each(["tool", "run"] as const)("cancels a dialog response during completion persistence using the %s signal", async (source) => {
    const h = programHarness(async () => undefined);
    await h.executor.beginRun();
    const subscription: any = await h.executor.subscribeEvent({ kind: "dialog" }, undefined, owner);
    await (h.executor as any).handleCommandEvent({ tabId: 41 }, "Page.javascriptDialogOpening", { type: "confirm", message: "Proceed?" });
    const event: any = await h.executor.waitEvent({ subscriptionId: subscription.subscriptionId }, undefined, owner);
    const dialogId = event.events[0].payload.dialogId;
    const append = h.logger.append.bind(h.logger);
    let resume!: () => void; let entered!: () => void;
    const hold = new Promise<void>((resolve) => { resume = resolve; }); const writing = new Promise<void>((resolve) => { entered = resolve; });
    vi.spyOn(h.logger, "append").mockImplementation(async (record) => {
      if (record.type === "browser.dialog.progress" && (record.content as any)?.state === "completed") { entered(); await hold; }
      return append(record);
    });
    const tool = new AbortController(); const run = new AbortController();
    const pending = h.executor.handleDialog({ dialogId, accept: true }, tool.signal, { ...owner, runSignal: run.signal });
    await writing; (source === "tool" ? tool : run).abort("cancelled");
    await expect(pending).rejects.toMatchObject({ name: "AbortError", effectUnknown: true });
    await expect(h.executor.handleDialog({ dialogId, accept: true }, undefined, owner)).rejects.toThrow("unavailable");
    resume(); await vi.waitFor(() => expect(h.events.filter((entry) => entry.type === "browser.dialog.progress").map((entry) => (fromLogValue(entry.content) as any).state)).toEqual(["dispatched-unknown", "completed"]));
    expect(h.fake.debuggerApi.sendCommand.mock.calls.filter(([, method]) => method === "Page.handleJavaScriptDialog")).toHaveLength(1);
    await h.executor.endRun(); h.executor.dispose();
  });

  it("rejects invalid prompt and refuses replay after an uncertain dialog response", async () => {
    const h = programHarness(async () => undefined);
    await h.executor.beginRun();
    const subscription: any = await h.executor.subscribeEvent({ kind: "dialog" }, undefined, owner);
    await (h.executor as any).handleCommandEvent({ tabId: 41 }, "Page.javascriptDialogOpening", { type: "confirm", message: "Proceed?" });
    const event: any = await h.executor.waitEvent({ subscriptionId: subscription.subscriptionId }, undefined, owner);
    const dialogId = event.events[0].payload.dialogId;
    await expect(h.executor.handleDialog({ dialogId, accept: true, prompt: "invalid" }, undefined, owner)).rejects.toThrow("invalid-dialog-prompt");
    expect(h.fake.debuggerApi.sendCommand).not.toHaveBeenCalled();
    h.fake.debuggerApi.sendCommand.mockRejectedValueOnce(new Error("bridge disconnected"));
    await expect(h.executor.handleDialog({ dialogId, accept: true }, undefined, owner)).rejects.toMatchObject({ message: "bridge disconnected", effectUnknown: true });
    await expect(h.executor.handleDialog({ dialogId, accept: true }, undefined, owner)).rejects.toThrow("uncertain");
    expect(h.fake.debuggerApi.sendCommand).toHaveBeenCalledTimes(1);
    await h.executor.endRun(); h.executor.dispose();
  });

  it("prevents program and independent tool from responding to the same dialog", async () => {
    const h = programHarness(async () => undefined);
    await h.executor.beginRun();
    const subscription: any = await h.executor.subscribeEvent({ kind: "dialog" }, undefined, owner);
    const source = { tabId: 41, sessionId: "frame" };
    await (h.executor as any).handleCommandEvent(source, "Page.javascriptDialogOpening", { type: "confirm", message: "Proceed?" });
    const event: any = await h.executor.waitEvent({ subscriptionId: subscription.subscriptionId }, undefined, owner);
    let complete!: () => void;
    h.fake.debuggerApi.sendCommand.mockImplementation(async (_debuggee, method) => method === "Page.handleJavaScriptDialog" ? new Promise<void>((resolve) => { complete = resolve; }) : {});
    const handling = (h.executor as any).bridgeCommand(source, "Page.handleJavaScriptDialog", { accept: true });
    await vi.waitFor(() => expect(complete).toBeTypeOf("function"));
    await expect(h.executor.handleDialog({ dialogId: event.events[0].payload.dialogId, accept: true }, undefined, owner)).rejects.toThrow("handling");
    complete();
    await handling;
    expect(h.fake.debuggerApi.sendCommand.mock.calls.filter(([, method]) => method === "Page.handleJavaScriptDialog")).toHaveLength(1);
    await h.executor.endRun(); h.executor.dispose();
  });

  it("does not allow an old dialogClosed event to invalidate a later dialog", async () => {
    const h = programHarness(async () => undefined);
    await h.executor.beginRun();
    const subscription: any = await h.executor.subscribeEvent({ kind: "dialog" }, undefined, owner);
    const source = { tabId: 41, sessionId: "frame" };
    await (h.executor as any).handleCommandEvent(source, "Page.javascriptDialogOpening", { type: "confirm", message: "First" });
    const first: any = await h.executor.waitEvent({ subscriptionId: subscription.subscriptionId }, undefined, owner);
    await h.executor.handleDialog({ dialogId: first.events[0].payload.dialogId, accept: true }, undefined, owner);
    await (h.executor as any).handleCommandEvent(source, "Page.javascriptDialogOpening", { type: "confirm", message: "Second" });
    await (h.executor as any).handleCommandEvent(source, "Page.javascriptDialogClosed", {});
    const second: any = await h.executor.waitEvent({ subscriptionId: subscription.subscriptionId, after: 1 }, undefined, owner);
    await expect(h.executor.handleDialog({ dialogId: second.events[0].payload.dialogId, accept: false }, undefined, owner)).resolves.toMatchObject({ accepted: false });
    await h.executor.endRun(); h.executor.dispose();
  });

  it("does not install a late subscription after its run ends while page attachment is pending", async () => {
    const h = programHarness(async () => undefined);
    await h.executor.beginRun();
    let ready!: () => void;
    (h.executor as any).pageFor = vi.fn(async () => { await new Promise<void>((resolve) => { ready = resolve; }); return h.raw; });
    const creating = h.executor.subscribeEvent({ kind: "dialog" }, undefined, owner);
    await vi.waitFor(() => expect(ready).toBeTypeOf("function"));
    await h.executor.endRun();
    ready();
    await expect(creating).rejects.toThrow("event-owner-expired");
    expect((h.executor as any).eventOwner).toBeUndefined();
    h.executor.dispose();
  });

  it("invalidates a child-frame dialog on CDP target detach", async () => {
    const h = programHarness(async () => undefined);
    await h.executor.beginRun();
    const subscription: any = await h.executor.subscribeEvent({ kind: "dialog" }, undefined, owner);
    await (h.executor as any).handleCommandEvent({ tabId: 41, sessionId: "child" }, "Page.javascriptDialogOpening", { type: "confirm", message: "Question" });
    const observed: any = await h.executor.waitEvent({ subscriptionId: subscription.subscriptionId }, undefined, owner);
    await (h.executor as any).handleCommandEvent({ tabId: 41 }, "Target.detachedFromTarget", { sessionId: "child" });
    await expect(h.executor.handleDialog({ dialogId: observed.events[0].payload.dialogId, accept: true }, undefined, owner)).rejects.toThrow("unavailable");
    expect(h.fake.debuggerApi.sendCommand).not.toHaveBeenCalled();
    await h.executor.endRun(); h.executor.dispose();
  });

  it("rejects old run contexts after endRun, including after a new run begins", async () => {
    const h = programHarness(async () => undefined);
    await h.executor.beginRun();
    await h.executor.subscribeEvent({ kind: "dialog" }, undefined, owner);
    await h.executor.endRun();
    // The coordinator can still hold the old lease while cleanup returns.
    await expect(h.executor.subscribeEvent({ kind: "dialog" }, undefined, owner)).rejects.toThrow("event-owner-expired");
    h.setRunIdentity(undefined);
    await expect(h.executor.subscribeEvent({ kind: "dialog" }, undefined, owner)).rejects.toThrow("event-owner-expired");
    h.setRunIdentity({ runId: "next-run", ownerId: "next-owner", generation: 2 });
    await h.executor.beginRun();
    await expect(h.executor.subscribeEvent({ kind: "dialog" }, undefined, owner)).rejects.toThrow("event-owner-expired");
    const nextOwner = { conversationId: "conversation", logIdentity: { runId: "next-run", toolCallId: "1:next", toolCallIdCanonical: true as const } };
    await expect(h.executor.subscribeEvent({ kind: "dialog" }, undefined, nextOwner)).resolves.toMatchObject({ kind: "dialog", tabId: 41 });
    await h.executor.endRun(); h.executor.dispose();
  });

  it("wakes pending readers and unregisters popup and tab listeners when the run ends", async () => {
    const h = programHarness(async () => undefined);
    await h.executor.beginRun();
    let onCreated!: (tab: chrome.tabs.Tab) => void;
    let onRemoved!: (tabId: number) => void;
    const created = { addListener: vi.fn((listener) => { onCreated = listener; }), removeListener: vi.fn() };
    const removed = { addListener: vi.fn((listener) => { onRemoved = listener; }), removeListener: vi.fn() };
    Object.assign((h.fake.chromeApi as any).tabs, { onCreated: created, onRemoved: removed });
    const subscription: any = await h.executor.subscribeEvent({ kind: "popup" }, undefined, owner);
    onCreated({ id: 50, openerTabId: 41, windowId: 7 } as chrome.tabs.Tab);
    expect(await h.executor.waitEvent({ subscriptionId: subscription.subscriptionId }, undefined, owner)).toMatchObject({ events: [{ kind: "popup", source: { tabId: 41 }, payload: { tabId: 50 } }] });
    const pending = h.executor.waitEvent({ subscriptionId: subscription.subscriptionId, after: 1, waitMs: 5_000 }, undefined, owner);
    onRemoved(41);
    expect(await pending).toMatchObject({ closed: "tab-closed" });
    await h.executor.endRun();
    expect(created.removeListener).toHaveBeenCalledWith(onCreated);
    expect(removed.removeListener).toHaveBeenCalledWith(onRemoved);
    h.executor.dispose();
  });
});

describe("background-job observation fence", () => {
  const context = { conversationId: "conversation" };

  it("keeps completed background jobs fenced until a terminal result is explicitly read", async () => {
    let finish!: () => void;
    const h = programHarness(async () => new Promise<void>((resolve) => { finish = resolve; }));
    await h.executor.beginRun();
    const accepted: any = await h.run(undefined, { background: true });
    expect(h.executor.pendingBackgroundJobs()).toEqual([accepted.jobId]);
    expect(h.executor.acknowledgeBackgroundJob(accepted.jobId, "conversation")).toBe(false);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    finish();
    expect(await (h.executor as any).jobs.completion(accepted.jobId, "conversation")).toMatchObject({ terminal: true, ok: true });
    expect(h.executor.pendingBackgroundJobs()).toEqual([accepted.jobId]);
    await h.executor.queryJobs({ action: "list" }, undefined, context);
    expect(h.executor.pendingBackgroundJobs()).toEqual([accepted.jobId]);
    await expect(h.executor.queryJobs({ action: "status", id: accepted.jobId }, undefined, { conversationId: "other" })).rejects.toThrow("unavailable");
    expect(h.executor.pendingBackgroundJobs()).toEqual([accepted.jobId]);
    expect(await h.executor.queryJobs({ action: "status", id: accepted.jobId }, undefined, context)).toMatchObject({ terminal: true, ok: true });
    expect(h.executor.pendingBackgroundJobs()).toEqual([accepted.jobId]);
    expect(h.executor.acknowledgeBackgroundJob(accepted.jobId, "other")).toBe(false);
    expect(h.executor.pendingBackgroundJobs()).toEqual([accepted.jobId]);
    expect(h.executor.acknowledgeBackgroundJob(accepted.jobId, "conversation")).toBe(true);
    expect(h.executor.pendingBackgroundJobs()).toEqual([]);
    await h.executor.endRun(); h.executor.dispose();
  });

  it("keeps cancelled work fenced until cleanup completes and its terminal result is observed", async () => {
    let finish!: () => void;
    const h = programHarness(async (_capabilities, signal) => {
      await new Promise<void>((resolve) => { finish = resolve; });
      signal.throwIfAborted();
    });
    await h.executor.beginRun();
    const accepted: any = await h.run(undefined, { background: true });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    expect(await h.executor.queryJobs({ action: "cancel", id: accepted.jobId }, undefined, context)).toMatchObject({ terminal: false, cancellationRequested: true });
    expect(h.executor.pendingBackgroundJobs()).toEqual([accepted.jobId]);
    finish();
    expect(await (h.executor as any).jobs.completion(accepted.jobId, "conversation")).toMatchObject({ terminal: true, ok: false });
    expect(h.executor.pendingBackgroundJobs()).toEqual([accepted.jobId]);
    expect(await h.executor.queryJobs({ action: "status", id: accepted.jobId }, undefined, context)).toMatchObject({ terminal: true, ok: false });
    expect(h.executor.pendingBackgroundJobs()).toEqual([accepted.jobId]);
    expect(h.executor.acknowledgeBackgroundJob(accepted.jobId, "conversation")).toBe(true);
    expect(h.executor.pendingBackgroundJobs()).toEqual([]);
    await h.executor.endRun(); h.executor.dispose();
  });

  it("retains the fence for a failed background job until its failure is read", async () => {
    const h = programHarness(async () => { throw new Error("failed after dispatch"); });
    await h.executor.beginRun();
    const accepted: any = await h.run(undefined, { background: true });
    expect(await (h.executor as any).jobs.completion(accepted.jobId, "conversation")).toMatchObject({ terminal: true, ok: false });
    expect(h.executor.pendingBackgroundJobs()).toEqual([accepted.jobId]);
    expect(await h.executor.queryJobs({ action: "wait", id: accepted.jobId, waitMs: 5_000 }, undefined, context)).toMatchObject({ terminal: true, ok: false });
    expect(h.executor.pendingBackgroundJobs()).toEqual([accepted.jobId]);
    expect(h.executor.acknowledgeBackgroundJob(accepted.jobId, "conversation")).toBe(true);
    expect(h.executor.pendingBackgroundJobs()).toEqual([]);
    await h.executor.endRun(); h.executor.dispose();
  });

  it("clears the fence on run end and rejects late background acceptance", async () => {
    const h = programHarness(async () => undefined);
    await h.executor.beginRun();
    const append = h.logger.append.bind(h.logger);
    let resume!: () => void;
    let notify!: () => void;
    const entered = new Promise<void>((resolve) => { notify = resolve; });
    const held = new Promise<void>((resolve) => { resume = resolve; });
    vi.spyOn(h.logger, "append").mockImplementation(async (record) => {
      if (record.type === "browser.job.state" && (record.content as any)?.state === "queued") { notify(); await held; }
      return append(record);
    });
    const creating = h.run(undefined, { background: true });
    await entered;
    const ending = h.executor.endRun();
    expect(h.executor.pendingBackgroundJobs()).toEqual([]);
    h.setRunIdentity({ runId: "next-run", ownerId: "next-owner", generation: 2 });
    let newRunReady = false;
    const beginning = h.executor.beginRun().then((value) => { newRunReady = true; return value; });
    await Promise.resolve();
    expect(newRunReady).toBe(false);
    resume();
    await expect(creating).rejects.toMatchObject({ name: "AbortError" });
    await ending;
    await beginning;
    expect(h.executor.pendingBackgroundJobs()).toEqual([]);
    await expect(h.run(undefined, { background: true })).rejects.toThrow("event-owner-expired");
    const next = await h.executor.runProgram({ code: "fixture program", background: true }, undefined, {
      conversationId: "conversation", logIdentity: { runId: "next-run", toolCallId: "1:next", toolCallIdCanonical: true },
    }) as any;
    expect(h.executor.pendingBackgroundJobs()).toEqual([next.jobId]);
    await h.executor.endRun();
    expect(h.executor.pendingBackgroundJobs()).toEqual([]);
    h.executor.dispose();
  });
});

describe("foreground dialog handoff", () => {
  const context = { conversationId: "conversation", logIdentity: { runId: "run", toolCallId: "1:program", toolCallIdCanonical: true as const } };

  it("hands off a chooser upload whose change handler opens a dialog, then completes the same job", async () => {
    const h = programHarness(async () => undefined);
    await h.executor.beginRun();
    const subscription: any = await h.executor.subscribeEvent({ kind: "filechooser" }, undefined, context);
    const artifact = await h.logger.append({ type: "tool.result.data", conversationId: "conversation", output: { filename: "file.txt", mimeType: "text/plain", base64: "YQ==" } });
    const source = { tabId: 41, sessionId: "frame" };
    await (h.executor as any).handleCommandEvent(source, "Page.fileChooserOpened", { backendNodeId: 77, mode: "selectSingle" });
    const observed: any = await h.executor.waitEvent({ subscriptionId: subscription.subscriptionId }, undefined, context);
    let finish!: () => void;
    h.fake.debuggerApi.sendCommand.mockImplementation(async (_source: any, method: string) => {
      if (method === "DOM.resolveNode") return { object: { objectId: "input" } };
      if (method === "Runtime.callFunctionOn") return new Promise(resolve => { finish = () => resolve({ result: { value: null } }); });
      return {};
    });
    const tool = new AbortController();
    const pending = h.executor.uploadChooser({ chooserId: observed.events[0].payload.chooserId, artifactId: artifact!.id, timeoutMs: 5000 }, tool.signal, context);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    await (h.executor as any).handleCommandEvent(source, "Page.javascriptDialogOpening", { type: "confirm", message: "continue?" });
    const result: any = await pending;
    expect(result).toMatchObject({ accepted: true, complete: false, state: "blocked", blockedBy: { kind: "dialog", source } });
    expect(h.executor.pendingBackgroundJobs()).toContain(result.jobId);
    tool.abort("tool-returned");
    await h.executor.handleDialog({ dialogId: result.blockedBy.dialogId, accept: true }, undefined, context);
    finish();
    await vi.waitFor(async () => expect(await h.executor.queryJobs({ action: "status", id: result.jobId }, undefined, context)).toMatchObject({ terminal: true, ok: true, result: { state: "completed" } }));
    expect(h.fake.debuggerApi.sendCommand.mock.calls.filter((call) => call[1] === "Runtime.callFunctionOn")).toHaveLength(1);
    await h.executor.endRun(); h.executor.dispose();
  });

  it("retains the chooser timeout after a dialog handoff and reports an uncertain effect", async () => {
    const h = programHarness(async () => undefined);
    await h.executor.beginRun();
    const subscription: any = await h.executor.subscribeEvent({ kind: "filechooser" }, undefined, context);
    const artifact = await h.logger.append({ type: "tool.result.data", conversationId: "conversation", output: { filename: "file.txt", mimeType: "text/plain", base64: "YQ==" } });
    await (h.executor as any).handleCommandEvent({ tabId: 41 }, "Page.fileChooserOpened", { backendNodeId: 77, mode: "selectSingle" });
    const observed: any = await h.executor.waitEvent({ subscriptionId: subscription.subscriptionId }, undefined, context);
    let started = false;
    h.fake.debuggerApi.sendCommand.mockImplementation(async (_source: any, method: string) => {
      if (method === "DOM.resolveNode") return { object: { objectId: "input" } };
      if (method === "Runtime.callFunctionOn") { started = true; return new Promise(() => {}); }
      return {};
    });
    const pending = h.executor.uploadChooser({ chooserId: observed.events[0].payload.chooserId, artifactId: artifact!.id, timeoutMs: 200 }, undefined, context);
    await vi.waitFor(() => expect(started).toBe(true));
    await (h.executor as any).handleCommandEvent({ tabId: 41 }, "Page.javascriptDialogOpening", { type: "alert", message: "open" });
    const result: any = await pending;
    expect(result).toMatchObject({ accepted: true, state: "blocked" });
    await vi.waitFor(async () => expect(await h.executor.queryJobs({ action: "status", id: result.jobId }, undefined, context)).toMatchObject({
      terminal: true, ok: false, result: { error: { code: "timeout", effectUnknown: true } },
    }));
    await h.executor.endRun(); h.executor.dispose();
  });

  it.each(["queued", "running"] as const)("returns promptly on tool cancellation while %s job persistence is stalled", async (state) => {
    const h = programHarness(async () => undefined);
    await h.executor.beginRun();
    const subscription: any = await h.executor.subscribeEvent({ kind: "filechooser" }, undefined, context);
    const artifact = await h.logger.append({ type: "tool.result.data", conversationId: "conversation", output: { filename: "file.txt", mimeType: "text/plain", base64: "YQ==" } });
    await (h.executor as any).handleCommandEvent({ tabId: 41 }, "Page.fileChooserOpened", { backendNodeId: 77, mode: "selectSingle" });
    const observed: any = await h.executor.waitEvent({ subscriptionId: subscription.subscriptionId }, undefined, context);
    const append = h.logger.append.bind(h.logger);
    let resume!: () => void; let entered!: () => void;
    const hold = new Promise<void>(resolve => { resume = resolve; });
    const writing = new Promise<void>(resolve => { entered = resolve; });
    vi.spyOn(h.logger, "append").mockImplementation(async (record) => {
      if (record.type === "browser.job.state" && (record.content as any)?.state === state) { entered(); await hold; }
      return append(record);
    });
    const tool = new AbortController();
    const pending = h.executor.uploadChooser({ chooserId: observed.events[0].payload.chooserId, artifactId: artifact!.id }, tool.signal, context);
    await writing;
    tool.abort("tool-cancelled");
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(h.fake.debuggerApi.sendCommand).not.toHaveBeenCalledWith(expect.anything(), "Runtime.callFunctionOn", expect.anything());
    resume();
    await h.executor.endRun();
    expect(h.fake.debuggerApi.sendCommand).not.toHaveBeenCalledWith(expect.anything(), "Runtime.callFunctionOn", expect.anything());
    h.executor.dispose();
  });

  it("returns promptly on run cancellation while the running job receipt is stalled", async () => {
    const h = programHarness(async () => undefined);
    await h.executor.beginRun();
    const subscription: any = await h.executor.subscribeEvent({ kind: "filechooser" }, undefined, context);
    const artifact = await h.logger.append({ type: "tool.result.data", conversationId: "conversation", output: { filename: "file.txt", mimeType: "text/plain", base64: "YQ==" } });
    await (h.executor as any).handleCommandEvent({ tabId: 41 }, "Page.fileChooserOpened", { backendNodeId: 77, mode: "selectSingle" });
    const observed: any = await h.executor.waitEvent({ subscriptionId: subscription.subscriptionId }, undefined, context);
    const append = h.logger.append.bind(h.logger);
    let resume!: () => void; let entered!: () => void;
    const hold = new Promise<void>(resolve => { resume = resolve; });
    const writing = new Promise<void>(resolve => { entered = resolve; });
    vi.spyOn(h.logger, "append").mockImplementation(async (record) => {
      if (record.type === "browser.job.state" && (record.content as any)?.state === "running") { entered(); await hold; }
      return append(record);
    });
    const run = new AbortController();
    const pending = h.executor.uploadChooser({ chooserId: observed.events[0].payload.chooserId, artifactId: artifact!.id }, undefined, { ...context, runSignal: run.signal });
    await writing;
    run.abort("run-cancelled");
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    resume();
    await h.executor.endRun();
    expect(h.fake.debuggerApi.sendCommand).not.toHaveBeenCalledWith(expect.anything(), "Runtime.callFunctionOn", expect.anything());
    h.executor.dispose();
  });

  it("settles the chooser intent as not dispatched if a dialog arrives before dispatch", async () => {
    const h = programHarness(async () => undefined);
    await h.executor.beginRun();
    const subscription: any = await h.executor.subscribeEvent({ kind: "filechooser" }, undefined, context);
    const artifact = await h.logger.append({ type: "tool.result.data", conversationId: "conversation", output: { filename: "file.txt", mimeType: "text/plain", base64: "YQ==" } });
    await (h.executor as any).handleCommandEvent({ tabId: 41 }, "Page.fileChooserOpened", { backendNodeId: 77, mode: "selectSingle" });
    const observed: any = await h.executor.waitEvent({ subscriptionId: subscription.subscriptionId }, undefined, context);
    h.fake.debuggerApi.sendCommand.mockImplementation(async (_source: any, method: string) => method === "DOM.resolveNode" ? { object: { objectId: "input" } } : {});
    const append = h.logger.append.bind(h.logger);
    vi.spyOn(h.logger, "append").mockImplementation(async (record) => {
      const saved = await append(record);
      if (record.type === "browser.chooser.progress" && (record.content as any)?.state === "dispatched-unknown")
        await (h.executor as any).handleCommandEvent({ tabId: 41 }, "Page.javascriptDialogOpening", { type: "alert", message: "open" });
      return saved;
    });
    const pending = h.executor.uploadChooser({ chooserId: observed.events[0].payload.chooserId, artifactId: artifact!.id }, undefined, context);
    await pending.catch(() => undefined);
    await vi.waitFor(() => expect(h.events.filter((entry) => entry.type === "browser.chooser.progress").map((entry) => (entry.content as any).state)).toEqual(["dispatched-unknown", "not-dispatched"]));
    expect(h.fake.debuggerApi.sendCommand).not.toHaveBeenCalledWith(expect.anything(), "Runtime.callFunctionOn", expect.anything());
    await h.executor.endRun(); h.executor.dispose();
  });

  it("settles a late intent write after cancellation without dispatching", async () => {
    const h = programHarness(async () => undefined);
    await h.executor.beginRun();
    const subscription: any = await h.executor.subscribeEvent({ kind: "filechooser" }, undefined, context);
    const artifact = await h.logger.append({ type: "tool.result.data", conversationId: "conversation", output: { filename: "file.txt", mimeType: "text/plain", base64: "YQ==" } });
    await (h.executor as any).handleCommandEvent({ tabId: 41 }, "Page.fileChooserOpened", { backendNodeId: 77, mode: "selectSingle" });
    const observed: any = await h.executor.waitEvent({ subscriptionId: subscription.subscriptionId }, undefined, context);
    h.fake.debuggerApi.sendCommand.mockImplementation(async (_source: any, method: string) => method === "DOM.resolveNode" ? { object: { objectId: "input" } } : {});
    const append = h.logger.append.bind(h.logger);
    let resume!: () => void; let entered!: () => void;
    const hold = new Promise<void>(resolve => { resume = resolve; });
    const writing = new Promise<void>(resolve => { entered = resolve; });
    vi.spyOn(h.logger, "append").mockImplementation(async (record) => {
      if (record.type === "browser.chooser.progress" && (record.content as any)?.state === "dispatched-unknown") { entered(); await hold; }
      return append(record);
    });
    const tool = new AbortController();
    const pending = h.executor.uploadChooser({ chooserId: observed.events[0].payload.chooserId, artifactId: artifact!.id }, tool.signal, context);
    await writing;
    tool.abort("tool-cancelled");
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    resume();
    await vi.waitFor(() => expect(h.events.filter((entry) => entry.type === "browser.chooser.progress").map((entry) => (entry.content as any).state)).toEqual(["dispatched-unknown", "not-dispatched"]));
    expect(h.fake.debuggerApi.sendCommand).not.toHaveBeenCalledWith(expect.anything(), "Runtime.callFunctionOn", expect.anything());
    await h.executor.endRun(); h.executor.dispose();
  });

  it("hands off only a matching active tab with durable evidence and retains the job after the call signal ends", async () => {
    let finish!: () => void;
    const h = programHarness(async ({ page }) => page.goto("https://example.test"));
    h.raw.goto = vi.fn(async () => { await (h.executor as any).programScope.dispatched(); await new Promise<void>(resolve => { finish = resolve; }); return "done"; });
    await h.executor.beginRun();
    const tool = new AbortController(); const run = new AbortController();
    const pending = h.executor.runProgram({ code: "test", timeoutMs: 5000 }, tool.signal, { ...context, runSignal: run.signal });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    await (h.executor as any).handleCommandEvent({ tabId: 42 }, "Page.javascriptDialogOpening", { type: "alert", message: "other" });
    let completed = false; void pending.then(() => { completed = true; });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(completed).toBe(false);
    await (h.executor as any).handleCommandEvent({ tabId: 41, sessionId: "frame" }, "Page.javascriptDialogOpening", { type: "confirm", message: "continue?" });
    const result: any = await pending;
    expect(result).toMatchObject({ accepted: true, complete: false, state: "blocked", blockedBy: { source: { tabId: 41, sessionId: "frame" }, kind: "dialog" } });
    expect(h.events.find(event => event.id === result.blockedBy.evidenceId)).toMatchObject({ type: "browser.job.progress", content: { jobId: result.jobId, state: "blocked" } });
    expect(h.executor.pendingBackgroundJobs()).toContain(result.jobId);
    tool.abort("tool-returned");
    h.fake.debuggerApi.sendCommand.mockResolvedValue({});
    await h.executor.handleDialog({ dialogId: result.blockedBy.dialogId, accept: true }, undefined, context);
    finish();
    await vi.waitFor(async () => expect(await h.executor.queryJobs({ action: "status", id: result.jobId }, undefined, context)).toMatchObject({ terminal: true, ok: true }));
    await h.executor.endRun(); h.executor.dispose();
  });

  it("rejects an already observed open dialog before invoking the page action", async () => {
    const h = programHarness(async ({ page }) => page.goto("https://example.test"));
    await h.executor.beginRun();
    await h.executor.subscribeEvent({ kind: "dialog" }, undefined, context);
    await (h.executor as any).handleCommandEvent({ tabId: 41 }, "Page.javascriptDialogOpening", { type: "alert", message: "open" });
    const result: any = await h.executor.runProgram({ code: "test" }, undefined, context);
    expect(result).toMatchObject({ ok: false, result: { error: { code: "dialog-open" } } });
    expect(h.raw.goto).not.toHaveBeenCalled();
    await h.executor.endRun(); h.executor.dispose();
  });

  it("tracks dynamically selected tabs instead of the initially bound tab", async () => {
    let finish!: () => void;
    const h = programHarness(async ({ browser }) => (await browser.page(42)).goto("https://example.test"));
    h.raw.goto = vi.fn(async () => { await (h.executor as any).programScope.dispatched(); await new Promise<void>(resolve => { finish = resolve; }); });
    await h.executor.beginRun();
    const pending = h.executor.runProgram({ code: "test" }, undefined, context);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    await (h.executor as any).handleCommandEvent({ tabId: 42, sessionId: "child" }, "Page.javascriptDialogOpening", { type: "alert", message: "dynamic" });
    const result: any = await pending;
    expect(result).toMatchObject({ accepted: true, blockedBy: { source: { tabId: 42, sessionId: "child" } } });
    finish(); await h.executor.endRun(); h.executor.dispose();
  });

  it("keeps the handed-off job subject to run cancellation", async () => {
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const h = programHarness(async ({ page }) => page.goto("https://example.test"));
    h.raw.goto = vi.fn(async () => { await (h.executor as any).programScope.dispatched(); started(); await new Promise<void>((_, reject) => {
      const signal = (h.executor as any).programScope.signal as AbortSignal;
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }); });
    await h.executor.beginRun();
    const run = new AbortController();
    const pending = h.executor.runProgram({ code: "test" }, undefined, { ...context, runSignal: run.signal });
    await ready;
    await (h.executor as any).handleCommandEvent({ tabId: 41 }, "Page.javascriptDialogOpening", { type: "alert", message: "open" });
    const result: any = await pending;
    run.abort("run-cancelled");
    await vi.waitFor(async () => expect(await h.executor.queryJobs({ action: "status", id: result.jobId }, undefined, context)).toMatchObject({ terminal: true, state: "cancelled" }));
    await h.executor.endRun(); h.executor.dispose();
  });

  it("lets an in-program dialog subscription complete after a blocked handoff", async () => {
    let send!: (event: unknown) => void; let finish!: () => void;
    const h = programHarness(async ({ page }) => {
      const dialog = page.waitForEvent("dialog");
      const action = page.goto("https://example.test");
      await (await dialog).accept();
      finish();
      return action;
    });
    h.raw.waitForEvent = vi.fn(() => new Promise(resolve => { send = resolve; }));
    h.raw.goto = vi.fn(async () => { await (h.executor as any).programScope.dispatched(); await new Promise<void>(resolve => { finish = resolve; }); return "done"; });
    await h.executor.beginRun();
    const pending = h.executor.runProgram({ code: "test" }, undefined, context);
    await vi.waitFor(() => { expect(send).toBeTypeOf("function"); expect(finish).toBeTypeOf("function"); });
    await (h.executor as any).handleCommandEvent({ tabId: 41 }, "Page.javascriptDialogOpening", { type: "confirm", message: "open" });
    const dialog = { accept: async () => undefined };
    Object.defineProperty(dialog, PROGRAM_EVENT_INVOKE, { value: async (_method: string, _args: unknown[], dispatch: () => Promise<void>) => { await dispatch(); return dialog.accept(); } });
    send(dialog);
    const result: any = await pending;
    expect(result).toMatchObject({ accepted: true, state: "blocked" });
    await vi.waitFor(async () => expect(await h.executor.queryJobs({ action: "status", id: result.jobId }, undefined, context)).toMatchObject({ terminal: true, ok: true, result: "done" }));
    await h.executor.endRun(); h.executor.dispose();
  });


  it("hands off when a program abandons its dialog waiter", async () => {
    let finish!: () => void;
    const h = programHarness(async ({ page }) => {
      void page.waitForEvent("dialog").catch(() => undefined);
      return page.goto("https://example.test");
    });
    h.raw.waitForEvent = (kind: string) => (h.executor as any).automation.waitForEvent(41, kind);
    h.raw.goto = vi.fn(async () => { await (h.executor as any).programScope.dispatched(); await new Promise<void>(resolve => { finish = resolve; }); return "done"; });
    h.fake.debuggerApi.sendCommand.mockImplementation(async (_source, method) => { if (method === "Page.handleJavaScriptDialog") finish(); return {}; });
    await h.executor.beginRun();
    const pending = h.executor.runProgram({ code: "test" }, undefined, context);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    const params = { type: "confirm", message: "open" };
    await (h.executor as any).handleCommandEvent({ tabId: 41 }, "Page.javascriptDialogOpening", params);
    (h.executor as any).automation.handleEvent({ tabId: 41 }, "Page.javascriptDialogOpening", params);
    const result: any = await pending;
    expect(result).toMatchObject({ accepted: true, state: "blocked", blockedBy: { kind: "dialog" } });
    await h.executor.handleDialog({ dialogId: result.blockedBy.dialogId, accept: true }, undefined, context);
    await vi.waitFor(async () => expect(await h.executor.queryJobs({ action: "status", id: result.jobId }, undefined, context)).toMatchObject({ terminal: true, ok: true, result: "done" }));
    await h.executor.endRun(); h.executor.dispose();
  });

  it.each([false, true])("binds a program dialog response to the observed child session (background=%s)", async (background) => {
    let finish!: () => void;
    const h = programHarness(async ({ page }) => {
      const waiting = page.waitForEvent("dialog");
      const action = page.goto("https://example.test");
      await (await waiting).accept("answer");
      return action;
    });
    h.raw.waitForEvent = (kind: string) => (h.executor as any).automation.waitForEvent(41, kind);
    h.raw.goto = vi.fn(async () => { await (h.executor as any).programScope.dispatched(); await new Promise<void>(resolve => { finish = resolve; }); return "done"; });
    h.fake.debuggerApi.sendCommand.mockImplementation(async (_source, method) => { if (method === "Page.handleJavaScriptDialog") finish(); return {}; });
    await h.executor.beginRun();
    const pending = h.executor.runProgram({ code: "test", background }, undefined, context);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    const source = { tabId: 41, sessionId: "child" };
    const params = { type: "prompt", message: "open" };
    await (h.executor as any).handleCommandEvent(source, "Page.javascriptDialogOpening", params);
    (h.executor as any).automation.handleEvent(source, "Page.javascriptDialogOpening", params);
    const result: any = await pending;
    if (result.state === "blocked" || result.state === "queued") await vi.waitFor(async () => expect(await h.executor.queryJobs({ action: "status", id: result.jobId }, undefined, context)).toMatchObject({ terminal: true, ok: true, result: "done" }));
    else expect(result).toMatchObject({ ok: true, result: "done" });
    expect(h.fake.debuggerApi.sendCommand).toHaveBeenCalledWith(source, "Page.handleJavaScriptDialog", { accept: true, promptText: "answer" });
    await h.executor.endRun(); h.executor.dispose();
  });

  it("allows only one dispatch when program and external dialog replies race", async () => {
    const h = programHarness(async () => undefined);
    await h.executor.beginRun();
    await h.executor.subscribeEvent({ kind: "dialog" }, undefined, context);
    (h.executor as any).activeContext = context;
    const automation = (h.executor as any).automation;
    const waiting = automation.waitForEvent(41, "dialog");
    const source = { tabId: 41, sessionId: "child" };
    const params = { type: "prompt", message: "race" };
    await (h.executor as any).handleCommandEvent(source, "Page.javascriptDialogOpening", params);
    automation.handleEvent(source, "Page.javascriptDialogOpening", params);
    const dialog = await waiting;
    let sent!: () => void; let finish!: () => void;
    const sentPromise = new Promise<void>(resolve => { sent = resolve; });
    const held = new Promise<void>(resolve => { finish = resolve; });
    h.fake.debuggerApi.sendCommand.mockImplementation(async (_source, method) => {
      if (method === "Page.handleJavaScriptDialog") { sent(); await held; }
      return {};
    });
    const external = h.executor.handleDialog({ dialogId: (params as any).surfWaxDialogId, accept: true, prompt: "external" }, undefined, context);
    await sentPromise;
    await expect(dialog.accept("program")).rejects.toThrow("handling");
    finish();
    await expect(external).resolves.toMatchObject({ state: "completed" });
    expect(h.fake.debuggerApi.sendCommand.mock.calls.filter(([, method]) => method === "Page.handleJavaScriptDialog")).toHaveLength(1);
    await h.executor.endRun(); h.executor.dispose();
  });

  it("cannot use an old program dialog handle to answer a later dialog", async () => {
    let finish!: () => void; let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const h = programHarness(async ({ page }) => {
      const waiting = page.waitForEvent("dialog");
      const action = page.goto("https://example.test");
      const dialog = await waiting;
      await gate;
      await dialog.accept();
      return action;
    });
    h.raw.waitForEvent = (kind: string) => (h.executor as any).automation.waitForEvent(41, kind);
    h.raw.goto = vi.fn(async () => { await (h.executor as any).programScope.dispatched(); await new Promise<void>(resolve => { finish = resolve; }); return "done"; });
    h.fake.debuggerApi.sendCommand.mockImplementation(async (_source, method) => { if (method === "Page.handleJavaScriptDialog") finish(); return {}; });
    await h.executor.beginRun();
    const pending = h.executor.runProgram({ code: "test" }, undefined, context);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    const source = { tabId: 41, sessionId: "child" };
    const first = { type: "confirm", message: "first" };
    await (h.executor as any).handleCommandEvent(source, "Page.javascriptDialogOpening", first);
    (h.executor as any).automation.handleEvent(source, "Page.javascriptDialogOpening", first);
    const result: any = await pending;
    await h.executor.handleDialog({ dialogId: result.blockedBy.dialogId, accept: true }, undefined, context);
    await (h.executor as any).handleCommandEvent(source, "Page.javascriptDialogClosed", {});
    await (h.executor as any).handleCommandEvent(source, "Page.javascriptDialogOpening", { type: "confirm", message: "second" });
    release();
    await vi.waitFor(async () => expect(await h.executor.queryJobs({ action: "status", id: result.jobId }, undefined, context)).toMatchObject({ terminal: true, ok: false }));
    expect(h.fake.debuggerApi.sendCommand.mock.calls.filter(([, method]) => method === "Page.handleJavaScriptDialog")).toHaveLength(1);
    await h.executor.endRun(); h.executor.dispose();
  });

  it("retains the original timeout after the handoff", async () => {
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const h = programHarness(async ({ page }) => page.goto("https://example.test"));
    h.raw.goto = vi.fn(async () => { await (h.executor as any).programScope.dispatched(); started(); await new Promise<void>((_, reject) => {
      const signal = (h.executor as any).programScope.signal as AbortSignal;
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }); });
    await h.executor.beginRun();
    const pending = h.executor.runProgram({ code: "test", timeoutMs: 200 }, undefined, context);
    await ready;
    await (h.executor as any).handleCommandEvent({ tabId: 41 }, "Page.javascriptDialogOpening", { type: "alert", message: "open" });
    const result: any = await pending;
    await vi.waitFor(async () => expect(await h.executor.queryJobs({ action: "status", id: result.jobId }, undefined, context)).toMatchObject({ terminal: true, ok: false, result: { error: { code: "timeout" } } }));
    await h.executor.endRun(); h.executor.dispose();
  });


  it("checks an observed dialog after the action queue becomes available", async () => {
    const h = programHarness(async ({ page }) => page.goto("https://example.test"));
    await h.executor.beginRun();
    await h.executor.subscribeEvent({ kind: "dialog" }, undefined, context);
    let release!: () => void;
    (h.executor as any).tail = new Promise<void>(resolve => { release = resolve; });
    const pending = h.executor.runProgram({ code: "test" }, undefined, context);
    await (h.executor as any).handleCommandEvent({ tabId: 41 }, "Page.javascriptDialogOpening", { type: "alert", message: "opened while queued" });
    release();
    expect(await pending).toMatchObject({ ok: false, result: { error: { code: "dialog-open" } } });
    expect(h.raw.goto).not.toHaveBeenCalled();
    await h.executor.endRun(); h.executor.dispose();
  });

  it("does not publish a pending job when blocker evidence cannot be persisted", async () => {
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const h = programHarness(async ({ page }) => page.goto("https://example.test"));
    h.raw.goto = vi.fn(async () => { await (h.executor as any).programScope.dispatched(); started(); await new Promise<void>((_, reject) => {
      const signal = (h.executor as any).programScope.signal as AbortSignal;
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }); });
    const append = h.logger.append.bind(h.logger);
    vi.spyOn(h.logger, "append").mockImplementation(async event => {
      if (event.type === "browser.job.progress" && (event.content as any)?.state === "blocked") throw new Error("disk failed");
      return append(event);
    });
    await h.executor.beginRun();
    const pending = h.executor.runProgram({ code: "test" }, undefined, context);
    await ready;
    await (h.executor as any).handleCommandEvent({ tabId: 41 }, "Page.javascriptDialogOpening", { type: "alert", message: "open" });
    await expect(pending).rejects.toMatchObject({ message: "Could not persist dialog blocker evidence", effectUnknown: true });
    expect(h.executor.pendingBackgroundJobs()).toEqual([]);
    await h.executor.endRun(); h.executor.dispose();
  });

});
