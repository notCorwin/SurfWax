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
    const fake = fakeChrome([{ result: { type: "object", value: { title: "test", tabs: 2 } } }]);
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

  it("propagates JavaScript exceptions and preserves non-JSON RemoteObject descriptors", async () => {
    const fake = fakeChrome([
      { exceptionDetails: { text: "Uncaught", exception: { description: "Error: boom" } }, result: { type: "object" } },
      { result: { type: "bigint", unserializableValue: "1n", description: "1n" } },
    ]);
    const executor = new ChromeExecutor({ chromeApi: fake.chromeApi as never, targetUrl: "chrome-extension://id/sidepanel.html#test" });
    await expect(executor.execute({ code: "throw new Error('boom')" })).rejects.toThrow("Error: boom");
    await expect(executor.execute({ code: "return 1n" })).resolves.toEqual({ type: "bigint", unserializableValue: "1n", description: "1n" });
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

    await expect(running).resolves.toBe("first");
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
});
