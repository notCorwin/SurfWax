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
    expect(instructions).toContain("upload_file with the chooserId");
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
});
