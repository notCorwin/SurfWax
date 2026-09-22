// @vitest-environment jsdom

import type { ComponentProps } from "react";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot } from "react-dom/client";
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

  expect(reasoning("running")).toContain('class="shimmer text-foreground/65">正在思考');
  expect(reasoning("complete")).toContain("<span>思考完成</span>");
  expect(tool("running", '{"code":"return 1')).toContain('class="shimmer text-foreground/65">正在输入命令');
  expect(tool("running", '{"code":"return 1"}')).toContain('class="shimmer text-foreground/65">正在执行命令');
  expect(tool("complete", "{}")).toContain("<span>命令执行完成</span>");
  expect(tool("incomplete", "{}")).toContain("<span>命令执行失败</span>");
  expect(reasoning("running")).not.toContain("<svg");
  expect(tool("running", "{}")).not.toContain("<svg");
});

it("replaces the shimmer label when command input becomes execution", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement("div");
  const root = createRoot(container);
  const render = (argsText: string) => createElement(ToolFallback, {
    status: { type: "running" },
    argsText,
    args: parsePartialJsonObject(argsText),
  } as ComponentProps<typeof ToolFallback>);

  await act(() => root.render(render('{"code":"return 1')));
  const inputLabel = container.querySelector("summary span");
  expect(inputLabel?.textContent).toBe("正在输入命令");

  await act(() => root.render(render('{"code":"return 1"}')));
  const executionLabel = container.querySelector("summary span");
  expect(executionLabel?.textContent).toBe("正在执行命令");
  expect(executionLabel).not.toBe(inputLabel);
  expect(container.querySelectorAll("summary span")).toHaveLength(1);
  await act(() => root.unmount());
});
