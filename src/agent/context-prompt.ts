import { z } from "zod";
import { GOAL_DESCRIPTION, GOAL_INSTRUCTIONS, GOAL_SCHEMA } from "./goal-completion";
import { createPromptSnapshot, PROMPT_TOOLS, type PromptSnapshot } from "./prompt";

export const GOAL_TOOLS = [...PROMPT_TOOLS, {
  type: "function", name: "complete_goal", description: GOAL_DESCRIPTION,
  inputSchema: z.toJSONSchema(GOAL_SCHEMA, { target: "draft-7", unrepresentable: "any" }),
}];

/** Execution, compaction and the counter describe the same fixed prompt. */
export function contextPrompt(snapshot: PromptSnapshot | undefined, goalMode = false) {
  return {
    instructions: createPromptSnapshot(snapshot?.source).instructions + (goalMode ? GOAL_INSTRUCTIONS : ""),
    tools: goalMode ? GOAL_TOOLS : PROMPT_TOOLS,
  };
}
