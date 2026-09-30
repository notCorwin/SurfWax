import { describe, expect, it, vi } from "vitest";
import { convertToModelMessages, readUIMessageStream, type UIMessageChunk } from "ai";
import { EventLogger, type LogEvent } from "../logging";
import { recoverModelStream } from "./stream-recovery";
function logger() { const events: LogEvent[] = []; return new EventLogger({ store: {
  async append(record) { const event = { ...record, id: events.length + 1 }; events.push(event); return event; },
  async all() { return [...events]; }, async clear() { events.length = 0; },
} }); }
function stream(chunks: UIMessageChunk[]) { return new ReadableStream<UIMessageChunk>({ start(c) { for (const chunk of chunks) c.enqueue(chunk); c.close(); } }); }
describe("SSE recovery", () => {
  it("summarizes a provider context rejection inside the same run and resumes its durable result", async () => {
    const log = logger();
    const overflow = Object.assign(new Error("maximum context length exceeded"), { statusCode: 400 });
    let calls = 0;
    const summarize = vi.fn(async (signal: AbortSignal) => {
      signal.throwIfAborted();
      expect((await log.messages("thread"))[0]?.parts).toMatchObject([{ type: "text", text: "Retained. " }]);
    });
    const open = vi.fn(async (messages, capture) => {
      if (++calls === 1) {
        capture(overflow);
        return stream([{ type: "start", messageId: "reply" }, { type: "text-start", id: "text" },
          { type: "text-delta", id: "text", delta: "Retained. " }, { type: "error", errorText: overflow.message }]);
      }
      expect(summarize).toHaveBeenCalledOnce();
      expect(messages.at(-1).parts[0].text).toBe("Retained. ");
      return stream([{ type: "start", messageId: "reply" }, { type: "text-start", id: "text" },
        { type: "text-delta", id: "text", delta: "Recovered." }, { type: "text-end", id: "text" }, { type: "finish" }]);
    });
    let result;
    for await (const message of readUIMessageStream({ stream: recoverModelStream({ open, messages: [], logger: log, conversationId: "thread", runId: "run", parentId: null,
      signal: new AbortController().signal, onContextOverflow: summarize, sleep: async () => undefined }) })) result = message;
    expect(result?.parts.filter((part) => part.type === "text").map((part) => part.text).join("")).toBe("Retained. Recovered.");
    expect((await log.all()).filter((event) => event.type === "model.stream.retrying")).toMatchObject([{ retry: { attempt: 1, delayMs: 0, reason: "context-overflow" } }]);
  });

  it("does not repeat an ineffective overflow summary or persist an empty assistant", async () => {
    const log = logger();
    const overflow = Object.assign(new Error("maximum context length exceeded"), { statusCode: 400 });
    const summarize = vi.fn(async () => undefined);
    const open = vi.fn(async (_messages, capture) => { capture(overflow); return stream([{ type: "start", messageId: "empty" }, { type: "error", errorText: overflow.message }]); });
    const reader = recoverModelStream({ open, messages: [], logger: log, conversationId: "thread", runId: "run", parentId: null,
      signal: new AbortController().signal, onContextOverflow: summarize, sleep: async () => undefined }).getReader();
    await expect((async () => { while (!(await reader.read()).done) { /* consume */ } })()).rejects.toThrow(overflow.message);
    expect(open).toHaveBeenCalledTimes(2);
    expect(summarize).toHaveBeenCalledOnce();
    expect(await log.messages("thread")).toEqual([]);
  });
  it("treats a missing finish event as a disconnect and closes the old phase before continuing", async () => {
    const log = logger();
    const signals: AbortSignal[] = [];
    const open = vi.fn(async (messages, _capture, signal) => {
      signals.push(signal);
      if (signals.length === 1) return stream([{ type: "start", messageId: "reply" }, { type: "text-start", id: "text" },
        { type: "text-delta", id: "text", delta: "Retained. " }]);
      expect(signals[0]!.aborted).toBe(true);
      expect(messages.at(-1).parts[0].text).toBe("Retained. ");
      return stream([{ type: "start", messageId: "reply" }, { type: "text-start", id: "text" },
        { type: "text-delta", id: "text", delta: "Continued." }, { type: "text-end", id: "text" }, { type: "finish" }]);
    });
    let message;
    for await (const next of readUIMessageStream({ stream: recoverModelStream({ open, messages: [], logger: log, conversationId: "thread", runId: "run", parentId: null,
      signal: new AbortController().signal, sleep: async () => undefined }) })) message = next;
    expect(open).toHaveBeenCalledTimes(2);
    expect(message?.parts.filter((part) => part.type === "text").map((part) => part.text).join("")).toBe("Retained. Continued.");
  });

  it("finishes partial tool input as an unexecuted error with valid model-call input", async () => {
    const log = logger();
    let attempts = 0;
    const open = vi.fn(async (messages, capture) => {
      if (++attempts === 1) { capture(new TypeError("connection reset")); return stream([
        { type: "start", messageId: "reply" }, { type: "tool-input-start", toolCallId: "partial", toolName: "click", dynamic: true },
        { type: "tool-input-delta", toolCallId: "partial", inputTextDelta: '{"target":' }, { type: "error", errorText: "connection reset" },
      ]); }
      expect(messages.at(-1).parts).toEqual(expect.arrayContaining([expect.objectContaining({ toolCallId: "partial", state: "output-error", input: {} })]));
      const converted = await convertToModelMessages(messages, { ignoreIncompleteToolCalls: true });
      expect(converted).toEqual(expect.arrayContaining([expect.objectContaining({ role: "assistant", content: expect.arrayContaining([expect.objectContaining({ type: "tool-call", input: {} })]) })]));
      return stream([{ type: "start", messageId: "reply" }, { type: "finish" }]);
    });
    for await (const _next of readUIMessageStream({ stream: recoverModelStream({ open, messages: [], logger: log, conversationId: "thread", runId: "run", parentId: null,
      signal: new AbortController().signal, sleep: async () => undefined }) })) { /* consume */ }
    expect(open).toHaveBeenCalledTimes(2);
    expect((await log.all()).some((event) => event.type === "tool.started")).toBe(false);
  });

  it("stops a recovery backoff when its consumer cancels the stream", async () => {
    const log = logger();
    const sleep = vi.fn(() => new Promise<void>(() => undefined));
    const open = vi.fn(async (_messages, capture) => { capture(new TypeError("network")); return stream([{ type: "error", errorText: "network" }]); });
    const reader = recoverModelStream({ open, messages: [], logger: log, conversationId: "thread", runId: "run", parentId: null,
      signal: new AbortController().signal, sleep }).getReader();
    await vi.waitFor(() => expect(sleep).toHaveBeenCalledOnce());
    await reader.cancel("user-stopped");
    await Promise.resolve();
    expect(open).toHaveBeenCalledOnce();
  });

  it("persists text and completed tools before resuming without replay", async () => {
    const log = logger(); let attempts = 0; log.setRunPhase("run", 0);
    await log.append({ type: "tool.started", runId: "run", conversationId: "thread", toolCallId: "call", content: { toolName: "click" } });
    await log.append({ type: "tool.finished", runId: "run", conversationId: "thread", toolCallId: "call", output: { ok: true } });
    const open = vi.fn(async (messages, capture) => {
      if (++attempts === 1) { capture(new TypeError("connection reset")); return stream([
        { type: "start", messageId: "reply" }, { type: "text-start", id: "text" }, { type: "text-delta", id: "text", delta: "First. " },
        { type: "tool-input-available", toolCallId: "call", toolName: "click", input: { target: "e1" } },
        { type: "tool-output-available", toolCallId: "call", output: { ok: true } }, { type: "error", errorText: "connection reset" },
      ]); }
      expect(messages.at(-1).parts).toEqual(expect.arrayContaining([expect.objectContaining({ type: "text", text: "First. " }), expect.objectContaining({ state: "output-available", output: { ok: true } })]));
      expect((await log.all()).some((event) => event.type === "conversation.message")).toBe(true);
      return stream([{ type: "start", messageId: "reply" }, { type: "text-start", id: "text" }, { type: "text-delta", id: "text", delta: "Second." }, { type: "text-end", id: "text" }, { type: "finish" }]);
    });
    let message;
    for await (const next of readUIMessageStream({ stream: recoverModelStream({ open, messages: [{ id: "user", role: "user", parts: [{ type: "text", text: "work" }] }], logger: log, conversationId: "thread", runId: "run", parentId: "user", signal: new AbortController().signal, sleep: async () => undefined }) })) message = next;
    expect(open).toHaveBeenCalledTimes(2);
    expect(message?.parts.filter((part) => part.type === "text").map((part) => part.text).join("")).toBe("First. Second.");
    expect((await log.all()).filter((event) => event.type === "tool.finished")).toHaveLength(1);
  });
});
