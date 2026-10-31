import { fromLogValue } from "../../src/logging";
import { ATOMIC_TOOL_REGISTRY } from "../../src/chrome/atomic-tools";

// These registered atomic tools have direct implementations in createProgramTools.
// Chooser uploads also use a different return envelope, so only their explicit
// accepted handoffs can be correlated from the tool result.
const directTools = new Set(["list_tabs", "switch_tab", "read_artifact", "upload_file"]);
const programTools = new Set(["execute_program", ...ATOMIC_TOOL_REGISTRY.map(({ name }) => name).filter((name) => !directTools.has(name))]);
type Event = { id?: unknown; type?: unknown; conversationId?: unknown; runId?: unknown; toolCallId?: unknown; content?: unknown; output?: unknown; valueEncoding?: unknown; artifactGraph?: unknown };

function decode(value: unknown, encoding: unknown): unknown {
  if (encoding !== undefined && ![2, 3, 4, 5].includes(encoding as number)) throw new Error("Unknown log encoding");
  return fromLogValue(value, encoding as 2 | 3 | 4 | 5 | undefined);
}

/** Classify whether browser jobs have settled without unknown effects. */
export function browserJobsSettled(events: readonly Event[]): boolean | null {
  const states = new Map<string, { id: number; state: string; knownFailure: boolean; toolCallId: unknown }>();
  const handoffs = new Set<string>();
  const programOwners = new Map<string, { toolCallId: string; terminal: boolean }>();
  const unresolvedPrograms: Array<{ conversationId: string; runId: string; toolCallId: string }> = [];
  const artifacts = new Map<number, Event | null>();
  for (const event of events) if (event.type === "tool.result.data" && Number.isSafeInteger(event.id) && Number(event.id) > 0) {
    const id = Number(event.id);
    artifacts.set(id, artifacts.has(id) ? null : event);
  }
  const artifactJobId = (reference: unknown, owner: Event): string | undefined => {
    if (!Number.isSafeInteger(reference) || Number(reference) < 1) return;
    const artifact = artifacts.get(Number(reference));
    if (!artifact || !owner.toolCallId || artifact.toolCallId !== owner.toolCallId
      || artifact.runId !== owner.runId || artifact.conversationId !== owner.conversationId) return;
    try {
      const content = decode(artifact.content, artifact.valueEncoding);
      const output = decode(artifact.output, artifact.valueEncoding);
      if (content && typeof content === "object" && !Array.isArray(content)
        && typeof (content as Record<string, unknown>).jobId === "string" && (content as Record<string, unknown>).jobId) {
        return (content as Record<string, unknown>).jobId as string;
      }
      if (output && typeof output === "object" && !Array.isArray(output)
        && typeof (output as Record<string, unknown>).jobId === "string" && (output as Record<string, unknown>).jobId) {
        return (output as Record<string, unknown>).jobId as string;
      }
    } catch { /* Missing or unreadable artifact cannot establish the owner. */ }
  };
  const isOwnedArtifact = (reference: unknown, owner: Event): boolean => {
    if (!Number.isSafeInteger(reference) || Number(reference) < 1) return false;
    const artifact = artifacts.get(Number(reference));
    const graph = artifact?.artifactGraph;
    return !!artifact && !!graph && typeof graph === "object" && !Array.isArray(graph)
      && (graph as Record<string, unknown>).version === 1 && typeof (graph as Record<string, unknown>).key === "string"
      && !!(graph as Record<string, unknown>).key && Object.hasOwn(graph, "root")
      && !!owner.toolCallId && artifact.toolCallId === owner.toolCallId
      && artifact.runId === owner.runId && artifact.conversationId === owner.conversationId;
  };
  const ids = new Set<number>();
  const known = new Set(["queued", "running", "blocked", "succeeded", "failed", "cancelled", "interrupted"]);
  for (const event of events) {
    if (event.type === "tool.finished") {
      if (!Object.hasOwn(event, "output") || event.valueEncoding !== undefined && ![2, 3, 4, 5].includes(event.valueEncoding as number)) return null;
      let output: unknown;
      try { output = fromLogValue(event.output, event.valueEncoding as 2 | 3 | 4 | 5 | undefined); } catch { return null; }
      let toolName: unknown;
      try {
        const content = decode(event.content, event.valueEncoding);
        if (content && typeof content === "object" && !Array.isArray(content)) toolName = (content as Record<string, unknown>).toolName;
      } catch { return null; }
      // Without the canonical tool identity an ordinary object cannot be
      // distinguished from a foreground program envelope.
      if (typeof toolName !== "string" || !toolName) return null;
      if (!output || typeof output !== "object" || Array.isArray(output)) {
        if (typeof toolName === "string" && programTools.has(toolName)) return null;
        continue;
      }
      const outer = output as Record<string, unknown>;
      const records = [outer];
      if (outer.envelopeWrapped === true) {
        if (outer.result && typeof outer.result === "object" && !Array.isArray(outer.result)) records.push(outer.result as Record<string, unknown>);
        // Compacted envelopes preserve any accepted handoff on the outer object.
        else if (!Number.isSafeInteger(outer.$ref) || Number(outer.$ref) < 1) return null;
      }
      const jobIds = new Set<string>();
      for (const record of records) {
        if (record.accepted !== true || record.complete !== false && !Object.hasOwn(record, "jobId")) {
          if (record.complete === false && Object.hasOwn(record, "jobId")) return null;
          continue;
        }
        if (typeof record.jobId !== "string" || !record.jobId) return null;
        jobIds.add(record.jobId);
      }
      // A successful foreground program is also a durable job. Its terminal
      // envelope contains jobId even without an accepted background handoff.
      // Look only at the outer tool envelope, never at arbitrary user results.
      if (typeof toolName === "string" && programTools.has(toolName)) {
        let id = outer.jobId;
        if (id === undefined && outer.envelopeWrapped === true && records.length > 1) id = records[1]!.jobId;
        if (id === undefined && outer.$ref !== undefined) id = artifactJobId(outer.$ref, event);
        if (id === undefined && isOwnedArtifact(outer.$ref, event)
          && typeof event.conversationId === "string" && !!event.conversationId && typeof event.runId === "string" && !!event.runId
          && typeof event.toolCallId === "string" && !!event.toolCallId && outer.accepted !== true) {
          // Partitioned artifacts may not expose their original envelope in
          // event.output. A single job owned by this exact call establishes
          // its identity without materializing the entire large value.
          unresolvedPrograms.push({ conversationId: event.conversationId, runId: event.runId, toolCallId: event.toolCallId });
        } else {
          if (typeof id !== "string" || !id) return null;
          jobIds.add(id);
        }
      }
      if (jobIds.size > 1) return null;
      if (jobIds.size) {
        if (typeof event.conversationId !== "string" || !event.conversationId || typeof event.runId !== "string" || !event.runId) return null;
        const key = JSON.stringify([event.conversationId, event.runId, [...jobIds][0]]);
        handoffs.add(key);
        if (typeof toolName === "string" && programTools.has(toolName)) {
          if (typeof event.toolCallId !== "string" || !event.toolCallId) return null;
          const previous = programOwners.get(key);
          if (previous && previous.toolCallId !== event.toolCallId) return null;
          programOwners.set(key, { toolCallId: event.toolCallId, terminal: outer.accepted !== true });
        }
      }
      continue;
    }
    if (event.type !== "browser.job.state") continue;
    if (!Number.isSafeInteger(event.id) || Number(event.id) < 1 || ids.has(event.id as number)
      || typeof event.conversationId !== "string" || !event.conversationId || typeof event.runId !== "string" || !event.runId
      || event.valueEncoding !== undefined && ![2, 3, 4, 5].includes(event.valueEncoding as number)) return null;
    ids.add(event.id as number);
    let content: unknown;
    try { content = fromLogValue(event.content, event.valueEncoding as 2 | 3 | 4 | 5 | undefined); } catch { return null; }
    if (!content || typeof content !== "object" || Array.isArray(content)) return null;
    const { jobId, state } = content as Record<string, unknown>;
    if (typeof jobId !== "string" || !jobId || typeof state !== "string" || !known.has(state)) return null;
    let knownFailure = false;
    if (state === "failed" && Object.hasOwn(event, "output")) {
      try {
        const output = fromLogValue(event.output, event.valueEncoding as 2 | 3 | 4 | 5 | undefined);
        if (output && typeof output === "object" && !Array.isArray(output)) {
          const record = output as Record<string, unknown>, error = record.error;
          if (record.ok === false && error && typeof error === "object" && !Array.isArray(error)) {
            const detail = error as Record<string, unknown>;
            knownFailure = typeof detail.code === "string" && !!detail.code && typeof detail.message === "string"
              && (detail.effectUnknown === undefined || detail.effectUnknown === false);
          }
        }
      } catch { /* Missing, detached or invalid result evidence remains unknown. */ }
    }
    const key = JSON.stringify([event.conversationId, event.runId, jobId]);
    const prior = states.get(key);
    if (!prior || Number(event.id) > prior.id) states.set(key, { id: Number(event.id), state, knownFailure, toolCallId: event.toolCallId });
  }
  const latest = [...states.values()];
  if (latest.some(({ state }) => ["queued", "running", "blocked"].includes(state))) return false;
  // A durable tool handoff without its corresponding job state cannot prove
  // that the accepted work finished, even if every other job settled.
  if ([...handoffs].some((key) => !states.has(key))) return null;
  if ([...programOwners].some(([key, owner]) => states.get(key)?.toolCallId !== owner.toolCallId
    || owner.terminal && states.get(key)?.state !== "succeeded")) return null;
  if (unresolvedPrograms.length) {
    const byOwner = new Map<string, { count: number; state: string }>();
    for (const [key, job] of states) {
      const [conversationId, runId] = JSON.parse(key) as string[];
      const ownerKey = JSON.stringify([conversationId, runId, job.toolCallId]);
      const prior = byOwner.get(ownerKey);
      byOwner.set(ownerKey, { count: (prior?.count ?? 0) + 1, state: job.state });
    }
    for (const owner of unresolvedPrograms) {
      const match = byOwner.get(JSON.stringify([owner.conversationId, owner.runId, owner.toolCallId]));
      if (match?.count !== 1 || match.state !== "succeeded") return null;
    }
  }
  // Cancellation or host interruption is terminal in the log but does not
  // establish whether a dispatched effect completed before work was stopped.
  if (latest.some(({ state, knownFailure }) => state === "cancelled" || state === "interrupted" || state === "failed" && !knownFailure)) return null;
  return true;
}
