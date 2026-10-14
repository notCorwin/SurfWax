import { describe, expect, it, vi } from "vitest";
import { delay, imageSize, keyboardParams } from "./automation-utils";

describe("automation utilities", () => {
  it("builds trusted keyboard event parameters", () => {
    expect(keyboardParams("Control+Enter")).toMatchObject({ key: "Enter", code: "Enter", modifiers: 2, windowsVirtualKeyCode: 13, text: "\r" });
    expect(keyboardParams("Shift+A")).toMatchObject({ key: "A", code: "KeyA", modifiers: 8 });
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
