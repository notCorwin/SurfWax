import type { ComponentProps } from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { Reasoning } from "./reasoning";
import { ToolFallback } from "./tool-fallback";

vi.mock("./markdown-text", () => ({ MarkdownText: () => null }));

it("shimmers only active reasoning and tool labels", () => {
  const reasoning = (type: "running" | "complete") => renderToStaticMarkup(createElement(Reasoning, {
    status: { type },
  } as ComponentProps<typeof Reasoning>));
  const tool = (type: "running" | "complete" | "incomplete", argsText: string) => renderToStaticMarkup(createElement(ToolFallback, {
    status: { type },
    argsText,
  } as ComponentProps<typeof ToolFallback>));

  expect(reasoning("running")).toContain('class="shimmer text-foreground/65">正在思考');
  expect(reasoning("complete")).toContain("<span>已思考</span>");
  expect(tool("running", "{")).toContain('class="shimmer text-foreground/65">正在输入命令');
  expect(tool("running", "{}")).toContain('class="shimmer text-foreground/65">运行命令中');
  expect(tool("complete", "{}")).toContain("<span>调用了命令</span>");
  expect(tool("incomplete", "{}")).toContain("<span>命令执行失败</span>");
});
