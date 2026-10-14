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
    expect([...state.keys]).toEqual([["Shift", { type: "keyDown", key: "Shift", modifiers: 8 }]]);
    expect([...state.buttons]).toEqual([["left", { type: "mousePressed", button: "left", x: 10, y: 20 }]]);
    expect(state).toMatchObject({ x: 10, y: 20 });
    expect(shouldPersistInputState(state, "mouseMoved")).toBe(true);
    updateHeldInputState(state, "Input.dispatchKeyEvent", { type: "keyUp", key: "Shift" });
    updateHeldInputState(state, "Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", x: 11, y: 21 });
    expect(state.keys.size).toBe(0); expect(state.buttons.size).toBe(0);
    expect(shouldPersistInputState(state, "mouseReleased")).toBe(true);
  });
});
