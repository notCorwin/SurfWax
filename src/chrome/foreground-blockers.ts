import type { EventOwner, EventSource } from "./event-subscriptions";

/** A browser dialog is identified by the CDP event, not by model-supplied guesses. */
export type ObservedDialog = Readonly<{
  dialogId: string;
  source: EventSource;
  type: string;
  message: string;
  defaultPrompt?: string;
}>;

export type BlockedEvidence = Readonly<{
  owner: EventOwner;
  jobId: string;
  dialog: ObservedDialog;
  /** The actual operation targets that were still in flight when the event arrived. */
  operations: readonly Readonly<{ operation: string; source: EventSource; dispatched: boolean }>[];
}>;

export type BlockerOutcome =
  | { status: "blocked"; jobId: string; dialog: ObservedDialog; evidenceId: number; operationDispatchedAtObservation: boolean }
  | { status: "settled" }
  | { status: "cancelled"; reason: unknown }
  | { status: "persistence-failed"; error: unknown; effectUnknown: true };

export type BlockerJob = Readonly<{ token: symbol }>;
export type BlockerOperation = Readonly<{ token: symbol }>;

type OperationRecord = {
  handle: BlockerOperation;
  job: JobRecord;
  operation: string;
  source: EventSource;
  dispatched: boolean;
  active: boolean;
};
type JobRecord = {
  handle: BlockerJob;
  owner: EventOwner;
  jobId: string;
  operations: Set<OperationRecord>;
  active: boolean;
  outcome?: BlockerOutcome;
  done: Promise<BlockerOutcome>;
  resolve: (outcome: BlockerOutcome) => void;
};
type DialogRecord = {
  owner: EventOwner;
  dialog: ObservedDialog;
  active: boolean;
  processing: Promise<void>;
};

function sameOwner(a: EventOwner, b: EventOwner): boolean {
  return a.conversationId === b.conversationId && a.runId === b.runId;
}
function validateOwner(owner: EventOwner): void {
  if (typeof owner.conversationId !== "string" || !owner.conversationId || typeof owner.runId !== "string" || !owner.runId)
    throw new Error("Blocker owner must include conversationId and runId");
}
function copySource(source: EventSource): EventSource {
  if (!Number.isSafeInteger(source.tabId) || source.tabId < 0 || source.sessionId !== undefined && (typeof source.sessionId !== "string" || !source.sessionId))
    throw new Error("Invalid blocker source");
  return { tabId: source.tabId, ...(source.sessionId === undefined ? {} : { sessionId: source.sessionId }) };
}
function dialogKey(owner: EventOwner, id: string): string {
  return JSON.stringify([owner.conversationId, owner.runId, id]);
}

/**
 * Coordinates only live foreground work. Historical events never recreate
 * browser handles, and an empty known-dialog list is not proof of absence.
 */
export class ForegroundBlockers {
  private readonly jobs = new WeakMap<BlockerJob, JobRecord>();
  private readonly operations = new WeakMap<BlockerOperation, OperationRecord>();
  private readonly activeJobs = new Set<JobRecord>();
  private readonly dialogs = new Map<string, DialogRecord>();

  constructor(private readonly persist: (evidence: BlockedEvidence) => Promise<number>) {}

  begin(owner: EventOwner, jobId: string): BlockerJob {
    validateOwner(owner);
    if (typeof jobId !== "string" || !jobId) throw new Error("Blocker job ID is required");
    if ([...this.activeJobs].some((job) => sameOwner(job.owner, owner) && job.jobId === jobId)) throw new Error("Blocker job is already active");
    const handle = Object.freeze({ token: Symbol("foreground-job") });
    let resolve!: (outcome: BlockerOutcome) => void;
    const done = new Promise<BlockerOutcome>((finish) => { resolve = finish; });
    const record: JobRecord = { handle, owner: { ...owner }, jobId, operations: new Set(), active: true, done, resolve };
    this.jobs.set(handle, record);
    this.activeJobs.add(record);
    return handle;
  }

  startOperation(handle: BlockerJob, operation: string, source: EventSource): BlockerOperation {
    const job = this.jobs.get(handle);
    if (!job?.active) throw new Error("Foreground job is no longer active");
    if (typeof operation !== "string" || !operation) throw new Error("Blocker operation is required");
    const token = Object.freeze({ token: Symbol("foreground-operation") });
    const record: OperationRecord = { handle: token, job, operation, source: copySource(source), dispatched: false, active: true };
    this.operations.set(token, record);
    job.operations.add(record);
    return token;
  }

  /** Call only after the operation's dispatch intent is durable, before sending it to Chrome. */
  markDispatched(handle: BlockerOperation, source: EventSource): void {
    const operation = this.operations.get(handle);
    const actual = copySource(source);
    if (!operation?.active || !operation.job.active) throw new Error("Foreground operation is no longer active");
    if (operation.source.tabId !== actual.tabId) throw new Error("Dispatch tab does not match the active operation");
    operation.source = actual;
    operation.dispatched = true;
  }

  endOperation(handle: BlockerOperation): void {
    const operation = this.operations.get(handle);
    if (!operation?.active) return;
    operation.active = false;
    operation.job.operations.delete(operation);
  }

  /** Returns observed open dialogs only. It deliberately does not infer absence. */
  knownDialogs(owner: EventOwner, tabId: number): ObservedDialog[] {
    validateOwner(owner);
    if (!Number.isSafeInteger(tabId) || tabId < 0) throw new Error("Invalid tab ID");
    return [...this.dialogs.values()].filter((item) => item.active && sameOwner(item.owner, owner) && item.dialog.source.tabId === tabId)
      .map((item) => structuredClone(item.dialog));
  }

  /** Register synchronously; the returned promise completes after any matching evidence writes. */
  observeDialog(owner: EventOwner, input: ObservedDialog, eligible: (jobId: string) => boolean = () => true): Promise<void> {
    validateOwner(owner);
    if (typeof input.dialogId !== "string" || !input.dialogId || typeof input.type !== "string" || typeof input.message !== "string"
      || input.defaultPrompt !== undefined && typeof input.defaultPrompt !== "string") throw new Error("Invalid observed dialog");
    const dialog: ObservedDialog = { dialogId: input.dialogId, source: copySource(input.source), type: input.type, message: input.message,
      ...(input.defaultPrompt === undefined ? {} : { defaultPrompt: input.defaultPrompt }) };
    const key = dialogKey(owner, dialog.dialogId);
    const previous = this.dialogs.get(key);
    if (previous?.active) {
      if (JSON.stringify(previous.dialog) !== JSON.stringify(dialog)) throw new Error("Dialog ID already belongs to a different event");
      return previous.processing;
    }
    const record: DialogRecord = { owner: { ...owner }, dialog, active: true, processing: Promise.resolve() };
    this.dialogs.set(key, record);
    const candidates = [...this.activeJobs].filter((job) => sameOwner(job.owner, owner) && !job.outcome && eligible(job.jobId))
      .map((job) => ({ job, operations: [...job.operations].filter((operation) => operation.active && operation.source.tabId === dialog.source.tabId) }))
      .filter((candidate) => candidate.operations.length > 0);
    record.processing = Promise.all(candidates.map(async ({ job, operations }) => {
      const evidence: BlockedEvidence = {
        owner: { ...owner }, jobId: job.jobId, dialog: structuredClone(dialog),
        operations: operations.map((operation) => ({ operation: operation.operation, source: { ...operation.source }, dispatched: operation.dispatched })),
      };
      let evidenceId: number;
      try {
        evidenceId = await this.persist(evidence);
        if (!Number.isSafeInteger(evidenceId) || evidenceId < 1) throw new Error("Blocker evidence was not persisted");
      } catch (error) {
        if (record.active && job.active && !job.outcome && operations.some((operation) => operation.active)) {
          // Earlier operations in this program may already have had effects,
          // even if the currently observed operation was not dispatched yet.
          this.resolve(job, { status: "persistence-failed", error, effectUnknown: true });
        }
        return;
      }
      if (!record.active || !job.active || job.outcome || !operations.some((operation) => operation.active)) return;
      // This describes the durable snapshot at event observation, not the
      // overall job's effects or what might happen after the observation.
      const operationDispatchedAtObservation = evidence.operations.some((operation) => operation.dispatched);
      this.resolve(job, { status: "blocked", jobId: job.jobId, dialog: structuredClone(dialog), evidenceId, operationDispatchedAtObservation });
    })).then(() => undefined);
    return record.processing;
  }

  closeDialog(owner: EventOwner, dialogId: string): void {
    const key = dialogKey(owner, dialogId);
    const dialog = this.dialogs.get(key);
    if (!dialog) return;
    dialog.active = false;
    this.dialogs.delete(key);
  }

  wait(handle: BlockerJob): Promise<BlockerOutcome> {
    const job = this.jobs.get(handle);
    if (!job) throw new Error("Unknown foreground job");
    return job.done;
  }

  private resolve(job: JobRecord, outcome: BlockerOutcome): void {
    if (job.outcome) return;
    job.outcome = outcome;
    job.resolve(outcome);
  }

  private end(handle: BlockerJob, outcome: BlockerOutcome): void {
    const job = this.jobs.get(handle);
    if (!job?.active) return;
    job.active = false;
    for (const operation of job.operations) operation.active = false;
    job.operations.clear();
    this.activeJobs.delete(job);
    this.resolve(job, outcome);
  }

  settle(handle: BlockerJob): void { this.end(handle, { status: "settled" }); }
  cancel(handle: BlockerJob, reason: unknown): void { this.end(handle, { status: "cancelled", reason }); }

  closeOwner(owner: EventOwner, reason: unknown = "run-ended"): void {
    for (const job of [...this.activeJobs]) if (sameOwner(job.owner, owner)) this.cancel(job.handle, reason);
    for (const [key, dialog] of this.dialogs) if (sameOwner(dialog.owner, owner)) { dialog.active = false; this.dialogs.delete(key); }
  }
}
