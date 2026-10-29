/** Opaque-origin sandbox page. The worker is disposable even when model code never yields. */
function workerMain() {
  const pending = new Map<
    string,
    { resolve: (value: any) => void; reject: (reason: any) => void }
  >();
  let requestSequence = 0;
  const lifetime = new AbortController();
  const describeError = (error: any) => ({
    message: error?.message ?? String(error),
    name: error?.name,
    code: error?.code,
    ...(error?.artifact ? { artifact: error.artifact } : {}),
    effectUnknown: Boolean(error?.effectUnknown),
  });
  self.addEventListener("unhandledrejection", (event: any) => {
    event.preventDefault();
    self.postMessage({
      type: "failed",
      error: describeError(event.reason),
    });
  });
  const close = self.close.bind(self);
  self.close = () => {
    self.postMessage({
      type: "failed",
      error: { message: "Program worker exited" },
    });
    close();
  };
  const remotes = new WeakMap<object, any>();
  const chains = new Set([
    "ref",
    "locator",
    "frameLocator",
    "frameRef",
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
  const encode = (value: any, seen = new WeakSet<object>(), allowSource = false): any => {
    if (value instanceof Date) return { $date: Number.isNaN(value.getTime()) ? null : value.toISOString() };
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return value;
    if (typeof value === "function" && !remotes.has(value)) {
      if (!allowSource) throw new Error("Program bridge cannot serialize functions as data");
      return { $function: String(value) };
    }
    if (
      value &&
      (typeof value === "object" || typeof value === "function") &&
      remotes.has(value)
    )
      return { $remoteArgument: remotes.get(value) };
    if (!value || typeof value !== "object") return value;
    if (seen.has(value)) throw new Error("Program bridge requires serializable values or browser capability handles");
    seen.add(value);
    let result: any;
    if (value instanceof RegExp) {
      result = { $regexp: { source: value.source, flags: value.flags, lastIndex: encode(value.lastIndex, seen) } };
    } else if (value instanceof Map) {
      result = { $map: [...value].map(([key, item]) => [encode(key, seen), encode(item, seen)]) };
    } else if (value instanceof Set) {
      result = { $set: [...value].map((item) => encode(item, seen)) };
    } else if (Array.isArray(value)) {
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
  const request = (reference: any, args: any[]) =>
    new Promise<any>((resolve, reject) => {
      const isEvaluate = reference.steps?.at(-1)?.key === "evaluate";
      const encoded = args.map((value, index) => encode(value, new WeakSet(), isEvaluate && index === 0));
      const id = String(++requestSequence);
      pending.set(id, { resolve, reject });
      try { self.postMessage({ type: "rpc", id, reference, args: encoded }); }
      catch (error) { pending.delete(id); throw error; }
    });
  const remote = (descriptor: any, steps: any[] = []): any => {
    const reference = { id: descriptor.id, steps };
    const result = new Proxy(
      {},
      {
        get: (_target, key) => {
          if (key === "then") return undefined;
          if (key === "tabId") return descriptor.tabId;
          if (
            typeof key !== "string" ||
            key.startsWith("_") ||
            ["constructor", "prototype", "__proto__"].includes(key)
          )
            return undefined;
          if (descriptor.metadata && key in descriptor.metadata)
            return () => descriptor.metadata[key];
          if (key === "keyboard" || key === "mouse")
            return remote(descriptor, [...steps, { key }]);
          return (...args: any[]) =>
            chains.has(key)
              ? remote(descriptor, [...steps, { key, args: encode(args) }])
              : request({ ...reference, steps: [...steps, { key }] }, args);
        },
      },
    );
    remotes.set(result, reference);
    return result;
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
    if (value?.$remoteObject) return remote(value.$remoteObject);
    if (value?.$remoteFunction) {
      const fn = (...args: any[]) =>
        request({ id: value.$remoteFunction }, args);
      remotes.set(fn, { id: value.$remoteFunction, steps: [] });
      return fn;
    }
    return value;
  };
  self.onmessage = async (event) => {
    const message = event.data;
    if (message.type === "abort") {
      lifetime.abort(new DOMException(message.reason, "AbortError"));
      return;
    }
    if (message.type === "rpc-result") {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if (message.error)
        waiter?.reject(
          Object.assign(new Error(message.error.message), message.error),
        );
      else waiter?.resolve(decode(message.value));
      return;
    }
    if (message.type !== "run") return;
    try {
      const values = decode(message.capabilities);
      const signal = lifetime.signal;
      const AsyncFunction = Object.getPrototypeOf(
        async function () {},
      ).constructor;
      const execute = new AsyncFunction(
        "page",
        "browser",
        "net",
        "protocol",
        "artifacts",
        "emit",
        "check",
        "sleep",
        "signal",
        message.code,
      );
      const result = await execute(
        values.page,
        values.browser,
        values.net,
        values.protocol,
        values.artifacts,
        values.emit,
        values.check,
        values.sleep,
        signal,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      self.postMessage({ type: "done", value: encode(result) });
    } catch (error: any) {
      self.postMessage({
        type: "failed",
        error: describeError(error),
      });
    }
  };
}

const initialize = (event: MessageEvent) => {
  if (
    event.source !== parent ||
    (!import.meta.env.DEV && event.origin !== new URL(location.href).origin) ||
    event.data?.type !== "surf-wax:program-init" ||
    event.data.token !== location.hash.slice(1) ||
    event.ports.length !== 1
  )
    return;
  window.removeEventListener("message", initialize);
  const port = event.ports[0]!;
  const blob = new Blob([`(${workerMain.toString()})()`], {
    type: "text/javascript",
  });
  const url = URL.createObjectURL(blob);
  const worker = new Worker(url, { name: "surf-wax-program" });
  URL.revokeObjectURL(url);
  const cleanup = () => {
    worker.terminate();
    port.close();
  };
  worker.onmessage = (reply) => port.postMessage(reply.data);
  worker.onerror = (error) =>
    port.postMessage({ type: "failed", error: { message: error.message } });
  port.onmessage = (request) => {
    if (request.data?.type === "dispose") cleanup();
    else worker.postMessage(request.data);
  };
  port.start();
  port.postMessage({ type: "ready" });
};
window.addEventListener("message", initialize);
