import { z } from "zod";
import { fromLogValue, type EventLogger } from "../logging";

const text = z.string().trim().min(1);
const reference = z.object({ toolCallId: text.describe("The evidenceId returned by the tool."), observation: text,
  resolves: z.array(text).optional().describe("Evidence IDs of uncertain effects this later observation actually checked, whether the effect occurred or did not occur.") }).strict();
const recovery = z.object({ toolCallId: text.describe("The evidenceId of an actual recovery or diagnostic action."), action: text }).strict();
type Reference = z.infer<typeof reference>;
type Recovery = z.infer<typeof recovery>;
type Dependency = "authentication" | "user_information" | "external_dependency";
export type Goal = { taskType: "answer"; status: "completed" }
  | { taskType: "browser"; status: "completed"; evidence: Reference[] }
  | { taskType: "browser"; status: "blocked"; evidence: Reference[]; dependency: Dependency; userAction: string; attemptedRecovery: Recovery[] };
// Providers require an object at the function schema root. Conditional requirements
// remain enforced locally because the wire schema cannot express them portably.
export const GOAL_SCHEMA = z.object({ taskType: z.enum(["answer", "browser"]), status: z.enum(["completed", "blocked"]),
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
export const GOAL_DESCRIPTION = "Finish only after all work and background jobs have finished. This tool does not accept a summary. Deliver requested facts, links and other output in assistant text before calling it; do not add an unsolicited completion recap. An independent review checks requirements against observations. For a browser task cite evidenceId values from actual tool results, including successful post-action page snapshots; for a blocker identify the observed user dependency, needed action and actual recovery attempts. A rejected action or invalid search is not proof of an external blocker or absence. Use answer only for a pure question with no browser work. Call this tool alone.";
export const GOAL_INSTRUCTIONS = "\n\nContinue until the user's outcome is achieved or a genuine user dependency prevents further progress. Plain text does not end work. Call complete_goal alone with a structured outcome and evidence from this run. A dispatched action is not proof of the outcome; cite at least one successful observation. For each effectUnknown, inspect or otherwise observe the relevant state after that action, explain what was established, and include its evidenceId in that observation's resolves array. A verified absence may permit a safe recovery action; continue to the requested outcome before reporting completion. verify_state evidence must report verified=true. Do not report a recoverable error as a user blocker.\n- complete_goal: Report a completed answer, a browser outcome supported by tool evidence, or a genuine user-dependent blocker.";

type ReceiptValue = string | number | boolean | null | ReceiptValue[] | { [key: string]: ReceiptValue };
type ActionReceipt = { input?: { [key: string]: ReceiptValue }; result?: { [key: string]: ReceiptValue }; labels?: { [key: string]: string }; truncated?: true };
type Evidence = { id: string; name: string; success: boolean; effectUnknown: boolean; order: number; pageObserved?: true; partialObservation?: true; receipt?: ActionReceipt };
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
/** Retain effect identities, never raw page bodies, file bytes or large inputs. */
function actionReceipt(input: unknown, output: unknown): ActionReceipt {
  const receipt: ActionReceipt = {};
  let remaining = 4096;
  const short = (value: unknown, depth = 0): ReceiptValue | undefined => {
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
    if (typeof value === "string") {
      const length = Math.min(256, remaining);
      remaining -= Math.min(value.length, length);
      if (value.length > length) { receipt.truncated = true; return length ? value.slice(0, length - 1) + "…" : ""; }
      return value;
    }
    if (!value || typeof value !== "object") return undefined;
    if (depth >= 3 || remaining <= 0) { receipt.truncated = true; return "[receipt limit]"; }
    if (Array.isArray(value)) {
      if (value.length > 8) receipt.truncated = true;
      return value.slice(0, 8).map((entry) => short(entry, depth + 1) ?? null);
    }
    const fields: Array<[string, ReceiptValue]> = [];
    let visited = 0;
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      if (visited++ === 8) { receipt.truncated = true; break; }
      const projected = short((value as Record<string, unknown>)[key], depth + 1);
      if (projected !== undefined) fields.push([key.slice(0, 256), projected]);
      if (key.length > 256) receipt.truncated = true;
    }
    return Object.fromEntries(fields.sort(([left], [right]) => left.localeCompare(right)));
  };
  const parameters = object(input);
  const keptInput: { [key: string]: ReceiptValue } = {};
  for (const key of ["tabId", "target", "source", "destination", "artifactId", "url", "key"]) {
    const value = short(parameters[key]);
    if (value !== undefined) keptInput[key] = value;
  }
  if (Object.keys(keptInput).length) receipt.input = keptInput;
  const outer = object(output);
  const candidates = [outer, object(outer.result), object(object(outer.result).result)];
  const result: { [key: string]: ReceiptValue } = {};
  for (const key of ["jobId", "state", "performed"]) for (const candidate of candidates) {
    const value = short(candidate[key]);
    if (value !== undefined) { result[key] = value; break; }
  }
  for (const candidate of candidates) {
    const artifact = candidate.artifact && typeof candidate.artifact === "object" && !Array.isArray(candidate.artifact) ? object(candidate.artifact)
      : ["filename", "mimeType", "byteLength"].some((key) => candidate[key] !== undefined) ? candidate : undefined;
    if (!artifact) continue;
    const metadata: { [key: string]: ReceiptValue } = {};
    for (const key of ["id", "artifactId", "filename", "mimeType", "byteLength"]) {
      const value = short(artifact[key]);
      if (value !== undefined) metadata[key] = value;
    }
    if (Object.keys(metadata).length) { result.artifact = metadata; break; }
  }
  if (Object.keys(result).length) receipt.result = result;
  const items = object(outer.pageSnapshot).items;
  if (Array.isArray(items)) for (const key of ["target", "source", "destination"]) {
    const ref = object(parameters[key]).ref;
    if (typeof ref !== "string") continue;
    const item = items.find((item) => object(item).ref === ref);
    if (typeof object(item).line === "string") {
      receipt.labels ??= {};
      receipt.labels[key] = short(object(item).line) as string;
    }
  }
  return receipt;
}
function projectEvidence(id: string, name: string, output: unknown, failed: boolean, order: number, input?: unknown): Evidence {
  const value = object(output);
  const snapshot = object(value.pageSnapshot);
  const pageObserved = typeof snapshot.observationId === "string" && snapshot.observationId.length > 0
    && Number.isSafeInteger(snapshot.tabId) && snapshot.documentId !== undefined
    && ["full", "delta"].includes(String(snapshot.mode)) && Array.isArray(snapshot.items)
    && snapshot.pending !== true && snapshot.unavailable !== true && snapshot.partial !== true;
  return { id, name, order, effectUnknown: object(value.error).effectUnknown === true,
    ...(!OBSERVATION_TOOLS.has(name) || name === "get_job" ? { receipt: actionReceipt(input, output) } : {}),
    ...(pageObserved ? { pageObserved: true as const } : {}),
    ...(name === "inspect_page" && value.partial === true ? { partialObservation: true as const } : {}),
    success: !failed && value.ok !== false && !["running", "blocked", "failed", "cancelled", "interrupted"].includes(String(value.state))
      && !(value.accepted === true && value.complete === false)
      && !(name === "get_job" && value.terminal !== true)
      && !(name === "verify_state" && verification(output) !== true) };
}
function successful(entry: Evidence): boolean { return entry.success; }
const OBSERVATION_TOOLS = new Set(["inspect_page", "find_elements", "list_frames", "read_text", "read_value", "read_attribute", "read_checked", "read_elements", "count_elements", "get_page_info", "verify_state", "wait_for_url", "take_screenshot", "list_tabs", "list_downloads", "read_artifact", "list_requests", "read_response", "read_console", "list_scripts", "read_script", "list_jobs", "get_job", "wait_event"]);
function observation(entry: Evidence): boolean { return !entry.partialObservation && (OBSERVATION_TOOLS.has(entry.name) || entry.pageObserved === true) && successful(entry); }
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
      fromLogValue(event.output, event.valueEncoding), event.type === "tool.failed", event.id,
      fromLogValue(event.input, event.valueEncoding)));
  }
  return [...cache.entries.values()];
}

export function localEvidence(id: string, name: string, output: unknown, order: number, input?: unknown): Evidence {
  return projectEvidence(id, name, output, object(output).ok === false, order, input);
}

/** All effects participate; repeated matching receipts retain counts and order ranges. */
export function actionHistory(entries: readonly Evidence[]) {
  const groups = new Map<string, { name: string; receipt: ActionReceipt; success: boolean; effectUnknown: boolean; count: number; firstOrder: number; lastOrder: number }>();
  for (const entry of entries) {
    if (entry.receipt === undefined) continue;
    const key = JSON.stringify([entry.name, entry.receipt, entry.success, entry.effectUnknown]);
    const previous = groups.get(key);
    if (previous) {
      previous.count++;
      previous.firstOrder = Math.min(previous.firstOrder, entry.order);
      previous.lastOrder = Math.max(previous.lastOrder, entry.order);
    } else groups.set(key, { name: entry.name, receipt: entry.receipt, success: entry.success, effectUnknown: entry.effectUnknown,
      count: 1, firstOrder: entry.order, lastOrder: entry.order });
  }
  return [...groups.values()].sort((left, right) => left.firstOrder - right.firstOrder);
}

export function validateGoal(goal: Goal, entries: Evidence[]): string | undefined {
  if (goal.taskType === "answer") return entries.length ? "Answer mode is only available when this run has done no browser work; cite browser evidence instead." : undefined;
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const cited = goal.evidence.map(({ toolCallId }) => byId.get(toolCallId));
  if (cited.some((entry) => !entry)) return "Evidence must reference terminal tool results from this run using their evidenceId.";
  if (cited.some((entry) => entry?.partialObservation)) return "A partial page snapshot is not complete evidence; obtain a reliable observation before citing it.";
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
