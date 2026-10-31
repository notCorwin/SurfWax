import { fromLogValue } from "../../src/logging";

type ToolEvent = { id?: unknown; type?: unknown; conversationId?: unknown; runId?: unknown; toolCallId?: unknown; valueEncoding?: unknown; content?: unknown };
type Encoding = 2 | 3 | 4 | 5 | undefined;

/** Read identity without decoding the growing parts of every historical snapshot. */
function messageHeader(content: unknown, version: Encoding): { id: unknown; role: unknown; parts: unknown; encodedParts: boolean } {
  if (!content || typeof content !== "object" || Array.isArray(content)) throw new Error("Invalid message");
  let fields = content as Record<string, unknown>;
  let encodedParts = true;
  if (version !== undefined && fields.$type === "escaped-object") {
    if (Object.keys(fields).length !== 2 || !Array.isArray(fields.entries)
      || fields.entries.some((entry) => !Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string")
      || new Set(fields.entries.map((entry) => entry[0])).size !== fields.entries.length) throw new Error("Invalid escaped message");
    fields = Object.fromEntries(fields.entries);
  } else if (version !== undefined && typeof fields.$type === "string") {
    const decoded = fromLogValue(content, version);
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error("Invalid message");
    fields = decoded as Record<string, unknown>;
    encodedParts = false;
  }
  return { id: encodedParts ? fromLogValue(fields.id, version) : fields.id,
    role: encodedParts ? fromLogValue(fields.role, version) : fields.role, parts: fields.parts, encodedParts };
}

/** Operation names contain no tool arguments or page content. */
export function completedProgramOperations(events: readonly ToolEvent[]): Record<string, number> {
  const counts: Record<string, number> = Object.create(null);
  for (const event of events) {
    if (event.type !== "browser.job.progress" || !event.content || typeof event.content !== "object" || Array.isArray(event.content)) continue;
    const { operation, state } = event.content as Record<string, unknown>;
    if (state !== "completed" || typeof operation !== "string" || !operation) continue;
    counts[operation] = (counts[operation] ?? 0) + 1;
  }
  return counts;
}

/** Invalid model tool calls can have a failed terminal without a tool.started event. */
export function toolLifecycleEvidence(events: readonly ToolEvent[]) {
  const calls = new Map<string, { starts: number; finished: number; failed: number; startAfterTerminal: boolean }>();
  const snapshots = new Map<string, { eventId: number; run: string; conversationId: string; runId: string; parts: unknown; encodedParts: boolean; version: Encoding }>();
  const assistantRuns = new Set<string>();
  const messageEventIds = new Set<number>();
  let invalidIdentities = 0;
  let invalidMessages = 0;
  for (const event of events) {
    if (event.type === "conversation.message") {
      if (event.valueEncoding !== undefined && ![2, 3, 4, 5].includes(event.valueEncoding as number)) { invalidMessages++; continue; }
      const version = event.valueEncoding as Encoding;
      let message: ReturnType<typeof messageHeader>;
      try { message = messageHeader(event.content, version); }
      catch { invalidMessages++; continue; }
      if (message.role === "user" || message.role === "system") continue;
      if (message.role !== "assistant" || typeof message.id !== "string" || !message.id
        || typeof event.conversationId !== "string" || !event.conversationId || typeof event.runId !== "string" || !event.runId
        || !Number.isSafeInteger(event.id) || Number(event.id) < 1 || messageEventIds.has(event.id as number)) {
        invalidMessages++; continue;
      }
      messageEventIds.add(event.id as number);
      const run = JSON.stringify([event.conversationId, event.runId]);
      const key = JSON.stringify([event.conversationId, event.runId, message.id]);
      const prior = snapshots.get(key);
      // The event log is append-only; the highest event ID is the authoritative snapshot.
      if (!prior || Number(event.id) > prior.eventId) snapshots.set(key, {
        eventId: Number(event.id), run, conversationId: event.conversationId, runId: event.runId,
        parts: message.parts, encodedParts: message.encodedParts, version,
      });
      continue;
    }
    if (event.type !== "tool.started" && event.type !== "tool.finished" && event.type !== "tool.failed") continue;
    if (typeof event.conversationId !== "string" || !event.conversationId || typeof event.runId !== "string" || !event.runId || typeof event.toolCallId !== "string" || !event.toolCallId) {
      invalidIdentities++;
      continue;
    }
    const key = JSON.stringify([event.conversationId, event.runId, event.toolCallId]);
    const call = calls.get(key) ?? { starts: 0, finished: 0, failed: 0, startAfterTerminal: false };
    if (event.type === "tool.started") { call.startAfterTerminal ||= call.finished + call.failed > 0; call.starts++; }
    else if (event.type === "tool.finished") call.finished++;
    else call.failed++;
    calls.set(key, call);
  }
  const declared = new Map<string, number>();
  for (const snapshot of snapshots.values()) {
    assistantRuns.add(snapshot.run);
    let parts: unknown;
    try { parts = snapshot.encodedParts ? fromLogValue(snapshot.parts, snapshot.version) : snapshot.parts; }
    catch { invalidMessages++; continue; }
    if (!Array.isArray(parts)) { invalidMessages++; continue; }
    for (const part of parts) {
      if (!part || typeof part !== "object" || Array.isArray(part)) { invalidMessages++; continue; }
      const record = part as Record<string, unknown>;
      if (typeof record.type !== "string") { invalidMessages++; continue; }
      if (record.type !== "dynamic-tool" && !record.type.startsWith("tool-")) continue;
      if (typeof record.toolCallId !== "string" || !record.toolCallId) { invalidMessages++; continue; }
      const key = JSON.stringify([snapshot.conversationId, snapshot.runId, record.toolCallId]);
      declared.set(key, (declared.get(key) ?? 0) + 1);
    }
  }
  const records = [...calls.values()];
  const started = records.reduce((count, call) => count + call.starts, 0);
  const missingTerminals = records.filter((call) => call.starts > 0 && call.finished + call.failed === 0).length;
  const duplicateStarts = records.filter((call) => call.starts > 1).length;
  const duplicateTerminals = records.filter((call) => call.finished + call.failed > 1).length;
  const startAfterTerminal = records.filter((call) => call.startAfterTerminal).length;
  // A successful completion without a start is never a valid rejected input.
  const orphanFinished = records.filter((call) => call.starts === 0 && call.finished > 0).length;
  const unstartedFailures = records.filter((call) => call.starts === 0 && call.failed === 1).length;
  const missingDeclaredTerminals = [...declared.keys()].filter((key) => {
    const call = calls.get(key);
    return !call || call.finished + call.failed === 0;
  }).length;
  const duplicateDeclaredCalls = [...declared.values()].filter((count) => count > 1).length;
  const missingAssistantRuns = new Set([...calls.keys()].filter((key) => {
    const [conversationId, runId] = JSON.parse(key) as string[];
    return !assistantRuns.has(JSON.stringify([conversationId, runId]));
  }).map((key) => {
    const [conversationId, runId] = JSON.parse(key) as string[];
    return JSON.stringify([conversationId, runId]);
  })).size;
  const unreferencedStarts = [...calls.entries()].filter(([key, call]) => call.starts > 0 && !declared.has(key)).length;
  const incompleteMessages = invalidMessages > 0 || missingAssistantRuns > 0 || unreferencedStarts > 0;
  const invalid = started === 0 || invalidIdentities > 0 || missingTerminals > 0 || duplicateStarts > 0 || duplicateTerminals > 0 || startAfterTerminal > 0 || orphanFinished > 0 || missingDeclaredTerminals > 0 || duplicateDeclaredCalls > 0;
  const complete = invalid ? false : incompleteMessages ? null : true;
  return { complete, started, missingTerminals, duplicateStarts, duplicateTerminals, startAfterTerminal, orphanFinished, unstartedFailures, invalidIdentities,
    declaredCalls: declared.size, missingDeclaredTerminals, duplicateDeclaredCalls, invalidMessages, missingAssistantRuns, unreferencedStarts };
}
