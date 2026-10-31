import { afterEach, expect, it, vi } from "vitest";
import { installPageGuard, removePageGuard } from "./chrome/interaction-guard";

const boot = vi.hoisted(() => ({ inputStateEvents: vi.fn(), append: vi.fn(), recoverDanglingRuns: vi.fn() }));
vi.mock("./logging", () => ({
  EventLogger: class { inputStateEvents = boot.inputStateEvents; append = boot.append; recoverDanglingRuns = boot.recoverDanglingRuns; },
  fromLogValue: (value: unknown) => value,
}));

afterEach(() => { removePageGuard(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const observedReceipt = { blockedBeforeInput: false, keydown: true, keyup: true, keypress: true };

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
  const send = (id: string, method: string, params: object, tabId = 7) => dispatch({ id, runId: identity.runId, ownerId: identity.ownerId, generation: identity.generation,
    operationId: `${id}-op`, method: "sendCommand", args: [{ tabId }, method, params] });
  const startGuard = async () => {
    let onMessage!: (message: unknown) => void;
    const port = { name: "surf-wax-page-guard", onMessage: { addListener: (listener: (message: unknown) => void) => { onMessage = listener; } }, onDisconnect: event(), postMessage: vi.fn() };
    connects.forEach(listener => listener(port as unknown as chrome.runtime.Port));
    onMessage({ ...identity, tabId: 7, id: "guard" });
    await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalledWith({ id: "guard", ready: true }));
  };
  return { bridge, send, disconnect, startGuard, finishOwner: () => ownerMessage({ type: "finished" }) };
}

it("serializes a tab's entire input ticket while allowing another tab to proceed", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const sendCommand = vi.fn(async (_source: object, method: string, params: any) => {
    if (method === "Input.dispatchKeyEvent" && params.key === "A") await pending;
    return {};
  });
  const { bridge, send, disconnect } = await inputBridge(sendCommand);
  installPageGuard("run");
  const scripting = vi.mocked(chrome.scripting.executeScript);
  scripting.mockImplementation(async ({ target, args = [] }: any) => [{ frameId: 0, documentId: `doc-${target.tabId}`, result: args[1] == null ? observedReceipt : true }] as any);
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

it("reports an unknown effect when guard revocation fails after input dispatch", async () => {
  const sendCommand = vi.fn(async () => ({}));
  const { bridge, send, disconnect } = await inputBridge(sendCommand);
  installPageGuard("run");
  vi.mocked(chrome.scripting.executeScript).mockImplementation(async ({ func, args = [] }: any) => {
    if (args[1] == null) throw new Error("frame navigated");
    return [{ frameId: 0, documentId: "doc", result: func(...args) }] as any;
  });
  send("key", "Input.dispatchKeyEvent", { type: "rawKeyDown", key: "X" });
  await vi.waitFor(() => expect(bridge.postMessage).toHaveBeenCalledWith({ id: "key", error: expect.stringContaining("guard-context-unavailable"), effectUnknown: true }));
  expect(sendCommand).toHaveBeenCalledOnce();
  disconnect();
});

it("reports an unknown effect when the guarded document changes during dispatch", async () => {
  const sendCommand = vi.fn(async () => ({}));
  const { bridge, send, disconnect } = await inputBridge(sendCommand);
  installPageGuard("run");
  vi.mocked(chrome.scripting.executeScript).mockImplementation(async ({ func, args = [] }: any) => [{
    frameId: 0, documentId: args[1] == null ? "new-document" : "old-document", result: func(...args),
  }] as any);
  send("key", "Input.dispatchKeyEvent", { type: "rawKeyDown", key: "X" });
  await vi.waitFor(() => expect(bridge.postMessage).toHaveBeenCalledWith({ id: "key", error: expect.stringContaining("guard-context-unavailable"), effectUnknown: true }));
  disconnect();
});

it.each(["replaced", "removed", "lost-ticket"] as const)("reports uncertainty when an authorized child frame is %s during key dispatch", async (change) => {
  const sendCommand = vi.fn(async () => ({}));
  const { bridge, send, disconnect } = await inputBridge(sendCommand);
  vi.mocked(chrome.scripting.executeScript).mockImplementation(async ({ args = [] }: any) => {
    const root = { frameId: 0, documentId: "root", result: args[1] == null ? observedReceipt : true };
    if (args[1] != null) return [root, { frameId: 1, documentId: "child", result: true }] as any;
    if (change === "removed") return [root] as any;
    return [root, { frameId: 1, documentId: change === "replaced" ? "replacement" : "child", result: undefined }] as any;
  });
  send("key", "Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Backspace" });
  await vi.waitFor(() => expect(bridge.postMessage).toHaveBeenCalledWith({ id: "key", error: expect.stringContaining("guard-context-unavailable"), effectUnknown: true }));
  expect(sendCommand).toHaveBeenCalledOnce();
  disconnect();
});

it("accepts surviving authorized frames and ignores frames without an authorized ticket", async () => {
  const sendCommand = vi.fn(async () => ({}));
  const { bridge, send, disconnect } = await inputBridge(sendCommand);
  vi.mocked(chrome.scripting.executeScript).mockImplementation(async ({ args = [] }: any) => {
    const authorized = args[1] != null;
    return [
      { frameId: 0, documentId: "root", result: authorized ? true : observedReceipt },
      { frameId: 1, documentId: "child", result: authorized ? true : observedReceipt },
      ...(authorized ? [{ frameId: 2, documentId: "unprotected", result: undefined }] : []),
    ] as any;
  });
  send("key", "Input.dispatchKeyEvent", { type: "rawKeyDown", key: "A" });
  await vi.waitFor(() => expect(bridge.postMessage).toHaveBeenCalledWith({ id: "key", result: {} }));
  disconnect();
});

it.each([undefined, true])("reports uncertainty when a new frame appears before key dispatch completes (ticket %s)", async (newFrameTicket) => {
  const sendCommand = vi.fn(async () => ({}));
  const { bridge, send, disconnect } = await inputBridge(sendCommand);
  vi.mocked(chrome.scripting.executeScript).mockImplementation(async ({ args = [] }: any) => {
    const authorized = args[1] != null;
    return [
      { frameId: 0, documentId: "root", result: authorized ? true : observedReceipt },
      ...(!authorized ? [{ frameId: 4, documentId: "new", result: newFrameTicket }] : []),
    ] as any;
  });
  send("key", "Input.dispatchKeyEvent", { type: "rawKeyDown", key: "A" });
  await vi.waitFor(() => expect(bridge.postMessage).toHaveBeenCalledWith({ id: "key", error: expect.stringContaining("guard-context-unavailable"), effectUnknown: true }));
  expect(sendCommand).toHaveBeenCalledOnce();
  disconnect();
});

it("refuses to dispatch a key when an existing frame did not authorize the expected guard", async () => {
  const sendCommand = vi.fn(async () => ({}));
  const { bridge, send, disconnect, startGuard } = await inputBridge(sendCommand);
  vi.mocked(chrome.scripting.executeScript).mockImplementation(async ({ func, args = [] }: any) => {
    if (func.name !== "authorizeGuardInput") return [] as any;
    const authorized = args[1] != null;
    return [
      { frameId: 0, documentId: "root", result: authorized ? true : observedReceipt },
      { frameId: 1, documentId: "child", result: undefined },
    ] as any;
  });
  await startGuard();
  send("key", "Input.dispatchKeyEvent", { type: "rawKeyDown", key: "A" });
  await vi.waitFor(() => expect(bridge.postMessage).toHaveBeenCalledWith({ id: "key", error: expect.stringContaining("guard-context-unavailable") }));
  expect(sendCommand).not.toHaveBeenCalled();
  disconnect();
});

it.each([
  ["rawKeyDown", "keydown"], ["keyDown", "keydown"], ["keyUp", "keyup"], ["char", "keypress"],
] as const)("reports an uncertain effect when %s delivers no %s", async (type, expected) => {
  const sendCommand = vi.fn(async () => ({}));
  const { bridge, send, disconnect } = await inputBridge(sendCommand);
  const wrong = { blockedBeforeInput: false, keydown: false, keyup: false, keypress: false,
    [expected === "keydown" ? "keyup" : "keydown"]: true };
  vi.mocked(chrome.scripting.executeScript).mockImplementation(async ({ args = [] }: any) => [{
    frameId: 0, documentId: "root", result: args[1] == null ? wrong : true,
  }] as any);
  send("key", "Input.dispatchKeyEvent", { type, key: "A", ...(type === "char" ? { text: "a" } : {}) });
  await vi.waitFor(() => expect(bridge.postMessage).toHaveBeenCalledWith({ id: "key", error: expect.stringContaining("input-unconfirmed"), effectUnknown: true }));
  expect(sendCommand).toHaveBeenCalledOnce();
  disconnect();
});

it.each([
  ["rawKeyDown", "keydown"], ["keyUp", "keyup"], ["char", "keypress"],
] as const)("accepts %s observed in an authorized child frame", async (type, expected) => {
  const sendCommand = vi.fn(async () => ({}));
  const { bridge, send, disconnect } = await inputBridge(sendCommand);
  const empty = { blockedBeforeInput: false, keydown: false, keyup: false, keypress: false };
  vi.mocked(chrome.scripting.executeScript).mockImplementation(async ({ args = [] }: any) => {
    const authorization = args[1] != null;
    return [
      { frameId: 0, documentId: "root", result: authorization ? true : empty },
      { frameId: 1, documentId: "child", result: authorization ? true : { ...empty, [expected]: true } },
    ] as any;
  });
  send("key", "Input.dispatchKeyEvent", { type, key: "A", ...(type === "char" ? { text: "a" } : {}) });
  await vi.waitFor(() => expect(bridge.postMessage).toHaveBeenCalledWith({ id: "key", result: {} }));
  disconnect();
});

it("does not treat an unrelated child navigation as a pointer failure", async () => {
  const sendCommand = vi.fn(async () => ({}));
  const { bridge, send, disconnect } = await inputBridge(sendCommand);
  vi.mocked(chrome.scripting.executeScript).mockImplementation(async ({ args = [] }: any) => {
    const authorized = args[1] != null;
    return [
      { frameId: 0, documentId: "root", result: authorized ? true : observedReceipt },
      { frameId: 1, documentId: authorized ? "child" : "replacement", result: authorized ? true : undefined },
    ] as any;
  });
  send("move", "Input.dispatchMouseEvent", { type: "mouseMoved", x: 1, y: 1 });
  await vi.waitFor(() => expect(bridge.postMessage).toHaveBeenCalledWith({ id: "move", result: {} }));
  disconnect();
});

it("does not dispatch when an expected guard cannot authorize the input", async () => {
  const sendCommand = vi.fn(async () => ({}));
  const { bridge, send, disconnect, startGuard } = await inputBridge(sendCommand);
  vi.mocked(chrome.scripting.executeScript).mockImplementation(async ({ func, args = [] }: any) => {
    if (func.name === "authorizeGuardInput" && args[1] != null) throw new Error("frame unavailable");
    return [{ frameId: 0, documentId: "doc", result: func(...args) }] as any;
  });
  await startGuard();
  send("key", "Input.dispatchKeyEvent", { type: "rawKeyDown", key: "X" });
  await vi.waitFor(() => expect(bridge.postMessage).toHaveBeenCalledWith({ id: "key", error: expect.stringContaining("guard-context-unavailable") }));
  expect(sendCommand).not.toHaveBeenCalled();
  disconnect();
});

it("reports blocked edits from key dispatch as uncertain and leaves canceled or non-editing keys alone", async () => {
  const prevent = vi.fn();
  const sendCommand = vi.fn(async (_source: object, method: string, params: any) => {
    if (method === "Input.dispatchKeyEvent") {
      (globalThis as any).__surfWaxBlocker.block({ type: "keydown", target: document.body, isTrusted: true,
        timeStamp: params.timestamp * 1000 - performance.timeOrigin, preventDefault: vi.fn(), stopImmediatePropagation: vi.fn() });
    }
    if (method === "Input.dispatchKeyEvent" && ["Backspace", "Delete", "Enter"].includes(params.key)) {
      (globalThis as any).__surfWaxBlocker.block({ type: "beforeinput", target: document.body, isTrusted: true,
        timeStamp: performance.now(), preventDefault: prevent, stopImmediatePropagation: vi.fn() });
    }
    return {};
  });
  const { bridge, send, disconnect } = await inputBridge(sendCommand);
  installPageGuard("run");
  vi.mocked(chrome.scripting.executeScript).mockImplementation(async ({ func, args = [] }: any) => [{ frameId: 0, documentId: "doc", result: func(...args) }] as any);
  for (const key of ["Backspace", "Delete", "Enter"]) {
    send(key, "Input.dispatchKeyEvent", { type: key === "Enter" ? "keyDown" : "rawKeyDown", key });
    await vi.waitFor(() => expect(bridge.postMessage).toHaveBeenCalledWith({ id: key, error: expect.stringContaining("AutomationError[guard-blocked-input]"), effectUnknown: true }));
  }
  expect(prevent).toHaveBeenCalledTimes(3);
  // A page-cancelled key or Enter on a non-editable element emits no beforeinput.
  send("cancelled", "Input.dispatchKeyEvent", { type: "rawKeyDown", key: "cancelled" });
  await vi.waitFor(() => expect(bridge.postMessage).toHaveBeenCalledWith({ id: "cancelled", result: {} }));
  disconnect();
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
