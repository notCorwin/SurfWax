/** Opaque-origin sandbox page. The worker is disposable even when model code never yields. */
function workerMain() {
  const pending = new Map<
    string,
    { resolve: (value: any) => void; reject: (reason: any) => void }
  >();
  let requestSequence = 0;
  const lifetime = new AbortController();
  const drained = new Set<() => void>();
  self.addEventListener("unhandledrejection", (event: any) => {
    event.preventDefault();
    self.postMessage({
      type: "failed",
      error: {
        message: event.reason?.message ?? String(event.reason),
        effectUnknown: Boolean(event.reason?.effectUnknown),
      },
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
  const encode = (value: any): any => {
    if (value instanceof RegExp)
      return { $regexp: { source: value.source, flags: value.flags } };
    if (value instanceof Date) return { $date: value.toISOString() };
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return value;
    if (typeof value === "function" && !remotes.has(value))
      return { $function: String(value) };
    if (
      value &&
      (typeof value === "object" || typeof value === "function") &&
      remotes.has(value)
    )
      return { $remoteArgument: remotes.get(value) };
    if (Array.isArray(value)) return value.map(encode);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, encode(item)]),
      );
    return value;
  };
  const request = (reference: any, args: any[]) =>
    new Promise<any>((resolve, reject) => {
      const id = String(++requestSequence);
      pending.set(id, { resolve, reject });
      self.postMessage({ type: "rpc", id, reference, args: encode(args) });
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
    if (value?.$regexp)
      return new RegExp(value.$regexp.source, value.$regexp.flags);
    if (value?.$date) return new Date(value.$date);
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return value;
    if (value?.$remoteObject) return remote(value.$remoteObject);
    if (value?.$remoteFunction) {
      const fn = (...args: any[]) =>
        request({ id: value.$remoteFunction }, args);
      remotes.set(fn, { id: value.$remoteFunction, steps: [] });
      return fn;
    }
    if (Array.isArray(value)) return value.map(decode);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, decode(item)]),
      );
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
      if (pending.size === 0) {
        for (const notify of drained) notify();
        drained.clear();
      }
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
      if (pending.size)
        await new Promise<void>((resolve) => drained.add(resolve));
      await new Promise((resolve) => setTimeout(resolve, 0));
      self.postMessage({ type: "done", value: encode(result ?? null) });
    } catch (error: any) {
      self.postMessage({
        type: "failed",
        error: {
          message: error?.message ?? String(error),
          effectUnknown: Boolean(error?.effectUnknown),
        },
      });
    }
  };
}

const initialize = (event: MessageEvent) => {
  if (
    event.source !== parent ||
    event.origin !== new URL(location.href).origin ||
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
