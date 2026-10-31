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

it("distinguishes active reasoning and tool labels", () => {
  const reasoning = (type: "running" | "complete") => renderToStaticMarkup(createElement(Reasoning, {
    status: { type },
  } as ComponentProps<typeof Reasoning>));
  const tool = (type: "running" | "complete" | "incomplete") => renderToStaticMarkup(createElement(ToolFallback, {
    toolName: "click", status: { type },
    args: {},
  } as ComponentProps<typeof ToolFallback>));

  expect(reasoning("running")).toContain('class="shimmer text-foreground/65">正在思考');
  expect(reasoning("complete")).toContain("<span>思考完成</span>");
  expect(tool("running")).toContain('<span aria-live="off">点击</span>');
  expect(tool("complete")).toContain('<span aria-live="off">点击</span>');
  expect(tool("incomplete")).toContain('<span aria-live="off">点击 · 未完成</span>');
  expect(reasoning("running")).not.toContain("<svg");
  expect(tool("running")).not.toContain("<svg");
});

it("keeps completed activity labels live until text, then settles them", () => {
  const render = (phase: ActivityPhase) => renderToStaticMarkup(createElement(ActivityPhaseContext.Provider, { value: phase },
    createElement(Reasoning, { status: { type: "complete" } } as ComponentProps<typeof Reasoning>),
    createElement(ToolFallback, { toolName: "click", status: { type: "complete" }, args: {} } as ComponentProps<typeof ToolFallback>)));
  expect(render("pending")).toMatch(/思考完成.*点击/s);
  expect(render("settled")).toMatch(/思考完成.*点击/s);
  expect(render("cancelled")).toMatch(/回复中断.*点击/s);
  expect(render("failed")).toMatch(/回复失败.*点击/s);
  expect(renderToStaticMarkup(createElement(ActivityPhaseContext.Provider, { value: "pending" },
    createElement(Reasoning, { status: { type: "incomplete" } } as ComponentProps<typeof Reasoning>)))).toContain("思考未完成");
});

it("updates the tool state when command execution completes", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement("div");
  const root = createRoot(container);
  const render = (status: "running" | "complete") => createElement(ToolFallback, {
    toolName: "click", status: { type: status },
    args: {},
  } as ComponentProps<typeof ToolFallback>);

  await act(() => root.render(render("running")));
  const activeLabel = container.querySelector("summary span");
  expect(activeLabel?.textContent).toBe("点击");
  expect(container.querySelector(".activity")?.getAttribute("data-status")).toBe("running");

  await act(() => root.render(render("complete")));
  const settledLabel = container.querySelector("summary span");
  expect(settledLabel?.textContent).toBe("点击");
  expect(container.querySelector(".activity")?.getAttribute("data-status")).toBe("complete");
  expect(container.querySelectorAll("summary span")).toHaveLength(1);
  await act(() => root.unmount());
});

it("updates a running tool's elapsed time from its recorded start and stops at the recorded duration", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    const render = (type: "running" | "complete", durationMs?: number) => createElement(ToolFallback, {
      toolName: "inspect_page", args: {}, status: { type }, startedAtMs: 1_000, durationMs,
    });
    await act(() => root.render(render("running")));
    expect(container.querySelector("summary")?.textContent).toBe("查看页面 · 0.00 秒");
    await act(() => vi.advanceTimersByTime(1_200));
    expect(container.querySelector("summary")?.textContent).toBe("查看页面 · 1.20 秒");
    await act(() => root.render(render("complete", 1256)));
    expect(container.querySelector("summary")?.textContent).toBe("查看页面 · 1.26 秒");
    await act(() => vi.advanceTimersByTime(1_000));
    expect(container.querySelector("summary")?.textContent).toBe("查看页面 · 1.26 秒");
  } finally {
    await act(() => root.unmount());
    vi.useRealTimers();
  }
});
