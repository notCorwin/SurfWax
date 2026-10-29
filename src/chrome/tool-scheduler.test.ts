import { describe, expect, it, vi } from "vitest";
import { ToolLoopAgent, dynamicTool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { ToolScheduler } from "./tool-scheduler";

const names = ["click", "fill", "inspect_page", "verify_state", "switch_tab", "key_up", "execute_program", "get_job", "cancel_job", "subscribe_event", "wait_event", "handle_dialog", "upload_file", "list_downloads", "read_api_reference"];
const call = (toolCallId: string, toolName: string, input: unknown = {}, extra = {}) => ({ type: "tool-call", toolCallId, toolName, input, ...extra });
function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

describe("model response tool scheduling", () => {
  it("orders writes and following reads by model response, not arrival", async () => {
    const scheduler = new ToolScheduler(names);
    scheduler.prepare([call("click", "click"), call("inspect", "inspect_page")], 7);
    const gate = latch();
    const order: string[] = [];
    const read = scheduler.run("inspect", async () => { order.push("inspect"); return "new state"; });
    const write = scheduler.run("click", async () => { order.push("click-start"); await gate.promise; order.push("click-end"); return { ok: true }; });
    await vi.waitFor(() => expect(order).toEqual(["click-start"]));
    gate.release();
    await expect(read).resolves.toBe("new state");
    await write;
    expect(order).toEqual(["click-start", "click-end", "inspect"]);
  });

  it("prevents subsequent writes on the failed tab while allowing reads, cleanup, and other tabs", async () => {
    const scheduler = new ToolScheduler(names);
    scheduler.prepare([
      call("bad", "click", { tabId: 1 }), call("blocked", "fill", { tabId: 1 }),
      call("read", "inspect_page", { tabId: 1 }), call("release", "key_up", { tabId: 1 }), call("other", "click", { tabId: 2 }),
    ], 1);
    const blockedWork = vi.fn(async () => "wrong");
    const bad = scheduler.run("bad", async () => ({ ok: false }));
    const blocked = scheduler.run("blocked", blockedWork);
    const read = scheduler.run("read", async () => "read");
    const release = scheduler.run("release", async () => "released");
    const other = scheduler.run("other", async () => "other");
    await expect(blocked).rejects.toMatchObject({ code: "prior-action-failed" });
    expect(blockedWork).not.toHaveBeenCalled();
    await expect(Promise.all([bad, read, release, other])).resolves.toEqual([{ ok: false }, "read", "released", "other"]);
  });

  it("does not run a later write when verification completed but the condition was false", async () => {
    const scheduler = new ToolScheduler(names);
    scheduler.prepare([call("verify", "verify_state"), call("write", "click")], 1);
    const verify = scheduler.run("verify", async () => ({ ok: true, result: { verified: false } }));
    const click = vi.fn(async () => "wrong");
    const write = scheduler.run("write", click);
    await expect(verify).resolves.toMatchObject({ result: { verified: false } });
    await expect(write).rejects.toMatchObject({ code: "prior-action-failed" });
    expect(click).not.toHaveBeenCalled();
  });

  it("permits an event subscription after a failed action", async () => {
    const scheduler = new ToolScheduler(names);
    scheduler.prepare([call("bad", "click"), call("subscribe", "subscribe_event")], 1);
    const bad = scheduler.run("bad", async () => ({ ok: false }));
    const subscribe = scheduler.run("subscribe", async () => ({ subscriptionId: "events" }));
    await expect(Promise.all([bad, subscribe])).resolves.toEqual([{ ok: false }, { subscriptionId: "events" }]);
  });

  it("allows chooser upload while a background job is blocked, and fences later writes on failure", async () => {
    const scheduler = new ToolScheduler(names, () => ["job"]);
    scheduler.prepare([call("chooser", "upload_file", { chooserId: "chooser", artifactId: 7 }), call("write", "click")], 1);
    const chooser = scheduler.run("chooser", async () => ({ ok: false, error: { code: "invalid-artifact" } }));
    const click = vi.fn(async () => "wrong");
    const write = scheduler.run("write", click);
    await expect(chooser).resolves.toMatchObject({ ok: false });
    await expect(write).rejects.toMatchObject({ code: "chooser-response-failed" });
    expect(click).not.toHaveBeenCalled();
  });

  it("lets a dialog reply unblock a chooser upload while later writes wait for both", async () => {
    const scheduler = new ToolScheduler(names);
    scheduler.prepare([call("chooser", "upload_file", { chooserId: "chooser", artifactId: 7 }), call("dialog", "handle_dialog"), call("write", "click")], 1);
    const started = latch(); const unblock = latch(); const dialogDone = latch();
    const order: string[] = [];
    const chooser = scheduler.run("chooser", async () => { order.push("chooser"); started.release(); await unblock.promise; order.push("chooser-done"); return { ok: true }; });
    const dialog = scheduler.run("dialog", async () => { await started.promise; order.push("dialog"); unblock.release(); await dialogDone.promise; order.push("dialog-done"); return { ok: true }; });
    const write = scheduler.run("write", async () => { order.push("write"); return { ok: true }; });
    await vi.waitFor(() => expect(order).toEqual(["chooser", "dialog", "chooser-done"]));
    dialogDone.release();
    await Promise.all([chooser, dialog, write]);
    expect(order).toEqual(["chooser", "dialog", "chooser-done", "dialog-done", "write"]);
  });

  it("waits for an earlier dialog reply before starting a chooser upload", async () => {
    const scheduler = new ToolScheduler(names);
    scheduler.prepare([call("dialog", "handle_dialog"), call("chooser", "upload_file", { chooserId: "chooser", artifactId: 7 })], 1);
    const gate = latch(); const order: string[] = [];
    const dialog = scheduler.run("dialog", async () => { order.push("dialog"); await gate.promise; return { ok: true }; });
    const chooser = scheduler.run("chooser", async () => { order.push("chooser"); return { ok: true }; });
    await vi.waitFor(() => expect(order).toEqual(["dialog"]));
    gate.release(); await Promise.all([dialog, chooser]);
    expect(order).toEqual(["dialog", "chooser"]);
  });

  it("does not dispatch a chooser after an earlier dialog reply fails", async () => {
    const scheduler = new ToolScheduler(names);
    scheduler.prepare([call("dialog", "handle_dialog"), call("chooser", "upload_file", { chooserId: "chooser", artifactId: 7 })], 1);
    const work = vi.fn(async () => ({ ok: true }));
    const dialog = scheduler.run("dialog", async () => ({ ok: false }));
    const chooser = scheduler.run("chooser", work);
    await dialog;
    await expect(chooser).rejects.toMatchObject({ code: "dialog-response-failed" });
    expect(work).not.toHaveBeenCalled();
  });

  it("does not bypass the background fence for target-based upload", async () => {
    const scheduler = new ToolScheduler(names, () => ["job"]);
    scheduler.prepare([call("upload", "upload_file", { target: { ref: "e1" }, artifactId: 7 })], 1);
    const upload = vi.fn(async () => "wrong");
    await expect(scheduler.run("upload", upload)).rejects.toMatchObject({ code: "background-job-pending" });
    expect(upload).not.toHaveBeenCalled();
  });

  it("can read live download metadata while a background job owns the browser queue", async () => {
    const scheduler = new ToolScheduler(names, () => ["job"]);
    scheduler.prepare([call("downloads", "list_downloads")], 1);
    await expect(scheduler.run("downloads", async () => ({ downloads: [], consistency: "live" }))).resolves.toMatchObject({ consistency: "live" });
  });

  it("retains a failed verification boundary when the result was compacted", async () => {
    const scheduler = new ToolScheduler(names);
    scheduler.prepare([call("verify", "verify_state"), call("write", "click")], 1);
    const verify = scheduler.run("verify", async () => ({ $ref: 7, verification: { verified: false } }));
    const click = vi.fn(async () => "wrong");
    const write = scheduler.run("write", click);
    await verify;
    await expect(write).rejects.toMatchObject({ code: "prior-action-failed" });
    expect(click).not.toHaveBeenCalled();
  });

  it("consumes invalid and unknown calls without waiting for an SDK callback", async () => {
    const scheduler = new ToolScheduler(names);
    scheduler.prepare([call("invalid", "click", { tabId: 1 }, { invalid: true }), call("read", "inspect_page", { tabId: 1 }), call("write", "fill", { tabId: 1 }), call("unknown", "missing", {}, { invalid: true }), call("other", "click", { tabId: 2 })], 1);
    const read = scheduler.run("read", async () => "read");
    const write = scheduler.run("write", async () => "wrong");
    const other = scheduler.run("other", async () => "other");
    await expect(read).resolves.toBe("read");
    await expect(write).rejects.toMatchObject({ code: "prior-action-failed" });
    await expect(other).resolves.toBe("other");
  });

  it("fails closed on duplicate or missing tool call IDs, including provider calls", async () => {
    for (const calls of [
      [call("a", "click"), call("a", "click")],
      [call("a", "click", {}, { providerExecuted: true }), call("a", "click")],
      [{ type: "tool-call", toolName: "click" }],
    ]) {
      const scheduler = new ToolScheduler(names);
      expect(scheduler.prepare(calls)).toMatchObject({ code: "invalid-tool-call-id" });
      const task = vi.fn(async () => 1);
      await expect(scheduler.run("a", task)).rejects.toMatchObject({ code: "invalid-tool-call-id" });
      expect(task).not.toHaveBeenCalled();
    }
  });

  it("lets job and event operations proceed without waiting for browser actions", async () => {
    const scheduler = new ToolScheduler(names);
    scheduler.prepare([call("bg", "execute_program", { background: true }), call("job", "get_job"), call("cancel", "cancel_job"), call("event", "wait_event"), call("dialog", "handle_dialog"), call("api", "read_api_reference")], 1);
    const gate = latch();
    const bg = scheduler.run("bg", async () => { await gate.promise; return { accepted: true }; });
    await expect(Promise.all(["job", "cancel", "event", "dialog", "api"].map((id) => scheduler.run(id, async () => id)))).resolves.toEqual(["job", "cancel", "event", "dialog", "api"]);
    gate.release();
    await bg;
  });

  it("lets a dialog response release a preceding blocked action, and fences later writes", async () => {
    const scheduler = new ToolScheduler(names);
    scheduler.prepare([call("click", "click"), call("dialog", "handle_dialog"), call("fill", "fill")], 1);
    const clicked = latch(); const resume = latch(); const done = latch();
    const order: string[] = [];
    const click = scheduler.run("click", async () => { order.push("click"); clicked.release(); await resume.promise; order.push("click-done"); return { ok: true }; });
    const fill = scheduler.run("fill", async () => { order.push("fill"); return { ok: true }; });
    const dialog = scheduler.run("dialog", async () => { await clicked.promise; order.push("dialog"); resume.release(); await done.promise; order.push("dialog-done"); return { ok: true }; });
    await vi.waitFor(() => expect(order).toEqual(["click", "dialog", "click-done"]));
    done.release();
    await Promise.all([click, dialog, fill]);
    expect(order).toEqual(["click", "dialog", "click-done", "dialog-done", "fill"]);
  });

  it("reports a failed dialog fence before an earlier blocked action finishes", async () => {
    const scheduler = new ToolScheduler(names);
    scheduler.prepare([call("click", "click"), call("dialog", "handle_dialog"), call("fill", "fill"), call("read", "inspect_page")], 1);
    const gate = latch(); const started = latch();
    const click = scheduler.run("click", async () => { started.release(); await gate.promise; return { ok: true }; });
    const fillWork = vi.fn(async () => "wrong");
    const readWork = vi.fn(async () => "wrong");
    const fill = scheduler.run("fill", fillWork);
    const read = scheduler.run("read", readWork);
    const dialog = scheduler.run("dialog", async () => { await started.promise; return { ok: false, error: { code: "uncertain" } }; });
    await expect(dialog).resolves.toMatchObject({ ok: false });
    await expect(fill).rejects.toMatchObject({ code: "dialog-response-failed" });
    await expect(read).rejects.toMatchObject({ code: "dialog-response-failed" });
    expect(fillWork).not.toHaveBeenCalled(); expect(readWork).not.toHaveBeenCalled();
    gate.release(); await click;
  });

  it("fences invalid dialog calls without waiting for an SDK execution callback", async () => {
    const scheduler = new ToolScheduler(names);
    scheduler.prepare([call("dialog", "handle_dialog", {}, { invalid: true }), call("fill", "fill")], 1);
    const work = vi.fn(async () => "wrong");
    await expect(scheduler.run("fill", work)).rejects.toMatchObject({ code: "dialog-response-failed" });
    expect(work).not.toHaveBeenCalled();
  });

  it("serializes multiple dialog replies without waiting for a blocked browser action", async () => {
    const scheduler = new ToolScheduler(names);
    scheduler.prepare([call("click", "click"), call("first", "handle_dialog"), call("second", "handle_dialog"), call("fill", "fill")], 1);
    const gate = latch(); const firstDone = latch(); const order: string[] = [];
    const click = scheduler.run("click", async () => { order.push("click"); await gate.promise; order.push("click-done"); return { ok: true }; });
    const first = scheduler.run("first", async () => { order.push("first"); await firstDone.promise; return { ok: true }; });
    const second = scheduler.run("second", async () => { order.push("second"); gate.release(); return { ok: true }; });
    const fill = scheduler.run("fill", async () => { order.push("fill"); return { ok: true }; });
    await vi.waitFor(() => expect(order).toEqual(["click", "first"]));
    firstDone.release(); await Promise.all([click, first, second, fill]);
    expect(order).toEqual(["click", "first", "second", "click-done", "fill"]);
  });

  it("coordinates real AI SDK concurrent calls with a blocked click and dialog reply", async () => {
    const scheduler = new ToolScheduler(names);
    const actionStarted = latch(); const actionReleased = latch(); const dialogFinished = latch();
    const order: string[] = [];
    let step = 0;
    const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
    const model = new MockLanguageModelV4({ doGenerate: async () => ++step === 1 ? {
      content: [{ type: "tool-call" as const, toolCallId: "a", toolName: "click", input: "{}" }, { type: "tool-call" as const, toolCallId: "b", toolName: "handle_dialog", input: "{}" }, { type: "tool-call" as const, toolCallId: "c", toolName: "fill", input: "{}" }],
      finishReason: { unified: "tool-calls" as const, raw: "tool-calls" }, usage, warnings: [],
    } : { content: [{ type: "text" as const, text: "done" }], finishReason: { unified: "stop" as const, raw: "stop" }, usage, warnings: [] } });
    const create = (work: () => Promise<unknown>) => dynamicTool({ inputSchema: z.object({}), execute: (_input, options) => scheduler.run(options.toolCallId, work, options.abortSignal) });
    const agent = new ToolLoopAgent({ model, onLanguageModelCallEnd: (event) => { scheduler.prepare(event.content, 1); }, tools: {
      click: create(async () => { order.push("click"); actionStarted.release(); await actionReleased.promise; order.push("click-done"); return { ok: true }; }),
      handle_dialog: create(async () => { await actionStarted.promise; order.push("dialog"); actionReleased.release(); await dialogFinished.promise; order.push("dialog-done"); return { ok: true }; }),
      fill: create(async () => { order.push("fill"); return { ok: true }; }),
    } });
    const result = agent.generate({ prompt: "act" });
    await vi.waitFor(() => expect(order).toEqual(["click", "dialog", "click-done"]));
    dialogFinished.release();
    expect((await result).text).toBe("done");
    expect(order).toEqual(["click", "dialog", "click-done", "dialog-done", "fill"]);
  });

  it("returns real SDK tool results without dispatching writes after a failed dialog response", async () => {
    const scheduler = new ToolScheduler(names);
    const dialogStarted = latch(); const finishDialog = latch();
    const write = vi.fn(async () => ({ ok: true }));
    let step = 0;
    const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
    const model = new MockLanguageModelV4({ doGenerate: async () => ++step === 1 ? {
      content: [{ type: "tool-call" as const, toolCallId: "a", toolName: "handle_dialog", input: "{}" }, { type: "tool-call" as const, toolCallId: "b", toolName: "fill", input: "{}" }],
      finishReason: { unified: "tool-calls" as const, raw: "tool-calls" }, usage, warnings: [],
    } : { content: [{ type: "text" as const, text: "done" }], finishReason: { unified: "stop" as const, raw: "stop" }, usage, warnings: [] } });
    const create = (work: () => Promise<unknown>) => dynamicTool({ inputSchema: z.object({}), execute: async (_input, options) => {
      try { return await scheduler.run(options.toolCallId, work, options.abortSignal); }
      catch (error) { return { ok: false, error: { code: (error as { code?: string }).code } }; }
    } });
    const agent = new ToolLoopAgent({ model, onLanguageModelCallEnd: (event) => { scheduler.prepare(event.content, 1); }, tools: {
      handle_dialog: create(async () => { dialogStarted.release(); await finishDialog.promise; return { ok: false, error: { code: "dialog-failed" } }; }),
      fill: create(write),
    } });
    const pending = agent.generate({ prompt: "act" });
    await dialogStarted.promise;
    expect(write).not.toHaveBeenCalled();
    finishDialog.release();
    const result = await pending;
    expect(result.text).toBe("done"); expect(write).not.toHaveBeenCalled();
    expect(result.steps[0]?.toolResults.map((entry) => entry.output)).toEqual([
      { ok: false, error: { code: "dialog-failed" } },
      { ok: false, error: { code: "dialog-response-failed" } },
    ]);
  });

  it("returns all real SDK results when a background action fences following browser calls", async () => {
    const scheduler = new ToolScheduler(names);
    const attempted = vi.fn(async () => ({ ok: true }));
    let step = 0;
    const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
    const model = new MockLanguageModelV4({ doGenerate: async () => ++step === 1 ? {
      content: [{ type: "tool-call" as const, toolCallId: "a", toolName: "click", input: "{}" }, { type: "tool-call" as const, toolCallId: "b", toolName: "inspect_page", input: "{}" }, { type: "tool-call" as const, toolCallId: "c", toolName: "fill", input: "{}" }],
      finishReason: { unified: "tool-calls" as const, raw: "tool-calls" }, usage, warnings: [],
    } : { content: [{ type: "text" as const, text: "done" }], finishReason: { unified: "stop" as const, raw: "stop" }, usage, warnings: [] } });
    const create = (work: () => Promise<unknown>) => dynamicTool({ inputSchema: z.object({}), execute: async (_input, options) => {
      try { return await scheduler.run(options.toolCallId, work, options.abortSignal); }
      catch (error) { return { ok: false, error: { code: (error as { code?: string }).code } }; }
    } });
    const agent = new ToolLoopAgent({ model, onLanguageModelCallEnd: (event) => { scheduler.prepare(event.content, 1); }, tools: {
      click: create(async () => ({ accepted: true, complete: false, jobId: "background" })),
      inspect_page: create(attempted), fill: create(attempted),
    } });
    const result = await agent.generate({ prompt: "act" });
    expect(result.text).toBe("done"); expect(attempted).not.toHaveBeenCalled();
    expect(result.steps[0]?.toolResults.map((entry) => entry.output)).toEqual([
      { accepted: true, complete: false, jobId: "background" },
      { ok: false, error: { code: "background-job-pending" } },
      { ok: false, error: { code: "background-job-pending" } },
    ]);
  });

  it("prevents later browser calls in the same response from blocking on a background job", async () => {
    const scheduler = new ToolScheduler(names);
    scheduler.prepare([call("start", "click", { background: true }), call("write", "fill"), call("read", "inspect_page"), call("event", "wait_event")], 1);
    const start = scheduler.run("start", async () => ({ accepted: true, complete: false, jobId: "job" }));
    const writeWork = vi.fn(async () => "wrong");
    const readWork = vi.fn(async () => "wrong");
    const write = scheduler.run("write", writeWork);
    const read = scheduler.run("read", readWork);
    const event = scheduler.run("event", async () => "event");
    await expect(start).resolves.toMatchObject({ jobId: "job" });
    await expect(write).rejects.toMatchObject({ code: "background-job-pending" });
    await expect(read).rejects.toMatchObject({ code: "background-job-pending" });
    await expect(event).resolves.toBe("event");
    expect(writeWork).not.toHaveBeenCalled();
    expect(readWork).not.toHaveBeenCalled();
  });

  it("keeps a run-level background fence across responses until the model sees terminal status", async () => {
    let pending = ["job"];
    const scheduler = new ToolScheduler(names, () => pending);
    scheduler.prepare([call("get", "get_job"), call("write", "fill"), call("dialog", "handle_dialog"), call("event", "wait_event")], 1);
    const get = scheduler.run("get", async () => { pending = []; return { terminal: true, state: "succeeded" }; });
    const writeWork = vi.fn(async () => "wrong");
    const write = scheduler.run("write", writeWork);
    const dialog = scheduler.run("dialog", async () => ({ ok: true }));
    const event = scheduler.run("event", async () => "event");
    await expect(get).resolves.toMatchObject({ terminal: true });
    await expect(write).rejects.toMatchObject({ code: "background-job-pending" });
    await expect(dialog).resolves.toEqual({ ok: true });
    await expect(event).resolves.toBe("event");
    expect(writeWork).not.toHaveBeenCalled();
    scheduler.prepare([call("next", "fill")], 1);
    await expect(scheduler.run("next", async () => "after terminal was read")).resolves.toBe("after terminal was read");
  });

  it("preserves a pending job when the scheduler is recreated", async () => {
    const pending = ["active-job"];
    const first = new ToolScheduler(names, () => pending);
    first.prepare([call("first", "click")], 1);
    await expect(first.run("first", async () => "wrong")).rejects.toMatchObject({ code: "background-job-pending" });
    const restarted = new ToolScheduler(names, () => pending);
    restarted.prepare([call("second", "inspect_page"), call("status", "get_job")], 1);
    const read = restarted.run("second", async () => "wrong");
    const status = restarted.run("status", async () => ({ terminal: false }));
    await expect(read).rejects.toMatchObject({ code: "background-job-pending" });
    await expect(status).resolves.toEqual({ terminal: false });
  });

  it("rechecks jobs introduced after response preparation and fails closed on an unavailable index", async () => {
    let pending: string[] = [];
    const scheduler = new ToolScheduler(names, () => pending);
    scheduler.prepare([call("click", "click")], 1);
    pending = ["late-job"];
    const work = vi.fn(async () => "wrong");
    await expect(scheduler.run("click", work)).rejects.toMatchObject({ code: "background-job-pending" });
    expect(work).not.toHaveBeenCalled();
    const broken = new ToolScheduler(names, () => { throw new Error("state lost"); });
    expect(broken.prepare([call("click", "click")], 1)).toMatchObject({ code: "background-job-state-unavailable" });
    await expect(broken.run("click", work)).rejects.toMatchObject({ code: "background-job-state-unavailable" });
  });

  it("cancels a queued call promptly but does not let a following read overtake its predecessor", async () => {
    const scheduler = new ToolScheduler(names);
    scheduler.prepare([call("a", "click"), call("b", "fill"), call("c", "inspect_page")], 3);
    const gate = latch();
    const order: string[] = [];
    const first = scheduler.run("a", async () => { order.push("start"); await gate.promise; order.push("end"); return { ok: true }; });
    const signal = new AbortController();
    const work = vi.fn(async () => "bad");
    const pending = scheduler.run("b", work, signal.signal);
    const read = scheduler.run("c", async () => { order.push("read"); return "ok"; });
    signal.abort("cancelled");
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(work).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(order).toEqual(["start"]));
    gate.release();
    await Promise.all([first, read]);
    expect(order).toEqual(["start", "end", "read"]);
  });

  it("releases slots on thrown errors and tracks changes to the bound tab", async () => {
    const scheduler = new ToolScheduler(names);
    scheduler.prepare([call("bad", "click", { tabId: 1 }), call("switch", "switch_tab", { tabId: 2 }), call("next", "fill"), call("read", "inspect_page")], 1);
    const bad = scheduler.run("bad", async () => { throw new Error("failed"); });
    const change = scheduler.run("switch", async () => ({ ok: true }));
    const next = scheduler.run("next", async () => "tab 2");
    const read = scheduler.run("read", async () => "read");
    await expect(bad).rejects.toThrow("failed");
    await expect(Promise.all([change, next, read])).resolves.toEqual([{ ok: true }, "tab 2", "read"]);
  });

  it("releases uninvoked slots when the run is cancelled", async () => {
    const controller = new AbortController();
    const scheduler = new ToolScheduler(names);
    scheduler.prepare([call("a", "click"), call("b", "fill")], 1, controller.signal);
    controller.abort();
    const work = vi.fn(async () => true);
    await expect(scheduler.run("a", work, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(work).not.toHaveBeenCalled();
    scheduler.prepare([call("new", "click")], 1);
    await expect(scheduler.run("new", work)).resolves.toBe(true);
  });
});
