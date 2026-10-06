import { expect, test } from "@playwright/test";
import { mkdir, writeFile, copyFile } from "node:fs/promises";
import { chunk, textResponse, commandResponse, startProvider, openExtension, configure, nameCurrentConversation, readEvents, dispose } from "./fixtures";
import { finishRenderTrace, installSoftwareCadence, measureRenderTrace, startRenderTrace } from "./render-trace";

// The CDP render trace below is the evidence. A second Playwright screencast /
// DOM snapshot recorder forces extra layout/paint while measuring the frames.
test.use({ trace: "off", screenshot: "off" });

test("120Hz software frames include real dense-stream, code, math, history, input, scroll and tool rendering", { tag: "@performance" }, async () => {
  const frames = Math.max(600, Number(process.env.SURFWAX_PERFORMANCE_FRAMES ?? 600));
  const warmupMs = Math.max(1000, Number(process.env.SURFWAX_PERFORMANCE_WARMUP_MS ?? 1000));
  const total = frames + Math.ceil(warmupMs * 120 / 1000);
  const tokens = Array.from({ length: total - 1 }, (_, index) => index % 60 === 0
    ? `\n\n\`\`\`typescript\nconst value${index}: number = ${index};\n\`\`\`\n\n$$\\int_0^1 x^2 dx = \\frac{1}{3}$$\n\n| A | B |\n| - | - |\n| ${index} | **value** |\n\n`
    : `token-${index} ${index % 4 === 0 ? "\n\n" : ""}`);
  const payload = tokens.join("");
  // Keep the same dense document, but stream its code/math/table syntax as
  // incremental tokens rather than putting three whole blocks in one token.
  const deltas = Array.from({ length: total - 1 }, (_, index) => payload.slice(
    Math.floor(index * payload.length / (total - 1)), Math.floor((index + 1) * payload.length / (total - 1))));
  const text = "# TRACE_LOAD\n\n" + payload + "TRACE_COMPLETE";
  const provider = await startProvider([commandResponse("run", { code: `return await browser.tabs.list();` }, "trace-tool"),
    [chunk({ role: "assistant", content: "# TRACE_LOAD\n\n" }), ...deltas.map((content) => chunk({ content })), chunk({ content: "TRACE_COMPLETE" }), chunk({}, "stop"), "data: [DONE]\n\n"]]);
  const opened = await openExtension(undefined, { args: ["--disable-frame-rate-limit", "--disable-gpu-vsync", "--disable-gpu"] });
  const tracePath = test.info().outputPath("render-trace.json");
  try {
    await opened.page.setViewportSize({ width: 430, height: 850 });
    const options = await configure(opened.context, opened.page, provider.baseURL); await options.close();
    await nameCurrentConversation(opened.page, "Render benchmark");
    const id = (await readEvents(opened.page)).find((event) => event.type === "conversation.created").conversationId;
    // Long history is reconstructed exclusively from the canonical log.
    await opened.page.evaluate(async (conversationId) => {
      const db = await new Promise<IDBDatabase>((resolve) => { const request = indexedDB.open("side-agent-runtime"); request.onsuccess = () => resolve(request.result); });
      const transaction = db.transaction("events", "readwrite"); const store = transaction.objectStore("events");
      let parentId: string | null = null; const timestamp = new Date().toISOString();
      for (let index = 0; index < 500; index++) {
        const userId = `trace-u-${index}`, assistantId = `trace-a-${index}`;
        store.add({ type: "conversation.message", timestamp, conversationId, parentId, content: { id: userId, role: "user", parts: [{ type: "text", text: `Question ${index}` }] } });
        store.add({ type: "conversation.message", timestamp, conversationId, parentId: userId, content: { id: assistantId, role: "assistant", parts: [{ type: "text", text: `## Answer ${index}\n\nHistory with **GFM**, $x^2$ and cached blocks.\n\n\`\`\`js\nconst history = ${index};\n\`\`\`` }] } });
        parentId = assistantId;
      }
      await new Promise<void>((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error); }); db.close();
    }, id);
    await opened.page.reload(); await opened.page.getByTestId("conversation-menu").click();
    await opened.page.locator(".conversation-item", { hasText: "Render benchmark" }).locator(".conversation-select").click();
    await expect(opened.page.locator(".markdown-body").last()).toContainText("Answer 499");
    const session = await opened.context.newCDPSession(opened.page);
    if (process.env.SURFWAX_PROFILE) { await session.send("Profiler.enable"); await session.send("Profiler.start"); }
    await installSoftwareCadence(opened.page, `${provider.baseURL}/chat/completions`, frames, warmupMs);
    await startRenderTrace(session);
    await opened.page.getByTestId("composer-input").fill("render trace workload"); await opened.page.getByTestId("composer-input").press("Enter");
    await expect.poll(() => opened.page.evaluate(() => (globalThis as any).__renderTraceLoad.done), { timeout: 30000 }).toBe(true);
    await expect(opened.page.locator(".markdown-body").last()).toContainText("TRACE_COMPLETE");
    await expect(opened.page.getByRole("button", { name: "停止生成" })).toHaveCount(0);
    if (process.env.SURFWAX_PROFILE) {
      const { profile } = await session.send("Profiler.stop");
      await writeFile(".dev/render-profile.json", JSON.stringify(profile));
    }
    const events = await finishRenderTrace(session, tracePath);
    const measured = measureRenderTrace(events, frames);
    const log = await readEvents(opened.page);
    const final = log.filter((event) => event.type === "conversation.message" && event.content?.role === "assistant").at(-1);
    expect(final.content.parts.filter((part: any) => part.type === "text").map((part: any) => part.text).join("")).toBe(text);
    expect(log.filter((event) => ["tool.finished", "tool.failed"].includes(event.type) && event.toolCallId === "trace-tool")).toHaveLength(1);
    const state = await opened.page.evaluate(() => (globalThis as any).__renderTraceLoad);
    expect(state.supplied).toBe(total); expect(state.measured).toBe(frames);
    const version = await session.send("Browser.getVersion");
    const report = { ...measured, warmupMs, browser: version, node: process.version, finalTextLength: text.length,
      streamEvents: log.filter((event) => event.type === "conversation.stream.chunk").length, integrity: "exact final text and single tool result verified" };
    const reportPath = test.info().outputPath("render-report.json"); await writeFile(reportPath, JSON.stringify(report, null, 2));
    await mkdir(`.dev/verification/performance/${test.info().project.name || "current"}`, { recursive: true });
    await copyFile(tracePath, `.dev/verification/performance/${test.info().project.name || "current"}/render-trace.json`);
    await copyFile(reportPath, `.dev/verification/performance/${test.info().project.name || "current"}/render-report.json`);
    await test.info().attach("render-trace", { path: tracePath, contentType: "application/json" });
    await test.info().attach("render-report", { path: reportPath, contentType: "application/json" });
    console.log(`120Hz ${version.product}: P95 ${measured.p95WorkMs.toFixed(2)}ms; deadline misses ${(measured.deadlineMissRate * 100).toFixed(2)}%; rendered ${measured.renderedFrames}/${frames}`);
    expect(measured.renderedFrames).toBeGreaterThanOrEqual(frames * 0.95);
    expect(measured.p95WorkMs).toBeLessThanOrEqual(1000 / 120);
    expect(measured.deadlineMissRate).toBeLessThanOrEqual(0.01);
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
