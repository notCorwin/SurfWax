import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { EventLogger, type LogEvent } from "../logging";
import { parseLocatorTarget, ChromeExecutor } from "./executor";
import { compactToolResult, createProgramTools, prepareToolMessages, repairProgramToolCall, PROGRAM_TOOL_REGISTRY, PROGRAM_TOOL_CONTEXT } from "./tool";
import { callUserScript } from "./script-client";

describe("three browser tools", () => {
  it.each(["screenshot", "pdf", "save"])("retains a %s artifact when the abort race settles before its underlying work", async (operation) => {
    const events: LogEvent[] = [];
    const logger = new EventLogger({ store: {
      append: async (event) => { const stored = { ...event, id: events.length + 1 }; events.push(stored); return stored; },
      all: async () => [...events], clear: async () => { events.length = 0; },
    } });
    const metadata = { filename: operation === "screenshot" ? "screen.png" : "page.pdf", mimeType: operation === "screenshot" ? "image/png" : "application/pdf", byteLength: 1 };
    const stored = operation === "save" ? await logger.append({ type: "tool.result.data", conversationId: "conversation", runId: "previous-run", content: metadata,
      output: { ...metadata, base64: "eA==" } }) : undefined;
    const input = { code: operation === "save" ? `return await artifacts.save(${stored!.id});` : `return await page.${operation}({save:true});` };
    logger.beginRun("conversation", "run"); logger.setRunPhase("run", 1);
    await logger.append({ type: "tool.started", conversationId: "conversation", toolCallId: "capture", content: { callId: "sdk", toolName: "run" }, input });
    const executor = new ChromeExecutor({ chromeApi: { debugger: {} } as never, logger });
    let artifactId = stored?.id;
    let notifyStored!: () => void;
    const ready = new Promise<void>((resolve) => { notifyStored = resolve; });
    let finishWork!: () => void;
    let workFinished = false;
    executor.runProgram = async (_input, signal) => {
      if (!artifactId) artifactId = (await logger.append({ type: "tool.result.data", conversationId: "conversation", runId: "run", toolCallId: "1:capture", toolCallIdCanonical: true,
        content: metadata, output: { ...metadata, base64: "eA==" } }))!.id;
      if (stored) await logger.append({ type: "browser.artifact.used", conversationId: "conversation", runId: "run", toolCallId: "1:capture", toolCallIdCanonical: true, content: { artifactId } });
      notifyStored();
      return (executor as any).awaitAbort(new Promise((resolve) => { finishWork = () => { workFinished = true; resolve(null); }; }), signal, true);
    };
    const controller = new AbortController();
    const tools = createProgramTools(executor, { logger, conversationId: "conversation" }) as Record<string, any>;
    const pending = tools.run.execute(input, { toolCallId: "capture", abortSignal: controller.signal });
    await ready; logger.setRunPhase("run", 2); controller.abort("sidepanel-closed");
    const result = await pending;
    expect(workFinished).toBe(false);
    expect(result).toMatchObject({ ok: false, error: { code: "aborted", message: "sidepanel-closed", effectUnknown: true }, artifact: { id: artifactId, ...metadata } });
    expect(result).not.toHaveProperty("artifact.saved"); expect(JSON.stringify(result)).not.toContain("eA==");
    await logger.append({ type: "tool.failed", conversationId: "conversation", toolCallId: "capture", content: { callId: "sdk", toolName: "run" }, input, output: result, error: result.error });
    await logger.closePendingTools("run", "conversation", "owner-disconnected");
    expect(events.filter((event) => event.type === "tool.failed")).toHaveLength(1);
    expect(events.find((event) => event.type === "tool.failed")).toMatchObject({ toolCallId: "1:capture", output: result });
    finishWork(); executor.dispose();
  });
  it("preserves a large failed program and its full partial output without hiding the failure", async () => {
    const failed = { ok: false, state: "failed", result: { error: { code: "timeout", message: "interrupted", effectUnknown: true }, completed: "completed".repeat(2000) } };
    expect(JSON.stringify(failed).length).toBeGreaterThan(8000);
    const append = vi.fn(async () => ({ id: 7 }));
    const logger = { append, toolIdentity: () => ({ toolCallId: "call", toolCallIdCanonical: true }) } as unknown as EventLogger;
    const tools = createProgramTools({ runProgram: vi.fn(async () => failed) } as unknown as ChromeExecutor, { logger, conversationId: "conversation" }) as Record<string, any>;
    const result = await tools.run.execute({ code: "await check(false);" }, { toolCallId: "call" });
    expect(result).toEqual({ ...failed, error: { ...failed.result.error, retryable: false } });
    expect(result).not.toHaveProperty("$ref"); expect(append).not.toHaveBeenCalled();
    await expect(compactToolResult({ type: "tool-error", error: "large".repeat(2000) }, { logger })).resolves.toHaveProperty("type", "tool-error");
  });
  it("stores a large result with its original identity after a request phase changes", async () => {
    let phase = 1;
    const append = vi.fn(async () => ({ id: 7 }));
    const logger = { append, toolIdentity: (_conversation: string, id: string) => ({ runId: "run", toolCallId: `${phase}:${id}`, toolCallIdCanonical: true }) } as unknown as EventLogger;
    let finish!: (value: unknown) => void;
    const runProgram = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const tools = createProgramTools({ runProgram } as unknown as ChromeExecutor, { logger, conversationId: "conversation" }) as Record<string, any>;
    const pending = tools.run.execute({ code: "return await page.evaluate(() => null);" }, { toolCallId: "call" });
    await vi.waitFor(() => expect(runProgram).toHaveBeenCalled());
    phase = 2; finish({ ok: true, result: "original".repeat(2000) });
    await expect(pending).resolves.toMatchObject({ $ref: 7, access: { path: ["result"] } });
    expect(append).toHaveBeenCalledWith(expect.objectContaining({ type: "tool.result.data", runId: "run", toolCallId: "1:call", toolCallIdCanonical: true }));
  });
  it("registers exactly inspect/run/jobs in stable order, with no old tool aliases or deferred loading", () => {
    const tools = createProgramTools({} as ChromeExecutor) as Record<string, any>;
    expect(Object.keys(tools)).toEqual(["inspect", "run", "jobs"]);
    expect(Object.keys(tools)).toEqual(PROGRAM_TOOL_REGISTRY.map(({ name }) => name));
    for (const name of ["snapshot", "act", "run-code", "browser", "result", "userscript-create", "click", "search-tools", "install"]) expect(tools).not.toHaveProperty(name);
    expect(Object.values(tools).every((tool) => tool.deferLoading !== true)).toBe(true);
    for (const { name, summary } of PROGRAM_TOOL_REGISTRY) expect(PROGRAM_TOOL_CONTEXT).toContain(`- ${name}: ${summary}`);
  });
  it("keeps actual serialized tool metadata and the documented program API within budget", () => {
    const metadata = PROGRAM_TOOL_REGISTRY.map(({ name, description, inputSchema }) => ({ name, description, parameters: z.toJSONSchema(inputSchema) }));
    expect(new TextEncoder().encode(JSON.stringify(metadata)).byteLength).toBeLessThanOrEqual(5050);
    expect(new TextEncoder().encode(PROGRAM_TOOL_CONTEXT).byteLength).toBeLessThanOrEqual(6000);
  });
  it("strictly validates the three public schemas, including job ownership selectors", () => {
    const tools = createProgramTools({} as ChromeExecutor) as Record<string, any>;
    expect(tools.inspect.inputSchema.parse({ region: { by: "label", value: "Email" }, fields: ["text", "ref"], budget: 100 })).toHaveProperty("budget", 100);
    expect(() => tools.inspect.inputSchema.parse({ image: true, readonly: true })).toThrow();
    expect(() => tools.run.inputSchema.parse({ code: "return 1;", world: "MAIN" })).toThrow();
    expect(() => tools.jobs.inputSchema.parse({ action: "cancel" })).toThrow();
    expect(() => tools.jobs.inputSchema.parse({ action: "wait", id: "one", waitMs: 30001 })).toThrow();
    expect(tools.jobs.inputSchema.parse({ action: "list" })).toEqual({ action: "list" });
  });
  it("preserves historical user content and never injects an executable old catalogue", async () => {
    const messages = [{ role: "user", content: "Task\n\nAvailable tools:\n- run-code: historical" }, { role: "assistant", content: "Working" }];
    expect(await prepareToolMessages(messages, 0)).toEqual(messages);
    expect(await prepareToolMessages([{ role: "user", content: "Task" }], 0)).toEqual([{ role: "user", content: "Task" }]);
  });
  it("repairs only lossless current tool names/stringified JSON and never translates old names", async () => {
    const tools = createProgramTools({} as ChromeExecutor);
    await expect(repairProgramToolCall({ toolCall: { toolCallId: "1", toolName: "INSPECT", input: JSON.stringify("{}") }, tools } as any)).resolves.toMatchObject({ toolName: "inspect", input: "{}" });
    for (const name of ["run-code", "RUN_CODE", "act", "snapshot", "click", "userscript-list"]) {
      await expect(repairProgramToolCall({ toolCall: { toolCallId: "old", toolName: name, input: "{}" }, tools } as any)).resolves.toBeNull();
    }
  });
  it("never suggests retrying timed-out programs with uncertain effects", async () => {
    const error = Object.assign(new DOMException("late Chrome response", "TimeoutError"), { effectUnknown: true });
    const tools = createProgramTools({ runProgram: async () => { throw error; } } as unknown as ChromeExecutor) as Record<string, any>;
    await expect(tools.run.execute({ code: "await browser.tabs.open();" }, { toolCallId: "call" })).resolves.toEqual({
      ok: false, error: { code: "timeout", message: "late Chrome response", retryable: false, effectUnknown: true },
    });
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

  it("accepts refs, CSS, documented locators, and structured targets", () => {
    expect(parseLocatorTarget("e15")).toEqual({ ref: "e15" });
    expect(parseLocatorTarget("#main > button")).toEqual({ by: "css", value: "#main > button" });
    expect(parseLocatorTarget("getByRole('button', { name: 'Submit', exact: true })")).toEqual({ by: "role", value: "button", name: "Submit", exact: true });
    expect(parseLocatorTarget('getByText("Login")')).toEqual({ by: "text", value: "Login" });
    expect(parseLocatorTarget('getByLabel("Email", { exact: false })')).toEqual({ by: "label", value: "Email", exact: false });
    expect(parseLocatorTarget({ by: "label", value: "Email" })).toEqual({ by: "label", value: "Email" });
    expect(() => parseLocatorTarget("getByUnknown('x')")).toThrow(/Unsupported locator expression/);
    expect(() => parseLocatorTarget("getByRole('button', { pressed: true })")).toThrow(/Unsupported locator expression/);
  });

  it("injects only the latest screenshot and keeps historical browser results compatible", async () => {
    const messages = [{ role: "tool", content: [
      { type: "tool-result", toolName: "browser", output: { type: "json", value: { screenshot: { mediaType: "image/jpeg", data: "old" } } } },
      { type: "tool-result", toolName: "inspect", output: { type: "json", value: { screenshot: { mediaType: "image/png", data: "new" } } } },
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
      type: "tool-result", toolName: "inspect", output: { type: "json", value: { screenshot: { mediaType: "image/png", artifactId: 7 } } },
    }] }];
    const prepared = await prepareToolMessages(messages, 1, undefined, async (id) => ({ mimeType: "image/png", base64: `image-${id}` }));
    expect(prepared[1]).toMatchObject({ role: "user", content: [
      { type: "file", mediaType: "image/png", data: { type: "data", data: "image-7" } },
    ] });
    const value = { snapshot: "x".repeat(9_000), screenshot: { mediaType: "image/png", artifactId: 7 } };
    expect(await compactToolResult(value, { logger: { append: () => { throw new Error("must not compact visual results"); } } as unknown as EventLogger })).toBe(value);
  });
});
