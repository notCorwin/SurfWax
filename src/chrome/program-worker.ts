import type { createProgramCodec } from "./program-codec";

export function programWorkerMain(codecFactory: typeof createProgramCodec) {
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
    "elementById",
  "ref",
    "locator",
    "uniqueScope",
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
  const { encode, decode } = codecFactory((value, allowSource) => {
    if (remotes.has(value)) return { value: { $remoteArgument: remotes.get(value) } };
    if (typeof value === "function" && allowSource) return { value: { $function: String(value) } };
    return undefined;
  }, (value) => {
    if ("$remoteObject" in value) return { value: remote(value.$remoteObject) };
    if ("$remoteFunction" in value) {
      const fn = (...args: any[]) => request({ id: value.$remoteFunction }, args);
      remotes.set(fn, { id: value.$remoteFunction, steps: [] });
      return { value: fn };
    }
    return undefined;
  });
  const request = (reference: any, args: any[]) =>
    new Promise<any>((resolve, reject) => {
      const isEvaluate = reference.steps?.at(-1)?.key === "evaluate";
      const seen = new WeakMap<object, any>();
      const encoded = args.map((value, index) => encode(value, seen, isEvaluate && index === 0));
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
        "artifacts",
        "sleep",
        "signal",
        message.code,
      );
      const result = await execute(
        values.page,
        values.browser,
        values.net,
        values.artifacts,
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
