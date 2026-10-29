/** Internal lifecycle hook; never sent to the program worker. */
export const PROGRAM_HANDLE_ASSERT_LIVE = Symbol("program-handle-assert-live");

/** Strongly held bridge capabilities, indexed by the tab that owns them. */
export class ProgramHandles {
  private readonly objects = new Map<string, object>();
  private readonly ids = new WeakMap<object, string>();
  private readonly byTab = new Map<number, Set<string>>();

  get size(): number { return this.objects.size; }

  remember(value: object, tabId?: number): string {
    const assertLive = (value as any)[PROGRAM_HANDLE_ASSERT_LIVE];
    if (typeof assertLive === "function") assertLive();
    let id = this.ids.get(value);
    if (id) return id;
    id = crypto.randomUUID();
    this.ids.set(value, id);
    this.objects.set(id, value);
    if (tabId !== undefined) {
      let ids = this.byTab.get(tabId);
      if (!ids) this.byTab.set(tabId, ids = new Set());
      ids.add(id);
    }
    return id;
  }

  resolve(id: string): any {
    const value = this.objects.get(id);
    if (!value) throw new Error("Program capability handle expired (stale-page)");
    return value;
  }

  closeTab(tabId: number): void {
    const ids = this.byTab.get(tabId);
    if (!ids) return;
    for (const id of ids) this.objects.delete(id);
    this.byTab.delete(tabId);
    // Keep the weak identity association: re-encoding a retired object cannot
    // resurrect a handle that was invalidated while an RPC was in flight.
  }

  clear(): void {
    this.objects.clear();
    this.byTab.clear();
  }
}
