import { describe, expect, it } from "vitest";
import { createFrameHandle } from "./snapshot-frame-handle";

function decodedHex(handle: string): string {
  const encoded = handle.slice(1).replaceAll("-", "+").replaceAll("_", "/");
  return [...atob(`${encoded}==`)].map((character) => character.charCodeAt(0).toString(16).padStart(2, "0")).join("");
}

describe("frame handles", () => {
  it.each([
    "00000000-0000-0000-0000-000000000000",
    "ffffffff-ffff-ffff-ffff-ffffffffffff",
    "017f17ee-4223-43b7-8e9b-be2e1ff130c4",
    "6120211d-c0d1-4cc1-ac04-2e3df5180f2a",
  ])("preserves all UUID bits and produces a short safe handle: %s", (uuid) => {
    const handle = createFrameHandle(uuid);
    expect(handle).toMatch(/^f[A-Za-z0-9_-]{22}$/);
    expect(decodedHex(handle)).toBe(uuid.replaceAll("-", ""));
    expect(createFrameHandle(uuid.toUpperCase())).toBe(handle);
  });

  it("distinguishes adjacent UUID values and rejects malformed UUIDs", () => {
    expect(createFrameHandle("00000000-0000-0000-0000-000000000000"))
      .not.toBe(createFrameHandle("00000000-0000-0000-0000-000000000001"));
    expect(() => createFrameHandle("00000000000000000000000000000000")).toThrow(TypeError);
    expect(() => createFrameHandle("00000000-0000-0000-0000-00000000000g")).toThrow(TypeError);
  });

  it("uses the platform's random UUID when no value is provided", () => {
    expect(createFrameHandle()).toMatch(/^f[A-Za-z0-9_-]{22}$/);
    expect(createFrameHandle()).not.toBe(createFrameHandle());
  });
});
