import { describe, expect, it } from "vitest";
import { createHeldInputState, debuggeeKey, shouldPersistInputState, updateHeldInputState } from "./input-state";

describe("debugger input state", () => {
  it("uses stable keys for every Chrome debuggee shape", () => {
    expect(debuggeeKey({ targetId: "target" })).toBe("target:target");
    expect(debuggeeKey({ tabId: 7 })).toBe("tab:7");
    expect(debuggeeKey({ extensionId: "extension" })).toBe("extension:extension");
  });

  it("tracks pressed keys, buttons and the latest pointer position", () => {
    const state = createHeldInputState({ tabId: 7 }, 7, "run");
    updateHeldInputState(state, "Input.dispatchKeyEvent", { type: "keyDown", key: "Shift", modifiers: 8 });
    updateHeldInputState(state, "Input.dispatchMouseEvent", { type: "mousePressed", button: "left", x: 10, y: 20 });
    expect([...state.keys.values()]).toEqual([{ type: "keyDown", key: "Shift", modifiers: 8 }]);
    expect([...state.buttons]).toEqual([["left", { type: "mousePressed", button: "left", x: 10, y: 20 }]]);
    expect(state).toMatchObject({ x: 10, y: 20 });
    expect(shouldPersistInputState(state, "mouseMoved")).toBe(true);
    updateHeldInputState(state, "Input.dispatchKeyEvent", { type: "keyUp", key: "Shift" });
    updateHeldInputState(state, "Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", x: 11, y: 21 });
    expect(state.keys.size).toBe(0); expect(state.buttons.size).toBe(0);
    expect(shouldPersistInputState(state, "mouseReleased")).toBe(true);
  });

  it("does not track char events or key events without a real key", () => {
    const state = createHeldInputState({ tabId: 7 }, 7, "run");
    updateHeldInputState(state, "Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Shift" });
    updateHeldInputState(state, "Input.dispatchKeyEvent", { type: "char", text: "é" });
    updateHeldInputState(state, "Input.dispatchKeyEvent", { type: "char", key: "Shift", text: "é" });
    updateHeldInputState(state, "Input.dispatchKeyEvent", { type: "keyDown" });
    updateHeldInputState(state, "Input.dispatchKeyEvent", { type: "rawKeyDown", key: "" });
    updateHeldInputState(state, "Input.dispatchKeyEvent", { type: "keyUp" });
    expect([...state.keys.values()]).toEqual([{ type: "rawKeyDown", key: "Shift" }]);
    updateHeldInputState(state, "Input.dispatchKeyEvent", { type: "keyUp", key: "Shift" });
    expect(state.keys.size).toBe(0);
  });

  it("tracks distinct physical keys and releases code-only raw events", () => {
    const state = createHeldInputState({ tabId: 7 });
    updateHeldInputState(state, "Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Shift", code: "ShiftLeft" });
    updateHeldInputState(state, "Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Shift", code: "ShiftRight" });
    updateHeldInputState(state, "Input.dispatchKeyEvent", { type: "rawKeyDown", code: "KeyA" });
    expect(state.keys.size).toBe(3);
    updateHeldInputState(state, "Input.dispatchKeyEvent", { type: "keyUp", key: "Shift", code: "ShiftLeft" });
    updateHeldInputState(state, "Input.dispatchKeyEvent", { type: "keyUp", code: "KeyA" });
    expect([...state.keys.values()]).toEqual([{ type: "rawKeyDown", key: "Shift", code: "ShiftRight" }]);
    updateHeldInputState(state, "Input.dispatchKeyEvent", { type: "keyUp", key: "Shift" });
    expect(state.keys.size).toBe(0);
  });

  it("matches a more specific release only to a unique held key without a code", () => {
    const state = createHeldInputState({ tabId: 7 });
    updateHeldInputState(state, "Input.dispatchKeyEvent", { type: "rawKeyDown", key: "a" }, false, true);
    updateHeldInputState(state, "Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA" }, false, true);
    expect(state.keys.size).toBe(0);
    updateHeldInputState(state, "Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Shift", code: "ShiftRight" }, false, true);
    updateHeldInputState(state, "Input.dispatchKeyEvent", { type: "keyUp", key: "Shift", code: "ShiftLeft" }, false, true);
    expect([...state.keys.values()]).toEqual([{ type: "rawKeyDown", key: "Shift", code: "ShiftRight" }]);
    updateHeldInputState(state, "Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Shift" }, false, true);
    updateHeldInputState(state, "Input.dispatchKeyEvent", { type: "keyUp", key: "Shift", code: "ShiftLeft" }, false, true);
    expect([...state.keys.values()]).toEqual([{ type: "rawKeyDown", key: "Shift", code: "ShiftRight" }]);
  });

  it("does not invent a left-button press for a raw mouse event without a button", () => {
    const state = createHeldInputState({ tabId: 7 });
    updateHeldInputState(state, "Input.dispatchMouseEvent", { type: "mousePressed", x: 1, y: 2 }, false, true);
    expect(state.buttons.size).toBe(0);
  });
});
