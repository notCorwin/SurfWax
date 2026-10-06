import type { EventLogger } from "../logging";
import type { JobContext } from "./jobs";

const chains = new Set([
  "ref",
  "locator",
  "frameLocator",
  "getByRole",
  "getByText",
  "getByLabel",
  "getByPlaceholder",
  "getByAltText",
  "getByTitle",
  "getByTestId",
  "filter",
  "first",
  "last",
  "nth",
]);
const reads = new Set([
  "snapshot",
  "inspect",
  "observe",
  "ensureObservation",
  "url",
  "title",
  "count",
  "textContent",
  "innerText",
  "inputValue",
  "getAttribute",
  "isVisible",
  "isEnabled",
  "isChecked",
  "isMultiple",
]);
const waits = new Set([
  "waitFor",
  "waitForEvent",
  "waitForURL",
  "waitForLoadState",
]);
const effects = new Set([
  "point",
  "upload",
  "press",
  "insertText",
  "goto",
  "reload",
  "goBack",
  "goForward",
  "evaluate",
  "click",
  "dblclick",
  "hover",
  "fill",
  "clear",
  "pressSequentially",
  "check",
  "uncheck",
  "selectOption",
  "dragTo",
  "setInputFiles",
  "focus",
  "blur",
  "scrollIntoViewIfNeeded",
  "accept",
  "dismiss",
  "setFiles",
]);
const metadata = new Set(["type", "message", "defaultValue", "isMultiple"]);

/** Per-program revocable capabilities. Mutation calls are ordered even inside Promise.all. */
export class ProgramScope {
  private tail: Promise<unknown> = Promise.resolve();
  private sequence = 0;
  private closed = false;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly subjects = new WeakMap<object, object>();
  private currentDispatch?: () => Promise<void>;
  private readonly uncertain = new Set<number>();
  constructor(
    readonly signal: AbortSignal,
    readonly jobId: string,
    private readonly context: JobContext,
    private readonly logger: EventLogger,
  ) {}

  guard(): void {
    this.signal.throwIfAborted();
    if (this.closed)
      throw new DOMException("Program capabilities expired", "AbortError");
  }
  async dispatched(): Promise<void> {
    await this.currentDispatch?.();
  }
  get effectUnknown(): boolean {
    return this.uncertain.size > 0;
  }

  private async event(
    operation: string,
    sequence: number,
    state: string,
    output?: unknown,
    error?: unknown,
  ) {
    const stored = await this.logger.append({
      type: "browser.job.progress",
      conversationId: this.context.conversationId,
      ...this.context.logIdentity,
      content: { jobId: this.jobId, sequence, operation, state },
      ...(output === undefined ? {} : { output }),
      ...(error === undefined ? {} : { error }),
    });
    if (!stored)
      throw new DOMException("Could not persist program receipt", "AbortError");
  }

  call<T>(
    operation: string,
    run: () => T | Promise<T>,
    effect = true,
    verified = false,
    subscribe = false,
    ordered = effect,
  ): Promise<T> {
    this.guard();
    const sequence = ++this.sequence;
    const work = async (): Promise<T> => {
      let dispatched = false;
      let dispatching: Promise<void> | undefined;
      const priorDispatch = this.currentDispatch;
      const mark = () =>
        (dispatching ??= (async () => {
          this.guard();
          await this.event(operation, sequence, "dispatched-unknown");
          this.guard();
          dispatched = true;
          this.uncertain.add(sequence);
        })());
      try {
        this.guard();
        // Event waits subscribe synchronously before an action can be dispatched. They must not take the mutation queue.
        const subscription = subscribe ? Promise.resolve(run()) : undefined;
        await this.event(operation, sequence, "not-dispatched");
        this.guard();
        if (effect) this.currentDispatch = mark;
        const result = await (subscription ?? run());
        this.guard();
        await this.event(
          operation,
          sequence,
          verified ? "verified" : "completed",
          result,
        );
        this.uncertain.delete(sequence);
        return result;
      } catch (error) {
        if (dispatched && error && typeof error === "object")
          Object.assign(error, { effectUnknown: true });
        await this.event(
          operation,
          sequence,
          dispatched ? "dispatched-unknown" : "not-dispatched",
          undefined,
          error,
        );
        throw error;
      } finally {
        if (this.currentDispatch === mark) this.currentDispatch = priorDispatch;
      }
    };
    const task = ordered ? this.tail.then(work) : work();
    if (ordered) this.tail = task.catch(() => undefined);
    this.pending.add(task);
    void task.then(
      () => this.pending.delete(task),
      () => this.pending.delete(task),
    );
    return task;
  }

  wrap<T extends object>(subject: T, label = "page"): T {
    const proxy = new Proxy(subject, {
      get: (target, key) => {
        if (key === "tabId" || key === "then") return Reflect.get(target, key);
        if (
          typeof key !== "string" ||
          ![...chains, ...reads, ...waits, ...effects, ...metadata].includes(
            key,
          )
        )
          return undefined;
        const value = Reflect.get(target, key);
        if (typeof value !== "function") return undefined;
        return (...args: unknown[]) => {
          this.guard();
          args = args.map((arg) => this.unwrap(arg));
          if (key === "filter" && args[0] && typeof args[0] === "object")
            args[0] = { ...args[0], has: this.unwrap((args[0] as any).has) };
          if (metadata.has(key)) return Reflect.apply(value, target, args);
          if (chains.has(key))
            return this.wrap(
              Reflect.apply(value, target, args),
              `${label}.${key}`,
            );
          const invoke = () => Reflect.apply(value, target, args);
          const result = this.call(
            `${label}.${key}`,
            invoke,
            effects.has(key),
            key === "waitFor" ||
              key === "waitForURL" ||
              key === "waitForLoadState",
            key === "waitForEvent",
            effects.has(key) &&
              !["accept", "dismiss", "setFiles"].includes(key),
          );
          return key === "waitForEvent"
            ? result.then((event: any) =>
                event &&
                typeof event === "object" &&
                (event.setFiles || event.accept || event.tabId)
                  ? this.wrap(event, "event")
                  : event,
              )
            : result;
        };
      },
    });
    this.subjects.set(proxy, subject);
    return proxy;
  }

  unwrap(value: unknown): any {
    return value && typeof value === "object"
      ? (this.subjects.get(value) ?? value)
      : value;
  }

  async emit(value: unknown): Promise<void> {
    this.guard();
    await this.event("emit", ++this.sequence, "completed", value);
  }
  async check(
    condition: unknown,
    message = "Program assertion failed",
  ): Promise<void> {
    await this.call(
      "check",
      () => {
        if (!condition) throw new Error(message);
      },
      false,
      true,
    );
  }
  async sleep(ms: number): Promise<void> {
    this.guard();
    if (!Number.isFinite(ms) || ms < 0)
      throw new Error("sleep requires nonnegative milliseconds");
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.signal.removeEventListener("abort", abort);
      };
      const abort = () => {
        cleanup();
        reject(this.signal.reason);
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve();
      }, ms);
      this.signal.addEventListener("abort", abort, { once: true });
      if (this.signal.aborted) abort();
    });
  }
  async finish(): Promise<void> {
    await Promise.allSettled([...this.pending]);
    this.closed = true;
  }
  revoke(): void {
    this.closed = true;
  }
}
