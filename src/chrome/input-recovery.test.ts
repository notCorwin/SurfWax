import { describe, expect, it, vi } from "vitest";
import { toLogValue, type LogEvent } from "../logging";
import { recoverBrowserInput } from "./input-recovery";

function event(runId: string, tabId: number, keys: Record<string, unknown>[], buttons: [string, Record<string, unknown>][] = [], sessionId?: string): LogEvent {
  return { id: 1, timestamp: "now", type: "browser.input.state", runId, content: toLogValue({ tabId, debuggee: { tabId, sessionId }, x: 80, y: 45, keys, buttons }) };
}
function api() {
  return { attach: vi.fn(async (_debuggee: object, _version: string) => undefined), sendCommand: vi.fn(async (_debuggee: object, _method: string, _params: object) => ({})), detach: vi.fn(async (_debuggee: object) => undefined) };
}

describe("orphan browser input recovery", () => {
  it("uses the latest canonical state for each source and releases through a fresh root session", async () => {
    const debuggerApi = api();
    const events = [event("orphan", 1, [{ key: "Control" }]), event("orphan", 1, [{ key: "Shift", code: "ShiftLeft", modifiers: 8 }], [["left", { clickCount: 1 }]]), event("orphan", 1, [{ key: "a", code: "KeyA", text: "a" }], [], "expired-frame"), event("active", 2, [{ key: "Meta" }])];
    expect(await recoverBrowserInput(events, ["orphan"], debuggerApi as never)).toEqual({ recovered: 1, failures: [] });
    expect(debuggerApi.attach).toHaveBeenCalledExactlyOnceWith({ tabId: 1 }, "1.3");
    expect(debuggerApi.sendCommand).toHaveBeenCalledWith({ tabId: 1 }, "Input.dispatchKeyEvent", expect.objectContaining({ key: "Shift", type: "keyUp", modifiers: 0 }));
    expect(debuggerApi.sendCommand).toHaveBeenCalledWith({ tabId: 1 }, "Input.dispatchKeyEvent", expect.objectContaining({ key: "a", type: "keyUp", text: undefined }));
    expect(debuggerApi.sendCommand).toHaveBeenCalledWith({ tabId: 1 }, "Input.dispatchMouseEvent", expect.objectContaining({ type: "mouseReleased", button: "left", x: 80, y: 45, buttons: 0 }));
    expect(debuggerApi.sendCommand.mock.calls.some(([, , params]) => (params as any)?.key === "Control")).toBe(false);
    expect(debuggerApi.detach).toHaveBeenCalledExactlyOnceWith({ tabId: 1 });
  });
  it("ignores released keys and continues after an unavailable tab", async () => {
    const debuggerApi = api();
    debuggerApi.attach.mockRejectedValueOnce(new Error("No target"));
    const events = [event("orphan", 1, [{ key: "Shift" }]), event("orphan", 2, [{ key: "Shift" }]), event("orphan", 2, [])];
    expect(await recoverBrowserInput(events, ["orphan"], debuggerApi as never)).toEqual({ recovered: 0, failures: [{ tabId: 1, error: "Error: No target" }] });
    expect(debuggerApi.sendCommand).not.toHaveBeenCalled();
    expect(debuggerApi.detach).toHaveBeenCalledExactlyOnceWith({ tabId: 1 });
  });
  it("releases an attachment retained by the same extension after Worker termination", async () => {
    const debuggerApi = api(); debuggerApi.attach.mockRejectedValueOnce(new Error("Another debugger is already attached to the tab"));
    await recoverBrowserInput([event("orphan", 1, [{ key: "Shift" }])], ["orphan"], debuggerApi as never);
    expect(debuggerApi.sendCommand).toHaveBeenCalledWith({ tabId: 1 }, "Input.dispatchKeyEvent", expect.objectContaining({ key: "Shift", type: "keyUp" }));
  });
  it("recovers held input after the conversation terminal and skips its settled snapshot on later boots", async () => {
    const debuggerApi = api();
    const held = event("finished", 1, [{ key: "Shift" }], [["left", {}]]);
    const terminal: LogEvent = { id: 2, timestamp: "now", type: "conversation.finished", runId: "finished", content: null };
    const events = [held, terminal];
    const runIds = [...new Set(events.filter((item) => item.type === "browser.input.state").map((item) => item.runId!))];
    expect(await recoverBrowserInput(events, runIds, debuggerApi as never)).toEqual({ recovered: 1, failures: [] });
    debuggerApi.attach.mockClear(); debuggerApi.sendCommand.mockClear(); debuggerApi.detach.mockClear();
    expect(await recoverBrowserInput([...events, event("finished", 1, [])], runIds, debuggerApi as never)).toEqual({ recovered: 0, failures: [] });
    expect(debuggerApi.attach).not.toHaveBeenCalled(); expect(debuggerApi.sendCommand).not.toHaveBeenCalled();
  });
});
