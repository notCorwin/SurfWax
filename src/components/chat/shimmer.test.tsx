// @vitest-environment jsdom

import type { ComponentProps } from "react";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { Reasoning } from "./reasoning";
import { ToolFallback } from "./tool-fallback";
import { ActivityPhaseContext, type ActivityPhase } from "./process-group";

vi.mock("./markdown-text", () => ({ MarkdownText: () => null }));

it("shimmers only active reasoning and tool labels", () => {
  const reasoning = (type: "running" | "complete") => renderToStaticMarkup(createElement(Reasoning, {
    status: { type },
  } as ComponentProps<typeof Reasoning>));
  const tool = (type: "running" | "complete" | "incomplete") => renderToStaticMarkup(createElement(ToolFallback, {
    status: { type },
    args: {},
  } as ComponentProps<typeof ToolFallback>));

  expect(reasoning("running")).toContain('class="shimmer text-foreground/65">正在思考');
  expect(reasoning("complete")).toContain("<span>思考完成</span>");
  expect(tool("running")).toContain('class="shimmer text-foreground/65">正在执行命令');
  expect(tool("complete")).toContain("<span>命令执行完成</span>");
  expect(tool("incomplete")).toContain("<span>命令执行失败</span>");
  expect(reasoning("running")).not.toContain("<svg");
  expect(tool("running")).not.toContain("<svg");
});

it("keeps completed activity labels live until text, then settles them", () => {
  const render = (phase: ActivityPhase) => renderToStaticMarkup(createElement(ActivityPhaseContext.Provider, { value: phase },
    createElement(Reasoning, { status: { type: "complete" } } as ComponentProps<typeof Reasoning>),
    createElement(ToolFallback, { status: { type: "complete" }, args: {} } as ComponentProps<typeof ToolFallback>)));
  expect(render("pending")).toMatch(/正在思考.*正在执行命令/s);
  expect(render("settled")).toMatch(/思考完成.*命令执行完成/s);
  expect(render("cancelled")).toMatch(/回复中断.*回复中断/s);
  expect(render("failed")).toMatch(/回复失败.*回复失败/s);
  expect(renderToStaticMarkup(createElement(ActivityPhaseContext.Provider, { value: "pending" },
    createElement(Reasoning, { status: { type: "incomplete" } } as ComponentProps<typeof Reasoning>)))).toContain("正在思考");
});

it("settles the shimmer when command execution completes", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement("div");
  const root = createRoot(container);
  const render = (status: "running" | "complete") => createElement(ToolFallback, {
    status: { type: status },
    args: {},
  } as ComponentProps<typeof ToolFallback>);

  await act(() => root.render(render("running")));
  const activeLabel = container.querySelector("summary span");
  expect(activeLabel?.textContent).toBe("正在执行命令");

  await act(() => root.render(render("complete")));
  const settledLabel = container.querySelector("summary span");
  expect(settledLabel?.textContent).toBe("命令执行完成");
  expect(settledLabel).not.toBe(activeLabel);
  expect(container.querySelectorAll("summary span")).toHaveLength(1);
  await act(() => root.unmount());
});
