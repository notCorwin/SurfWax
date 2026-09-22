import { describe, expect, it } from "vitest";
import type { EventLogger } from "../logging";
import { parseCommandTarget, type ChromeExecutor } from "./executor";
import { COMMAND_NAMES, compactToolResult, createCommandTools, parseCommandInput, prepareToolMessages, repairCommandToolCall, TOOL_SUMMARY } from "./tool";

describe("browser command tools", () => {
  it("registers exactly the 76 executable current-window commands", () => {
    expect(COMMAND_NAMES).toHaveLength(76);
    expect(new Set(COMMAND_NAMES).size).toBe(76);
    expect(COMMAND_NAMES).toEqual(expect.arrayContaining(["snapshot", "click", "run-code", "video-stop", "artifact-save"]));
    for (const name of ["install", "install-browser", "pause-at", "resume", "step-over"]) expect(COMMAND_NAMES as readonly string[]).not.toContain(name);
    expect(COMMAND_NAMES.filter((name) => ["browser", "open", "attach", "close", "detach", "show", "list", "close-all", "kill-all"].includes(name))).toEqual([]);
  });

  it("exposes all 78 tools in stable order without search or deferred loading", () => {
    const tools = createCommandTools({} as ChromeExecutor) as Record<string, any>;
    expect(Object.keys(tools)).toEqual([...COMMAND_NAMES, "act", "result"]);
    for (const name of ["install", "install-browser", "pause-at", "resume", "step-over"]) expect(tools).not.toHaveProperty(name);
    expect(tools).not.toHaveProperty("search-tools");
    expect(Object.values(tools).every((tool) => tool.deferLoading !== true)).toBe(true);
    expect(TOOL_SUMMARY.split("\n")).toHaveLength(78);
    for (const [name, tool] of Object.entries(tools)) expect(TOOL_SUMMARY).toContain(`- ${name}: ${tool.description}`);
  });

  it("repairs only lossless tool-name and stringified JSON mistakes", async () => {
    const tools = createCommandTools({} as ChromeExecutor);
    await expect(repairCommandToolCall({
      toolCall: { toolCallId: "1", toolName: "TAB_LIST", input: JSON.stringify("{}") }, tools,
    } as any)).resolves.toMatchObject({ toolName: "tab-list", input: "{}" });
    await expect(repairCommandToolCall({
      toolCall: { toolCallId: "2", toolName: "act", input: JSON.stringify({ steps: JSON.stringify([{ type: "goto", url: "https://example.com" }]) }) }, tools,
    } as any)).resolves.toMatchObject({ toolName: "act", input: JSON.stringify({ steps: [{ type: "goto", url: "https://example.com" }] }) });
  });

  it("stores large non-visual results once and returns a useful reference", async () => {
    const appended: any[] = [];
    const logger = { append: async (event: any) => { appended.push(event); return { ...event, id: 9 }; } } as EventLogger;
    const value = { snapshot: "x".repeat(9_000) };
    await expect(compactToolResult(value, { logger, conversationId: "c", toolCallId: "t" })).resolves.toMatchObject({
      $ref: 9, bytes: expect.any(Number), preview: "x".repeat(4000), access: { id: 9, path: ["snapshot"], offset: 0, limit: 4000 },
    });
    expect(appended).toHaveLength(1);
    expect(appended[0].output).toBe(value);
  });

  it("strictly validates command-specific structured inputs", () => {
    expect(parseCommandInput("click", { target: "e15", button: "right", modifiers: ["Shift"] })).toEqual({ target: "e15", button: "right", modifiers: ["Shift"] });
    expect(parseCommandInput("fill", { target: { by: "label", value: "Email" }, text: "a@b.test", submit: true })).toMatchObject({ text: "a@b.test" });
    expect(parseCommandInput("tab-select", { index: 0 })).toEqual({ index: 0 });
    expect(parseCommandInput("request", { index: 1 })).toEqual({ index: 1 });
    expect(parseCommandInput("upload", { files: [{ name: "a.txt", text: "hello" }] })).toMatchObject({ files: [{ name: "a.txt" }] });
    expect(parseCommandInput("upload", { files: [{ name: "a.txt", artifactId: 7 }] })).toMatchObject({ files: [{ artifactId: 7 }] });
    expect(parseCommandInput("screenshot", { filename: "internal.png", save: true })).toMatchObject({ filename: "internal.png", save: true });
    expect(() => parseCommandInput("click", { target: "e1", extra: true })).toThrow();
    expect(() => parseCommandInput("goto", { url: "https://example.com", session: "other" })).toThrow();
    expect(() => parseCommandInput("upload", { files: [{ name: "a.txt", text: "x", base64: "eA==" }] })).toThrow();
    expect(() => parseCommandInput("upload", { files: [{ name: "a.txt", text: "x", artifactId: 7 }] })).toThrow();
    expect(() => parseCommandInput("request", { index: 0 })).toThrow();
  });

  it("accepts refs, CSS, documented locators, and structured targets", () => {
    expect(parseCommandTarget("e15")).toEqual({ ref: "e15" });
    expect(parseCommandTarget("#main > button")).toEqual({ by: "css", value: "#main > button" });
    expect(parseCommandTarget("getByRole('button', { name: 'Submit', exact: true })")).toEqual({ by: "role", value: "button", name: "Submit", exact: true });
    expect(parseCommandTarget('getByText("Login")')).toEqual({ by: "text", value: "Login" });
    expect(parseCommandTarget('getByLabel("Email", { exact: false })')).toEqual({ by: "label", value: "Email", exact: false });
    expect(parseCommandTarget({ by: "label", value: "Email" })).toEqual({ by: "label", value: "Email" });
    expect(() => parseCommandTarget("getByUnknown('x')")).toThrow(/Unsupported locator expression/);
    expect(() => parseCommandTarget("getByRole('button', { pressed: true })")).toThrow(/Unsupported locator expression/);
  });

  it("injects only the latest screenshot and keeps historical browser results compatible", async () => {
    const messages = [{ role: "tool", content: [
      { type: "tool-result", toolName: "browser", output: { type: "json", value: { screenshot: { mediaType: "image/jpeg", data: "old" } } } },
      { type: "tool-result", toolName: "screenshot", output: { type: "json", value: { screenshot: { mediaType: "image/png", data: "new" } } } },
    ] }];
    const prepared = await prepareToolMessages(messages, 1, "tab context");
    expect(prepared[0].content[0].output.value.screenshot.data).toBe("[stored in canonical event log]");
    expect(prepared[0].content[1].output.value.screenshot.data).toBe("[stored in canonical event log]");
    expect(prepared[1]).toMatchObject({ role: "user", content: [
      { type: "text", text: "tab context" },
      { type: "file", mediaType: "image/png", data: { type: "data", data: "new" } },
    ] });
    expect(await prepareToolMessages(messages, 0)).toHaveLength(1);
    expect(await prepareToolMessages([], 0, "tab context")).toEqual([
      { role: "user", content: [{ type: "text", text: "tab context" }] },
    ]);
  });

  it("loads the latest screenshot from its canonical artifact", async () => {
    const messages = [{ role: "tool", content: [{
      type: "tool-result", toolName: "screenshot", output: { type: "json", value: { screenshot: { mediaType: "image/png", artifactId: 7 } } },
    }] }];
    const prepared = await prepareToolMessages(messages, 1, undefined, async (id) => ({ mimeType: "image/png", base64: `image-${id}` }));
    expect(prepared[1]).toMatchObject({ role: "user", content: [
      { type: "file", mediaType: "image/png", data: { type: "data", data: "image-7" } },
    ] });
    const value = { snapshot: "x".repeat(9_000), screenshot: { mediaType: "image/png", artifactId: 7 } };
    expect(await compactToolResult(value, { logger: { append: () => { throw new Error("must not compact visual results"); } } as unknown as EventLogger })).toBe(value);
  });
});
