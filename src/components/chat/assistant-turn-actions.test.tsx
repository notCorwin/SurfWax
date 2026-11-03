import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { RuntimeViewContext, type RuntimeView } from "@/sidepanel/runtime-view";
import type { MessageView } from "@/sidepanel/conversation-store";
import { AssistantTurnActions } from "./assistant-turn-actions";

it("copies the complete assistant turn, retries from its start, and retains branch navigation", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  const reload = vi.fn();
  const switchToBranch = vi.fn();
  const getMessageById = vi.fn(() => ({ reload, switchToBranch }));
  const runtime = { thread: { getMessageById } } as unknown as RuntimeView["runtime"];
  const assistants = [
    { id: "first", parts: [{ type: "text", text: "先检查" }, { type: "tool-call" }], branchCount: 2, branchNumber: 2, userBranch: { id: "user", number: 2, count: 2 } },
    { id: "second", parts: [{ type: "text", text: "已完成" }], branchCount: 2, branchNumber: 2 },
  ] as unknown as MessageView[];
  const container = document.createElement("div");
  const root = createRoot(container);
  const render = (running: boolean, locked = false) => createElement(RuntimeViewContext.Provider,
    { value: { runtime, thread: runtime.thread, getState: runtime.thread.getState } },
    createElement(AssistantTurnActions, { assistants, running, locked, command: (action) => { void action(); } }));
  await act(() => root.render(render(false)));
  expect(container.querySelectorAll('[data-testid="replay-message-button"]')).toHaveLength(1);
  await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="复制消息"]')!.click(); });
  expect(writeText).toHaveBeenCalledWith("先检查\n已完成");
  await act(() => container.querySelector<HTMLButtonElement>('[data-testid="replay-message-button"]')!.click());
  expect(getMessageById).toHaveBeenLastCalledWith("first");
  expect(reload).toHaveBeenCalledOnce();
  const previous = container.querySelectorAll<HTMLButtonElement>('[aria-label="上一个分支"]');
  expect(previous).toHaveLength(2);
  await act(() => previous[1]!.click());
  expect(getMessageById).toHaveBeenLastCalledWith("second");
  expect(switchToBranch).toHaveBeenCalledWith({ position: "previous" });
  await act(() => container.querySelector<HTMLButtonElement>('[aria-label="上一个消息版本"]')!.click());
  expect(getMessageById).toHaveBeenLastCalledWith("user");
  await act(() => root.render(render(true)));
  expect(container.querySelector('[data-testid="replay-message-button"]')).toBeNull();
  await act(() => root.render(render(false, true)));
  expect(container.querySelector('[data-testid="replay-message-button"]')).toBeNull();
  await act(() => root.unmount());
});
