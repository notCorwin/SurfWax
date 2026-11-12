import { canonicalUrl } from "./sources.ts";
export { canonicalUrl } from "./sources.ts";
import { fromLogValue, rebuildConversation, type LogEvent } from "../../src/logging";

/** Only the last durable assistant text can supply the answer; goal completion may be tool-only. */
export function finalAnswer(events: LogEvent[]): { text: string; value: unknown } {
  const message = rebuildConversation(events).filter(message => message.role === "assistant" && message.parts.some(part => part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part && typeof part.text === "string" && part.text.trim())).at(-1);
  const text = message?.parts.filter((part): part is { type: "text"; text: string } => !!part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part && typeof part.text === "string").map(part => part.text).join("\n") ?? "";
  const blocks = [...text.matchAll(/```json\s*\n([\s\S]*?)\n```/g)];
  try { return { text, value: JSON.parse(blocks.at(-1)?.[1] ?? text) }; }
  catch { return { text, value: null }; }
}

/** Snapshot evidence comes only from terminal tool outputs, never from the answer or arguments. */
export function snapshotEvidence(events: LogEvent[]) {
  const snapshots: { eventId: number; url: string; observationId: string; itemCount: number; partial: boolean; text: string; tabId: number | null; at: number }[] = [];
  for (const event of events) {
    if (event.type !== "tool.finished") continue;
    let output: any;
    try { output = fromLogValue(event.output, event.valueEncoding); } catch { continue; }
    const toolName = (fromLogValue(event.content, event.valueEncoding) as { toolName?: string })?.toolName;
    const candidates = [output?.pageSnapshot];
    if (toolName === "inspect_page") candidates.push(output);
    if (output?.envelopeWrapped === true) {
      candidates.push(output?.result?.pageSnapshot);
      if (toolName === "inspect_page") candidates.push(output?.result);
    }
    for (const snapshot of candidates) {
      if (!snapshot || typeof snapshot.url !== "string" || typeof snapshot.observationId !== "string" || !Array.isArray(snapshot.items)) continue;
      snapshots.push({ eventId: event.id, url: snapshot.url, observationId: snapshot.observationId, itemCount: snapshot.items.length, partial: snapshot.partial === true, text: JSON.stringify(snapshot.items), tabId: typeof snapshot.tabId === "number" ? snapshot.tabId : null, at: Date.parse(event.timestamp) });
    }
  }
  return snapshots;
}

export type DocumentEvidence = { url: string; status: number; at: string; duringTask: boolean; pageId: number; tabId: number | null };

/** Require observed source facts, not merely a page title or an unrelated visible row. */
export function verifyBrowsing(required: { url: string; terms: string[]; alternatives?: string[] }[], documents: DocumentEvidence[], snapshots: ReturnType<typeof snapshotEvidence>, http: {url: string; status: number; text: string}[] = []) {
  const checks = required.map(({ url, terms, alternatives = [] }) => {
    const responses = documents.filter(doc => canonicalUrl(doc.url) === canonicalUrl(url)).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const latest = responses.at(-1);
    const visible = snapshots.filter(snapshot => {
      if (canonicalUrl(snapshot.url) !== canonicalUrl(url) || snapshot.partial || !snapshot.itemCount || snapshot.tabId === null) return false;
      const document = documents.filter(doc => doc.tabId === snapshot.tabId && Date.parse(doc.at) <= snapshot.at).sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).at(-1);
      return !!document && canonicalUrl(document.url) === canonicalUrl(url) && document.status >= 200 && document.status < 300;
    });
    const httpReads = http.filter(read => read.status >= 200 && read.status < 300 && [url, ...alternatives].some(source => canonicalUrl(source) === canonicalUrl(read.url)));
    const content = [...visible.map(snapshot => snapshot.text), ...httpReads.map(read => read.text)].join(" ").replace(/\s+/g, "").toLowerCase();
    return { url, verified: (httpReads.length > 0 || !!latest && latest.status >= 200 && latest.status < 300) && terms.length > 0
      && terms.every(term => content.includes(term.replace(/\s+/g, "").toLowerCase())),
      blocked: httpReads.length === 0 && !!latest && (latest.status === 403 || latest.status === 429 || latest.status >= 500),
      missingTerms: terms.filter(term => !content.includes(term.replace(/\s+/g, "").toLowerCase())) };
  });
  return { complete: checks.length > 0 && checks.every(check => check.verified), blocked: checks.some(check => check.blocked), checks };
}

import { deadlineEvidence } from "../evaluation/deadline-evidence";
import { toolLifecycleEvidence } from "../evaluation/tool-lifecycle";
import { browserJobsSettled } from "../evaluation/job-evidence";
import { httpEvidence, settledReadJobs } from "./http-evidence";
import { usageEvidence } from "../evaluation/model-proxy";

/** Poll canonical events until a terminal or deadline, retaining each successful observation. */
export async function pollPublicEvidence(read: (timeout: number) => Promise<LogEvent[]>, startedAt: number, deadlineAt: number, observe: (events: LogEvent[]) => void) {
  let events: LogEvent[] = [];
  while (Date.now() < deadlineAt) {
    events = await read(Math.max(1, Math.min(5000, deadlineAt - Date.now())));
    observe(events);
    if (deadlineEvidence(events, startedAt, deadlineAt).state !== "pending") break;
    await new Promise(resolveWait => setTimeout(resolveWait, Math.max(0, Math.min(1000, deadlineAt - Date.now()))));
  }
  return Date.now() >= deadlineAt && deadlineEvidence(events, startedAt, deadlineAt).state !== "on_time";
}

/** Capture once, persist the raw observation first, then derive all event evidence from it. */
export async function finalizePublicEvidence(options: {
  prior: LogEvent[]; hasObservation: boolean; read?: () => Promise<LogEvent[]>;
  persist: (events: LogEvent[]) => Promise<void>;
  startedAt: number | null; deadlineAt: number | null;
  outcome: "passed" | "failed" | "blocked" | "timed_out" | "setup_failed";
  reason: string; runError: string | null; deadlineExpired: boolean;
  required: () => { url: string; terms: string[]; alternatives: string[] }[];
  documents: DocumentEvidence[]; navigationFailures: { url: string; duringTask: boolean }[];
  grade: (value: unknown) => boolean;
  redact: (error: unknown) => string;
}) {
  let events = options.prior, hasObservation = options.hasObservation;
  let capture: { status: "not_attempted" | "succeeded" | "failed"; error: string | null; hasObservation: boolean } = { status: "not_attempted", error: null, hasObservation };
  if (options.read) try {
    events = await options.read(); hasObservation = true;
    capture = { status: "succeeded", error: null, hasObservation };
  } catch (error) { capture = { status: "failed", error: options.redact(error), hasObservation }; }
  events = structuredClone(events);
  await options.persist(events);
  let outcome = options.outcome, reason = options.reason, derivationError: string | null = null;
  let derived: { answer: ReturnType<typeof finalAnswer>; lifecycle: ReturnType<typeof toolLifecycleEvidence>; effectCertainty: boolean | null; jobs: boolean | null; snapshots: ReturnType<typeof snapshotEvidence>; http: Awaited<ReturnType<typeof httpEvidence>>; browsing: ReturnType<typeof verifyBrowsing>; usage: ReturnType<typeof usageEvidence>; correct: boolean | null } | null = null;
  try {
    if (hasObservation && options.startedAt !== null && options.deadlineAt !== null) {
      const terminal = deadlineEvidence(events, options.startedAt, options.deadlineAt);
      const lifecycle = toolLifecycleEvidence(events), effectCertainty = capture.status === "succeeded" ? browserJobsSettled(events) : null;
      const jobs = settledReadJobs(events), answer = finalAnswer(events), snapshots = snapshotEvidence(events);
      const required = options.required();
      const http = await httpEvidence(events), browsing = verifyBrowsing(required, options.documents, snapshots, http);
      let correct: boolean | null = null;
      if (!options.runError && outcome !== "timed_out" && outcome !== "failed" && capture.status === "failed") { outcome = "setup_failed"; reason = "Final canonical event capture failed"; }
      else if (!options.runError && outcome !== "failed" && (options.deadlineExpired || terminal.state === "pending" || terminal.state === "late")) { outcome = "timed_out"; reason = "Task deadline exceeded"; }
      else if (!options.runError && outcome !== "timed_out" && outcome !== "failed" && (terminal.state !== "on_time" || terminal.terminal !== "conversation.finished")) { outcome = "blocked"; reason = "Provider or conversation did not finish normally; inspect events"; }
      else if (!options.runError && outcome !== "timed_out" && outcome !== "failed") {
        correct = options.grade(answer.value);
        outcome = correct && browsing.complete && lifecycle.complete === true && jobs === true ? "passed" : "failed";
        reason = !correct ? "Structured result is incorrect or incomplete" : !browsing.complete ? "Required sources lack verified visible or HTTP response facts" : lifecycle.complete !== true || jobs !== true ? "Tool or browser-job terminal evidence is incomplete" : "All required facts and browser evidence verified";
        const inaccessible = browsing.blocked || required.some(({ url }) => {
          const failure = options.navigationFailures.filter(item => canonicalUrl(item.url) === canonicalUrl(url) && item.duringTask).at(-1);
          return !!failure && !browsing.checks.find(check => canonicalUrl(check.url) === canonicalUrl(url))?.verified;
        });
        if (inaccessible) { outcome = "blocked"; reason = "A required source failed to load in Chrome"; }
      }
      derived = { answer, lifecycle, effectCertainty, jobs, snapshots, http, browsing, usage: usageEvidence(events), correct };
    } else if (options.startedAt !== null && !options.runError) { outcome = "setup_failed"; reason = "Final canonical event capture failed"; }
  } catch (error) {
    derivationError = options.redact(error);
    if (!options.runError && outcome !== "timed_out" && outcome !== "failed") { outcome = "setup_failed"; reason = "Canonical evidence derivation failed"; }
  }
  return { events, capture, outcome, reason, derivationError, derived };
}
