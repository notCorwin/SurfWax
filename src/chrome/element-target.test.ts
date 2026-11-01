import { describe, expect, it } from "vitest";
import { zodSchema } from "ai";
import { z } from "zod";
import { elementTargetSchema } from "./element-target";

describe("element target contract", () => {
  it("accepts only options meaningful for each locator kind", () => {
    expect(elementTargetSchema.safeParse({ by: "role", value: "button", name: "Save", exact: true, index: -1 }).success).toBe(true);
    expect(elementTargetSchema.safeParse({ by: "label", value: "Email", exact: true }).success).toBe(true);
    expect(elementTargetSchema.safeParse({ by: "css", value: "button", name: "Save" }).success).toBe(false);
    expect(elementTargetSchema.safeParse({ by: "text", value: "Save", name: "Save" }).success).toBe(false);
    expect(elementTargetSchema.safeParse({ by: "testId", value: "save", exact: false }).success).toBe(false);
  });

  it("uses either an element ref or a locator scoped by a frame ref", () => {
    expect(elementTargetSchema.safeParse({ ref: "element", frame: { ref: "frame" } }).success).toBe(false);
    expect(elementTargetSchema.safeParse({ ref: "element" }).success).toBe(true);
    expect(elementTargetSchema.safeParse({ by: "role", value: "button", frame: { ref: "frame" } }).success).toBe(true);
  });

  it("exposes locator-specific restrictions and semantics in JSON Schema", () => {
    const schema = z.toJSONSchema(elementTargetSchema, { target: "draft-7" });
    const serialized = JSON.stringify(schema);
    expect(serialized).toContain("accessible role");
    expect(serialized).toContain("zero-based index");
    expect(serialized).toContain("testId always matches exactly");
    const branches = schema.anyOf as Array<{ properties: Record<string, unknown>; additionalProperties: boolean; allOf?: unknown[] }>;
    expect(branches.every((branch) => branch.additionalProperties === false)).toBe(true);
    expect(branches[1]?.allOf).toHaveLength(1);
  });

  it("retains locator restrictions in the AI SDK's schema and validation", async () => {
    const sdkSchema = zodSchema(elementTargetSchema);
    const schema = await sdkSchema.jsonSchema as { anyOf: Array<{ allOf?: Array<{ anyOf: unknown[] }> }> };
    expect(schema.anyOf[1]?.allOf?.[0]?.anyOf).toEqual([
      { properties: { by: { const: "role" } } },
      { properties: { by: { enum: ["text", "label", "placeholder", "alt", "title"] } }, not: { required: ["name"] } },
      { properties: { by: { const: "css" }, value: { minLength: 1 } }, not: { anyOf: [{ required: ["name"] }, { required: ["exact"] }] } },
      { properties: { by: { const: "testId" } }, not: { anyOf: [{ required: ["name"] }, { required: ["exact"] }] } },
    ]);
    expect((await sdkSchema.validate!({ by: "role", value: "button", name: "Save" })).success).toBe(true);
    expect((await sdkSchema.validate!({ by: "text", value: "Save", name: "Save" })).success).toBe(false);
  });
});
