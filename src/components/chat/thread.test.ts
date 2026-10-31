import { describe, expect, it } from "vitest";
import { buildMessageSearchIndex } from "./thread-list";
import { activityPhaseAt, toolActivity, turnActivityBoundary, turnActivityPhase } from "./process-group";
import { toLogValue, type LogEvent } from "../../logging";

describe("tool activity", () => {
  const tool = (toolName: string, type: string, extra: { isError?: boolean; result?: unknown; durationMs?: number; timingIncomplete?: boolean } = {}) =>
    ({ type: "tool-call", toolName, status: { type }, ...extra });

  it("distinguishes failure, interruption and incomplete timing", () => {
    expect(toolActivity(tool("click", "incomplete", { isError: true, durationMs: 10 })))
      .toEqual({ status: "error", label: "点击 · 未完成 · 0.01 秒" });
    expect(toolActivity(tool("fill", "incomplete", { result: { error: { code: "aborted" } }, durationMs: 0, timingIncomplete: true })))
      .toEqual({ status: "error", label: "填写 · 已中断 · ≥0.00 秒" });
    expect(toolActivity(tool("fill", "incomplete", { result: { error: { code: "interrupted" } } })).label)
      .toBe("填写 · 已中断");
    expect(toolActivity({ ...tool("fill", "incomplete"), interrupted: true }).label).toBe("填写 · 已中断");
    expect(toolActivity(tool("fill", "incomplete", { durationMs: 25, timingIncomplete: true })).label)
      .toBe("填写 · 未完成 · ≥0.02 秒");
    expect(toolActivity(tool("fill", "running"), "cancelled"))
      .toEqual({ status: "error", label: "填写 · 已中断" });
    expect(toolActivity(tool("click", "complete"), "cancelled"))
      .toEqual({ status: "complete", label: "点击" });
  });
});

it("settles an activity only after a later activity or nonempty text", () => {
  const messages = [
    { id: "u1", role: "user", parts: [{ type: "text", text: "Question" }] },
    { id: "a1", role: "assistant", parts: [{ type: "text", text: "Earlier answer" }] },
    { id: "u2", role: "user", parts: [{ type: "text", text: "Next question" }] },
    { id: "a2", role: "assistant", parts: [
      { type: "text", text: "Progress" }, { type: "reasoning" }, { type: "tool-call" }, { type: "tool-call" }, { type: "text", text: " \n" },
    ] },
  ];
  expect(turnActivityBoundary(messages, "a2")).toBe(3);
  expect(turnActivityPhase(messages, "a2", true)).toBe("pending");
  expect(activityPhaseAt(3, 1, "pending")).toBe("settled");
  expect(activityPhaseAt(3, 2, "pending")).toBe("settled");
  expect(activityPhaseAt(3, 3, "pending")).toBe("pending");
  expect(activityPhaseAt(3, 2, "cancelled", "requires-action")).toBe("cancelled");
  expect(activityPhaseAt(3, 2, "cancelled", "complete")).toBe("settled");
  messages[3]!.parts.push({ type: "text", text: "Next progress" });
  expect(turnActivityBoundary(messages, "a2")).toBe(5);
  expect(activityPhaseAt(5, 3, "pending")).toBe("settled");
  messages[3]!.parts.push({ type: "tool-call" });
  expect(activityPhaseAt(turnActivityBoundary(messages, "a2"), 6, "pending")).toBe("pending");
  messages.push({ id: "a3", role: "assistant", parts: [{ type: "text", text: "Later message" }] });
  expect(turnActivityBoundary(messages, "a2")).toBe(Infinity);
  expect(activityPhaseAt(Infinity, 6, "pending")).toBe("settled");
});

it("uses the current turn's terminal status when no later activity or text arrives", () => {
  const messages: Array<{ id: string; role: string; parts: Array<{ type: string; text?: string }>; status: { type: string; reason?: string } }> = [
    { id: "u", role: "user", parts: [{ type: "text", text: "Question" }], status: { type: "complete" } },
    { id: "a", role: "assistant", parts: [{ type: "text", text: "Progress" }, { type: "tool-call" }], status: { type: "complete" } },
  ];
  expect(turnActivityPhase(messages, "a", false)).toBe("stopped");
  messages[1]!.status = { type: "incomplete", reason: "error" };
  expect(turnActivityPhase(messages, "a", false)).toBe("failed");
  messages[1]!.status = { type: "incomplete", reason: "cancelled" };
  expect(turnActivityPhase(messages, "a", false)).toBe("cancelled");
  messages[1]!.status = { type: "requires-action" };
  expect(turnActivityPhase(messages, "a", false)).toBe("cancelled");
  messages.push({ id: "a2", role: "assistant", parts: [], status: { type: "incomplete", reason: "error" } });
  expect(turnActivityPhase(messages, "a", false)).toBe("failed");
});

it("indexes saved message text without tool input or superseded edits", () => {
  const make = (id: number, conversationId: string, message: unknown): LogEvent => ({
    id, conversationId, type: "conversation.message", timestamp: new Date(id * 1000).toISOString(), content: toLogValue(message),
  });
  const index = buildMessageSearchIndex([
    make(1, "first", { id: "u1", role: "user", parts: [{ type: "text", text: "Old phrase" }] }),
    make(2, "first", { id: "u1", role: "user", parts: [{ type: "text", text: "New phrase" }] }),
    make(3, "first", { id: "a1", role: "assistant", parts: [{ type: "text", text: "Final Answer" }, { type: "dynamic-tool", input: "SECRET TOOL INPUT" }] }),
    make(4, "second", { id: "u2", role: "user", parts: [{ type: "text", text: "Other topic" }] }),
  ]);
  expect(index.get("first")).toContain("new phrase");
  expect(index.get("first")).toContain("final answer");
  expect(index.get("first")).not.toContain("old phrase");
  expect(index.get("first")).not.toContain("secret tool input");
  expect(index.get("second")).toBe("other topic");
});
