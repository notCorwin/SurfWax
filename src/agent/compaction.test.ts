import type { ModelMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { EventLogger, type LogEvent } from "../logging";
import { createMemoryEventStore } from "../memory-event-store";
import { effectiveContext, summarizeContext } from "./compaction";
import { IncrementalActiveContext } from "./context-choice";

function fixture() {
  const events: LogEvent[] = [];
  const logger = new EventLogger({ store: createMemoryEventStore(events) });
  const generate = vi.fn(async (_options?: unknown) => ({
    content: [{ type: "text" as const, text: "Keep the user's constraints." }],
    finishReason: { unified: "stop" as const, raw: "stop" },
    usage: {
      inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 10, text: 10, reasoning: 0 },
    },
    warnings: [],
  }));
  const languageModel = new MockLanguageModelV4({
    doGenerate: generate,
  });
  const raw: ModelMessage[] = [
    { role: "user", content: "Old user details " + "a".repeat(7_000) },
    { role: "assistant", content: "Old findings " + "b".repeat(7_000) },
  ];
  return { events, logger, generate, languageModel, raw };
}

describe("context choices and summary", () => {
  it("retains recent tool call/result pairs and user corrections while incrementally summarizing older history", async () => {
    const { events, logger, languageModel, generate } = fixture();
    const raw: ModelMessage[] = [
      { role: "user", content: "Original goal" },
      { role: "assistant", content: "old findings " + "x".repeat(8000) },
      { role: "user", content: "Correction: use the second account" },
      { role: "assistant", content: "more findings " + "y".repeat(14000) },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "c",
            toolName: "inspect",
            input: {},
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c",
            toolName: "inspect",
            output: { type: "text", value: "recent result" },
          },
        ],
      },
    ];
    const options = {
      branchIds: ["branch"],
      uiCount: 1,
      languageModel,
      logger,
      conversationId: "one",
      signal: new AbortController().signal,
      limit: {
        provider: "manual",
        model: "test",
        context: 20_000,
        source: "manual" as const,
      },
    };
    await summarizeContext({ ...options, raw });
    const first = await effectiveContext(events, options.branchIds, raw);
    expect(first.checkpoint?.sourceCount).toBe(4);
    expect(first.messages).toEqual([
      raw[0],
      raw[2],
      expect.objectContaining({
        role: "user",
        content: expect.stringContaining("Earlier conversation summary:"),
      }),
      raw[4],
      raw[5],
    ]);
    const extended: ModelMessage[] = [
      ...raw,
      { role: "assistant", content: "later " + "z".repeat(14000) },
      { role: "user", content: "new instruction" },
    ];
    await summarizeContext({ ...options, raw: extended });
    expect(generate).toHaveBeenCalledTimes(2);
    const nextPrompt = JSON.stringify(generate.mock.calls[1]);
    expect(nextPrompt).toContain("recent result");
    expect(nextPrompt).not.toContain("old findings");
    const second = await effectiveContext(events, options.branchIds, extended);
    expect(second.messages).toContainEqual(raw[0]);
    expect(second.messages).toContainEqual(raw[2]);
    expect(second.messages).toContainEqual(extended.at(-1));

    await logger.appendMessage("one", { id: "user", role: "user", parts: [{ type: "text", text: "Retry this request" }] }, { parentId: null });
    await logger.appendMessage("one", { id: "prior-reply", role: "assistant", parts: [{ type: "text", text: "Prior branch answer" }] }, { parentId: "user" });
    const projection = new IncrementalActiveContext(logger, "one");
    expect((await projection.read()).branchIds).toEqual(["user", "prior-reply"]);
    // Changing the run's head must invalidate a cached projection even when no
    // events arrive, without changing the durable idle branch selection.
    const retry = await projection.read("user");
    expect(retry.branchIds).toEqual(["user"]);
    expect(JSON.stringify(retry.messages)).not.toContain("Prior branch answer");
    expect(retry.checkpoint).toBeUndefined();
    expect((await projection.read()).branchIds).toEqual(["user", "prior-reply"]);
    expect((await logger.repository("one")).headId).toBe("prior-reply");
    await expect(projection.read("uncommitted-head")).rejects.toThrow("上下文锚点尚未保存");
  });

  it("does not write a checkpoint when one fragment fails", async () => {
    const { events, logger, raw } = fixture();
    let calls = 0;
    const languageModel = new MockLanguageModelV4({
      doGenerate: async () => {
        if (++calls === 2) throw new Error("second fragment unavailable");
        return {
          content: [{ type: "text", text: "first fragment" }],
          finishReason: { unified: "stop", raw: "stop" },
          usage: {
            inputTokens: {
              total: 100,
              noCache: 100,
              cacheRead: 0,
              cacheWrite: 0,
            },
            outputTokens: { total: 10, text: 10, reasoning: 0 },
          },
          warnings: [],
        };
      },
    });
    await expect(
      summarizeContext({
        raw,
        branchIds: ["u", "a"],
        uiCount: 2,
        languageModel,
        logger,
        conversationId: "one",
        signal: new AbortController().signal,
        limit: {
          provider: "manual",
          model: "test",
          context: 2_000,
          source: "manual",
        },
      }),
    ).rejects.toThrow("second fragment");
    expect(events.some((event) => event.type === "context.compacted")).toBe(
      false,
    );
    expect(
      events.some((event) => event.type === "context.compaction.failed"),
    ).toBe(true);
  });
});
