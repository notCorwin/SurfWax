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
