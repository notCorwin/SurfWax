import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { EventLogger, LogEvent } from "../logging";
import type { ModelConfig } from "../types";
import { ConversationView } from "./App";

const mock = vi.hoisted(() => ({
  state: { threadListItem: { id: "first", remoteId: "first" }, thread: { isRunning: false } },
  activeContext: vi.fn(), pressure: vi.fn(), summarize: vi.fn(), owner: vi.fn(), claim: vi.fn(),
}));
vi.mock("@/sidepanel/runtime-view", () => ({ usePanelState: (select: (state: typeof mock.state) => unknown) => select(mock.state), usePanelRuntime: () => ({}), RuntimeViewContext: {} }));
vi.mock("../components/chat/thread", () => ({ Thread: () => null }));
vi.mock("../agent/context-choice", () => ({ activeContext: mock.activeContext, ensureAutomaticContextSummary: mock.summarize }));
vi.mock("../agent/compaction", () => ({ contextPressure: mock.pressure }));
vi.mock("../agent/coordinator", () => ({
  activeRunIdentity: mock.owner, claimConversationRun: mock.claim,
  registerBackgroundRequest: () => () => {}, withIdleConversation: (action: () => unknown) => action(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const context = { raw: [], branchIds: [], events: [], checkpoint: undefined };
const config = { model: "test" } as ModelConfig;
let root: ReturnType<typeof createRoot>, host: HTMLDivElement;
let listeners: Set<(event: LogEvent) => void>;
let logger: EventLogger;
const drafts = new Map<string, string>();
const render = () => root.render(<ConversationView config={config} logger={logger} threadId={mock.state.threadListItem.id} drafts={drafts} goalMode={false} onGoalModeChange={() => {}} />);

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mock.state.threadListItem = { id: "first", remoteId: "first" }; mock.state.thread.isRunning = false;
  mock.activeContext.mockReset().mockResolvedValue(context);
  mock.pressure.mockReset().mockResolvedValue({ estimated: 1, threshold: 10, limit: { contextWindow: 100 } });
  mock.summarize.mockReset().mockResolvedValue(undefined);
  mock.owner.mockReset().mockResolvedValue(undefined);
  mock.claim.mockReset().mockResolvedValue({ signal: new AbortController().signal, finish: vi.fn() });
  listeners = new Set();
  logger = { subscribe: (listener: (event: LogEvent) => void) => { listeners.add(listener); return () => listeners.delete(listener); } } as unknown as EventLogger;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

it("assesses the newly selected conversation after an old assessment is cancelled", async () => {
  const old = deferred<typeof context>();
  mock.activeContext.mockReturnValueOnce(old.promise);
  await act(async () => render());
  expect(mock.activeContext).toHaveBeenCalledTimes(1);
  mock.state.threadListItem = { id: "second", remoteId: "second" };
  await act(async () => render());
  expect(mock.activeContext).toHaveBeenCalledTimes(1);
  await act(async () => { old.resolve(context); await old.promise; });
  expect(mock.activeContext).toHaveBeenCalledTimes(2);
  expect(mock.activeContext).toHaveBeenLastCalledWith(logger, "second");
});

it("retains a forced assessment requested while another is in flight", async () => {
  const old = deferred<typeof context>();
  mock.activeContext.mockReturnValueOnce(old.promise);
  await act(async () => render());
  await act(async () => { for (const listener of listeners) listener({ id: 1, timestamp: new Date().toISOString(), type: "conversation.failed", conversationId: "first", content: null, error: "context window exceeded" }); });
  await act(async () => { old.resolve(context); await old.promise; });
  expect(mock.activeContext).toHaveBeenCalledTimes(2);
  expect(mock.summarize).toHaveBeenCalledTimes(1);
  expect(mock.summarize.mock.calls[0]?.[4]).toMatchObject({ forced: true });
});

it("never starts an assessment during a running conversation", async () => {
  mock.state.thread.isRunning = true;
  await act(async () => render());
  await act(async () => { for (const listener of listeners) listener({ id: 1, timestamp: new Date().toISOString(), type: "conversation.failed", conversationId: "first", content: null, error: "context window exceeded" }); });
  expect(mock.activeContext).not.toHaveBeenCalled();
  mock.state.thread.isRunning = false;
  await act(async () => render());
  expect(mock.activeContext).toHaveBeenCalledTimes(1);
});
