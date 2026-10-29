import { afterEach, expect, it, vi } from "vitest";
import { installPageGuard, removePageGuard } from "./chrome/interaction-guard";

const boot = vi.hoisted(() => ({ inputStateEvents: vi.fn(), append: vi.fn(), recoverDanglingRuns: vi.fn() }));
vi.mock("./logging", () => ({
  EventLogger: class { inputStateEvents = boot.inputStateEvents; append = boot.append; recoverDanglingRuns = boot.recoverDanglingRuns; },
  fromLogValue: (value: unknown) => value,
}));

afterEach(() => { removePageGuard(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

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

it("authorizes held-key cleanup while the disconnected guard still awaits DOM removal", async () => {
  vi.resetModules();
  boot.inputStateEvents.mockResolvedValue([]);
  boot.recoverDanglingRuns.mockResolvedValue(undefined);
  boot.append.mockResolvedValue({ id: 1 });
  const connects: ((port: chrome.runtime.Port) => void)[] = [];
  const event = () => ({ addListener: vi.fn(), removeListener: vi.fn() });
  const preventDefault = vi.fn();
  const stopImmediatePropagation = vi.fn();
  const sendCommand = vi.fn(async (_debuggee: object, method: string, params: Record<string, any>) => {
    if (method === "Input.dispatchKeyEvent") {
      (globalThis as any).__surfWaxBlocker.block({ type: "keyup", key: params.key, isTrusted: true,
        timeStamp: params.timestamp * 1000 - performance.timeOrigin, target: document.body, preventDefault, stopImmediatePropagation });
    }
    return {};
  });
  vi.stubGlobal("chrome", {
    runtime: { id: "test", onConnect: { addListener: (listener: (port: chrome.runtime.Port) => void) => connects.push(listener) },
      onMessage: event(), onInstalled: event(), onStartup: event(), sendMessage: vi.fn(async () => undefined) },
    tabs: { query: vi.fn(async () => []), onUpdated: event() },
    debugger: { sendCommand, onEvent: event(), onDetach: event() },
    scripting: { executeScript: vi.fn(async ({func, args = []}: {func:(...args:any[])=>unknown;args?:any[]}) => [{result:func(...args)}]) },
    sidePanel: { setPanelBehavior: vi.fn(async () => undefined) },
  });
  await import("./background");
  // The last port has gone, so the transient map is empty. Chrome has not yet
  // executed removePageGuard in this document; hardware input must still block.
  installPageGuard("closing-run");
  const hardwarePrevented = vi.fn();
  (globalThis as any).__surfWaxBlocker.block({type:"keyup", key:"Shift", isTrusted:true, timeStamp:performance.now(),
    target:document.body, preventDefault:hardwarePrevented, stopImmediatePropagation:vi.fn()});
  expect(hardwarePrevented).toHaveBeenCalledOnce();
  let dispatch!: (message: unknown) => void;
  const port = {name:"surf-wax-debugger", onMessage:{addListener:(listener:(message:unknown)=>void)=>{dispatch=listener;}},
    onDisconnect:event(), postMessage:vi.fn()};
  connects.forEach(listener => listener(port as unknown as chrome.runtime.Port));
  dispatch({id:"cleanup", runId:"closing-run", method:"sendCommand", args:[{tabId:7}, "Input.dispatchKeyEvent", {type:"keyUp",key:"Shift",modifiers:0}]});
  await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalledWith({id:"cleanup",result:{}}));
  expect(sendCommand).toHaveBeenCalledOnce();
  expect(preventDefault).not.toHaveBeenCalled();
  expect(stopImmediatePropagation).not.toHaveBeenCalled();
  // The ticket is revoked after the native command, even while the old guard remains.
  const afterCleanup = vi.fn();
  (globalThis as any).__surfWaxBlocker.block({type:"keyup",key:"Shift",isTrusted:true,timeStamp:performance.now(),
    target:document.body,preventDefault:afterCleanup,stopImmediatePropagation:vi.fn()});
  expect(afterCleanup).toHaveBeenCalledOnce();
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
  let dispatch!: (message: unknown) => void, disconnect!: () => void;
  const bridge = { name: "surf-wax-debugger", onMessage: { addListener: (listener: (message: unknown) => void) => { dispatch = listener; } },
    onDisconnect: { addListener: (listener: () => void) => { disconnect = listener; } }, postMessage: vi.fn(), disconnect: vi.fn() };
  connects.forEach(listener => listener(bridge as unknown as chrome.runtime.Port));
  const send = (id: string, method: string, params: object) => dispatch({ id, runId: identity.runId, ownerId: identity.ownerId, generation: identity.generation,
    operationId: `${id}-op`, method: "sendCommand", args: [{ tabId: 7 }, method, params] });
  return { bridge, send, disconnect };
}

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
  await vi.waitFor(() => expect(bridge.postMessage).toHaveBeenCalledWith({ id: "up", error: "release failed" }));
  send("release", "Input.dispatchMouseEvent", { type: "mouseReleased", button: "left" });
  await vi.waitFor(() => expect(bridge.postMessage).toHaveBeenCalledWith({ id: "release", error: "release failed" }));
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
  await Promise.all([keyStarted, buttonStarted]);
  send("down-2", "Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Shift" });
  send("press-2", "Input.dispatchMouseEvent", { type: "mousePressed", button: "left" });
  await vi.waitFor(() => {
    expect(bridge.postMessage).toHaveBeenCalledWith({ id: "down-2", result: {} });
    expect(bridge.postMessage).toHaveBeenCalledWith({ id: "press-2", result: {} });
  });
  releaseKey(); releaseButton();
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
