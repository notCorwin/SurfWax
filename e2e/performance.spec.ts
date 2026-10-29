import { chromium, expect, type BrowserContext, type CDPSession, type Locator, type Page } from "@playwright/test";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";


import { test, p95, textResponse, toolResponse, pageResponse, commandResponse, queuedToolResponse, startProvider, closeServer, openExtension, dispose, selectProvider, configure, themeColors, expectThemeButton, startNewConversation, nameCurrentConversation, enableUserScripts, readEvents, attachTarget, warnsOnLeave, type MockResponse } from './fixtures';

test("keeps 100 semantic locate-and-action operations at p95 <= 100ms", { tag: "@performance" }, async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/performance`);
    responses.push(commandResponse("execute_program", { timeoutMs: 30000, code: "for(let i=0;i<100;i++) await page.getByRole('button',{name:'Increment'}).click(); const count=await page.locator('output').innerText(); await check(count==='100','all 100 native clicks must change the counter'); return count;" }, "call-performance"), textResponse("PERFORMANCE_OK"), textResponse("性能"));
    const options = await configure(opened.context, opened.page, provider.baseURL); await options.close();
    // This harness opens the panel in a tab; a real Side Panel retains page focus.
    await target.bringToFront();
    await expect.poll(() => target.evaluate(() => document.hasFocus())).toBe(true);
    await opened.page.getByTestId("composer-input").fill("benchmark semantic actions"); await opened.page.getByTestId("composer-input").press("Enter");
    await expect(target.locator("output")).toHaveText("100", { timeout: 30_000 });
    await expect(opened.page.locator(".markdown-body").last()).toContainText("PERFORMANCE_OK");
    const events = await readEvents(opened.page);
    expect(events.find((event) => event.type === "tool.finished" && event.toolCallId === "call-performance")?.output).toMatchObject({ ok: true, state: "succeeded", result: "100" });
    const latencies = events.filter((event) => event.type === "automation.action.finished" && event.toolCallId === "call-performance" && event.content.operation === "click").map((event) => event.latencyMs);
    const evidence = test.info().outputPath("semantic-action-latencies.json");
    await writeFile(evidence, JSON.stringify({ p95Ms: p95(latencies), samples: latencies }, null, 2));
    await test.info().attach("semantic-action-latencies", { path: evidence, contentType: "application/json" });
    expect(latencies).toHaveLength(100);
    expect(p95(latencies)).toBeLessThanOrEqual(100);
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});


test("stress profile: dense complete response and long canonical history stay interactive", { tag: "@performance" }, async () => {
  const stressReply = "# Stress\n\n" + Array.from({ length: 1_500 }, (_, index) => index % 25 === 0
    ? `\n\n- row ${index} with **bold** and $x_${index}^2$\n\n`
    : `token-${index} `).join("") + "\n\nFULL_RESPONSE_STRESS_DONE";
  const provider = await startProvider([textResponse(stressReply), textResponse("压力测试")]);
  const opened = await openExtension();
  try {
    await opened.page.setViewportSize({ width: 430, height: 850 });
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    const composer = opened.page.getByTestId("composer-input");
    await composer.fill("stress rendering of a complete response");
    const initialFullRenderStarted = Date.now();
    await composer.press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("FULL_RESPONSE_STRESS_DONE");
    const initialFullRenderMs = Date.now() - initialFullRenderStarted;

    const viewport = opened.page.getByTestId("thread-viewport");
    const box = await viewport.boundingBox();
    if (!box) throw new Error("stress viewport has no bounding box");
    await opened.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await opened.page.evaluate(() => {
      const metrics = { frameGaps: [] as number[], frameCount: 0, longTasks: [] as number[], inputLatencies: [] as number[], running: true };
      document.addEventListener('input', event => {
        const started = event.timeStamp;
        requestAnimationFrame(() => metrics.inputLatencies.push(performance.now() - started));
      }, true);
      (globalThis as typeof globalThis & { __stressMetrics?: typeof metrics }).__stressMetrics = metrics;
      if (PerformanceObserver.supportedEntryTypes.includes("longtask")) {
        new PerformanceObserver((list) => {
          metrics.longTasks.push(...list.getEntries().map((entry) => entry.duration));
        }).observe({ type: "longtask", buffered: true });
      }
      let previous: number | null = null;
      const frame = (now: number) => {
        if (!metrics.running) return;
        metrics.frameCount += 1;
        if (previous !== null && now > previous) metrics.frameGaps.push(now - previous);
        previous = now;
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });

    const activeWorkloadStarted = Date.now();
    const inputPhaseDeadline = activeWorkloadStarted + 1_500;
    const scrollPhaseDeadline = activeWorkloadStarted + 3_000;
    let inputMs = 0;
    while (Date.now() < inputPhaseDeadline) {
      const inputStarted = Date.now();
      await composer.pressSequentially("responsive-typing-".repeat(12));
      if (inputMs === 0) inputMs = Date.now() - inputStarted;
    }
    let scrollDirection = 1;
    while (Date.now() < scrollPhaseDeadline) {
      await opened.page.mouse.wheel(0, scrollDirection * 400);
      scrollDirection *= -1;
      // Allow each real wheel action to produce its browser scroll frame before the next one.
      await opened.page.waitForTimeout(16);
    }
    const activeWorkloadMs = Date.now() - activeWorkloadStarted;
    const metrics = await opened.page.evaluate(() => {
      const state = (globalThis as typeof globalThis & { __stressMetrics?: { frameGaps: number[]; frameCount: number; longTasks: number[]; inputLatencies: number[]; running: boolean } }).__stressMetrics;
      if (!state) return { frameGaps: [] as number[], frameCount: 0, inputLatencies: [] as number[], maxLongTask: 0, longTaskCount: 0 };
      state.running = false;
      return {
        frameGaps: state.frameGaps,
        frameCount: state.frameCount,
        inputLatencies: state.inputLatencies,
        maxLongTask: Math.max(0, ...state.longTasks),
        longTaskCount: state.longTasks.length,
      };
    });
    const events = await readEvents(opened.page);
    const conversationId = events.find((event) => event.type === "conversation.created")?.conversationId;
    if (!conversationId) throw new Error("stress conversation was not created");
    const finalAssistant = events.filter((event) => event.type === "conversation.message" && event.content?.role === "assistant").at(-1);
    expect(finalAssistant.content.parts.filter((part: any) => part.type === "text").map((part: any) => part.text).join("")).toBe(stressReply);

    await opened.page.evaluate(async ({ id }) => {
      const db = await new Promise<IDBDatabase>((resolveDb, reject) => {
        const request = indexedDB.open("side-agent-runtime");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolveDb(request.result);
      });
      const transaction = db.transaction("events", "readwrite");
      const store = transaction.objectStore("events");
      const timestamp = new Date().toISOString();
      let parentId: string | null = null;
      for (let index = 0; index < 500; index += 1) {
        const userId = `stress-user-${index}`;
        const assistantId = `stress-assistant-${index}`;
        store.add({
          type: "conversation.message",
          timestamp,
          conversationId: id,
          parentId,
          content: { id: userId, role: "user", parts: [{ type: "text", text: `Question ${index}` }] },
        });
        store.add({
          type: "conversation.message",
          timestamp,
          conversationId: id,
          parentId: userId,
          content: {
            id: assistantId,
            role: "assistant",
            parts: [{ type: "text", text: `## Answer ${index}\n\n${"Paragraph with **formatting** and $x^2$.\n\n".repeat(8)}HISTORY_MARKER_${index}` }],
          },
        });
        parentId = assistantId;
      }
      await new Promise<void>((resolveTransaction, reject) => {
        transaction.oncomplete = () => resolveTransaction();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
      db.close();
    }, { id: conversationId });

    const reloadStarted = Date.now();
    await opened.page.reload();
    await expect(opened.page.getByTestId("conversation-menu")).toContainText("新对话");
    await opened.page.getByTestId("conversation-menu").click();
    await opened.page.locator(".conversation-item", { hasText: "压力测试" }).locator(".conversation-select").click();
    await expect(opened.page.locator(".markdown-body").last()).toContainText("HISTORY_MARKER_499");
    const reloadMs = Date.now() - reloadStarted;
    const restoredComposer = opened.page.getByTestId("composer-input");
    await opened.page.evaluate(() => {
      const latencies: number[] = [];
      Object.assign(globalThis, { __restoredInputLatencies: latencies });
      document.addEventListener('input', event => { const started = event.timeStamp; requestAnimationFrame(() => latencies.push(performance.now() - started)); }, true);
    });
    const restoredInputStarted = Date.now();
    await restoredComposer.pressSequentially("after-reload");
    const restoredInputMs = Date.now() - restoredInputStarted;
    await opened.page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    const restoredInputLatencies = await opened.page.evaluate(() => (globalThis as typeof globalThis & { __restoredInputLatencies: number[] }).__restoredInputLatencies);
    const dom = await opened.page.evaluate(() => ({
      elements: document.querySelectorAll("*").length,
      messages: document.querySelectorAll('[data-role="user"], [data-role="assistant"]').length,
    }));
    await opened.page.evaluate(() => {
      const state = { gaps: [] as number[], running: true };
      (globalThis as typeof globalThis & { __scrollStress?: typeof state }).__scrollStress = state;
      let previous: number | null = null;
      const frame = (now: number) => {
        if (!state.running) return;
        if (previous !== null && now > previous) state.gaps.push(now - previous);
        previous = now;
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
    await opened.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let index = 0; index < 30; index += 1) {
      await opened.page.mouse.wheel(0, -1_000);
      await opened.page.waitForTimeout(16);
    }
    const scrollFrameGaps = await opened.page.evaluate(() => {
      const state = (globalThis as typeof globalThis & { __scrollStress?: { gaps: number[]; running: boolean } }).__scrollStress;
      if (!state) return [] as number[];
      state.running = false;
      return state.gaps;
    });
    const maxFrameGap = Math.max(0, ...metrics.frameGaps);
    const p95FrameGap = p95(metrics.frameGaps);
    const scrollMaxFrameGap = Math.max(0, ...scrollFrameGaps);
    const scrollP95FrameGap = p95(scrollFrameGaps);
    const jump = opened.page.getByRole("button", { name: "滚动到底部" });
    await expect(jump).toBeVisible();
    await jump.click();
    await expect(opened.page.locator(".markdown-body").last()).toContainText("HISTORY_MARKER_499");
    const measured = { initialFullRenderMs, activeWorkloadMs, inputMs, restoredInputMs, reloadMs, maxFrameGap, p95FrameGap, scrollMaxFrameGap, scrollP95FrameGap,
      inputToFrameP95: p95(metrics.inputLatencies), restoredInputToFrameP95: p95(restoredInputLatencies), ...dom,
      maxLongTask: metrics.maxLongTask, longTaskCount: metrics.longTaskCount,
      samples: { frameCount: metrics.frameCount, frameGaps: metrics.frameGaps, inputToFrame: metrics.inputLatencies, restoredInputToFrame: restoredInputLatencies, scrollFrameGaps } };
    console.log('stress metrics', measured);
    const evidence = test.info().outputPath("local-performance-metrics.json");
    await writeFile(evidence, JSON.stringify(measured, null, 2));
    await test.info().attach('local-performance-metrics', { path: evidence, contentType: 'application/json' });

    expect(initialFullRenderMs).toBeLessThan(2_000);
    expect(activeWorkloadMs).toBeGreaterThanOrEqual(3_000);
    expect(inputMs).toBeLessThan(500);
    expect(restoredInputMs).toBeLessThan(500);
    expect(reloadMs).toBeLessThan(2_000);
    expect(dom.messages).toBeLessThan(50);
    expect(dom.elements).toBeLessThan(1_000);
    expect(metrics.frameCount).toBeGreaterThanOrEqual(120);
    expect(metrics.frameGaps.length).toBeGreaterThan(30);
    expect(metrics.inputLatencies.length).toBeGreaterThan(10);
    expect(restoredInputLatencies.length).toBeGreaterThan(5);
    expect(p95FrameGap).toBeLessThanOrEqual(20);
    expect(scrollP95FrameGap).toBeLessThanOrEqual(20);
    expect(measured.inputToFrameP95).toBeLessThanOrEqual(50);
    expect(measured.restoredInputToFrameP95).toBeLessThanOrEqual(50);
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});
