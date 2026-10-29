import { LocatorFacade, PageFacade } from "./automation";
import { ProgramHandles } from "./program-handles";

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
  // Chrome 151 crashes an extension renderer when a Vite-served extension page
  // embeds a manifest sandbox. In development, host the same opaque worker
  // bridge in Vite's separate localhost renderer; production remains on the
  // packaged manifest sandbox with no network access.
  frame.src = import.meta.env.DEV
    ? `${__SURF_WAX_DEV_SERVER__}/@surf-wax/program-sandbox#${token}`
    : `${chrome.runtime.getURL("program-sandbox.html")}#${token}`;
  const channel = new MessageChannel();
  const objects = new ProgramHandles();
  const onTabRemoved = (tabId: number) => objects.closeTab(tabId);
  chrome.tabs.onRemoved.addListener(onTabRemoved);
  const inflight = new Set<Promise<unknown>>();
  const idOf = (value: object, tabId?: number) => objects.remember(value, tabId);
  const encode = (value: any, seen = new WeakSet<object>()): any => {
    if (typeof value === "function") return { $remoteFunction: idOf(value) };
    if (!value || typeof value !== "object") return value;
    if (value instanceof Date) return { $date: Number.isNaN(value.getTime()) ? null : value.toISOString() };
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return value;
    if (value instanceof PageFacade || value instanceof LocatorFacade)
      return {
        $remoteObject: {
          id: idOf(value, value.tabId),
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
    let result: any;
    if (value instanceof RegExp) {
      result = { $regexp: { source: value.source, flags: value.flags, lastIndex: encode(value.lastIndex, seen) } };
    } else if (value instanceof Map) {
      result = { $map: [...value].map(([key, item]) => [encode(key, seen), encode(item, seen)]) };
    } else if (value instanceof Set) {
      result = { $set: [...value].map((item) => encode(item, seen)) };
    } else if (Array.isArray(value)) {
      // Avoid scanning a huge sparse length when crossing the worker boundary.
      const keys = value.length > 32768 ? Object.keys(value).filter((key) => {
        const index = Number(key);
        return Number.isInteger(index) && index >= 0 && index < value.length && String(index) === key;
      }) : undefined;
      result = keys && keys.length < value.length
        ? { $sparseArray: { length: value.length, entries: keys.map((key) => [Number(key), encode(value[Number(key)], seen)]) } }
        : value.map((item) => encode(item, seen));
    } else {
      result = {
          $plainObject: Object.entries(value).map(([key, item]) => [
            key,
            encode(item, seen),
          ]),
        };
    }
    seen.delete(value);
    return result;
  };
  const resolve = (reference: {
    id: string;
    steps?: Array<{ key: string; args?: any[] }>;
  }): any => {
    let subject = objects.resolve(reference.id);
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
    if (Array.isArray(value)) return value.map(decode);
    if (value && typeof value === "object" && "$sparseArray" in value) {
      const result = new Array(value.$sparseArray.length);
      for (const [index, item] of value.$sparseArray.entries) result[index] = decode(item);
      return result;
    }
    if (value && typeof value === "object" && "$plainObject" in value)
      return Object.fromEntries(
        value.$plainObject.map(([key, item]: [string, unknown]) => [
          key,
          decode(item),
        ]),
      );
    if (value?.$regexp) {
      const regexp = new RegExp(value.$regexp.source, value.$regexp.flags);
      regexp.lastIndex = decode(value.$regexp.lastIndex);
      return regexp;
    }
    if (value && typeof value === "object" && "$date" in value) return value.$date === null ? new Date(NaN) : new Date(value.$date);
    if (value && typeof value === "object" && "$map" in value) return new Map(value.$map.map(([key, item]: [unknown, unknown]) => [decode(key), decode(item)]));
    if (value && typeof value === "object" && "$set" in value) return new Set(value.$set.map(decode));
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return value;
    if (value?.$remoteArgument) return resolve(value.$remoteArgument);
    if (value?.$function) return String(value.$function); // Page/locator evaluate takes source; never eval in the Side Panel.
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
    chrome.tabs.onRemoved.removeListener(onTabRemoved);
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
        if (message.type === "done") accept(decode(message.value));
      };
      channel.port1.start();
      document.body.append(frame);
      if (signal.aborted) abort();
    });
  } finally {
    cleanup();
  }
}
