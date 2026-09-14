import type { JsonValue } from "./types";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogCategory = "conversation" | "model" | "tool" | "request" | "userscript" | "system";

export type LogEvent = {
  id: number;
  type: string;
  timestamp: string;
  content: JsonValue;
  category: LogCategory;
  level: LogLevel;
  runId?: string;
  stopReason?: JsonValue;
  usage?: JsonValue;
  providerMetadata?: JsonValue;
  toolCallId?: string;
  input?: JsonValue;
  output?: JsonValue;
  error?: JsonValue;
  retry?: JsonValue;
  abort?: JsonValue;
  latencyMs?: number;
};

export type NewLogEvent = Omit<LogEvent, "id">;

export type LogQuery = {
  limit?: number;
  beforeId?: number;
  category?: LogCategory;
  search?: string;
};

export interface LogStore {
  append(event: NewLogEvent): Promise<LogEvent>;
  list(query?: LogQuery): Promise<LogEvent[]>;
  all(): Promise<LogEvent[]>;
  clear(): Promise<void>;
}

const DB_NAME = "side-agent-runtime";
const DB_VERSION = 2;
const EVENT_STORE = "events";
const LEGACY_EVENT_STORE = "audit-events";

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  });
}

function asCategory(value: unknown): LogCategory {
  return value === "conversation" || value === "model" || value === "tool" || value === "request" || value === "userscript" || value === "system"
    ? value
    : "system";
}

function asLevel(value: unknown): LogLevel {
  return value === "debug" || value === "info" || value === "warn" || value === "error" ? value : "info";
}

function normalizeEvent(value: unknown): LogEvent {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const legacyType = typeof raw.event === "string" ? raw.event : "system.legacy";
  const type = typeof raw.type === "string" ? raw.type : legacyType;
  const content = raw.content !== undefined ? raw.content : raw.payload ?? null;
  return {
    id: typeof raw.id === "number" ? raw.id : Number(raw.id ?? 0),
    type,
    timestamp: typeof raw.timestamp === "string" ? raw.timestamp : new Date(0).toISOString(),
    content: toLogValue(content),
    category: asCategory(raw.category),
    level: asLevel(raw.level),
    ...(typeof raw.runId === "string" ? { runId: raw.runId } : {}),
    ...(raw.stopReason !== undefined ? { stopReason: toLogValue(raw.stopReason) } : {}),
    ...(raw.usage !== undefined ? { usage: toLogValue(raw.usage) } : {}),
    ...(raw.providerMetadata !== undefined ? { providerMetadata: toLogValue(raw.providerMetadata) } : {}),
    ...(typeof raw.toolCallId === "string" ? { toolCallId: raw.toolCallId } : {}),
    ...(raw.input !== undefined ? { input: toLogValue(raw.input) } : {}),
    ...(raw.output !== undefined ? { output: toLogValue(raw.output) } : {}),
    ...(raw.error !== undefined ? { error: toLogValue(raw.error) } : {}),
    ...(raw.retry !== undefined ? { retry: toLogValue(raw.retry) } : {}),
    ...(raw.abort !== undefined ? { abort: toLogValue(raw.abort) } : {}),
    ...(typeof raw.latencyMs === "number" ? { latencyMs: raw.latencyMs } : {}),
  };
}

export class IndexedDbLogStore implements LogStore {
  private dbPromise?: Promise<IDBDatabase>;

  private open(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    if (typeof indexedDB === "undefined") return Promise.reject(new Error("IndexedDB is unavailable"));

    this.dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        const transaction = request.transaction;
        const created = !db.objectStoreNames.contains(EVENT_STORE);
        const target = created
          ? db.createObjectStore(EVENT_STORE, { keyPath: "id", autoIncrement: true })
          : transaction!.objectStore(EVENT_STORE);

        if (created && db.objectStoreNames.contains(LEGACY_EVENT_STORE) && transaction) {
          const source = transaction.objectStore(LEGACY_EVENT_STORE);
          const cursorRequest = source.openCursor();
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (!cursor) return;
            const event = normalizeEvent(cursor.value);
            if (event.id > 0) target.put(event);
            else {
              const { id: _id, ...withoutId } = event;
              target.add(withoutId);
            }
            cursor.continue();
          };
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    });
    return this.dbPromise;
  }

  async append(event: NewLogEvent): Promise<LogEvent> {
    const db = await this.open();
    const transaction = db.transaction(EVENT_STORE, "readwrite");
    const id = await requestResult<IDBValidKey>(transaction.objectStore(EVENT_STORE).add(event));
    await transactionDone(transaction);
    return normalizeEvent({ ...event, id: Number(id) });
  }

  async list(query: LogQuery = {}): Promise<LogEvent[]> {
    const search = query.search?.trim().toLowerCase();
    return (await this.all())
      .filter((event) => query.beforeId === undefined || event.id < query.beforeId)
      .filter((event) => !query.category || event.category === query.category)
      .filter((event) => !search || JSON.stringify(event).toLowerCase().includes(search))
      .sort((left, right) => right.id - left.id)
      .slice(0, query.limit ?? 100);
  }

  async all(): Promise<LogEvent[]> {
    const db = await this.open();
    const transaction = db.transaction(EVENT_STORE, "readonly");
    const values = await requestResult<unknown[]>(transaction.objectStore(EVENT_STORE).getAll());
    return values.map(normalizeEvent).sort((left, right) => left.id - right.id);
  }

  async clear(): Promise<void> {
    const db = await this.open();
    const transaction = db.transaction(EVENT_STORE, "readwrite");
    transaction.objectStore(EVENT_STORE).clear();
    await transactionDone(transaction);
  }
}

export class MemoryLogStore implements LogStore {
  private nextId = 1;
  private readonly events: LogEvent[] = [];

  async append(event: NewLogEvent): Promise<LogEvent> {
    const stored = normalizeEvent({ ...event, id: this.nextId++ });
    this.events.push(stored);
    return stored;
  }

  async list(query: LogQuery = {}): Promise<LogEvent[]> {
    const search = query.search?.trim().toLowerCase();
    return this.events
      .filter((event) => query.beforeId === undefined || event.id < query.beforeId)
      .filter((event) => !query.category || event.category === query.category)
      .filter((event) => !search || JSON.stringify(event).toLowerCase().includes(search))
      .sort((left, right) => right.id - left.id)
      .slice(0, query.limit ?? 100);
  }

  async all(): Promise<LogEvent[]> {
    return [...this.events].sort((left, right) => left.id - right.id);
  }

  async clear(): Promise<void> {
    this.events.length = 0;
  }
}

let sharedStore: LogStore | undefined;

export function getLogStore(): LogStore {
  if (!sharedStore) sharedStore = typeof indexedDB === "undefined" ? new MemoryLogStore() : new IndexedDbLogStore();
  return sharedStore;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

export function toLogValue(value: unknown, active = new WeakSet<object>()): JsonValue {
  if (value === null) return null;
  if (value === undefined) return { $type: "undefined", value: null };
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : { $type: "number", value: String(value) };
  if (typeof value === "bigint") return { $type: "bigint", value: value.toString() };
  if (typeof value === "symbol") return { $type: "symbol", value: String(value) };
  if (typeof value === "function") return { $type: "function", value: value.name || "anonymous" };
  if (active.has(value)) return { $type: "circular-reference", value: "$" };

  active.add(value);
  try {
    if (value instanceof Error) return { $type: "error", name: value.name, message: toLogValue(value.message), stack: toLogValue(value.stack ?? null) };
    if (value instanceof Date) return { $type: "date", value: Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString() };
    if (value instanceof ArrayBuffer) return { $type: "array-buffer", byteLength: value.byteLength, base64: bytesToBase64(new Uint8Array(value)) };
    if (ArrayBuffer.isView(value)) {
      const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      return { $type: "typed-array", name: value.constructor.name, byteLength: value.byteLength, base64: bytesToBase64(bytes) };
    }
    if (value instanceof Map) return { $type: "map", entries: [...value.entries()].map(([key, item]) => [toLogValue(key, active), toLogValue(item, active)]) };
    if (value instanceof Set) return { $type: "set", values: [...value.values()].map((item) => toLogValue(item, active)) };
    if (Array.isArray(value)) return value.map((item) => toLogValue(item, active));

    const result: Record<string, JsonValue> = {};
    for (const [key, child] of Object.entries(value)) result[key] = toLogValue(child, active);
    return result;
  } finally {
    active.delete(value);
  }
}

export type LogRecord = {
  category: LogCategory;
  type: string;
  content?: unknown;
  level?: LogLevel;
  runId?: string;
  stopReason?: unknown;
  usage?: unknown;
  providerMetadata?: unknown;
  toolCallId?: string;
  input?: unknown;
  output?: unknown;
  error?: unknown;
  retry?: unknown;
  abort?: unknown;
  latencyMs?: number;
};

export type ConversationMessage = {
  id: string;
  role: "system" | "user" | "assistant";
  parts: unknown[];
  [key: string]: unknown;
};

function isConversationMessage(value: unknown): value is ConversationMessage {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && typeof (value as { id?: unknown }).id === "string"
    && ((value as { role?: unknown }).role === "system" || (value as { role?: unknown }).role === "user" || (value as { role?: unknown }).role === "assistant")
    && Array.isArray((value as { parts?: unknown }).parts));
}

function restoreConversationValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(restoreConversationValue);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (record.$type === "undefined" && record.value === null && Object.keys(record).length === 2) return undefined;
  return Object.fromEntries(Object.entries(record).map(([key, child]) => [key, restoreConversationValue(child)]));
}

function readConversationMessage(event: LogEvent): ConversationMessage | undefined {
  if (event.type !== "conversation.message") return undefined;
  const message = restoreConversationValue(event.content);
  return isConversationMessage(message) ? message : undefined;
}

export function rebuildConversation(events: readonly LogEvent[]): ConversationMessage[] {
  const messages = new Map<string, ConversationMessage>();
  const order: string[] = [];
  let baseIds: string[] | undefined;
  let baseEventIndex = -1;

  events.forEach((event, index) => {
    if (event.type === "conversation.context" && event.content && typeof event.content === "object" && !Array.isArray(event.content)) {
      const ids = (event.content as { ids?: unknown }).ids;
      if (Array.isArray(ids) && ids.every((id) => typeof id === "string")) {
        baseIds = [...ids];
        baseEventIndex = index;
      }
    }
    const message = readConversationMessage(event);
    if (!message) return;
    if (!messages.has(message.id)) order.push(message.id);
    messages.set(message.id, message);
  });

  if (!baseIds) return order.flatMap((id) => messages.get(id) ? [messages.get(id)!] : []);

  const result: ConversationMessage[] = [];
  const included = new Set<string>();
  for (const id of baseIds) {
    const message = messages.get(id);
    if (message) {
      result.push(message);
      included.add(id);
    }
  }
  events.slice(baseEventIndex + 1).forEach((event) => {
    const appended = readConversationMessage(event);
    if (!appended) return;
    const message = messages.get(appended.id);
    if (!message) return;
    const index = result.findIndex((item) => item.id === message.id);
    if (index >= 0) result[index] = message;
    else if (!included.has(message.id)) {
      included.add(message.id);
      result.push(message);
    }
  });
  return result;
}

export class EventLogger {
  private pending: Promise<unknown> = Promise.resolve();
  private activeRunId?: string;
  private readonly store: LogStore;
  private readonly now: () => Date;

  constructor(options: { store?: LogStore; now?: () => Date } = {}) {
    this.store = options.store ?? getLogStore();
    this.now = options.now ?? (() => new Date());
  }

  beginRun(runId: string): void {
    this.activeRunId = runId;
  }

  endRun(runId?: string): void {
    if (!runId || this.activeRunId === runId) this.activeRunId = undefined;
  }

  append(record: LogRecord): Promise<LogEvent> {
    const event: NewLogEvent = {
      timestamp: this.now().toISOString(),
      type: record.type,
      category: record.category,
      level: record.level ?? "info",
      content: toLogValue(record.content === undefined ? null : record.content),
      ...(record.runId ?? this.activeRunId ? { runId: record.runId ?? this.activeRunId } : {}),
      ...(record.stopReason !== undefined ? { stopReason: toLogValue(record.stopReason) } : {}),
      ...(record.usage !== undefined ? { usage: toLogValue(record.usage) } : {}),
      ...(record.providerMetadata !== undefined ? { providerMetadata: toLogValue(record.providerMetadata) } : {}),
      ...(record.toolCallId !== undefined ? { toolCallId: record.toolCallId } : {}),
      ...(record.input !== undefined ? { input: toLogValue(record.input) } : {}),
      ...(record.output !== undefined ? { output: toLogValue(record.output) } : {}),
      ...(record.error !== undefined ? { error: toLogValue(record.error) } : {}),
      ...(record.retry !== undefined ? { retry: toLogValue(record.retry) } : {}),
      ...(record.abort !== undefined ? { abort: toLogValue(record.abort) } : {}),
      ...(record.latencyMs !== undefined ? { latencyMs: record.latencyMs } : {}),
    };
    const result = this.pending.then(() => this.store.append(event));
    this.pending = result.then(() => undefined, () => undefined);
    return result;
  }

  record(record: LogRecord): void {
    void this.append(record).catch((error) => console.error("Side Agent log write failed", error));
  }

  async appendMessage(message: ConversationMessage, runId?: string): Promise<void> {
    await this.append({ category: "conversation", type: "conversation.message", runId, content: message });
  }

  async appendContext(ids: readonly string[], runId?: string): Promise<void> {
    await this.append({ category: "conversation", type: "conversation.context", runId, content: { ids: [...ids] } });
  }

  async messages(): Promise<ConversationMessage[]> {
    await this.pending;
    return rebuildConversation(await this.store.all());
  }

  async list(query?: LogQuery): Promise<LogEvent[]> {
    await this.pending;
    return this.store.list(query);
  }

  async all(): Promise<LogEvent[]> {
    await this.pending;
    return this.store.all();
  }

  async clear(): Promise<void> {
    await this.store.clear();
  }

  async flush(): Promise<void> {
    await this.pending;
  }
}
