import type { JsonValue } from "./types";

export type LogEvent = {
  id: number;
  type: string;
  timestamp: string;
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
  appendMany?(events: readonly Omit<LogEvent, "id">[]): Promise<LogEvent[]>;
  all(): Promise<LogEvent[]>;
  byTypes?(types: readonly string[], conversationId?: string): Promise<LogEvent[]>;
  byRunTypes?(runIds: readonly string[], types: readonly string[]): Promise<LogEvent[]>;
  conversation?(conversationId: string): Promise<LogEvent[]>;
  deleteConversation?(conversationId: string): Promise<void>;
  clear(): Promise<void>;
};

const DB_NAME = "side-agent-runtime";
const DB_VERSION = 6;
const EVENT_STORE = "events";
const CONVERSATION_INDEX = "conversationId";
const TYPE_INDEX = "type";
const CONVERSATION_TYPE_INDEX = "conversationType";
const RUN_TYPE_INDEX = "runType";
const SUMMARY_EVENT_TYPES = [
  "conversation.created",
  "conversation.selected",
  "conversation.title.updated",
  "conversation.archived",
  "conversation.unarchived",
  "conversation.submitted",
  "conversation.finished",
  "conversation.failed",
  "conversation.aborted",
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
const CONTEXT_EVENT_TYPES = ["context.compacted", "context.estimate.calibrated"] as const;

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

  async appendMany(events: readonly Omit<LogEvent, "id">[]): Promise<LogEvent[]> {
    const db = await this.open();
    const transaction = db.transaction(EVENT_STORE, "readwrite");
    const done = transactionDone(transaction);
    const store = transaction.objectStore(EVENT_STORE);
    const ids = await Promise.all(events.map((event) => requestResult<IDBValidKey>(store.add(event))));
    await done;
    return events.map((event, index) => ({ ...event, id: Number(ids[index]) }));
  }

  async all(): Promise<LogEvent[]> {
    const db = await this.open();
    const transaction = db.transaction(EVENT_STORE, "readonly");
    const events = await requestResult<LogEvent[]>(transaction.objectStore(EVENT_STORE).getAll());
    await transactionDone(transaction);
    return events.sort((left, right) => left.id - right.id);
  }

  async byTypes(types: readonly string[], conversationId?: string): Promise<LogEvent[]> {
    const db = await this.open();
    const transaction = db.transaction(EVENT_STORE, "readonly");
    const done = transactionDone(transaction);
    const index = transaction.objectStore(EVENT_STORE).index(conversationId ? CONVERSATION_TYPE_INDEX : TYPE_INDEX);
    const batches = await Promise.all(types.map((type) => requestResult<LogEvent[]>(
      index.getAll(IDBKeyRange.only(conversationId ? [conversationId, type] : type)),
    )));
    await done;
    return batches.flat().sort((left, right) => left.id - right.id);
  }

  async byRunTypes(runIds: readonly string[], types: readonly string[]): Promise<LogEvent[]> {
    const db = await this.open();
    const transaction = db.transaction(EVENT_STORE, "readonly");
    const done = transactionDone(transaction);
    const index = transaction.objectStore(EVENT_STORE).index(RUN_TYPE_INDEX);
    const batches = await Promise.all(runIds.flatMap((runId) => types.map((type) =>
      requestResult<LogEvent[]>(index.getAll(IDBKeyRange.only([runId, type]))))));
    await done;
    return batches.flat().sort((left, right) => left.id - right.id);
  }

  async conversation(conversationId: string): Promise<LogEvent[]> {
    const db = await this.open();
    const transaction = db.transaction(EVENT_STORE, "readonly");
    const events = await requestResult<LogEvent[]>(transaction.objectStore(EVENT_STORE).index(CONVERSATION_INDEX).getAll(conversationId));
    await transactionDone(transaction);
    return events.sort((left, right) => left.id - right.id);
  }

  async deleteConversation(conversationId: string): Promise<void> {
    const db = await this.open();
    const transaction = db.transaction(EVENT_STORE, "readwrite");
    const store = transaction.objectStore(EVENT_STORE);
    const keys = await requestResult<IDBValidKey[]>(store.index(CONVERSATION_INDEX).getAllKeys(conversationId));
    for (const key of keys) store.delete(key);
    await transactionDone(transaction);
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

export function fromLogValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(fromLogValue);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (record.$type === "undefined" && record.value === null && Object.keys(record).length === 2) return undefined;
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, fromLogValue(item)]));
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
    const message = fromLogValue(event.content);
    return isConversationMessage(message) ? [message] : [];
  });
}

export type ConversationSummary = {
  id: string;
  title: string;
  status: "regular" | "archived";
  runStatus: "idle" | "running" | "interrupted";
  createdAt: string;
  lastMessageAt: string;
};

export function rebuildConversationList(events: readonly LogEvent[]): ConversationSummary[] {
  const conversations = new Map<string, ConversationSummary>();
  for (const event of events) {
    if (!event.conversationId) continue;
    if (event.type === "conversation.created") {
      const content = fromLogValue(event.content) as { title?: unknown };
      conversations.set(event.conversationId, {
        id: event.conversationId,
        title: typeof content?.title === "string" && content.title.trim() ? content.title : "新对话",
        status: "regular",
        runStatus: "idle",
        createdAt: event.timestamp,
        lastMessageAt: event.timestamp,
      });
      continue;
    }
    const conversation = conversations.get(event.conversationId);
    if (!conversation) continue;
    if (event.type !== "conversation.selected") conversation.lastMessageAt = event.timestamp;
    if (event.type === "conversation.title.updated") {
      const content = fromLogValue(event.content) as { title?: unknown };
      if (typeof content?.title === "string" && content.title.trim()) conversation.title = content.title.trim();
    }
    if (event.type === "conversation.archived") conversation.status = "archived";
    if (event.type === "conversation.unarchived") conversation.status = "regular";
    if (event.type === "conversation.submitted") conversation.runStatus = "running";
    if (event.type === "conversation.finished") conversation.runStatus = "idle";
    if (event.type === "conversation.aborted" || event.type === "conversation.failed") conversation.runStatus = "interrupted";
  }
  return [...conversations.values()].sort((left, right) => right.lastMessageAt.localeCompare(left.lastMessageAt));
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
  const latest = [...stored].reduce<{ id: string | null; eventId: number }>(
    (head, [id, item]) => item.eventId > head.eventId ? { id, eventId: item.eventId } : head,
    { id: null, eventId: -1 },
  );
  for (const event of events) {
    if (event.type !== "conversation.branch.selected") continue;
    const content = fromLogValue(event.content) as { headId?: unknown };
    if (typeof content?.headId === "string" && stored.has(content.headId) && event.id > latest.eventId) {
      latest.id = content.headId;
      latest.eventId = event.id;
    }
  }
  return latest.id;
}

export function rebuildConversationRepository(events: readonly LogEvent[]): ConversationRepository {
  const stored = new Map<string, { eventId: number; parentId: string | null; message: ConversationMessage }>();
  for (const event of events) {
    if (event.type !== "conversation.message") continue;
    const message = fromLogValue(event.content);
    if (!isConversationMessage(message)) continue;
    stored.set(message.id, { eventId: event.id, parentId: event.parentId ?? null, message });
  }
  const messages = [...stored.values()].sort((left, right) => left.eventId - right.eventId).map(({ parentId, message }) => ({ parentId, message }));
  return { headId: selectedHeadId(events, stored), messages };
}

export class EventLogger {
  private pending: Promise<unknown> = Promise.resolve();
  private buffered: Omit<LogEvent, "id">[] = [];
  private bufferTimer: ReturnType<typeof setTimeout> | undefined;
  private activeRuns = new Map<string, string>();
  private accepting = true;
  private listeners = new Set<(event: LogEvent) => void>();

  constructor(private readonly options: {
    store?: EventStore;
    now?: () => Date;
    onError?: (error: unknown) => void;
  } = {}) {}

  beginRun(conversationId: string, runId: string): void {
    this.activeRuns.set(conversationId, runId);
  }

  endRun(conversationId: string, runId?: string): void {
    if (!runId || this.activeRuns.get(conversationId) === runId) this.activeRuns.delete(conversationId);
  }

  private event(record: LogRecord): Omit<LogEvent, "id"> {
    return {
      timestamp: (this.options.now?.() ?? new Date()).toISOString(),
      type: record.type,
      content: toLogValue(record.content ?? null),
      ...(record.conversationId ? { conversationId: record.conversationId } : {}),
      ...(record.parentId !== undefined ? { parentId: record.parentId } : {}),
      ...(record.runId ?? (record.conversationId ? this.activeRuns.get(record.conversationId) : undefined) ? { runId: record.runId ?? this.activeRuns.get(record.conversationId!) } : {}),
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
  }

  private enqueue(events: readonly Omit<LogEvent, "id">[]): Promise<LogEvent[]> {
    const task = this.pending.then(async () => {
      const store = this.options.store ?? getEventStore();
      const stored: LogEvent[] = [];
      if (store.appendMany) stored.push(...await store.appendMany(events));
      else for (const event of events) stored.push(await store.append(event));
      for (const event of stored) for (const listener of this.listeners) listener(event);
      return stored;
    });
    this.pending = task.catch((error) => {
      this.options.onError?.(error);
      throw error;
    });
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

  record(record: LogRecord): void {
    if (!this.accepting) return;
    this.buffered.push(this.event(record));
    this.bufferTimer ??= setTimeout(() => this.flushBuffer(), 16);
  }

  async appendMessage(conversationId: string, message: ConversationMessage, options?: { runId?: string; parentId?: string | null }): Promise<void>;
  async appendMessage(message: ConversationMessage, runId?: string): Promise<void>;
  async appendMessage(
    conversationOrMessage: string | ConversationMessage,
    messageOrRunId: ConversationMessage | string | undefined,
    options: { runId?: string; parentId?: string | null } = {},
  ): Promise<void> {
    const legacy = typeof conversationOrMessage !== "string";
    const message = (legacy ? conversationOrMessage : messageOrRunId) as ConversationMessage;
    await this.append({
      type: "conversation.message",
      ...(legacy ? {} : { conversationId: conversationOrMessage }),
      runId: legacy && typeof messageOrRunId === "string" ? messageOrRunId : options.runId,
      parentId: options.parentId,
      content: message,
    });
  }

  async repository(conversationId: string): Promise<ConversationRepository> {
    return rebuildConversationRepository(await this.eventsByTypes(["conversation.message"], conversationId));
  }

  private async eventsByTypes(types: readonly string[], conversationId?: string): Promise<LogEvent[]> {
    await this.flush();
    const store = this.options.store ?? getEventStore();
    if (store.byTypes) return store.byTypes(types, conversationId);
    const events = conversationId && store.conversation
      ? await store.conversation(conversationId)
      : await store.all();
    return events.filter((event) => types.includes(event.type) && (!conversationId || event.conversationId === conversationId));
  }

  summaryEvents(conversationId?: string): Promise<LogEvent[]> {
    return this.eventsByTypes(SUMMARY_EVENT_TYPES, conversationId);
  }

  contextEvents(conversationId: string): Promise<LogEvent[]> {
    return this.eventsByTypes(CONTEXT_EVENT_TYPES, conversationId);
  }

  modelUsageEvents(conversationId: string): Promise<LogEvent[]> {
    return this.eventsByTypes(["model.finished"], conversationId);
  }

  followupEvents(conversationId: string): Promise<LogEvent[]> {
    return this.eventsByTypes([...FOLLOWUP_EVENT_TYPES, ...RUN_EVENT_TYPES], conversationId);
  }

  messageEvents(): Promise<LogEvent[]> {
    return this.eventsByTypes(["conversation.message"]);
  }

  private async eventsByRunTypes(runIds: readonly string[], types: readonly string[]): Promise<LogEvent[]> {
    await this.flush();
    const store = this.options.store ?? getEventStore();
    if (store.byRunTypes) return store.byRunTypes(runIds, types);
    const events = await store.all();
    return events.filter((event) => event.runId && runIds.includes(event.runId) && types.includes(event.type));
  }

  async restorationEvents(conversationId: string): Promise<LogEvent[]> {
    const lifecycle = await this.eventsByTypes([...RUN_EVENT_TYPES, "conversation.message", "conversation.branch.selected"], conversationId);
    const completed = new Set(lifecycle.filter((event) => event.type === "conversation.finished" && event.runId).map((event) => event.runId));
    const interrupted = [...new Set(lifecycle
      .filter((event) => (event.type === "conversation.failed" || event.type === "conversation.aborted")
        && event.runId
        && !completed.has(event.runId))
      .map((event) => event.runId!))];
    if (interrupted.length === 0) return lifecycle;
    const replay = await this.eventsByRunTypes(interrupted, [
      "conversation.stream.chunk",
      "tool.started",
      "tool.finished",
      "tool.failed",
    ]);
    return [...lifecycle, ...replay].sort((left, right) => left.id - right.id);
  }

  async messages(conversationId?: string): Promise<ConversationMessage[]> {
    if (conversationId) return (await this.repository(conversationId)).messages.map(({ message }) => message);
    return rebuildConversation(await this.all());
  }

  async all(): Promise<LogEvent[]> {
    await this.flush();
    return (this.options.store ?? getEventStore()).all();
  }

  async result(id: number, selection: { path?: string | Array<string | number>; offset?: number; limit?: number } = {}): Promise<unknown> {
    if (!Number.isSafeInteger(id) || id < 1) throw new Error("Invalid result event ID");
    await this.flush();
    const store = this.options.store ?? getEventStore();
    const event = store.get ? await store.get(id) : (await store.all()).find((item) => item.id === id);
    if (event?.type !== "tool.result.data") throw new Error(`Tool result ${id} is unavailable`);
    let value = fromLogValue(event.output);
    const path = typeof selection.path === "string" ? [selection.path] : selection.path ?? [];
    for (const part of path) {
      if (value === null || typeof value !== "object" && typeof value !== "string") throw new Error(`Tool result ${id} has no path ${path.join(".")}`);
      value = (value as any)[part];
    }
    if (selection.offset !== undefined || selection.limit !== undefined) {
      if (!Array.isArray(value) && typeof value !== "string") {
        const keys = value && typeof value === "object" ? Object.keys(value).slice(0, 16) : [];
        throw new Error(`offset/limit requires an array or string result${keys.length ? `; select one first with { path: [${JSON.stringify(keys[0])}], offset: 0, limit: 4000 }. Available keys: ${keys.join(", ")}` : ""}`);
      }
      const offset = Math.max(0, selection.offset ?? 0);
      value = value.slice(offset, selection.limit === undefined ? undefined : offset + Math.max(0, selection.limit));
    }
    return value;
  }

  async conversation(conversationId: string): Promise<LogEvent[]> {
    await this.flush();
    const store = this.options.store ?? getEventStore();
    return store.conversation
      ? store.conversation(conversationId)
      : (await store.all()).filter((event) => event.conversationId === conversationId);
  }

  async deleteConversation(conversationId: string): Promise<void> {
    await this.flush();
    const store = this.options.store ?? getEventStore();
    if (!store.deleteConversation) throw new Error("Event store cannot delete one conversation");
    await store.deleteConversation(conversationId);
    await this.append({ type: "conversation.deleted", content: { conversationId } });
  }

  async recoverDanglingRuns(): Promise<void> {
    const events = await this.eventsByTypes(RUN_EVENT_TYPES);
    const terminal = new Set(events.filter((event) => event.runId && ["conversation.finished", "conversation.failed", "conversation.aborted"].includes(event.type)).map((event) => event.runId));
    for (const event of events) {
      if (event.type !== "conversation.submitted" || !event.runId || !event.conversationId || terminal.has(event.runId)) continue;
      await this.append({
        type: "conversation.aborted",
        conversationId: event.conversationId,
        runId: event.runId,
        content: null,
        abort: { reason: "Side Panel 在运行完成前关闭。" },
      });
    }
  }

  async clear(): Promise<void> {
    await this.flush();
    await (this.options.store ?? getEventStore()).clear();
  }

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
    await this.pending;
  }
}
