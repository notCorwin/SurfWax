import { afterEach, expect, it, vi } from "vitest";

const boot = vi.hoisted(() => ({ inputStateEvents: vi.fn(), append: vi.fn(), recoverDanglingRuns: vi.fn() }));
vi.mock("./logging", () => ({
  EventLogger: class { inputStateEvents = boot.inputStateEvents; append = boot.append; recoverDanglingRuns = boot.recoverDanglingRuns; },
  fromLogValue: (value: unknown) => value,
}));

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("reports a failed bootstrap to both waiting writers and run claims", async () => {
  vi.resetModules();
  let rejectBoot!: (error: Error) => void;
  boot.inputStateEvents.mockReturnValue(new Promise((_, reject) => { rejectBoot = reject; }));
  const connects: ((port: chrome.runtime.Port) => void)[] = [];
  const event = () => ({ addListener: vi.fn(), removeListener: vi.fn() });
  vi.stubGlobal("chrome", {
    runtime: {
      id: "test", onConnect: { addListener: (listener: (port: chrome.runtime.Port) => void) => connects.push(listener) },
      onMessage: event(), onInstalled: event(), onStartup: event(), sendMessage: vi.fn(async () => undefined),
    },
    tabs: { query: vi.fn(async () => []), onUpdated: event() },
    sidePanel: { setPanelBehavior: vi.fn(async () => undefined) },
  });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  await import("./background");
  const writer = { name: "surf-wax-log-writer", onMessage: event(), onDisconnect: event(), postMessage: vi.fn() };
  let claim!: (message: unknown) => void;
  const owner = { name: "surf-wax-run-owner", onMessage: { addListener: (listener: (message: unknown) => void) => { claim = listener; } }, onDisconnect: event(), postMessage: vi.fn() };
  connects.forEach((listener) => listener(writer as unknown as chrome.runtime.Port));
  connects.forEach((listener) => listener(owner as unknown as chrome.runtime.Port));
  claim({ type: "claim", runId: "run", ownerId: "owner", conversationId: "conversation" });
  rejectBoot(new Error("IndexedDB unavailable"));
  await vi.waitFor(() => {
    expect(writer.postMessage).toHaveBeenCalledWith({ type: "writer-error", error: "后台初始化失败，请重新加载扩展后重试：IndexedDB unavailable" });
    expect(owner.postMessage).toHaveBeenCalledWith({ type: "claimed", error: "后台初始化失败：IndexedDB unavailable" });
  });
  expect(writer.postMessage.mock.calls.some(([message]) => message.type === "writer-ready")).toBe(false);
});

async function inputBridge(sendCommand: ReturnType<typeof vi.fn>) {
  vi.resetModules();
  boot.inputStateEvents.mockReset().mockResolvedValue([]);
  boot.recoverDanglingRuns.mockReset().mockResolvedValue(undefined);
  boot.append.mockReset().mockResolvedValue({ id: 1 });
  const connects: ((port: chrome.runtime.Port) => void)[] = [];
  const event = () => ({ addListener: vi.fn(), removeListener: vi.fn() });
  vi.stubGlobal("chrome", {
    runtime: { id: "test", onConnect: { addListener: (listener: (port: chrome.runtime.Port) => void) => connects.push(listener) },
      onMessage: event(), onInstalled: event(), onStartup: event(), sendMessage: vi.fn(async () => undefined) },
    tabs: { query: vi.fn(async () => []), onUpdated: event() },
    debugger: { sendCommand, onEvent: event(), onDetach: event(), detach: vi.fn(async () => undefined) },
    scripting: { executeScript: vi.fn(async () => []) },
    sidePanel: { setPanelBehavior: vi.fn(async () => undefined) },
  });
  await import("./background");
  let ownerMessage!: (message: unknown) => void;
  const owner = { name: "surf-wax-run-owner", onMessage: { addListener: (listener: (message: unknown) => void) => { ownerMessage = listener; } },
    onDisconnect: event(), postMessage: vi.fn() };
  connects.forEach(listener => listener(owner as unknown as chrome.runtime.Port));
  ownerMessage({ type: "claim", runId: "run", ownerId: "owner", conversationId: "conversation" });
  await vi.waitFor(() => expect(owner.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "claimed", runId: "run" })));
  const identity = owner.postMessage.mock.calls.find(([value]) => value.type === "claimed")![0];
  const connectBridge = () => {
    let dispatch!: (message: unknown) => void, disconnect!: () => void;
    const bridge = { name: "surf-wax-debugger", onMessage: { addListener: (listener: (message: unknown) => void) => { dispatch = listener; } },
      onDisconnect: { addListener: (listener: () => void) => { disconnect = listener; } }, postMessage: vi.fn(), disconnect: vi.fn() };
    connects.forEach(listener => listener(bridge as unknown as chrome.runtime.Port));
    const send = (id: string, method: string, params: object, tabId = 7, rawCdp = false) => dispatch({ id, runId: identity.runId, ownerId: identity.ownerId, generation: identity.generation,
      operationId: `${id}-op`, method: "sendCommand", args: [{ tabId }, method, params], ...(rawCdp ? { rawCdp: true } : {}) });
    return { bridge, send, disconnect };
  };
  const { bridge, send, disconnect } = connectBridge();
  return { bridge, send, disconnect, connectBridge, finishOwner: () => ownerMessage({ type: "finished" }) };
}

it("does not interpret internal automation controls supplied by raw CDP", async () => {
  const sendCommand = vi.fn(async () => ({}));
  const { bridge, send, disconnect } = await inputBridge(sendCommand);
  for (const [id, params] of Object.entries({
    click: { type: "mousePressed", x: 1, y: 2, surfWaxAtomicClick: true },
    target: { text: "x", surfWaxTargetBackendNodeId: 7 },
    replace: { text: "x", surfWaxReplaceSelection: true },
  })) {
    send(id, id === "click" ? "Input.dispatchMouseEvent" : "Input.insertText", params, 7, true);
    await vi.waitFor(() => expect(bridge.postMessage).toHaveBeenCalledWith(expect.objectContaining({ id, error: expect.stringContaining("invalid-protocol-parameter") })));
  }
  expect(sendCommand).not.toHaveBeenCalled();
  disconnect();
});

it("dispatches editing keys without injecting page scripts", async () => {
  const sendCommand = vi.fn(async () => ({}));
  const { bridge, send, disconnect } = await inputBridge(sendCommand);
  for (const key of ["Backspace", "Delete", "Enter"]) {
    send(key, "Input.dispatchKeyEvent", { type: "rawKeyDown", key });
    await vi.waitFor(() => expect(bridge.postMessage).toHaveBeenCalledWith({ id: key, result: {} }));
  }
  expect(sendCommand.mock.calls.map(([, , params]: any[]) => params.key)).toEqual(["Backspace", "Delete", "Enter"]);
  expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
  disconnect();
});

it("serializes input per tab while allowing another tab to proceed", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const sendCommand = vi.fn(async (_source: object, method: string, params: any) => {
    if (method === "Input.dispatchKeyEvent" && params.key === "A") await pending;
    return {};
  });
  const { bridge, send, disconnect } = await inputBridge(sendCommand);
  send("a", "Input.dispatchKeyEvent", { type: "rawKeyDown", key: "A" });
  await vi.waitFor(() => expect(sendCommand).toHaveBeenCalledTimes(1));
  send("b", "Input.dispatchKeyEvent", { type: "rawKeyDown", key: "B" });
  send("c", "Input.dispatchKeyEvent", { type: "rawKeyDown", key: "C" }, 8);
  await vi.waitFor(() => expect(bridge.postMessage).toHaveBeenCalledWith({ id: "c", result: {} }));
  expect(sendCommand.mock.calls.some(([, , params]: any[]) => params.key === "B")).toBe(false);
  release();
  await vi.waitFor(() => expect(bridge.postMessage).toHaveBeenCalledWith({ id: "b", result: {} }));
  expect(sendCommand.mock.calls.map(([, , params]: any[]) => params.key)).toEqual(["A", "C", "B"]);
  disconnect();
});

it("revalidates the run after waiting for an earlier input transaction", async () => {
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const sendCommand = vi.fn(async () => { await waiting; return {}; });
  const { bridge, send, disconnect, finishOwner } = await inputBridge(sendCommand);
  send("a", "Input.dispatchKeyEvent", { type: "char", text: "a" });
  await vi.waitFor(() => expect(sendCommand).toHaveBeenCalledOnce());
  send("b", "Input.dispatchKeyEvent", { type: "char", text: "b" });
  finishOwner();
  release();
  await vi.waitFor(() => expect(bridge.postMessage).toHaveBeenCalledWith(expect.objectContaining({ id: "b", error: expect.any(String) })));
  expect(sendCommand).toHaveBeenCalledOnce();
  disconnect();
});

it("does not dispatch or leave a held key if the intent log write fails", async () => {
  const sendCommand = vi.fn(async (_source: object, _method: string, _params: any) => ({}));
  const { bridge, send, disconnect } = await inputBridge(sendCommand);
  boot.append.mockImplementation(async (entry) => {
    if (entry.type === "browser.input.state" && entry.content.keys.length) throw new Error("intent write failed");
    return { id: 1 };
  });
  send("key", "Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Shift", code: "ShiftLeft" });
  await vi.waitFor(() => expect(bridge.postMessage).toHaveBeenCalledWith({ id: "key", error: "intent write failed", dispatchState: "not-dispatched" }));
  disconnect(); await vi.waitFor(() => expect(bridge.disconnect).toHaveBeenCalled());
  expect(sendCommand.mock.calls.some(([, method]) => method === "Input.dispatchKeyEvent")).toBe(false);
});

it("does not persist char-only input as a held key or release a nonexistent key on disconnect", async () => {
  const sendCommand = vi.fn(async () => ({}));
  const { bridge, send, disconnect } = await inputBridge(sendCommand);
  send("char", "Input.dispatchKeyEvent", { type: "char", text: "é" });
  await vi.waitFor(() => expect(bridge.postMessage).toHaveBeenCalledWith({ id: "char", result: {} }));
  const states = boot.append.mock.calls.map(([entry]) => entry).filter(entry => entry.type === "browser.input.state");
  expect(states.length).toBeGreaterThan(0);
  expect(states.every(entry => entry.content.keys.length === 0)).toBe(true);
  disconnect();
  await vi.waitFor(() => expect(bridge.disconnect).toHaveBeenCalled());
  expect(sendCommand.mock.calls.some(([, method, params]: any[]) => method === "Input.dispatchKeyEvent" && params?.type === "keyUp")).toBe(false);
});

it("preserves failed releases in the canonical log for subsequent recovery", async () => {
  const sendCommand = vi.fn(async (_source: object, method: string, params: any) => {
    if ((method === "Input.dispatchKeyEvent" && params.type === "keyUp") || (method === "Input.dispatchMouseEvent" && params.type === "mouseReleased")) throw new Error("release failed");
    return {};
  });
  const { bridge, send, disconnect } = await inputBridge(sendCommand);
  send("down", "Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Shift", code: "ShiftLeft" });
  await vi.waitFor(() => expect(bridge.postMessage).toHaveBeenCalledWith({ id: "down", result: {} }));
  send("press", "Input.dispatchMouseEvent", { type: "mousePressed", button: "left", x: 5, y: 7 });
  await vi.waitFor(() => expect(bridge.postMessage).toHaveBeenCalledWith({ id: "press", result: {} }));
  send("up", "Input.dispatchKeyEvent", { type: "keyUp", key: "Shift" });
  await vi.waitFor(() => expect(bridge.postMessage).toHaveBeenCalledWith({ id: "up", error: "release failed", effectUnknown: true }));
  send("release", "Input.dispatchMouseEvent", { type: "mouseReleased", button: "left" });
  await vi.waitFor(() => expect(bridge.postMessage).toHaveBeenCalledWith({ id: "release", error: "release failed", effectUnknown: true }));
  disconnect();
  await vi.waitFor(() => expect(bridge.disconnect).toHaveBeenCalled());
  const states = boot.append.mock.calls.map(([entry]) => entry).filter(entry => entry.type === "browser.input.state");
  expect(states.at(-1).content).toMatchObject({ keys: [{ key: "Shift" }], buttons: [["left", { button: "left" }]] });
  expect(boot.append.mock.calls.some(([entry]) => entry.type === "browser.input.release-failed")).toBe(true);
  expect(sendCommand.mock.calls.filter(([, method, params]) => method === "Input.dispatchKeyEvent" && params.type === "keyUp")).toHaveLength(2);
  expect(sendCommand.mock.calls.filter(([, method, params]) => method === "Input.dispatchMouseEvent" && params.type === "mouseReleased")).toHaveLength(2);
});

it("does not let late release acknowledgements erase newer key or button presses", async () => {
  let releaseKey!: () => void, releaseButton!: () => void, startedKey!: () => void, startedButton!: () => void;
  const keyStarted = new Promise<void>(resolve => { startedKey = resolve; });
  const buttonStarted = new Promise<void>(resolve => { startedButton = resolve; });
  let delayKey = true, delayButton = true;
  const sendCommand = vi.fn(async (_source: object, method: string, params: any) => {
    if (method === "Input.dispatchKeyEvent" && params.type === "keyUp" && delayKey) {
      delayKey = false; startedKey(); await new Promise<void>(resolve => { releaseKey = resolve; });
    }
    if (method === "Input.dispatchMouseEvent" && params.type === "mouseReleased" && delayButton) {
      delayButton = false; startedButton(); await new Promise<void>(resolve => { releaseButton = resolve; });
    }
    return {};
  });
  const { bridge, send, disconnect } = await inputBridge(sendCommand);
  send("down-1", "Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Shift" });
  await vi.waitFor(() => expect(bridge.postMessage).toHaveBeenCalledWith({ id: "down-1", result: {} }));
  send("press-1", "Input.dispatchMouseEvent", { type: "mousePressed", button: "left" });
  await vi.waitFor(() => expect(bridge.postMessage).toHaveBeenCalledWith({ id: "press-1", result: {} }));
  send("up-1", "Input.dispatchKeyEvent", { type: "keyUp", key: "Shift" });
  send("release-1", "Input.dispatchMouseEvent", { type: "mouseReleased", button: "left" });
  await keyStarted;
  send("down-2", "Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Shift" });
  send("press-2", "Input.dispatchMouseEvent", { type: "mousePressed", button: "left" });
  releaseKey();
  await buttonStarted;
  releaseButton();
  await vi.waitFor(() => {
    expect(bridge.postMessage).toHaveBeenCalledWith({ id: "down-2", result: {} });
    expect(bridge.postMessage).toHaveBeenCalledWith({ id: "press-2", result: {} });
  });
  await vi.waitFor(() => {
    expect(bridge.postMessage).toHaveBeenCalledWith({ id: "up-1", result: {} });
    expect(bridge.postMessage).toHaveBeenCalledWith({ id: "release-1", result: {} });
  });
  const states = boot.append.mock.calls.map(([entry]) => entry).filter(entry => entry.type === "browser.input.state");
  expect(states.at(-1).content).toMatchObject({ keys: [{ key: "Shift" }], buttons: [["left", { button: "left" }]] });
  disconnect(); await vi.waitFor(() => expect(bridge.disconnect).toHaveBeenCalled());
  const final = boot.append.mock.calls.map(([entry]) => entry).filter(entry => entry.type === "browser.input.state").at(-1);
  expect(final.content).toMatchObject({ keys: [], buttons: [] });
});
