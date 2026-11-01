import { z } from "zod";
import { fromLogValue, type EventLogger } from "../logging";

const text = z.string().trim().min(1);
const reference = z.object({ toolCallId: text.describe("The evidenceId returned by the tool."), observation: text,
  resolves: z.array(text).optional().describe("Evidence IDs of uncertain effects this later observation actually checked, whether the effect occurred or did not occur.") }).strict();
const recovery = z.object({ toolCallId: text.describe("The evidenceId of an actual recovery or diagnostic action."), action: text }).strict();
type Reference = z.infer<typeof reference>;
type Recovery = z.infer<typeof recovery>;
type Dependency = "authentication" | "user_information" | "external_dependency";
export type Goal = { taskType: "answer"; status: "completed"; summary: string }
  | { taskType: "browser"; status: "completed"; summary: string; evidence: Reference[] }
  | { taskType: "browser"; status: "blocked"; summary: string; evidence: Reference[]; dependency: Dependency; userAction: string; attemptedRecovery: Recovery[] };
// Providers require an object at the function schema root. Conditional requirements
// remain enforced locally because the wire schema cannot express them portably.
export const GOAL_SCHEMA = z.object({ taskType: z.enum(["answer", "browser"]), status: z.enum(["completed", "blocked"]), summary: text,
  evidence: z.array(reference).min(1).optional(), dependency: z.enum(["authentication", "user_information", "external_dependency"]).optional(),
  userAction: text.optional(), attemptedRecovery: z.array(recovery).min(1).optional(),
}).strict().superRefine((value, context) => {
  const reject = (message: string) => context.addIssue({ code: "custom", message });
  if (value.taskType === "answer") {
    if (value.status !== "completed" || value.evidence !== undefined || value.dependency !== undefined || value.userAction !== undefined || value.attemptedRecovery !== undefined)
      reject("Answer mode requires completed status and no browser evidence or blocker fields.");
    return;
  }
  if (!value.evidence) reject("Browser goals require evidence.");
  if (value.status === "blocked") {
    if (!value.dependency || !value.userAction || !value.attemptedRecovery) reject("A blocker requires dependency, userAction, and attemptedRecovery.");
  } else if (value.dependency !== undefined || value.userAction !== undefined || value.attemptedRecovery !== undefined)
    reject("A completed goal cannot include blocker fields.");
}) as z.ZodType<Goal>;
export const GOAL_DESCRIPTION = "Finish only after all work and background jobs have finished. For a browser task cite evidenceId values from actual tool results; for a blocker identify the user dependency, needed action, attempted recovery, and successful observations. Use answer only for a pure question with no browser work. Call this tool alone.";
export const GOAL_INSTRUCTIONS = "\n\nContinue until the user's outcome is achieved or a genuine user dependency prevents further progress. Plain text does not end work. Call complete_goal alone with a structured outcome and evidence from this run. A dispatched action is not proof of the outcome; cite at least one successful observation. For each effectUnknown, inspect or otherwise observe the relevant state after that action, explain what was established, and include its evidenceId in that observation's resolves array. A verified absence may permit a safe recovery action; continue to the requested outcome before reporting completion. verify_state evidence must report verified=true. Do not report a recoverable error as a user blocker.\n- complete_goal: Report a completed answer, a browser outcome supported by tool evidence, or a genuine user-dependent blocker.";

type Evidence = { id: string; name: string; success: boolean; effectUnknown: boolean; order: number };
type Cache = { runId: string; cursor: number; epoch?: string; entries: Map<string, Evidence> };
const caches = new WeakMap<EventLogger, Map<string, Cache>>();

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function verification(output: unknown): unknown {
  const value = object(output);
  const result = object(value.result);
  return object(value.verification).verified ?? result.verified ?? (value.envelopeWrapped === true ? object(result.result).verified : undefined) ?? value.verified;
}
function projectEvidence(id: string, name: string, output: unknown, failed: boolean, order: number): Evidence {
  const value = object(output);
  return { id, name, order, effectUnknown: object(value.error).effectUnknown === true,
    success: !failed && value.ok !== false && !["running", "blocked", "failed", "cancelled", "interrupted"].includes(String(value.state))
      && !(value.accepted === true && value.complete === false)
      && !(name === "get_job" && value.terminal !== true)
      && !(name === "verify_state" && verification(output) !== true) };
}
function successful(entry: Evidence): boolean { return entry.success; }
const OBSERVATION_TOOLS = new Set(["inspect_page", "find_elements", "list_frames", "read_text", "read_value", "read_attribute", "read_checked", "read_elements", "count_elements", "get_page_info", "verify_state", "wait_for_url", "take_screenshot", "list_tabs", "list_downloads", "read_artifact", "list_requests", "read_response", "read_console", "list_scripts", "read_script", "list_jobs", "get_job", "wait_event"]);
function observation(entry: Evidence): boolean { return OBSERVATION_TOOLS.has(entry.name) && successful(entry); }
function unknownEffect(entry: Evidence): boolean { return entry.effectUnknown; }

/** Release only the matching run, so a late cleanup cannot evict its replacement. */
export function releaseRunEvidence(logger: EventLogger, conversationId: string, runId: string): void {
  const runs = caches.get(logger);
  if (runs?.get(conversationId)?.runId !== runId) return;
  runs.delete(conversationId);
  if (!runs.size) caches.delete(logger);
}

/** Incremental canonical projection shared by all agent instances in the same run. */
export async function runEvidence(logger: EventLogger, conversationId: string, runId: string): Promise<Evidence[]> {
  let runs = caches.get(logger);
  if (!runs) { runs = new Map(); caches.set(logger, runs); }
  let cache = runs.get(conversationId);
  if (!cache || cache.runId !== runId) { cache = { runId, cursor: -1, entries: new Map() }; runs.set(conversationId, cache); }
  let batch = await logger.contextProjectionEvents(conversationId, cache.cursor);
  if (cache.epoch && cache.epoch !== batch.epoch) {
    cache = { runId, cursor: -1, entries: new Map() }; runs.set(conversationId, cache);
    batch = await logger.contextProjectionEvents(conversationId);
  }
  cache.epoch = batch.epoch;
  for (const event of batch.value) {
    cache.cursor = Math.max(cache.cursor, event.id);
    if (event.runId !== runId || !event.toolCallId || (event.type !== "tool.finished" && event.type !== "tool.failed")) continue;
    const content = object(fromLogValue(event.content, event.valueEncoding));
    if (typeof content.toolName !== "string" || content.toolName === "complete_goal") continue;
    cache.entries.set(event.toolCallId, projectEvidence(event.toolCallId, content.toolName,
      fromLogValue(event.output, event.valueEncoding), event.type === "tool.failed", event.id));
  }
  return [...cache.entries.values()];
}

export function localEvidence(id: string, name: string, output: unknown, order: number): Evidence {
  return projectEvidence(id, name, output, object(output).ok === false, order);
}

export function validateGoal(goal: Goal, entries: Evidence[]): string | undefined {
  if (goal.taskType === "answer") return entries.length ? "Answer mode is only available when this run has done no browser work; cite browser evidence instead." : undefined;
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const cited = goal.evidence.map(({ toolCallId }) => byId.get(toolCallId));
  if (cited.some((entry) => !entry)) return "Evidence must reference terminal tool results from this run using their evidenceId.";
  for (let index = 0; index < goal.evidence.length; index++) {
    const entry = cited[index]!;
    for (const id of goal.evidence[index]!.resolves ?? []) {
      const uncertain = byId.get(id);
      if (!uncertain || !unknownEffect(uncertain) || !observation(entry) || entry.order <= uncertain.order)
        return `Resolution of ${id} must reference an earlier unknown effect and a later successful observation.`;
    }
  }
  if (goal.status === "blocked") {
    if (goal.attemptedRecovery.some(({ toolCallId }) => !byId.has(toolCallId))) return "Each attempted recovery must reference an actual terminal tool result from this run.";
    if (!cited.some((entry) => entry && observation(entry))) return "A blocker requires a successful observation, not only failed or retryable operations.";
    return undefined;
  }
  if (cited.some((entry) => !entry || !successful(entry))) return "Completion evidence must be successful terminal results; failed verification and unfinished work are not success.";
  if (!cited.some((entry) => entry && observation(entry))) return "Completion requires at least one successful observation; dispatch alone does not establish the outcome.";
  const resolved = new Set(goal.evidence.flatMap((item) => item.resolves ?? []));
  const unresolved = entries.filter(unknownEffect).filter((entry) => !resolved.has(entry.id));
  if (unresolved.length) return `The effect of ${unresolved.map((entry) => entry.id).join(", ")} is unknown. Inspect the relevant current state and cite a later successful observation whose resolves array names each checked effect.`;
  return undefined;
}
