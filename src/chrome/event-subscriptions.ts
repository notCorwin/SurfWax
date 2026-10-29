/** Live event subscriptions belong to a single run and never reconstruct browser state from history. */
export type EventOwner = Readonly<{ conversationId: string; runId: string }>;
export type BrowserEventKind = "dialog" | "popup" | "download" | "filechooser" | "request" | "response" | "console";
export type EventSource = Readonly<{ tabId: number; sessionId?: string }>;
export type BrowserEvent = Readonly<{ kind: BrowserEventKind; source: EventSource; payload: unknown }>;
export type SubscriptionEvent = BrowserEvent & { cursor: number; payloadTruncated?: { reason: "event-too-large"; bytes: number } };
export type EventRead = {
  subscriptionId: string;
  events: SubscriptionEvent[];
  nextCursor: number;
  hasMore: boolean;
  overflow?: { from: number; through: number };
  timedOut?: boolean;
  closed?: string;
};

type Subscription = {
  id: string;
  owner: EventOwner;
  tabId: number;
  kinds: Set<BrowserEventKind>;
  cursor: number;
  events: SubscriptionEvent[];
  closed?: string;
  waiters: Set<() => void>;
};
type Dialog = {
  id: string;
  owner: EventOwner;
  source: EventSource;
  type: string;
  message: string;
  defaultPrompt?: string;
  state: "active" | "handling" | "uncertain";
  claimVersion: number;
};
type DialogView = Omit<Dialog, "owner" | "claimVersion">;
type Chooser = {
  id: string;
  owner: EventOwner;
  source: EventSource;
  backendNodeId: number;
  mode: string;
  state: "active" | "handling" | "uncertain" | "handled";
  claimVersion: number;
};
type ChooserView = Omit<Chooser, "owner" | "claimVersion">;

function sameOwner(a: EventOwner, b: EventOwner): boolean {
  return a.conversationId === b.conversationId && a.runId === b.runId;
}
function integer(value: number, name: string, minimum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`Invalid ${name}`);
}
function ownerCopy(owner: EventOwner): EventOwner {
  if (!owner.conversationId || !owner.runId) throw new Error("Event owner must include conversationId and runId");
  return { conversationId: owner.conversationId, runId: owner.runId };
}
function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Operation aborted", "AbortError");
}

export class EventSubscriptions {
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly dialogs = new Map<string, Dialog>();
  private readonly choosers = new Map<string, Chooser>();
  private readonly capacity: number;
  private readonly createId: () => string;
  private readonly maxEventBytes: number;

  constructor(options: { capacity?: number; maxEventBytes?: number; createId?: () => string } = {}) {
    this.capacity = options.capacity ?? 256;
    integer(this.capacity, "event capacity", 1);
    this.maxEventBytes = options.maxEventBytes ?? 65_536;
    integer(this.maxEventBytes, "maximum event bytes", 1);
    this.createId = options.createId ?? (() => crypto.randomUUID());
  }

  private id(): string {
    const id = this.createId();
    if (!id || this.subscriptions.has(id) || this.dialogs.has(id) || this.choosers.has(id)) throw new Error("Duplicate or empty event handle");
    return id;
  }

  subscribe(input: { owner: EventOwner; tabId: number; kinds: readonly BrowserEventKind[] }): { subscriptionId: string; cursor: number } {
    const owner = ownerCopy(input.owner);
    integer(input.tabId, "tab ID", 0);
    if (!input.kinds.length) throw new Error("At least one event kind is required");
    const id = this.id();
    this.subscriptions.set(id, { id, owner, tabId: input.tabId, kinds: new Set(input.kinds), cursor: 0, events: [], waiters: new Set() });
    return { subscriptionId: id, cursor: 0 };
  }

  /** Call after the browser listener is installed. Payloads are Chrome-protocol JSON; publication does not imply persistence. */
  publish(owner: EventOwner, event: BrowserEvent): void {
    integer(event.source.tabId, "tab ID", 0);
    if (event.source.sessionId !== undefined && event.source.sessionId.length > 1024) throw new Error("Event session ID is too long");
    const targets = [...this.subscriptions.values()].filter((subscription) => !subscription.closed && sameOwner(subscription.owner, owner) && subscription.tabId === event.source.tabId && subscription.kinds.has(event.kind));
    if (!targets.length) return;
    let encoded: string | undefined;
    try { encoded = JSON.stringify(event); } catch { throw new Error("Event must be JSON serializable"); }
    if (encoded === undefined) throw new Error("Event must be JSON serializable");
    const bytes = new TextEncoder().encode(encoded).byteLength;
    const payload = event.payload && typeof event.payload === "object" ? event.payload as Record<string, unknown> : undefined;
    const critical = event.kind === "dialog" && typeof payload?.dialogId === "string" && payload.dialogId.length <= 1024
      ? { dialogId: payload.dialogId, ...(typeof payload.type === "string" && payload.type.length <= 64 ? { type: payload.type } : {}) }
      : event.kind === "filechooser" && typeof payload?.chooserId === "string" && payload.chooserId.length <= 1024
        ? { chooserId: payload.chooserId, ...(typeof payload.mode === "string" && payload.mode.length <= 64 ? { mode: payload.mode } : {}) }
      : event.kind === "popup" && Number.isSafeInteger(payload?.tabId) ? { tabId: payload!.tabId } : null;
    const captured = bytes <= this.maxEventBytes ? JSON.parse(encoded) as BrowserEvent : {
      kind: event.kind, source: { ...event.source }, payload: critical,
      payloadTruncated: { reason: "event-too-large" as const, bytes },
    };
    for (const subscription of targets) {
      const stored = { ...captured, cursor: subscription.cursor + 1 };
      subscription.cursor = stored.cursor;
      subscription.events.push(stored);
      if (subscription.events.length > this.capacity) subscription.events.shift();
      for (const wake of [...subscription.waiters]) wake();
    }
  }

  private subscription(owner: EventOwner, id: string): Subscription {
    const subscription = this.subscriptions.get(id);
    if (!subscription || !sameOwner(subscription.owner, owner)) throw new Error("Event subscription unavailable in this run");
    return subscription;
  }

  private view(subscription: Subscription, after: number, limit: number): EventRead {
    const oldest = subscription.events[0]?.cursor ?? subscription.cursor + 1;
    const overflow = after + 1 < oldest ? { from: after + 1, through: oldest - 1 } : undefined;
    const events = subscription.events.filter((event) => event.cursor > after).slice(0, limit);
    const nextCursor = events.at(-1)?.cursor ?? after;
    return { subscriptionId: subscription.id, events: structuredClone(events), nextCursor, hasMore: nextCursor < subscription.cursor,
      ...(overflow ? { overflow } : {}), ...(subscription.closed ? { closed: subscription.closed } : {}) };
  }

  async read(input: { owner: EventOwner; subscriptionId: string; after?: number; limit?: number; waitMs?: number; signal?: AbortSignal }): Promise<EventRead> {
    const subscription = this.subscription(input.owner, input.subscriptionId);
    const after = input.after ?? 0;
    const limit = input.limit ?? 50;
    const waitMs = input.waitMs ?? 0;
    integer(after, "cursor", 0); integer(limit, "limit", 1); integer(waitMs, "waitMs", 0);
    if (after > subscription.cursor) throw new Error("Event cursor is ahead of the subscription");
    const deadline = Date.now() + waitMs;
    while (true) {
      input.signal?.throwIfAborted();
      const value = this.view(subscription, after, limit);
      if (value.events.length || value.overflow || value.closed || waitMs === 0) return value;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { ...value, timedOut: true };
      await new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        let settled = false;
        const cleanup = () => { subscription.waiters.delete(wake); input.signal?.removeEventListener("abort", abort); if (timer !== undefined) clearTimeout(timer); };
        const wake = () => { if (settled) return; settled = true; cleanup(); resolve(); };
        const abort = () => { if (settled) return; settled = true; cleanup(); reject(abortReason(input.signal!)); };
        subscription.waiters.add(wake);
        input.signal?.addEventListener("abort", abort, { once: true });
        timer = setTimeout(wake, Math.min(remaining, 2_147_483_647));
        // Close the check/subscribe race, including abort immediately before listener registration.
        if (input.signal?.aborted) abort();
        else if (subscription.closed || subscription.cursor > after) wake();
      });
    }
  }

  private close(subscription: Subscription, reason: string, release = false): void {
    if (!subscription.closed) {
      subscription.closed = reason;
      for (const wake of [...subscription.waiters]) wake();
    }
    if (release) this.subscriptions.delete(subscription.id);
  }

  unsubscribe(owner: EventOwner, subscriptionId: string): void {
    const subscription = this.subscription(owner, subscriptionId);
    this.close(subscription, "unsubscribed", true);
  }

  closeTab(owner: EventOwner, tabId: number, reason = "tab-closed"): void {
    for (const subscription of this.subscriptions.values()) if (sameOwner(owner, subscription.owner) && subscription.tabId === tabId) this.close(subscription, reason);
    for (const dialog of this.dialogs.values()) if (sameOwner(owner, dialog.owner) && dialog.source.tabId === tabId) this.dialogs.delete(dialog.id);
    this.closeChoosers(owner, tabId);
  }

  closeOwner(owner: EventOwner, reason = "run-ended"): void {
    for (const subscription of this.subscriptions.values()) if (sameOwner(owner, subscription.owner)) this.close(subscription, reason, true);
    for (const dialog of this.dialogs.values()) if (sameOwner(owner, dialog.owner)) this.dialogs.delete(dialog.id);
    for (const chooser of this.choosers.values()) if (sameOwner(owner, chooser.owner)) this.choosers.delete(chooser.id);
  }

  registerDialog(input: { owner: EventOwner; source: EventSource; type: string; message: string; defaultPrompt?: string }): DialogView {
    const owner = ownerCopy(input.owner);
    integer(input.source.tabId, "tab ID", 0);
    const dialog: Dialog = { id: this.id(), owner, source: { ...input.source }, type: input.type, message: input.message,
      ...(input.defaultPrompt === undefined ? {} : { defaultPrompt: input.defaultPrompt }), state: "active", claimVersion: 0 };
    this.dialogs.set(dialog.id, dialog);
    const { owner: _owner, claimVersion: _claimVersion, ...visible } = dialog;
    return structuredClone(visible);
  }

  /** Claim synchronously before any await; only the claimant may dispatch the response. */
  claimDialog(owner: EventOwner, id: string): DialogView & { claimId: number } {
    const dialog = this.dialogs.get(id);
    if (!dialog || !sameOwner(owner, dialog.owner)) throw new Error("Dialog unavailable in this run");
    if (dialog.state !== "active") throw new Error(`Dialog is ${dialog.state}`);
    dialog.state = "handling";
    dialog.claimVersion += 1;
    const { owner: _owner, claimVersion: claimId, ...visible } = dialog;
    return structuredClone({ ...visible, claimId });
  }

  /** Verify the exact claimed dialog is still live immediately before dispatch. */
  assertDialogClaim(owner: EventOwner, id: string, claimId: number): void {
    const dialog = this.dialogs.get(id);
    if (!dialog || !sameOwner(owner, dialog.owner)) throw new Error("Dialog unavailable in this run");
    if (dialog.state !== "handling" || dialog.claimVersion !== claimId) throw new Error("Dialog claim is stale");
  }

  /** A definite pre-dispatch failure releases the claim; uncertain effects cannot be retried automatically. */
  finishDialog(owner: EventOwner, id: string, claimId: number, outcome: "handled" | "not-dispatched" | "uncertain"): void {
    const dialog = this.dialogs.get(id);
    if (!dialog) return; // The browser may have already emitted dialogClosed.
    if (!sameOwner(owner, dialog.owner)) throw new Error("Dialog unavailable in this run");
    if (dialog.state !== "handling" || dialog.claimVersion !== claimId) throw new Error("Dialog claim is stale");
    if (outcome === "handled") this.dialogs.delete(id);
    else dialog.state = outcome === "uncertain" ? "uncertain" : "active";
  }

  /** Browser dialogClosed or target detach invalidates the handle. */
  closeDialog(owner: EventOwner, id: string): void {
    const dialog = this.dialogs.get(id);
    if (dialog && sameOwner(owner, dialog.owner)) this.dialogs.delete(id);
  }

  /** A later chooser in the same tab supersedes the previous native chooser. */
  registerChooser(input: { owner: EventOwner; source: EventSource; backendNodeId: number; mode: string }): ChooserView {
    const owner = ownerCopy(input.owner);
    integer(input.source.tabId, "tab ID", 0);
    integer(input.backendNodeId, "backend node ID", 1);
    if (!["selectSingle", "selectMultiple"].includes(input.mode)) throw new Error("File chooser mode is unavailable");
    this.closeChoosers(owner, input.source.tabId);
    const chooser: Chooser = { id: this.id(), owner, source: { ...input.source }, backendNodeId: input.backendNodeId,
      mode: input.mode, state: "active", claimVersion: 0 };
    this.choosers.set(chooser.id, chooser);
    const { owner: _owner, claimVersion: _version, ...visible } = chooser;
    return structuredClone(visible);
  }

  claimChooser(owner: EventOwner, id: string): ChooserView & { claimId: number } {
    const chooser = this.choosers.get(id);
    if (!chooser || !sameOwner(owner, chooser.owner)) throw new Error("File chooser unavailable in this run");
    if (chooser.state !== "active") throw new Error(`File chooser is ${chooser.state}`);
    chooser.state = "handling";
    chooser.claimVersion += 1;
    const { owner: _owner, claimVersion: claimId, ...visible } = chooser;
    return structuredClone({ ...visible, claimId });
  }

  assertChooserClaim(owner: EventOwner, id: string, claimId: number): void {
    const chooser = this.choosers.get(id);
    if (!chooser || !sameOwner(owner, chooser.owner)) throw new Error("File chooser unavailable in this run");
    if (chooser.state !== "handling" || chooser.claimVersion !== claimId) throw new Error("File chooser claim is stale");
  }

  finishChooser(owner: EventOwner, id: string, claimId: number, outcome: "handled" | "not-dispatched" | "uncertain"): void {
    const chooser = this.choosers.get(id);
    if (!chooser) return;
    this.assertChooserClaim(owner, id, claimId);
    chooser.state = outcome === "not-dispatched" ? "active" : outcome;
  }

  closeChoosers(owner: EventOwner, tabId: number, sessionId?: string): void {
    for (const chooser of this.choosers.values()) if (sameOwner(owner, chooser.owner) && chooser.source.tabId === tabId
      && (sessionId === undefined || chooser.source.sessionId === sessionId)) this.choosers.delete(chooser.id);
  }
}
