import { describe, expect, it } from "vitest";
import { EventLogger, type LogEvent } from "../logging";
import { compactChromeResult, parseChromeToolInput } from "./tool";

describe("chrome tool input", () => {
  it("accepts optional page targets without allowing a world alone", () => {
    expect(parseChromeToolInput({ code: "return await chrome.tabs.query({});" })).toEqual({ code: "return await chrome.tabs.query({});" });
    expect(parseChromeToolInput({ code: "return document.title", tabId: 5 })).toEqual({ code: "return document.title", tabId: 5 });
    expect(parseChromeToolInput({ code: "return 1", tabId: 5, world: "USER_SCRIPT" }).world).toBe("USER_SCRIPT");
    expect(parseChromeToolInput({ code: "return document.title", target: { kind: "page", tabId: 5, frameId: 2, world: "ISOLATED" }, timeoutMs: 5000 }))
      .toEqual({ code: "return document.title", target: { kind: "page", tabId: 5, frameId: 2, world: "ISOLATED" }, timeoutMs: 5000 });
    expect(() => parseChromeToolInput({ code: "return 1", target: { kind: "native" } })).toThrow();
    expect(() => parseChromeToolInput({ code: "return 1", target: { kind: "page", tabId: 1 }, tabId: 1 })).toThrow();
    expect(() => parseChromeToolInput({ code: "" })).toThrow();
    expect(() => parseChromeToolInput({ code: "return 1", world: "MAIN" })).toThrow();
    expect(() => parseChromeToolInput({ code: "return 1", tabId: -1 })).toThrow();
    expect(() => parseChromeToolInput({ code: "return 1", operation: "call" })).toThrow();
  });

  it("persists large output before returning a compact reference, then expires it on deletion", async () => {
    const events: LogEvent[] = [];
    const store = {
      async append(event: Omit<LogEvent, "id">) { const saved = { ...event, id: events.length + 1 }; events.push(saved); return saved; },
      async all() { return [...events]; },
      async deleteConversation(id: string) { events.splice(0, events.length, ...events.filter((event) => event.conversationId !== id)); },
      async clear() { events.length = 0; },
    };
    const logger = new EventLogger({ store });
    const large = Array.from({ length: 1500 }, (_, index) => ({ index, text: "网页内容" }));
    const result = await compactChromeResult(large, { logger, conversationId: "one", toolCallId: "call-1" }) as Record<string, unknown>;
    expect(result).toMatchObject({ $ref: 1, type: "array", preview: "Array(1500)", access: "await globalThis.__surfWaxResult(1, {path?, offset?, limit?})" });
    expect(JSON.stringify(result).length).toBeLessThan(200);
    expect(events[0]).toMatchObject({ type: "tool.result.data", conversationId: "one", toolCallId: "call-1", output: large });
    expect((await logger.result(1) as typeof large).slice(0, 2)).toEqual(large.slice(0, 2));
    expect(await logger.result(1, { offset: 2, limit: 2 })).toEqual(large.slice(2, 4));
    await logger.deleteConversation("one");
    await expect(logger.result(1)).rejects.toThrow("unavailable");
    expect(await compactChromeResult("small", { logger, conversationId: "one" })).toBe("small");
  });
});
