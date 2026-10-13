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
