// @vitest-environment node
import { expect, it } from "vitest";
import { browserJobsSettled } from "../../e2e/evaluation/job-evidence";
import { toLogValue } from "../../src/logging";
import { toolLifecycleEvidence } from "../../e2e/evaluation/tool-lifecycle";
import { evaluateResultEvidence } from "../../e2e/evaluation/result-evidence";

it("only treats all known browser jobs as settled after their terminal states", () => {
  const event = (id: number, jobId: string, state: string) => ({ id, type: "browser.job.state", conversationId: "c", runId: "r", content: { jobId, state } });
  expect(browserJobsSettled([])).toBe(true);
  expect(browserJobsSettled([event(1, "a", "running")])).toBe(false);
  expect(browserJobsSettled([event(2, "a", "succeeded"), event(1, "a", "queued")])).toBe(true);
  expect(browserJobsSettled([event(1, "a", "succeeded"), event(2, "b", "blocked")])).toBe(false);
  const failure = { ok: false, error: { code: "not-found", message: "No match" } };
  expect(browserJobsSettled([{ ...event(1, "a", "failed"), output: failure }, event(2, "b", "succeeded")])).toBe(true);
  expect(browserJobsSettled([event(1, "a", "failed")])).toBeNull();
  expect(browserJobsSettled([{ ...event(1, "a", "failed"), output: { ok: false, error: { ...failure.error, effectUnknown: true } } }])).toBeNull();
  expect(browserJobsSettled([{ ...event(1, "a", "failed"), output: { ok: false, error: { ...failure.error, effectUnknown: "unknown" } } }])).toBeNull();
  expect(browserJobsSettled([event(1, "a", "interrupted"), event(2, "b", "failed")])).toBeNull();
  expect(browserJobsSettled([event(1, "a", "cancelled")])).toBeNull();
  expect(browserJobsSettled([event(1, "a", "unknown")])).toBeNull();
  expect(browserJobsSettled([event(1, "a", "running"), event(1, "a", "succeeded")])).toBeNull();
  expect(browserJobsSettled([{ ...event(1, "a", "running"), runId: undefined }])).toBeNull();
});

it("cross-checks accepted job handoffs against the same run's canonical states", () => {
  const tool = (id: number, output: unknown, identity = { conversationId: "c", runId: "r" }) => ({
    id, type: "tool.finished", ...identity, output,
  });
  const job = (id: number, state: string, identity = { conversationId: "c", runId: "r" }) => ({
    id, type: "browser.job.state", ...identity, content: { jobId: "job-a", state },
  });
  const accepted = { accepted: true, complete: false, jobId: "job-a" };
  expect(browserJobsSettled([tool(2, accepted)])).toBeNull();
  expect(browserJobsSettled([job(1, "queued", { conversationId: "other", runId: "r" }), tool(2, accepted)])).toBe(false);
  expect(browserJobsSettled([job(1, "succeeded", { conversationId: "c", runId: "other" }), tool(2, accepted)])).toBeNull();
  expect(browserJobsSettled([job(1, "queued"), tool(2, accepted)])).toBe(false);
  expect(browserJobsSettled([job(1, "succeeded"), tool(2, accepted)])).toBe(true);
  expect(browserJobsSettled([job(1, "cancelled"), tool(2, accepted)])).toBeNull();
  expect(browserJobsSettled([tool(2, { accepted: true, complete: false })])).toBeNull();
  expect(browserJobsSettled([tool(2, { accepted: true, jobId: "job-a" })])).toBeNull();
  expect(browserJobsSettled([job(1, "succeeded"), tool(2, { accepted: true, jobId: "job-a" })])).toBe(true);
  expect(browserJobsSettled([job(1, "succeeded"), tool(2, { accepted: false, complete: false, jobId: "job-a" })])).toBeNull();
  expect(browserJobsSettled([tool(2, { ...accepted, envelopeWrapped: true, result: { ...accepted, jobId: "different" } })])).toBeNull();
  expect(browserJobsSettled([tool(2, { envelopeWrapped: true })])).toBeNull();
  expect(browserJobsSettled([tool(2, { envelopeWrapped: true, result: accepted })])).toBeNull();
  expect(browserJobsSettled([job(1, "succeeded"), tool(2, { envelopeWrapped: true, result: accepted })])).toBe(true);
  expect(browserJobsSettled([job(1, "succeeded"), tool(2, { $ref: 7, ...accepted })])).toBe(true);
  expect(browserJobsSettled([job(1, "succeeded"), tool(2, { $ref: 7, envelopeWrapped: true, ...accepted })])).toBe(true);
  expect(browserJobsSettled([job(1, "succeeded"), tool(2, { $ref: "invalid", envelopeWrapped: true, ...accepted })])).toBeNull();
  expect(browserJobsSettled([job(1, "succeeded"), { ...tool(2, toLogValue(accepted, undefined, 5)), valueEncoding: 5 }])).toBe(true);
  expect(browserJobsSettled([{ ...tool(2, { $type: "array-buffer", base64: "invalid", byteLength: 1 }), valueEncoding: 5 }])).toBeNull();
});

it("does not infer background work from synchronous or ordinary tool output", () => {
  const tool = (output: unknown) => ({ id: 1, type: "tool.finished", conversationId: "c", runId: "r", output });
  expect(browserJobsSettled([tool({ ok: true, state: "succeeded", jobId: "completed", result: "ok" })])).toBe(true);
  expect(browserJobsSettled([tool({ ok: true, result: { accepted: true, complete: false, jobId: "user-data" } })])).toBe(true);
  expect(browserJobsSettled([tool({ accepted: true, state: "completed" })])).toBe(true);
  expect(browserJobsSettled([tool({ $ref: 42, envelopeWrapped: true })])).toBe(true);
  expect(browserJobsSettled([tool("plain value")])).toBe(true);
  expect(browserJobsSettled([{ id: 1, type: "tool.finished", conversationId: "c", runId: "r" }])).toBeNull();
});

it("does not pass a successful business result when the accepted job log is missing", () => {
  const owner = { conversationId: "c", runId: "r" };
  const events = [
    { id: 1, type: "conversation.message", ...owner, content: { id: "m", role: "assistant", parts: [{ type: "tool-execute_program", toolCallId: "t" }] } },
    { id: 2, type: "tool.started", ...owner, toolCallId: "t" },
    { id: 3, type: "tool.finished", ...owner, toolCallId: "t", output: { accepted: true, complete: false, jobId: "j" } },
  ];
  const lifecycle = toolLifecycleEvidence(events);
  expect(lifecycle.complete).toBe(true);
  expect(evaluateResultEvidence({ outcome: "conversation.finished", networkSettled: true, ledgerDrained: true, logComplete: true,
    business: true, interaction: { applicable: false }, lifecycle: lifecycle.complete, jobsSettled: browserJobsSettled(events) }))
    .toMatchObject({ classification: "unknown", passed: false, reasons: ["jobs_unknown"] });
});
