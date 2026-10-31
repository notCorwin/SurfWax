import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
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
    expect(liveHtml.match(/class="activity"/g)).toHaveLength(3);
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

  it("renders text and tool groups in chronological order across assistant messages", () => {
    const messages = [message("a", [text("BEFORE"), tool("1")]), message("b", [tool("2"), text("AFTER")])];
    const timeline = projectToolTimeline(messages, false);
    const runtime = { thread: { getMessageById: () => ({ getCopyText: () => "" }) } } as unknown as RuntimeView["runtime"];
    const html = renderToStaticMarkup(createElement(RuntimeViewContext.Provider, { value: { runtime, thread: runtime.thread, getState: runtime.thread.getState } },
      messages.map((item) => createElement(MessageRow, { key: item.id, message: item, messages, running: false, locked: false, latest: item.id === "b", timeline, command: () => {} }))));
    expect(html.indexOf("BEFORE")).toBeLessThan(html.indexOf("tool-group-summary"));
    expect(html.indexOf("tool-group-summary")).toBeLessThan(html.indexOf("AFTER"));
    expect(html.match(/data-testid="tool-group-summary"/g)).toHaveLength(1);
  });

  it("measures elapsed wall time rather than summing concurrent calls and omits unknown or incomplete timing", () => {
    expect(toolGroupDuration([tool("1", 1000, 4000), tool("2", 2000, 3000)])).toBe(3000);
    expect(toolGroupDuration([{ ...tool("1"), finishedAtMs: undefined }])).toBeUndefined();
    expect(toolGroupDuration([{ ...tool("1"), timingIncomplete: true }])).toBeUndefined();
    expect(toolGroupDuration([tool("1", 1000, 500)])).toBeUndefined();
  });
});
