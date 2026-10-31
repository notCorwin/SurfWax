import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { EventLogger, type LogEvent } from "../logging";
import { testEventStore } from "../test-event-store";
import { parseLocatorTarget, ChromeExecutor } from "./executor";
import { compactToolResult, createProgramTools, prepareToolMessages, repairProgramToolCall, PROGRAM_TOOL_REGISTRY, PROGRAM_TOOL_CONTEXT } from "./tool";
import { callUserScript } from "./script-client";
import { ToolScheduler } from "./tool-scheduler";

describe("browser tools", () => {
  it.each(["screenshot", "pdf", "save"])("retains a %s artifact when the abort race settles before its underlying work", async (operation) => {
    const events: LogEvent[] = [];
    const logger = new EventLogger({ store: testEventStore(events) });
    const metadata = { filename: operation === "screenshot" ? "screen.png" : "page.pdf", mimeType: operation === "screenshot" ? "image/png" : "application/pdf", byteLength: 1 };
    const stored = operation === "save" ? await logger.append({ type: "tool.result.data", conversationId: "conversation", runId: "previous-run", content: metadata,
      output: { ...metadata, base64: "eA==" } }) : undefined;
    const input = { code: operation === "save" ? `return await artifacts.save(${stored!.id});` : `return await page.${operation}({save:true});` };
    logger.beginRun("conversation", "run"); logger.setRunPhase("run", 1);
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
    const tools = createProgramTools(executor, { logger, conversationId: "conversation", callId: () => "sdk" }) as Record<string, any>;
    const pending = tools.execute_program.execute(input, { toolCallId: "capture", abortSignal: controller.signal });
    await ready; logger.setRunPhase("run", 2); controller.abort("sidepanel-closed");
    const result = await pending;
    expect(workFinished).toBe(false);
    expect(result).toMatchObject({ ok: false, error: { code: "aborted", message: "sidepanel-closed", effectUnknown: true }, artifact: { id: artifactId, ...metadata } });
    expect(result).not.toHaveProperty("artifact.saved"); expect(JSON.stringify(result)).not.toContain("eA==");
    await logger.append({ type: "tool.failed", conversationId: "conversation", toolCallId: "capture", content: { callId: "sdk", toolName: "execute_program" }, input, output: result, error: result.error });
    await logger.closePendingTools("run", "conversation", "owner-disconnected");
    expect(events.filter((event) => event.type === "tool.failed")).toHaveLength(1);
    expect(events.find((event) => event.type === "tool.failed")).toMatchObject({ toolCallId: "1:capture", output: result });
    finishWork(); executor.dispose();
  });
  it("stores a large failed program without hiding failure or its original partial output", async () => {
    const failed = { ok: false, state: "failed", result: { error: { code: "timeout", message: "interrupted", effectUnknown: true }, completed: "completed".repeat(2000) } };
    expect(JSON.stringify(failed).length).toBeGreaterThan(8000);
    const append = vi.fn(async () => ({ id: 7 }));
    const logger = { append, toolIdentity: () => ({ toolCallId: "call", toolCallIdCanonical: true }) } as unknown as EventLogger;
    const tools = createProgramTools({ runProgram: vi.fn(async () => failed) } as unknown as ChromeExecutor, { logger, conversationId: "conversation" }) as Record<string, any>;
    const result = await tools.execute_program.execute({ code: "await check(false);" }, { toolCallId: "call" });
    expect(result).toMatchObject({ $ref: 7, ok: false, state: "failed", error: { ...failed.result.error, retryable: false }, resultAccess: { artifactId: 7, path: ["result"] } });
    expect(JSON.stringify(result).length).toBeLessThan(8000);
    expect(append).toHaveBeenCalledTimes(3);
    expect(append).toHaveBeenCalledWith(expect.objectContaining({ type: "tool.started" }));
    expect(append).toHaveBeenCalledWith(expect.objectContaining({ type: "tool.result.data", output: expect.objectContaining({ result: failed.result }) }));
    expect(append).toHaveBeenCalledWith(expect.objectContaining({ type: "tool.failed", output: result }));
    const toolError = await compactToolResult({ type: "tool-error", error: "large".repeat(2000) }, { logger }) as any;
    expect(toolError).toMatchObject({ type: "tool-error", $ref: 7, errorAccess: { artifactId: 7, path: ["error"] } });
    expect(toolError.error.length).toBeLessThanOrEqual(2001);
  });
  it("stores a large result with its original identity after a request phase changes", async () => {
    let phase = 1;
    const append = vi.fn(async () => ({ id: 7 }));
    const logger = { append, toolIdentity: (_conversation: string, id: string) => ({ runId: "run", toolCallId: `${phase}:${id}`, toolCallIdCanonical: true }) } as unknown as EventLogger;
    let finish!: (value: unknown) => void;
    const runProgram = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const tools = createProgramTools({ runProgram } as unknown as ChromeExecutor, { logger, conversationId: "conversation" }) as Record<string, any>;
    const pending = tools.execute_program.execute({ code: "return await page.evaluate(() => null);" }, { toolCallId: "call" });
    await vi.waitFor(() => expect(runProgram).toHaveBeenCalled());
    phase = 2; finish({ ok: true, result: "original".repeat(2000) });
    await expect(pending).resolves.toMatchObject({ $ref: 7, access: { path: ["result"] } });
    expect(append).toHaveBeenCalledWith(expect.objectContaining({ type: "tool.result.data", runId: "run", toolCallId: "1:call", toolCallIdCanonical: true }));
  });
  it("reads a conversation-owned artifact while browser work is blocked", async () => {
    const events: LogEvent[] = [];
    const logger = new EventLogger({ store: testEventStore(events) });
    const artifact = await logger.append({ type: "tool.result.data", conversationId: "c", output: { text: "partial result" } });
    const foreign = await logger.append({ type: "tool.result.data", conversationId: "other", output: { text: "secret" } });
    const executor = new ChromeExecutor({ chromeApi: { debugger: {} } as never, logger });
    let release!: () => void; (executor as any).tail = new Promise<void>((resolve) => { release = resolve; });
    const scheduler = new ToolScheduler(PROGRAM_TOOL_REGISTRY.map(({ name }) => name), () => ["job"]);
    const tools = createProgramTools(executor, { logger, conversationId: "c", scheduler }) as Record<string, any>;
    scheduler.prepare([{ type: "tool-call", toolCallId: "read", toolName: "read_artifact", input: { artifactId: artifact!.id } }]);
    await expect(tools.read_artifact.execute({ artifactId: artifact!.id, path: ["text"], offset: 0, limit: 7 }, { toolCallId: "read" })).resolves.toEqual({ ok: true, result: "partial" });
    scheduler.prepare([{ type: "tool-call", toolCallId: "foreign", toolName: "read_artifact", input: { artifactId: foreign!.id } }]);
    await expect(tools.read_artifact.execute({ artifactId: foreign!.id }, { toolCallId: "foreign" })).resolves.toMatchObject({ ok: false, error: { message: expect.stringContaining("unavailable") } });
    release(); executor.dispose();
  });

  it("reports absent artifact paths and preserves the distinction between undefined, null and objects", async () => {
    const events: LogEvent[] = [];
    const logger = new EventLogger({ store: testEventStore(events) });
    const artifact = await logger.append({ type: "tool.result.data", conversationId: "c", output: {
      rows: ["first", null, undefined], object: { result: null, resultType: "undefined" }, literal: { $type: "undefined", value: null },
    } });
    const executor = new ChromeExecutor({ chromeApi: { debugger: {} } as never, logger });
    const tools = createProgramTools(executor, { logger, conversationId: "c" }) as Record<string, any>;
    const read = async (path: (string | number)[]) => tools.read_artifact.execute({ artifactId: artifact!.id, path }, { toolCallId: crypto.randomUUID() });
    expect(await read(["rows", 0])).toEqual({ ok: true, result: "first" });
    expect(await read(["rows", 1])).toEqual({ ok: true, result: null });
    expect(await read(["rows", 2])).toEqual({ ok: true, result: null, resultType: "undefined" });
    expect(await read(["object"])).toEqual({ ok: true, result: { result: null, resultType: "undefined" } });
    expect(await read(["literal"])).toEqual({ ok: true, result: { $type: "undefined", value: null } });
    for (const path of [["rows", 3], ["rows", "map"], ["missing"]])
      expect(await read(path)).toMatchObject({ ok: false, error: { code: "result-path-not-found" } });
    executor.dispose();
  });

  it("sends nested undefined and sparse array holes as paths relative to the returned slice", async () => {
    const events: LogEvent[] = [];
    const logger = new EventLogger({ store: testEventStore(events) });
    const rows = ["a", undefined, , null, { undefinedPaths: undefined, holePaths: [undefined, null] }];
    const artifact = await logger.append({ type: "tool.result.data", conversationId: "c", output: { rows } });
    const executor = new ChromeExecutor({ chromeApi: { debugger: {} } as never, logger });
    const tools = createProgramTools(executor, { logger, conversationId: "c" }) as Record<string, any>;
    const read = async (selection: object) => tools.read_artifact.execute({ artifactId: artifact!.id, ...selection }, { toolCallId: crypto.randomUUID() });
    const output = await read({ path: ["rows"], offset: 1, limit: 4 });
    expect(JSON.parse(JSON.stringify(output))).toEqual({ ok: true,
      result: [null, null, null, { undefinedPaths: null, holePaths: [null, null] }],
      undefinedPaths: [[0], [3, "undefinedPaths"], [3, "holePaths", 0]], holePaths: [[1]] });
    // Existing JavaScript program consumers still receive the original values and holes.
    const original = await logger.result(artifact!.id, { path: ["rows"], offset: 1, limit: 4 }, "c") as any[];
    expect(Object.hasOwn(original, 0)).toBe(true); expect(original[0]).toBeUndefined();
    expect(Object.hasOwn(original, 1)).toBe(false); expect(original[2]).toBeNull();
    executor.dispose();
  });

  it("preserves small program results and data fields that resemble sidecar metadata", async () => {
    const programResult = { undefinedPaths: ["ordinary data"], holePaths: { x: undefined }, rows: [undefined, , null] };
    const tools = createProgramTools({ runProgram: vi.fn(async () => ({ ok: true, result: programResult })) } as unknown as ChromeExecutor) as Record<string, any>;
    const output = await tools.execute_program.execute({ code: "return 1;" }, { toolCallId: "program" });
    expect(JSON.parse(JSON.stringify(output))).toEqual({ ok: true,
      result: { undefinedPaths: ["ordinary data"], holePaths: { x: null }, rows: [null, null, null] },
      undefinedPaths: [["holePaths", "x"], ["rows", 0]], holePaths: [["rows", 1]] });
  });

  it("exposes non-JSON numbers and bigint as sidecars without changing literal tagged data", async () => {
    const value = { nan: NaN, positive: Infinity, negative: -Infinity, zero: -0, big: 123n,
      literal: { $type: "bigint", value: "123" } };
    const tools = createProgramTools({ runProgram: vi.fn(async () => ({ ok: true, result: value })) } as unknown as ChromeExecutor) as Record<string, any>;
    const output = await tools.execute_program.execute({ code: "return 1;" }, { toolCallId: "program" });
    expect(JSON.parse(JSON.stringify(output))).toEqual({ ok: true,
      result: { nan: null, positive: null, negative: null, zero: null, big: null, literal: value.literal },
      numberPaths: [{ path: ["nan"], value: "NaN" }, { path: ["positive"], value: "Infinity" }, { path: ["negative"], value: "-Infinity" }, { path: ["zero"], value: "-0" }],
      bigintPaths: [{ path: ["big"], value: "123" }] });
  });

  it("represents native values using type paths without confusing literal metadata", async () => {
    const regexp = /x+/gi; regexp.lastIndex = 4;
    const value = { date: new Date("2020-01-02T03:04:05.000Z"), invalid: new Date(NaN),
      buffer: new Uint8Array([0, 255]).buffer, view: new DataView(new Uint8Array([8, 9]).buffer),
      regexp, map: new Map([[123n, new Set([undefined, new Date("2024-01-01T00:00:00Z")])]]),
      literal: { typePaths: [{ path: [], type: "date" }], $type: "date", value: "ordinary" } };
    const tools = createProgramTools({ runProgram: vi.fn(async () => ({ ok: true, result: value })) } as unknown as ChromeExecutor) as Record<string, any>;
    const output = await tools.execute_program.execute({ code: "return 1;" }, { toolCallId: "program" });
    expect(JSON.parse(JSON.stringify(output))).toEqual({ ok: true,
      result: { date: "2020-01-02T03:04:05.000Z", invalid: null, buffer: "AP8=", view: "CAk=",
        regexp: { source: "x+", flags: "gi", lastIndex: 4 }, map: [[null, [null, "2024-01-01T00:00:00.000Z"]]], literal: value.literal },
      undefinedPaths: [["map", 0, 1, 0]], bigintPaths: [{ path: ["map", 0, 0], value: "123" }],
      typePaths: [{ path: ["date"], type: "date" }, { path: ["invalid"], type: "date" },
        { path: ["buffer"], type: "array-buffer" }, { path: ["view"], type: "typed-array", name: "DataView" },
        { path: ["regexp"], type: "regexp" }, { path: ["map"], type: "map" },
        { path: ["map", 0, 1], type: "set" }, { path: ["map", 0, 1, 1], type: "date" }] });
  });

  it("retains native values and paged type paths after compaction", async () => {
    const events: LogEvent[] = [];
    const logger = new EventLogger({ store: testEventStore(events) });
    const executor = new ChromeExecutor({ chromeApi: { debugger: {} } as never, logger });
    vi.spyOn(executor, "runProgram").mockResolvedValue({ ok: true, result: { date: new Date("2020-01-01Z"), bytes: new Uint8Array([1, 2]), large: "x".repeat(10000) } });
    const tools = createProgramTools(executor, { logger, conversationId: "c" }) as Record<string, any>;
    const output = await tools.execute_program.execute({ code: "return 1;" }, { toolCallId: "program" });
    expect(output).toMatchObject({ $ref: expect.any(Number), typeCount: 2, typePathsAccess: { path: ["typePaths"], offset: 0 } });
    expect(await tools.read_artifact.execute({ ...output.typePathsAccess, limit: 2 }, { toolCallId: "paths" })).toEqual({ ok: true, result: [
      { path: ["date"], type: "date" }, { path: ["bytes"], type: "typed-array", name: "Uint8Array" },
    ] });
    const original = await logger.result(output.$ref, { path: ["result"] }, "c") as any;
    expect(original.date).toEqual(new Date("2020-01-01Z")); expect(original.bytes).toEqual(new Uint8Array([1, 2]));
    executor.dispose();
  });

  it("offers directly usable pages for large native collections and binary views", async () => {
    const events: LogEvent[] = [];
    const logger = new EventLogger({ store: testEventStore(events) });
    const executor = new ChromeExecutor({ chromeApi: { debugger: {} } as never, logger });
    const run = vi.spyOn(executor, "runProgram");
    const tools = createProgramTools(executor, { logger, conversationId: "c" }) as Record<string, any>;
    run.mockResolvedValueOnce({ ok: true, result: new Map(Array.from({ length: 40000 }, (_, index) => [index, index * 2])) });
    const map = await tools.execute_program.execute({ code: "return 1;" }, { toolCallId: "map" });
    expect(map).toMatchObject({ sidecarsDeferred: true, resultAccess: { path: ["result"], offset: 0, limit: 25 } });
    expect(await tools.read_artifact.execute({ ...map.resultAccess, offset: 39998, limit: 2 }, { toolCallId: "map-page" }))
      .toEqual({ ok: true, result: [[39998, 79996], [39999, 79998]], typePaths: [{ path: [], type: "map" }] });
    const numbers = new Uint16Array(30000); numbers[29000] = 258;
    run.mockResolvedValueOnce({ ok: true, result: numbers });
    const binary = await tools.execute_program.execute({ code: "return 1;" }, { toolCallId: "binary" });
    expect(binary).toMatchObject({ sidecarsDeferred: true, resultAccess: { path: ["result"], offset: 0, limit: 1536 } });
    expect(await tools.read_artifact.execute({ ...binary.resultAccess, offset: 29000, limit: 1 }, { toolCallId: "binary-page" }))
      .toEqual({ ok: true, result: btoa(String.fromCharCode(...new Uint8Array(numbers.buffer, 58000, 2))), typePaths: [{ path: [], type: "typed-array", name: "Uint16Array" }] });
    const compact = new Uint16Array(10000); compact[9000] = 513;
    run.mockResolvedValueOnce({ ok: true, result: compact });
    const compacted = await tools.execute_program.execute({ code: "return 1;" }, { toolCallId: "compact-binary" });
    expect(compacted).toMatchObject({ typeCount: 1, resultAccess: { path: ["result"], offset: 0, limit: 1536 } });
    expect(await tools.read_artifact.execute({ ...compacted.resultAccess, offset: 9000, limit: 1 }, { toolCallId: "compact-binary-page" }))
      .toEqual({ ok: true, result: btoa(String.fromCharCode(...new Uint8Array(compact.buffer, 18000, 2))), typePaths: [{ path: [], type: "typed-array", name: "Uint16Array" }] });
    executor.dispose();
  });

  it("retains original native values and paged type sidecars after compaction", async () => {
    const events: LogEvent[] = [];
    const logger = new EventLogger({ store: testEventStore(events) });
    const executor = new ChromeExecutor({ chromeApi: { debugger: {} } as never, logger });
    const value = { nan: NaN, big: 123n, zero: -0, literal: { $type: "bigint", value: "123" }, large: "x".repeat(10000) };
    vi.spyOn(executor, "runProgram").mockResolvedValue({ ok: true, result: value });
    const tools = createProgramTools(executor, { logger, conversationId: "c" }) as Record<string, any>;
    const output = await tools.execute_program.execute({ code: "return 1;" }, { toolCallId: "program" });
    expect(output).toMatchObject({ $ref: expect.any(Number), numberCount: 2, bigintCount: 1,
      numberPathsAccess: { path: ["numberPaths"], offset: 0 }, bigintPathsAccess: { path: ["bigintPaths"], offset: 0 } });
    expect(await tools.read_artifact.execute({ ...output.bigintPathsAccess, limit: 1 }, { toolCallId: "paths" }))
      .toEqual({ ok: true, result: [{ path: ["big"], value: "123" }] });
    const original = await logger.result(output.$ref, { path: ["result"] }, "c") as typeof value;
    expect(Number.isNaN(original.nan)).toBe(true); expect(original.big).toBe(123n); expect(Object.is(original.zero, -0)).toBe(true);
    expect(original.literal).toEqual(value.literal);
    executor.dispose();
  });

  it("wraps conflicting outer metadata without losing job data or its identity", async () => {
    const events: LogEvent[] = [];
    const logger = new EventLogger({ store: testEventStore(events) });
    const job = { id: "job", state: "succeeded", terminal: true, ok: true, result: { value: undefined }, undefinedPaths: ["user data"], resultType: "user type" };
    const tools = createProgramTools({ queryJobs: vi.fn(async () => job), acknowledgeBackgroundJob: vi.fn() } as unknown as ChromeExecutor, { logger, conversationId: "c" }) as Record<string, any>;
    const output = await tools.get_job.execute({ jobId: "job" }, { toolCallId: "job-call" });
    expect(JSON.parse(JSON.stringify(output))).toMatchObject({ id: "job", state: "succeeded", terminal: true, ok: true, envelopeWrapped: true,
      result: { id: "job", result: { value: null }, undefinedPaths: ["user data"], resultType: "user type" }, undefinedPaths: [["result", "value"]] });
    const terminal = events.find((event) => event.type === "tool.finished");
    expect(terminal).toMatchObject({ toolCallId: "job-call", content: { toolName: "get_job" }, output });
  });

  it("preserves undefined in job event outputs while retaining status and pagination", async () => {
    const job = { id: "job", state: "running", terminal: false, nextCursor: 42, hasMore: true,
      events: [{ cursor: 42, output: { value: undefined, rows: [, undefined, null] } }] };
    const tools = createProgramTools({ queryJobs: vi.fn(async () => job) } as unknown as ChromeExecutor) as Record<string, any>;
    const output = await tools.get_job.execute({ jobId: "job" }, { toolCallId: "job-call" });
    expect(JSON.parse(JSON.stringify(output))).toMatchObject({ id: "job", state: "running", terminal: false, nextCursor: 42, hasMore: true,
      envelopeWrapped: true, result: { events: [{ cursor: 42, output: { value: null, rows: [null, null, null] } }] },
      undefinedPaths: [["events", 0, "output", "value"], ["events", 0, "output", "rows", 1]],
      holePaths: [["events", 0, "output", "rows", 0]] });
  });

  it("keeps wrapped job event pagination accessible after compaction", async () => {
    const events: LogEvent[] = [];
    const logger = new EventLogger({ store: testEventStore(events) });
    const job = { id: "job", state: "running", terminal: false, nextCursor: 42, hasMore: true,
      events: [{ cursor: 42, output: { value: undefined, text: "x".repeat(10000) } }] };
    const executor = new ChromeExecutor({ chromeApi: { debugger: {} } as never, logger });
    vi.spyOn(executor, "queryJobs").mockResolvedValue(job);
    const tools = createProgramTools(executor, { logger, conversationId: "c" }) as Record<string, any>;
    const output = await tools.get_job.execute({ jobId: "job" }, { toolCallId: "job-call" });
    expect(output).toMatchObject({ id: "job", state: "running", terminal: false, nextCursor: 42, hasMore: true,
      envelopeWrapped: true, access: { path: ["result", "events"], offset: 0 }, undefinedCount: 1 });
    const event = await tools.read_artifact.execute({ ...output.access, limit: 1 }, { toolCallId: "read-events" });
    expect(event).toMatchObject({ $ref: expect.any(Number), undefinedCount: 1, undefinedPathsAccess: { path: ["undefinedPaths"] } });
    expect(await tools.read_artifact.execute({ ...event.undefinedPathsAccess, limit: 1 }, { toolCallId: "read-paths" }))
      .toEqual({ ok: true, result: [[0, "output", "value"]] });
    executor.dispose();
  });

  it("keeps the conflicting outer envelope and sidecar accessible after failure compaction", async () => {
    const events: LogEvent[] = [];
    const logger = new EventLogger({ store: testEventStore(events) });
    const failed = { ok: false, state: "failed", error: { code: "timeout", message: "interrupted", effectUnknown: true },
      result: { before: undefined, large: "x".repeat(10000) }, undefinedPaths: ["user data"] };
    const executor = new ChromeExecutor({ chromeApi: { debugger: {} } as never, logger });
    vi.spyOn(executor, "runProgram").mockResolvedValue(failed);
    const tools = createProgramTools(executor, { logger, conversationId: "c" }) as Record<string, any>;
    const output = await tools.execute_program.execute({ code: "return 1;" }, { toolCallId: "failure" });
    expect(output).toMatchObject({ ok: false, envelopeWrapped: true, error: { code: "timeout", effectUnknown: true }, undefinedCount: 1,
      undefinedPathsAccess: { path: ["undefinedPaths"], offset: 0 }, resultAccess: { path: ["result"] } });
    expect(await tools.read_artifact.execute({ ...output.undefinedPathsAccess, limit: 1 }, { toolCallId: "paths" }))
      .toEqual({ ok: true, result: [["result", "before"]] });
    expect(await tools.read_artifact.execute({ artifactId: output.$ref, path: ["result", "undefinedPaths"] }, { toolCallId: "user-data" }))
      .toEqual({ ok: true, result: ["user data"] });
    executor.dispose();
  });

  it("preserves failed verification metadata when an envelope conflict is compacted", async () => {
    const events: LogEvent[] = [];
    const logger = new EventLogger({ store: testEventStore(events) });
    const executor = new ChromeExecutor({ chromeApi: { debugger: {} } as never, logger });
    vi.spyOn(executor, "runProgram").mockResolvedValue({ ok: true, result: { verified: false, present: true, large: "x".repeat(10000) }, undefinedPaths: ["ordinary"] });
    const tools = createProgramTools(executor, { logger, conversationId: "c" }) as Record<string, any>;
    const output = await tools.verify_state.execute({ target: { ref: "e1" }, state: "visible" }, { toolCallId: "verify" });
    expect(output).toMatchObject({ envelopeWrapped: true, verification: { verified: false, present: true } });
    executor.dispose();
  });

  it("preserves screenshots when an envelope conflicts with sidecar names", async () => {
    const events: LogEvent[] = [];
    const logger = new EventLogger({ store: testEventStore(events) });
    const executor = new ChromeExecutor({ chromeApi: { debugger: {} } as never, logger });
    vi.spyOn(executor, "runProgram").mockResolvedValue({ ok: true,
      result: { screenshot: { artifactId: 7, mediaType: "image/png" }, optional: undefined, large: "y".repeat(10000) },
      holePaths: ["ordinary data"] });
    const tools = createProgramTools(executor, { logger, conversationId: "c" }) as Record<string, any>;
    const output = await tools.execute_program.execute({ code: "return 1;" }, { toolCallId: "visual" });
    expect(output).toMatchObject({ envelopeWrapped: true, screenshot: { artifactId: 7, mediaType: "image/png" }, undefinedCount: 1 });
    expect(await tools.read_artifact.execute({ ...output.undefinedPathsAccess, limit: 1 }, { toolCallId: "paths" }))
      .toEqual({ ok: true, result: [["result", "optional"]] });
    executor.dispose();
  });

  it("keeps error and visual evidence alongside result sidecars", async () => {
    const failure = { ok: false, state: "failed", error: { code: "timeout", message: "interrupted", effectUnknown: true }, result: { before: undefined, large: "x".repeat(10000) } };
    const visual = { ok: true, result: { screenshot: { artifactId: 7, mediaType: "image/png" }, optional: undefined, large: "y".repeat(10000) } };
    const events: LogEvent[] = [];
    const logger = new EventLogger({ store: testEventStore(events) });
    const executor = new ChromeExecutor({ chromeApi: { debugger: {} } as never, logger });
    vi.spyOn(executor, "runProgram").mockResolvedValueOnce(failure).mockResolvedValueOnce(visual);
    const tools = createProgramTools(executor, { logger, conversationId: "c" }) as Record<string, any>;
    const failed = await tools.execute_program.execute({ code: "return 1;" }, { toolCallId: "failure" });
    expect(failed).toMatchObject({ ok: false, error: { code: "timeout", effectUnknown: true }, undefinedCount: 1,
      undefinedPathsAccess: { path: ["undefinedPaths"], offset: 0 } });
    expect(await tools.read_artifact.execute({ ...failed.undefinedPathsAccess, limit: 1 }, { toolCallId: "failure-path" }))
      .toEqual({ ok: true, result: [["before"]] });
    const screenshot = await tools.execute_program.execute({ code: "return 2;" }, { toolCallId: "visual" });
    expect(screenshot).toMatchObject({ screenshot: { artifactId: 7, mediaType: "image/png" }, undefinedCount: 1,
      undefinedPathsAccess: { path: ["undefinedPaths"], offset: 0 } });
    expect(await tools.read_artifact.execute({ ...screenshot.undefinedPathsAccess, limit: 1 }, { toolCallId: "visual-path" }))
      .toEqual({ ok: true, result: [["optional"]] });
    executor.dispose();
  });

  it("pages program result sidecars after a large result is compacted", async () => {
    const rows = new Array(3000); for (let index = 1; index < rows.length; index += 2) rows[index] = undefined;
    rows[0] = 123n; rows[2] = NaN;
    const events: LogEvent[] = [];
    const logger = new EventLogger({ store: testEventStore(events) });
    const executor = new ChromeExecutor({ chromeApi: { debugger: {} } as never, logger });
    vi.spyOn(executor, "runProgram").mockResolvedValue({ ok: true, result: rows });
    const tools = createProgramTools(executor, { logger, conversationId: "c" }) as Record<string, any>;
    const output = await tools.execute_program.execute({ code: "return 1;" }, { toolCallId: "program" });
    expect(output).toMatchObject({ $ref: expect.any(Number), undefinedCount: 1500, holeCount: 1498, bigintCount: 1, numberCount: 1,
      undefinedPathsAccess: { path: ["undefinedPaths"], offset: 0 }, holePathsAccess: { path: ["holePaths"], offset: 0 } });
    expect(await tools.read_artifact.execute({ ...output.undefinedPathsAccess, limit: 2 }, { toolCallId: "undefined-paths" }))
      .toEqual({ ok: true, result: [[1], [3]] });
    expect(await tools.read_artifact.execute({ ...output.holePathsAccess, limit: 2 }, { toolCallId: "hole-paths" }))
      .toEqual({ ok: true, result: [[4], [6]] });
    executor.dispose();
  });

  it("stores large sparse values before creating sidecars and normalizes only the requested slice", async () => {
    const events: LogEvent[] = [];
    const logger = new EventLogger({ store: testEventStore(events) });
    const rows = new Array(100_000);
    for (let i = 1; i < rows.length; i += 2) rows[i] = undefined;
    rows[2] = NaN; rows[4] = 123n; rows[6] = null;
    const executor = new ChromeExecutor({ chromeApi: { debugger: {} } as never, logger });
    vi.spyOn(executor, "runProgram").mockResolvedValue({ ok: true, result: rows });
    const tools = createProgramTools(executor, { logger, conversationId: "c" }) as Record<string, any>;
    const output = await tools.execute_program.execute({ code: "return 1;" }, { toolCallId: "program" });
    expect(output).toMatchObject({ $ref: expect.any(Number), sidecarsDeferred: true,
      resultAccess: { path: ["result"], offset: 0, limit: 25 } });
    expect(JSON.stringify(output).length).toBeLessThan(2000);
    expect(await tools.read_artifact.execute({ ...output.resultAccess, limit: 8 }, { toolCallId: "slice" }))
      .toEqual({ ok: true, result: Array(8).fill(null), undefinedPaths: [[1], [3], [5], [7]], holePaths: [[0]],
        numberPaths: [{ path: [2], value: "NaN" }], bigintPaths: [{ path: [4], value: "123" }] });
    const native = await logger.result(output.$ref, { path: ["result"], offset: 0, limit: 8 }, "c") as unknown[];
    expect(Object.hasOwn(native, 0)).toBe(false); expect(Object.hasOwn(native, 1)).toBe(true);
    expect(Number.isNaN(native[2])).toBe(true); expect(native[4]).toBe(123n); expect(native[6]).toBeNull();
    executor.dispose();
  });

  it("retains background job identity when its result exceeds the normalization budget", async () => {
    const events: LogEvent[] = [];
    const logger = new EventLogger({ store: testEventStore(events) });
    const acknowledge = vi.fn();
    const job = { id: "job", state: "succeeded", terminal: true, ok: true, result: new Array(100_000) };
    const tools = createProgramTools({ queryJobs: vi.fn(async () => job), acknowledgeBackgroundJob: acknowledge } as unknown as ChromeExecutor, { logger, conversationId: "c" }) as Record<string, any>;
    const output = await tools.get_job.execute({ jobId: "job" }, { toolCallId: "job-call" });
    expect(output).toMatchObject({ id: "job", state: "succeeded", terminal: true, ok: true, sidecarsDeferred: true, resultAccess: { path: ["result"] } });
    expect(acknowledge).toHaveBeenCalledWith("job", "c");
  });

  it("reads an unbounded suffix of a huge sparse result without losing holes or undefined", async () => {
    const events: LogEvent[] = [];
    const logger = new EventLogger({ store: testEventStore(events) });
    const rows = new Array(1_000_000_000);
    rows[3] = undefined; rows[8] = NaN; rows[999_999_999] = 123n;
    const executor = new ChromeExecutor({ chromeApi: { debugger: {} } as never, logger });
    vi.spyOn(executor, "runProgram").mockResolvedValue({ ok: true, result: rows });
    const tools = createProgramTools(executor, { logger, conversationId: "c" }) as Record<string, any>;
    const first = await tools.execute_program.execute({ code: "return 1;" }, { toolCallId: "first" });
    const suffix = await tools.read_artifact.execute({ artifactId: first.$ref, path: ["result"], offset: 2 }, { toolCallId: "suffix" });
    expect(suffix).toMatchObject({ sidecarsDeferred: true, resultAccess: { path: ["result"], offset: 0 } });
    const page = await tools.read_artifact.execute({ ...suffix.resultAccess, limit: 8 }, { toolCallId: "page" });
    expect(page).toEqual({ ok: true, result: Array(8).fill(null), undefinedPaths: [[1]], holePaths: [[0], [2], [3], [4], [5], [7]], numberPaths: [{ path: [6], value: "NaN" }] });
    const native = await logger.result(suffix.$ref, { path: ["result"] }, "c") as unknown[];
    expect(native.length).toBe(999_999_998); expect(Object.hasOwn(native, 0)).toBe(false);
    expect(Object.hasOwn(native, 1)).toBe(true); expect(native[1]).toBeUndefined(); expect(native[999_999_997]).toBe(123n);
    executor.dispose();
  });

  it("preserves bounded status and evidence when result normalization is deferred", async () => {
    const logger = { append: vi.fn(async () => ({ id: 7 })) } as unknown as EventLogger;
    const huge = () => new Array(100_000);
    const executor = { runProgram: vi.fn()
      .mockResolvedValueOnce({ ok: true, result: { verified: false, timedOut: true, present: true, actual: huge() } })
      .mockResolvedValueOnce({ ok: true, result: { requests: huge(), integrity: "incomplete", hasMore: null, nextOffset: 42, reason: "diagnostic-log-incomplete" } })
      .mockResolvedValueOnce({ accepted: true, complete: false, jobId: "job", blockedBy: { kind: "dialog", dialogId: "dialog-1" }, result: huge() })
      .mockResolvedValueOnce({ ok: false, state: "failed", error: { code: "timeout", message: "interrupted", effectUnknown: true }, receipts: { jobId: "job", after: 3 }, result: huge() })
      .mockResolvedValueOnce({ ok: true, artifact: { id: 4, filename: "page.png" }, result: { screenshot: { artifactId: 9, mediaType: "image/png" }, rows: huge() } }),
    } as unknown as ChromeExecutor;
    const tools = createProgramTools(executor, { logger }) as Record<string, any>;
    expect(await tools.verify_state.execute({ target: { ref: "e1" }, state: "visible" }, { toolCallId: "verify" }))
      .toMatchObject({ sidecarsDeferred: true, verification: { verified: false, timedOut: true, present: true } });
    expect(await tools.list_requests.execute({}, { toolCallId: "requests" }))
      .toMatchObject({ integrity: "incomplete", hasMore: null, nextOffset: 42, reason: "diagnostic-log-incomplete", access: { path: ["result", "requests"] } });
    expect(await tools.execute_program.execute({ code: "return 1;" }, { toolCallId: "handoff" }))
      .toMatchObject({ accepted: true, complete: false, jobId: "job", blockedBy: { kind: "dialog", dialogId: "dialog-1" }, blockedByAccess: { path: ["blockedBy"] } });
    expect(await tools.execute_program.execute({ code: "return 1;" }, { toolCallId: "failed" }))
      .toMatchObject({ ok: false, state: "failed", error: { code: "timeout", effectUnknown: true }, receipts: { jobId: "job", after: 3 }, receiptsAccess: { path: ["receipts"] } });
    expect(await tools.execute_program.execute({ code: "return 1;" }, { toolCallId: "screenshot" }))
      .toMatchObject({ screenshot: { artifactId: 9, mediaType: "image/png" }, visualAccess: { path: ["result"] }, artifact: { id: 4, filename: "page.png" }, artifactAccess: { path: ["artifact"] } });
  });

  it("retains paginated sidecar access when a large artifact read is compacted", async () => {
    const events: LogEvent[] = [];
    const logger = new EventLogger({ store: testEventStore(events) });
    const values = new Array(3000); for (let index = 1; index < values.length; index += 2) values[index] = undefined;
    const artifact = await logger.append({ type: "tool.result.data", conversationId: "c", output: { values } });
    const executor = new ChromeExecutor({ chromeApi: { debugger: {} } as never, logger });
    const tools = createProgramTools(executor, { logger, conversationId: "c" }) as Record<string, any>;
    const execute = (input: object) => tools.read_artifact.execute(input, { toolCallId: crypto.randomUUID() });
    const compacted = await execute({ artifactId: artifact!.id, path: ["values"], offset: 100, limit: 2000 });
    expect(compacted).toMatchObject({ $ref: expect.any(Number), undefinedCount: 1000, holeCount: 1000,
      undefinedPathsAccess: { path: ["undefinedPaths"], offset: 0 }, holePathsAccess: { path: ["holePaths"], offset: 0 } });
    expect(compacted.pathsNote).toContain("relative");
    expect(await execute({ ...compacted.undefinedPathsAccess, limit: 2 })).toEqual({ ok: true, result: [[1], [3]] });
    expect(await execute({ ...compacted.holePathsAccess, limit: 2 })).toEqual({ ok: true, result: [[0], [2]] });
    const longKey = "x".repeat(10000);
    const hugePath = await logger.append({ type: "tool.result.data", conversationId: "c", output: { [longKey]: undefined } });
    const huge = await execute({ artifactId: hugePath!.id });
    expect(huge).toMatchObject({ undefinedCount: 1, undefinedPathsOversizedItem: { path: ["undefinedPaths", 0] } });
    expect(await execute({ artifactId: huge.$ref, path: ["undefinedPaths", 0, 0], offset: 0, limit: 5 })).toEqual({ ok: true, result: "xxxxx" });
    executor.dispose();
  });

  it("cancels a stalled artifact read when only the run signal is aborted", async () => {
    const logger = { result: vi.fn(() => new Promise(() => {})), append: vi.fn(async () => ({ id: 1 })) } as unknown as EventLogger;
    const executor = new ChromeExecutor({ chromeApi: { debugger: {} } as never, logger });
    const run = new AbortController();
    const tools = createProgramTools(executor, { conversationId: "c", runSignal: run.signal }) as Record<string, any>;
    const result = tools.read_artifact.execute({ artifactId: 1 }, { toolCallId: "read" });
    await vi.waitFor(() => expect(logger.result).toHaveBeenCalled());
    run.abort("run cancelled");
    await expect(result).resolves.toMatchObject({ ok: false, error: { code: "aborted" } });
    executor.dispose();
  });

  it("registers individual action tools in stable order without old tool aliases", () => {
    const tools = createProgramTools({} as ChromeExecutor) as Record<string, any>;
    expect(Object.keys(tools)).toEqual(PROGRAM_TOOL_REGISTRY.map(({ name }) => name));
    expect(new Set(Object.keys(tools)).size).toBe(PROGRAM_TOOL_REGISTRY.length);
    for (const name of ["inspect_page", "find_elements", "list_frames", "click", "fill", "set_checked", "navigate", "list_tabs", "read_artifact", "execute_program", "list_jobs", "get_job", "cancel_job"]) expect(tools).toHaveProperty(name);
    for (const name of ["inspect", "run", "jobs", "snapshot", "act", "run-code", "browser", "result", "search-tools", "install"]) expect(tools).not.toHaveProperty(name);
    expect(Object.values(tools).every((tool) => tool.deferLoading !== true)).toBe(true);
    for (const { name, summary } of PROGRAM_TOOL_REGISTRY) expect(PROGRAM_TOOL_CONTEXT).toContain(`- ${name}: ${summary}`);
  });
  it("provides serializable schemas and a concise summary for every tool", () => {
    const metadata = PROGRAM_TOOL_REGISTRY.map(({ name, description, inputSchema }) => ({ name, description, parameters: z.toJSONSchema(inputSchema) }));
    expect(metadata.every(({ description, parameters }) => Boolean(description) && parameters.type === "object")).toBe(true);
    expect(new TextEncoder().encode(PROGRAM_TOOL_CONTEXT).byteLength).toBeLessThanOrEqual(15000);
  });
  it("loads the detailed program API only when requested", async () => {
    const tools = createProgramTools({} as ChromeExecutor) as Record<string, any>;
    expect(PROGRAM_TOOL_CONTEXT).not.toContain("locators: chain/filter");
    await expect(tools.read_api_reference.execute({}, { toolCallId: "reference" })).resolves.toMatchObject({ reference: expect.stringContaining("locators: chain/filter") });
  });
  it("strictly validates action and job schemas", () => {
    const tools = createProgramTools({} as ChromeExecutor) as Record<string, any>;
    expect(tools.inspect_page.inputSchema.parse({ region: { by: "label", value: "Email" }, fields: ["text", "ref"], budget: 100 })).toHaveProperty("budget", 100);
    expect(() => tools.inspect_page.inputSchema.parse({ readonly: true })).toThrow();
    expect(() => tools.execute_program.inputSchema.parse({ code: "return 1;", world: "MAIN" })).toThrow();
    expect(() => tools.cancel_job.inputSchema.parse({})).toThrow();
    expect(tools.get_job.inputSchema.parse({ jobId: "one", waitMs: 30001 })).toMatchObject({ waitMs: 30001 });
    expect(tools.list_jobs.inputSchema.parse({})).toEqual({});
    expect(() => tools.fill.inputSchema.parse({ target: { by: "label", value: "Email" } })).toThrow();
    expect(tools.set_checked.inputSchema.parse({ target: { ref: "e1" }, checked: false })).toMatchObject({ checked: false });
    expect(() => tools.fetch.inputSchema.parse({ url: "https://example.com" })).toThrow();
  });
  it("dispatches a fill with arbitrary input as data and logs its result", async () => {
    const events: any[] = [];
    const append = vi.fn(async (event) => { events.push(event); return { ...event, id: events.length }; });
    const logger = { append, toolIdentity: () => ({ runId: "run", toolCallId: "call", toolCallIdCanonical: true }) } as unknown as EventLogger;
    const fill = vi.fn(async () => "filled");
    const getByLabel = vi.fn(() => ({ fill }));
    const runProgram = vi.fn(async ({ code }: { code: string }) => {
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
      const result = await new AsyncFunction("page", "browser", code)({ getByLabel }, {});
      return { ok: true, state: "completed", result };
    });
    const tools = createProgramTools({ runProgram } as unknown as ChromeExecutor, { logger, conversationId: "conversation" }) as Record<string, any>;
    const value = "email'\n` ${notCode()} \\ value";
    const input = { target: { by: "label", value: "Email" }, value };
    const result = await tools.fill.execute(input, { toolCallId: "call" });
    expect(getByLabel).toHaveBeenCalledWith("Email", {});
    expect(fill).toHaveBeenCalledWith(value);
    expect(result).toMatchObject({ ok: true, result: "filled" });
    expect(events.map((event) => event.type)).toEqual(["tool.started", "tool.finished"]);
    expect(events[1]).toMatchObject({ content: { toolName: "fill" }, input, output: result, latencyMs: expect.any(Number) });
  });
  it("records exactly one failed result for a failed atomic action", async () => {
    const events: any[] = [];
    const logger = { append: async (event: any) => { events.push(event); return { ...event, id: events.length }; }, toolIdentity: () => ({ toolCallId: "call", toolCallIdCanonical: true }) } as unknown as EventLogger;
    const runProgram = vi.fn(async () => ({ ok: false, state: "failed", result: { error: { code: "stale-ref", message: "Element no longer exists" } } }));
    const tools = createProgramTools({ runProgram } as unknown as ChromeExecutor, { logger, conversationId: "conversation" }) as Record<string, any>;
    const input = { target: { ref: "e1" } };
    const result = await tools.click.execute(input, { toolCallId: "call" });
    expect(result).toMatchObject({ ok: false, error: { code: "stale-ref", retryable: false } });
    expect(events.map((event) => event.type)).toEqual(["tool.started", "tool.failed"]);
    expect(events[1]).toMatchObject({ content: { toolName: "click" }, input, output: result, latencyMs: expect.any(Number) });
  });
  it.each(["click", "execute_program"])("marks an interrupted %s as effect-unknown after execution begins", async (name) => {
    const events: any[] = [];
    const logger = { append: async (event: any) => { events.push(event); return { ...event, id: events.length }; }, toolIdentity: () => ({ toolCallId: "call", toolCallIdCanonical: true }) } as unknown as EventLogger;
    const controller = new AbortController();
    const runProgram = vi.fn(async () => { controller.abort("cancelled"); throw new DOMException("cancelled", "AbortError"); });
    const tools = createProgramTools({ runProgram } as unknown as ChromeExecutor, { logger, conversationId: "conversation" }) as Record<string, any>;
    const input = name === "click" ? { target: { ref: "e1" } } : { code: "await page.goto('https://example.com');" };
    const result = await tools[name].execute(input, { toolCallId: "call", abortSignal: controller.signal });
    expect(result).toMatchObject({ ok: false, error: { code: "aborted", effectUnknown: true, retryable: false } });
    expect(events.map((event) => event.type)).toEqual(["tool.started", "tool.failed"]);
    expect(events[1]).toMatchObject({ content: { status: "interrupted", effectUnknown: true }, output: result, latencyMs: expect.any(Number) });
  });
  it("does not mark effects unknown when interrupted before an action starts", async () => {
    const events: any[] = [];
    const logger = { append: async (event: any) => { events.push(event); return { ...event, id: events.length }; }, toolIdentity: () => ({ toolCallId: "call", toolCallIdCanonical: true }) } as unknown as EventLogger;
    const controller = new AbortController();
    const runProgram = vi.fn();
    const visualEnabled = async () => { controller.abort("cancelled"); throw new DOMException("cancelled", "AbortError"); };
    const tools = createProgramTools({ runProgram } as unknown as ChromeExecutor, { logger, conversationId: "conversation", visualEnabled }) as Record<string, any>;
    const result = await tools.click.execute({ target: { ref: "e1" } }, { toolCallId: "call", abortSignal: controller.signal });
    expect(runProgram).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, error: { code: "aborted", retryable: false } });
    expect(result.error.effectUnknown).toBeUndefined();
    expect(events[1]).toMatchObject({ type: "tool.failed", content: { status: "interrupted", effectUnknown: false }, output: result });
  });
  it("keeps tab discovery and selection available without an active page", async () => {
    const listTabs = vi.fn(async () => [{ id: 42, current: false }]);
    const switchTab = vi.fn(async () => [{ id: 42, current: true }]);
    const tools = createProgramTools({ listTabs, switchTab } as unknown as ChromeExecutor) as Record<string, any>;
    await expect(tools.list_tabs.execute({}, { toolCallId: "list" })).resolves.toEqual([{ id: 42, current: false }]);
    await expect(tools.switch_tab.execute({ tabId: 42 }, { toolCallId: "switch" })).resolves.toEqual([{ id: 42, current: true }]);
    expect(switchTab).toHaveBeenCalledWith(42, undefined, undefined);
  });
  it("accepts inspection continuation without mixing it with a new scope", () => {
    const tools = createProgramTools({} as ChromeExecutor) as Record<string, any>;
    expect(tools.inspect_page.inputSchema.parse({ cursor: "next", tabId: 41, budget: 500, limit: 5 })).toBeTruthy();
    for (const extra of [{ since: "old" }, { offset: 1 }, { fields: ["text"] }, { depth: 1 }, { region: "main" }])
      expect(() => tools.inspect_page.inputSchema.parse({ cursor: "next", ...extra })).toThrow();
  });

  it("routes bounded element searches to the live browser executor", async () => {
    const findElements = vi.fn(async () => ({ tabId: 41, documentId: 1, total: 1, elements: [{ ref: "t41d1e1", role: "button", name: "Submit" }], hasMore: false }));
    const tools = createProgramTools({ findElements } as unknown as ChromeExecutor, { conversationId: "c" }) as Record<string, any>;
    const input = { target: { by: "role", value: "button", name: "Submit" }, limit: 10 };
    await expect(tools.find_elements.execute(input, { toolCallId: "find" })).resolves.toMatchObject({ elements: [{ ref: "t41d1e1" }], hasMore: false });
    expect(findElements).toHaveBeenCalledWith(input, undefined, expect.objectContaining({ conversationId: "c" }));
    expect(() => tools.find_elements.inputSchema.parse({ ...input, limit: 101 })).toThrow();
  });

  it("routes paginated frame discovery to the browser executor", async () => {
    const listFrames = vi.fn(async () => ({ tabId: 41, documentId: 1, total: 1, frames: [{ frameRef: "frame-1" }], hasMore: false }));
    const tools = createProgramTools({ listFrames } as unknown as ChromeExecutor, { conversationId: "c" }) as Record<string, any>;
    const input = { tabId: 41, limit: 10 };
    await expect(tools.list_frames.execute(input, { toolCallId: "frames" })).resolves.toMatchObject({ frames: [{ frameRef: "frame-1" }] });
    expect(listFrames).toHaveBeenCalledWith(input, undefined, expect.objectContaining({ conversationId: "c" }));
    expect(() => tools.list_frames.inputSchema.parse({ limit: 101 })).toThrow();
    expect(tools.find_elements.inputSchema.parse({ target: { by: "role", value: "button", frame: { ref: "frame-1" } } })).toBeTruthy();
  });

  it("routes download metadata to the Chrome downloads reader without requiring a page", async () => {
    const listDownloads = vi.fn(async (input: unknown) => ({ downloads: [], input, consistency: "live" }));
    const tools = createProgramTools({ listDownloads } as unknown as ChromeExecutor) as Record<string, any>;
    await expect(tools.list_downloads.execute({ state: "complete", limit: 0 }, { toolCallId: "downloads" })).resolves.toMatchObject({ downloads: [], consistency: "live" });
    expect(listDownloads).toHaveBeenCalledWith({ state: "complete", limit: 0 }, undefined);
    expect(() => tools.list_downloads.inputSchema.parse({ limit: -1 })).toThrow();
  });
  it("routes a chooser upload to its queue-independent handler", async () => {
    const uploadChooser = vi.fn(async () => ({ chooserId: "chooser", artifactIds: [7, 8], state: "completed" }));
    const runProgram = vi.fn();
    const tools = createProgramTools({ uploadChooser, runProgram } as unknown as ChromeExecutor, { conversationId: "c" }) as Record<string, any>;
    const input = { chooserId: "chooser", artifactId: [7, 8], timeoutMs: 5000 };
    await expect(tools.upload_file.execute(input, { toolCallId: "upload" })).resolves.toMatchObject({ state: "completed", artifactIds: [7, 8] });
    expect(uploadChooser).toHaveBeenCalledWith(input, undefined, expect.objectContaining({ conversationId: "c" }));
    expect(runProgram).not.toHaveBeenCalled();
  });
  it("maps individual job tools to conversation-owned job operations", async () => {
    const queryJobs = vi.fn(async (input: unknown, _signal?: AbortSignal, _context?: { conversationId?: string }) => input);
    const tools = createProgramTools({ queryJobs } as unknown as ChromeExecutor, { conversationId: "conversation" }) as Record<string, any>;
    await tools.list_jobs.execute({}, { toolCallId: "list" });
    await tools.get_job.execute({ jobId: "j", after: 2, waitMs: 100 }, { toolCallId: "get" });
    await tools.cancel_job.execute({ jobId: "j" }, { toolCallId: "cancel" });
    expect(queryJobs.mock.calls.map(([input]) => input)).toEqual([
      { action: "list", limit: undefined, cursor: undefined },
      { action: "wait", id: "j", after: 2, limit: undefined, waitMs: 100 },
      { action: "cancel", id: "j" },
    ]);
    expect(queryJobs.mock.calls.every(([, , context]) => context?.conversationId === "conversation")).toBe(true);
  });
  it("acknowledges a background terminal result only after its tool result is durable", async () => {
    const order: string[] = [];
    let failTerminal = false;
    const logger = { append: async (event: any) => {
      order.push(event.type);
      if (failTerminal && event.type === "tool.finished") throw new Error("storage failure");
      return { ...event, id: 1 };
    }, toolIdentity: () => ({ runId: "run", toolCallId: "call", toolCallIdCanonical: true }) } as unknown as EventLogger;
    const acknowledgeBackgroundJob = vi.fn(() => { order.push("acknowledged"); });
    const executor = { queryJobs: async () => ({ id: "job", terminal: true, state: "succeeded", ok: true }), acknowledgeBackgroundJob } as unknown as ChromeExecutor;
    const tools = createProgramTools(executor, { logger, conversationId: "conversation" }) as Record<string, any>;
    await tools.get_job.execute({ jobId: "job" }, { toolCallId: "call" });
    expect(order).toEqual(["tool.started", "tool.finished", "acknowledged"]);
    expect(acknowledgeBackgroundJob).toHaveBeenCalledWith("job", "conversation");
    order.length = 0; acknowledgeBackgroundJob.mockClear(); failTerminal = true;
    await expect(tools.get_job.execute({ jobId: "job" }, { toolCallId: "call" })).rejects.toThrow("storage failure");
    expect(acknowledgeBackgroundJob).not.toHaveBeenCalled();
  });
  it("preserves historical user content and never injects an executable old catalogue", async () => {
    const messages = [{ role: "user", content: "Task\n\nAvailable tools:\n- run-code: historical" }, { role: "assistant", content: "Working" }];
    expect(await prepareToolMessages(messages, 0)).toEqual(messages);
    expect(await prepareToolMessages([{ role: "user", content: "Task" }], 0)).toEqual([{ role: "user", content: "Task" }]);
  });
  it("repairs only lossless current tool names/stringified JSON and never translates old names", async () => {
    const tools = createProgramTools({} as ChromeExecutor);
    await expect(repairProgramToolCall({ toolCall: { toolCallId: "1", toolName: "INSPECT-PAGE", input: JSON.stringify("{}") }, tools } as any)).resolves.toMatchObject({ toolName: "inspect_page", input: "{}" });
    for (const name of ["run", "jobs", "inspect", "run-code", "RUN_CODE", "act", "snapshot", "userscript-list"]) {
      await expect(repairProgramToolCall({ toolCall: { toolCallId: "old", toolName: name, input: "{}" }, tools } as any)).resolves.toBeNull();
    }
  });
  it("never suggests retrying timed-out programs with uncertain effects", async () => {
    const error = Object.assign(new DOMException("late Chrome response", "TimeoutError"), { effectUnknown: true });
    const tools = createProgramTools({ runProgram: async () => { throw error; } } as unknown as ChromeExecutor) as Record<string, any>;
    await expect(tools.execute_program.execute({ code: "await browser.tabs.open();" }, { toolCallId: "call" })).resolves.toEqual({
      ok: false, error: { code: "timeout", message: "late Chrome response", retryable: false, effectUnknown: true },
    });
  });
  it("stores large non-visual results once and returns a useful reference", async () => {
    const appended: any[] = [];
    const logger = { append: async (event: any) => { appended.push(event); return { ...event, id: 9 }; } } as EventLogger;
    const value = { snapshot: "x".repeat(9_000) };
    await expect(compactToolResult(value, { logger, conversationId: "c", toolCallId: "t" })).resolves.toMatchObject({
      $ref: 9, bytes: expect.any(Number), preview: "x".repeat(4000), access: { artifactId: 9, path: ["snapshot"], offset: 0, limit: 4000 },
    });
    expect(appended).toHaveLength(1);
    expect(appended[0].output).toBe(value);
  });

  it("keeps a failed verification visible when its evidence is compacted", async () => {
    const logger = { append: async (event: any) => ({ ...event, id: 11 }) } as EventLogger;
    const result = await compactToolResult({ ok: true, result: { verified: false, timedOut: true, present: true, actual: "x".repeat(10_000) } }, { logger, preserveVerification: true });
    expect(result).toMatchObject({ $ref: 11, verification: { verified: false, timedOut: true, present: true }, access: { path: ["result", "actual"] }, preview: "x".repeat(4000) });
  });

  it("keeps the recovery identifiers when a blocked job has an oversized dialog message", async () => {
    const logger = { append: async (event: any) => ({ ...event, id: 13 }) } as EventLogger;
    const value = { accepted: true, complete: false, jobId: "job", state: "blocked", blockedBy: { kind: "dialog", dialogId: "dialog", source: { tabId: 4 }, type: "prompt", evidenceId: 8, message: "x".repeat(10_000) } };
    const result = await compactToolResult(value, { logger });
    expect(result).toMatchObject({ $ref: 13, accepted: true, complete: false, jobId: "job", state: "blocked", blockedBy: { kind: "dialog", dialogId: "dialog", source: { tabId: 4 }, type: "prompt", evidenceId: 8 } });
    expect(JSON.stringify(result)).not.toContain("x".repeat(100));
  });

  it("bounds previews of nested large receipts and keeps the original event accessible", async () => {
    const appended: any[] = [];
    const logger = { append: async (event: any) => { appended.push(event); return { ...event, id: 15 }; } } as EventLogger;
    const value = { ok: true, result: [{ operation: "emit", output: "large".repeat(20_000) }] };
    const result = await compactToolResult(value, { logger }) as any;
    expect(result).toMatchObject({ $ref: 15, access: { artifactId: 15, path: ["result"], offset: 0, limit: 1 }, oversizedItem: { path: ["result", 0], guidance: expect.stringContaining("execute_program") }, resultOversizedItem: { path: ["result", 0] } });
    expect(new TextEncoder().encode(JSON.stringify(result.preview)).byteLength).toBeLessThanOrEqual(4096);
    expect(JSON.stringify(result.preview)).not.toContain("large".repeat(100));
    expect(appended[0].output).toBe(value);
  });

  it("recommends array slices sized by actual JSON bytes and identifies an oversized item", async () => {
    const logger = { append: async (event: any) => ({ ...event, id: 21 }) } as EventLogger;
    const values = Array.from({ length: 50 }, (_, index) => ({ id: index, text: "汉\n\u0000".repeat(70) }));
    const result = await compactToolResult({ ok: true, result: values }, { logger }) as any;
    const limit = result.access.limit;
    expect(limit).toBeGreaterThan(0); expect(limit).toBeLessThan(50);
    expect(result.resultAccess.limit).toBe(limit);
    const selected = { ok: true, result: values.slice(0, limit) };
    expect(new TextEncoder().encode(JSON.stringify(selected)).byteLength).toBeLessThan(8192);
    expect(await compactToolResult(selected, { logger })).toEqual(selected);

    const huge = { id: "long", line: "字".repeat(30_000) };
    const oversized = await compactToolResult({ ok: true, result: [huge] }, { logger }) as any;
    expect(oversized).toMatchObject({ access: { path: ["result"], limit: 1 }, oversizedItem: { path: ["result", 0], guidance: expect.stringContaining("bounded substrings") }, resultOversizedItem: { path: ["result", 0] } });
  });

  it("recommends a JSON-byte-bounded string prefix without splitting a Unicode pair", async () => {
    const logger = { append: async (event: any) => ({ ...event, id: 22 }) } as EventLogger;
    const value = "汉\n\u0000😀".repeat(4000);
    const result = await compactToolResult({ ok: true, result: value }, { logger }) as any;
    expect(result.access.limit).toBeGreaterThan(0); expect(result.access.limit).toBeLessThan(4000);
    expect(result.resultAccess.limit).toBe(result.access.limit);
    const prefix = value.slice(0, result.access.limit);
    expect(prefix).not.toMatch(/[\uD800-\uDBFF]$/);
    const selected = { ok: true, result: prefix };
    expect(new TextEncoder().encode(JSON.stringify(selected)).byteLength).toBeLessThan(8192);
    expect(await compactToolResult(selected, { logger })).toEqual(selected);
  });

  it("bounds a failed job while retaining error identity, cursor and artifact access", async () => {
    const stored: any[] = [];
    const logger = { append: async (event: any) => { stored.push(event); return { ...event, id: 16 }; } } as EventLogger;
    const value = { id: "job", state: "failed", terminal: true, ok: false, nextCursor: 42, hasMore: true,
      error: { code: "timeout", message: "failure ".repeat(20_000), effectUnknown: true, retryable: false },
      result: { partial: "data".repeat(30_000) }, events: [{ output: "receipt".repeat(30_000) }] };
    const result = await compactToolResult(value, { logger, preserveJobStatus: true }) as any;
    expect(result).toMatchObject({ $ref: 16, ok: false, id: "job", state: "failed", terminal: true, nextCursor: 42, hasMore: true,
      error: { code: "timeout", effectUnknown: true, retryable: false }, errorAccess: { artifactId: 16, path: ["error"] },
      access: { artifactId: 16, path: ["events"] }, resultAccess: { artifactId: 16, path: ["result"] } });
    expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThan(8192);
    expect(stored[0].output).toBe(value);
  });

  it("keeps raw image pixels available while compacting other large results and scrubs them on replay", async () => {
    const value = { ok: true, result: { snapshot: "page".repeat(5000), observationId: "obs", tabId: 7,
      screenshot: { mediaType: "image/png", data: "image-data", width: 100, height: 50, scale: 1, origin: { x: 0, y: 0 } } } };
    const logger = { append: async (event: any) => ({ ...event, id: 17 }) } as EventLogger;
    const compacted = await compactToolResult(value, { logger }) as any;
    expect(compacted).toMatchObject({ $ref: 17, observationId: "obs", tabId: 7, screenshot: value.result.screenshot });
    expect(JSON.stringify(compacted)).not.toContain("page".repeat(1100));
    const messages = [{ role: "tool", content: [{ type: "tool-result", output: { type: "json", value: compacted } }] }];
    const prepared = await prepareToolMessages(messages, 1);
    expect(prepared[0].content[0].output.value.screenshot.data).toBe("[stored in canonical event log]");
    expect(prepared.at(-1)).toMatchObject({ role: "user", content: [{ type: "file", mediaType: "image/png", data: { data: "image-data" } }] });
    const replay = await prepareToolMessages([...messages, { role: "assistant", content: "continue" }], 2);
    expect(JSON.stringify(replay)).not.toContain("image-data");
  });

  it("bounds page-controlled visual and error metadata while retaining the original paths", async () => {
    const events: LogEvent[] = [];
    const logger = new EventLogger({ store: testEventStore(events) });
    const huge = "x".repeat(120_000);
    const visual = { ok: true, result: { screenshot: { artifactId: 2, mediaType: "image/png", origin: { x: 2, y: 3, extra: huge } },
      observationId: "obs", tabId: 4, viewport: { width: 100, height: 50, extra: huge }, page: { url: huge, title: huge, extra: huge }, artifact: { id: 2, filename: huge, mimeType: "image/png", extra: huge } } };
    const compacted = await compactToolResult(visual, { logger, conversationId: "c" }) as any;
    expect(compacted).toMatchObject({ $ref: expect.any(Number), screenshot: { artifactId: 2, origin: { x: 2, y: 3 } }, visualAccess: { artifactId: compacted.$ref, path: ["result"] },
      viewport: { width: 100, height: 50 }, page: { urlTruncated: true, titleTruncated: true }, artifact: { id: 2, filenameTruncated: true } });
    expect(new TextEncoder().encode(JSON.stringify(compacted)).byteLength).toBeLessThan(8192);
    await expect(logger.result(compacted.$ref, { path: ["result", "page", "url"] }, "c")).resolves.toBe(huge);
    const failed = { ok: false, error: { code: { extra: huge }, message: "\u0000".repeat(2000), retryable: false, effectUnknown: true },
      artifact: { id: 4, filename: huge }, receipts: { tool: "get_job", jobId: "job", after: 2, extra: huge } };
    const failure = await compactToolResult(failed, { logger, conversationId: "c" }) as any;
    expect(failure).toMatchObject({ $ref: expect.any(Number), ok: false, error: { retryable: false, effectUnknown: true, messageTruncated: true },
      errorAccess: { artifactId: failure.$ref, path: ["error"] }, artifact: { id: 4, filenameTruncated: true }, artifactAccess: { artifactId: failure.$ref, path: ["artifact"] },
      receipts: { tool: "get_job", jobId: "job", after: 2 }, receiptsAccess: { artifactId: failure.$ref, path: ["receipts"] } });
    expect(failure.error).not.toHaveProperty("code");
    expect(new TextEncoder().encode(JSON.stringify(failure)).byteLength).toBeLessThan(8192);
    await expect(logger.result(failure.$ref, { path: ["error", "code", "extra"] }, "c")).resolves.toBe(huge);
  });

  it("loads the artifact when screenshot data is an empty string", async () => {
    const logger = { append: async (event: any) => ({ ...event, id: 18 }) } as EventLogger;
    const compacted = await compactToolResult({ snapshot: "x".repeat(10_000), screenshot: { data: "", artifactId: 7, mediaType: "image/png" } }, { logger }) as any;
    expect(compacted.screenshot).toEqual({ artifactId: 7, mediaType: "image/png" });
    for (const value of [compacted, { screenshot: { data: "", artifactId: 7, mediaType: "image/png" } }]) {
      const readArtifact = vi.fn(async () => ({ mimeType: "image/png", base64: "image-7" }));
      const messages = [{ role: "tool", content: [{ type: "tool-result", output: { type: "json", value } }] }];
      const prepared = await prepareToolMessages(messages, 1, undefined, readArtifact);
      expect(readArtifact).toHaveBeenCalledWith(7);
      expect(prepared.at(-1)).toMatchObject({ role: "user", content: [{ type: "file", mediaType: "image/png", data: { type: "data", data: "image-7" } }] });
    }
  });

  it("keeps frame pagination visible when a large frame list is compacted", async () => {
    const logger = { append: async (event: any) => ({ ...event, id: 17 }) } as EventLogger;
    const frames = Array.from({ length: 100 }, (_, index) => ({ frameRef: `frame-${index}`, url: "x".repeat(160) }));
    const result = await compactToolResult({ tabId: 41, documentId: 2, total: 200, frames, hasMore: true, nextCursor: "cursor" }, { logger, preserveSearchStatus: true }) as any;
    expect(result).toMatchObject({ $ref: 17, tabId: 41, documentId: 2, total: 200, hasMore: true, nextCursor: "cursor", access: { artifactId: 17, path: ["frames"], offset: 0, limit: expect.any(Number) } });
    expect(result.access.limit).toBeLessThan(50);
    expect(new TextEncoder().encode(JSON.stringify({ ok: true, result: frames.slice(0, result.access.limit) })).byteLength).toBeLessThan(8192);
  });

  it("preserves event closure, overflow and continuation when a result is compacted", async () => {
    const logger = { append: async (event: any) => ({ ...event, id: 21 }) } as EventLogger;
    const events = Array.from({ length: 80 }, (_, index) => ({ cursor: index + 4, kind: "console", payload: "x".repeat(200) }));
    const value = { subscriptionId: "subscription", events, nextCursor: 83, hasMore: true, overflow: { from: 1, through: 3 }, closed: "tab-closed" };
    const result = await compactToolResult(value, { logger, preserveEventStatus: true });
    expect(result).toMatchObject({ $ref: 21, subscriptionId: "subscription", nextCursor: 83, hasMore: true, eventCount: 80, cursorNote: expect.stringContaining("all events"), closed: "tab-closed", overflow: { from: 1, through: 3 }, access: { artifactId: 21, path: ["events"], offset: 0 } });
  });

  it("keeps long inspection continuation and fragment access visible", async () => {
    const logger = { append: async (event: any) => ({ ...event, id: 18 }) } as EventLogger;
    const items = Array.from({ length: 50 }, (_, index) => ({ id: `node-${index}`, line: "x".repeat(250) }));
    const value = { observationId: "obs", tabId: 41, documentId: 3, mode: "full", items, nextCursor: "cursor", truncation: { truncated: true, total: 100, returned: 50, budget: 15000, used: 14000, reason: "budget", baselineComplete: false } };
    const result = await compactToolResult(value, { logger, preserveInspectionStatus: true });
    expect(result).toMatchObject({ $ref: 18, observationId: "obs", tabId: 41, documentId: 3, mode: "full", nextCursor: "cursor", truncation: { truncated: true, reason: "budget", baselineComplete: false }, access: { artifactId: 18, path: ["items"], offset: 0, limit: expect.any(Number) } });
  });

  it("keeps request history integrity and access visible after compaction", async () => {
    const logger = { append: async (event: any) => ({ ...event, id: 19 }) } as EventLogger;
    const requests = Array.from({ length: 100 }, (_, index) => ({ requestRef: `request-${index}`, url: "x".repeat(160) }));
    const result = await compactToolResult({ ok: true, result: { requests, integrity: "incomplete", hasMore: null, reason: "diagnostic-log-incomplete" } }, { logger, preserveDiagnosticStatus: true });
    expect(result).toMatchObject({ $ref: 19, integrity: "incomplete", hasMore: null, reason: "diagnostic-log-incomplete", access: { artifactId: 19, path: ["result", "requests"], offset: 0, limit: expect.any(Number) } });
  });

  it("keeps console history integrity and access visible after compaction", async () => {
    const logger = { append: async (event: any) => ({ ...event, id: 20 }) } as EventLogger;
    const messages = Array.from({ length: 100 }, (_, index) => ({ index, text: "x".repeat(160) }));
    const result = await compactToolResult({ ok: true, result: { messages, integrity: "incomplete", hasMore: true, nextOffset: 100, reason: "diagnostic-log-incomplete" } }, { logger, preserveDiagnosticStatus: true });
    expect(result).toMatchObject({ $ref: 20, integrity: "incomplete", hasMore: true, nextOffset: 100, reason: "diagnostic-log-incomplete", access: { artifactId: 20, path: ["result", "messages"], offset: 0, limit: expect.any(Number) } });
  });

  it("keeps a large search page's scope and continuation visible", async () => {
    const logger = { append: async (event: any) => ({ ...event, id: 16 }) } as EventLogger;
    const elements = Array.from({ length: 100 }, (_, index) => ({ ref: `ref-${index}`, role: "button", name: "x".repeat(160) }));
    const value = { tabId: 41, documentId: 2, total: 200, elements, hasMore: true, nextCursor: "cursor" };
    const result = await compactToolResult(value, { logger, preserveSearchStatus: true });
    expect(result).toMatchObject({ $ref: 16, tabId: 41, documentId: 2, total: 200, hasMore: true, nextCursor: "cursor", access: { artifactId: 16, path: ["elements"], offset: 0, limit: expect.any(Number) } });
    expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThan(6000);
  });

  it("keeps terminal job status and cursor visible without repeating large receipt payloads", async () => {
    const logger = { append: async (event: any) => ({ ...event, id: 12 }) } as EventLogger;
    const value = { id: "job", state: "succeeded", terminal: true, ok: true, result: "done", nextCursor: 42, hasMore: false, events: [{ output: "x".repeat(10_000) }] };
    const result = await compactToolResult(value, { logger, preserveJobStatus: true });
    expect(result).toMatchObject({ $ref: 12, id: "job", state: "succeeded", terminal: true, ok: true, nextCursor: 42, hasMore: false, preview: { eventCount: 1 }, access: { artifactId: 12, path: ["events"], offset: 0, limit: 1 }, oversizedItem: { path: ["events", 0] }, resultAccess: { artifactId: 12, path: ["result"], offset: 0, limit: 4000 } });
    expect(JSON.stringify(result)).not.toContain("x".repeat(100));
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
    const value = { snapshot: "x".repeat(9_000), screenshot: { mediaType: "image/png", artifactId: 7 }, observationId: "obs", tabId: 41, documentId: 2, viewport: { width: 100, height: 100 } };
    const logger = { append: async (event: any) => ({ ...event, id: 9 }) } as EventLogger;
    const compacted = await compactToolResult(value, { logger }) as any;
    expect(compacted).toMatchObject({ $ref: 9, screenshot: value.screenshot, observationId: "obs", tabId: 41, documentId: 2, viewport: value.viewport });
    expect(JSON.stringify(compacted).length).toBeLessThan(8000);
    const current = [{ role: "tool", content: [{ type: "tool-result", output: { type: "json", value: compacted } }] }];
    const image = await prepareToolMessages(current, 1, undefined, async (id) => ({ mimeType: "image/png", base64: `image-${id}` }));
    expect(image.at(-1)).toMatchObject({ role: "user", content: [{ type: "file", mediaType: "image/png", data: { data: "image-7" } }] });
    const replay = await prepareToolMessages([...current, { role: "assistant", content: "continued" }], 2, undefined, async () => { throw new Error("historical image must not be loaded"); });
    expect(replay).toHaveLength(2);
  });

  it("keeps screenshot artifact metadata without injecting pixels for text-only models", async () => {
    const messages = [{ role: "tool", content: [{
      type: "tool-result", toolName: "run", output: { type: "json", value: { screenshot: { mediaType: "image/png", artifactId: 7 } } },
    }] }];
    const readArtifact = vi.fn(async () => ({ mimeType: "image/png", base64: "pixels" }));
    const prepared = await prepareToolMessages(messages, 1, undefined, readArtifact, false);
    expect(prepared).toHaveLength(1);
    expect(prepared[0].content[0].output.value.screenshot).toEqual({ mediaType: "image/png", artifactId: 7 });
    expect(readArtifact).not.toHaveBeenCalled();
  });
});
