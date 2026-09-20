import { describe, expect, it } from "vitest";
import { EventLogger, type LogEvent } from "../logging";
import { compactToolResult, parseBrowserToolInput, prepareBrowserMessages, repairBrowserToolCall } from "./tool";

describe("browser tool input", () => {
  it("validates all modes and deterministic action schema", () => {
    expect(parseBrowserToolInput({ mode: "observe", tabId: 5, detail: "auto" })).toEqual({ mode: "observe", tabId: 5, detail: "auto" });
    expect(parseBrowserToolInput({ mode: "act", observationId: "o1", steps: [{ type: "fill", target: { by: "label", value: "Email" }, value: "a@b.test" }, { type: "expect", target: { ref: "e1" }, state: "visible" }] }).mode).toBe("act");
    expect(parseBrowserToolInput({ mode: "run", code: "return await chrome.tabs.query({})" })).toEqual({ mode: "run", code: "return await chrome.tabs.query({})" });
    expect(parseBrowserToolInput({ mode: "run", target: { kind: "page", tabId: 5, world: "MAIN" }, code: "return document.title" })).toMatchObject({ target: { kind: "page", tabId: 5, world: "MAIN" } });
    expect(parseBrowserToolInput({ mode: "result", id: 2087, path: ["observation", "snapshot"], offset: 0, limit: 4000 })).toEqual({ mode: "result", id: 2087, path: ["observation", "snapshot"], offset: 0, limit: 4000 });
    expect(() => parseBrowserToolInput({ mode: "run", code: "" })).toThrow();
    expect(() => parseBrowserToolInput({ mode: "act", steps: [] })).toThrow();
    expect(() => parseBrowserToolInput({ mode: "act", steps: [{ type: "expect", target: { ref: "e1" } }] })).toThrow();
    expect(() => parseBrowserToolInput({ mode: "act", steps: [{ type: "upload", target: { ref: "e1" }, files: [{ name: "x", text: "x", base64: "eA==" }] }] })).toThrow();
  });

  it("repairs only stringified act steps before strict validation", () => {
    const repaired = repairBrowserToolCall({ toolName: "browser", input: JSON.stringify({ mode: "act", steps: JSON.stringify([{ type: "goto", url: "https://example.com" }]) }) });
    expect(parseBrowserToolInput(JSON.parse(repaired!.input))).toEqual({ mode: "act", steps: [{ type: "goto", url: "https://example.com" }] });
    expect(repairBrowserToolCall({ toolName: "browser", input: JSON.stringify({ mode: "act", steps: "not json" }) })).toBeNull();
    expect(repairBrowserToolCall({ toolName: "browser", input: JSON.stringify({ mode: "act", steps: JSON.stringify({ type: "goto" }) }) })).toBeNull();
    expect(repairBrowserToolCall({ toolName: "other", input: JSON.stringify({ mode: "act", steps: "[]" }) })).toBeNull();
    expect(() => parseBrowserToolInput(JSON.parse(repairBrowserToolCall({ toolName: "browser", input: JSON.stringify({ mode: "act", steps: JSON.stringify([{ type: "goto", url: "invalid" }]) }) })!.input))).toThrow();
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
    const result = await compactToolResult(large, { logger, conversationId: "one", toolCallId: "call-1" }) as Record<string, unknown>;
    expect(result).toMatchObject({ $ref: 1, type: "array", preview: "Array(1500)", access: '{"mode":"result","id":1,"offset":0,"limit":50}' });
    expect(JSON.stringify(result).length).toBeLessThan(220);
    expect(events[0]).toMatchObject({ type: "tool.result.data", conversationId: "one", toolCallId: "call-1", output: large });
    expect((await logger.result(1) as typeof large).slice(0, 2)).toEqual(large.slice(0, 2));
    expect(await logger.result(1, { offset: 2, limit: 2 })).toEqual(large.slice(2, 4));
    await logger.deleteConversation("one");
    await expect(logger.result(1)).rejects.toThrow("unavailable");
    expect(await compactToolResult("small", { logger, conversationId: "one" })).toBe("small");
  });

  it("describes selectable object results with real keys and a bounded access example", async () => {
    const events: LogEvent[] = [];
    const store = {
      async append(event: Omit<LogEvent, "id">) { const saved = { ...event, id: events.length + 1 }; events.push(saved); return saved; },
      async all() { return [...events]; }, async clear() { events.length = 0; },
    };
    const logger = new EventLogger({ store });
    const result = await compactToolResult({ url: "https://example.com", snapshot: "page".repeat(3000) }, { logger }) as Record<string, unknown>;
    expect(result).toMatchObject({ keys: ["url", "snapshot"], access: '{"mode":"result","id":1,"path":["snapshot"],"offset":0,"limit":4000}' });
    expect(await logger.result(1, { path: "snapshot", offset: 4, limit: 4 })).toBe("page");
    await expect(logger.result(1, { limit: 4 })).rejects.toThrow('path: ["url"]');
  });

  it("points failed actions at the nested observation snapshot", async () => {
    const events: LogEvent[] = [];
    const logger = new EventLogger({ store: {
      async append(event: Omit<LogEvent, "id">) { const saved = { ...event, id: events.length + 1 }; events.push(saved); return saved; },
      async all() { return [...events]; }, async clear() { events.length = 0; },
    } });
    const result = await compactToolResult({ ok: false, completed: [], observation: { snapshot: "button".repeat(2000) } }, { logger }) as Record<string, unknown>;
    expect(result.access).toBe('{"mode":"result","id":1,"path":["observation","snapshot"],"offset":0,"limit":4000}');
  });

  it("injects only the latest screenshot into the next model step", () => {
    const messages = [{ role: "tool", content: [{ type: "tool-result", toolName: "browser", output: { type: "json", value: { observationId: "o1", screenshot: { mediaType: "image/jpeg", data: "abc" } } } }] }];
    const prepared = prepareBrowserMessages(messages, 1);
    expect(prepared[0].content[0].output.value.screenshot.data).toBe("[stored in canonical event log]");
    expect(prepared[1]).toMatchObject({ role: "user", content: [{ type: "file", mediaType: "image/jpeg", data: { type: "data", data: "abc" } }] });
    expect(prepareBrowserMessages(messages, 0)).toHaveLength(1);
  });
});
