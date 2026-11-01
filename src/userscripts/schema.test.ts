import { describe, expect, it } from "vitest";
import { z } from "zod";
import { scriptChanges, scriptDefinition, scriptId } from "./schema";

describe("user script tool schemas", () => {
  it("exposes the script ID restriction in the JSON Schema", () => {
    const schema = z.toJSONSchema(scriptId, { target: "draft-7" });
    expect(schema.pattern).toBe("^[^_]");
    expect(new RegExp(schema.pattern as string).test("_reserved")).toBe(false);
    expect(scriptId.safeParse("_reserved").success).toBe(false);
    expect(scriptId.safeParse("example").success).toBe(true);
  });

  it("explains the Chrome fields and update semantics in the model-facing schema", () => {
    const definition = JSON.stringify(z.toJSONSchema(scriptDefinition, { target: "draft-7" }));
    expect(definition).toContain("Chrome match patterns");
    expect(definition).toContain("relative to the extension root");
    expect(definition).toContain("defaults to document_idle");
    expect(definition).toContain("Only valid when world is omitted or USER_SCRIPT");
    const changes = z.toJSONSchema(scriptChanges, { target: "draft-7" });
    expect(changes.description).toContain("null removes the setting");
    expect(scriptChanges.safeParse({ runAt: null }).success).toBe(true);
    expect(scriptChanges.safeParse({}).success).toBe(false);
  });
});
