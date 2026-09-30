import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { EventLogger, type LogEvent } from "../logging";
import { parseCommandTarget, ChromeExecutor } from "./executor";
import { COMMAND_NAMES, USER_SCRIPT_TOOL_NAMES, compactToolResult, createCommandTools, parseCommandInput, prepareToolMessages, repairCommandToolCall, TOOL_REGISTRY, TOOL_SUMMARY } from "./tool";

describe("browser command tools", () => {
  it.each(["screenshot", "pdf", "artifact-save"])("retains a %s artifact when the abort race settles before its underlying work", async (toolName) => {
    const events: LogEvent[] = [];
    const logger = new EventLogger({ store: {
      append: async (event) => { const stored = { ...event, id: events.length + 1 }; events.push(stored); return stored; },
      all: async () => [...events], clear: async () => { events.length = 0; },
    } });
    const metadata = { filename: toolName === "screenshot" ? "screen.png" : "page.pdf", mimeType: toolName === "screenshot" ? "image/png" : "application/pdf", byteLength: 1 };
    const stored = toolName === "artifact-save" ? await logger.append({ type: "tool.result.data", conversationId: "conversation", runId: "previous-run", content: metadata,
      output: { ...metadata, base64: "eA==" } }) : undefined;
    const input = stored ? { id: stored.id } : { filename: metadata.filename, save: true };
    logger.beginRun("conversation", "run"); logger.setRunPhase("run", 1);
    await logger.append({ type: "tool.started", conversationId: "conversation", toolCallId: "capture", content: { callId: "sdk", toolName }, input });
    const executor = new ChromeExecutor({ chromeApi: { debugger: {} } as never, logger, targetUrl: "chrome-extension://id/sidepanel.html#test" });
    let artifactId = stored?.id;
    let notifyStored!: () => void;
    const ready = new Promise<void>((resolve) => { notifyStored = resolve; });
    let finishWork!: () => void;
    let workFinished = false;
    (executor as any).executeCommandNow = async () => {
      if (!artifactId) artifactId = (await logger.append({ type: "tool.result.data", conversationId: "conversation", runId: "run", toolCallId: "1:capture", toolCallIdCanonical: true,
        content: metadata, output: { ...metadata, base64: "eA==" } }))!.id;
      notifyStored();
      return new Promise((resolve) => { finishWork = () => { workFinished = true; resolve(null); }; });
    };
    const controller = new AbortController();
    const tools = createCommandTools(executor, { logger, conversationId: "conversation" }) as Record<string, any>;
    const pending = tools[toolName].execute(input, { toolCallId: "capture", abortSignal: controller.signal });
    await ready;
    logger.setRunPhase("run", 2);
    controller.abort("sidepanel-closed");
    const result = await pending;
    expect(workFinished).toBe(false);
    expect(result).toMatchObject({ ok: false, error: { code: "aborted", message: "sidepanel-closed", effectUnknown: true }, artifact: { id: artifactId, ...metadata } });
    expect(result).not.toHaveProperty("artifact.saved");
    expect(JSON.stringify(result)).not.toContain("eA==");
    // The SDK terminal wins first; background recovery must preserve it intact.
    await logger.append({ type: "tool.failed", conversationId: "conversation", toolCallId: "capture", content: { callId: "sdk", toolName }, input, output: result, error: result.error });
    await logger.closePendingTools("run", "conversation", "owner-disconnected");
    expect(events.filter((event) => event.type === "tool.failed")).toHaveLength(1);
    expect(events.find((event) => event.type === "tool.failed")).toMatchObject({ toolCallId: "1:capture", output: result });
    finishWork(); await (executor as any).tail; executor.dispose();
  });
  it("preserves a large failed act result through the registered tool without compacting away its failure", async () => {
    const failed = { ok: false, completed: [{ index: 0, type: "fill", result: { text: "completed".repeat(2000) } }], failed: { index: 1, step: { type: "expect" }, error: { code: "timeout", message: "interrupted", effectUnknown: true } }, notRun: [{ type: "click" }] };
    expect(JSON.stringify(failed).length).toBeGreaterThan(8000);
    const append = vi.fn(async () => ({ id: 7 }));
    const logger = { append, toolIdentity: () => ({ toolCallId: "call", toolCallIdCanonical: true }) } as unknown as EventLogger;
    const tools = createCommandTools({ executeBrowser: vi.fn(async () => failed) } as unknown as ChromeExecutor, { logger, conversationId: "conversation" }) as Record<string, any>;
    const result = await tools.act.execute({ steps: [{ type: "goto", url: "https://test/" }] }, { toolCallId: "call" });
    expect(result).toEqual({ ...failed, error: { ...failed.failed.error, retryable: false } });
    expect(result).not.toHaveProperty("$ref");
    expect(append).not.toHaveBeenCalled();
    await expect(compactToolResult({ type: "tool-error", error: "large".repeat(2000) }, { logger })).resolves.toHaveProperty("type", "tool-error");
  });

  it("stores a large result with its original identity after a request phase changes", async () => {
    let phase = 1;
    const append = vi.fn(async () => ({ id: 7 }));
    const logger = { append, toolIdentity: (_conversation: string, id: string) => ({ runId: "run", toolCallId: `${phase}:${id}`, toolCallIdCanonical: true }) } as unknown as EventLogger;
    let finish!: (value: unknown) => void;
    const executeCommand = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const tools = createCommandTools({ executeCommand } as unknown as ChromeExecutor, { logger, conversationId: "conversation" }) as Record<string, any>;
    const pending = tools.eval.execute({ func: "() => null" }, { toolCallId: "call" });
    await vi.waitFor(() => expect(executeCommand).toHaveBeenCalled());
    phase = 2; finish("original".repeat(2000));
    await expect(pending).resolves.toMatchObject({ $ref: 7 });
    expect(append).toHaveBeenCalledWith(expect.objectContaining({ type: "tool.result.data", runId: "run", toolCallId: "1:call", toolCallIdCanonical: true }));
  });

  it("registers exactly the 42 executable current-window commands", () => {
    expect(COMMAND_NAMES).toHaveLength(42);
    expect(new Set(COMMAND_NAMES).size).toBe(42);
    expect(COMMAND_NAMES).toEqual(expect.arrayContaining(["snapshot", "click", "run-code", "artifact-save"]));
    for (const name of ["state-save", "state-load", "cookie-clear"]) expect(COMMAND_NAMES as readonly string[]).not.toContain(name);
    for (const name of ["install", "install-browser", "pause-at", "resume", "step-over"]) expect(COMMAND_NAMES as readonly string[]).not.toContain(name);
    expect(COMMAND_NAMES.filter((name) => ["browser", "open", "attach", "close", "detach", "show", "list", "close-all", "kill-all"].includes(name))).toEqual([]);
  });

  it("exposes browser and user-script tools in stable order without search or deferred loading", () => {
    const tools = createCommandTools({} as ChromeExecutor) as Record<string, any>;
    expect(Object.keys(tools)).toEqual([...COMMAND_NAMES, "act", "result", ...USER_SCRIPT_TOOL_NAMES]);
    for (const name of ["install", "install-browser", "pause-at", "resume", "step-over"]) expect(tools).not.toHaveProperty(name);
    expect(tools).not.toHaveProperty("search-tools");
    expect(Object.values(tools).every((tool) => tool.deferLoading !== true)).toBe(true);
    expect(TOOL_SUMMARY.split("\n")).toHaveLength(49);
    expect(Object.keys(tools)).toEqual(TOOL_REGISTRY.map(({ name }) => name));
    expect(new TextEncoder().encode(TOOL_SUMMARY).byteLength).toBeLessThanOrEqual(4100);
    for (const { name, summary } of TOOL_REGISTRY) expect(TOOL_SUMMARY).toContain(`- ${name}: ${summary}`);
  });

  it("keeps actual serialized tool metadata within the context budget", () => {
    const metadata = TOOL_REGISTRY.map(({ name, description, inputSchema }) => ({ name, description, parameters: z.toJSONSchema(inputSchema) }));
    expect(new TextEncoder().encode(JSON.stringify(metadata)).byteLength).toBeLessThanOrEqual(50_500);
  });

  it("rejects unsupported coordinate actions and ambiguous tab selectors", () => {
    const point = { point: { observationId: "capture", x: 5, y: 10 } };
    expect(parseCommandInput("click", { target: point, button: "right", modifiers: ["Shift"] })).toMatchObject({ target: point });
    expect(() => parseCommandInput("fill", { target: point, text: "bad" })).toThrow();
    expect(() => parseCommandInput("tab-select", {})).toThrow();
    expect(() => parseCommandInput("tab-select", { tabId: 41, index: 0 })).toThrow();
    expect(parseCommandInput("tab-select", { tabId: 41 })).toEqual({ tabId: 41 });
    const tools = createCommandTools({} as ChromeExecutor) as Record<string, any>;
    expect(() => tools.act.inputSchema.parse({ steps: [{ type: "fill", target: point, value: "bad" }] })).toThrow();
    expect(() => tools.act.inputSchema.parse({ steps: [{ type: "click", target: { ref: "e1" }, value: "invalid" }] })).toThrow();
  });

  it("validates native user-script definitions and keeps enabled outside them", () => {
    const tools = createCommandTools({} as ChromeExecutor) as Record<string, any>;
    const script = { id: "sample", matches: ["https://example.com/*"], js: [{ code: "document.title = 'Ready'" }] };
    expect(tools["userscript-create"].inputSchema.parse({ script })).toEqual({ script });
    expect(() => tools["userscript-create"].inputSchema.parse({ script: { ...script, enabled: false } })).toThrow();
    expect(tools["userscript-edit"].inputSchema.parse({ id: "sample", changes: { js: [{ code: "1" }], runAt: null } })).toMatchObject({ id: "sample" });
    expect(() => tools["userscript-edit"].inputSchema.parse({ id: "sample", changes: { id: "changed" } })).toThrow();
  });

  it("routes all five user-script tools through the background manager", async () => {
    const sendMessage = vi.fn(async (message) => ({ ok: true, result: message.method }));
    vi.stubGlobal("chrome", { runtime: { sendMessage } });
    try {
      const tools = createCommandTools({} as ChromeExecutor) as Record<string, any>;
      const script = { id: "sample", matches: ["https://example.com/*"], js: [{ code: "1" }] };
      const inputs = [{}, { id: "sample" }, { script }, { id: "sample", changes: { js: [{ code: "2" }] } }, { id: "sample", enabled: false }];
      for (const [index, name] of USER_SCRIPT_TOOL_NAMES.entries()) {
        await expect(tools[name].execute(inputs[index], { toolCallId: `call-${index}` })).resolves.toBe(["list", "read", "create", "edit", "setEnabled"][index]);
      }
      expect(sendMessage.mock.calls.map(([{ operationId, ...message }]) => { expect(operationId).toEqual(expect.any(String)); return message; })).toEqual([
        { type: "surf-wax:user-scripts", method: "list", args: [] },
        { type: "surf-wax:user-scripts", method: "read", args: ["sample"] },
        { type: "surf-wax:user-scripts", method: "create", args: [script] },
        { type: "surf-wax:user-scripts", method: "edit", args: [inputs[3]] },
        { type: "surf-wax:user-scripts", method: "setEnabled", args: [inputs[4]] },
      ]);
    } finally { vi.unstubAllGlobals(); }
  });

  it("ends a pending user-script tool call when the panel aborts", async () => {
    vi.stubGlobal("chrome", { runtime: { sendMessage: () => new Promise(() => undefined) } });
    try {
      const controller = new AbortController();
      const tools = createCommandTools({} as ChromeExecutor) as Record<string, any>;
      const result = tools["userscript-set-enabled"].execute({ id: "sample", enabled: false }, { toolCallId: "call", abortSignal: controller.signal });
      controller.abort();
      await expect(result).resolves.toEqual({ ok: false, error: { code: "aborted", message: "Operation aborted", retryable: false, effectUnknown: true } });
    } finally { vi.unstubAllGlobals(); }
  });

  it("appends the tool catalog once to the first model-visible user message", async () => {
    const stringMessages = [{ role: "user", content: "Do the task" }, { role: "assistant", content: "Working" }];
    const first = await prepareToolMessages(stringMessages, 0);
    expect(first[0].content).toBe(`Do the task\n\nAvailable tools:\n${TOOL_SUMMARY}`);
    expect(await prepareToolMessages(first, 1)).toEqual(first);

    const parts = await prepareToolMessages([{ role: "user", content: [{ type: "text", text: "Inspect this" }, { type: "file", data: "image" }] }], 0);
    expect(parts[0].content).toEqual([
      { type: "text", text: "Inspect this" },
      { type: "file", data: "image" },
      { type: "text", text: `Available tools:\n${TOOL_SUMMARY}` },
    ]);
  });

  it("repairs only lossless tool-name and stringified JSON mistakes", async () => {
    const tools = createCommandTools({} as ChromeExecutor);
    await expect(repairCommandToolCall({
      toolCall: { toolCallId: "1", toolName: "TAB_LIST", input: JSON.stringify("{}") }, tools,
    } as any)).resolves.toMatchObject({ toolName: "tab-list", input: "{}" });
    await expect(repairCommandToolCall({
      toolCall: { toolCallId: "2", toolName: "act", input: JSON.stringify({ steps: JSON.stringify([{ type: "goto", url: "https://example.com" }]) }) }, tools,
    } as any)).resolves.toMatchObject({ toolName: "act", input: JSON.stringify({ steps: [{ type: "goto", url: "https://example.com" }] }) });
    await expect(repairCommandToolCall({
      toolCall: { toolCallId: "3", toolName: "mousewheel", input: '{"deltaX":0,"deltaY":600}' }, tools,
    } as any)).resolves.toMatchObject({ input: '{"dx":0,"dy":600}' });
    await expect(repairCommandToolCall({
      toolCall: { toolCallId: "4", toolName: "mousewheel", input: '{"dx":1,"deltaX":0,"deltaY":600}' }, tools,
    } as any)).resolves.toBeNull();
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

  it("does not suggest retrying a timed-out operation with uncertain effects", async () => {
    const error = Object.assign(new DOMException("late Chrome response", "TimeoutError"), { effectUnknown: true });
    const tools = createCommandTools({ executeCommand: async () => { throw error; } } as unknown as ChromeExecutor) as Record<string, any>;
    await expect(tools["tab-new"].execute({}, { toolCallId: "call" })).resolves.toEqual({
      ok: false, error: { code: "timeout", message: "late Chrome response", retryable: false, effectUnknown: true },
    });
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

  it("removes raw screenshots from older tool messages on later steps", async () => {
    const messages = [
      { role: "tool", content: [{ type: "tool-result", output: { type: "json", value: { screenshot: { mediaType: "image/png", data: "older-image" } } } }] },
      { role: "assistant", content: [{ type: "text", text: "continue" }] },
      { role: "tool", content: [{ type: "tool-result", output: { type: "json", value: { screenshot: { mediaType: "image/png", data: "latest-image" } } } }] },
    ];
    const prepared = await prepareToolMessages(messages, 2);
    expect(JSON.stringify(prepared)).not.toContain("older-image");
    expect(prepared[0].content[0].output.value.screenshot.data).toBe("[stored in canonical event log]");
    expect(prepared.at(-1)).toMatchObject({ role: "user", content: [{ type: "file", data: { data: "latest-image" } }] });
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
