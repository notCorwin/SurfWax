import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { MessagePart, MessageView } from "@/sidepanel/conversation-store";
import { RuntimeViewContext, type RuntimeView } from "@/sidepanel/runtime-view";
import { MessageRow } from "./message-row";
import { projectToolTimeline, toolGroupAt, toolGroupDuration, ToolGroupView } from "./tool-timeline";

type Tool = Extract<MessagePart, { type: "tool-call" }>;
const tool = (id: string, start = 0, end = 100): Tool => ({
  type: "tool-call", toolName: "inspect_pages", toolCallId: id, args: {}, status: { type: "complete" }, startedAtMs: start, finishedAtMs: end,
});
const text = (value: string): MessagePart => ({ type: "text", text: value, status: { type: "complete" } });
const message = (id: string, parts: MessagePart[]) => ({ id, role: "assistant", parts, metadata: {}, status: { type: "complete" }, branchCount: 1, branchNumber: 1 }) as unknown as MessageView;

describe("tool timeline", () => {
  it("keeps tool groups in place, spanning assistant messages until visible text breaks the sequence", () => {
    const messages = [message("a", [text("first"), tool("1"), tool("2")]), message("b", [text(" "), tool("3"), text("next"), tool("4")])];
    const projected = projectToolTimeline(messages, true);
    const first = toolGroupAt(projected, "a", 1)!;
    const second = toolGroupAt(projected, "b", 3)!;
    expect(first.tools.map((item) => item.toolCallId)).toEqual(["1", "2", "3"]);
    expect(first.live).toBe(false);
    expect(toolGroupAt(projected, "b", 1)).toBeUndefined();
    expect(second.tools.map((item) => item.toolCallId)).toEqual(["4"]);
    expect(second.live).toBe(true);
    expect(projectToolTimeline(messages, false).starts.size).toBe(2);
    expect(toolGroupAt(projectToolTimeline(messages, false), "b", 3)?.live).toBe(false);
    expect(projectToolTimeline(messages, true)).toBe(projected);
  });

  it("shows only the latest three during a running sequence and a single non-expandable summary after it ends", () => {
    const messages = [message("a", [tool("1"), tool("2"), tool("3"), tool("4")])];
    const live = toolGroupAt(projectToolTimeline(messages, true), "a", 0)!;
    const liveHtml = renderToStaticMarkup(createElement(ToolGroupView, { group: live }));
    expect(liveHtml.match(/class="activity transcript-activity"/g)).toHaveLength(3);
    const settled = toolGroupAt(projectToolTimeline(messages, false), "a", 0)!;
    const settledHtml = renderToStaticMarkup(createElement(ToolGroupView, { group: settled }));
    expect(settledHtml).toContain("tool-group-summary");
    expect(settledHtml).not.toContain("<details");
  });

  it("keeps a call visible if later text arrived before that call finished", () => {
    const pending: Tool = { ...tool("pending"), status: { type: "running" }, finishedAtMs: undefined };
    const messages = [message("a", [pending, text("later text")])];
    expect(toolGroupAt(projectToolTimeline(messages, true), "a", 0)?.live).toBe(true);
    expect(toolGroupAt(projectToolTimeline([message("a", [tool("done"), text("later text")])], true), "a", 0)?.live).toBe(false);
  });

  it("rolls only when the visible calls change and respects reduced motion", async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const container = document.createElement("div");
    const root = createRoot(container);
    let reduced = false;
    let now = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.stubGlobal("matchMedia", () => ({ matches: reduced }));
    const top = vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute("data-tool-id") ? Array.from(this.parentElement!.children).indexOf(this) * 32 : 0;
    });
    const height = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(24);
    const animate = vi.fn(() => ({ cancel: vi.fn(), onfinish: null, oncancel: null }));
    Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: animate });
    const render = async (tools: Tool[]) => act(() => root.render(createElement(ToolGroupView, { group: { key: "a", tools, live: true } })));
    try {
      await render([tool("1"), tool("2"), tool("3")]);
      expect(animate).not.toHaveBeenCalled();
      await render([{ ...tool("1"), status: { type: "incomplete" } }, tool("2"), tool("3")]);
      expect(animate).not.toHaveBeenCalled();
      await render([tool("1"), tool("2"), tool("3"), tool("4")]);
      expect(animate).toHaveBeenCalled();
      expect(Array.from(container.querySelectorAll('[data-tool-id]:not([aria-hidden])')).map((item) => item.getAttribute("data-tool-id"))).toEqual(["2", "3", "4"]);
      animate.mockClear();
      now = 100;
      await render([tool("1"), tool("2"), tool("3"), tool("4"), tool("5")]);
      expect(JSON.stringify(animate.mock.calls)).toContain("translateY(48px)");
      animate.mockClear();
      reduced = true;
      await render([tool("1"), tool("2"), tool("3"), tool("4"), tool("5"), tool("6")]);
      expect(animate).not.toHaveBeenCalled();
    } finally {
      await act(() => root.unmount());
      vi.unstubAllGlobals();
      clock.mockRestore();
      top.mockRestore();
      height.mockRestore();
      delete (HTMLElement.prototype as { animate?: unknown }).animate;
    }
  });

  it("summarizes older failures and interruptions without displacing the latest three", () => {
    const failed: Tool = { ...tool("failed"), isError: true, result: { error: "failure" }, status: { type: "incomplete" } };
    const interrupted: Tool = { ...tool("interrupted"), interrupted: true, status: { type: "incomplete" } };
    const messages = [message("a", [failed, interrupted, tool("1"), tool("2"), tool("3")])];
    for (const running of [true, false]) {
      const group = toolGroupAt(projectToolTimeline(messages, running), "a", 0)!;
      const html = renderToStaticMarkup(createElement(ToolGroupView, { group }));
      expect(html).toContain("1 项未完成，1 项已中断");
      expect(html.match(/data-status="error"/g)).toHaveLength(1);
      if (running) {
        expect(html.match(/data-tool-id=/g)).toHaveLength(3);
        expect(html).not.toContain('data-tool-id="failed"');
        expect(html).not.toContain('data-tool-id="interrupted"');
      }
    }
  });

  it("reports a pending call as interrupted when its turn was cancelled after an earlier call", () => {
    const pending: Tool = { ...tool("pending"), status: { type: "running" }, finishedAtMs: undefined };
    const item = { ...message("a", [tool("done"), pending]), metadata: { custom: { interrupted: true } } };
    const messages = [item];
    const runtime = { thread: { getMessageById: () => ({ getCopyText: () => "" }) } } as unknown as RuntimeView["runtime"];
    const html = renderToStaticMarkup(createElement(RuntimeViewContext.Provider, { value: { runtime, thread: runtime.thread, getState: runtime.thread.getState } },
      createElement(MessageRow, { message: item, messages, running: false, locked: false, latest: true, timeline: projectToolTimeline(messages, false), command: () => {} })));
    expect(html).toContain("已中断");
    expect(html).toContain('data-status="error"');
  });

  it("renders text and tool groups in chronological order across assistant messages", () => {
    const messages = [message("a", [text("BEFORE"), tool("1")]), message("b", [tool("2"), text("AFTER")])];
    const timeline = projectToolTimeline(messages, false);
    const runtime = { thread: { getMessageById: () => ({ getCopyText: () => "" }) } } as unknown as RuntimeView["runtime"];
    const html = renderToStaticMarkup(createElement(RuntimeViewContext.Provider, { value: { runtime, thread: runtime.thread, getState: runtime.thread.getState } },
      messages.map((item) => createElement(MessageRow, { key: item.id, message: item, messages, running: false, locked: false, latest: item.id === "b", timeline, command: () => {} }))));
    expect(html.indexOf("BEFORE")).toBeLessThan(html.indexOf("tool-group-summary"));
    expect(html.indexOf("tool-group-summary")).toBeLessThan(html.indexOf("AFTER"));
    expect(html.match(/data-testid="tool-group-summary"/g)).toHaveLength(1);
    expect(html).not.toContain('aria-label="复制消息"');
    expect(html).not.toContain('data-testid="replay-message-button"');
  });

  it("measures elapsed wall time rather than summing concurrent calls and omits unknown or incomplete timing", () => {
    expect(toolGroupDuration([tool("1", 1000, 4000), tool("2", 2000, 3000)])).toBe(3000);
    expect(toolGroupDuration([{ ...tool("1"), finishedAtMs: undefined }])).toBeUndefined();
    expect(toolGroupDuration([{ ...tool("1"), timingIncomplete: true }])).toBeUndefined();
    expect(toolGroupDuration([tool("1", 1000, 500)])).toBeUndefined();
  });
});
