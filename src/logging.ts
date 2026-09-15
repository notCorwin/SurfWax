import type { JsonValue } from "./types";

export type LogEvent = {
  id: number;
  type: string;
  timestamp: string;
  content: JsonValue;
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

export type LogRecord = {
  type: string;
  content?: unknown;
  runId?: string;
  toolCallId?: string;
  stopReason?: unknown;
  usage?: unknown;
  providerMetadata?: unknown;
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

type EventStore = {
  append(event: Omit<LogEvent, "id">): Promise<LogEvent>;
  all(): Promise<LogEvent[]>;
  clear(): Promise<void>;
};

const DB_NAME = "side-agent-runtime";
const DB_VERSION = 3;
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

class IndexedDbEventStore implements EventStore {
  private dbPromise?: Promise<IDBDatabase>;

  private open(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    if (typeof indexedDB === "undefined") return Promise.reject(new Error("IndexedDB is unavailable"));

    this.dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (db.objectStoreNames.contains(EVENT_STORE)) db.deleteObjectStore(EVENT_STORE);
        if (db.objectStoreNames.contains(LEGACY_EVENT_STORE)) db.deleteObjectStore(LEGACY_EVENT_STORE);
        db.createObjectStore(EVENT_STORE, { keyPath: "id", autoIncrement: true });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    });
    return this.dbPromise;
  }

  async append(event: Omit<LogEvent, "id">): Promise<LogEvent> {
    const db = await this.open();
    const transaction = db.transaction(EVENT_STORE, "readwrite");
    const id = await requestResult<IDBValidKey>(transaction.objectStore(EVENT_STORE).add(event));
    await transactionDone(transaction);
    return { ...event, id: Number(id) };
  }

  async all(): Promise<LogEvent[]> {
    const db = await this.open();
    const transaction = db.transaction(EVENT_STORE, "readonly");
    const events = await requestResult<LogEvent[]>(transaction.objectStore(EVENT_STORE).getAll());
    await transactionDone(transaction);
    return events.sort((left, right) => left.id - right.id);
  }

  async clear(): Promise<void> {
    const db = await this.open();
    const transaction = db.transaction(EVENT_STORE, "readwrite");
    transaction.objectStore(EVENT_STORE).clear();
    await transactionDone(transaction);
  }
}

let sharedStore: EventStore | undefined;

function getEventStore(): EventStore {
  sharedStore ??= new IndexedDbEventStore();
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
    if (value instanceof Error) {
      return { $type: "error", name: value.name, message: value.message, stack: value.stack ?? null };
    }
    if (value instanceof Date) return { $type: "date", value: Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString() };
    if (value instanceof ArrayBuffer) return { $type: "array-buffer", byteLength: value.byteLength, base64: bytesToBase64(new Uint8Array(value)) };
    if (ArrayBuffer.isView(value)) {
      const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      return { $type: "typed-array", name: value.constructor.name, byteLength: value.byteLength, base64: bytesToBase64(bytes) };
    }
    if (value instanceof Map) return { $type: "map", entries: [...value].map(([key, item]) => [toLogValue(key, active), toLogValue(item, active)]) };
    if (value instanceof Set) return { $type: "set", values: [...value].map((item) => toLogValue(item, active)) };
    if (Array.isArray(value)) return value.map((item) => toLogValue(item, active));

    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, toLogValue(item, active)]),
    );
  } finally {
    active.delete(value);
  }
}

function restoreLogValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(restoreLogValue);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (record.$type === "undefined" && record.value === null && Object.keys(record).length === 2) return undefined;
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, restoreLogValue(item)]));
}

function isConversationMessage(value: unknown): value is ConversationMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const message = value as Partial<ConversationMessage>;
  return typeof message.id === "string"
    && (message.role === "system" || message.role === "user" || message.role === "assistant")
    && Array.isArray(message.parts);
}

export function rebuildConversation(events: readonly LogEvent[]): ConversationMessage[] {
  return events.flatMap((event) => {
    if (event.type !== "conversation.message") return [];
    const message = restoreLogValue(event.content);
    return isConversationMessage(message) ? [message] : [];
  });
}

export class EventLogger {
  private pending: Promise<unknown> = Promise.resolve();
  private activeRunId?: string;
  private accepting = true;

  constructor(private readonly options: {
    store?: EventStore;
    now?: () => Date;
    onError?: (error: unknown) => void;
  } = {}) {}

  beginRun(runId: string): void {
    this.activeRunId = runId;
  }

  endRun(runId?: string): void {
    if (!runId || this.activeRunId === runId) this.activeRunId = undefined;
  }

  append(record: LogRecord): Promise<LogEvent | undefined> {
    if (!this.accepting) return Promise.resolve(undefined);
    const event: Omit<LogEvent, "id"> = {
      timestamp: (this.options.now?.() ?? new Date()).toISOString(),
      type: record.type,
      content: toLogValue(record.content ?? null),
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
    const task = this.pending.then(() => (this.options.store ?? getEventStore()).append(event));
    this.pending = task.catch((error) => {
      this.options.onError?.(error);
      throw error;
    });
    return task;
  }

  record(record: LogRecord): void {
    if (!this.accepting) return;
    void this.append(record).catch((error) => {
      console.error("Side Agent event log write failed", error);
    });
  }

  async appendMessage(message: ConversationMessage, runId?: string): Promise<void> {
    await this.append({ type: "conversation.message", runId, content: message });
  }

  async messages(): Promise<ConversationMessage[]> {
    await this.flush();
    return rebuildConversation(await (this.options.store ?? getEventStore()).all());
  }

  async all(): Promise<LogEvent[]> {
    await this.flush();
    return (this.options.store ?? getEventStore()).all();
  }

  async clear(): Promise<void> {
    await this.flush();
    await (this.options.store ?? getEventStore()).clear();
  }

  stop(): void {
    this.accepting = false;
    this.activeRunId = undefined;
  }

  async flush(): Promise<void> {
    await this.pending;
  }
}
