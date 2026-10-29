import { fromLogValue, type EventLogger, type LogEvent } from "../logging";

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
};
type LiveJob = {
  controller: AbortController;
  done: Promise<void>;
  conversationId: string;
};
const terminal = new Set(["succeeded", "failed", "cancelled", "interrupted"]);
type StateEntry = {
  id: number;
  state: string;
  runId?: string;
  toolCallId?: string;
};
type ProjectedJob = {
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
    const saved = await this.logger?.append({
      type: "browser.job.state",
      conversationId: context.conversationId,
      ...context.logIdentity,
      content: { jobId: id, state },
      ...(output === undefined ? {} : { output }),
    });
    if (!saved) throw new Error("Could not persist browser job state");
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
    const content = fromLogValue(event.content) as {
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
        if ((fromLogValue(event.content) as any)?.jobId === id)
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
            if ((fromLogValue(event.content) as any)?.jobId === input.id)
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
          if (!projection.historyEvicted) {
            return { jobs: [...projection.jobs].flatMap(([id, job]) =>
              job.state ? [{ id, state: job.state.state }] : [],
            ) };
          }
          // The existing list contract returns all jobs, so the result itself
          // is necessarily proportional to history; do not retain it as an index.
          const states = new Map<string, string>();
          const valid = await this.scan(conversationId, epoch, upper, signal, (event) => {
            if (event.type !== "browser.job.state") return;
            const content = fromLogValue(event.content) as { jobId?: unknown; state?: unknown } | null;
            if (typeof content?.jobId === "string" && typeof content.state === "string") states.set(content.jobId, content.state);
          });
          if (!valid) continue;
          return { jobs: [...states].map(([id, state]) => ({ id, state })) };
        }
        const id = input.id;
        let job = id ? projection.jobs.get(id) : undefined;
        if (id && !job?.state) {
          let rebuilt: ProjectedJob | undefined;
          const valid = await this.scan(conversationId, epoch, upper, signal, (event) => {
            const content = fromLogValue(event.content) as { jobId?: unknown; state?: unknown } | null;
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
        if (
          records.some(
            (event) => (fromLogValue(event.content) as any)?.jobId !== id,
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
                result: fromLogValue(stateEvent.output),
              }
            : {}),
          events: entries.map((event) => ({
            cursor: event.id,
            type: event.type,
            ...(fromLogValue(event.content) as object),
            ...(event.output === undefined
              ? {}
              : { output: fromLogValue(event.output) }),
            ...(event.error === undefined
              ? {}
              : { error: fromLogValue(event.error) }),
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
