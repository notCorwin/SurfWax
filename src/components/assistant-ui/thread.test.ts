import { describe, expect, it } from "vitest";
import { workLabel } from "./work-time";
import { buildMessageSearchIndex } from "./thread-list";
import { activityPhaseAt, processGroupSummary, toolActivity, turnActivityBoundary, turnActivityPhase } from "./process-group";
import { toLogValue, type LogEvent } from "../../logging";

describe("workLabel", () => {
  it.each([
    [365 * 86400 + 211 * 86400, "工作了 1 年 211 天"],
    [7 * 86400 + 23 * 3600, "工作了 7 天 23 小时"],
    [3 * 3600 + 29 * 60, "工作了 3 小时 29 分钟"],
    [29 * 60 + 38, "工作了 29 分 38 秒"],
    [60, "工作了 1 分 0 秒"],
    [3600, "工作了 1 小时 0 分钟"],
    [86400, "工作了 1 天 0 小时"],
    [18, "工作了 18 秒"],
    [0, "工作了 0 秒"],
  ])("formats %i seconds as %s", (seconds, expected) => {
    expect(workLabel(seconds)).toBe(expected);
  });
});

describe("processGroupSummary", () => {
  const summary = (...parts: Array<{ type: string; status: { type: string }; args?: unknown; isError?: boolean }>) =>
    processGroupSummary(parts, parts.map((_, index) => index));

  it("shows the latest live phase", () => {
    expect(summary({ type: "reasoning", status: { type: "running" } }).label).toBe("正在思考");
    expect(summary({ type: "tool-call", status: { type: "running" }, args: {} }).label).toBe("正在执行命令");
  });

  it("summarizes completed reasoning and commands", () => {
    expect(summary({ type: "reasoning", status: { type: "complete" } }).label).toBe("思考完成");
    expect(summary(
      { type: "tool-call", status: { type: "complete" } },
      { type: "tool-call", status: { type: "complete" } },
    ).label).toBe("已执行 2 次命令");
    expect(summary(
      { type: "reasoning", status: { type: "complete" } },
      { type: "tool-call", status: { type: "complete" } },
    ).label).toBe("已思考并执行 1 次命令");
  });

  it("reports failures across the whole group", () => {
    expect(summary(
      { type: "tool-call", status: { type: "incomplete" } },
      { type: "tool-call", status: { type: "complete" } },
    )).toMatchObject({ status: "error", label: "2 次命令中有失败" });
    expect(processGroupSummary([
      { type: "tool-call", status: { type: "requires-action" } },
    ], [0], true)).toMatchObject({ status: "error", label: "1 次命令中有失败" });
    expect(processGroupSummary([
      { type: "reasoning", status: { type: "complete" } },
    ], [0], true)).toMatchObject({ status: "complete", label: "思考完成" });
  });

  it("continues the latest activity until assistant text arrives", () => {
    const reasoning = { type: "reasoning", status: { type: "complete" } };
    const tool = { type: "tool-call", status: { type: "complete" }, args: {} };
    expect(processGroupSummary([reasoning], [0], false, "pending")).toEqual({ status: "running", label: "正在思考" });
    expect(processGroupSummary([reasoning, tool], [0, 1], false, "pending")).toEqual({ status: "running", label: "正在执行命令" });
    expect(toolActivity(tool, "pending")).toEqual({ status: "running", label: "正在执行命令" });
    expect(processGroupSummary([{ ...tool, isError: true }], [0], false, "pending")).toEqual({ status: "running", label: "正在执行命令" });
    expect(toolActivity({ ...tool, isError: true }, "pending")).toEqual({ status: "running", label: "正在执行命令" });
    expect(processGroupSummary([reasoning, tool], [0, 1], false, "settled").label).toBe("已思考并执行 1 次命令");
    expect(toolActivity(tool, "settled").label).toBe("命令执行完成");
  });

  it("stops the activity when a run ends without text", () => {
    const tool = { type: "tool-call", status: { type: "complete" }, args: {} };
    expect(processGroupSummary([tool], [0], false, "cancelled")).toEqual({ status: "error", label: "回复中断" });
    expect(processGroupSummary([tool], [0], false, "failed")).toEqual({ status: "error", label: "回复失败" });
    expect(processGroupSummary([tool], [0], false, "stopped")).toEqual({ status: "complete", label: "回复未生成" });
    expect(processGroupSummary([{ ...tool, status: { type: "incomplete" } }], [0], true, "cancelled"))
      .toEqual({ status: "error", label: "回复中断" });
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
