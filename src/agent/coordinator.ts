export type RunIdentity = { runId: string; generation: number; ownerId: string };
type ActiveRun = RunIdentity & { conversationId: string; controller: AbortController; done: Promise<void>; finish: () => void };
let activeRun: ActiveRun | undefined;
let claiming = false;
let idleMutationDepth = 0;
let idleLockDepth = 0;
const backgroundControllers = new Map<AbortController, { conversationId?: string; done: Promise<void>; finish: () => void }>();
export const RUN_LOCK = "surf-wax:active-run";
export function getRunIdentity(): RunIdentity | undefined {
  return activeRun ? { runId: activeRun.runId, generation: activeRun.generation, ownerId: activeRun.ownerId } : undefined;
}
export async function activeRunIdentity(): Promise<RunIdentity | undefined> {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) return getRunIdentity();
  const response = await chrome.runtime.sendMessage({ type: "surf-wax:run-status" });
  if (response?.error) throw new Error(String(response.error));
  return response?.identity;
}

export const CONVERSATION_BUSY = "已有任务运行，请等待它完成或在原侧栏停止任务后再修改会话。";

/** The same extension-wide lease protects command entrances and storage mutations. */
export async function withIdleConversation<T>(action: () => T | Promise<T>): Promise<T> {
  const perform = async () => {
    if (activeRun || claiming || await activeRunIdentity()) throw new Error(CONVERSATION_BUSY);
    idleMutationDepth += 1;
    try { return await action(); } finally { idleMutationDepth -= 1; }
  };
  if (typeof navigator !== "undefined" && navigator.locks) {
    let acquired = false;
    try {
      return await navigator.locks.request(RUN_LOCK, { ifAvailable: true }, async (lock) => {
        if (!lock) throw new Error(CONVERSATION_BUSY);
        acquired = true; idleLockDepth += 1;
        return perform();
      });
    } finally { if (acquired) idleLockDepth -= 1; }
  }
  return perform();
}
export async function claimConversationRun(conversationId: string, signal?: AbortSignal, runId: string = crypto.randomUUID()): Promise<{ signal: AbortSignal; finish: () => void }> {
  signal?.throwIfAborted();
  if (activeRun || claiming) throw new Error("已有任务运行，请等待它完成或在原侧栏停止任务。");
  claiming = true;
  const queueBehindOwnMutation = idleMutationDepth > 0 || idleLockDepth > 0;
  const controller = new AbortController();
  let resolve!: () => void;
  const done = new Promise<void>((r) => { resolve = r; });
  let releaseLock: (() => void) | undefined;
  let port: chrome.runtime.Port | undefined;
  try {
    if (typeof navigator !== "undefined" && navigator.locks) {
      await new Promise<void>((accept, reject) => {
        void navigator.locks.request(RUN_LOCK, queueBehindOwnMutation ? { ...(signal ? { signal } : {}) } : { ifAvailable: true }, async (lock) => {
          if (!lock) { reject(new Error("已有任务运行，请在原侧栏停止任务后重试。")); return; }
          accept();
          await new Promise<void>((r) => { releaseLock = r; });
        }).catch(reject);
      });
    }
    signal?.throwIfAborted();
    const ownerId = crypto.randomUUID();
    let generation = 0;
    if (typeof chrome !== "undefined" && chrome.runtime?.connect) {
      port = chrome.runtime.connect({ name: "surf-wax-run-owner" });
      const connected = port;
      generation = await new Promise<number>((accept, reject) => {
        const disconnect = () => reject(new Error("后台运行协调器已断开，请重新打开侧栏。"));
        connected.onDisconnect.addListener(disconnect);
        connected.onMessage.addListener((message) => {
          if (message.type !== "claimed") return;
          connected.onDisconnect.removeListener(disconnect);
          if (message.error) reject(new Error(message.error)); else accept(message.generation);
        });
        void (async () => {
          const windowId = typeof chrome.windows?.getCurrent === "function" ? (await chrome.windows.getCurrent()).id : undefined;
          signal?.throwIfAborted();
          connected.postMessage({ type: "claim", runId, ownerId, conversationId, windowId });
        })().catch(reject);
      });
      connected.onDisconnect.addListener(() => controller.abort("worker-disconnected"));
      connected.onMessage.addListener((message) => { if (message.type === "abort") controller.abort(message.reason); });
    }
    let finished = false;
    const run: ActiveRun = { conversationId, runId, ownerId, generation, controller, done, finish: () => {
      if (finished) return;
      finished = true;
      if (activeRun === run) activeRun = undefined;
      try { port?.postMessage({ type: "finished", runId, ownerId, generation }); port?.disconnect(); } catch { /* Worker already stopped. */ }
      releaseLock?.();
      resolve();
    } };
    activeRun = run;
    const cancel = () => { try { port?.postMessage({ type: "cancelled", ...getRunIdentity() }); } catch { /* disconnected */ } };
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    combined.addEventListener("abort", cancel, { once: true });
    return { signal: combined, finish: run.finish };
  } catch (error) {
    port?.disconnect(); releaseLock?.(); throw error;
  } finally { claiming = false; }
}
export function registerBackgroundRequest(controller: AbortController, conversationId?: string): () => void {
  let resolve!: () => void;
  const entry = { conversationId, done: new Promise<void>((r) => { resolve = r; }), finish: resolve };
  backgroundControllers.set(controller, entry);
  return () => { backgroundControllers.delete(controller); entry.finish(); };
}
export async function abortConversationWork(conversationId: string, reason = "conversation-deleted"): Promise<void> {
  const run = activeRun?.conversationId === conversationId ? activeRun : undefined;
  const requests = [...backgroundControllers].filter(([, entry]) => entry.conversationId === conversationId);
  run?.controller.abort(reason);
  for (const [controller] of requests) controller.abort(reason);
  await Promise.all([...(run ? [run.done] : []), ...requests.map(([, entry]) => entry.done)]);
}
export function abortAllConversationWork(reason = "sidepanel-closed"): void {
  activeRun?.controller.abort(reason);
  for (const controller of backgroundControllers.keys()) controller.abort(reason);
}
export async function settleAllConversationWork(reason = "log-cleared"): Promise<void> {
  abortAllConversationWork(reason);
  await Promise.all([...(activeRun ? [activeRun.done] : []), ...[...backgroundControllers.values()].map((entry) => entry.done)]);
}
export function activeConversationId(): string | undefined { return activeRun?.conversationId; }

export async function waitForConversationRun(conversationId: string): Promise<void> {
  if (activeRun?.conversationId === conversationId) await activeRun.done;
}
