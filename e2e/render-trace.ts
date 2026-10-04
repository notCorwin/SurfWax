import type { CDPSession, Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";

export async function startRenderTrace(session: CDPSession) {
  // Capture JS and real render work without expensive diagnostic stack snapshots.
  await session.send("Tracing.start", { transferMode: "ReturnAsStream", categories: "devtools.timeline,toplevel" });
}
export async function finishRenderTrace(session: CDPSession, path: string) {
  const complete = new Promise<{ stream?: string }>((resolve) => session.once("Tracing.tracingComplete", resolve));
  await session.send("Tracing.end");
  const { stream } = await complete;
  if (!stream) throw new Error("Chrome returned no trace stream");
  let raw = "";
  while (true) { const part = await session.send("IO.read", { handle: stream, size: 8 * 1024 * 1024 }); raw += part.data; if (part.eof) break; }
  await session.send("IO.close", { handle: stream }); await writeFile(path, raw);
  return JSON.parse(raw).traceEvents as any[];
}
function unionDuration(intervals: number[][]): number {
  intervals.sort((a, b) => a[0] - b[0]);
  let total = 0, end = -Infinity;
  for (const [start, stop] of intervals) { total += Math.max(0, stop - Math.max(start, end)); end = Math.max(end, stop); }
  return total;
}
export function measureRenderTrace(events: any[], frames: number) {
  const marks = events.map((event) => event.name === "TimeStamp"
    ? { ...event, name: event.args?.data?.message ?? "" } : event)
    .filter((event) => /^surf-wax-frame-\d+$/.test(event.name) && ["R", "I", "i"].includes(event.ph)).sort((a, b) => a.ts - b.ts);
  const unique = [...new Map(marks.map((mark) => [mark.name, mark])).values()];
  // A terminal marker closes the last interval just as the next marker closes
  // every earlier one. Older saved traces can still use the fixed last budget.
  const terminal = unique.at(-1)?.name === `surf-wax-frame-${frames}`;
  if (unique.length !== frames + Number(terminal)
    || unique.slice(0, frames).some((mark, index) => mark.name !== `surf-wax-frame-${index}`)) {
    throw new Error(`Trace has ${unique.length} software frames; expected ${frames}`);
  }
  const { pid, tid } = unique[0];
  const workNames = new Set(["RunTask", "ThreadControllerImpl::RunTask", "FunctionCall", "EvaluateScript", "EventDispatch", "FireAnimationFrame", "UpdateLayoutTree", "Layout", "PrePaint", "Paint", "Layerize", "Commit"]);
  const renderer = events.filter((event) => event.pid === pid && event.tid === tid && event.ph === "X" && workNames.has(event.name) && event.dur > 0);
  const rendering = renderer.filter((event) => ["UpdateLayoutTree", "Layout", "PrePaint", "Paint", "Layerize", "Commit"].includes(event.name));
  const deadlineUs = 1_000_000 / 120;
  const starts = unique.map((mark) => {
    const frame = renderer.find((event) => ["RunTask", "ThreadControllerImpl::RunTask"].includes(event.name) && event.ts <= mark.ts && event.ts + event.dur >= mark.ts)
      ?? renderer.find((event) => event.name === "FireAnimationFrame" && event.ts <= mark.ts && event.ts + event.dur >= mark.ts);
    return frame?.ts ?? mark.ts;
  });
  const samples = unique.slice(0, frames).map((mark, index) => {
    const start = starts[index]!;
    const next = starts[index + 1] ?? start + deadlineUs;
    // Associate complete tasks by their start, and render work by the software
    // frame interval. Union nested spans so JS/layout/paint are counted once.
    const assigned = renderer.filter((event) => event.ts >= start && event.ts < next);
    const intervals = assigned.map((event) => [event.ts, event.ts + event.dur]);
    const workMs = unionDuration(intervals) / 1000;
    const render = rendering.filter((event) => event.ts >= start && event.ts < next);
    const renderEnd = Math.max(start, ...render.map((event) => event.ts + event.dur));
    return { frame: index, workMs, renderMs: unionDuration(render.map((event) => [event.ts, event.ts + event.dur])) / 1000,
      renderEvents: render.length, deadlineMiss: workMs > 1000 / 120 || renderEnd > start + deadlineUs };
  });
  const sorted = samples.map((sample) => sample.workMs).sort((a, b) => a - b);
  return { softwareHz: 120, frameBudgetMs: 1000 / 120, frames, renderer: { pid, tid },
    p95WorkMs: sorted[Math.ceil(sorted.length * 0.95) - 1], deadlineMissRate: samples.filter((sample) => sample.deadlineMiss).length / frames,
    renderedFrames: samples.filter((sample) => sample.renderEvents > 0).length,
    renderEvents: rendering.length, counts: Object.fromEntries([...workNames].map((name) => [name, renderer.filter((event) => event.name === name).length])), samples };
}

/** Software 120Hz input cadence; native RAF and Chrome rendering remain real. */
export async function installSoftwareCadence(page: Page, endpoint: string, frames: number, warmupMs: number) {
  await page.evaluate(({ endpoint, frames, warmupMs }) => {
    // Request a real Chrome animation frame at software 120Hz, sharing it
    // across app callbacks. Uncapped headless Chrome otherwise busy-spins at
    // thousands of RAFs per second, which is a different workload than 120Hz.
    const nativeFrame = globalThis.requestAnimationFrame.bind(globalThis);
    const callbacks = new Map<number, FrameRequestCallback>();
    let nextId = 0, pending = false, nextDue = performance.now();
    let measuredFrame: number | undefined;
    const schedule = () => {
      if (pending || !callbacks.size) return;
      pending = true;
      const due = Math.max(nextDue, performance.now());
      setTimeout(() => nativeFrame((now) => {
        nextDue = due + 1000 / 120;
        // Trace-only markers avoid adding PerformanceEntry/observer work to
        // the application being measured, especially on older Chrome.
        if (measuredFrame !== undefined) {
          console.timeStamp(`surf-wax-frame-${measuredFrame}`);
          if (measuredFrame < frames) (globalThis as any).__renderTraceLoad.measured++;
          measuredFrame = undefined;
        }
        const current = [...callbacks.values()]; callbacks.clear(); pending = false;
        for (const callback of current) callback(now);
        schedule();
      }), Math.max(0, due - performance.now()));
    };
    globalThis.requestAnimationFrame = (callback) => { const id = ++nextId; callbacks.set(id, callback); schedule(); return id; };
    globalThis.cancelAnimationFrame = (id) => { callbacks.delete(id); };
    const originalFetch = globalThis.fetch.bind(globalThis);
    let used = false;
    Object.assign(globalThis, { __renderTraceLoad: { done: false, supplied: 0, measured: 0 } });
    globalThis.fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const response = await originalFetch(request);
      if (used || request.url !== endpoint || !response.ok) return response;
      const reader = response.body!.getReader();
      const decoder = new TextDecoder(); const encoder = new TextEncoder();
      let buffer = "", eof = false; const queue: string[] = []; const waiters: (() => void)[] = [];
      const pump = async () => { while (true) {
        const part = await reader.read(); if (part.done) { eof = true; for (const wake of waiters.splice(0)) wake(); return; }
        buffer += decoder.decode(part.value, { stream: true });
        let end: number; while ((end = buffer.indexOf("\n\n")) >= 0) { queue.push(buffer.slice(0, end + 2)); buffer = buffer.slice(end + 2); }
        for (const wake of waiters.splice(0)) wake();
      } };
      void pump();
      while (!queue.length && !eof) await new Promise<void>((resolve) => waiters.push(resolve));
      // Tool exchanges and metadata keep their real native stream behavior.
      if (!queue[0]?.includes("TRACE_LOAD")) return new Response(new ReadableStream({ async start(controller) {
        while (!eof || queue.length) { if (!queue.length) await new Promise<void>((resolve) => waiters.push(resolve)); while (queue.length) controller.enqueue(encoder.encode(queue.shift()!)); }
        if (buffer) controller.enqueue(encoder.encode(buffer)); controller.close();
      } }), { status: response.status, headers: response.headers });
      used = true;
      const state = (globalThis as any).__renderTraceLoad;
      const warmupFrames = Math.ceil(warmupMs * 120 / 1000);
      const body = new ReadableStream({ async start(controller) {
        for (let index = 0; index < warmupFrames + frames; index++) {
          if (index >= warmupFrames) measuredFrame = index - warmupFrames;
          await new Promise<void>((resolve) => requestAnimationFrame(() => {
            // Stream + scrolling + editable draft exercise the real app in each
            // frame. Completed code/math blocks stay in the virtual transcript.
            const input = document.querySelector<HTMLTextAreaElement>("[data-testid=composer-input]")!;
            const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
            setter.call(input, `draft ${index}`); input.dispatchEvent(new Event("input", { bubbles: true }));
            const viewport = document.querySelector<HTMLElement>("[data-testid=thread-viewport]")!;
            viewport.scrollTop = viewport.scrollHeight - viewport.clientHeight - (index % 8);
            if (queue.length) { controller.enqueue(encoder.encode(queue.shift()!)); state.supplied++; }
            resolve();
          }));
        }
        measuredFrame = frames;
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        while (!eof || queue.length) { if (!queue.length) await new Promise<void>((resolve) => waiters.push(resolve)); while (queue.length) controller.enqueue(encoder.encode(queue.shift()!)); }
        if (buffer) controller.enqueue(encoder.encode(buffer)); controller.close(); state.done = true;
      } });
      return new Response(body, { status: response.status, headers: response.headers });
    };
  }, { endpoint, frames, warmupMs });
}
