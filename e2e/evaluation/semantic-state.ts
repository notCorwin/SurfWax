/** A compact independent consumer for paged structured semantic observations. */
export type SemanticItem = {
  id: string;
  depth?: number;
  role?: string;
  name?: string;
  nameUnknown?: true;
  box?: readonly number[];
  textBox?: readonly number[];
  textParts?: readonly { text: string; box?: readonly number[] }[];
  coordinates?: "frame-viewport";
  value?: string;
  valueUnknown?: true;
  placeholder?: string | "unknown";
  selected?: readonly string[];
  frameRef?: string;
  ownerUnrepresented?: true;
  actionable?: true;
  actions?: readonly string[];
  state?: Record<string, unknown>;
  count?: number;
  boxes?: readonly unknown[];
  path?: readonly unknown[];
  change?: "added" | "updated" | "removed" | "moved";
  after?: string | null;
};
type FragmentMeta = { index: number; field: string; start: number; end: number; total: number };
type Fragment = SemanticItem & { fragment?: FragmentMeta };
type Page = { observationId: string; documentId: number; mode: "full" | "delta"; baseObservationId?: string; items: Fragment[]; nextCursor?: string; truncation: { baselineComplete: boolean } };

function sliceText(item: SemanticItem, field: string): string | undefined {
  if (field === "name") return typeof item.name === "string" ? item.name : undefined;
  if (field === "value") return typeof item.value === "string" ? item.value : undefined;
  const match = /^textParts\.(\d+)\.text$/.exec(field);
  if (match && item.textParts) {
    const text = item.textParts[Number(match[1])]?.text;
    return typeof text === "string" ? text : undefined;
  }
}

function withSlice(item: SemanticItem, field: string, text: string): SemanticItem {
  if (field === "name") return { ...item, name: text };
  if (field === "value") return { ...item, value: text };
  const match = /^textParts\.(\d+)\.text$/.exec(field);
  if (match && item.textParts) {
    const index = Number(match[1]);
    return { ...item, textParts: item.textParts.map((part, partIndex) => partIndex === index ? { ...part, text } : part) };
  }
  throw new Error("Invalid semantic fragment");
}

export class SemanticPages {
  private identity?: { observationId: string; documentId: number; mode: Page["mode"]; baseObservationId?: string };
  private cursor?: string;
  private ended = false;
  private readonly items: SemanticItem[] = [];
  private readonly ids = new Set<string>();
  private partial?: { item: SemanticItem; field: string; index: number; total: number };
  fragments = 0;

  append(page: Page, cursor?: string): string | undefined {
    if (this.ended || cursor !== this.cursor || !page || !Array.isArray(page.items)
      || typeof page.observationId !== "string" || !page.observationId || !Number.isSafeInteger(page.documentId)
      || !["full", "delta"].includes(page.mode) || !page.truncation || typeof page.truncation.baselineComplete !== "boolean") throw new Error("Invalid semantic page");
    if (!this.identity) this.identity = { observationId: page.observationId, documentId: page.documentId, mode: page.mode, baseObservationId: page.baseObservationId };
    if (page.observationId !== this.identity.observationId || page.documentId !== this.identity.documentId || page.mode !== this.identity.mode
      || page.baseObservationId !== this.identity.baseObservationId) throw new Error("Mixed semantic observations");
    for (const raw of page.items) {
      if (!raw || typeof raw !== "object" || typeof raw.id !== "string" || !raw.id
        || raw.actionable !== undefined && raw.actionable !== true
        || raw.change !== undefined && !["added", "updated", "removed", "moved"].includes(raw.change)
        || raw.after !== undefined && raw.after !== null && typeof raw.after !== "string") throw new Error("Invalid semantic item");
      const { fragment, ...item } = raw;
      if (!fragment) {
        if (this.partial || this.ids.has(item.id)) throw new Error("Duplicate or incomplete semantic item");
        this.ids.add(item.id); this.items.push(item); continue;
      }
      this.fragments++;
      if (typeof fragment.field !== "string" || !fragment.field
        || ![fragment.index, fragment.start, fragment.end, fragment.total].every(Number.isSafeInteger)
        || fragment.index < 0 || fragment.start < 0 || fragment.end <= fragment.start || fragment.end > fragment.total) throw new Error("Invalid semantic fragment");
      const text = sliceText(item, fragment.field);
      if (typeof text !== "string" || fragment.end - fragment.start !== text.length) throw new Error("Invalid semantic fragment");
      if (/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(text)) throw new Error("Split Unicode surrogate");
      if (!this.partial) {
        if (fragment.start !== 0 || this.ids.has(item.id)) throw new Error("Missing semantic fragment");
        this.partial = { item: withSlice(item, fragment.field, ""), field: fragment.field, index: fragment.index, total: fragment.total };
      }
      const part = this.partial, assembled = sliceText(part.item, part.field) ?? "";
      if (part.item.id !== item.id || part.field !== fragment.field || part.index !== fragment.index || part.total !== fragment.total
        || assembled.length !== fragment.start || part.item.actionable !== item.actionable || part.item.change !== item.change || part.item.after !== item.after) throw new Error("Inconsistent semantic fragments");
      part.item = withSlice(part.item, part.field, assembled + text);
      if (fragment.end === fragment.total) { this.ids.add(item.id); this.items.push(part.item); this.partial = undefined; }
    }
    if (page.nextCursor !== undefined && (typeof page.nextCursor !== "string" || !page.nextCursor || page.nextCursor === cursor)) throw new Error("Invalid semantic cursor");
    this.cursor = page.nextCursor;
    if (!this.cursor) {
      if (this.partial || !page.truncation.baselineComplete) throw new Error("Incomplete semantic observation");
      this.ended = true;
    }
    return this.cursor;
  }

  result(): { observationId: string; mode: Page["mode"]; baseObservationId?: string; items: SemanticItem[] } {
    if (!this.ended || !this.identity) throw new Error("Semantic observation is incomplete");
    return { observationId: this.identity.observationId, mode: this.identity.mode,
      ...(this.identity.baseObservationId ? { baseObservationId: this.identity.baseObservationId } : {}), items: structuredClone(this.items) };
  }
}

/** Rebuild only completely delivered observations from actual canonical receipts.
 * Automatic snapshots may form a chain; their base ID, rather than proximity in
 * the transcript, determines which prior visible state each change applies to.
 */
export function deliveredSemanticState(events: readonly { type: string; output?: unknown }[], observation: { observationId: string }): SemanticItem[] {
  const pending = new Map<string, { pages: SemanticPages; cursor?: string }>();
  const complete = new Map<string, ReturnType<SemanticPages["result"]>>();
  for (const event of events) {
    if (!["tool.finished", "tool.failed", "tool.aborted"].includes(event.type)) continue;
    const output = event.output as { pageSnapshot?: unknown; observationId?: unknown } | undefined;
    const page = (output?.pageSnapshot ?? (output?.observationId ? output : undefined)) as (Page & { partial?: boolean }) | undefined;
    if (!page || page.partial || !Array.isArray(page.items) || complete.has(page.observationId)) continue;
    let current = pending.get(page.observationId);
    if (!current) { current = { pages: new SemanticPages() }; pending.set(page.observationId, current); }
    current.cursor = current.pages.append(page, current.cursor);
    if (!current.cursor) complete.set(page.observationId, current.pages.result());
    // A baseline completed only after this observation was delivered cannot
    // justify the producer having selected it for an automatic delta.
    if (complete.has(observation.observationId)) break;
  }
  const visiting = new Set<string>();
  const resolve = (id: string): SemanticItem[] => {
    if (visiting.has(id)) throw new Error("Cyclic semantic baseline chain");
    const current = complete.get(id);
    if (!current) throw new Error(`Missing completely delivered semantic baseline ${id}`);
    if (current.mode === "full") return current.items;
    if (!current.baseObservationId) throw new Error("Delta has no explicit semantic baseline");
    visiting.add(id);
    try { return applySemanticDelta(resolve(current.baseObservationId), current.items); }
    finally { visiting.delete(id); }
  };
  return resolve(observation.observationId);
}

/** Apply the published delta contract, independently of the snapshot producer. */
export function applySemanticDelta(previous: readonly SemanticItem[], changes: readonly SemanticItem[]): SemanticItem[] {
  const items = previous.map((item) => ({ ...item }));
  if (new Set(items.map((item) => item.id)).size !== items.length) throw new Error("Duplicate baseline item");
  for (const change of changes) {
    const index = items.findIndex((item) => item.id === change.id);
    if (change.change === "removed") {
      if (index < 0) throw new Error("Removed item is missing");
      items.splice(index, 1); continue;
    }
    if (!change.change || change.change === "added" && index >= 0 || change.change !== "added" && index < 0
      || change.after === undefined || change.after === change.id) throw new Error("Invalid semantic change");
    if (index >= 0) items.splice(index, 1);
    const position = change.after === null ? 0 : items.findIndex((item) => item.id === change.after) + 1;
    if (change.after !== null && position === 0) throw new Error("Missing semantic predecessor");
    const { change: _change, after: _after, ...item } = change;
    items.splice(position, 0, item);
  }
  return items;
}
