import { describe, expect, it } from "vitest";
import { decodeBridgeError, encodeBridgeError } from "./bridge-error";

describe("debugger bridge errors", () => {
  it("preserves both failures through the JSON port boundary", () => {
    const original = new Error("input failed");
    const rollback = new Error("rollback failed", { cause: original });
    const restored = decodeBridgeError(JSON.parse(JSON.stringify(encodeBridgeError(rollback))));
    expect(restored.message).toBe("rollback failed");
    expect(restored.stack).toContain("rollback failed");
    expect(restored.cause).toBeInstanceOf(Error);
    expect((restored.cause as Error).message).toBe("input failed");
  });
});
