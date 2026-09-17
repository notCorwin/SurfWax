import type { ComponentProps } from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parsePartialJsonObject } from "assistant-stream/utils";
import { expect, it, vi } from "vitest";
import { Reasoning } from "./reasoning";
import { ToolFallback } from "./tool-fallback";

vi.mock("./markdown-text", () => ({ MarkdownText: () => null }));

it("shimmers only active reasoning and tool labels", () => {
  const reasoning = (type: "running" | "complete") => renderToStaticMarkup(createElement(Reasoning, {
    status: { type },
  } as ComponentProps<typeof Reasoning>));
  const tool = (type: "running" | "complete" | "incomplete", argsText: string, args = parsePartialJsonObject(argsText)) => renderToStaticMarkup(createElement(ToolFallback, {
    status: { type },
    argsText,
    args,
  } as ComponentProps<typeof ToolFallback>));

  expect(reasoning("running")).toContain('class="shimmer text-foreground/65">正在思考…');
  expect(reasoning("complete")).toContain("<span>思考完成</span>");
  expect(tool("running", '{"code":"return 1')).toContain('class="shimmer text-foreground/65">正在输入命令…');
  expect(tool("running", '{"code":"return 1"}')).toContain('class="shimmer text-foreground/65">正在执行命令…');
  expect(tool("complete", "{}")).toContain("<span>命令执行完成</span>");
  expect(tool("incomplete", "{}")).toContain("<span>命令执行失败</span>");
});
