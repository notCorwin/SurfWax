import { fromLogValue, rebuildConversation, type LogEvent } from "../../src/logging";

/** Only the last durable assistant text can supply the answer; goal completion may be tool-only. */
export function finalAnswer(events: LogEvent[]): { text: string; value: unknown } {
  const message = rebuildConversation(events).filter(message => message.role === "assistant" && message.parts.some(part => part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part && typeof part.text === "string" && part.text.trim())).at(-1);
  const text = message?.parts.filter((part): part is { type: "text"; text: string } => !!part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part && typeof part.text === "string").map(part => part.text).join("\n") ?? "";
  const blocks = [...text.matchAll(/```json\s*\n([\s\S]*?)\n```/g)];
  try { return { text, value: JSON.parse(blocks.at(-1)?.[1] ?? text) }; }
  catch { return { text, value: null }; }
}

export function canonicalUrl(url: string): string {
  try { const value = new URL(url); if (value.hostname === "developer.chrome.com") value.searchParams.delete("hl"); return `${value.origin}${value.pathname.replace(/\/$/, "")}${value.search}`; }
  catch { return ""; }
}

/** Snapshot evidence comes only from terminal tool outputs, never from the answer or arguments. */
export function snapshotEvidence(events: LogEvent[]) {
  const snapshots: { eventId: number; url: string; observationId: string; itemCount: number; partial: boolean; text: string; tabId: number | null; at: number }[] = [];
  for (const event of events) {
    if (event.type !== "tool.finished") continue;
    let output: any;
    try { output = fromLogValue(event.output, event.valueEncoding); } catch { continue; }
    const candidates = [output, output?.pageSnapshot, output?.result?.pageSnapshot];
    for (const snapshot of candidates) {
      if (!snapshot || typeof snapshot.url !== "string" || typeof snapshot.observationId !== "string" || !Array.isArray(snapshot.items)) continue;
      snapshots.push({ eventId: event.id, url: snapshot.url, observationId: snapshot.observationId, itemCount: snapshot.items.length, partial: snapshot.partial === true, text: JSON.stringify(snapshot.items), tabId: typeof snapshot.tabId === "number" ? snapshot.tabId : null, at: Date.parse(event.timestamp) });
    }
  }
  return snapshots;
}

export type DocumentEvidence = { url: string; status: number; at: string; duringTask: boolean; pageId: number; tabId: number | null };

/** Require observed source facts, not merely a page title or an unrelated visible row. */
export function verifyBrowsing(required: { url: string; terms: string[] }[], documents: DocumentEvidence[], snapshots: ReturnType<typeof snapshotEvidence>) {
  const checks = required.map(({ url, terms }) => {
    const responses = documents.filter(doc => canonicalUrl(doc.url) === canonicalUrl(url)).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const latest = responses.at(-1);
    const visible = snapshots.filter(snapshot => {
      if (canonicalUrl(snapshot.url) !== canonicalUrl(url) || snapshot.partial || !snapshot.itemCount || snapshot.tabId === null) return false;
      const document = documents.filter(doc => doc.tabId === snapshot.tabId && Date.parse(doc.at) <= snapshot.at).sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).at(-1);
      return !!document && canonicalUrl(document.url) === canonicalUrl(url) && document.status >= 200 && document.status < 300;
    });
    const content = visible.map(snapshot => snapshot.text).join(" ").replace(/\s+/g, "").toLowerCase();
    return { url, verified: !!latest && latest.status >= 200 && latest.status < 300 && terms.length > 0
      && terms.every(term => content.includes(term.replace(/\s+/g, "").toLowerCase())),
      blocked: !!latest && (latest.status === 403 || latest.status === 429 || latest.status >= 500),
      missingTerms: terms.filter(term => !content.includes(term.replace(/\s+/g, "").toLowerCase())) };
  });
  return { complete: checks.length > 0 && checks.every(check => check.verified), blocked: checks.some(check => check.blocked), checks };
}
