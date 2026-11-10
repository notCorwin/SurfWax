const memoryKey = Symbol.for("surf-wax.element-id-sequence.v1");
const memorySequence: { value: number } = (globalThis as any)[memoryKey] ??= { value: 0 };
let database: Promise<IDBDatabase> | undefined;

/** Persist only allocation progress, never DOM handles or conversation data. */
function counterDatabase(): Promise<IDBDatabase> {
  if (database) return database;
  const pending = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("surf-wax-element-ids", 1);
    let settled = false;
    const fail = (error: Error) => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } };
    const timer = setTimeout(() => fail(new Error("Element ID storage timed out; retry the inspection.")), 10_000);
    request.onupgradeneeded = () => request.result.createObjectStore("counter", { autoIncrement: true });
    request.onblocked = () => fail(new Error("Element ID storage is blocked; close older extension views and retry."));
    request.onerror = () => fail(new Error("Could not open element ID storage; retry the inspection.", { cause: request.error }));
    request.onsuccess = () => {
      if (settled) { request.result.close(); return; }
      settled = true; clearTimeout(timer);
      request.result.onversionchange = () => { request.result.close(); database = undefined; };
      resolve(request.result);
    };
  });
  database = pending;
  void pending.catch(() => { if (database === pending) database = undefined; });
  return pending;
}

async function allocate(count: number): Promise<string[]> {
  if (!count) return [];
  // Standalone runs have no persistent model history. Share one allocator
  // across all runtimes in this process, including replaced executors.
  if (!globalThis.chrome?.runtime?.id || typeof indexedDB === "undefined") {
    if (!Number.isSafeInteger(memorySequence.value + count)) throw new Error("Element ID range exhausted; start a new standalone process.");
    return Array.from({ length: count }, () => (++memorySequence.value).toString(36));
  }
  const db = await counterDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("counter", "readwrite"), store = transaction.objectStore("counter");
    const ids: string[] = [];
    const timer = setTimeout(() => { try { transaction.abort(); } catch { /* Already completed. */ } }, 10_000);
    transaction.oncomplete = () => { clearTimeout(timer); resolve(ids); };
    transaction.onabort = transaction.onerror = () => {
      clearTimeout(timer); reject(new Error("Could not allocate element IDs; retry the inspection.", { cause: transaction.error }));
    };
    for (let index = 0; index < count; index++) {
      const request = store.add(null);
      request.onsuccess = () => {
        ids[index] = Number(request.result).toString(36);
        // Deleting the reservation retains IndexedDB's monotonic key generator.
        store.delete(request.result);
      };
    }
  });
}

export type ElementIdBinding = { session: object; generation: number; owner: string; sourceId: string; actionable: boolean };

/** Opaque short IDs share one namespace; ownership stays entirely internal. */
export class ElementIds {
  private sources = new WeakMap<object, Map<string, string>>();
  private readonly bindings = new Map<string, ElementIdBinding>();
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private epoch = 0;
  private readonly versions = new WeakMap<object, number>();
  constructor(private readonly retire: (id: string, binding: ElementIdBinding) => void) {}
  get(id: string): ElementIdBinding | undefined { return this.bindings.get(id); }
  touch(id: string): void {
    const entry = this.bindings.get(id);
    if (entry) { this.bindings.delete(id); this.bindings.set(id, entry); }
  }
  assign(entries: readonly ElementIdBinding[]): Promise<string[]> {
    this.pending++;
    const epoch = this.epoch, versions = entries.map(entry => this.versions.get(entry.session) ?? 0);
    const task = this.tail.then(async () => {
      const keys = entries.map(entry => JSON.stringify([entry.generation, entry.owner, entry.sourceId, entry.actionable]));
      const pending: Array<{ entry: ElementIdBinding; key: string }> = [];
      const seen = new WeakMap<object, Set<string>>();
      entries.forEach((entry, index) => {
        const key = keys[index]!;
        let local = seen.get(entry.session);
        if (!local) { local = new Set(); seen.set(entry.session, local); }
        if (!this.sources.get(entry.session)?.has(key) && !local.has(key)) pending.push({ entry, key });
        local.add(key);
      });
      const ids = await allocate(pending.length);
      if (epoch !== this.epoch || entries.some((entry, index) => (this.versions.get(entry.session) ?? 0) !== versions[index]))
        throw Object.assign(new Error("Element ID context changed during allocation; inspect the current page again."), { code: "stale-observation" });
      pending.forEach(({ entry, key }, index) => {
        let sources = this.sources.get(entry.session);
        if (!sources) { sources = new Map(); this.sources.set(entry.session, sources); }
        sources.set(key, ids[index]!); this.bindings.set(ids[index]!, entry);
      });
      return entries.map((entry, index) => {
        const id = this.sources.get(entry.session)!.get(keys[index]!)!;
        this.touch(id); return id;
      });
    });
    this.tail = task.then(() => { this.pending--; }, () => { this.pending--; });
    return task;
  }
  prune(session: object): void {
    if (this.pending) return;
    const ids = [...this.bindings].filter(([, binding]) => binding.session === session).map(([id]) => id);
    if (ids.length <= 32_768) return;
    for (let index = 0; index < ids.length - 24_576; index++) this.remove(ids[index]!);
  }
  clear(session?: object): void {
    if (session) this.versions.set(session, (this.versions.get(session) ?? 0) + 1); else this.epoch++;
    for (const [id, binding] of this.bindings) if (!session || binding.session === session) this.remove(id);
  }
  private remove(id: string): void {
    const binding = this.bindings.get(id)!;
    this.bindings.delete(id);
    this.sources.get(binding.session)?.delete(JSON.stringify([binding.generation, binding.owner, binding.sourceId, binding.actionable]));
    this.retire(id, binding);
  }
}
