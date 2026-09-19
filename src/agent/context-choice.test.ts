import { describe, expect, it, vi } from "vitest";
import { EventLogger, type ConversationMessage, type LogEvent } from "../logging";
import { activeContext, forkSelection, proposeJevSelection, selectMessages } from "./context-choice";
import { saveInheritedSummary } from "./compaction";

function fixture() {
  const events: LogEvent[] = [];
  const store = {
    async append(event: Omit<LogEvent, "id">) {
      const saved = { ...event, id: events.length + 1 };
      events.push(saved);
      return saved;
    },
    async all() { return [...events]; },
    async byTypes(types: readonly string[], conversationId?: string) {
      return events.filter((event) => types.includes(event.type) && (!conversationId || event.conversationId === conversationId));
    },
    async conversation(conversationId: string) { return events.filter((event) => event.conversationId === conversationId); },
    async deleteConversation(conversationId: string) {
      for (let index = events.length - 1; index >= 0; index -= 1) if (events[index]!.conversationId === conversationId) events.splice(index, 1);
    },
    async clear() { events.length = 0; },
  };
  return { logger: new EventLogger({ store }), events };
}

const message = (id: string, role: "user" | "assistant", text: string): ConversationMessage => ({
  id, role, parts: [{ type: "text", text }],
});

describe("Jev context workflow", () => {
  it("keeps every user message and closes tool call/result pairs", () => {
    const items: ConversationMessage[] = [
      message("u1", "user", "constraint"),
      { id: "a1", role: "assistant", parts: [{ type: "tool-chrome", toolCallId: "call-1", state: "input-available" }] },
      { id: "a2", role: "assistant", parts: [{ type: "tool-chrome", toolCallId: "call-1", state: "output-available" }] },
      message("u2", "user", "continue"),
    ];
    expect(selectMessages(items, new Map([[1, 0.9], [2, 0.1]]), 0.5).map((item) => item.id))
      .toEqual(["u1", "a1", "a2", "u2"]);
  });

  it("shows the minimum temporary threshold and forks only after selection is final", async () => {
    const { logger, events } = fixture();
    const model = { baseURL: "https://provider.test/v1", model: "test", apiKey: "key", contextWindowOverride: 6_000 };
    const jev = { provider: "typesafe" as const, baseURL: "https://jev.test", model: "jev", apiKey: "key", threshold: 0.5 };
    await logger.append({ type: "conversation.created", conversationId: "parent", content: { title: "Parent" } });
    const items = [
      message("u1", "user", "Keep the original constraint"),
      message("a1", "assistant", "important old details ".repeat(450)),
      message("u2", "user", "Continue the whole task"),
      message("a2", "assistant", "stale output ".repeat(450)),
    ];
    for (const [index, item] of items.entries()) await logger.appendMessage("parent", item, { parentId: items[index - 1]?.id ?? null });
    const score = vi.fn(async (state: unknown, candidates: readonly { index: number }[]) => ({
      probabilities: new Map(candidates.map(({ index }) => [index, index === 1 ? 0.8 : 0.6])),
      batches: 1, usage: { input_tokens: 10, output_tokens: 0 }, model: "jev",
    }));
    const proposal = await proposeJevSelection({ logger, conversationId: "parent", model, jev,
      signal: new AbortController().signal, selector: { score } });
    expect(score).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(score.mock.calls[0]?.[0])).toContain("original constraint");
    expect(proposal.minimumRaisedThreshold).toBe(0.81);
    expect(events.find((event) => event.type === "model.compaction.selection.finished")?.providerMetadata)
      .toEqual({ provider: "typesafe", model: "jev" });
    expect(events.filter((event) => event.type === "conversation.created")).toHaveLength(1);

    const child = await forkSelection(logger, "parent", proposal, proposal.minimumRaisedThreshold);
    expect((await activeContext(logger, child)).ui.map((item) => item.id)).toEqual(["u1", "u2"]);
    expect((await activeContext(logger, "parent")).ui.map((item) => item.id)).toEqual(["u1", "a1", "u2", "a2"]);
    expect(events.find((event) => event.conversationId === child && event.type === "conversation.created")?.content)
      .toMatchObject({ parentConversationId: "parent" });
  });

  it("does not offer a temporary threshold when retained user messages alone exceed 30%", async () => {
    const { logger, events } = fixture();
    const model = { baseURL: "https://provider.test/v1", model: "test", apiKey: "key", contextWindowOverride: 6_000 };
    const jev = { provider: "typesafe" as const, baseURL: "https://jev.test", model: "jev", apiKey: "key", threshold: 0.5 };
    await logger.append({ type: "conversation.created", conversationId: "parent", content: { title: "Parent" } });
    await logger.appendMessage("parent", message("u1", "user", "Important constraint ".repeat(400)), { parentId: null });
    await logger.appendMessage("parent", message("a1", "assistant", "Stale data ".repeat(100)), { parentId: "u1" });
    const proposal = await proposeJevSelection({ logger, conversationId: "parent", model, jev,
      signal: new AbortController().signal, selector: { score: async () => ({ probabilities: new Map([[1, 0.1]]),
        batches: 1, usage: { input_tokens: 1, output_tokens: 0 }, model: "jev" }) } });
    expect(proposal.minimumRaisedThreshold).toBeUndefined();
    expect(events.filter((event) => event.type === "conversation.created")).toHaveLength(1);
  });

  it("forks again from a child using only that child's selected history", async () => {
    const { logger } = fixture();
    await logger.append({ type: "conversation.created", conversationId: "parent", content: { title: "Parent" } });
    const original = [message("u1", "user", "keep"), message("a1", "assistant", "remove")];
    for (const [index, item] of original.entries()) await logger.appendMessage("parent", item, { parentId: original[index - 1]?.id ?? null });
    const source = await activeContext(logger, "parent");
    const first = await forkSelection(logger, "parent", { source, scores: { probabilities: new Map([[1, 0.1]]),
      batches: 1, usage: { input_tokens: 1, output_tokens: 0 }, model: "jev" }, selected: [original[0]!],
      estimated: 1, threshold: 0.5, limit: 6_000, inputThreshold: 4_000 });
    await logger.appendMessage(first, message("a2", "assistant", "new child detail"), { parentId: "u1" });
    const childSource = await activeContext(logger, first);
    expect(childSource.ui.map((item) => item.id)).toEqual(["u1", "a2"]);
    const second = await forkSelection(logger, first, { source: childSource, scores: { probabilities: new Map([[1, 0.9]]),
      batches: 1, usage: { input_tokens: 1, output_tokens: 0 }, model: "jev" }, selected: childSource.ui,
      estimated: 1, threshold: 0.5, limit: 6_000, inputThreshold: 4_000 });
    expect((await activeContext(logger, second)).ui.map((item) => item.id)).toEqual(["u1", "a2"]);
    expect((await activeContext(logger, "parent")).ui.map((item) => item.id)).toEqual(["u1", "a1"]);
  });

  it("carries a summary into a Jev child without restoring earlier raw messages", async () => {
    const { logger } = fixture();
    await logger.append({ type: "conversation.created", conversationId: "parent", content: { title: "Parent" } });
    await saveInheritedSummary(logger, "parent", "Earlier facts are summarized here");
    await logger.appendMessage("parent", message("u1", "user", "After summary"), { parentId: null });
    const source = await activeContext(logger, "parent");
    expect(JSON.stringify(source.messages)).toContain("Earlier facts are summarized here");
    const child = await forkSelection(logger, "parent", { source, scores: { probabilities: new Map(), batches: 0,
      usage: { input_tokens: 0, output_tokens: 0 }, model: "jev" }, selected: source.effectiveUi,
      estimated: 1, threshold: 0.5, limit: 6_000, inputThreshold: 4_000 });
    const childContext = await activeContext(logger, child);
    expect(childContext.ui.map((item) => item.id)).toEqual(["u1"]);
    expect(childContext.messages).toEqual(source.messages);
  });
});
