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
const TERMINAL_EVENT_TYPES = ["tool.finished", "tool.failed", "conversation.finished", "conversation.failed", "conversation.aborted"];
let localTerminalWrite: Promise<unknown> = Promise.resolve();

function terminalKey(event: Pick<LogEvent, "type" | "runId" | "toolCallId" | "content">): string | undefined {
  if (!event.runId || !TERMINAL_EVENT_TYPES.includes(event.type)) return undefined;
  if (event.type.startsWith("conversation.")) return JSON.stringify(["run", event.runId]);
  if (!event.toolCallId) return undefined;
  const content = fromLogValue(event.content) as { callId?: unknown } | null;
  return JSON.stringify(["tool", event.runId, content?.callId ?? "", event.toolCallId]);
}

function withTerminalWriteLock<T>(write: () => Promise<T>): Promise<T> {
  if (typeof navigator !== "undefined" && navigator.locks) return navigator.locks.request("surf-wax:terminal-log", write);
  // Tests and environments without Web Locks still serialize all local writers.
  const task = localTerminalWrite.then(write, write);
  localTerminalWrite = task.catch(() => undefined);
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
      const details: Record<string, JsonValue> = { $type: "error", name: value.name, message: value.message, stack: value.stack ?? null };
      for (const key of ["statusCode", "status", "responseBody", "responseText", "headers", "requestId", "data", "cause", "providerMetadata"]) {
        try {
          const item = (value as unknown as Record<string, unknown>)[key];
          if (item !== undefined) details[key] = item instanceof Headers ? toLogValue(Object.fromEntries(item.entries()), active) : toLogValue(item, active);
        } catch { /* Ignore throwing provider error getters. */ }
      }
      for (const [key, item] of Object.entries(value)) if (!(key in details)) details[key] = toLogValue(item, active);
      return details;
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
  const createdAt = new Map<string, number>();
  for (const event of events) {
    if (event.type !== "conversation.message") continue;
    const id = event.content && typeof event.content === "object" && !Array.isArray(event.content) ? event.content.id : undefined;
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
  // New message nodes and submitted runs advance the head. Updating an existing
  // node only refreshes its contents, so a late snapshot cannot undo a branch.
  const submittedAt = events.reduce((id, event) => event.type === "conversation.submitted" ? Math.max(id, event.id) : id, -1);
  const selectionFloor = Math.max(submittedAt, latest.eventId);
  for (const event of events) {
    if (event.type !== "conversation.branch.selected") continue;
    const content = fromLogValue(event.content) as { headId?: unknown };
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
    const message = fromLogValue(event.content);
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
      content: toLogValue(record.content ?? null),
      ...(record.conversationId ? { conversationId: record.conversationId } : {}),
      ...(record.parentId !== undefined ? { parentId: record.parentId } : {}),
      ...(run ? { runId: run } : {}),
      ...(record.stopReason !== undefined ? { stopReason: toLogValue(record.stopReason) } : {}),
      ...(record.usage !== undefined ? { usage: toLogValue(record.usage) } : {}),
      ...(record.providerMetadata !== undefined ? { providerMetadata: toLogValue(record.providerMetadata) } : {}),
      ...(record.toolCallId !== undefined ? { toolCallId: !record.toolCallIdCanonical && phase !== undefined && phase > 0 ? `${phase}:${record.toolCallId}` : record.toolCallId } : {}),
      ...(record.input !== undefined ? { input: toLogValue(record.input) } : {}),
      ...(record.output !== undefined ? { output: toLogValue(record.output) } : {}),
      ...(record.error !== undefined ? { error: toLogValue(record.error) } : {}),
      ...(record.retry !== undefined ? { retry: toLogValue(record.retry) } : {}),
      ...(record.abort !== undefined ? { abort: toLogValue(record.abort) } : {}),
      ...(record.latencyMs !== undefined ? { latencyMs: record.latencyMs } : {}),
    };
  }

  private enqueue(events: readonly Omit<LogEvent, "id">[]): Promise<LogEvent[]> {
    const generation = this.generation;
    const task = this.pending.then(async () => {
      await this.ready;
      const store = this.options.store ?? getEventStore();
      const write = async () => {
        // Recheck after the cross-page lock: maintenance may have advanced while
        // this writer was waiting for another page's terminal transaction.
        if (generation === undefined ? this.handshakePaused : generation !== this.generation) return [];
        const runIds = [...new Set(events.filter((event) => terminalKey(event)).map((event) => event.runId!))];
        const prior = runIds.length ? store.byRunTypes
          ? await store.byRunTypes(runIds, TERMINAL_EVENT_TYPES)
          : (await store.all()).filter((event) => event.runId && runIds.includes(event.runId) && TERMINAL_EVENT_TYPES.includes(event.type)) : [];
        const existing = new Map(prior.map((event) => [terminalKey(event), event]));
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
        for (const event of stored) for (const listener of this.listeners) listener(event);
        // Return the accepted durable terminal to a competing callback, without
        // publishing a second event or replacing the original reason/result.
        for (const event of stored) { const key = terminalKey(event); if (key) existing.set(key, event); }
        const appended = new Map(accepted.map((event, index) => [event, stored[index]!]));
        return events.map((event) => terminalKey(event) ? existing.get(terminalKey(event)!)! : appended.get(event)!)
          .filter((event): event is LogEvent => Boolean(event));
      };
      return events.some((event) => terminalKey(event)) ? withTerminalWriteLock(write) : write();
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

  diagnosticEvents(conversationId: string): Promise<LogEvent[]> {
    return this.eventsByTypes(["browser.diagnostic"], conversationId);
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

  async result(id: number, selection: { path?: string | Array<string | number>; offset?: number; limit?: number } = {}, conversationId?: string): Promise<unknown> {
    if (!Number.isSafeInteger(id) || id < 1) throw new Error("Invalid result event ID");
    await this.flush();
    const store = this.options.store ?? getEventStore();
    const event = store.get ? await store.get(id) : (await store.all()).find((item) => item.id === id);
    if (event?.type !== "tool.result.data" || conversationId !== undefined && event.conversationId !== conversationId) throw new Error(`Tool result ${id} is unavailable`);
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

  async closePendingTools(runId: string, conversationId: string, reason: unknown): Promise<void> {
    const events = await this.eventsByRunTypes([runId], ["tool.started", "tool.finished", "tool.failed", "tool.progress"]);
    const key = (event: LogEvent) => `${(fromLogValue(event.content) as { callId?: string })?.callId ?? ""}\0${event.toolCallId}`;
    const terminal = new Set(events.filter((event) => ["tool.finished", "tool.failed"].includes(event.type)).map(key));
    for (const event of events) {
      if (event.type !== "tool.started" || !event.toolCallId || terminal.has(key(event))) continue;
      terminal.add(key(event));
      const progress = [...events].reverse().find((item) => item.type === "tool.progress" && item.toolCallId === event.toolCallId);
      const progressContent = progress ? fromLogValue(progress.content) as { nextIndex: number; steps: unknown[] } : undefined;
      const progressOutput = progress ? fromLogValue(progress.output) as { completed: unknown[]; elapsedMs: number } : undefined;
      const input = fromLogValue(event.input) as { steps?: unknown[] } | undefined;
      const steps = progressContent?.steps ?? input?.steps;
      const index = progressContent?.nextIndex ?? 0;
      const completedAll = Boolean(steps && index === steps.length);
      const failure = { code: "interrupted", message: String(reason), effectUnknown: true };
      const output = steps ? {
        ok: completedAll, completed: progressOutput?.completed ?? [],
        ...(completedAll ? {} : { error: failure, failed: { index, step: steps[index], error: failure }, notRun: steps.slice(index + 1) }),
        elapsedMs: progressOutput?.elapsedMs ?? 0,
      } : { ok: false, error: failure };
      await this.append({ type: completedAll ? "tool.finished" : "tool.failed", conversationId, runId, toolCallId: event.toolCallId, toolCallIdCanonical: true,
        content: { ...((fromLogValue(event.content) as object) ?? {}), status: completedAll ? "completed" : "interrupted", effectUnknown: !completedAll },
        input: fromLogValue(event.input), output,
        ...(completedAll ? {} : { error: failure, abort: { reason } }) });
    }
  }

  async recoverDanglingRuns(activeRunIds: readonly string[] | (() => Promise<readonly string[]>) = [], reason = "owner-disconnected"): Promise<void> {
    const recover = async () => {
      const events = await this.eventsByTypes(RUN_EVENT_TYPES);
      const terminal = new Set(events.filter((event) => event.runId && event.type !== "conversation.submitted").map((event) => event.runId));
      for (const event of events) {
        if (event.type !== "conversation.submitted" || !event.runId || !event.conversationId || terminal.has(event.runId)) continue;
        const owners = typeof activeRunIds === "function" ? await activeRunIds() : activeRunIds;
        if (owners.includes(event.runId)) continue;
        terminal.add(event.runId);
        await this.closePendingTools(event.runId, event.conversationId, reason);
        await this.append({ type: "conversation.aborted", conversationId: event.conversationId, runId: event.runId,
          content: null, abort: { reason } });
      }
    };
    if (typeof navigator !== "undefined" && navigator.locks) await navigator.locks.request("surf-wax:log-recovery", recover);
    else await recover();
  }

  async clear(): Promise<void> {
    await this.flush();
    await (this.options.store ?? getEventStore()).clear();
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
