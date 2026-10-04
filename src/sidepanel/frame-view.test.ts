import { describe, expect, it, vi } from "vitest";
import { createFrameView } from "./frame-view";

describe("frame projection", () => {
  it("publishes only the latest response once per frame without dropping source events", () => {
    let state = 0;
    let changed!: () => void;
    let frame!: FrameRequestCallback;
    const schedule = vi.fn((callback: FrameRequestCallback) => { frame = callback; return 7; });
    const unsubscribe = vi.fn();
    const source = { getState: () => state, subscribe: (listener: () => void) => { changed = listener; return unsubscribe; } };
    const view = createFrameView(source, schedule, vi.fn());
    const listener = vi.fn(); view.subscribe(listener);
    for (state = 1; state <= 100; state++) changed();
    state = 100;
    expect(schedule).toHaveBeenCalledOnce(); expect(view.getSnapshot()).toBe(0);
    frame(8.33);
    expect(view.getSnapshot()).toBe(100); expect(listener).toHaveBeenCalledOnce();
    state = 101; changed(); frame(16.66);
    expect(view.getSnapshot()).toBe(101); expect(listener).toHaveBeenCalledTimes(2);
    view.dispose(); expect(unsubscribe).toHaveBeenCalledOnce();
  });
  it("cancels pending publication when the panel unmounts", () => {
    const cancel = vi.fn(); let changed!: () => void;
    const view = createFrameView({ getState: () => ({}), subscribe: (listener) => { changed = listener; return vi.fn(); } }, () => 42, cancel);
    const listener = vi.fn(); view.subscribe(listener); changed(); view.dispose();
    expect(cancel).toHaveBeenCalledExactlyOnceWith(42); expect(listener).not.toHaveBeenCalled();
  });
  it("subscribes only after commit and can reconnect after effect cleanup", () => {
    const unsubscribe = vi.fn();
    const source = { getState: () => 0, subscribe: vi.fn(() => unsubscribe) };
    const view = createFrameView(source, vi.fn(), vi.fn());
    expect(source.subscribe).not.toHaveBeenCalled();
    view.subscribe(vi.fn())(); view.dispose();
    expect(unsubscribe).toHaveBeenCalledOnce();
    view.subscribe(vi.fn()); expect(source.subscribe).toHaveBeenCalledTimes(2);
    view.dispose(); expect(unsubscribe).toHaveBeenCalledTimes(2);
  });
});

import type { AssistantRuntime, ThreadRuntime } from "@assistant-ui/react";
import { commandRuntime, createThreadView } from "./runtime-view";

it("keeps all runtime history while command clients avoid historic message subscriptions", () => {
  let state: any = { isRunning: true, messages: Array.from({ length: 1000 }, (_, index) => ({ id: String(index), role: "assistant", content: [{ type: "text", text: String(index) }] })) };
  const getMessageByIndex = vi.fn((index: number) => ({
    getState: () => ({ ...state.messages[index], index, isLast: index === state.messages.length - 1, branchNumber: 1, branchCount: 1 }),
    getMessagePartByIndex: (part: number) => ({ getState: () => ({ ...state.messages[index].content[part], status: { type: "complete" } }) }),
  }));
  const thread = { getState: () => state, getMessageByIndex } as unknown as ThreadRuntime;
  const runtime = { thread, threads: { main: thread } } as AssistantRuntime;
  const commands = commandRuntime(runtime);
  const view = createThreadView(thread);
  expect(commands.thread.getState().messages).toHaveLength(0);
  expect(commands.thread.getState()).toBe(commands.thread.getState());
  const commandState = commands.thread.getState();
  expect(runtime.thread.getState().messages).toHaveLength(1000);
  const before = view.getState();
  expect(before.messages).toHaveLength(1000);
  getMessageByIndex.mockClear();
  state = { ...state, messages: [...state.messages.slice(0, -1), { ...state.messages.at(-1), content: [{ type: "text", text: "latest token" }] }] };
  const after = view.getState();
  expect(commands.thread.getState()).toBe(commandState);
  state = { ...state, isRunning: false };
  expect(commands.thread.getState().isRunning).toBe(false);
  expect(getMessageByIndex).toHaveBeenCalledExactlyOnceWith(999);
  expect(after.messages[0]).toBe(before.messages[0]);
  expect(after.messages[999].parts[0]).toMatchObject({ text: "latest token" });
});
