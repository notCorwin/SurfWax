import { ATOMIC_TOOL_REGISTRY } from "../../src/chrome/atomic-tools";
import { fromLogValue, type LogEvent } from "../../src/logging";
import { readPartitionedArtifact } from "../../src/artifact-graph";

const obj = (v: unknown): Record<string, any> | undefined => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, any> : undefined;
const decode = (e: LogEvent, v: unknown) => fromLogValue(v, e.valueEncoding);
const owner = (a: LogEvent, b: LogEvent) => !!a.conversationId && !!a.runId && !!a.toolCallId && a.conversationId === b.conversationId && a.runId === b.runId && a.toolCallId === b.toolCallId;

export async function httpEvidence(events: LogEvent[]): Promise<Array<{eventId: number; url: string; status: number; text: string}>> {
  const result: Array<{eventId: number; url: string; status: number; text: string}> = [];
  const byId = new Map<number, LogEvent | null>();
  for (const e of events) byId.set(e.id, byId.has(e.id) ? null : e);
  const field = async (artifact: LogEvent, path: string[]) => {
    if (!artifact.artifactGraph) {
      let value: any = decode(artifact, artifact.output);
      for (const key of path) { if (!obj(value) || !Object.hasOwn(value, key)) throw new Error("Missing field"); value = value[key]; }
      return value;
    }
    const graph = artifact.artifactGraph;
    const rows = events.filter(e => e.type === "artifact.part" && e.artifactPart?.key === graph.key);
    const select = (node: number, predicate: (section: string, part: number) => boolean) => rows.filter(e => e.artifactPart!.node === node && predicate(e.artifactPart!.section, e.artifactPart!.part)).map(e => {
      const p = e.artifactPart!;
      if (e.id >= artifact.id || e.id <= 0 || p.owner !== artifact.conversationId || byId.get(e.id) !== e) throw new Error("Invalid artifact part");
      return { node: p.node, section: p.section, part: p.part, value: e.output };
    });
    return readPartitionedArtifact(graph, async (node, section, first, last) => select(node, (s, p) => (section === undefined || s === section) && (first === undefined || p >= first) && (last === undefined || p <= last)), { path }, artifact.id,
      async (node, prefix, first, last) => select(node, s => { const suffix = s.slice(prefix.length); const n = Number(suffix); return s.startsWith(prefix) && /^(?:0|[1-9]\d*)$/.test(suffix) && Number.isSafeInteger(n) && n >= first && n <= last; }));
  };
  for (const e of events) try {
    if (e.type !== "tool.finished" || !["send_extension_request", "send_page_request"].includes(obj(decode(e, e.content))?.toolName)) continue;
    const input = obj(decode(e, e.input)), output = obj(decode(e, e.output));
    if (!input || !output || typeof input.url !== "string" || (input.init !== undefined && !obj(input.init)) || (input.init?.method !== undefined && (typeof input.init.method !== "string" || input.init.method.toUpperCase() !== "GET")) || input.init?.body !== undefined || output.ok !== true) continue;
    const request = new URL(input.url); if (!['http:', 'https:'].includes(request.protocol)) continue;
    let response = obj(output.result), artifact: LogEvent | undefined;
    if (output.$ref !== undefined) {
      const candidate = byId.get(output.$ref);
      if (!candidate || candidate.type !== "tool.result.data" || candidate.id >= e.id || !owner(e, candidate)) continue;
      artifact = candidate;
      response = { url: await field(candidate, ["result", "url"]), status: await field(candidate, ["result", "status"]) };
    }
    if (!response || typeof response.url !== "string" || typeof response.status !== "number" || response.status < 200 || response.status >= 300) continue;
    const url = new URL(response.url); if (!['http:', 'https:'].includes(url.protocol) || url.origin !== request.origin) continue;
    const texts: string[] = [];
    if (!artifact && typeof response.body === "string") texts.push(response.body);
    if (artifact) for (const read of events) {
      if (read.id <= e.id || read.type !== "tool.finished" || read.conversationId !== e.conversationId || read.runId !== e.runId) continue;
      const content = obj(decode(read, read.content)), ri = obj(decode(read, read.input)), ro = obj(decode(read, read.output)), source = obj(ro?.sourceAccess);
      if (content?.toolName !== "read_artifact" || ro?.ok !== true || ro.$ref !== undefined || typeof ro.result !== "string" || ri?.artifactId !== artifact.id || source?.artifactId !== artifact.id) continue;
      const path = ri.path ?? []; if (JSON.stringify(path) !== JSON.stringify(source.path) || !(JSON.stringify(path) === '["result","body"]' || JSON.stringify(path) === '["body"]')) continue;
      texts.push(ro.result);
    }
    for (const text of texts) if (text) result.push({ eventId: e.id, url: url.href, status: response.status, text });
  } catch { /* Invalid or incomplete evidence is not evidence. */ }
  return result;
}

/** Read-only research needs terminated work; uncertain write effects are reported separately. */
export function settledReadJobs(events: LogEvent[]): boolean | null {
  const states = new Map<string, { id: number; state: string; toolCallId: string }>();
  const claims: Array<{ key: string; toolCallId: string }> = [];
  const unresolved: LogEvent[] = [];
  const ids = new Set<number>();
  const direct = new Set(["list_tabs", "switch_tab", "read_artifact", "upload_file_chooser"]);
  const jobTools = new Set(["execute_program", ...ATOMIC_TOOL_REGISTRY.map(tool => tool.name).filter(name => !direct.has(name))]);
  const key = (event: LogEvent, id: string) => JSON.stringify([event.conversationId, event.runId, id]);
  try {
    for (const event of events) {
      if (event.type === "browser.job.state") {
        const content = obj(decode(event, event.content));
        if (!Number.isSafeInteger(event.id) || event.id < 1 || ids.has(event.id) || !event.conversationId || !event.runId || !event.toolCallId
          || typeof content?.jobId !== "string" || !content.jobId || !["queued", "running", "blocked", "succeeded", "failed", "cancelled", "interrupted"].includes(content.state)) return null;
        ids.add(event.id);
        const id = key(event, content.jobId), previous = states.get(id);
        if (previous && previous.toolCallId !== event.toolCallId) return null;
        if (!previous || event.id > previous.id) states.set(id, { id: event.id, state: content.state, toolCallId: event.toolCallId });
      } else if (event.type === "tool.finished" || event.type === "tool.failed") {
        const content = obj(decode(event, event.content)), output = obj(decode(event, event.output));
        if (!content || typeof content.toolName !== "string" || !output) return null;
        const needsJob = jobTools.has(content.toolName) && content.dispatched !== false;
        // get_job observes another call's job, so its result is not an ownership claim.
        if (!needsJob && !(output.accepted === true && output.complete === false)) continue;
        const records = [output];
        if (output.envelopeWrapped === true) {
          const wrapped = obj(output.result);
          if (wrapped) records.push(wrapped);
          else if (!Number.isSafeInteger(output.$ref)) return null;
        }
        const jobIds = new Set<string>();
        for (const record of records) {
          if (record.jobId !== undefined) {
            if (typeof record.jobId !== "string" || !record.jobId) return null;
            jobIds.add(record.jobId);
          } else if (record.accepted === true && record.complete === false) return null;
        }
        if (jobIds.size > 1) return null;
        if (needsJob && !jobIds.size) unresolved.push(event);
        for (const id of jobIds) {
          if (!event.conversationId || !event.runId || !event.toolCallId) return null;
          claims.push({ key: key(event, id), toolCallId: event.toolCallId });
        }
      }
    }
  } catch { return null; }
  for (const event of unresolved) {
    if (!event.conversationId || !event.runId || !event.toolCallId) return null;
    const matches = [...states].filter(([id, state]) => {
      const [conversationId, runId] = JSON.parse(id);
      return conversationId === event.conversationId && runId === event.runId && state.toolCallId === event.toolCallId;
    });
    if (matches.length !== 1) return null;
  }
  if (claims.some(claim => states.get(claim.key)?.toolCallId !== claim.toolCallId)) return null;
  return ![...states.values()].some(state => ["queued", "running", "blocked"].includes(state.state));
}
