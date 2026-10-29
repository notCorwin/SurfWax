import { LocatorFacade, PageFacade } from "./automation";
import { DeferredProgramPage, ProgramHandles } from "./program-handles";
import { createProgramCodec } from "./program-codec";

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
  const { encode, decode } = createProgramCodec((value) => {
    if (typeof value === "function") return { value: { $remoteFunction: idOf(value) } };
    if (value instanceof DeferredProgramPage)
      return { value: { $remoteObject: { id: idOf(value, value.tabId), ...(value.tabId === undefined ? {} : { tabId: value.tabId }) } } };
    if (value instanceof PageFacade || value instanceof LocatorFacade)
      return { value: { $remoteObject: { id: idOf(value, value.tabId), ...(value.tabId === undefined ? {} : { tabId: value.tabId }) } } };
    if (typeof value.accept === "function" || typeof value.setFiles === "function") {
      const metadata: Record<string, unknown> = {};
      for (const key of ["type", "message", "defaultValue", "isMultiple"])
        if (typeof value[key] === "function") metadata[key] = value[key]();
      return { value: { $remoteObject: { id: idOf(value), metadata } } };
    }
    return undefined;
  }, (value) => {
    if ("$remoteArgument" in value) return { value: resolve(value.$remoteArgument) };
    if ("$function" in value) return { value: String(value.$function) };
    return undefined;
  });
  const resolve = (reference: {
    id: string;
    steps?: Array<{ key: string; args?: any[] }>;
  }): any => {
    let subject = objects.resolve(reference.id);
    if (subject instanceof DeferredProgramPage) subject = subject.bound();
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
  // Locator arguments may themselves refer to the initial page, including
  // references nested in a cyclic bridge value. Bind before synchronous decode.
  const bindReferences = async (reference: { id: string; steps?: unknown }, args: unknown): Promise<void> => {
    const pages = new Set<DeferredProgramPage>();
    const consider = (id: string) => { const object = objects.resolve(id); if (object instanceof DeferredProgramPage) pages.add(object); };
    consider(reference.id);
    const seen = new WeakSet<object>();
    const visit = (value: unknown): void => {
      if (!value || typeof value !== "object" || seen.has(value) || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return;
      seen.add(value);
      if ("$remoteArgument" in value) {
        const remote = (value as { $remoteArgument: { id: string } }).$remoteArgument;
        consider(remote.id);
      }
      for (const child of Object.values(value)) visit(child);
    };
    visit(reference.steps); visit(args);
    await Promise.all([...pages].map((page) => page.bind()));
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
              await bindReferences(message.reference, message.args);
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
