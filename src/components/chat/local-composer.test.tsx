import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { EventLogger, LogEvent } from "@/logging";
import type { ModelConfig } from "@/types";
import { TooltipProvider } from "@/components/ui/tooltip";
import { LocalComposer } from "./local-composer";

const mock = vi.hoisted(() => {
  const thread = { messages: [], isLoading: false, isRunning: true, isDisabled: false };
  const state = { thread, composer: { text: "" } };
  const runtime = { getState: () => state, subscribe: () => () => {}, thread: { getState: () => thread, subscribe: () => () => {}, cancelRun: () => {}, append: () => Promise.resolve() }, composer: { setText: () => {}, send: () => {} } };
  return { state, runtime, view: { runtime, thread: runtime.thread, getState: runtime.thread.getState } };
});
vi.mock("@/sidepanel/runtime-view", () => ({
  usePanelRuntime: () => mock.runtime,
  usePanelState: (select: (state: typeof mock.state) => unknown) => select(mock.state),
  useRuntimeView: () => mock.view,
}));
vi.mock("@/sidepanel/useRunState", () => ({ useRunState: () => ({ locked: true }) }));
vi.mock("@/agent/reasoning", () => {
  const state = { selected: null, choices: [], ready: true };
  return { reasoningSettingsFor: () => ({ subscribe: () => () => {}, snapshot: () => state, select: () => {} }) };
});
vi.mock("@/agent/model-limits", () => ({ resolveModelLimit: async () => null, contextUsedPercent: () => 0, inputBudget: () => 0 }));

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const config = { model: "test" } as ModelConfig;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}
function loggerWith(append: (record: unknown) => Promise<LogEvent | undefined>): EventLogger {
  return { append, subscribe: () => () => {}, followupEvents: async () => [], modelUsageEvents: async () => [], contextEvents: async () => [], repository: async () => ({ messages: [] }) } as unknown as EventLogger;
}
async function mount(logger: EventLogger) {
  await act(async () => root.render(<TooltipProvider><LocalComposer config={config} logger={logger} conversationId="one" draft="keep this message" onDraftChange={() => {}} goalMode={false} onGoalModeChange={() => {}} /></TooltipProvider>));
}
function input() { return host.querySelector<HTMLTextAreaElement>("[data-testid=composer-input]")!; }
async function send() { await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="排队消息"]')!.click(); }); }

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); mock.state.thread.isRunning = true; vi.restoreAllMocks(); });

it.each(["rejected", "unavailable"])("keeps the draft and reports a %s queue write", async (outcome) => {
  const pending = deferred<LogEvent | undefined>();
  await mount(loggerWith(() => pending.promise));
  await send();
  expect(input().value).toBe("keep this message");
  expect(host.querySelector<HTMLButtonElement>('[aria-label="排队消息"]')!.disabled).toBe(true);
  await act(async () => { if (outcome === "rejected") pending.reject(new Error("disk failed")); else pending.resolve(undefined); await pending.promise.catch(() => undefined); });
  expect(input().value).toBe("keep this message");
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("消息未能加入队列");
  expect(host.querySelector<HTMLButtonElement>('[aria-label="排队消息"]')!.disabled).toBe(false);
});

it("clears the submitted draft only after a durable queue write", async () => {
  const pending = deferred<LogEvent | undefined>();
  await mount(loggerWith(() => pending.promise));
  await send();
  expect(input().value).toBe("keep this message");
  await act(async () => { pending.resolve({ id: 1 } as LogEvent); await pending.promise; });
  expect(input().value).toBe("");
});

it("does not erase edits made while a queue write is pending", async () => {
  const pending = deferred<LogEvent | undefined>();
  await mount(loggerWith(() => pending.promise));
  await send();
  await act(async () => { input().value = "new draft"; });
  await act(async () => { pending.resolve({ id: 1 } as LogEvent); await pending.promise; });
  expect(input().value).toBe("new draft");
});

it("keeps a failed dispatch in the queue without retrying until requested", async () => {
  mock.state.thread.isRunning = false;
  const append = vi.spyOn(mock.runtime.thread, "append").mockRejectedValue(new Error("run unavailable"));
  const logger = loggerWith(async () => undefined);
  logger.followupEvents = async () => [
    { id: 1, type: "conversation.followup.queued", timestamp: new Date().toISOString(), conversationId: "one", content: { id: "pending", text: "saved message", createdAt: new Date().toISOString() } },
    { id: 2, type: "conversation.finished", timestamp: new Date().toISOString(), conversationId: "one", content: null },
  ];
  await mount(logger);
  expect(append).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain("排队消息未能发送");
  expect(host.querySelector('[data-testid="followup-item"]')?.textContent).toContain("saved message");
  await act(async () => root.render(<TooltipProvider><LocalComposer config={config} logger={logger} conversationId="one" draft="keep this message" onDraftChange={() => {}} goalMode={false} onGoalModeChange={() => {}} /></TooltipProvider>));
  expect(append).toHaveBeenCalledTimes(1);
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="立即发送"]')!.click());
  expect(append).toHaveBeenCalledTimes(2);
  expect(host.querySelector('[data-testid="followup-item"]')?.textContent).toContain("saved message");
});
