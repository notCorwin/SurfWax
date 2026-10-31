import { describe, expect, it } from "vitest";
import { summarizeToolActions, toolAction } from "./tool-labels";
import { toolActivity } from "./process-group";
import { PROGRAM_TOOL_REGISTRY } from "../../chrome/tool";

describe("human-facing tool activity", () => {
  it("names actions and meaningful targets without exposing selectors", () => {
    expect(toolAction({ toolName: "inspect_pages", args: {} })).toBe("查看页面");
    expect(toolAction({ toolName: "click", args: { target: { by: "role", value: "button", name: "登录" } } })).toBe("点击「登录」");
    expect(toolAction({ toolName: "click", args: { target: { by: "css", value: "#login-button" } } })).toBe("点击");
    expect(toolAction({ toolName: "unknown_tool", args: {} })).toBe("执行浏览器操作");
  });

  it("has a human-facing label for every registered tool", () => {
    const missing = PROGRAM_TOOL_REGISTRY.filter(({ name }) => name !== "execute_program"
      && toolAction({ toolName: name, args: {} }) === "执行浏览器操作");
    expect(missing.map(({ name }) => name)).toEqual([]);
  });

  it("summarizes consecutive calls in order without claiming success", () => {
    const part = (toolName: string) => ({ toolName, args: {} });
    expect(summarizeToolActions([part("inspect_page"), part("inspect_page"), part("click"), part("read_text")]))
      .toBe("查看页面、点击并读取文本");
    expect(summarizeToolActions([part("inspect_page"), part("click"), part("read_text"), part("scroll")]))
      .toBe("查看页面、点击、读取文本等操作");
  });

  it("shows actual elapsed time while running and never invents a missing start", () => {
    const part = { toolName: "inspect_page", args: {}, status: { type: "running" } };
    expect(toolActivity({ ...part, startedAtMs: 1000 }, "pending", 13370).label).toBe("查看页面 · 12.37 秒");
    expect(toolActivity(part, "pending", 13370).label).toBe("查看页面");
    expect(toolActivity({ ...part, startedAtMs: 1000 }, "cancelled", 13370).label).toBe("查看页面 · 已中断");
    expect(toolActivity({ ...part, startedAtMs: 1000, durationMs: 2345, status: { type: "complete" } }, "settled", 13370).label).toBe("查看页面 · 2.35 秒");
  });
});
