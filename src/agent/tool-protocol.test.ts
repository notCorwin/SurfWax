import { describe, expect, it } from "vitest";
import { z } from "zod";
import { PROGRAM_TOOL_REGISTRY } from "../chrome/tool";

describe("tool protocol", () => {
  it("exposes conditional input constraints in the model-facing JSON Schema", () => {
    const schema = (name: string) =>
      z.toJSONSchema(
        PROGRAM_TOOL_REGISTRY.find((tool) => tool.name === name)!.inputSchema,
      ) as any;
    expect(schema("inspect_page").allOf).toEqual([
      ...["region", "fields", "depth", "offset", "full", "since"].map(
        (field) => ({ not: { required: ["cursor", field] } }),
      ),
      { not: { required: ["full", "since"] } },
    ]);
    expect(schema("upload_file").required).toContain("target");
    expect(schema("upload_file_chooser").required).toContain("chooserId");
    expect(schema("handle_dialog").anyOf).toEqual([
      { not: { required: ["prompt"] } },
      { properties: { accept: { const: true } }, required: ["accept"] },
    ]);
  });

  it("enforces the same conditional constraints when calls are executed", () => {
    const accepts = (name: string, input: unknown) =>
      PROGRAM_TOOL_REGISTRY.find(
        (tool) => tool.name === name,
      )!.inputSchema.safeParse(input).success;
    expect(accepts("inspect_page", { cursor: "c", limit: 10 })).toBe(true);
    expect(accepts("inspect_page", { since: "old" })).toBe(true);
    expect(accepts("inspect_page", { since: "old", full: true })).toBe(false);
    expect(accepts("inspect_page", { since: "old", cursor: "page" })).toBe(
      false,
    );
    expect(accepts("inspect_page", { cursor: "c", region: "main" })).toBe(
      false,
    );
    expect(
      accepts("upload_file", { artifactId: 1, target: { id: "e1" }, tabId: 1 }),
    ).toBe(true);
    expect(
      accepts("upload_file_chooser", { artifactId: 1, chooserId: "c" }),
    ).toBe(true);
    expect(accepts("upload_file", { artifactId: 1 })).toBe(false);
    expect(
      accepts("upload_file", {
        artifactId: 1,
        chooserId: "c",
        target: { id: "e1" },
      }),
    ).toBe(false);
    expect(
      accepts("upload_file_chooser", {
        artifactId: 1,
        chooserId: "c",
        background: false,
      }),
    ).toBe(false);
    expect(
      accepts("upload_file_chooser", {
        artifactId: 1,
        chooserId: "c",
        tabId: 1,
      }),
    ).toBe(false);
    expect(
      accepts("handle_dialog", {
        dialogId: "d",
        accept: true,
        prompt: "answer",
      }),
    ).toBe(true);
    expect(
      accepts("handle_dialog", {
        dialogId: "d",
        accept: false,
        prompt: "answer",
      }),
    ).toBe(false);
  });
});

it("reports the recovery field and bounded copyable evidence IDs without accepting job IDs", async () => {
  const { validateGoal } = await import("./goal-completion");
  const entries = Array.from({ length: 20 }, (_, i) => ({ id: `tool:observed-${i}`, name: "inspect_page", success: true, pageObserved: true as const, effectUnknown: false, order: i }));
  const goal = { taskType: "browser" as const, status: "blocked" as const, dependency: "authentication" as const, userAction: "Sign in",
    evidence: [{ evidenceId: "tool:observed-19", observation: "Sign-in page" }], attemptedRecovery: [{ evidenceId: "tool:job-913", action: "Inspected" }] };
  const error = validateGoal(goal, entries)!;
  expect(error).toContain('attemptedRecovery');
  expect(error).toContain('tool:job-913');
  expect(error).toContain('tool:observed-19');
  expect(error).not.toContain('tool:observed-11');
  expect(validateGoal({ ...goal, attemptedRecovery: [{ evidenceId: "tool:observed-19", action: "Inspected" }] }, entries)).toBeUndefined();
  expect(validateGoal({ ...goal, evidence: [{ evidenceId: "observed-19", observation: "Sign-in page" }] }, entries)).toContain('tool:observed-19');
});
