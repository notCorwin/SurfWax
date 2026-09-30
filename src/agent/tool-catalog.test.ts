import { describe, expect, it } from "vitest";
import { materializeToolCatalog } from "./tool-catalog";

describe("persisted tool catalogue", () => {
  it("materializes its original version without mutating the UI message and is idempotent", () => {
    const original = { id: "u", role: "user", parts: [{ type: "text", text: "User request" }],
      metadata: { custom: { toolCatalog: { version: "0.2.0", context: "Available tools:\n- old-tool" } } } };
    const materialized = materializeToolCatalog(original);
    expect(materialized.parts).toEqual([...original.parts, { type: "text", text: "Available tools:\n- old-tool" }]);
    expect(original.parts).toHaveLength(1);
    expect(materializeToolCatalog(materialized)).toBe(materialized);
  });

  it("ignores absent, malformed, or non-user metadata", () => {
    for (const message of [null, { role: "user", parts: [] },
      { role: "assistant", parts: [], metadata: { custom: { toolCatalog: { version: "1", context: "context" } } } },
      { role: "user", parts: [], metadata: { custom: { toolCatalog: { version: 1, context: "context" } } } },
      { role: "user", parts: [], metadata: { custom: { toolCatalog: { version: "1", context: "" } } } },
      { role: "user", parts: [], metadata: { custom: { toolCatalog: ["1", "context"] } } },
    ]) expect(materializeToolCatalog(message)).toBe(message);
  });
});
