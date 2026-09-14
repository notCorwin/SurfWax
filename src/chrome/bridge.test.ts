import { describe, expect, it, vi } from "vitest";
import { ChromeBridge } from "./bridge";

class FakeEvent {
  private readonly listeners = new Set<(...args: unknown[]) => void>();

  addListener(listener: (...args: unknown[]) => void): void {
    this.listeners.add(listener);
  }

  removeListener(listener: (...args: unknown[]) => void): void {
    this.listeners.delete(listener);
  }

  emit(...args: unknown[]): void {
    for (const listener of [...this.listeners]) listener(...args);
  }

  get size(): number {
    return this.listeners.size;
  }
}

class FakePort {
  readonly messages: unknown[] = [];

  postMessage(message: unknown): void {
    this.messages.push(message);
  }
}

function fakeChrome() {
  const onUpdated = new FakeEvent();
  const onDetach = new FakeEvent();
  const port = new FakePort();
  const debuggerCalls: string[] = [];
  const attach = vi.fn(async () => {
    debuggerCalls.push("attach");
  });
  const sendCommand = vi.fn(async (_session: unknown, command: string, params: unknown) => ({
    command,
    params,
    result: "ok",
  }));
  const detach = vi.fn(async () => {
    debuggerCalls.push("detach");
  });
  const callbackApi = vi.fn((value: string, callback: (result: unknown) => void) => {
    callback({ value });
  });

  const chromeApi = {
    runtime: { lastError: undefined },
    permissions: {
      getAll: vi.fn(async () => ({ permissions: ["tabs"], origins: ["<all_urls>"] })),
    },
    tabs: {
      query: vi.fn(async () => [{ id: 7, title: "Test tab" }]),
      onUpdated,
      fail: vi.fn(async () => {
        throw new Error("tab operation failed");
      }),
      connect: vi.fn(() => port),
    },
    callbackApi,
    debugger: {
      attach,
      sendCommand,
      detach,
      onDetach,
    },
  };

  return { chromeApi, onUpdated, onDetach, port, debuggerCalls, callbackApi, attach, sendCommand, detach };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("ChromeBridge", () => {
  it("calls arbitrary promise APIs and returns a structured value", async () => {
    const fake = fakeChrome();
    const bridge = new ChromeBridge({ chromeApi: fake.chromeApi as never });

    await expect(bridge.execute({ operation: "call", path: "tabs.query", args: [] })).resolves.toEqual({
      ok: true,
      value: [{ id: 7, title: "Test tab" }],
    });
  });

  it("supports callback APIs without a wrapper per Chrome method", async () => {
    const fake = fakeChrome();
    const bridge = new ChromeBridge({ chromeApi: fake.chromeApi as never });

    await expect(bridge.execute({
      operation: "call",
      path: "callbackApi",
      args: ["hello"],
      callbackMode: "callback",
    })).resolves.toEqual({ ok: true, value: { value: "hello" } });
    expect(fake.callbackApi).toHaveBeenCalledTimes(1);
  });

  it("waits for and filters Chrome events, then removes the listener", async () => {
    const fake = fakeChrome();
    const bridge = new ChromeBridge({ chromeApi: fake.chromeApi as never });
    const pending = bridge.execute({
      operation: "waitEvent",
      eventPath: "tabs.onUpdated",
      match: [7, { status: "complete" }],
    });

    expect(fake.onUpdated.size).toBe(1);
    fake.onUpdated.emit(3, { status: "loading" });
    fake.onUpdated.emit(7, { status: "complete" }, { id: 7 });
    await expect(pending).resolves.toEqual({
      ok: true,
      value: [7, { status: "complete" }, { id: 7 }],
    });
    expect(fake.onUpdated.size).toBe(0);
  });

  it("cancels an event wait without a timeout ceiling", async () => {
    const fake = fakeChrome();
    const bridge = new ChromeBridge({ chromeApi: fake.chromeApi as never });
    const controller = new AbortController();
    const pending = bridge.execute({ operation: "waitEvent", eventPath: "tabs.onUpdated" }, controller.signal);
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fake.onUpdated.size).toBe(0);
  });

  it("disposes pending waits when the side panel closes", async () => {
    const fake = fakeChrome();
    const bridge = new ChromeBridge({ chromeApi: fake.chromeApi as never });
    const pending = bridge.execute({ operation: "waitEvent", eventPath: "tabs.onUpdated" });
    bridge.dispose();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fake.onUpdated.size).toBe(0);
  });

  it("creates handles for non-JSON objects and accepts them as receivers", async () => {
    const fake = fakeChrome();
    const bridge = new ChromeBridge({ chromeApi: fake.chromeApi as never });
    const created = await bridge.execute({ operation: "call", path: "tabs.connect", args: [] });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const handle = (created.value as { $sideAgentHandle: string }).$sideAgentHandle;

    await expect(bridge.execute({
      operation: "call",
      receiver: handle,
      path: "postMessage",
      args: [{ hello: "world" }],
    })).resolves.toEqual({ ok: true, value: { $type: "undefined", value: null } });
    expect(fake.port.messages).toEqual([{ hello: "world" }]);
  });

  it("supports raw CDP attach, send, and detach", async () => {
    const fake = fakeChrome();
    const bridge = new ChromeBridge({ chromeApi: fake.chromeApi as never });
    const sendCommand = fake.chromeApi.debugger.sendCommand;

    await expect(bridge.execute({ operation: "cdp", action: "attach", tabId: 7 })).resolves.toEqual({
      ok: true,
      value: { attached: true, tabId: 7 },
    });
    await expect(bridge.execute({
      operation: "cdp",
      action: "send",
      tabId: 7,
      command: "Runtime.evaluate",
      params: { expression: "document.title" },
    })).resolves.toEqual({
      ok: true,
      value: { command: "Runtime.evaluate", params: { expression: "document.title" }, result: "ok" },
    });
    expect(sendCommand).toHaveBeenLastCalledWith(
      { tabId: 7 },
      "Runtime.evaluate",
      { expression: "document.title" },
    );
    expect(sendCommand.mock.calls.at(-1)).toHaveLength(3);

    await expect(bridge.execute({
      operation: "cdp",
      action: "send",
      tabId: 7,
      command: "Page.enable",
    })).resolves.toEqual({
      ok: true,
      value: {
        command: "Page.enable",
        params: { $type: "undefined", value: null },
        result: "ok",
      },
    });
    expect(sendCommand).toHaveBeenLastCalledWith({ tabId: 7 }, "Page.enable");
    expect(sendCommand.mock.calls.at(-1)).toHaveLength(2);

    await expect(bridge.execute({
      operation: "cdp",
      action: "send",
      tabId: 7,
      command: "Runtime.enable",
      params: {},
    })).resolves.toEqual({
      ok: true,
      value: { command: "Runtime.enable", params: {}, result: "ok" },
    });
    expect(sendCommand).toHaveBeenLastCalledWith({ tabId: 7 }, "Runtime.enable", {});
    expect(sendCommand.mock.calls.at(-1)).toHaveLength(3);

    await expect(bridge.execute({ operation: "cdp", action: "detach", tabId: 7 })).resolves.toEqual({
      ok: true,
      value: { detached: true, tabId: 7 },
    });
    expect(fake.debuggerCalls).toEqual(["attach", "detach"]);
  });

  it("only attaches once for concurrent sends to one tab", async () => {
    const fake = fakeChrome();
    const bridge = new ChromeBridge({ chromeApi: fake.chromeApi as never });

    const results = await Promise.all([
      bridge.execute({ operation: "cdp", action: "send", tabId: 7, command: "Runtime.enable" }),
      bridge.execute({ operation: "cdp", action: "send", tabId: 7, command: "Page.enable" }),
    ]);

    expect(results.every((result) => result.ok)).toBe(true);
    expect(fake.attach).toHaveBeenCalledTimes(1);
    expect(fake.sendCommand).toHaveBeenCalledTimes(2);
  });

  it("serializes Chrome calls and drops queued work after abort", async () => {
    const fake = fakeChrome();
    const started = deferred<void>();
    const release = deferred<void>();
    let active = 0;
    let maximumActive = 0;
    const serial = vi.fn(async (id: string) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (id === "first") {
        started.resolve();
        await release.promise;
      }
      active -= 1;
      return id;
    });
    (fake.chromeApi.tabs as { serial?: typeof serial }).serial = serial;
    const bridge = new ChromeBridge({ chromeApi: fake.chromeApi as never });

    const first = bridge.execute({ operation: "call", path: "tabs.serial", args: ["first"] });
    await started.promise;
    const controller = new AbortController();
    const second = bridge.execute({ operation: "call", path: "tabs.serial", args: ["second"] }, controller.signal);
    controller.abort();

    await expect(second).rejects.toMatchObject({ name: "AbortError" });
    expect(serial).toHaveBeenCalledTimes(1);
    release.resolve();
    await expect(first).resolves.toEqual({ ok: true, value: "first" });
    expect(maximumActive).toBe(1);
  });

  it("makes repeated explicit attaches idempotent", async () => {
    const fake = fakeChrome();
    const bridge = new ChromeBridge({ chromeApi: fake.chromeApi as never });

    await bridge.execute({ operation: "cdp", action: "attach", tabId: 7 });
    await bridge.execute({ operation: "cdp", action: "attach", tabId: 7 });

    expect(fake.attach).toHaveBeenCalledTimes(1);
  });

  it("reattaches after an external debugger detach", async () => {
    const fake = fakeChrome();
    const bridge = new ChromeBridge({ chromeApi: fake.chromeApi as never });
    const sendCommand = fake.sendCommand;

    await bridge.execute({ operation: "cdp", action: "send", tabId: 7, command: "Runtime.enable" });
    fake.onDetach.emit({ tabId: 7 }, "target_closed");
    await bridge.execute({ operation: "cdp", action: "send", tabId: 7, command: "Runtime.enable" });

    expect(fake.attach).toHaveBeenCalledTimes(2);
    expect(sendCommand).toHaveBeenCalledTimes(2);
  });

  it("retries one send after Chrome reports a stale debugger session", async () => {
    const fake = fakeChrome();
    const bridge = new ChromeBridge({ chromeApi: fake.chromeApi as never });
    fake.sendCommand.mockRejectedValueOnce(new Error("Debugger is not attached to the target"));

    const result = await bridge.execute({
      operation: "cdp",
      action: "send",
      tabId: 7,
      command: "Runtime.enable",
    });

    expect(result.ok).toBe(true);
    expect(fake.attach).toHaveBeenCalledTimes(2);
    expect(fake.sendCommand).toHaveBeenCalledTimes(2);
  });

  it("does not publish a late attach after abort and disposal", async () => {
    const fake = fakeChrome();
    const bridge = new ChromeBridge({ chromeApi: fake.chromeApi as never });
    const attachStarted = deferred<void>();
    const releaseAttach = deferred<void>();
    fake.attach.mockImplementation(async () => {
      attachStarted.resolve();
      await releaseAttach.promise;
      fake.debuggerCalls.push("attach");
    });
    const controller = new AbortController();
    const pending = bridge.execute(
      { operation: "cdp", action: "send", tabId: 7, command: "Runtime.enable" },
      controller.signal,
    );

    await attachStarted.promise;
    controller.abort();
    bridge.dispose();
    releaseAttach.resolve();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fake.sendCommand).not.toHaveBeenCalled();
    expect(fake.debuggerCalls).toEqual(["attach", "detach"]);
  });

  it("does not publish a late send after abort and disposal", async () => {
    const fake = fakeChrome();
    const bridge = new ChromeBridge({ chromeApi: fake.chromeApi as never });
    const sendStarted = deferred<void>();
    const releaseSend = deferred<void>();
    fake.sendCommand.mockImplementation(async () => {
      sendStarted.resolve();
      await releaseSend.promise;
      return { command: "Runtime.enable", params: undefined, result: "late" };
    });
    const controller = new AbortController();
    const pending = bridge.execute(
      { operation: "cdp", action: "send", tabId: 7, command: "Runtime.enable" },
      controller.signal,
    );

    await sendStarted.promise;
    controller.abort();
    bridge.dispose();
    releaseSend.resolve();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fake.sendCommand).toHaveBeenCalledTimes(1);
    expect(fake.debuggerCalls).toEqual(["attach", "detach"]);
  });

  it("returns Chrome errors instead of hiding them", async () => {
    const fake = fakeChrome();
    const bridge = new ChromeBridge({ chromeApi: fake.chromeApi as never });

    await expect(bridge.execute({ operation: "call", path: "tabs.fail", args: [] })).resolves.toMatchObject({
      ok: false,
      error: { name: "Error", message: "tab operation failed" },
    });
  });

  it("does not truncate large API results", async () => {
    const fake = fakeChrome();
    (fake.chromeApi.tabs as { large?: () => Promise<string> }).large = async () => "x".repeat(120_000);
    const bridge = new ChromeBridge({ chromeApi: fake.chromeApi as never });

    const result = await bridge.execute({ operation: "call", path: "tabs.large", args: [] });
    expect(result).toEqual({ ok: true, value: "x".repeat(120_000) });
  });
});
