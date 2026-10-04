import { expect, it } from "vitest";
import { measureRenderTrace } from "../../e2e/render-trace";

const marker = (index: number, ts: number) => ({ name: "TimeStamp", ph: "I", pid: 1, tid: 2, ts,
  args: { data: { message: `surf-wax-frame-${index}` } } });
const span = (name: string, ts: number, dur: number, pid = 1) => ({ name, ph: "X", pid, tid: 2, ts, dur });
it("correlates Chrome frame markers, unions nested real work and rejects deadline misses", () => {
  const report = measureRenderTrace([
    marker(0, 100), marker(1, 10100),
    span("ThreadControllerImpl::RunTask", 0, 7000), span("FunctionCall", 200, 5000), span("Paint", 5500, 500),
    span("RunTask", 10000, 9000), span("Layout", 15000, 1000),
    // Work in another renderer cannot be attributed to this extension frame.
    span("RunTask", 500, 100000, 3),
  ], 2);
  expect(report.samples.map((sample) => sample.workMs)).toEqual([7, 9]);
  expect(report.renderedFrames).toBe(2);
  expect(report.p95WorkMs).toBe(9);
  expect(report.deadlineMissRate).toBe(0.5);
});
it("requires every requested frame and accepts saved User Timing traces", () => {
  expect(() => measureRenderTrace([marker(0, 100)], 600)).toThrow("expected 600");
  const report = measureRenderTrace([{ name: "surf-wax-frame-0", ph: "R", pid: 1, tid: 2, ts: 100 },
    span("RunTask", 0, 1000), span("Paint", 500, 100)], 1);
  expect(report.samples[0]?.workMs).toBe(1);
  expect(report.deadlineMissRate).toBe(0);
});
it("uses a terminal frame marker to keep completion work in its own interval", () => {
  const report = measureRenderTrace([marker(0, 100), marker(1, 8100),
    span("RunTask", 0, 6000), span("Paint", 5500, 300),
    span("RunTask", 8000, 20000), span("Layout", 9000, 1000)], 1);
  expect(report.frames).toBe(1);
  expect(report.samples[0]?.workMs).toBe(6);
  expect(report.deadlineMissRate).toBe(0);
});
