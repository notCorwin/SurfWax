import { describe, expect, it, vi } from "vitest";
import { abortAllConversationWork, abortConversationWork, activeRunIdentity, claimConversationRun, registerBackgroundRequest } from "./coordinator";

describe("conversation run coordinator", () => {
  it("propagates background initialization errors instead of reporting an idle coordinator", async () => {
    const sendMessage = vi.fn(async () => ({ error: "IndexedDB unavailable" }));
    vi.stubGlobal("chrome", { runtime: { sendMessage } });
    try {
      await expect(activeRunIdentity()).rejects.toThrow("IndexedDB unavailable");
      expect(sendMessage).toHaveBeenCalledWith({ type: "surf-wax:run-status" });
    } finally { vi.unstubAllGlobals(); }
  });
  it("rejects a competing run without aborting the owner", async () => {
    const first = await claimConversationRun("first");
    await expect(claimConversationRun("second")).rejects.toThrow("已有任务运行");
    expect(first.signal.aborted).toBe(false);
    first.finish();
    const second = await claimConversationRun("second");
    second.finish();
  });

  it("aborts the active run and title requests when the panel closes", async () => {
    const run = await claimConversationRun("thread");
    const title = new AbortController();
    const finishTitle = registerBackgroundRequest(title);
    abortAllConversationWork();
    expect(run.signal.aborted).toBe(true);
    expect(title.signal.aborted).toBe(true);
    run.finish();
    finishTitle();
  });

  it("waits for the deleted conversation while leaving other title requests alone", async () => {
    const run = await claimConversationRun("deleted");
    const deletedTitle = new AbortController();
    const otherTitle = new AbortController();
    const finishDeletedTitle = registerBackgroundRequest(deletedTitle, "deleted");
    const finishOtherTitle = registerBackgroundRequest(otherTitle, "other");
    let settled = false;
    const abort = abortConversationWork("deleted").then(() => { settled = true; });
    await Promise.resolve();
    expect(run.signal.aborted).toBe(true);
    expect(deletedTitle.signal.aborted).toBe(true);
    expect(otherTitle.signal.aborted).toBe(false);
    expect(settled).toBe(false);
    run.finish();
    finishDeletedTitle();
    await abort;
    finishOtherTitle();
  });
});

it("rejects conversation mutations in both the owner and a non-owner panel", async () => {
  const { withIdleConversation } = await import("./coordinator");
  const action = vi.fn();
  const run = await claimConversationRun("owner");
  await expect(withIdleConversation(action)).rejects.toThrow("已有任务运行");
  run.finish();
  vi.stubGlobal("chrome", { runtime: { sendMessage: async () => ({ identity: { runId: "remote", ownerId: "other-panel", generation: 1 } }) } });
  await expect(withIdleConversation(action)).rejects.toThrow("已有任务运行");
  expect(action).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  await withIdleConversation(action);
  expect(action).toHaveBeenCalledOnce();
});

it("queues a run started by an idle edit until its command lease is released", async () => {
  const { withIdleConversation } = await import("./coordinator");
  let held = false;
  const waiters: (() => void)[] = [];
  const request = vi.fn(async (_name: string, options: { ifAvailable?: boolean }, callback: (lock: object | null) => Promise<void>) => {
    if (held && options.ifAvailable) return callback(null);
    if (held) await new Promise<void>((resolve) => waiters.push(resolve));
    held = true;
    try { return await callback({}); } finally { held = false; waiters.shift()?.(); }
  });
  vi.stubGlobal("navigator", { locks: { request } });
  try {
    let pending!: ReturnType<typeof claimConversationRun>;
    await withIdleConversation(() => { pending = claimConversationRun("edited"); });
    const run = await pending;
    expect(request.mock.calls[1]![1].ifAvailable).toBeUndefined();
    expect(run.signal.aborted).toBe(false);
    run.finish();
    await Promise.resolve();
  } finally { vi.unstubAllGlobals(); }
});

it("releases a pending ownership claim and its lock when cancelled before the worker replies", async () => {
  let held = false;
  const request = vi.fn(async (_name: string, _options: unknown, callback: (lock: object | null) => Promise<void>) => {
    if (held) return callback(null);
    held = true;
    try { return await callback({}); } finally { held = false; }
  });
  const ports: Array<{ postMessage: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>; reply: (message: unknown) => void }> = [];
  const connect = vi.fn(() => {
    const messages = new Set<(message: any) => void>();
    const disconnects = new Set<() => void>();
    const port = {
      onMessage: { addListener: (listener: (message: any) => void) => messages.add(listener), removeListener: (listener: (message: any) => void) => messages.delete(listener) },
      onDisconnect: { addListener: (listener: () => void) => disconnects.add(listener), removeListener: (listener: () => void) => disconnects.delete(listener) },
      postMessage: vi.fn(),
      disconnect: vi.fn(() => { for (const listener of disconnects) listener(); }),
      reply: (message: unknown) => { for (const listener of messages) listener(message); },
    };
    ports.push(port);
    return port;
  });
  vi.stubGlobal("navigator", { locks: { request } });
  vi.stubGlobal("chrome", { runtime: { connect } });
  try {
    const controller = new AbortController();
    const pending = claimConversationRun("first", controller.signal);
    await vi.waitFor(() => expect(ports[0]?.postMessage).toHaveBeenCalledOnce());
    const reason = new DOMException("stopped", "AbortError");
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    await vi.waitFor(() => expect(held).toBe(false));
    expect(ports[0]!.disconnect).toHaveBeenCalledOnce();

    const next = claimConversationRun("second");
    await vi.waitFor(() => expect(ports[1]?.postMessage).toHaveBeenCalledOnce());
    ports[1]!.reply({ type: "claimed", generation: 2 });
    const run = await next;
    expect(run.signal.aborted).toBe(false);
    run.finish();
    await vi.waitFor(() => expect(held).toBe(false));

    const invalid = claimConversationRun("invalid");
    await vi.waitFor(() => expect(ports[2]?.postMessage).toHaveBeenCalledOnce());
    ports[2]!.reply({ type: "claimed" });
    await expect(invalid).rejects.toThrow("无效的所有权");
    await vi.waitFor(() => expect(held).toBe(false));
    expect(ports[2]!.disconnect).toHaveBeenCalledOnce();
  } finally { vi.unstubAllGlobals(); }
});
