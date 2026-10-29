import type { JsonValue } from "./types";

export type LogEvent = {
  id: number;
  type: string;
  timestamp: string;
  /** Version of the value encoding, separate from user-controlled payloads. */
  valueEncoding?: 2 | 3;
  content: JsonValue;
  conversationId?: string;
  runId?: string;
  parentId?: string | null;
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
  conversationId?: string;
  runId?: string;
  parentId?: string | null;
  toolCallId?: string;
  /** Recovery already has the durable, phase-qualified ID. Do not qualify it again. */
  toolCallIdCanonical?: boolean;
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
  get?(id: number): Promise<LogEvent | undefined>;
  getMany?(ids: readonly number[]): Promise<Array<LogEvent | undefined>>;
  latestByType?(type: string): Promise<LogEvent | undefined>;
  appendMany?(events: readonly Omit<LogEvent, "id">[]): Promise<LogEvent[]>;
  all(): Promise<LogEvent[]>;
  byTypes?(types: readonly string[], conversationId?: string, afterId?: number, limit?: number): Promise<LogEvent[]>;
  diagnosticsByCapture?(conversationId: string, tabId: number, epoch: string, afterId: number): Promise<LogEvent[]>;
  byRunTypes?(runIds: readonly string[], types: readonly string[], afterId?: number): Promise<LogEvent[]>;
  conversation?(conversationId: string, afterId?: number): Promise<LogEvent[]>;
  /** Legacy test capability; canonical runtime never invokes destructive clearing. */
  clear?(): Promise<void>;
};

const DB_NAME = "side-agent-runtime";
const DB_VERSION = 9;
const EVENT_STORE = "events";
const DIAGNOSTIC_INDEX_STORE = "diagnosticCaptureIndex";
const CONVERSATION_INDEX = "conversationId";
const TYPE_INDEX = "type";
const CONVERSATION_TYPE_INDEX = "conversationType";
const RUN_TYPE_INDEX = "runType";
const OBSOLETE_ID_INDEXES = ["typeId", "conversationTypeId", "runTypeId", "conversationIdId"] as const;
const SUMMARY_EVENT_TYPES = [
  "conversation.created",
  "conversation.selected",
  "conversation.title.updated",
  // Keep historical archive events readable without maintaining archive state.
  "conversation.archived",
  "conversation.unarchived",
  "conversation.submitted",
  "conversation.finished",
  "conversation.failed",
  "conversation.aborted",
  "conversation.deleted",
  "conversation.restored",
  "conversation.followup.queued",
  "conversation.followup.dispatched",
  "conversation.followup.removed",
  "model.title.started",
  "model.title.finished",
  "model.title.failed",
  "model.title.aborted",
] as const;
const RUN_EVENT_TYPES = ["conversation.submitted", "conversation.finished", "conversation.failed", "conversation.aborted"] as const;
const FOLLOWUP_EVENT_TYPES = [
  "conversation.followup.queued",
  "conversation.followup.dispatched",
  "conversation.followup.removed",
] as const;
const CONTEXT_EVENT_TYPES = ["context.compacted", "context.estimate.calibrated", "context.prompt.updated"] as const;

export function upgradeEventStore(db: IDBDatabase, transaction: IDBTransaction): void {
  const store = db.objectStoreNames.contains(EVENT_STORE)
    ? transaction.objectStore(EVENT_STORE)
    : db.createObjectStore(EVENT_STORE, { keyPath: "id", autoIncrement: true });
  if (!store.indexNames.contains(CONVERSATION_INDEX)) store.createIndex(CONVERSATION_INDEX, CONVERSATION_INDEX);
  if (!store.indexNames.contains(TYPE_INDEX)) store.createIndex(TYPE_INDEX, TYPE_INDEX);
  if (!store.indexNames.contains(CONVERSATION_TYPE_INDEX)) {
    store.createIndex(CONVERSATION_TYPE_INDEX, [CONVERSATION_INDEX, TYPE_INDEX]);
  }
  if (!store.indexNames.contains(RUN_TYPE_INDEX)) store.createIndex(RUN_TYPE_INDEX, ["runId", TYPE_INDEX]);
  // Version 7 added four compound indexes over the append-only event payloads.
  // Rebuilding them could exhaust a Side Panel renderer when a development
  // profile had accumulated a large log. The existing indexes already order
  // duplicate keys by primary key, so cursor seeking provides the same range
  // reads without copying every historical event during an upgrade.
  for (const name of OBSOLETE_ID_INDEXES) if (store.indexNames.contains(name)) store.deleteIndex(name);
  // New captures are ephemeral and cannot survive an extension reload, so an
  // empty index is sufficient for old databases: no expensive backfill or
  // scan of historical event payloads is needed during the upgrade.
  if (!db.objectStoreNames.contains(DIAGNOSTIC_INDEX_STORE)) db.createObjectStore(DIAGNOSTIC_INDEX_STORE);
}

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

function indexEventsAfter(index: IDBIndex, key: IDBValidKey, afterId: number, limit = Infinity): Promise<LogEvent[]> {
  return new Promise((resolve, reject) => {
    const events: LogEvent[] = [];
    const request = index.openCursor(IDBKeyRange.only(key));
    let sought = afterId < 0;
    request.onerror = () => reject(request.error ?? new Error("IndexedDB cursor failed"));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) { resolve(events); return; }
      if (!sought) {
        sought = true;
        const nextId = Math.min(Number.MAX_SAFE_INTEGER, afterId + 1);
        if (Number(cursor.primaryKey) < nextId) {
          cursor.continuePrimaryKey(key, nextId);
          return;
        }
      }
      if (Number(cursor.primaryKey) > afterId) events.push(cursor.value as LogEvent);
      if (events.length >= limit) { resolve(events); return; }
      cursor.continue();
    };
  });
}

class IndexedDbEventStore implements EventStore {
  private dbPromise?: Promise<IDBDatabase>;

  private open(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    if (typeof indexedDB === "undefined") return Promise.reject(new Error("IndexedDB is unavailable"));

    this.dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => upgradeEventStore(request.result, request.transaction!);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    });
    return this.dbPromise;
  }

  async append(event: Omit<LogEvent, "id">): Promise<LogEvent> {
    return (await this.appendMany([event]))[0]!;
  }

  async get(id: number): Promise<LogEvent | undefined> {
    const db = await this.open();
    const transaction = db.transaction(EVENT_STORE, "readonly");
    const event = await requestResult<LogEvent | undefined>(transaction.objectStore(EVENT_STORE).get(id));
    await transactionDone(transaction);
    return event;
  }

  async getMany(ids: readonly number[]): Promise<Array<LogEvent | undefined>> {
    if (!ids.length) return [];
    const db = await this.open();
    const transaction = db.transaction(EVENT_STORE, "readonly");
    const done = transactionDone(transaction);
    const store = transaction.objectStore(EVENT_STORE);
    const events = await Promise.all(ids.map((id) => requestResult<LogEvent | undefined>(store.get(id))));
    await done;
    return events;
  }

  async latestByType(type: string): Promise<LogEvent | undefined> {
    const db = await this.open();
    const transaction = db.transaction(EVENT_STORE, "readonly");
    const done = transactionDone(transaction);
    const cursor = await requestResult(transaction.objectStore(EVENT_STORE).index(TYPE_INDEX).openCursor(IDBKeyRange.only(type), "prev"));
    const event = cursor?.value as LogEvent | undefined;
    await done;
    return event;
  }

  async appendMany(events: readonly Omit<LogEvent, "id">[]): Promise<LogEvent[]> {
    const db = await this.open();
    const transaction = db.transaction([EVENT_STORE, DIAGNOSTIC_INDEX_STORE], "readwrite");
    const done = transactionDone(transaction);
    const store = transaction.objectStore(EVENT_STORE);
    try {
      const ids = await Promise.all(events.map((event) => requestResult<IDBValidKey>(store.add(event))));
      const diagnosticIndex = transaction.objectStore(DIAGNOSTIC_INDEX_STORE);
      for (const [index, event] of events.entries()) {
        const decoded = fromLogValue(event.content, event.valueEncoding);
        const content = decoded && typeof decoded === "object" && !Array.isArray(decoded) ? decoded as Record<string, unknown> : undefined;
        if (event.type === "browser.diagnostic" && typeof event.conversationId === "string" && typeof content?.tabId === "number" && typeof content.epoch === "string") {
          const id = Number(ids[index]);
          diagnosticIndex.put(id, [event.conversationId, content.tabId, content.epoch, id]);
        }
      }
      await done;
      return events.map((event, index) => ({ ...event, id: Number(ids[index]) }));
    } catch (error) {
      // A synchronous key/clone error must not leave canonical events written
      // without their corresponding diagnostic index entries.
      try { transaction.abort(); } catch { /* Transaction may already have aborted. */ }
      await done.catch(() => undefined);
      throw error;
    }
  }

  async all(): Promise<LogEvent[]> {
    const db = await this.open();
    const transaction = db.transaction(EVENT_STORE, "readonly");
    const events = await requestResult<LogEvent[]>(transaction.objectStore(EVENT_STORE).getAll());
    await transactionDone(transaction);
    return events.sort((left, right) => left.id - right.id);
  }

  async byTypes(types: readonly string[], conversationId?: string, afterId = -1, limit = Infinity): Promise<LogEvent[]> {
    const db = await this.open();
    const transaction = db.transaction(EVENT_STORE, "readonly");
    const done = transactionDone(transaction);
    const index = transaction.objectStore(EVENT_STORE).index(conversationId ? CONVERSATION_TYPE_INDEX : TYPE_INDEX);
    const batches = await Promise.all(types.map((type) => indexEventsAfter(index, conversationId ? [conversationId, type] : type, afterId, limit)));
    await done;
    return batches.flat().sort((left, right) => left.id - right.id).slice(0, limit);
  }

  async byRunTypes(runIds: readonly string[], types: readonly string[], afterId = -1): Promise<LogEvent[]> {
    const db = await this.open();
    const transaction = db.transaction(EVENT_STORE, "readonly");
    const done = transactionDone(transaction);
    const index = transaction.objectStore(EVENT_STORE).index(RUN_TYPE_INDEX);
    const batches = await Promise.all(runIds.flatMap((runId) => types.map((type) =>
      indexEventsAfter(index, [runId, type], afterId))));
    await done;
    return batches.flat().sort((left, right) => left.id - right.id);
  }

  async diagnosticsByCapture(conversationId: string, tabId: number, epoch: string, afterId: number): Promise<LogEvent[]> {
    const db = await this.open();
    const transaction = db.transaction([EVENT_STORE, DIAGNOSTIC_INDEX_STORE], "readonly");
    const done = transactionDone(transaction);
    const range = IDBKeyRange.bound([conversationId, tabId, epoch, Math.max(0, afterId + 1)], [conversationId, tabId, epoch, Number.MAX_SAFE_INTEGER]);
    const ids = await requestResult<number[]>(transaction.objectStore(DIAGNOSTIC_INDEX_STORE).getAll(range));
    const events = await Promise.all(ids.map((id) => requestResult<LogEvent | undefined>(transaction.objectStore(EVENT_STORE).get(id))));
    await done;
    return events.filter((event): event is LogEvent => Boolean(event));
  }

  async conversation(conversationId: string, afterId = -1): Promise<LogEvent[]> {
    const db = await this.open();
    const transaction = db.transaction(EVENT_STORE, "readonly");
    const events = await indexEventsAfter(transaction.objectStore(EVENT_STORE).index(CONVERSATION_INDEX), conversationId, afterId);
    await transactionDone(transaction);
    return events.sort((left, right) => left.id - right.id);
  }

}

let sharedStore: EventStore | undefined;
const TERMINAL_EVENT_TYPES = ["tool.finished", "tool.failed", "conversation.finished", "conversation.failed", "conversation.aborted"];
let localTerminalWrite: Promise<unknown> = Promise.resolve();
let localJobStateWrite: Promise<unknown> = Promise.resolve();

function terminalKey(event: Pick<LogEvent, "type" | "runId" | "toolCallId" | "content" | "valueEncoding">): string | undefined {
  if (!event.runId || !TERMINAL_EVENT_TYPES.includes(event.type)) return undefined;
  if (event.type.startsWith("conversation.")) return JSON.stringify(["run", event.runId]);
  if (!event.toolCallId) return undefined;
  const content = fromLogValue(event.content, event.valueEncoding) as { callId?: unknown } | null;
  return JSON.stringify(["tool", event.runId, content?.callId ?? "", event.toolCallId]);
}

function withTerminalWriteLock<T>(write: () => Promise<T>): Promise<T> {
  if (typeof navigator !== "undefined" && navigator.locks) return navigator.locks.request("surf-wax:terminal-log", write);
  // Tests and environments without Web Locks still serialize all local writers.
  const task = localTerminalWrite.then(write, write);
  localTerminalWrite = task.catch(() => undefined);
  return task;
}

function withJobStateWriteLock<T>(write: () => Promise<T>, allowLocalFallback: boolean): Promise<T> {
  if (typeof navigator !== "undefined" && navigator.locks) return navigator.locks.request("surf-wax:job-state-log", write);
  if (!allowLocalFallback || (typeof chrome !== "undefined" && Boolean(chrome.runtime?.id))) {
    return Promise.reject(new Error("Web Locks are required for cross-context job state and log clearing"));
  }
  const task = localJobStateWrite.then(write, write);
  localJobStateWrite = task.catch(() => undefined);
  return task;
}

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

const RESERVED_LOG_TYPES = new Set(["undefined", "number", "bigint", "symbol", "function", "circular-reference", "error", "date", "array-buffer", "typed-array", "map", "set", "escaped-object", "sparse-array"]);

export function toLogValue(value: unknown, active = new WeakSet<object>(), version?: 2 | 3): JsonValue {
  if (value === null) return null;
  if (value === undefined) return { $type: "undefined", value: null };
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return version !== undefined && Object.is(value, -0) ? { $type: "number", value: "-0" }
    : Number.isFinite(value) ? value : { $type: "number", value: String(value) };
  if (typeof value === "bigint") return { $type: "bigint", value: value.toString() };
  if (typeof value === "symbol") return { $type: "symbol", value: String(value) };
  if (typeof value === "function") return { $type: "function", value: value.name || "anonymous" };
  if (active.has(value)) return { $type: "circular-reference", value: "$" };

  active.add(value);
  try {
    if (value instanceof Error) {
      const details: Record<string, JsonValue> = { $type: "error", name: value.name, message: value.message, stack: value.stack ?? null };
      for (const key of ["statusCode", "status", "responseBody", "responseText", "headers", "requestId", "data", "cause", "providerMetadata"]) {
        try {
          const item = (value as unknown as Record<string, unknown>)[key];
          if (item !== undefined) details[key] = item instanceof Headers ? toLogValue(Object.fromEntries(item.entries()), active, version) : toLogValue(item, active, version);
        } catch { /* Ignore throwing provider error getters. */ }
      }
      for (const [key, item] of Object.entries(value)) if (!(key in details)) details[key] = toLogValue(item, active, version);
      return details;
    }
    if (value instanceof Date) return { $type: "date", value: Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString() };
    if (value instanceof ArrayBuffer) return { $type: "array-buffer", byteLength: value.byteLength, base64: bytesToBase64(new Uint8Array(value)) };
    if (ArrayBuffer.isView(value)) {
      const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      return { $type: "typed-array", name: value.constructor.name, byteLength: value.byteLength, base64: bytesToBase64(bytes) };
    }
    if (value instanceof Map) return { $type: "map", entries: [...value].map(([key, item]) => [toLogValue(key, active, version), toLogValue(item, active, version)]) };
    if (value instanceof Set) return { $type: "set", values: [...value].map((item) => toLogValue(item, active, version)) };
    if (Array.isArray(value)) {
      if (version === 3 && value.length >= 32768) {
        const keys = Object.getOwnPropertyNames(value).filter((key) => /^(?:0|[1-9]\d*)$/.test(key) && Number(key) < value.length);
        if (keys.length < value.length * 0.8) return { $type: "sparse-array", length: value.length,
          entries: keys.map((key) => [Number(key), toLogValue(value[Number(key)], active, version)]) };
      }
      return value.map((item) => toLogValue(item, active, version));
    }

    const entries = Object.entries(value).map(([key, item]) => [key, toLogValue(item, active, version)] as const);
    const tag = entries.find(([key]) => key === "$type")?.[1];
    if (version !== undefined && typeof tag === "string" && RESERVED_LOG_TYPES.has(tag))
      return { $type: "escaped-object", entries: entries.map(([key, item]) => [key, item]) };
    return Object.fromEntries(entries);
  } finally {
    active.delete(value);
  }
}

export function fromLogValue(value: unknown, version?: 2 | 3): unknown {
  if (Array.isArray(value)) return value.map((item) => fromLogValue(item, version));
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (version !== undefined && record.$type === "escaped-object") {
    if (Object.keys(record).length !== 2 || !Array.isArray(record.entries)
      || record.entries.some((entry) => !Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string")
      || new Set(record.entries.map((entry) => entry[0])).size !== record.entries.length)
      throw new Error("Invalid escaped log object");
    return Object.fromEntries(record.entries.map(([key, item]) => [key, fromLogValue(item, version)]));
  }
  if (version === 3 && record.$type === "sparse-array") {
    if (Object.keys(record).length !== 3 || !Number.isSafeInteger(record.length) || Number(record.length) < 0 || Number(record.length) > 0xffff_ffff || !Array.isArray(record.entries)) throw new Error("Invalid encoded sparse array");
    const result = new Array(Number(record.length));
    let previous = -1;
    for (const entry of record.entries) {
      if (!Array.isArray(entry) || entry.length !== 2 || !Number.isSafeInteger(entry[0]) || entry[0] <= previous || entry[0] >= result.length) throw new Error("Invalid encoded sparse array entry");
      previous = entry[0]; result[entry[0]] = fromLogValue(entry[1], version);
    }
    return result;
  }
  if (version !== undefined && Object.keys(record).length === 2 && record.$type === "number") {
    if (record.value === "NaN") return NaN;
    if (record.value === "Infinity") return Infinity;
    if (record.value === "-Infinity") return -Infinity;
    if (record.value === "-0") return -0;
    throw new Error("Invalid encoded log number");
  }
  if (version !== undefined && Object.keys(record).length === 2 && record.$type === "bigint") {
    if (typeof record.value !== "string" || !/^-?(?:0|[1-9]\d*)$/.test(record.value)) throw new Error("Invalid encoded log bigint");
    return BigInt(record.value);
  }
  if (record.$type === "undefined" && record.value === null && Object.keys(record).length === 2) return undefined;
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, fromLogValue(item, version)]));
}

/** Keep ordinary JSON byte-for-byte stable; encode JavaScript-only numbers without collisions. */
export function stringifyLogSafe(value: unknown, space?: number): string | undefined {
  let hasSpecial = false;
  const ordinary = JSON.stringify(value, (_key, item) => {
    if (typeof item === "bigint" || typeof item === "number" && (!Number.isFinite(item) || Object.is(item, -0))) {
      hasSpecial = true; return null;
    }
    return item;
  }, space);
  if (!hasSpecial) return ordinary;
  return `[Surf Wax log value encoding v2]\n${JSON.stringify(toLogValue(value, undefined, 2), null, space)}`;
}

export function isConversationMessage(value: unknown): value is ConversationMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const message = value as Partial<ConversationMessage>;
  return typeof message.id === "string"
    && (message.role === "system" || message.role === "user" || message.role === "assistant")
    && Array.isArray(message.parts);
}

export function rebuildConversation(events: readonly LogEvent[]): ConversationMessage[] {
  return events.flatMap((event) => {
    if (event.type !== "conversation.message") return [];
    const message = fromLogValue(event.content, event.valueEncoding);
    return isConversationMessage(message) ? [message] : [];
  });
}

export type ConversationSummary = {
  id: string;
  title: string;
  runStatus: "idle" | "running" | "interrupted";
  createdAt: string;
  lastMessageAt: string;
};

export class ConversationListProjection {
  private conversations = new Map<string, ConversationSummary>();
  private deleted = new Set<string>();

  reset(events: readonly LogEvent[]): ConversationSummary[] {
    this.conversations.clear(); this.deleted.clear();
    for (const event of events) this.apply(event);
    return this.snapshot();
  }

  apply(event: LogEvent): boolean {
    if (!event.conversationId) return false;
    if (event.type === "conversation.created") {
      const content = fromLogValue(event.content, event.valueEncoding) as { title?: unknown };
      this.conversations.set(event.conversationId, { id: event.conversationId,
        title: typeof content?.title === "string" && content.title.trim() ? content.title : "新对话",
        runStatus: "idle", createdAt: event.timestamp, lastMessageAt: event.timestamp });
      return true;
    }
    const conversation = this.conversations.get(event.conversationId);
    if (!conversation) return false;
    if (event.type === "conversation.deleted") { this.deleted.add(event.conversationId); return true; }
    if (event.type === "conversation.restored") { this.deleted.delete(event.conversationId); return true; }
    if (event.type !== "conversation.selected") conversation.lastMessageAt = event.timestamp;
    if (event.type === "conversation.title.updated") {
      const content = fromLogValue(event.content, event.valueEncoding) as { title?: unknown };
      if (typeof content?.title === "string" && content.title.trim()) conversation.title = content.title.trim();
    }
    if (event.type === "conversation.submitted") conversation.runStatus = "running";
    if (event.type === "conversation.finished") conversation.runStatus = "idle";
    if (event.type === "conversation.aborted" || event.type === "conversation.failed") conversation.runStatus = "interrupted";
    return true;
  }

  snapshot(): ConversationSummary[] {
    return [...this.conversations.values()].filter(({ id }) => !this.deleted.has(id))
      .sort((left, right) => right.lastMessageAt.localeCompare(left.lastMessageAt));
  }
}

export function rebuildConversationList(events: readonly LogEvent[]): ConversationSummary[] {
  return new ConversationListProjection().reset(events);
}

export function selectedConversationId(events: readonly LogEvent[]): string | undefined {
  const ids = new Set(rebuildConversationList(events).map(({ id }) => id));
  return [...events].reverse().find((event) => event.type === "conversation.selected" && event.conversationId && ids.has(event.conversationId))?.conversationId;
}

export type ConversationRepository = {
  headId: string | null;
  messages: Array<{ parentId: string | null; message: ConversationMessage }>;
};

export function selectedHeadId(
  events: readonly LogEvent[],
  stored: Map<string, { eventId: number }>,
): string | null {
  const createdAt = new Map<string, number>();
  for (const event of events) {
    if (event.type !== "conversation.message") continue;
    const raw = event.content;
    const content = event.valueEncoding !== undefined && raw && typeof raw === "object" && !Array.isArray(raw) && raw.$type === "escaped-object"
      ? fromLogValue(raw, event.valueEncoding) : raw;
    const id = content && typeof content === "object" && !Array.isArray(content) ? (content as Record<string, unknown>).id : undefined;
    if (typeof id !== "string" || !stored.has(id)) continue;
    createdAt.set(id, Math.min(createdAt.get(id) ?? event.id, event.id));
  }
  const latest = [...stored].reduce<{ id: string | null; eventId: number }>(
    (head, [id, item]) => {
      const eventId = createdAt.get(id) ?? item.eventId;
      return eventId > head.eventId ? { id, eventId } : head;
    },
    { id: null, eventId: -1 },
  );
  // Only a new message node advances the head. A submitted run may fail or be
  // cancelled before creating one, and must not discard an explicit branch.
  // Updating an existing node only refreshes its contents.
  const selectionFloor = latest.eventId;
  for (const event of events) {
    if (event.type !== "conversation.branch.selected") continue;
    const content = fromLogValue(event.content, event.valueEncoding) as { headId?: unknown };
    if (typeof content?.headId === "string" && stored.has(content.headId) && event.id > selectionFloor && event.id > latest.eventId) {
      latest.id = content.headId;
      latest.eventId = event.id;
    }
  }
  return latest.id;
}

export function rebuildConversationRepository(events: readonly LogEvent[]): ConversationRepository {
  const stored = new Map<string, { eventId: number; firstEventId: number; parentId: string | null; message: ConversationMessage }>();
  for (const event of events) {
    if (event.type !== "conversation.message") continue;
    const message = fromLogValue(event.content, event.valueEncoding);
    if (!isConversationMessage(message)) continue;
    stored.set(message.id, { eventId: event.id, firstEventId: stored.get(message.id)?.firstEventId ?? event.id, parentId: event.parentId ?? null, message });
  }
  const messages = [...stored.values()].sort((left, right) => left.firstEventId - right.firstEventId).map(({ parentId, message }) => ({ parentId, message }));
  return { headId: selectedHeadId(events, stored), messages };
}

export class EventLogger {
  private pending: Promise<unknown> = Promise.resolve();
  private buffered: Omit<LogEvent, "id">[] = [];
  private bufferTimer: ReturnType<typeof setTimeout> | undefined;
  private activeRuns = new Map<string, string>();
  private phases = new Map<string, number>();
  private callOwners = new Map<string, { runId: string; phase: number | undefined }>();
  private accepting = true;
  private ready: Promise<void> = Promise.resolve();
  private generation: number | undefined = 0;
  private handshakePaused = false;
  private listeners = new Set<(event: LogEvent) => void>();

  constructor(private readonly options: {
    store?: EventStore;
    now?: () => Date;
    onError?: (error: unknown) => void;
    writerPort?: chrome.runtime.Port;
  } = {}) {
    if (options.writerPort || !options.store && typeof document !== "undefined" && typeof chrome !== "undefined" && chrome.runtime?.connect) {
      const port = options.writerPort ?? chrome.runtime.connect({ name: "surf-wax-log-writer" });
      this.generation = undefined;
      let ready!: () => void;
      this.ready = new Promise<void>((resolve) => { ready = resolve; });
      port.onDisconnect.addListener(() => {
        if (this.generation === undefined) this.handshakePaused = true;
        this.stop();
        ready();
        this.options.onError?.(new Error("后台日志连接已断开，请重新加载侧栏。"));
      });
      port.onMessage.addListener((message) => {
        if (message.type === "writer-error") {
          this.handshakePaused = true;
          this.stop();
          ready();
          this.options.onError?.(new Error(message.error || "后台初始化失败，请重新加载扩展后重试。"));
        }
        if (message.type === "writer-ready") {
          this.generation = message.generation;
          this.handshakePaused = Boolean(message.paused);
          if (message.paused) this.stop();
          ready();
        }
        if (message.type === "prepare-clear") {
          void import("./agent/coordinator").then(({ settleAllConversationWork }) => settleAllConversationWork("log-cleared"))
            .then(() => { this.stop(); return this.flush(); })
            .then(() => { this.generation = message.generation ?? (this.generation ?? 0) + 1; })
            .then(() => port.postMessage({ id: message.id, ok: true }), (error) => port.postMessage({ id: message.id, ok: false, error: String(error) }));
        }
        if (message.type === "clear-complete") {
          if (/\/(sidepanel|userscripts)\.html$/.test(location.pathname)) location.reload();
          else this.resume();
        }
        if (message.type === "clear-failed") this.resume();
      });
    }
  }

  beginRun(conversationId: string, runId: string): void {
    this.activeRuns.set(conversationId, runId);
  }

  setRunPhase(runId: string, phase: number): void { this.phases.set(runId, phase); }

  toolIdentity(conversationId: string, toolCallId: string): { runId?: string; toolCallId: string; toolCallIdCanonical: true } {
    const runId = this.activeRuns.get(conversationId);
    const phase = runId ? this.phases.get(runId) : undefined;
    return { runId, toolCallId: phase && phase > 0 ? `${phase}:${toolCallId}` : toolCallId, toolCallIdCanonical: true };
  }

  endRun(conversationId: string, runId?: string): void {
    if (!runId || this.activeRuns.get(conversationId) === runId) this.activeRuns.delete(conversationId);
    if (runId) this.phases.delete(runId);
  }

  private event(record: LogRecord): Omit<LogEvent, "id"> {
    const callId = record.content && typeof record.content === "object" && "callId" in record.content
      && typeof record.content.callId === "string" ? record.content.callId : undefined;
    let owner = callId ? this.callOwners.get(callId) : undefined;
    const run = record.runId ?? owner?.runId ?? (record.conversationId ? this.activeRuns.get(record.conversationId) : undefined);
    if (callId && run && (!owner || owner.runId !== run)) {
      owner = { runId: run, phase: this.phases.get(run) };
      this.callOwners.set(callId, owner);
      if (this.callOwners.size > 1024) this.callOwners.delete(this.callOwners.keys().next().value!);
    }
    const phase = owner && owner.runId === run ? owner.phase : run ? this.phases.get(run) : undefined;
    return {
      timestamp: (this.options.now?.() ?? new Date()).toISOString(),
      type: record.type,
      valueEncoding: 3,
      content: toLogValue(Object.hasOwn(record, "content") ? record.content : null, undefined, 3),
      ...(record.conversationId ? { conversationId: record.conversationId } : {}),
      ...(record.parentId !== undefined ? { parentId: record.parentId } : {}),
      ...(run ? { runId: run } : {}),
      ...(Object.hasOwn(record, "stopReason") ? { stopReason: toLogValue(record.stopReason, undefined, 3) } : {}),
      ...(Object.hasOwn(record, "usage") ? { usage: toLogValue(record.usage, undefined, 3) } : {}),
      ...(Object.hasOwn(record, "providerMetadata") ? { providerMetadata: toLogValue(record.providerMetadata, undefined, 3) } : {}),
      ...(record.toolCallId !== undefined ? { toolCallId: !record.toolCallIdCanonical && phase !== undefined && phase > 0 ? `${phase}:${record.toolCallId}` : record.toolCallId } : {}),
      ...(Object.hasOwn(record, "input") ? { input: toLogValue(record.input, undefined, 3) } : {}),
      ...(Object.hasOwn(record, "output") ? { output: toLogValue(record.output, undefined, 3) } : {}),
      ...(Object.hasOwn(record, "error") ? { error: toLogValue(record.error, undefined, 3) } : {}),
      ...(Object.hasOwn(record, "retry") ? { retry: toLogValue(record.retry, undefined, 3) } : {}),
      ...(Object.hasOwn(record, "abort") ? { abort: toLogValue(record.abort, undefined, 3) } : {}),
      ...(record.latencyMs !== undefined ? { latencyMs: record.latencyMs } : {}),
    };
  }

  private enqueue(events: readonly Omit<LogEvent, "id">[], expectedEpoch?: string, expectedJobStateId?: number): Promise<LogEvent[]> {
    const generation = this.generation;
    const task = this.pending.then(async () => {
      await this.ready;
      const store = this.options.store ?? getEventStore();
      const write = async () => {
        // Recheck after the cross-page lock: maintenance may have advanced while
        // this writer was waiting for another page's terminal transaction.
        if (generation === undefined ? this.handshakePaused : generation !== this.generation) return [];
        const floor = expectedEpoch === undefined ? undefined : await this.latestClearIdFresh(store);
        if (expectedEpoch !== undefined && JSON.stringify([this.generation ?? null, floor]) !== expectedEpoch) return [];
        if (expectedJobStateId !== undefined) {
          const requested = events[0];
          const jobId = (fromLogValue(requested?.content, requested?.valueEncoding) as { jobId?: unknown } | null)?.jobId;
          if (!requested?.conversationId || typeof jobId !== "string" || expectedJobStateId <= (floor ?? -1)) return [];
          const original = store.get ? await store.get(expectedJobStateId) : (await store.all()).find((event) => event.id === expectedJobStateId);
          if (!original || original.type !== "browser.job.state" || original.conversationId !== requested.conversationId
            || (fromLogValue(original.content, original.valueEncoding) as { jobId?: unknown } | null)?.jobId !== jobId) return [];
          let cursor = expectedJobStateId;
          while (true) {
            const rows = store.byTypes ? await store.byTypes(["browser.job.state"], requested.conversationId, cursor, 256)
              : (await store.all()).filter((event) => event.type === "browser.job.state" && event.conversationId === requested.conversationId && event.id > cursor);
            const newer = rows.filter((event) => event.id > cursor).sort((a, b) => a.id - b.id).slice(0, 256);
            if (newer.some((event) => (fromLogValue(event.content, event.valueEncoding) as { jobId?: unknown } | null)?.jobId === jobId)) return [];
            if (newer.length < 256) break;
            cursor = newer.at(-1)!.id;
          }
        }
        const runIds = [...new Set(events.filter((event) => terminalKey(event)).map((event) => event.runId!))];
        const terminalFloor = runIds.length ? floor ?? await this.latestClearIdFresh(store) : -1;
        const prior = runIds.length ? store.byRunTypes
          ? await store.byRunTypes(runIds, TERMINAL_EVENT_TYPES)
          : (await store.all()).filter((event) => event.runId && runIds.includes(event.runId) && TERMINAL_EVENT_TYPES.includes(event.type)) : [];
        const existing = new Map(prior.filter((event) => event.id > terminalFloor).map((event) => [terminalKey(event), event]));
        const accepted: Omit<LogEvent, "id">[] = [];
        const keys = new Set(existing.keys());
        for (const event of events) {
          const key = terminalKey(event);
          if (key && keys.has(key)) continue;
          if (key) keys.add(key);
          accepted.push(event);
        }
        const stored: LogEvent[] = [];
        if (accepted.length && store.appendMany) stored.push(...await store.appendMany(accepted));
        else for (const event of accepted) stored.push(await store.append(event));
        for (const event of stored) {
          for (const listener of this.listeners) listener(event);
        }
        // Return the accepted durable terminal to a competing callback, without
        // publishing a second event or replacing the original reason/result.
        for (const event of stored) { const key = terminalKey(event); if (key) existing.set(key, event); }
        const appended = new Map(accepted.map((event, index) => [event, stored[index]!]));
        return events.map((event) => terminalKey(event) ? existing.get(terminalKey(event)!)! : appended.get(event)!)
          .filter((event): event is LogEvent => Boolean(event));
      };
      const terminalWrite = () => events.some((event) => terminalKey(event)) ? withTerminalWriteLock(write) : write();
      return expectedEpoch !== undefined || events.some((event) => event.type === "browser.job.state" || event.type === "log.cleared")
        ? withJobStateWriteLock(terminalWrite, Boolean(this.options.store)) : terminalWrite();
    });
    this.pending = task.catch((error) => {
      this.options.onError?.(error);
      throw error;
    });
    // Retain the failed queue to block later writes; the caller owns the error.
    void this.pending.catch(() => undefined);
    return task;
  }

  private flushBuffer(): void {
    if (this.bufferTimer !== undefined) clearTimeout(this.bufferTimer);
    this.bufferTimer = undefined;
    if (this.buffered.length === 0) return;
    const events = this.buffered;
    this.buffered = [];
    void this.enqueue(events).catch((error) => {
      console.error("Side Agent event log write failed", error);
    });
  }

  append(record: LogRecord): Promise<LogEvent | undefined> {
    if (!this.accepting) return Promise.resolve(undefined);
    this.flushBuffer();
    return this.enqueue([this.event(record)]).then(([event]) => event);
  }

  /** Conditional append for recovery derived from a particular clear/writer epoch. */
  appendIfEpoch(record: LogRecord, epoch: string, expectedJobStateId?: number): Promise<LogEvent | undefined> {
    if (!this.accepting) return Promise.resolve(undefined);
    this.flushBuffer();
    return this.enqueue([this.event(record)], epoch, expectedJobStateId).then(([event]) => event);
  }

  /** Best-effort diagnostics only. State restoration must never depend on it. */
  telemetry(record: LogRecord): void {
    if (!this.accepting) return;
    this.buffered.push(this.event(record));
    this.bufferTimer ??= setTimeout(() => this.flushBuffer(), 16);
  }

  /** @deprecated Use append for canonical facts or telemetry for diagnostics. */
  record(record: LogRecord): void { this.telemetry(record); }

  async appendMessage(conversationId: string, message: ConversationMessage, options?: { runId?: string; parentId?: string | null }): Promise<void>;
  async appendMessage(message: ConversationMessage, runId?: string): Promise<void>;
  async appendMessage(
    conversationOrMessage: string | ConversationMessage,
    messageOrRunId: ConversationMessage | string | undefined,
    options: { runId?: string; parentId?: string | null } = {},
  ): Promise<void> {
    const legacy = typeof conversationOrMessage !== "string";
    const message = (legacy ? conversationOrMessage : messageOrRunId) as ConversationMessage;
    const saved = await this.append({
      type: "conversation.message",
      ...(legacy ? {} : { conversationId: conversationOrMessage }),
      runId: legacy && typeof messageOrRunId === "string" ? messageOrRunId : options.runId,
      parentId: options.parentId,
      content: message,
    });
    if (!saved) throw new DOMException("日志维护已阻止消息保存。", "AbortError");
  }

  async repository(conversationId: string): Promise<ConversationRepository> {
    return rebuildConversationRepository(await this.eventsByTypes(["conversation.message"], conversationId));
  }

  private async eventsByTypes(types: readonly string[], conversationId?: string): Promise<LogEvent[]> {
    return this.readCanonical((store, floor) => this.eventsByTypesAt(store, floor, types, conversationId));
  }

  private async eventsByTypesAt(store: EventStore, floor: number, types: readonly string[], conversationId?: string): Promise<LogEvent[]> {
    if (store.byTypes) return (await store.byTypes(types, conversationId, floor)).filter((event) => event.id > floor);
    return (await store.all()).filter((event) => event.id > floor && types.includes(event.type) && (!conversationId || event.conversationId === conversationId));
  }

  private async latestClearIdFresh(store: EventStore): Promise<number> {
    const latest = store.latestByType ? await store.latestByType("log.cleared")
      : store.byTypes ? (await store.byTypes(["log.cleared"])).at(-1)
      : (await store.all()).filter((event) => event.type === "log.cleared").at(-1);
    return latest?.id ?? -1;
  }

  /** A cross-writer clear may race any read; discard that read and retry. */
  private async readCanonicalSnapshot<T>(read: (store: EventStore, floor: number) => Promise<T>): Promise<{ value: T; epoch: string }> {
    while (true) {
      await this.flush();
      const store = this.options.store ?? getEventStore();
      const generation = this.generation;
      const floor = await this.latestClearIdFresh(store);
      const value = await read(store, floor);
      if (generation === this.generation && floor === await this.latestClearIdFresh(store)) return { value, epoch: JSON.stringify([generation ?? null, floor]) };
    }
  }

  private async readCanonical<T>(read: (store: EventStore, floor: number) => Promise<T>): Promise<T> {
    return (await this.readCanonicalSnapshot(read)).value;
  }

  summaryEvents(conversationId?: string): Promise<LogEvent[]> {
    return this.eventsByTypes(SUMMARY_EVENT_TYPES, conversationId);
  }

  contextEvents(conversationId: string): Promise<LogEvent[]> {
    return this.eventsByTypes(CONTEXT_EVENT_TYPES, conversationId);
  }

  diagnosticEvents(conversationId: string): Promise<LogEvent[]> {
    return this.eventsByTypes(["browser.diagnostic"], conversationId);
  }

  /** Diagnostic replay and its log epoch must be observed together. */
  diagnosticEventsSnapshot(conversationId: string, capture?: { tabId: number; epoch: string; afterId?: number }): Promise<{ value: LogEvent[]; epoch: string }> {
    return this.readCanonicalSnapshot(async (store, floor) => {
      const afterId = Math.max(floor, capture?.afterId ?? -1);
      if (capture && store.diagnosticsByCapture) return store.diagnosticsByCapture(conversationId, capture.tabId, capture.epoch, afterId);
      if (store.byTypes) return (await store.byTypes(["browser.diagnostic"], conversationId, afterId)).filter((event) => event.id > afterId);
      return (await store.all()).filter((event) => event.id > afterId && event.type === "browser.diagnostic" && event.conversationId === conversationId);
    });
  }

  /** Validate derived data against the current log-clear/writer epoch. */
  async canonicalEpoch(): Promise<string> {
    return (await this.readCanonicalSnapshot(async () => undefined)).epoch;
  }

  jobEvents(conversationId: string): Promise<LogEvent[]> {
    return this.eventsByTypes(["browser.job.state", "browser.job.progress"], conversationId);
  }

  /** Incremental, bounded reads of canonical job events. The epoch changes on log maintenance. */
  async jobEventsSince(conversationId: string, afterId: number, limit = 256): Promise<{ epoch: string; floor: number; events: LogEvent[]; hasMore: boolean }> {
    if (!Number.isSafeInteger(afterId) || afterId < -1 || !Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid job event cursor or limit");
    const types = ["browser.job.state", "browser.job.progress"];
    while (true) {
      await this.flush();
      const store = this.options.store ?? getEventStore();
      const generation = this.generation;
      const floor = await this.latestClearIdFresh(store);
      const start = Math.max(floor, afterId);
      const values = store.byTypes
        ? await store.byTypes(types, conversationId, start, limit + 1)
        : (await store.all()).filter((event) => event.id > start && event.conversationId === conversationId && types.includes(event.type));
      const nextFloor = await this.latestClearIdFresh(store);
      if (generation !== this.generation || floor !== nextFloor) continue;
      const events = values.filter((event) => event.id > start && event.conversationId === conversationId && types.includes(event.type))
        .sort((left, right) => left.id - right.id);
      return { epoch: JSON.stringify([generation ?? null, floor]), floor, events: events.slice(0, limit), hasMore: events.length > limit };
    }
  }

  /** Read a bounded page by canonical IDs; return null if log maintenance changed its epoch. */
  async jobEventsByIds(conversationId: string, ids: readonly number[], epoch: string): Promise<LogEvent[] | null> {
    if (ids.some((id) => !Number.isSafeInteger(id) || id < 1)) throw new Error("Invalid job event ID");
    await this.flush();
    const store = this.options.store ?? getEventStore();
    const generation = this.generation;
    const floor = await this.latestClearIdFresh(store);
    if (JSON.stringify([generation ?? null, floor]) !== epoch) return null;
    const values = store.getMany ? await store.getMany(ids) : store.get ? await Promise.all(ids.map((id) => store.get!(id)))
      : await store.all().then((all) => ids.map((id) => all.find((event) => event.id === id)));
    if (generation !== this.generation || floor !== await this.latestClearIdFresh(store)) return null;
    return values.map((event, index) => {
      if (!event || event.id !== ids[index] || event.id <= floor || event.conversationId !== conversationId
        || !["browser.job.state", "browser.job.progress"].includes(event.type)) throw new Error(`Job event ${ids[index]} is unavailable`);
      return event;
    });
  }

  inputStateEvents(): Promise<LogEvent[]> { return this.eventsByTypes(["browser.input.state"]); }

  modelUsageEvents(conversationId: string): Promise<LogEvent[]> {
    return this.eventsByTypes(["model.step.finished"], conversationId);
  }

  followupEvents(conversationId: string): Promise<LogEvent[]> {
    return this.eventsByTypes([...FOLLOWUP_EVENT_TYPES, ...RUN_EVENT_TYPES], conversationId);
  }

  messageEvents(): Promise<LogEvent[]> {
    return this.eventsByTypes(["conversation.message"]);
  }

  private async eventsByRunTypes(runIds: readonly string[], types: readonly string[]): Promise<LogEvent[]> {
    return this.readCanonical((store, floor) => this.eventsByRunTypesAt(store, floor, runIds, types));
  }

  private async eventsByRunTypesAt(store: EventStore, floor: number, runIds: readonly string[], types: readonly string[]): Promise<LogEvent[]> {
    if (store.byRunTypes) return (await store.byRunTypes(runIds, types, floor)).filter((event) => event.id > floor);
    return (await store.all()).filter((event) => event.id > floor && event.runId && runIds.includes(event.runId) && types.includes(event.type));
  }

  async restorationEvents(conversationId: string): Promise<LogEvent[]> {
    return this.readCanonical(async (store, floor) => {
      const lifecycle = await this.eventsByTypesAt(store, floor, [...RUN_EVENT_TYPES, "conversation.message", "conversation.branch.selected"], conversationId);
      const completed = new Set(lifecycle.filter((event) => event.type === "conversation.finished" && event.runId).map((event) => event.runId));
      const interrupted = [...new Set(lifecycle
        .filter((event) => (event.type === "conversation.failed" || event.type === "conversation.aborted")
          && event.runId
          && !completed.has(event.runId))
        .map((event) => event.runId!))];
      if (interrupted.length === 0) return lifecycle;
      const replay = await this.eventsByRunTypesAt(store, floor, interrupted, [
        "tool.started",
        "tool.finished",
        "tool.failed",
      ]);
      return [...lifecycle, ...replay].sort((left, right) => left.id - right.id);
    });
  }

  async messages(conversationId?: string): Promise<ConversationMessage[]> {
    if (conversationId) return (await this.repository(conversationId)).messages.map(({ message }) => message);
    return rebuildConversation(await this.eventsByTypes(["conversation.message"]));
  }

  async all(): Promise<LogEvent[]> {
    await this.flush();
    return (this.options.store ?? getEventStore()).all();
  }

  async result(id: number, selection: { path?: string | Array<string | number>; offset?: number; limit?: number } = {}, conversationId?: string): Promise<unknown> {
    if (!Number.isSafeInteger(id) || id < 1) throw new Error("Invalid result event ID");
    const event = await this.readCanonical(async (store, floor) => id > floor
      ? (store.get ? await store.get(id) : (await store.all()).find((item) => item.id === id)) : undefined);
    if (event?.type !== "tool.result.data" || conversationId !== undefined && event.conversationId !== conversationId) throw new Error(`Tool result ${id} is unavailable`);
    let value = fromLogValue(event.output, event.valueEncoding);
    const path = typeof selection.path === "string" ? [selection.path] : selection.path ?? [];
    if (!Array.isArray(path) || path.some((part) => typeof part !== "string" && (!Number.isSafeInteger(part) || part < 0)))
      throw new Error("Tool result path must contain only strings and nonnegative integer indices");
    for (const part of path) {
      if (value === null || typeof value !== "object" && typeof value !== "string" || !Object.hasOwn(Object(value), part))
        throw Object.assign(new Error(`Tool result ${id} has no path ${JSON.stringify(path)}`), { code: "result-path-not-found" });
      value = (value as any)[part];
    }
    if (selection.offset !== undefined || selection.limit !== undefined) {
      if (!Array.isArray(value) && typeof value !== "string") {
        const keys = value && typeof value === "object" ? Object.keys(value).slice(0, 16) : [];
        throw new Error(`offset/limit requires an array or string result${keys.length ? `; select one first with { path: [${JSON.stringify(keys[0])}], offset: 0, limit: 4000 }. Available keys: ${keys.join(", ")}` : ""}`);
      }
      const offset = Math.max(0, selection.offset ?? 0);
      const end = selection.limit === undefined ? undefined : offset + Math.max(0, selection.limit);
      if (Array.isArray(value)) {
        const array = value;
        // Array.prototype.slice scans every position, including holes. A native
        // artifact read can request an unbounded suffix of a huge sparse array.
        const index = (position: number) => Math.min(array.length, Math.max(0, Math.trunc(position) || 0));
        const first = index(offset), last = end === undefined ? array.length : index(end);
        if (last - first > 32768) {
          const keys = Object.getOwnPropertyNames(array).filter((key) => /^(?:0|[1-9]\d*)$/.test(key) && Number(key) < array.length);
          if (keys.length < array.length * 0.8) {
            const sliced = new Array(Math.max(0, last - first));
            for (const key of keys) {
              const position = Number(key);
              if (position >= first && position < last) sliced[position - first] = array[position];
            }
            value = sliced;
          } else value = array.slice(offset, end);
        } else value = array.slice(offset, end);
      } else value = value.slice(offset, end);
    }
    return value;
  }

  async conversation(conversationId: string): Promise<LogEvent[]> {
    return this.readCanonical(async (store, floor) => store.conversation
      ? (await store.conversation(conversationId, floor)).filter((event) => event.id > floor)
      : (await store.all()).filter((event) => event.id > floor && event.conversationId === conversationId));
  }

  async deleteConversation(conversationId: string): Promise<void> {
    await this.append({ type: "conversation.deleted", conversationId, content: null });
  }

  async restoreConversation(conversationId: string): Promise<void> {
    await this.append({ type: "conversation.restored", conversationId, content: null });
  }

  private async artifactForCall(event: LogEvent, events: readonly LogEvent[], source?: { store: EventStore; floor: number }): Promise<{ id: number } | undefined> {
    const store = source?.store ?? this.options.store ?? getEventStore();
    const floor = source?.floor ?? await this.latestClearIdFresh(store);
    let stored = [...events].reverse().find((item) => item.type === "tool.result.data" && item.toolCallId === event.toolCallId && item.id > event.id && item.id > floor
      && typeof (fromLogValue(item.content, item.valueEncoding) as { filename?: unknown } | null)?.filename === "string");
    const referenced = [...events].reverse().find(item => item.type === "browser.artifact.used" && item.toolCallId === event.toolCallId && item.id > event.id && item.id > floor);
    const referencedId = (fromLogValue(referenced?.content, referenced?.valueEncoding) as { artifactId?: number } | null)?.artifactId;
    if (!stored && Number.isSafeInteger(referencedId) && referencedId! > floor) {
      const saved = store.get ? await store.get(referencedId!) : (await store.all()).find(item => item.id === referencedId);
      if (saved?.type === "tool.result.data" && saved.conversationId === event.conversationId && typeof (fromLogValue(saved.content, saved.valueEncoding) as { filename?: unknown } | null)?.filename === "string") stored = saved;
    }
    const input = fromLogValue(event.input, event.valueEncoding) as { id?: number } | null;
    if (!stored && (fromLogValue(event.content, event.valueEncoding) as { toolName?: string })?.toolName === "artifact-save" && Number.isSafeInteger(input?.id) && input!.id! > floor) {
      const saved = store.get ? await store.get(input!.id!) : (await store.all()).find((item) => item.id === input!.id);
      if (saved?.type === "tool.result.data" && saved.conversationId === event.conversationId && typeof (fromLogValue(saved.content, saved.valueEncoding) as { filename?: unknown } | null)?.filename === "string") stored = saved;
    }
    return stored ? { id: stored.id, ...(fromLogValue(stored.content, stored.valueEncoding) as object) } : undefined;
  }

  async toolArtifact(conversationId: string, identity: { runId?: string; toolCallId: string }): Promise<{ id: number } | undefined> {
    if (!identity.runId) return undefined;
    return this.readCanonical(async (store, floor) => {
      const events = await this.eventsByRunTypesAt(store, floor, [identity.runId!], ["tool.started", "tool.result.data", "browser.artifact.used"]);
      const started = [...events].reverse().find((event) => event.type === "tool.started" && event.conversationId === conversationId && event.toolCallId === identity.toolCallId);
      return started ? this.artifactForCall(started, events, { store, floor }) : undefined;
    });
  }

  async closePendingTools(runId: string, conversationId: string, reason: unknown): Promise<void> {
    await this.closePendingToolsInEpoch(runId, conversationId, reason);
  }

  private async closePendingToolsInEpoch(runId: string, conversationId: string, reason: unknown, requiredEpoch?: string): Promise<boolean> {
    const snapshot = await this.readCanonicalSnapshot((store, floor) => this.eventsByRunTypesAt(store, floor, [runId], ["conversation.message", "tool.started", "tool.finished", "tool.failed", "tool.progress", "tool.result.data", "browser.artifact.used"]));
    if (requiredEpoch !== undefined && snapshot.epoch !== requiredEpoch) return false;
    const { value: events, epoch } = snapshot;
    const key = (event: LogEvent) => `${(fromLogValue(event.content, event.valueEncoding) as { callId?: string })?.callId ?? ""}\0${event.toolCallId}`;
    const terminal = new Set(events.filter((event) => ["tool.finished", "tool.failed"].includes(event.type)).map(key));
    for (const event of events) {
      if (event.type !== "tool.started" || !event.toolCallId || terminal.has(key(event))) continue;
      terminal.add(key(event));
      const progress = [...events].reverse().find((item) => item.type === "tool.progress" && item.toolCallId === event.toolCallId);
      const progressContent = progress ? fromLogValue(progress.content, progress.valueEncoding) as { nextIndex: number; steps: unknown[] } : undefined;
      const progressOutput = progress ? fromLogValue(progress.output, progress.valueEncoding) as { completed: unknown[]; elapsedMs: number } : undefined;
      const input = fromLogValue(event.input, event.valueEncoding) as { steps?: unknown[] } | undefined;
      const steps = progressContent?.steps ?? input?.steps;
      const index = progressContent?.nextIndex ?? 0;
      const completedAll = Boolean(steps && index === steps.length);
      const failure = { code: "interrupted", message: String(reason), effectUnknown: true };
      const artifact = await this.artifactForCall(event, events);
      const output = steps ? {
        ok: completedAll, completed: progressOutput?.completed ?? [],
        ...(completedAll ? {} : { error: failure, failed: { index, step: steps[index], error: failure }, notRun: steps.slice(index + 1) }),
        elapsedMs: progressOutput?.elapsedMs ?? 0,
      } : { ok: false, error: failure };
      const saved = await this.appendIfEpoch({ type: completedAll ? "tool.finished" : "tool.failed", conversationId, runId, toolCallId: event.toolCallId, toolCallIdCanonical: true,
        content: { ...((fromLogValue(event.content, event.valueEncoding) as object) ?? {}), status: completedAll ? "completed" : "interrupted", effectUnknown: !completedAll },
        input: fromLogValue(event.input, event.valueEncoding), output: { ...output, ...(artifact ? { artifact } : {}) },
        ...(completedAll ? {} : { error: failure, abort: { reason } }) }, epoch);
      if (!saved) return false;
    }
    const started = new Set(events.filter((event) => event.type === "tool.started" || event.type === "tool.finished" || event.type === "tool.failed").map((event) => event.toolCallId));
    const messages = new Map<string, ConversationMessage>();
    for (const event of events) if (event.type === "conversation.message") {
      const message = fromLogValue(event.content, event.valueEncoding);
      if (isConversationMessage(message)) messages.set(message.id, message);
    }
    // A complete response can contain several calls. Cancellation before their
    // execution still needs a terminal result for every accepted call.
    for (const message of messages.values()) for (const part of message.parts) {
      if (!part || typeof part !== "object" || !("toolCallId" in part) || !("state" in part)
        || typeof part.toolCallId !== "string" || !["input-available", "output-error"].includes(String(part.state)) || started.has(part.toolCallId)) continue;
      started.add(part.toolCallId);
      const input = "input" in part ? part.input : undefined;
      const toolName = "toolName" in part ? part.toolName : "type" in part ? String(part.type).slice(5) : undefined;
      const invalid = part.state === "output-error";
      const error = { code: invalid ? "invalid-tool-call" : "interrupted",
        message: invalid && "errorText" in part ? String(part.errorText) : "工具调用已中断，此操作未执行。", effectUnknown: false };
      const saved = await this.appendIfEpoch({ type: "tool.failed", conversationId, runId, toolCallId: part.toolCallId, toolCallIdCanonical: true,
        content: { toolName, status: invalid ? "failed" : "interrupted", effectUnknown: false }, input, output: { ok: false, error }, error,
        ...(invalid ? {} : { abort: { reason } }) }, epoch);
      if (!saved) return false;
    }
    return true;
  }

  async recoverDanglingRuns(activeRunIds: readonly string[] | (() => Promise<readonly string[]>) = [], reason = "owner-disconnected"): Promise<void> {
    const recover = async () => {
      const { value: events, epoch } = await this.readCanonicalSnapshot((store, floor) => this.eventsByTypesAt(store, floor, RUN_EVENT_TYPES));
      const terminal = new Set(events.filter((event) => event.runId && event.type !== "conversation.submitted").map((event) => event.runId));
      for (const event of events) {
        if (event.type !== "conversation.submitted" || !event.runId || !event.conversationId || terminal.has(event.runId)) continue;
        const owners = typeof activeRunIds === "function" ? await activeRunIds() : activeRunIds;
        if (owners.includes(event.runId)) continue;
        terminal.add(event.runId);
        if (!await this.closePendingToolsInEpoch(event.runId, event.conversationId, reason, epoch)) return;
        const saved = await this.appendIfEpoch({ type: "conversation.aborted", conversationId: event.conversationId, runId: event.runId,
          content: null, abort: { reason } }, epoch);
        if (!saved) return;
      }
    };
    if (typeof navigator !== "undefined" && navigator.locks) await navigator.locks.request("surf-wax:log-recovery", recover);
    else await recover();
  }

  async clear(): Promise<void> {
    await this.flush();
    const event = this.event({ type: "log.cleared", content: null });
    const [stored] = await this.enqueue([event]);
    if (!stored) throw new Error("Could not persist log clear");
  }

  resume(): void { this.accepting = true; }

  stop(): void {
    this.accepting = false;
    this.activeRuns.clear();
  }

  subscribe(listener: (event: LogEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async flush(): Promise<void> {
    this.flushBuffer();
    await this.ready;
    await this.pending;
  }
}
