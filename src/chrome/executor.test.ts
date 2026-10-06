import { afterEach, describe, expect, it, vi } from "vitest";
import { EventLogger, fromLogValue, type LogEvent } from "../logging";
import { ChromeExecutor } from "./executor";
import { ProgramScope } from "./program";
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
function programHarness(work: (capabilities: any, signal: AbortSignal) => Promise<unknown>, fake = fakeChrome()) {
  const log = memoryLog();
  const tabs = [{ id: 41, windowId: 7, active: true, title: "Current" }, { id: 42, windowId: 7, active: false }, { id: 99, windowId: 9 }] as chrome.tabs.Tab[];
  Object.assign(fake.chromeApi, {
    windows: { getCurrent: vi.fn(async () => ({ id: 7, tabs })), get: vi.fn(async () => ({ id: 7 })), update: vi.fn(), create: vi.fn(), remove: vi.fn() },
    tabs: { get: vi.fn(async (id: number) => tabs.find(tab => tab.id === id)), query: vi.fn(async () => tabs.filter(tab => tab.windowId === 7)),
      update: vi.fn(async (id: number) => { tabs.forEach(tab => { tab.active = tab.id === id; }); }),
      create: vi.fn(async (input: any) => { const tab = { id: 43, ...input }; tabs.push(tab); return tab; }),
      remove: vi.fn(async (id: number) => { const index = tabs.findIndex(tab => tab.id === id); if (index >= 0) tabs.splice(index, 1); }),
    },
  });
  const executor = new ChromeExecutor({ chromeApi: fake.chromeApi as never, logger: log.logger, programHost: async (_code, caps, signal) => work(caps, signal) });
  const raw: any = {
    tabId: 41, inspect: vi.fn(async () => ({ snapshot: "Current [ref=t41d1e1]" })),
    url: vi.fn(async () => "https://example.com"), title: vi.fn(async () => "Current"),
    observe: vi.fn(async () => ({ observationId: "capture", documentId: 1, url: "https://example.com", title: "Current", viewport: {}, screenshot: { data: "eA==", width: 1, height: 1, scale: 1, origin: { x: 0, y: 0 } } })),
    goto: vi.fn(async (url: string) => { await (executor as any).programScope.dispatched(); return { performed: true, url }; }),
    evaluate: vi.fn(async () => { await (executor as any).programScope.dispatched(); return 42; }),
  };
  (executor as any).pageFor = vi.fn(async (state: any) => ({ ...raw, tabId: state.tabId }));
  return { ...log, fake, tabs, raw, executor, run: (signal?: AbortSignal, input: { timeoutMs?: number; background?: boolean } = {}) => executor.runProgram({ code: "fixture program", ...input }, signal, { conversationId: "conversation", visualEnabled: true }) };
}

describe("ChromeExecutor programs", () => {
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
  it.each(["screenshot", "pdf"] as const)("keeps the ten-second foreground timeout while saving %s", async (name) => {
    vi.useFakeTimers();
    const h = programHarness(async ({ page }) => name === "screenshot" ? page.screenshot({ save: true }) : page.pdf({ save: true }));
    h.fake.debuggerApi.sendCommand.mockImplementation(async (_debuggee, method) => method === "Page.printToPDF" ? { data: "eA==" } : {});
    let finish!: () => void;
    h.fake.chromeApi.downloads.download.mockImplementationOnce(() => new Promise<number>(resolve => { finish = () => resolve(17); }));
    const pending = h.run();
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    await vi.advanceTimersByTimeAsync(10000);
    expect(await pending).toMatchObject({ ok: false, result: { error: { code: "timeout", effectUnknown: true } } });
    finish(); await (h.executor as any).tail; h.executor.dispose();
    await vi.advanceTimersByTimeAsync(1); expect(vi.getTimerCount()).toBe(0);
  });
  it("selects a stable tab without focusing or creating a Chrome window", async () => {
    const h = programHarness(async ({ browser }) => browser.tabs.select(42));
    expect(await h.run()).toMatchObject({ ok: true, result: [{ id: 41, current: false }, { id: 42, current: true }] });
    expect((h.fake.chromeApi as any).tabs.update).toHaveBeenCalledWith(42, { active: true });
    expect((h.fake.chromeApi as any).windows.update).not.toHaveBeenCalled(); h.executor.dispose();
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
  it("selects IDs after reorder, rejects foreign/missing tabs, and exposes no legacy routing methods", async () => {
    let tabId = 41; const h = programHarness(async ({ browser }) => browser.tabs.select(tabId));
    h.tabs.reverse(); expect(await h.run()).toMatchObject({ ok: true });
    expect((h.fake.chromeApi as any).tabs.update).toHaveBeenCalledWith(41, { active: true });
    for (const invalid of [99, 999]) { tabId = invalid; expect(await h.run()).toMatchObject({ ok: false, result: { error: { message: expect.stringContaining("invalid-tab-id") } } }); }
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
    expect(await h.run()).toMatchObject({ ok: true, result: { title: "Current", tabs: 2 } });
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
    expect(await h.run()).toMatchObject({ ok: true, result: ["artifacts", "browser", "check", "emit", "net", "page", "protocol", "signal", "sleep"] }); h.executor.dispose();
  });
  it("applies the default ten-second program timeout and honors an explicit deadline", async () => {
    const h = programHarness(async () => 1); const timer = vi.spyOn(globalThis, "setTimeout");
    expect(await h.run()).toMatchObject({ ok: true }); expect(timer.mock.calls.some(([, delay]) => delay === 10000)).toBe(true);
    expect(await h.run(undefined, { timeoutMs: 37 })).toMatchObject({ ok: true }); expect(timer.mock.calls.some(([, delay]) => delay === 37)).toBe(true);
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
        query: vi.fn(async ({ windowId, active }: chrome.tabs.QueryInfo) => tabs.filter((tab) => tab.windowId === windowId && (!active || tab.active))),
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
    expect((await executor.browserContext()).tabs[0]!.current).toBe(true);
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
