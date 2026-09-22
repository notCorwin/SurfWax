import { describe, expect, it } from "vitest";
import { workLabel } from "./work-time";
import { buildMessageSearchIndex } from "./thread-list";
import { processGroupSummary } from "./process-group";
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
    expect(summary({ type: "reasoning", status: { type: "running" } }).label).toBe("正在思考…");
    expect(summary({ type: "tool-call", status: { type: "running" }, args: {} }).label).toBe("正在执行命令…");
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
