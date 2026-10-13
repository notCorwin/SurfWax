import { LocatorFacade, PageFacade } from "./automation";

/** Control stays in the Side Panel. Arbitrary program computation runs only in a disposable sandbox worker. */
export async function executeSandboxProgram(
  code: string,
  capabilities: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  signal.throwIfAborted();
  const frame = document.createElement("iframe");
  const token = crypto.randomUUID();
  frame.hidden = true;
  frame.src = `${chrome.runtime.getURL("program-sandbox.html")}#${token}`;
  const channel = new MessageChannel();
  const objects = new Map<string, any>();
  const ids = new WeakMap<object, string>();
  const inflight = new Set<Promise<unknown>>();
  const idOf = (value: object) => {
    let id = ids.get(value);
    if (!id) {
      id = crypto.randomUUID();
      ids.set(value, id);
      objects.set(id, value);
    }
    return id;
  };
  const encode = (value: any, seen = new WeakSet<object>()): any => {
    if (typeof value === "function") return { $remoteFunction: idOf(value) };
    if (!value || typeof value !== "object") return value;
    if (value instanceof RegExp)
      return { $regexp: { source: value.source, flags: value.flags } };
    if (value instanceof Date) return { $date: value.toISOString() };
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return value;
    if (value instanceof PageFacade || value instanceof LocatorFacade)
      return {
        $remoteObject: {
          id: idOf(value),
          ...(value.tabId === undefined ? {} : { tabId: value.tabId }),
        },
      };
    if (
      typeof value.accept === "function" ||
      typeof value.setFiles === "function"
    ) {
      const metadata: Record<string, unknown> = {};
      for (const key of ["type", "message", "defaultValue", "isMultiple"])
        if (typeof value[key] === "function") metadata[key] = value[key]();
      return { $remoteObject: { id: idOf(value), metadata } };
    }
    if (seen.has(value))
      throw new Error(
        "Program bridge requires serializable values or browser capability handles",
      );
    seen.add(value);
    const result = Array.isArray(value)
      ? value.map((item) => encode(item, seen))
      : Object.fromEntries(
          Object.entries(value).map(([key, item]) => [key, encode(item, seen)]),
        );
    seen.delete(value);
    return result;
  };
  const resolve = (reference: {
    id: string;
    steps?: Array<{ key: string; args?: any[] }>;
  }): any => {
    if (!objects.has(reference.id))
      throw new Error("Program capability handle expired");
    let subject = objects.get(reference.id);
    for (const { key, args } of reference.steps ?? []) {
      if (
        key.startsWith("_") ||
        ["constructor", "prototype", "__proto__"].includes(key)
      )
        throw new Error("Invalid program capability member");
      const member = subject[key];
      if (member === undefined)
        throw new Error(`Unsupported program capability: ${key}`);
      subject = args
        ? Reflect.apply(member, subject, decode(args))
        : typeof member === "function"
          ? member.bind(subject)
          : member;
    }
    return subject;
  };
  const decode = (value: any): any => {
    if (value?.$regexp)
      return new RegExp(value.$regexp.source, value.$regexp.flags);
    if (value?.$date) return new Date(value.$date);
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return value;
    if (value?.$remoteArgument) return resolve(value.$remoteArgument);
    if (value?.$function) return String(value.$function); // Page/locator evaluate takes source; never eval in the Side Panel.
    if (Array.isArray(value)) return value.map(decode);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, decode(item)]),
      );
    return value;
  };
  let disposed = false;
  let abortTimer: ReturnType<typeof setTimeout> | undefined;
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    if (abortTimer) clearTimeout(abortTimer);
    channel.port1.postMessage({ type: "dispose" });
    channel.port1.close();
    frame.remove();
    objects.clear();
    signal.removeEventListener("abort", abort);
  };
  let reject!: (error: unknown) => void;
  const abort = () => {
    if (disposed || abortTimer !== undefined) return;
    channel.port1.postMessage({
      type: "abort",
      reason: String(signal.reason ?? "Program aborted"),
    });
    // Give yielding programs a chance to observe signal, then terminate even synchronous loops.
    abortTimer = setTimeout(() => {
      cleanup();
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new DOMException(
              String(signal.reason ?? "Program aborted"),
              "AbortError",
            ),
      );
    }, 10);
  };
  try {
    return await new Promise<unknown>((accept, fail) => {
      reject = fail;
      signal.addEventListener("abort", abort, { once: true });
      frame.onerror = () => fail(new Error("Program sandbox could not load"));
      frame.onload = () => {
        if (disposed) return;
        frame.contentWindow!.postMessage(
          { type: "surf-wax:program-init", token },
          "*",
          [channel.port2],
        );
      };
      channel.port1.onmessage = (event) => {
        const message = event.data;
        if (disposed) return;
        if (signal.aborted) return;
        if (message.type === "ready") {
          try {
            channel.port1.postMessage({
              type: "run",
              code,
              capabilities: encode(capabilities),
            });
          } catch (error) {
            fail(error);
          }
          return;
        }
        if (message.type === "rpc") {
          const task = (async () => {
            try {
              signal.throwIfAborted();
              const operation = resolve(message.reference);
              if (
                typeof operation !== "function" ||
                !Array.isArray(message.args)
              )
                throw new Error("Invalid program capability call");
              const value = await operation(...decode(message.args));
              signal.throwIfAborted();
              if (!disposed)
                channel.port1.postMessage({
                  type: "rpc-result",
                  id: message.id,
                  value: encode(value),
                });
            } catch (error: any) {
              if (!disposed)
                channel.port1.postMessage({
                  type: "rpc-result",
                  id: message.id,
                  error: {
                    message: error?.message ?? String(error),
                    name: error?.name,
                    code: error?.code,
                    ...(error?.artifact ? { artifact: error.artifact } : {}),
                    effectUnknown: Boolean(error?.effectUnknown),
                  },
                });
              throw error;
            }
          })();
          inflight.add(task);
          void task.then(
            () => inflight.delete(task),
            () => inflight.delete(task),
          );
          return;
        }
        if (message.type === "failed") {
          fail(
            Object.assign(
              new Error(message.error?.message ?? "Program failed"),
              message.error,
            ),
          );
          return;
        }
        if (message.type === "done")
          void Promise.allSettled([...inflight]).then((results) => {
            const failure = results.find(
              (result) => result.status === "rejected",
            );
            if (failure?.status === "rejected") fail(failure.reason);
            else accept(decode(message.value));
          }, fail);
      };
      channel.port1.start();
      document.body.append(frame);
      if (signal.aborted) abort();
    });
  } finally {
    cleanup();
  }
}
