import { describe, expect, it, vi } from "vitest";
import { readUIMessageStream, type UIMessageChunk } from "ai";
import { EventLogger, fromLogValue, type ConversationMessage, type LogEvent } from "../logging";
import { createChatTransport, type SidePanelMessage } from "./transport";
import { PROGRAM_CATALOG_VERSION as TOOL_CATALOG_VERSION } from "../chrome/tool";

vi.mock("./coordinator", () => ({ claimConversationRun: async (_id: string, signal: AbortSignal) => ({ signal, finish: vi.fn() }) }));
vi.mock("../chrome/page-guard", () => ({ guardActivePage: async () => vi.fn() }));
vi.mock("ai", async (original) => ({ ...await original<typeof import("ai")>(),
  DirectChatTransport: class {
    constructor(private options: any) {}
    sendMessages(options: any) { return this.options.agent.open(options, this.options.onError, this.options.generateMessageId()); }
  },
}));
function logger() {
  const events: LogEvent[] = [];
  return new EventLogger({ store: {
    async append(record) { const stored = { ...record, id: events.length + 1 }; events.push(stored); return stored; },
    async all() { return [...events]; }, async clear() { events.length = 0; },
  } });
}
function stream(chunks: UIMessageChunk[]) {
  return new ReadableStream<UIMessageChunk>({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); } });
}
function response(id: string) { return stream([{ type: "start", messageId: id }, { type: "text-start", id: "text" },
  { type: "text-delta", id: "text", delta: "Recovered" }, { type: "text-end", id: "text" }, { type: "finish" }]); }
async function consume(transport: ReturnType<typeof createChatTransport>, user: SidePanelMessage) {
  const output = await transport.sendMessages({ trigger: "submit-message", chatId: "thread", messageId: user.id, messages: [user], abortSignal: new AbortController().signal });
  let result;
  for await (const message of readUIMessageStream({ stream: output })) result = message;
  return result;
}

describe("durable transport recovery", () => {
  it("keeps a new user untouched and logs the system catalogue snapshot and rebuilds the agent after overflow", async () => {
    const log = logger();
    const user: SidePanelMessage = { id: "user", role: "user", parts: [{ type: "text", text: "Continue" }] };
    await log.appendMessage("thread", user as ConversationMessage);
    const requests: SidePanelMessage[][] = [];
    const summarize = vi.fn(async (signal: AbortSignal) => {
      signal.throwIfAborted();
      const saved = (await log.repository("thread")).messages[0]!.message;
      await log.appendMessage("thread", { ...saved, metadata: { ...(saved.metadata as any), checkpointTest: true } });
      await log.append({ type: "context.compacted", conversationId: "thread", content: { summary: "Saved summary" } });
    });
    let factories = 0;
    const factory = vi.fn(async (signal, branchIds, resumed) => {
      expect(branchIds).toEqual(["user"]);
      expect(resumed).toBe(factories > 0);
      if (factories++) expect((await log.conversation("thread")).some((event) => event.type === "context.compacted")).toBe(true);
      return { open(options: any, onError: (error: unknown) => string, id: string) {
        requests.push(options.messages);
        if (requests.length === 1) {
          const error = Object.assign(new Error("maximum context length exceeded"), { statusCode: 400 });
          return stream([{ type: "start", messageId: id }, { type: "error", errorText: onError(error) }]);
        }
        expect(signal.aborted).toBe(false);
        expect(options.messages[0].metadata.checkpointTest).toBe(true);
        return response(id);
      } } as any;
    });
    const cleanup = vi.fn(async () => undefined);
    const result = await consume(createChatTransport(factory, log, "thread", cleanup, summarize), user);
    expect(result?.parts).toMatchObject([{ type: "text", text: "Recovered" }]);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(summarize).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(requests[0]![0]!.parts).toEqual(user.parts);
    const saved = (await log.repository("thread")).messages.find((entry) => entry.message.id === "user")!.message;
    expect((saved.metadata as any)?.custom?.toolCatalog).toBeUndefined();
    expect(fromLogValue((await log.contextEvents("thread"))[0]!.content)).toMatchObject({ prompt: { version: 2, catalogVersion: TOOL_CATALOG_VERSION, instructions: expect.stringContaining("Available tools:") } });
    expect((await log.all()).filter((event) => event.type === "conversation.finished")).toHaveLength(1);
  });

  it("preserves an old submitted catalogue prefix during regeneration", async () => {
    const log = logger();
    const user: SidePanelMessage = { id: "user", role: "user", parts: [{ type: "text", text: "Continue" }],
      metadata: { custom: { toolCatalog: { version: "0.2.0", context: "Historical tools" } } } };
    await log.appendMessage("thread", user as ConversationMessage);
    await log.append({ type: "conversation.submitted", conversationId: "thread", runId: "old", content: { messageId: "user" } });
    const factory = async () => ({ open(options: any, _onError: any, id: string) {
      expect(options.messages[0].parts).toMatchObject([{ type: "text", text: "Continue" }, { type: "text", text: "Historical tools" }]);
      return response(id);
    } }) as any;
    const transport = createChatTransport(factory, log, "thread");
    const output = await transport.sendMessages({ trigger: "regenerate-message", chatId: "thread", messageId: "user", messages: [user], abortSignal: new AbortController().signal });
    for await (const _message of readUIMessageStream({ stream: output })) { /* consume */ }
    const messages = (await log.all()).filter((event) => event.type === "conversation.message").map((event) => fromLogValue(event.content) as SidePanelMessage);
    expect(messages.filter((message) => message.id === "user")).toHaveLength(1);
    expect(messages[0]!.metadata.custom.toolCatalog.version).toBe("0.2.0");
  });
});
