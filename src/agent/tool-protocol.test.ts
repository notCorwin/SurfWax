import { describe, expect, it } from "vitest";
import { z } from "zod";
import { PROGRAM_TOOL_REGISTRY } from "../chrome/tool";
import { createPromptSnapshot } from "./prompt";

describe("tool protocol", () => {
  it("keeps background, dialog and chooser instructions with custom prompts", () => {
    const instructions = createPromptSnapshot("Custom instructions").instructions;
    expect(instructions).toContain("Custom instructions");
    expect(instructions).toContain("background=true");
    expect(instructions).toContain("after set to the previous nextCursor");
    expect(instructions).toContain("handle_dialog");
    expect(instructions).toContain("upload_file_chooser with the chooserId");
  });

  it("describes how event and job cursors map to their input fields", () => {
    for (const name of ["wait_event", "get_job"]) {
      const definition = PROGRAM_TOOL_REGISTRY.find((tool) => tool.name === name)!;
      const schema = z.toJSONSchema(definition.inputSchema);
      const after = schema.properties?.after;
      expect(after && typeof after === "object" && after.description).toContain("nextCursor");
      expect(definition.description).toContain("as after");
    }
    const event = PROGRAM_TOOL_REGISTRY.find((tool) => tool.name === "wait_event")!;
    expect((z.toJSONSchema(event.inputSchema) as any).properties.after.description).toContain("cursor from subscribe_event");
    for (const name of ["inspect_page", "find_elements", "list_frames", "list_jobs"]) {
      expect(PROGRAM_TOOL_REGISTRY.find((tool) => tool.name === name)!.description).toContain("nextCursor as cursor");
    }
  });

  it("exposes automatic, pinned and full snapshots and explains long lines", () => {
    const inspect = PROGRAM_TOOL_REGISTRY.find((tool) => tool.name === "inspect_page")!;
    expect(z.toJSONSchema(inspect.inputSchema).properties).toHaveProperty("since");
    expect(z.toJSONSchema(inspect.inputSchema).properties).toHaveProperty("full");
    expect(inspect.description).not.toContain("For since");
    expect(inspect.description).toContain("Long lines can continue across pages");
  });

  it("exposes conditional input constraints in the model-facing JSON Schema", () => {
    const schema = (name: string) => z.toJSONSchema(PROGRAM_TOOL_REGISTRY.find((tool) => tool.name === name)!.inputSchema) as any;
    expect(schema("inspect_page").allOf).toEqual([... ["region", "fields", "depth", "offset", "full", "since"].map((field) => ({ not: { required: ["cursor", field] } })), { not: { required: ["full", "since"] } }]);
    expect(schema("upload_file").required).toContain("target");
    expect(schema("upload_file_chooser").required).toContain("chooserId");
    expect(schema("handle_dialog").anyOf).toEqual([
      { not: { required: ["prompt"] } },
      { properties: { accept: { const: true } }, required: ["accept"] },
    ]);
  });

  it("enforces the same conditional constraints when calls are executed", () => {
    const accepts = (name: string, input: unknown) => PROGRAM_TOOL_REGISTRY.find((tool) => tool.name === name)!.inputSchema.safeParse(input).success;
    expect(accepts("inspect_page", { cursor: "c", limit: 10 })).toBe(true);
    expect(accepts("inspect_page", { since: "old" })).toBe(true);
    expect(accepts("inspect_page", { since: "old", full: true })).toBe(false);
    expect(accepts("inspect_page", { since: "old", cursor: "page" })).toBe(false);
    expect(accepts("inspect_page", { cursor: "c", region: "main" })).toBe(false);
    expect(accepts("upload_file", { artifactId: 1, target: { ref: "e1" }, tabId: 1 })).toBe(true);
    expect(accepts("upload_file_chooser", { artifactId: 1, chooserId: "c" })).toBe(true);
    expect(accepts("upload_file", { artifactId: 1 })).toBe(false);
    expect(accepts("upload_file", { artifactId: 1, chooserId: "c", target: { ref: "e1" } })).toBe(false);
    expect(accepts("upload_file_chooser", { artifactId: 1, chooserId: "c", background: false })).toBe(false);
    expect(accepts("upload_file_chooser", { artifactId: 1, chooserId: "c", tabId: 1 })).toBe(false);
    expect(accepts("handle_dialog", { dialogId: "d", accept: true, prompt: "answer" })).toBe(true);
    expect(accepts("handle_dialog", { dialogId: "d", accept: false, prompt: "answer" })).toBe(false);
  });
});
