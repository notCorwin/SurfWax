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

/** Only controllers and completion notifications live in memory. All job state is a log projection. */
export class BrowserJobs {
  private readonly live = new Map<string, LiveJob>();
  constructor(private readonly logger?: EventLogger) {}

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
    await this.write(context, id, "queued");
    // Install the live owner before executing: status must never mistake a queued job for a lost host.
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    this.live.set(id, {
      controller,
      done,
      conversationId: context.conversationId,
    });
    void (async () => {
      try {
        const result = await execute(combined, id, () =>
          this.write(context, id, "running"),
        );
        combined.throwIfAborted();
        const failed =
          result && typeof result === "object" && (result as any).ok === false;
        await this.write(context, id, failed ? "failed" : "succeeded", result);
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
                  : "execution-failed",
              message: error instanceof Error ? error.message : String(error),
              retryable: false,
              ...((error as any)?.effectUnknown ? { effectUnknown: true } : {}),
            },
          },
        );
      } finally {
        this.live.delete(id);
        finish();
      }
    })().catch(() => {
      this.live.delete(id);
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

  private async events(conversationId: string): Promise<LogEvent[]> {
    if (!this.logger) throw new Error("Jobs require the canonical event log");
    return this.logger.jobEvents(conversationId);
  }

  async query(
    input: JobQuery,
    conversationId: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    signal?.throwIfAborted();
    let events = await this.events(conversationId);
    const states = () => {
      const result = new Map<string, { event: LogEvent; state: string }>();
      for (const event of events)
        if (event.type === "browser.job.state") {
          const value = fromLogValue(event.content) as any;
          result.set(value.jobId, { event, state: value.state });
        }
      return result;
    };
    // A host restart preserves receipts, not a JavaScript stack or a Promise. Never replay effects.
    for (const [id, entry] of states())
      if (!terminal.has(entry.state) && !this.live.has(id)) {
        await this.write(
          {
            conversationId,
            logIdentity: {
              runId: entry.event.runId,
              toolCallId: entry.event.toolCallId!,
              toolCallIdCanonical: true,
            },
          },
          id,
          "interrupted",
          {
            ok: false,
            error: {
              code: "host-lost",
              message:
                "Execution host ended; inspect receipts and page state before continuing",
              effectUnknown: entry.state !== "queued",
              retryable: false,
            },
          },
        );
      }
    events = await this.events(conversationId);
    if (input.action === "list")
      return { jobs: [...states()].map(([id, { state }]) => ({ id, state })) };
    const id = input.id;
    if (!id || !states().has(id))
      throw new Error("Job is unavailable in this conversation");
    const owner = this.live.get(id);
    if (input.action === "cancel") owner?.controller.abort("job-cancelled");
    if (input.action === "wait" && owner)
      await this.wait(owner.done, input.waitMs ?? 1000, signal);
    events = await this.events(conversationId);
    const entry = states().get(id)!;
    const matching = events.filter(
      (event) =>
        (fromLogValue(event.content) as any)?.jobId === id &&
        event.id > (input.after ?? 0),
    );
    const slice = matching.slice(0, input.limit ?? 50);
    return {
      id,
      state: entry.state,
      terminal: terminal.has(entry.state),
      ...(terminal.has(entry.state)
        ? {
            ok: entry.state === "succeeded",
            result: fromLogValue(entry.event.output),
          }
        : {}),
      events: slice.map((event) => ({
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
      nextCursor: slice.at(-1)?.id ?? input.after ?? 0,
      hasMore: matching.length > slice.length,
      ...(input.action === "cancel"
        ? { cancellationRequested: true, rollback: false }
        : {}),
    };
  }

  private async wait(
    done: Promise<void>,
    ms: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (ms <= 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      await Promise.race([
        done,
        new Promise<void>((resolve, reject) => {
          timer = setTimeout(resolve, Math.min(ms, 30_000));
          abort = () => reject(signal!.reason);
          signal?.addEventListener("abort", abort, { once: true });
          if (signal?.aborted) abort();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (abort) signal?.removeEventListener("abort", abort);
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
