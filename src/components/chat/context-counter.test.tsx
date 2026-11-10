import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { EventLogger, type LogEvent } from "@/logging";
import { createMemoryEventStore } from "@/memory-event-store";
import { TooltipProvider } from "@/components/ui/tooltip";
import { activeContext, ensureAutomaticContextSummary } from "@/agent/context-choice";
import { contextPressure } from "@/agent/compaction";
import { ContextIndicator } from "./local-composer";

const runtime = vi.hoisted(() => {
  const state = { messages: [], isLoading: false, isRunning: false, isDisabled: false };
  const listeners = new Set<() => void>();
  return { state, listeners, view: { getState: () => state, thread: { subscribe: (listener: () => void) => {
    listeners.add(listener); return () => listeners.delete(listener);
  } } } };
});
vi.mock("@/sidepanel/runtime-view", () => ({ useRuntimeView: () => runtime.view }));
const config = { baseURL: "https://test/v1", model: "test", contextWindowOverride: 256_000 };
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); runtime.listeners.clear(); });

it("counts hidden refreshes, model supplements and goal reminders, then applies the canonical summary", async () => {
  const events: LogEvent[] = [];
  const logger = new EventLogger({ store: createMemoryEventStore(events) });
  await logger.appendMessage("one", { id: "u", role: "user", parts: [{ type: "text", text: "Preserve the requested outcome" }] }, { parentId: null });
  await logger.appendMessage("one", { id: "r", role: "user", metadata: { custom: { pageRefresh: true } }, parts: [{ type: "text", text: "<page-refresh>" + "visible page content ".repeat(6000) }] }, { parentId: "u" });
  await logger.appendMessage("one", { id: "a", role: "assistant", parts: [{ type: "text", text: "Progress" }] }, { parentId: "r" });
  await logger.append({ type: "model.context.appended", conversationId: "one", content: { anchorMessageId: "u", partCount: 1, message: { role: "user", content: "<browser-context>\nSupplemental state only.\nThe bound tab." } } });
  await logger.append({ type: "agent.goal.continued", conversationId: "one", content: { messageId: "a", offset: 1,
    assistantSegment: { id: "s", role: "assistant", parts: [{ type: "text", text: "Progress" }] },
    reminderMessage: { id: "g", role: "user", parts: [{ type: "text", text: "Goal mode is still active. Continue the original requirement." }] } } });
  const canonical = await activeContext(logger, "one");
  const expected = await contextPressure({ ...canonical, model: config, goalMode: true });
  await act(async () => root.render(<TooltipProvider><ContextIndicator config={config} logger={logger} conversationId="one" goalMode /></TooltipProvider>));
  await vi.waitFor(async () => {
    await act(async () => {});
    expect(host.querySelector('[role="progressbar"]')?.getAttribute("aria-label")).toContain(`${expected!.estimated.toLocaleString("zh-CN")} /`);
  });
  expect(expected!.estimated).toBeGreaterThan(35_000);
  const projection = vi.spyOn(logger, "contextProjectionEvents");
  await act(async () => { for (const listener of runtime.listeners) listener(); });
  expect(projection).not.toHaveBeenCalled();
  const languageModel = new MockLanguageModelV4({ doGenerate: async () => ({
    content: [{ type: "text", text: "The requested outcome and the page findings are preserved." }], finishReason: { unified: "stop", raw: "stop" },
    usage: { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } }, warnings: [],
  }) });
  await act(async () => { await ensureAutomaticContextSummary(logger, "one", config, new AbortController().signal, { languageModel, forced: true, goalMode: true }); });
  const compacted = await activeContext(logger, "one");
  expect(compacted.checkpoint).toBeDefined();
  const after = await contextPressure({ ...compacted, model: config, goalMode: true });
  expect(after!.estimated).toBeLessThan(expected!.estimated - 30_000);
  await vi.waitFor(async () => {
    await act(async () => {});
    expect(host.querySelector('[role="progressbar"]')?.getAttribute("aria-label")).toContain(`${after!.estimated.toLocaleString("zh-CN")} /`);
  });
});

it("invalidates the canonical estimate after another writer commits without a UI loading change", async () => {
  const storage = createMemoryEventStore();
  const logger = new EventLogger({ store: storage });
  const other = new EventLogger({ store: storage });
  await logger.appendMessage('remote', { id: 'u', role: 'user', parts: [{ type: 'text', text: 'start' }] });
  await act(async () => root.render(<TooltipProvider><ContextIndicator config={config} logger={logger} conversationId="remote" /></TooltipProvider>));
  await vi.waitFor(async () => { await act(async () => {}); expect(host.querySelector('[role="progressbar"]')?.getAttribute('aria-label')).toContain('tokens'); });
  const before = host.querySelector('[role="progressbar"]')!.getAttribute('aria-label');
  await act(async () => { await other.appendMessage('remote', { id: 'a', role: 'assistant', parts: [{ type: 'text', text: 'remote canonical progress '.repeat(1000) }] }, { parentId: 'u' }); });
  const canonical = await activeContext(logger, 'remote');
  const expected = await contextPressure({ ...canonical, model: config });
  await vi.waitFor(async () => {
    await act(async () => {});
    const label = host.querySelector('[role="progressbar"]')!.getAttribute('aria-label');
    expect(label).not.toBe(before);
    expect(label).toContain(expected!.estimated.toLocaleString('zh-CN'));
  });
  await logger.dispose(); await other.dispose();
});
