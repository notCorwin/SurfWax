import { fromLogValue, type EventLogger, type LogEvent } from "../logging";
import { describeJobResult, jobResultReference, shouldStoreJobResult, type JobResultInfo } from "./job-result";

export type JobContext = {
  conversationId: string;
  logIdentity?: {
    runId?: string;
    toolCallId: string;
    toolCallIdCanonical: true;
  };
};
export type JobQuery = {
  action: "list" | "status" | "wait" | "cancel";
  id?: string;
  after?: number;
  limit?: number;
  waitMs?: number;
  cursor?: string;
};
type LiveJob = {
  controller: AbortController;
  done: Promise<void>;
  conversationId: string;
  stateId?: number;
};
const terminal = new Set(["succeeded", "failed", "cancelled", "interrupted"]);
type JobListCursor = { v: 1; conversationId: string; epoch: string; upper: number; after: number };
const LIST_LIMIT = 25;
const MAX_LIST_LIMIT = 100;

function encodeListCursor(cursor: JobListCursor): string {
  return btoa(encodeURIComponent(JSON.stringify(cursor)));
}
function decodeListCursor(value: string, conversationId: string): JobListCursor {
  try {
    if (value.length > 4096) throw new Error("too long");
    const cursor = JSON.parse(decodeURIComponent(atob(value))) as JobListCursor;
    if (!cursor || cursor.v !== 1 || cursor.conversationId !== conversationId || typeof cursor.epoch !== "string"
      || !Number.isSafeInteger(cursor.upper) || cursor.upper < 0 || !Number.isSafeInteger(cursor.after)
      || cursor.after < 0 || cursor.after > cursor.upper) throw new Error("invalid cursor");
    return cursor;
  } catch {
    throw Object.assign(new Error("Invalid job list cursor for this conversation"), { code: "invalid-job-cursor" });
  }
}
function expiredListCursor(): Error {
  return Object.assign(new Error("Job list snapshot expired after log maintenance; start a new list"), { code: "job-cursor-expired" });
}
type StateEntry = {
  id: number;
  state: string;
  runId?: string;
  toolCallId?: string;
};
type ProjectedJob = {
  queuedId?: number;
  state?: StateEntry;
  lastEventId: number;
  eventIds: number[] | null;
};
type JobProjection = {
  epoch?: string;
  cursor: number;
  jobs: Map<string, ProjectedJob>;
  unsettled: Set<string>;
  indexedEvents: number;
  cacheOrder: Set<string>;
  terminalOrder: Set<string>;
  historyEvicted: boolean;
  requested: number;
  completed: number;
  flight?: Promise<void>;
};

/** Only controllers and completion notifications live in memory. All job state is a log projection. */
export class BrowserJobs {
  private readonly live = new Map<string, LiveJob>();
  private recoveryReaders = 0;
  private readonly recovering = new Map<string, Promise<void>>();
  private readonly finishedDuringReads = new Set<string>();
  private readonly projections = new Map<string, JobProjection>();
  private readonly maxIndexedEvents: number;
  private readonly maxCachedJobs: number;
  constructor(
    private readonly logger?: EventLogger,
    options: { maxIndexedEvents?: number; maxCachedJobs?: number } = {},
  ) {
    this.maxIndexedEvents = Math.max(0, options.maxIndexedEvents ?? 100_000);
    this.maxCachedJobs = Math.max(0, options.maxCachedJobs ?? 1_000);
  }

  private releaseFinishedOwners(): void {
    if (this.recoveryReaders !== 0) return;
    for (const id of this.finishedDuringReads) this.live.delete(id);
    this.finishedDuringReads.clear();
  }

  async start(
    context: JobContext,
    signal: AbortSignal | undefined,
    execute: (
      signal: AbortSignal,
      id: string,
      started: () => Promise<void>,
    ) => Promise<unknown>,
  ): Promise<string> {
    signal?.throwIfAborted();
    if (!this.logger) throw new Error("Jobs require the canonical event log");
    const id = crypto.randomUUID();
    const controller = new AbortController();
    const combined = signal
      ? AbortSignal.any([controller.signal, signal])
      : controller.signal;
    // Register before publishing queued: readers may observe the durable event
    // before append() returns to this caller.
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const owner: LiveJob = {
      controller,
      done,
      conversationId: context.conversationId,
    };
    this.live.set(id, owner);
    try {
      await this.write(context, id, "queued");
    } catch (error) {
      this.live.delete(id);
      finish();
      throw error;
    }
    void (async () => {
      try {
        combined.throwIfAborted();
        const result = await execute(combined, id, () =>
          this.write(context, id, "running"),
        );
        combined.throwIfAborted();
        await this.write(context, id, "succeeded", result);
      } catch (error) {
        const timedOut =
          (combined.reason ?? error) instanceof DOMException &&
          (combined.reason ?? error).name === "TimeoutError";
        await this.write(
          context,
          id,
          combined.aborted ? "cancelled" : "failed",
          {
            ok: false,
            ...((error as any)?.artifact
              ? { artifact: (error as any).artifact }
              : {}),
            error: {
              code: timedOut
                ? "timeout"
                : combined.aborted
                  ? "aborted"
                  : (/^(?:Automation|Command)Error\[([^\]]+)\]/.exec(
                      error instanceof Error ? error.message : String(error),
                    )?.[1] ?? "execution-failed"),
              message: error instanceof Error ? error.message : String(error),
              retryable: false,
              ...((error as any)?.effectUnknown ? { effectUnknown: true } : {}),
            },
          },
        );
      } finally {
        this.finishedDuringReads.add(id);
        this.releaseFinishedOwners();
        finish();
      }
    })().catch(() => {
      this.finishedDuringReads.add(id);
      this.releaseFinishedOwners();
      finish();
    });
    return id;
  }

  private async write(
    context: JobContext,
    id: string,
    state: string,
    output?: unknown,
  ): Promise<void> {
    const record = {
      type: "browser.job.state",
      conversationId: context.conversationId,
      ...context.logIdentity,
      content: { jobId: id, state },
      ...(arguments.length >= 4 ? { output } : {}),
    };
    if (terminal.has(state)) {
      const previous = this.live.get(id)?.stateId;
      if (previous === undefined) throw new Error("Could not persist browser job state: missing owner state");
      const epoch = await this.logger!.canonicalEpoch();
      const large = arguments.length >= 4 && shouldStoreJobResult(output);
      const saved = large ? (await this.logger!.appendArtifactAnd({
          artifact: { type: "tool.result.data", conversationId: context.conversationId, ...context.logIdentity,
            content: { jobId: id }, output: { result: output } },
          terminal: { type: record.type, conversationId: context.conversationId, ...context.logIdentity,
            content: { jobId: id, state, resultInfo: describeJobResult(output) } },
          link: "resultArtifactId", expectedEpoch: epoch, expectedJobStateId: previous,
        }))?.terminal : await this.logger!.appendIfEpoch(record, epoch, previous);
      // A recovery or maintenance writer may have won; never replace its terminal state.
      if (saved) this.live.get(id)!.stateId = saved.id;
      return;
    }
    const saved = await this.logger?.append(record);
    if (!saved) throw new Error("Could not persist browser job state");
    const owner = this.live.get(id);
    if (owner) owner.stateId = saved.id;
  }

  private projection(conversationId: string): JobProjection {
    let projection = this.projections.get(conversationId);
    if (projection) this.projections.delete(conversationId);
    else
      projection = {
        cursor: -1,
        jobs: new Map(),
        unsettled: new Set(),
        indexedEvents: 0,
        cacheOrder: new Set(),
        terminalOrder: new Set(),
        historyEvicted: false,
        requested: 0,
        completed: 0,
      };
    this.projections.set(conversationId, projection);
    if (this.projections.size > 8)
      this.projections.delete(this.projections.keys().next().value!);
    return projection;
  }

  private resetProjection(
    projection: JobProjection,
    epoch: string,
    floor: number,
  ): void {
    projection.epoch = epoch;
    projection.cursor = floor;
    projection.jobs.clear();
    projection.unsettled.clear();
    projection.indexedEvents = 0;
    projection.cacheOrder.clear();
    projection.terminalOrder.clear();
    projection.historyEvicted = false;
  }

  private applyEvent(projection: JobProjection, event: LogEvent): void {
    if (event.id <= projection.cursor) return;
    projection.cursor = event.id;
    const content = fromLogValue(event.content, event.valueEncoding) as {
      jobId?: unknown;
      state?: unknown;
    } | null;
    if (typeof content?.jobId !== "string") return;
    const id = content.jobId;
    let job = projection.jobs.get(id);
    if (!job) {
      // Queued starts a fresh, unique job ID. Any other unseen event after an
      // eviction may belong to an older job and cannot establish a full index.
      const startsJob = event.type === "browser.job.state" && content.state === "queued";
      job = { lastEventId: event.id, eventIds: projection.historyEvicted && !startsJob ? null : [] };
      projection.jobs.set(id, job);
      if (job.eventIds) projection.cacheOrder.add(id);
    }
    job.lastEventId = event.id;
    if (job.eventIds) {
      job.eventIds.push(event.id);
      projection.indexedEvents++;
    }
    if (
      event.type === "browser.job.state" &&
      typeof content.state === "string"
    ) {
      if (content.state === "queued" && job.queuedId === undefined) job.queuedId = event.id;
      job.state = {
        id: event.id,
        state: content.state,
        runId: event.runId,
        toolCallId: event.toolCallId,
      };
      if (terminal.has(content.state)) projection.unsettled.delete(id);
      else projection.unsettled.add(id);
    }
    projection.terminalOrder.delete(id);
    if (!job.state || terminal.has(job.state.state)) projection.terminalOrder.add(id);
    while (projection.indexedEvents > this.maxIndexedEvents) {
      const expiredId = projection.cacheOrder.values().next().value!;
      projection.cacheOrder.delete(expiredId);
      const expired = projection.jobs.get(expiredId);
      if (expired?.eventIds) {
        projection.indexedEvents -= expired.eventIds.length;
        expired.eventIds = null;
      }
    }
    while (projection.terminalOrder.size > this.maxCachedJobs) {
      const expiredId = projection.terminalOrder.values().next().value!;
      projection.terminalOrder.delete(expiredId);
      const expired = projection.jobs.get(expiredId);
      if (expired?.eventIds) projection.indexedEvents -= expired.eventIds.length;
      projection.cacheOrder.delete(expiredId);
      projection.jobs.delete(expiredId);
      projection.historyEvicted = true;
    }
  }

  private async catchUp(
    conversationId: string,
    projection: JobProjection,
  ): Promise<void> {
    if (!this.logger) throw new Error("Jobs require the canonical event log");
    const requested = projection.requested;
    while (true) {
      const previousCursor = projection.cursor;
      const page = await this.logger.jobEventsSince(
        conversationId,
        previousCursor,
      );
      if (projection.epoch !== page.epoch) {
        this.resetProjection(projection, page.epoch, page.floor);
        // A writer generation can change without a clear. In that case a
        // page sought from the old cursor cannot initialize the new epoch.
        if (previousCursor > page.floor) continue;
      }
      for (const event of page.events) this.applyEvent(projection, event);
      if (!page.hasMore) break;
    }
    projection.completed = requested;
  }

  private async currentProjection(
    conversationId: string,
  ): Promise<JobProjection> {
    const projection = this.projection(conversationId);
    const required = ++projection.requested;
    while (projection.completed < required) {
      if (!projection.flight) {
        const flight = this.catchUp(conversationId, projection);
        projection.flight = flight;
        void flight
          .finally(() => {
            if (projection.flight === flight) projection.flight = undefined;
          })
          .catch(() => undefined);
      }
      await projection.flight;
    }
    return projection;
  }

  /** Recover abandoned jobs only after re-reading their latest durable state. */
  private async recoverLost(conversationId: string, id: string): Promise<void> {
    if (!this.logger) throw new Error("Jobs require the canonical event log");
    const key = JSON.stringify([conversationId, id]);
    let pending = this.recovering.get(key);
    if (!pending) {
      pending = (async () => {
        while (true) {
          const projection = await this.currentProjection(conversationId);
          const entry = projection.jobs.get(id)?.state;
          if (!entry || terminal.has(entry.state) || this.live.has(id)) return;
          const epoch = projection.epoch!;
          const saved = await this.logger!.appendIfEpoch(
            {
              type: "browser.job.state",
              conversationId,
              runId: entry.runId,
              toolCallId: entry.toolCallId,
              toolCallIdCanonical: true,
              content: { jobId: id, state: "interrupted" },
              output: {
                ok: false,
                error: {
                  code: "host-lost",
                  message:
                    "Execution host ended; inspect receipts and page state before continuing",
                  effectUnknown: entry.state !== "queued",
                  retryable: false,
                },
              },
            },
            epoch,
            entry.id,
          );
          if (saved) return;
          const current = await this.currentProjection(conversationId);
          if (current.epoch !== epoch) return;
          if (current.jobs.get(id)?.state?.id === entry.id)
            throw new Error("Could not persist job recovery");
        }
      })();
      this.recovering.set(key, pending);
    }
    try {
      await pending;
    } finally {
      if (this.recovering.get(key) === pending) this.recovering.delete(key);
    }
  }

  private async recoverProjection(
    conversationId: string,
    signal?: AbortSignal,
  ): Promise<JobProjection> {
    // Keep owners visible only while a reader can hold a pre-terminal snapshot.
    this.recoveryReaders++;
    try {
      let projection = await this.currentProjection(conversationId);
      signal?.throwIfAborted();
      // A local owner can finish while the first persisted snapshot is in
      // flight. Refresh before using that snapshot for state or recovery.
      if (
        [...projection.unsettled].some((id) => this.finishedDuringReads.has(id))
      ) {
        projection = await this.currentProjection(conversationId);
        signal?.throwIfAborted();
      }
      let recovered = false;
      for (const id of [...projection.unsettled]) {
        if (!this.live.has(id)) {
          await this.recoverLost(conversationId, id);
          recovered = true;
          signal?.throwIfAborted();
        }
      }
      if (recovered) projection = await this.currentProjection(conversationId);
      signal?.throwIfAborted();
      return projection;
    } finally {
      this.recoveryReaders--;
      this.releaseFinishedOwners();
    }
  }

  private async pageIds(
    conversationId: string,
    job: ProjectedJob,
    epoch: string,
    upper: number,
    id: string,
    after: number,
    limit: number,
  ): Promise<{ ids: number[]; hasMore: boolean } | null> {
    if (job.eventIds) {
      const ids = job.eventIds;
      const seek = (cursor: number) => {
        let low = 0,
          high = ids.length;
        while (low < high) {
          const mid = (low + high) >>> 1;
          if (ids[mid]! <= cursor) low = mid + 1;
          else high = mid;
        }
        return low;
      };
      const start = seek(after),
        end = seek(upper);
      return {
        ids: ids.slice(start, Math.min(end, start + limit)),
        hasMore: end > start + limit,
      };
    }
    // The ID cache is bounded. An evicted job is read from the canonical log,
    // in bounded pages, rather than claiming its partial cache is complete.
    const ids: number[] = [];
    let cursor = after;
    while (true) {
      const page = await this.logger!.jobEventsSince(conversationId, cursor);
      if (page.epoch !== epoch) return null;
      for (const event of page.events) {
        if (event.id > upper) break;
        cursor = event.id;
        if ((fromLogValue(event.content, event.valueEncoding) as any)?.jobId === id)
          ids.push(event.id);
        if (ids.length > limit)
          return { ids: ids.slice(0, limit), hasMore: true };
      }
      if (
        !page.hasMore ||
        !page.events.length ||
        cursor >= upper ||
        page.events.at(-1)!.id > upper
      )
        return { ids, hasMore: false };
    }
  }

  /** Rebuild evicted metadata from the authoritative log through one fixed cursor. */
  private async scan(
    conversationId: string,
    epoch: string,
    upper: number,
    signal: AbortSignal | undefined,
    visit: (event: LogEvent) => void,
  ): Promise<boolean> {
    let cursor = -1;
    while (true) {
      signal?.throwIfAborted();
      const page = await this.logger!.jobEventsSince(conversationId, cursor);
      signal?.throwIfAborted();
      if (page.epoch !== epoch) return false;
      for (const event of page.events) {
        if (event.id > upper) break;
        cursor = event.id;
        visit(event);
      }
      if (!page.hasMore || !page.events.length || cursor >= upper || page.events.at(-1)!.id > upper) {
        // A clear can commit after the final page was captured but before it
        // was delivered to us. Validate the epoch once more before returning.
        const valid = await this.logger!.jobEventsByIds(conversationId, [], epoch);
        signal?.throwIfAborted();
        return valid !== null;
      }
    }
  }

  /** List one snapshot page in creation order with only page-sized state in memory. */
  private async listPage(conversationId: string, epoch: string, upper: number, after: number, limit: number, signal?: AbortSignal): Promise<{ jobs: { id: string; state: string }[]; hasMore: boolean; nextCursor?: string } | null> {
    const selected = new Map<string, { id: string; state: string; created: number }>();
    let cursor = after;
    let hasMore = false;
    while (cursor < upper) {
      signal?.throwIfAborted();
      const page = await this.logger!.jobEventsSince(conversationId, cursor);
      signal?.throwIfAborted();
      if (page.epoch !== epoch) return null;
      for (const event of page.events) {
        if (event.id > upper) break;
        cursor = event.id;
        if (event.type !== "browser.job.state") continue;
        const content = fromLogValue(event.content, event.valueEncoding) as { jobId?: unknown; state?: unknown } | null;
        if (typeof content?.jobId !== "string" || typeof content.state !== "string") continue;
        let job = selected.get(content.jobId);
        // BrowserJobs.start persists one queued state before any other state.
        // Its unique event ID provides a stable creation-order pagination key.
        if (!job && content.state === "queued" && !hasMore) {
          if (selected.size === limit) hasMore = true;
          else {
            job = { id: content.jobId, state: content.state, created: event.id };
            selected.set(content.jobId, job);
          }
        }
        if (job) job.state = content.state;
      }
      if (!page.hasMore || !page.events.length || cursor >= upper || page.events.at(-1)!.id > upper) break;
    }
    if (!await this.logger!.jobEventsByIds(conversationId, [], epoch)) return null;
    signal?.throwIfAborted();
    const entries = [...selected.values()];
    return { jobs: entries.map(({ id, state }) => ({ id, state })), hasMore,
      ...(hasMore ? { nextCursor: encodeListCursor({ v: 1, conversationId, epoch, upper, after: entries.at(-1)!.created }) } : {}) };
  }

  async query(
    input: JobQuery,
    conversationId: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    signal?.throwIfAborted();
    let notify!: () => void;
    const changed = new Promise<void>((resolve) => {
      notify = resolve;
    });
    // Subscribe before the first read. An event committed while reading will
    // either be present in that read or wake the subsequent wait.
    const unsubscribe =
      input.action === "wait" && (input.waitMs ?? 1000) > 0
        ? this.logger?.subscribe((event) => {
            if (event.type === "log.cleared") {
              notify();
              return;
            }
            if (
              event.conversationId !== conversationId ||
              event.id <= (input.after ?? 0) ||
              !["browser.job.state", "browser.job.progress"].includes(
                event.type,
              )
            )
              return;
            if ((fromLogValue(event.content, event.valueEncoding) as any)?.jobId === input.id)
              notify();
          })
        : undefined;
    try {
      let waited = false;
      while (true) {
        const projection = await this.recoverProjection(conversationId, signal);
        signal?.throwIfAborted();
        const epoch = projection.epoch!;
        const upper = projection.cursor;
        if (input.action === "list") {
          const limit = input.limit ?? LIST_LIMIT;
          if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) throw new Error("Job list limit must be between 1 and 100");
          const continuation = input.cursor === undefined ? undefined : decodeListCursor(input.cursor, conversationId);
          if (continuation && continuation.epoch !== epoch) throw expiredListCursor();
          const snapshotEpoch = continuation?.epoch ?? epoch;
          const snapshotUpper = continuation?.upper ?? upper;
          // A complete in-memory projection already reflects this high-water
          // mark; reuse it for the first page instead of rereading history.
          if (!continuation && !projection.historyEvicted) {
            const entries: { id: string; state: string; created: number }[] = [];
            for (const [id, job] of projection.jobs) {
              if (job.state && job.queuedId !== undefined) entries.push({ id, state: job.state.state, created: job.queuedId });
              if (entries.length > limit) break;
            }
            const hasMore = entries.length > limit;
            if (hasMore) entries.pop();
            const result = { jobs: entries.map(({ id, state }) => ({ id, state })), hasMore,
              ...(hasMore ? { nextCursor: encodeListCursor({ v: 1, conversationId, epoch, upper, after: entries.at(-1)!.created }) } : {}) };
            if (!await this.logger!.jobEventsByIds(conversationId, [], epoch)) continue;
            signal?.throwIfAborted();
            return result;
          }
          const result = await this.listPage(conversationId, snapshotEpoch, snapshotUpper, continuation?.after ?? -1, limit, signal);
          if (!result) {
            if (continuation) throw expiredListCursor();
            continue;
          }
          return result;
        }
        const id = input.id;
        let job = id ? projection.jobs.get(id) : undefined;
        if (id && !job?.state) {
          let rebuilt: ProjectedJob | undefined;
          const valid = await this.scan(conversationId, epoch, upper, signal, (event) => {
            const content = fromLogValue(event.content, event.valueEncoding) as { jobId?: unknown; state?: unknown } | null;
            if (content?.jobId !== id) return;
            rebuilt ??= { lastEventId: event.id, eventIds: null };
            rebuilt.lastEventId = event.id;
            if (event.type === "browser.job.state" && typeof content.state === "string") {
              rebuilt.state = { id: event.id, state: content.state, runId: event.runId, toolCallId: event.toolCallId };
            }
          });
          if (!valid) continue;
          job = rebuilt;
        }
        if (!id || !job?.state)
          throw new Error("Job is unavailable in this conversation");
        const owner = this.live.get(id);
        if (input.action === "cancel") owner?.controller.abort("job-cancelled");
        if (
          input.action === "wait" &&
          !waited &&
          owner &&
          !terminal.has(job.state.state) &&
          job.lastEventId <= (input.after ?? 0)
        ) {
          waited = true;
          await this.wait(
            Promise.race([owner.done, changed]),
            input.waitMs ?? 1000,
            signal,
          );
          continue;
        }
        const state = job.state;
        const page = await this.pageIds(
          conversationId,
          job,
          epoch,
          upper,
          id,
          input.after ?? 0,
          input.limit ?? 50,
        );
        if (!page) continue;
        const requested = [
          ...page.ids,
          ...(terminal.has(state.state) && !page.ids.includes(state.id)
            ? [state.id]
            : []),
        ];
        const records = await this.logger!.jobEventsByIds(
          conversationId,
          requested,
          epoch,
        );
        if (!records) continue;
        signal?.throwIfAborted();
        const byId = new Map(records.map((event) => [event.id, event]));
        const entries = page.ids.map((eventId) => byId.get(eventId)!);
        const stateEvent = terminal.has(state.state)
          ? byId.get(state.id)!
          : undefined;
        const stateContent = stateEvent ? fromLogValue(stateEvent.content, stateEvent.valueEncoding) as { resultArtifactId?: unknown; resultInfo?: JobResultInfo } : undefined;
        const resultArtifactId = Number.isSafeInteger(stateContent?.resultArtifactId) && Number(stateContent?.resultArtifactId) > 0 ? Number(stateContent?.resultArtifactId) : undefined;
        if (
          records.some(
            (event) => (fromLogValue(event.content, event.valueEncoding) as any)?.jobId !== id,
          )
        )
          throw new Error("Job event belongs to another job");
        return {
          id,
          state: state.state,
          terminal: terminal.has(state.state),
          ...(stateEvent
            ? {
                ok: state.state === "succeeded",
                result: resultArtifactId ? jobResultReference(resultArtifactId, stateContent?.resultInfo ?? {}) : fromLogValue(stateEvent.output, stateEvent.valueEncoding),
              }
            : {}),
          events: entries.map((event) => ({
            cursor: event.id,
            type: event.type,
            ...(fromLogValue(event.content, event.valueEncoding) as object),
            ...(event.id === stateEvent?.id && resultArtifactId ? { outputAt: "resultAccess" } : event.output === undefined
              ? {}
              : event.id === stateEvent?.id
                ? { outputAt: "result" }
                : { output: fromLogValue(event.output, event.valueEncoding) }),
            ...(event.error === undefined
              ? {}
              : { error: fromLogValue(event.error, event.valueEncoding) }),
          })),
          nextCursor: entries.at(-1)?.id ?? input.after ?? 0,
          hasMore: page.hasMore,
          ...(input.action === "cancel"
            ? { cancellationRequested: true, rollback: false }
            : {}),
        };
      }
    } finally {
      unsubscribe?.();
    }
  }

  /** Wait only for the local execution owner to exit; this does not read job state. */
  waitForOwner(id: string, conversationId: string): Promise<void> {
    const owner = this.live.get(id);
    return owner?.conversationId === conversationId ? owner.done : Promise.resolve();
  }

  /** Await terminal completion without repeatedly waking on every progress receipt. */
  async completion(
    id: string,
    conversationId: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    signal?.throwIfAborted();
    const owner = this.live.get(id);
    if (owner?.conversationId === conversationId) {
      let abort: (() => void) | undefined;
      try {
        await Promise.race([
          owner.done,
          ...(signal
            ? [
                new Promise<never>((_, reject) => {
                  abort = () => reject(signal.reason);
                  signal.addEventListener("abort", abort, { once: true });
                  if (signal.aborted) abort();
                }),
              ]
            : []),
        ]);
      } finally {
        if (abort) signal?.removeEventListener("abort", abort);
      }
    }
    return this.query({ action: "status", id }, conversationId, signal);
  }

  cancelAll(reason = "run-ended"): void {
    for (const owner of this.live.values()) owner.controller.abort(reason);
  }

  private async wait(
    done: Promise<void>,
    ms: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (ms <= 0) return;
    const deadline = Date.now() + ms;
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let abort: (() => void) | undefined;
      try {
        const completed = await Promise.race([
          done.then(() => true),
          new Promise<false>((resolve, reject) => {
            timer = setTimeout(
              () => resolve(false),
              Math.min(remaining, 2_147_483_647),
            );
            abort = () => reject(signal!.reason);
            signal?.addEventListener("abort", abort, { once: true });
            if (signal?.aborted) abort();
          }),
        ]);
        if (completed) return;
      } finally {
        if (timer) clearTimeout(timer);
        if (abort) signal?.removeEventListener("abort", abort);
      }
    }
  }

  async settle(conversationId?: string): Promise<void> {
    const owners = [...this.live.values()].filter(
      (owner) => !conversationId || owner.conversationId === conversationId,
    );
    for (const owner of owners) owner.controller.abort("run-ended");
    await Promise.all(owners.map((owner) => owner.done));
  }
}
