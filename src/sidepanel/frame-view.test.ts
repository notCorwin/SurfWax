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

import { createMessageProjection } from "./conversation-store";
import type { SidePanelMessage } from "../agent/transport";

it("keeps historic message identity stable while projecting streamed tokens and branch changes", () => {
  const projection = createMessageProjection();
  const messages: SidePanelMessage[] = Array.from({ length: 1000 }, (_, index) => ({ id: String(index), role: "assistant", parts: [{ type: "text", text: String(index) }] }));
  const before = messages.map((message) => projection.message(message, true, [message.id]));
  const updated = { ...messages[999]!, parts: [{ type: "text" as const, text: "latest token" }] };
  const after = [...messages.slice(0, -1), updated].map((message) => projection.message(message, true, [message.id]));
  expect(after[0]).toBe(before[0]);
  expect(after[999]?.parts[0]).toMatchObject({ text: "latest token" });
  expect(projection.message(updated, false, [updated.id]).status.type).toBe("complete");
  expect(projection.message(messages[0]!, false, ["other", "0"])).toMatchObject({ branchNumber: 2, branchCount: 2 });
});
