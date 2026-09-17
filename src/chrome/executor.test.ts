import { describe, expect, it, vi } from "vitest";
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
  };
  return { calls, debuggerApi, chromeApi };
}

describe("ChromeExecutor", () => {
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

  it("propagates JavaScript exceptions and returns inspectable references", async () => {
    const fake = fakeChrome([
      { exceptionDetails: { text: "Uncaught", exception: { description: "Error: boom" } }, result: { type: "object" } },
      { result: { value: { kind: "reference", id: "ref-1", type: "bigint", preview: "1" } } },
    ]);
    const executor = new ChromeExecutor({ chromeApi: fake.chromeApi as never, targetUrl: "chrome-extension://id/sidepanel.html#test" });
    await expect(executor.execute({ code: "throw new Error('boom')" })).rejects.toThrow("Error: boom");
    await expect(executor.execute({ code: "return 1n" })).resolves.toEqual({
      $ref: "ref-1", type: "bigint", preview: "1", access: 'globalThis.__surfWaxResults.get("ref-1")',
    });
    expect(String(fake.debuggerApi.sendCommand.mock.calls[1][2]?.expression)).toContain("__surfWaxResults");
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
    let receive!: (message: unknown) => void;
    const port = {
      onMessage: { addListener: vi.fn((listener) => { receive = listener; }) },
      onDisconnect: { addListener: vi.fn() },
      postMessage: vi.fn((message: { id: string }) => receive({ id: message.id })),
      disconnect: vi.fn(),
    };
    (fake.chromeApi as any).runtime = { connect: vi.fn(() => port) };
    const executor = new ChromeExecutor({ chromeApi: fake.chromeApi as never, targetUrl: "chrome-extension://id/sidepanel.html#test" });
    const bridge = (globalThis as Record<string, any>).__surfWaxDebugger;
    await bridge.call("attach", [{ tabId: 15 }, "1.3"]);
    expect(port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ method: "attach", args: [{ tabId: 15 }, "1.3"] }));
    expect(fake.debuggerApi.attach).not.toHaveBeenCalled();
    executor.dispose();
    expect(port.disconnect).toHaveBeenCalled();
  });
});
