/** Internal lifecycle hook; never sent to the program worker. */
export const PROGRAM_HANDLE_ASSERT_LIVE = Symbol("program-handle-assert-live");
export const PROGRAM_HANDLE_SESSION = Symbol("program-handle-session");
/** Invoke a concurrent event effect with its own write-ahead dispatch marker. */
export const PROGRAM_EVENT_INVOKE = Symbol("program-event-invoke");

/** A program's initial page is acquired only when a page capability is used. */
export class DeferredProgramPage {
  private pending?: Promise<object>;
  private page?: object;
  constructor(readonly tabId: number | undefined, private readonly acquire: () => Promise<object>) {}
  bind(): Promise<object> {
    if (!this.pending) this.pending = this.acquire().then((page) => { this.page = page; return page; }, (error) => { this.pending = undefined; throw error; });
    return this.pending;
  }
  bound(): object {
    if (!this.page) throw new Error("Program page has not been bound");
    return this.page;
  }
}

/** Strongly held bridge capabilities, indexed by the tab that owns them. */
export class ProgramHandles {
  private readonly objects = new Map<string, object>();
  private readonly ids = new WeakMap<object, string>();
  private readonly byTab = new Map<number, { session?: object; ids: Set<string> }>();

  get size(): number { return this.objects.size; }

  remember(value: object, tabId?: number): string {
    const assertLive = (value as any)[PROGRAM_HANDLE_ASSERT_LIVE];
    if (typeof assertLive === "function") assertLive();
    const session = (value as any)[PROGRAM_HANDLE_SESSION];
    if (tabId !== undefined && session && typeof session === "object") {
      const previous = this.byTab.get(tabId);
      if (previous?.session && previous.session !== session) this.closeTab(tabId);
    }
    let id = this.ids.get(value);
    if (id) return id;
    id = crypto.randomUUID();
    this.ids.set(value, id);
    this.objects.set(id, value);
    if (tabId !== undefined) {
      let entry = this.byTab.get(tabId);
      if (!entry) this.byTab.set(tabId, entry = { ...(session && typeof session === "object" ? { session } : {}), ids: new Set() });
      else if (!entry.session && session && typeof session === "object") entry.session = session;
      entry.ids.add(id);
    }
    return id;
  }

  resolve(id: string): any {
    const value = this.objects.get(id);
    if (!value) throw new Error("Program capability handle expired (stale-page)");
    return value;
  }

  closeTab(tabId: number): void {
    const entry = this.byTab.get(tabId);
    if (!entry) return;
    for (const id of entry.ids) this.objects.delete(id);
    this.byTab.delete(tabId);
    // Keep the weak identity association: re-encoding a retired object cannot
    // resurrect a handle that was invalidated while an RPC was in flight.
  }

  clear(): void {
    this.objects.clear();
    this.byTab.clear();
  }
}
