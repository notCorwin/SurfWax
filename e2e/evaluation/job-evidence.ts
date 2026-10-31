import { fromLogValue } from "../../src/logging";
import { ATOMIC_TOOL_REGISTRY } from "../../src/chrome/atomic-tools";

// These registered atomic tools have direct implementations in createProgramTools.
// Chooser uploads use a different return envelope; target uploads are jobs.
const directTools = new Set(["list_tabs", "switch_tab", "read_artifact", "upload_file"]);
const programTools = new Set(["execute_program", ...ATOMIC_TOOL_REGISTRY.map(({ name }) => name).filter((name) => !directTools.has(name))]);
type Event = { id?: unknown; type?: unknown; conversationId?: unknown; runId?: unknown; toolCallId?: unknown; content?: unknown; input?: unknown; output?: unknown; error?: unknown; valueEncoding?: unknown; artifactGraph?: unknown };
type Failure = { code: string; message: string };

function decode(value: unknown, encoding: unknown): unknown {
  if (encoding !== undefined && ![2, 3, 4, 5].includes(encoding as number)) throw new Error("Unknown log encoding");
  return fromLogValue(value, encoding as 2 | 3 | 4 | 5 | undefined);
}

/** Classify whether browser jobs have settled without unknown effects. */
export function browserJobsSettled(events: readonly Event[]): boolean | null {
  const states = new Map<string, { id: number; state: string; knownFailure: boolean; toolCallId: unknown; failure?: Failure }>();
  const handoffs = new Set<string>();
  const programOwners = new Map<string, { toolCallId: string; expected: "succeeded" | "failed" | null; failure?: Failure }>();
  const unresolvedPrograms: Array<{ conversationId: string; runId: string; toolCallId: string; expected: "succeeded" | "failed"; failure?: Failure }> = [];
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
  const recordProgram = (event: Event, id: string, expected: "succeeded" | "failed" | null, failure?: Failure): boolean => {
    if (typeof event.conversationId !== "string" || !event.conversationId || typeof event.runId !== "string" || !event.runId
      || typeof event.toolCallId !== "string" || !event.toolCallId) return false;
    const key = JSON.stringify([event.conversationId, event.runId, id]);
    const prior = programOwners.get(key);
    if (prior && (prior.toolCallId !== event.toolCallId || prior.expected && expected && prior.expected !== expected
      || prior.failure && failure && (prior.failure.code !== failure.code || prior.failure.message !== failure.message))) return false;
    handoffs.add(key);
    programOwners.set(key, { toolCallId: event.toolCallId, expected: expected ?? prior?.expected ?? null, failure: failure ?? prior?.failure });
    return true;
  };
  for (const event of events) {
    if (event.type === "tool.failed") {
      // A failure can report an unknown effect even if its job events are
      // absent, or when the action (such as a chooser upload) has no job.
      let output: unknown, recordedError: unknown, content: unknown;
      try {
        output = decode(event.output, event.valueEncoding);
        recordedError = event.error === undefined ? undefined : decode(event.error, event.valueEncoding);
        content = decode(event.content, event.valueEncoding);
      } catch { return null; }
      if (content && typeof content === "object" && !Array.isArray(content)) {
        const effectUnknown = (content as Record<string, unknown>).effectUnknown;
        if (effectUnknown !== undefined && effectUnknown !== false) return null;
      }
      if (!output || typeof output !== "object" || Array.isArray(output)) return null;
      const record = output as Record<string, unknown>;
      if (record.ok !== false) return null;
      const errors = [record.error, recordedError].filter((value) => value !== undefined);
      if (!errors.length) return null;
      for (const error of errors) {
        if (!error || typeof error !== "object" || Array.isArray(error)) return null;
        const detail = error as Record<string, unknown>;
        if (typeof detail.code !== "string" || !detail.code || typeof detail.message !== "string"
          || detail.effectUnknown !== undefined && detail.effectUnknown !== false) return null;
      }
      const first = errors[0] as Failure;
      if (errors.some((error) => (error as Failure).code !== first.code || (error as Failure).message !== first.message)) return null;
      const failure = { code: first.code, message: first.message };
      // A foreground program can fail after a durable job was created. An
      // error with no job ID can instead arise before dispatch, but a visible
      // or compacted job ID requires a matching failed terminal state.
      const toolName = content && typeof content === "object" && !Array.isArray(content) ? (content as Record<string, unknown>).toolName : undefined;
      if ((Object.hasOwn(record, "jobId") || Object.hasOwn(record, "$ref")) && (typeof toolName !== "string" || !toolName)) return null;
      let program = typeof toolName === "string" && programTools.has(toolName);
      if (toolName === "upload_file" && (Object.hasOwn(record, "jobId") || Object.hasOwn(record, "$ref"))) {
        let input: unknown;
        try { input = decode(event.input, event.valueEncoding); } catch { return null; }
        if (!input || typeof input !== "object" || Array.isArray(input)) return null;
        const { target, chooserId } = input as Record<string, unknown>;
        if (target && typeof target === "object" && !Array.isArray(target) && chooserId === undefined) program = true;
        else if (!(typeof chooserId === "string" && !!chooserId && target === undefined)) return null;
      }
      if (program) {
        let id = record.jobId;
        let state = record.state;
        if (record.envelopeWrapped === true && record.result && typeof record.result === "object" && !Array.isArray(record.result)) {
          const wrapped = record.result as Record<string, unknown>, wrappedId = wrapped.jobId;
          if (id !== undefined && wrappedId !== undefined && id !== wrappedId) return null;
          if (state !== undefined && wrapped.state !== undefined && state !== wrapped.state) return null;
          id ??= wrappedId;
          state ??= wrapped.state;
        }
        if (state !== undefined && state !== "failed") return null;
        if (id === undefined && record.$ref !== undefined) id = artifactJobId(record.$ref, event);
        if (id === undefined && record.$ref !== undefined) {
          if (!isOwnedArtifact(record.$ref, event) || typeof event.conversationId !== "string" || !event.conversationId
            || typeof event.runId !== "string" || !event.runId || typeof event.toolCallId !== "string" || !event.toolCallId) return null;
          unresolvedPrograms.push({ conversationId: event.conversationId, runId: event.runId, toolCallId: event.toolCallId, expected: "failed", failure });
        } else if (id !== undefined && (typeof id !== "string" || !id || !recordProgram(event, id, "failed", failure))) return null;
        else if (id === undefined && (state !== undefined || record.envelopeWrapped === true)) return null;
      }
      continue;
    }
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
      let program = programTools.has(toolName);
      if (toolName === "upload_file") {
        let input: unknown;
        try { input = decode(event.input, event.valueEncoding); } catch { return null; }
        if (!input || typeof input !== "object" || Array.isArray(input)) return null;
        const { target, chooserId } = input as Record<string, unknown>;
        const hasTarget = !!target && typeof target === "object" && !Array.isArray(target);
        const hasChooser = typeof chooserId === "string" && !!chooserId;
        if (hasTarget && chooserId === undefined) program = true;
        else if (!(hasChooser && target === undefined)) return null;
      }
      if (!output || typeof output !== "object" || Array.isArray(output)) {
        if (program) return null;
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
      if (program) {
        let id = outer.jobId;
        if (id === undefined && outer.envelopeWrapped === true && records.length > 1) id = records[1]!.jobId;
        if (id === undefined && outer.$ref !== undefined) id = artifactJobId(outer.$ref, event);
        if (id === undefined && isOwnedArtifact(outer.$ref, event)
          && typeof event.conversationId === "string" && !!event.conversationId && typeof event.runId === "string" && !!event.runId
          && typeof event.toolCallId === "string" && !!event.toolCallId && outer.accepted !== true) {
          // Partitioned artifacts may not expose their original envelope in
          // event.output. A single job owned by this exact call establishes
          // its identity without materializing the entire large value.
          unresolvedPrograms.push({ conversationId: event.conversationId, runId: event.runId, toolCallId: event.toolCallId, expected: "succeeded" });
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
        if (program) {
          if (!recordProgram(event, [...jobIds][0]!, outer.accepted === true ? null : "succeeded")) return null;
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
    let knownFailure = false, failure: Failure | undefined;
    if (state === "failed" && Object.hasOwn(event, "output")) {
      try {
        const output = fromLogValue(event.output, event.valueEncoding as 2 | 3 | 4 | 5 | undefined);
        if (output && typeof output === "object" && !Array.isArray(output)) {
          const record = output as Record<string, unknown>, error = record.error;
          if (record.ok === false && error && typeof error === "object" && !Array.isArray(error)) {
            const detail = error as Record<string, unknown>;
            knownFailure = typeof detail.code === "string" && !!detail.code && typeof detail.message === "string"
              && (detail.effectUnknown === undefined || detail.effectUnknown === false);
            if (knownFailure) failure = { code: detail.code as string, message: detail.message as string };
          }
        }
      } catch { /* Missing, detached or invalid result evidence remains unknown. */ }
    }
    const key = JSON.stringify([event.conversationId, event.runId, jobId]);
    const prior = states.get(key);
    if (!prior || Number(event.id) > prior.id) states.set(key, { id: Number(event.id), state, knownFailure, toolCallId: event.toolCallId, failure });
  }
  const latest = [...states.values()];
  if (latest.some(({ state }) => ["queued", "running", "blocked"].includes(state))) return false;
  // A durable tool handoff without its corresponding job state cannot prove
  // that the accepted work finished, even if every other job settled.
  if ([...handoffs].some((key) => !states.has(key))) return null;
  if ([...programOwners].some(([key, owner]) => states.get(key)?.toolCallId !== owner.toolCallId
    || owner.expected && states.get(key)?.state !== owner.expected
    || owner.failure && (states.get(key)?.failure?.code !== owner.failure.code || states.get(key)?.failure?.message !== owner.failure.message))) return null;
  if (unresolvedPrograms.length) {
    const byOwner = new Map<string, { count: number; state: string; failure?: Failure }>();
    for (const [key, job] of states) {
      const [conversationId, runId] = JSON.parse(key) as string[];
      const ownerKey = JSON.stringify([conversationId, runId, job.toolCallId]);
      const prior = byOwner.get(ownerKey);
      byOwner.set(ownerKey, { count: (prior?.count ?? 0) + 1, state: job.state, failure: job.failure });
    }
    for (const owner of unresolvedPrograms) {
      const match = byOwner.get(JSON.stringify([owner.conversationId, owner.runId, owner.toolCallId]));
      if (match?.count !== 1 || match.state !== owner.expected
        || owner.failure && (match.failure?.code !== owner.failure.code || match.failure?.message !== owner.failure.message)) return null;
    }
  }
  // Cancellation or host interruption is terminal in the log but does not
  // establish whether a dispatched effect completed before work was stopped.
  if (latest.some(({ state, knownFailure }) => state === "cancelled" || state === "interrupted" || state === "failed" && !knownFailure)) return null;
  return true;
}
