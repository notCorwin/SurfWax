// @vitest-environment jsdom

import type { ComponentProps } from "react";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { Reasoning } from "./reasoning";
import { ToolFallback } from "./tool-fallback";
import { WaitingActivityRow } from "./waiting-status";
import { ActivityPhaseContext, type ActivityPhase } from "./process-group";

vi.mock("./markdown-text", () => ({ MarkdownText: () => null }));

function useFrameTimers() {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  // Keep jsdom's animation-frame phase independent of the test runner's clock.
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 16));
  vi.stubGlobal("cancelAnimationFrame", clearTimeout);
  vi.stubGlobal("IntersectionObserver", class {
    constructor(private callback: (entries: { isIntersecting: boolean }[]) => void) {}
    observe() { this.callback([{ isIntersecting: true }]); }
    disconnect() {}
  });
}

it("distinguishes active reasoning and tool labels", () => {
  const reasoning = (type: "running" | "complete") => renderToStaticMarkup(createElement(Reasoning, {
    status: { type },
  } as ComponentProps<typeof Reasoning>));
  const tool = (type: "running" | "complete" | "incomplete") => renderToStaticMarkup(createElement(ToolFallback, {
    toolName: "click", status: { type },
    args: {},
  } as ComponentProps<typeof ToolFallback>));

  expect(reasoning("running")).toContain('class="activity transcript-activity" data-status="running"');
  expect(reasoning("running")).not.toMatch(/<details|<summary|shimmer/);
  expect(tool("running")).toContain('class="activity transcript-activity" data-status="running"');
  expect(reasoning("complete")).toContain('<span aria-live="off">思考完成</span>');
  expect(tool("running")).toContain('<span aria-live="off">点击</span>');
  expect(tool("complete")).toContain('<span aria-live="off">点击</span>');
  expect(tool("incomplete")).toContain('<span aria-live="off">点击 · 未完成</span>');
  expect(reasoning("running")).not.toContain("<svg");
  expect(tool("running")).not.toContain("<svg");
});

it("shows tool failure and interruption without exposing input or output", () => {
  const render = (interrupted: boolean) => renderToStaticMarkup(createElement(ToolFallback, {
    toolName: "click", status: { type: "incomplete" }, args: { secretInput: "input-value" },
    result: { secretOutput: "output-value" }, interrupted,
  }));
  expect(render(false)).toContain("点击 · 未完成");
  expect(render(true)).toContain("点击 · 已中断");
  expect(render(false)).not.toMatch(/input-value|output-value|<details|<summary/);
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
  const activeLabel = container.querySelector(".activity span");
  expect(activeLabel?.textContent).toBe("点击");
  expect(container.querySelector(".activity")?.getAttribute("data-status")).toBe("running");

  await act(() => root.render(render("complete")));
  const settledLabel = container.querySelector(".activity span");
  expect(settledLabel?.textContent).toBe("点击");
  expect(container.querySelector(".activity")?.getAttribute("data-status")).toBe("complete");
  expect(container.querySelectorAll(".activity span")).toHaveLength(1);
  await act(() => root.unmount());
});

it("updates a running tool's elapsed time from its recorded start and stops at the recorded duration", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  useFrameTimers();
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    const render = (type: "running" | "complete", durationMs?: number) => createElement(ToolFallback, {
      toolName: "inspect_page", args: {}, status: { type }, startedAtMs: 1_000, durationMs,
    });
    await act(() => root.render(render("running")));
    expect(container.querySelector(".activity")?.textContent).toBe("查看页面 · 0.00 秒");
    await act(() => vi.advanceTimersByTime(32));
    expect(container.querySelector(".activity")?.textContent).toBe("查看页面 · 0.03 秒");
    await act(() => vi.advanceTimersByTime(1_168));
    expect(container.querySelector(".activity")?.textContent).toBe("查看页面 · 1.20 秒");
    await act(() => root.render(render("complete", 1256)));
    expect(container.querySelector(".activity")?.textContent).toBe("查看页面 · 1.26 秒");
    await act(() => vi.advanceTimersByTime(1_000));
    expect(container.querySelector(".activity")?.textContent).toBe("查看页面 · 1.26 秒");
  } finally {
    await act(() => root.unmount());
    vi.useRealTimers();
  }
});

it("updates both waiting-time decimal places and freezes the recorded end time", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  useFrameTimers();
  const container = document.createElement("div");
  const root = createRoot(container);
  const activity = { id: "wait", label: "等待响应", startedAt: 1_000 };
  try {
    await act(() => root.render(createElement(WaitingActivityRow, { activity })));
    expect(container.textContent).toBe("等待响应 · 0.00 秒");
    await act(() => vi.advanceTimersByTime(32));
    expect(container.textContent).toBe("等待响应 · 0.03 秒");
    await act(() => vi.advanceTimersByTime(96));
    expect(container.textContent).toBe("等待响应 · 0.13 秒");
    await act(() => root.render(createElement(WaitingActivityRow, { activity: { ...activity, endedAt: 1_135 } })));
    expect(container.textContent).toBe("等待响应 · 0.14 秒");
    expect(vi.getTimerCount()).toBe(0);
    await act(() => vi.advanceTimersByTime(1_000));
    expect(container.textContent).toBe("等待响应 · 0.14 秒");
  } finally {
    await act(() => root.unmount());
    vi.useRealTimers();
  }
});

it("shares one clock across visible rows and catches up when hidden rows reappear", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  useFrameTimers();
  const observers: ((entries: { isIntersecting: boolean }[]) => void)[] = [];
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: typeof observers[number]) { observers.push(callback); }
    observe() {}
    disconnect() {}
  });
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(() => root.render(createElement("div", null, ...["one", "two"].map((id) =>
      createElement(WaitingActivityRow, { key: id, activity: { id, label: id, startedAt: 1_000 } })))));
    expect(vi.getTimerCount()).toBe(0);
    await act(() => { for (const notify of observers) notify([{ isIntersecting: true }]); });
    expect(vi.getTimerCount()).toBe(1);
    await act(() => vi.advanceTimersByTime(32));
    expect(container.textContent).toBe("one · 0.03 秒two · 0.03 秒");
    await act(() => { for (const notify of observers) notify([{ isIntersecting: false }]); });
    expect(vi.getTimerCount()).toBe(0);
    await act(() => vi.advanceTimersByTime(1_000));
    expect(container.textContent).toBe("one · 0.03 秒two · 0.03 秒");
    await act(() => observers[0]([{ isIntersecting: true }]));
    expect(container.textContent).toBe("one · 1.03 秒two · 0.03 秒");
  } finally {
    await act(() => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  }
});
