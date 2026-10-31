/** A compact independent consumer for paged semantic observations. */
export type SemanticItem = { id: string; line: string; ref?: string; change?: "added" | "updated" | "removed" | "moved"; after?: string | null };
type Fragment = SemanticItem & { fragment?: { index: number; start: number; end: number; total: number } };
type Page = { observationId: string; documentId: number; mode: "full" | "delta"; items: Fragment[]; nextCursor?: string; truncation: { baselineComplete: boolean } };

export class SemanticPages {
  private identity?: { observationId: string; documentId: number; mode: Page["mode"] };
  private cursor?: string;
  private ended = false;
  private readonly items: SemanticItem[] = [];
  private readonly ids = new Set<string>();
  private partial?: { item: SemanticItem; index: number; total: number };
  fragments = 0;

  append(page: Page, cursor?: string): string | undefined {
    if (this.ended || cursor !== this.cursor || !page || !Array.isArray(page.items)
      || typeof page.observationId !== "string" || !page.observationId || !Number.isSafeInteger(page.documentId)
      || !["full", "delta"].includes(page.mode) || !page.truncation || typeof page.truncation.baselineComplete !== "boolean") throw new Error("Invalid semantic page");
    if (!this.identity) this.identity = { observationId: page.observationId, documentId: page.documentId, mode: page.mode };
    if (page.observationId !== this.identity.observationId || page.documentId !== this.identity.documentId || page.mode !== this.identity.mode) throw new Error("Mixed semantic observations");
    for (const raw of page.items) {
      if (!raw || typeof raw.id !== "string" || !raw.id || typeof raw.line !== "string"
        || raw.ref !== undefined && typeof raw.ref !== "string"
        || raw.change !== undefined && !["added", "updated", "removed", "moved"].includes(raw.change)
        || raw.after !== undefined && raw.after !== null && typeof raw.after !== "string") throw new Error("Invalid semantic item");
      if (/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(raw.line)) throw new Error("Split Unicode surrogate");
      const { fragment, ...item } = raw;
      if (!fragment) {
        if (this.partial || this.ids.has(item.id)) throw new Error("Duplicate or incomplete semantic item");
        this.ids.add(item.id); this.items.push(item); continue;
      }
      this.fragments++;
      if (![fragment.index, fragment.start, fragment.end, fragment.total].every(Number.isSafeInteger)
        || fragment.index < 0 || fragment.start < 0 || fragment.end <= fragment.start || fragment.end > fragment.total
        || fragment.end - fragment.start !== item.line.length) throw new Error("Invalid semantic fragment");
      if (!this.partial) {
        if (fragment.start !== 0 || this.ids.has(item.id)) throw new Error("Missing semantic fragment");
        this.partial = { item: { ...item, line: "" }, index: fragment.index, total: fragment.total };
      }
      const part = this.partial;
      if (part.item.id !== item.id || part.index !== fragment.index || part.total !== fragment.total
        || part.item.line.length !== fragment.start || part.item.ref !== item.ref || part.item.change !== item.change || part.item.after !== item.after) throw new Error("Inconsistent semantic fragments");
      part.item.line += item.line;
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

  result(): { observationId: string; mode: Page["mode"]; items: SemanticItem[] } {
    if (!this.ended || !this.identity) throw new Error("Semantic observation is incomplete");
    return { observationId: this.identity.observationId, mode: this.identity.mode, items: structuredClone(this.items) };
  }
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
