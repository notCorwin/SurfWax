import { describe, expect, it, vi } from "vitest";
import { delay, imageSize, isTransientNavigationError, keyboardParams, macEditingCommands, parseKeyboardChord } from "./automation-utils";

describe("automation utilities", () => {
  it("only retries execution-context loss while navigation replaces a document", () => {
    expect(isTransientNavigationError(new Error("Execution context was destroyed."))).toBe(true);
    expect(isTransientNavigationError(new Error("Cannot find context with specified id"))).toBe(true);
    expect(isTransientNavigationError(new Error('Cannot access contents of url "about:blank#part"'))).toBe(false);
    expect(isTransientNavigationError(new DOMException("Operation aborted", "AbortError"))).toBe(false);
  });
  it("builds trusted keyboard event parameters", () => {
    expect(keyboardParams("Control+Enter")).toMatchObject({ key: "Enter", code: "Enter", modifiers: 2, windowsVirtualKeyCode: 13, text: "\r" });
    expect(keyboardParams("Shift+A")).toMatchObject({ key: "A", code: "KeyA", modifiers: 8 });
  });

  it("maps Mac native editor shortcuts across selection, navigation, deletion, clipboard and history", () => {
    for (const [code, mask, commands] of [
      ["KeyA", 4, ["selectAll"]], ["ArrowLeft", 12, ["moveToLeftEndOfLineAndModifySelection"]],
      ["ArrowRight", 1, ["moveWordRight"]], ["Backspace", 1, ["deleteWordBackward"]],
      ["KeyC", 4, ["copy"]], ["KeyX", 4, ["cut"]], ["KeyV", 4, ["paste"]],
      ["KeyZ", 4, ["undo"]], ["KeyZ", 12, ["redo"]], ["ArrowUp", 1, ["moveBackward", "moveToBeginningOfParagraph"]],
    ] as const) expect(macEditingCommands(code, mask, "MacIntel")).toEqual(commands);
    expect(macEditingCommands("KeyA", 4, "Linux x86_64")).toBeUndefined();
    expect(macEditingCommands("KeyA", 0, "MacIntel")).toBeUndefined();
    expect(macEditingCommands("Enter", 0, "MacIntel")).toBeUndefined();
  });

  it("recognizes literal plus, punctuation and common modifier names without dropping unknown modifiers", () => {
    expect(keyboardParams("+")).toMatchObject({ key: "+", code: "Equal", windowsVirtualKeyCode: 187, text: "+", modifiers: 0 });
    expect(keyboardParams("Ctrl++")).toMatchObject({ key: "+", code: "Equal", windowsVirtualKeyCode: 187, modifiers: 2 });
    expect(keyboardParams("?")).toMatchObject({ key: "?", code: "Slash", windowsVirtualKeyCode: 191, text: "?" });
    expect(keyboardParams("!")).toMatchObject({ key: "!", code: "Digit1", windowsVirtualKeyCode: 49 });
    expect(keyboardParams("Cmd+a")).toMatchObject({ key: "a", modifiers: 4 });
    expect(parseKeyboardChord("Shift+Ctrl++")).toEqual({ key: "+", modifiers: ["Shift", "Control"] });
    expect(() => keyboardParams("Contrll+a")).toThrow("AutomationError[invalid-key]");
    expect(() => keyboardParams("Control+")).toThrow("AutomationError[invalid-key]");
    expect(() => keyboardParams("Control+Ctrl+a")).toThrow("AutomationError[invalid-key]");
  });

  it("reads PNG dimensions without decoding pixels", () => {
    const bytes = new Uint8Array(24); new DataView(bytes.buffer).setUint32(16, 320); new DataView(bytes.buffer).setUint32(20, 200);
    expect(imageSize(btoa(String.fromCharCode(...bytes)), "png")).toEqual({ width: 320, height: 200 });
  });

  it("cancels abortable waits", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const waiting = delay(1000, controller.signal);
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    vi.useRealTimers();
  });
});
