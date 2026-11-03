/** A completed top-level tab load observed while a run owns the tab. */
export type PageRefresh = { tabId: number; generation: number };
export type UnsettledRefresh = PageRefresh & { elapsedMs: number };
export const REFRESH_SETTLE_TIMEOUT_MS = 15_000;

type TabUpdate = (tabId: number, change: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab) => void;
type TabUpdates = { addListener(listener: TabUpdate): void; removeListener(listener: TabUpdate): void };
type TabRemoved = (tabId: number, info: chrome.tabs.OnRemovedInfo) => void;
type TabRemovals = { addListener(listener: TabRemoved): void; removeListener(listener: TabRemoved): void };

/** Tracks document loads separately from incidental tab metadata updates. */
export class RefreshTracker {
  private readonly generations = new Map<number, number>();
  private readonly loading = new Map<number, { generation: number; owned: boolean }>();
  private readonly unboundCompleted = new Map<number, PageRefresh>();
  private pending: PageRefresh[] = [];
  private readonly reportedLoading = new Map<number, number>();
  private disposed = false;
  private readonly waiters = new Set<() => void>();

  private readonly onUpdated: TabUpdate = (tabId, change) => {
    if (this.disposed) return;
    let refresh: PageRefresh | undefined;
    if (change.status === "loading") {
      const generation = (this.generations.get(tabId) ?? 0) + 1;
      this.generations.set(tabId, generation);
      this.reportedLoading.delete(tabId);
      this.unboundCompleted.delete(tabId);
      const target = this.targetTab();
      this.loading.set(tabId, { generation, owned: target === undefined || tabId === target });
    } else if (change.status === "complete") {
      const load = this.loading.get(tabId);
      if (!load) return;
      this.loading.delete(tabId);
      this.reportedLoading.delete(tabId);
      if (load.owned && tabId === this.targetTab()) {
        refresh = { tabId, generation: load.generation };
        this.pending.push(refresh);
      } else if (load.owned && this.targetTab() === undefined) {
        this.unboundCompleted.set(tabId, { tabId, generation: load.generation });
      }
    }
    this.notify();
    if (refresh) this.onRefresh?.(refresh);
  };

  private readonly onRemoved: TabRemoved = (tabId) => {
    this.loading.delete(tabId);
    this.reportedLoading.delete(tabId);
    this.generations.delete(tabId);
    this.unboundCompleted.delete(tabId);
    this.notify();
  };
  private readonly onAbort = () => this.dispose();

  constructor(private readonly updates: TabUpdates, private readonly targetTab: () => number | undefined, private readonly signal?: AbortSignal,
    private readonly removals?: TabRemovals, private readonly onRefresh?: (refresh: PageRefresh) => void) {
    if (signal?.aborted) { this.disposed = true; return; }
    updates.addListener(this.onUpdated);
    removals?.addListener(this.onRemoved);
    signal?.addEventListener("abort", this.onAbort, { once: true });
  }

  private notify(): void {
    for (const wake of this.waiters) wake();
    this.waiters.clear();
  }

  /** Wake waiters after changing the tab bound to the run. */
  targetChanged(): void {
    const target = this.targetTab();
    if (target !== undefined) {
      const refresh = this.unboundCompleted.get(target);
      this.unboundCompleted.clear();
      if (refresh) { this.pending.push(refresh); this.onRefresh?.(refresh); }
    }
    this.notify();
  }

  hasActivity(): boolean {
    const tabId = this.targetTab();
    return this.pending.length > 0 || tabId !== undefined && this.loading.has(tabId)
      && this.reportedLoading.get(tabId) !== this.loading.get(tabId)!.generation;
  }

  /** Report an incomplete load once per generation without taking a snapshot.
   * Later completion remains observable and produces its normal fresh snapshot.
   */
  async waitForSettled(onWaiting?: (state: UnsettledRefresh) => void): Promise<UnsettledRefresh | undefined> {
    const started = performance.now();
    let reported = false;
    while (!this.disposed) {
      this.signal?.throwIfAborted();
      const tabId = this.targetTab();
      const load = tabId === undefined ? undefined : this.loading.get(tabId);
      if (tabId === undefined || !load || this.reportedLoading.get(tabId) === load.generation) return;
      const elapsedMs = performance.now() - started;
      if (elapsedMs >= REFRESH_SETTLE_TIMEOUT_MS) {
        this.reportedLoading.set(tabId, load.generation);
        return { tabId, generation: load.generation, elapsedMs };
      }
      await new Promise<void>((resolve) => {
        const wake = () => { clearTimeout(timer); this.waiters.delete(wake); resolve(); };
        const timer = setTimeout(() => {
          if (!reported && onWaiting && this.loading.has(tabId)) {
            reported = true;
            onWaiting({ tabId, generation: load.generation, elapsedMs: performance.now() - started });
          }
          wake();
        }, Math.min(REFRESH_SETTLE_TIMEOUT_MS - elapsedMs, !reported && onWaiting ? 10_000 : REFRESH_SETTLE_TIMEOUT_MS));
        this.waiters.add(wake);
      });
    }
    this.signal?.throwIfAborted();
  }

  /** Removes and returns all completed loads in observation order. */
  drain(): PageRefresh[] {
    const pending = this.pending;
    this.pending = [];
    return pending;
  }

  /** Whether a completed load is still the bound tab's current document. */
  isCurrent(refresh: PageRefresh): boolean {
    return !this.disposed && this.targetTab() === refresh.tabId
      && this.generations.get(refresh.tabId) === refresh.generation && !this.loading.has(refresh.tabId);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.updates.removeListener(this.onUpdated);
    this.removals?.removeListener(this.onRemoved);
    this.signal?.removeEventListener("abort", this.onAbort);
    this.pending = [];
    this.loading.clear();
    this.reportedLoading.clear();
    this.unboundCompleted.clear();
    this.generations.clear();
    this.notify();
  }
}
