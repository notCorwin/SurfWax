import { describe, expect, it, vi } from "vitest";
import { EventLogger, type LogEvent } from "../logging";
import { USER_SCRIPTS_DATA_KEY, USER_SCRIPTS_STORAGE_KEY } from "../userscripts/persistence";
import { ChromeExecutor } from "./executor";

function fakeChrome(responses: Array<object | (() => Promise<object>)> = []) {
  const stored: Record<string, unknown> = {
    [USER_SCRIPTS_STORAGE_KEY]: [],
    [USER_SCRIPTS_DATA_KEY]: { version: 2, resetPending: false },
  };
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

describe("ChromeExecutor", () => {
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
    const executor = new ChromeExecutor({ chromeApi: fake.chromeApi as never, targetUrl: "chrome-extension://id/sidepanel.html#test" });

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

  it("selects a tab without focusing the Chrome window", async () => {
    const fake = fakeChrome();
    const tabs: chrome.tabs.Tab[] = [
      { id: 41, windowId: 7, active: true, title: "First" } as chrome.tabs.Tab,
      { id: 42, windowId: 7, active: false, title: "Second" } as chrome.tabs.Tab,
    ];
    const updateWindow = vi.fn();
    const updateTab = vi.fn(async (tabId: number) => {
      tabs.forEach((tab) => { tab.active = tab.id === tabId; });
    });
    Object.assign(fake.chromeApi, {
      windows: {
        getCurrent: vi.fn(async () => ({ id: 7, focused: false, tabs })),
        get: vi.fn(async () => ({ id: 7, focused: false })),
        update: updateWindow,
      },
      tabs: {
        query: vi.fn(async ({ windowId }: chrome.tabs.QueryInfo) => tabs.filter((tab) => tab.windowId === windowId)),
        update: updateTab,
      },
    });
    const executor = new ChromeExecutor({ chromeApi: fake.chromeApi as never, targetUrl: "chrome-extension://id/sidepanel.html#test" });

    await expect(executor.executeCommand("tab-select", { index: 1 })).resolves.toMatchObject([
      { index: 0, current: false },
      { index: 1, current: true },
    ]);
    expect(updateTab).toHaveBeenCalledWith(42, { active: true });
    expect(updateWindow).not.toHaveBeenCalled();
    executor.dispose();
  });

  it("navigates the current tab and creates new tabs only in the current window", async () => {
    const fake = fakeChrome();
    let url = "https://example.com/before";
    const tabs: chrome.tabs.Tab[] = [{ id: 41, windowId: 7, active: true, title: "Current", url } as chrome.tabs.Tab];
    const createWindow = vi.fn();
    const removeWindow = vi.fn();
    Object.assign(fake.chromeApi, {
      windows: {
        getCurrent: vi.fn(async () => ({ id: 7, tabs })),
        get: vi.fn(async () => ({ id: 7 })),
        update: vi.fn(async () => undefined),
        create: createWindow,
        remove: removeWindow,
      },
      tabs: {
        get: vi.fn(async (tabId: number) => tabs.find((tab) => tab.id === tabId)),
        query: vi.fn(async ({ windowId, active }: chrome.tabs.QueryInfo) => tabs.filter((tab) => tab.windowId === windowId && (!active || tab.active))),
        create: vi.fn(async (options: chrome.tabs.CreateProperties) => {
          const tab = { id: 42, windowId: options.windowId, active: true, title: "New", url: options.url } as chrome.tabs.Tab;
          tabs.forEach((item) => { item.active = false; });
          tabs.push(tab);
          return tab;
        }),
      },
    });
    fake.debuggerApi.sendCommand.mockImplementation(async (_debuggee, method, params) => {
      if (method === "Page.navigate") { url = String((params as { url?: string })?.url); tabs[0]!.url = url; return {}; }
      if (method !== "Runtime.evaluate") return {};
      const expression = String((params as { expression?: string })?.expression);
      if (expression.includes("document.readyState")) return { result: { value: true } };
      if (expression.includes("({url:location.href,title:document.title})")) return { result: { value: { url, title: "Current" } } };
      if (expression.includes("location.href")) return { result: { value: url } };
      if (expression.includes("document.title")) return { result: { value: "Current" } };
      return { result: { value: null } };
    });
    const executor = new ChromeExecutor({ chromeApi: fake.chromeApi as never, targetUrl: "chrome-extension://id/sidepanel.html#test" });

    await expect(executor.executeCommand("goto", { url: "https://example.com/after" })).resolves.toMatchObject({ page: { url: "https://example.com/after" } });
    await executor.executeCommand("tab-new", { url: "https://example.com/new" });

    expect((fake.chromeApi as any).tabs.create).toHaveBeenCalledWith({ windowId: 7, active: true, url: "https://example.com/new" });
    expect(createWindow).not.toHaveBeenCalled();
    expect(removeWindow).not.toHaveBeenCalled();
    executor.dispose();
  });

  it("runs code in the exact Side Panel target and returns by-value results", async () => {
    const fake = fakeChrome([{ result: { type: "object", value: { kind: "value", value: { title: "test", tabs: 2 } } } }]);
    const executor = new ChromeExecutor({ chromeApi: fake.chromeApi as never, targetUrl: "chrome-extension://id/sidepanel.html#test" });

    await expect(executor.execute({ code: "return { title: document.title, tabs: (await chrome.tabs.query({})).length };" }))
      .resolves.toEqual({ title: "test", tabs: 2 });
    expect(fake.debuggerApi.sendCommand).toHaveBeenCalledWith(
      { targetId: "target-1" },
      "Runtime.evaluate",
      expect.objectContaining({ awaitPromise: true, returnByValue: true }),
    );
    expect(String(fake.debuggerApi.sendCommand.mock.calls[0][2]?.expression)).toContain("const chrome = new Proxy");
  });

  it("exposes page() as a second meta-tool execution realm", async () => {
    const fake = fakeChrome([{ result: { value: { kind: "value", value: "done" } } }]);
    const executor = new ChromeExecutor({ chromeApi: fake.chromeApi as never, targetUrl: "chrome-extension://id/sidepanel.html#test" });
    await expect(executor.executePage({ tabId: 7, code: "await page.getByRole('button', {name: 'Go'}).click(); return 'done';" })).resolves.toBe("done");
    const expression = String(fake.debuggerApi.sendCommand.mock.calls[0][2]?.expression);
    expect(expression).toContain("__surfWaxBrowser");
    expect(expression).toContain("getByRole");
  });

  it("runs PageFacade-like targets through the existing page session", async () => {
    const fake = fakeChrome([
      { result: { value: { kind: "value", value: null } } },
      ...Array.from({ length: 8 }, () => ({})),
      { result: { value: { kind: "value", value: "Automation Target" } } },
    ]);
    const executor = new ChromeExecutor({ chromeApi: fake.chromeApi as never, targetUrl: "chrome-extension://id/sidepanel.html#test" });
    await executor.execute({ code: "return null" });

    await expect((globalThis as any).__surfWaxBrowser.runIn({ tabId: 7 }, "return document.title"))
      .resolves.toBe("Automation Target");
    expect(fake.debuggerApi.attach.mock.calls.filter(([debuggee]) => (debuggee as any).tabId === 7)).toHaveLength(1);
    expect(String(fake.debuggerApi.sendCommand.mock.calls.at(-1)?.[2]?.expression)).toContain("return document.title");
  });

  it("returns a stable automation timeout error for page calls", async () => {
    const fake = fakeChrome([() => new Promise<object>(() => undefined)]);
    const executor = new ChromeExecutor({ chromeApi: fake.chromeApi as never, targetUrl: "chrome-extension://id/sidepanel.html#test" });

    await expect(executor.executePage({ code: "await new Promise(() => undefined)", timeoutMs: 5 })).resolves.toMatchObject({ ok: false, error: { code: "timeout" } });
  });

  it("serializes page() and chrome() through the same queue", async () => {
    let finish!: (value: object) => void;
    const first = new Promise<object>((resolve) => { finish = resolve; });
    const fake = fakeChrome([() => first, { result: { value: { kind: "value", value: "chrome" } } }]);
    const executor = new ChromeExecutor({ chromeApi: fake.chromeApi as never, targetUrl: "chrome-extension://id/sidepanel.html#test" });
    const page = executor.executePage({ code: "return 'page'" });
    const chrome = executor.execute({ code: "return 'chrome'" });
    await vi.waitFor(() => expect(fake.debuggerApi.sendCommand).toHaveBeenCalledTimes(1));
    finish({ result: { value: { kind: "value", value: "page" } } });
    await expect(page).resolves.toBe("page");
    await expect(chrome).resolves.toBe("chrome");
    expect(fake.debuggerApi.sendCommand).toHaveBeenCalledTimes(2);
  });

  it("propagates JavaScript exceptions and returns inspectable references", async () => {
    const fake = fakeChrome([
      { exceptionDetails: { text: "Uncaught", exception: { description: "Error: boom" } }, result: { type: "object" } },
      { result: { value: { kind: "reference", id: "ref-1", type: "bigint", preview: "1" } } },
    ]);
    const executor = new ChromeExecutor({ chromeApi: fake.chromeApi as never, targetUrl: "chrome-extension://id/sidepanel.html#test" });
    await expect(executor.execute({ code: "throw new Error('boom')" })).rejects.toThrow("Error: boom");
    await expect(executor.execute({ code: "return 1n" })).resolves.toMatchObject({
      $ref: "ref-1", ref: "ref-1", type: "bigint", preview: "1", access: 'globalThis.__surfWaxObject("ref-1")', scope: "extension", host: "extension",
    });
    expect(String(fake.debuggerApi.sendCommand.mock.calls[1][2]?.expression)).toContain("__surfWaxResults");
  });

  it("runs a page async body in MAIN by default and USER_SCRIPT when requested", async () => {
    const fake = fakeChrome();
    const execute = vi.fn(async (injection: chrome.userScripts.UserScriptInjection) => [{
      frameId: 0, documentId: "doc", result: { kind: "value", value: injection.world },
    }]);
    (fake.chromeApi.userScripts as any).execute = execute;
    const executor = new ChromeExecutor({ chromeApi: fake.chromeApi as never, targetUrl: "chrome-extension://id/sidepanel.html#test" });
    await expect(executor.execute({ tabId: 5, code: "return document.title" })).resolves.toBe("MAIN");
    await expect(executor.execute({ tabId: 5, world: "USER_SCRIPT", code: "return await Promise.resolve(document.title)" })).resolves.toBe("USER_SCRIPT");
    await expect(executor.execute({ code: "return document.title", target: { kind: "page", tabId: 5, frameId: 2, world: "MAIN" } })).resolves.toBe("MAIN");
    await expect(executor.executeBrowser({ mode: "run", target: { kind: "page", tabId: 5 }, code: "return document.title" })).resolves.toBe("MAIN");
    expect(execute).toHaveBeenCalledTimes(4);
    expect(execute.mock.calls[0][0]).toMatchObject({ target: { tabId: 5 }, world: "MAIN", injectImmediately: true });
    expect(execute.mock.calls[0][0].js[0]?.code).toContain("return document.title");
    expect(execute.mock.calls[1][0].world).toBe("USER_SCRIPT");
    expect(execute.mock.calls[2][0].target).toEqual({ tabId: 5, frameIds: [2] });
    expect(fake.debuggerApi.attach).not.toHaveBeenCalled();
    executor.dispose();
  });

  it("reads canonical tool results without entering a Chrome execution context", async () => {
    const events: LogEvent[] = [];
    const logger = new EventLogger({ store: {
      async append(event: Omit<LogEvent, "id">) { const saved = { ...event, id: events.length + 1 }; events.push(saved); return saved; },
      async all() { return [...events]; }, async clear() { events.length = 0; },
    } });
    const saved = await logger.append({ type: "tool.result.data", content: null, output: { observation: { snapshot: "abcdef" } } });
    const fake = fakeChrome();
    const executor = new ChromeExecutor({ chromeApi: fake.chromeApi as never, targetUrl: "chrome-extension://id/sidepanel.html#test", logger });

    await expect(executor.executeBrowser({ mode: "result", id: saved!.id, path: ["observation", "snapshot"], offset: 1, limit: 3 })).resolves.toBe("bcd");
    expect(fake.debuggerApi.getTargets).not.toHaveBeenCalled();
    executor.dispose();
  });

  it("stores artifacts internally by default, saves explicitly, and reuses them for uploads", async () => {
    const events: LogEvent[] = [];
    const logger = new EventLogger({ store: {
      async append(event: Omit<LogEvent, "id">) { const saved = { ...event, id: events.length + 1 }; events.push(saved); return saved; },
      async all() { return [...events]; }, async clear() { events.length = 0; },
    } });
    const fake = fakeChrome();
    const executor = new ChromeExecutor({ chromeApi: fake.chromeApi as never, targetUrl: "chrome-extension://id/sidepanel.html#test", logger });
    (executor as any).activeContext = { conversationId: "conversation", toolCallId: "call" };

    const internal = await (executor as any).storeArtifact("internal.txt", "aGVsbG8=", "text/plain");
    expect(internal).toMatchObject({ id: 1, filename: "internal.txt", byteLength: 5, saved: false });
    expect(fake.chromeApi.downloads.download).not.toHaveBeenCalled();
    expect(await (executor as any).normalizeFiles([{ name: "upload.txt", artifactId: internal.id }])).toEqual([
      { name: "upload.txt", mimeType: "text/plain", base64: "aGVsbG8=" },
    ]);

    const saved = await (executor as any).storeArtifact("saved.txt", "eA==", "text/plain", true);
    expect(saved).toMatchObject({ id: 2, filename: "saved.txt", byteLength: 1, saved: true, downloadId: 17 });
    expect(fake.chromeApi.downloads.download).toHaveBeenCalledTimes(1);

    await expect(executor.executeCommand("artifact-save", { id: internal.id }, undefined, { conversationId: "conversation" }))
      .resolves.toMatchObject({ artifact: { id: 1, filename: "internal.txt", saved: true, downloadId: 17 } });
    expect(fake.chromeApi.downloads.download).toHaveBeenCalledTimes(2);
    executor.dispose();
  });

  it("guards raw downloads and passes through explicit save authority", async () => {
    const fake = fakeChrome();
    const previousChrome = Object.getOwnPropertyDescriptor(globalThis, "chrome");
    Object.defineProperty(globalThis, "chrome", { configurable: true, value: fake.chromeApi });
    fake.debuggerApi.sendCommand.mockImplementation(async (_debuggee, method, params) => {
      if (method !== "Runtime.evaluate" || typeof params?.expression !== "string") return {};
      return { result: { value: await (0, eval)(params.expression) } };
    });
    const executor = new ChromeExecutor({ chromeApi: fake.chromeApi as never, targetUrl: "chrome-extension://id/sidepanel.html#test" });

    try {
      await expect(executor.execute({ code: "return chrome.downloads.download({url:'data:text/plain,x'})" }))
        .rejects.toThrow("download-not-authorized");
      expect(fake.chromeApi.downloads.download).not.toHaveBeenCalled();
      await expect(executor.execute({ code: "return chrome.downloads.download({url:'data:text/plain,x'})", save: true })).resolves.toBe(17);
      expect(fake.chromeApi.downloads.download).toHaveBeenCalledTimes(1);
    } finally {
      executor.dispose();
      if (previousChrome) Object.defineProperty(globalThis, "chrome", previousChrome);
      else delete (globalThis as any).chrome;
    }
  });

  it("applies the default ten-second timeout to act batches", async () => {
    const fake = fakeChrome();
    const executor = new ChromeExecutor({ chromeApi: fake.chromeApi as never, targetUrl: "chrome-extension://id/sidepanel.html#test" });
    const timer = vi.spyOn(globalThis, "setTimeout");
    await executor.executeBrowser({ mode: "act", tabId: 5, steps: [{ type: "unsupported" } as never] });
    expect(timer.mock.calls.some(([, delay]) => delay === 10_000)).toBe(true);
    await executor.executeBrowser({ mode: "act", tabId: 5, timeoutMs: 37, steps: [{ type: "unsupported" } as never] });
    expect(timer.mock.calls.some(([, delay]) => delay === 37)).toBe(true);
    timer.mockRestore();
    executor.dispose();
  });

  it("uses CDP only when native page execution is unavailable and never replays failures", async () => {
    const fake = fakeChrome([{ result: { value: { kind: "value", value: "CDP" } } }]);
    const executor = new ChromeExecutor({ chromeApi: fake.chromeApi as never, targetUrl: "chrome-extension://id/sidepanel.html#test" });
    await expect(executor.execute({ tabId: 8, code: "return document.title" })).resolves.toBe("CDP");
    expect(fake.debuggerApi.attach).toHaveBeenCalledWith({ tabId: 8 }, "1.3");
    expect(String(fake.debuggerApi.sendCommand.mock.calls[0][2]?.expression)).toContain("return document.title");
    await expect(executor.execute({ tabId: 8, world: "USER_SCRIPT", code: "return 1" })).rejects.toThrow("Allow User Scripts");
    expect(fake.debuggerApi.sendCommand).toHaveBeenCalledTimes(1);
    (fake.chromeApi.userScripts as any).execute = vi.fn(async () => [{ frameId: 0, documentId: "doc", error: "page failed" }]);
    await expect(executor.execute({ tabId: 8, code: "throw Error('page failed')" })).rejects.toThrow("page failed");
    expect(fake.debuggerApi.sendCommand).toHaveBeenCalledTimes(1);
    executor.dispose();
  });

  it("aborts a pending native page result without starting queued calls", async () => {
    const fake = fakeChrome();
    const execute = vi.fn(() => new Promise<chrome.userScripts.InjectionResult[]>(() => undefined));
    (fake.chromeApi.userScripts as any).execute = execute;
    const executor = new ChromeExecutor({ chromeApi: fake.chromeApi as never, targetUrl: "chrome-extension://id/sidepanel.html#test" });
    const controller = new AbortController();
    const running = executor.execute({ tabId: 7, code: "await new Promise(() => {})" }, controller.signal);
    const queued = executor.execute({ tabId: 7, code: "return 2" }, controller.signal);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    expect(execute).toHaveBeenCalledTimes(1);
    executor.dispose();
  });

  it("finds and attaches to the current target again for every call", async () => {
    const fake = fakeChrome([{ result: { value: 1 } }, { result: { value: 2 } }]);
    fake.debuggerApi.getTargets
      .mockResolvedValueOnce([{ id: "target-1", type: "page", title: "Surf Wax", url: "chrome-extension://id/sidepanel.html#test", attached: false }])
      .mockResolvedValueOnce([{ id: "target-2", type: "page", title: "Surf Wax", url: "chrome-extension://id/sidepanel.html#test", attached: false }]);
    const executor = new ChromeExecutor({ chromeApi: fake.chromeApi as never, targetUrl: "chrome-extension://id/sidepanel.html#test" });

    await expect(executor.execute({ code: "return 1" })).resolves.toBe(1);
    await expect(executor.execute({ code: "return 2" })).resolves.toBe(2);
    expect(fake.debuggerApi.attach.mock.calls.map(([debuggee]) => debuggee)).toEqual([
      { targetId: "target-1" },
      { targetId: "target-2" },
    ]);
  });

  it("serializes calls and prevents queued work after disposal", async () => {
    let finish!: (value: object) => void;
    const first = new Promise<object>((resolve) => { finish = resolve; });
    const fake = fakeChrome([() => first, { result: { value: "second" } }]);
    const executor = new ChromeExecutor({ chromeApi: fake.chromeApi as never, targetUrl: "chrome-extension://id/sidepanel.html#test" });
    const running = executor.execute({ code: "return 'first'" });
    const queued = executor.execute({ code: "return 'second'" });
    await vi.waitFor(() => expect(fake.debuggerApi.sendCommand).toHaveBeenCalledTimes(1));
    executor.dispose();
    finish({ result: { value: "first" } });

    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    await expect(queued).rejects.toThrow("disposed");
    expect(fake.debuggerApi.sendCommand).toHaveBeenCalledTimes(1);
  });

  it("detaches the active target when aborted", async () => {
    const fake = fakeChrome([() => new Promise<object>(() => undefined)]);
    const executor = new ChromeExecutor({ chromeApi: fake.chromeApi as never, targetUrl: "chrome-extension://id/sidepanel.html#test" });
    const controller = new AbortController();
    const running = executor.execute({ code: "await new Promise(() => {})" }, controller.signal);
    await vi.waitFor(() => expect(fake.debuggerApi.sendCommand).toHaveBeenCalled());
    controller.abort();
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    expect(fake.debuggerApi.detach).toHaveBeenCalledWith({ targetId: "target-1" });
  });

  it("does not attach after target discovery is aborted", async () => {
    const fake = fakeChrome();
    let finish!: (targets: chrome.debugger.TargetInfo[]) => void;
    fake.debuggerApi.getTargets.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const executor = new ChromeExecutor({ chromeApi: fake.chromeApi as never, targetUrl: "chrome-extension://id/sidepanel.html#test" });
    const controller = new AbortController();
    const running = executor.execute({ code: "return 1" }, controller.signal);
    await vi.waitFor(() => expect(fake.debuggerApi.getTargets).toHaveBeenCalled());
    controller.abort();
    finish([{ id: "target-1", type: "page", title: "Surf Wax", url: "chrome-extension://id/sidepanel.html#test", attached: false }]);
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    expect(fake.debuggerApi.attach).not.toHaveBeenCalled();
  });

  it("detaches when aborted during attach and never evaluates", async () => {
    const fake = fakeChrome();
    let finish!: () => void;
    fake.debuggerApi.attach.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const executor = new ChromeExecutor({ chromeApi: fake.chromeApi as never, targetUrl: "chrome-extension://id/sidepanel.html#test" });
    const controller = new AbortController();
    const running = executor.execute({ code: "return 1" }, controller.signal);
    await vi.waitFor(() => expect(fake.debuggerApi.attach).toHaveBeenCalled());
    controller.abort();
    finish();
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    expect(fake.debuggerApi.sendCommand).not.toHaveBeenCalled();
    expect(fake.debuggerApi.detach).toHaveBeenCalledWith({ targetId: "target-1" });
  });

  it("keeps the execution result when a user-script snapshot fails", async () => {
    const fake = fakeChrome([{ result: { value: { kind: "value", value: 42 } } }]);
    fake.chromeApi.userScripts.getScripts.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockRejectedValueOnce(new Error("snapshot failed"));
    const executor = new ChromeExecutor({ chromeApi: fake.chromeApi as never, targetUrl: "chrome-extension://id/sidepanel.html#test" });
    await expect(executor.execute({ code: "return 42" })).resolves.toBe(42);
    expect(fake.debuggerApi.detach).toHaveBeenCalledWith({ targetId: "target-1" });
  });

  it("routes agent debugger calls through a panel-owned background port", async () => {
    const fake = fakeChrome();
    const { port } = fakePort();
    (fake.chromeApi as any).runtime = { connect: vi.fn(() => port) };
    const executor = new ChromeExecutor({ chromeApi: fake.chromeApi as never, targetUrl: "chrome-extension://id/sidepanel.html#test" });
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
    const executor = new ChromeExecutor({ chromeApi: fake.chromeApi as never, targetUrl: "chrome-extension://id/sidepanel.html#test" });
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

  it("retries only a disconnected user-script restoration before first page execution", async () => {
    const fake = fakeChrome();
    const execute = vi.fn(async () => [{ frameId: 0, documentId: "doc", result: { kind: "value", value: "READY" } }]);
    (fake.chromeApi.userScripts as any).execute = execute;
    const first = fakePort((_message, _reply, drop) => drop());
    const second = fakePort();
    const connect = vi.fn().mockReturnValueOnce(first.port).mockReturnValueOnce(second.port);
    (fake.chromeApi as any).runtime = { connect };
    const executor = new ChromeExecutor({ chromeApi: fake.chromeApi as never, targetUrl: "chrome-extension://id/sidepanel.html#test" });
    await expect(executor.execute({ tabId: 5, code: "return document.title" })).resolves.toBe("READY");
    expect(connect).toHaveBeenCalledTimes(2);
    expect(first.port.postMessage.mock.calls[0][0].method).toBe("restoreUserScripts");
    expect(second.port.postMessage.mock.calls[0][0].method).toBe("restoreUserScripts");
    expect(execute).toHaveBeenCalledTimes(1);
    executor.dispose();
  });

  it("does not replay a command whose port disconnects while it is pending", async () => {
    const fake = fakeChrome();
    const first = fakePort(() => undefined);
    const second = fakePort();
    const connect = vi.fn().mockReturnValueOnce(first.port).mockReturnValueOnce(second.port);
    (fake.chromeApi as any).runtime = { connect };
    const executor = new ChromeExecutor({ chromeApi: fake.chromeApi as never, targetUrl: "chrome-extension://id/sidepanel.html#test" });
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

  it("does not cache a failed restoration", async () => {
    const fake = fakeChrome();
    const execute = vi.fn(async () => [{ frameId: 0, documentId: "doc", result: { kind: "value", value: "READY" } }]);
    (fake.chromeApi.userScripts as any).execute = execute;
    let first = true;
    const { port } = fakePort((message, reply) => {
      if (first) {
        first = false;
        reply({ id: message.id, error: "restore failed" });
      } else reply({ id: message.id });
    });
    (fake.chromeApi as any).runtime = { connect: vi.fn(() => port) };
    const executor = new ChromeExecutor({ chromeApi: fake.chromeApi as never, targetUrl: "chrome-extension://id/sidepanel.html#test" });
    await expect(executor.execute({ tabId: 5, code: "return document.title" })).rejects.toThrow("restore failed");
    await expect(executor.execute({ tabId: 5, code: "return document.title" })).resolves.toBe("READY");
    expect(execute).toHaveBeenCalledTimes(1);
    executor.dispose();
  });
});
