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
    id, type: "tool.finished", ...identity, content: { toolName: "read_artifact" }, output,
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
  const tool = (output: unknown) => ({ id: 1, type: "tool.finished", conversationId: "c", runId: "r", content: { toolName: "read_artifact" }, output });
  expect(browserJobsSettled([tool({ ok: true, state: "succeeded", jobId: "completed", result: "ok" })])).toBe(true);
  expect(browserJobsSettled([tool({ ok: true, result: { accepted: true, complete: false, jobId: "user-data" } })])).toBe(true);
  expect(browserJobsSettled([tool({ accepted: true, state: "completed" })])).toBe(true);
  expect(browserJobsSettled([tool({ $ref: 42, envelopeWrapped: true })])).toBe(true);
  expect(browserJobsSettled([tool("plain value")])).toBe(true);
  expect(browserJobsSettled([{ ...tool("plain value"), content: undefined }])).toBeNull();
  expect(browserJobsSettled([{ id: 1, type: "tool.finished", conversationId: "c", runId: "r" }])).toBeNull();
});

it("does not pass a successful business result when the accepted job log is missing", () => {
  const owner = { conversationId: "c", runId: "r" };
  const events = [
    { id: 1, type: "conversation.message", ...owner, content: { id: "m", role: "assistant", parts: [{ type: "tool-execute_program", toolCallId: "t" }] } },
    { id: 2, type: "tool.started", ...owner, toolCallId: "t" },
    { id: 3, type: "tool.finished", ...owner, toolCallId: "t", content: { toolName: "execute_program" }, output: { accepted: true, complete: false, jobId: "j" } },
  ];
  const lifecycle = toolLifecycleEvidence(events);
  expect(lifecycle.complete).toBe(true);
  expect(evaluateResultEvidence({ outcome: "conversation.finished", networkSettled: true, ledgerDrained: true, logComplete: true,
    business: true, interaction: { applicable: false }, lifecycle: lifecycle.complete, jobsSettled: browserJobsSettled(events) }))
    .toMatchObject({ classification: "unknown", passed: false, reasons: ["jobs_unknown"] });
});

it("correlates foreground program results with canonical job states", () => {
  const owner = { conversationId: "c", runId: "r", toolCallId: "t" };
  const job = (state: string, identity = owner) => ({ id: 4, type: "browser.job.state", ...identity, content: { jobId: "j", state } });
  const tool = (name: string, output: unknown, identity = owner) => ({
    id: 3, type: "tool.finished", ...identity, content: { toolName: name }, output,
  });
  const output = { jobId: "j", ok: true, state: "succeeded", result: { jobId: "ordinary", accepted: true, complete: false } };
  expect(browserJobsSettled([tool("execute_program", output)])).toBeNull();
  expect(browserJobsSettled([tool("click", output)])).toBeNull();
  expect(browserJobsSettled([tool("execute_program", output), job("succeeded")])).toBe(true);
  expect(browserJobsSettled([tool("execute_program", output), job("running")])).toBe(false);
  expect(browserJobsSettled([tool("execute_program", output), { ...job("failed"), output: { ok: false, error: { code: "known", message: "Known failure" } } }])).toBeNull();
  expect(browserJobsSettled([tool("execute_program", output), job("succeeded", { ...owner, runId: "other" })])).toBeNull();
  expect(browserJobsSettled([tool("execute_program", output), job("succeeded", { ...owner, toolCallId: "other" })])).toBeNull();
  expect(browserJobsSettled([tool("execute_program", output, { ...owner, toolCallId: "" }), job("succeeded")])).toBeNull();
  expect(browserJobsSettled([tool("execute_program", { ok: true, result: "missing envelope" })])).toBeNull();
  expect(browserJobsSettled([tool("execute_program", "missing envelope")])).toBeNull();
  // Ordinary direct-tool return values do not imply a browser job.
  expect(browserJobsSettled([tool("read_artifact", output)])).toBe(true);
  expect(browserJobsSettled([tool("list_tabs", output)])).toBe(true);
  expect(browserJobsSettled([{ ...tool("upload_file", { ok: true, result: "chooser upload" }), input: { chooserId: "chooser", artifactId: 1 } }])).toBe(true);
  expect(browserJobsSettled([tool("execute_program", { ...output, envelopeWrapped: true, result: output }), job("succeeded")])).toBe(true);
  const encoded = { ...tool("execute_program", toLogValue(output, undefined, 5)), content: toLogValue({ toolName: "execute_program" }, undefined, 5), valueEncoding: 5 };
  expect(browserJobsSettled([encoded])).toBeNull();
  expect(browserJobsSettled([encoded, job("succeeded")])).toBe(true);
});

it("resolves compressed foreground result owners only from matching canonical artifacts", () => {
  const owner = { conversationId: "c", runId: "r", toolCallId: "t" };
  const tool = { id: 5, type: "tool.finished", ...owner, content: { toolName: "execute_program" }, output: { $ref: 2, resultAccess: { artifactId: 2, path: ["result"] } } };
  const artifact = { id: 2, type: "tool.result.data", ...owner, content: { bytes: 9000 }, output: { jobId: "j", ok: true, state: "succeeded", result: "large" } };
  const job = { id: 4, type: "browser.job.state", ...owner, content: { jobId: "j", state: "succeeded" } };
  expect(browserJobsSettled([tool])).toBeNull();
  expect(browserJobsSettled([tool, artifact])).toBeNull();
  expect(browserJobsSettled([tool, artifact, job])).toBe(true);
  expect(browserJobsSettled([tool, { ...artifact, toolCallId: "other" }, job])).toBeNull();
  expect(browserJobsSettled([tool, artifact, artifact, job])).toBeNull();
  expect(browserJobsSettled([tool, { ...artifact, content: { jobId: "j" }, output: { result: "large" } }, job])).toBe(true);
  const partitioned = { ...artifact, output: null, artifactGraph: { version: 1, key: "parts", root: [1, 0] } };
  expect(browserJobsSettled([tool, partitioned, job])).toBe(true);
  expect(browserJobsSettled([tool, partitioned])).toBeNull();
  expect(browserJobsSettled([tool, partitioned, { ...job, toolCallId: "other" }])).toBeNull();
  expect(browserJobsSettled([tool, partitioned, job, { ...job, id: 6, content: { jobId: "other", state: "succeeded" } }])).toBeNull();
  // A compacted job result may instead preserve jobId in the visible envelope.
  expect(browserJobsSettled([{ ...tool, output: { $ref: 2, jobId: "j", ok: true, state: "succeeded" } }, job])).toBe(true);
});

it("does not pass a completed business result when its foreground job state is missing", () => {
  const owner = { conversationId: "c", runId: "r" };
  const events = [
    { id: 1, type: "conversation.message", ...owner, content: { id: "m", role: "assistant", parts: [{ type: "tool-execute_program", toolCallId: "t" }] } },
    { id: 2, type: "tool.started", ...owner, toolCallId: "t", content: { toolName: "execute_program" } },
    { id: 3, type: "tool.finished", ...owner, toolCallId: "t", content: { toolName: "execute_program" }, output: { jobId: "j", ok: true, state: "succeeded", result: "done" } },
  ];
  const lifecycle = toolLifecycleEvidence(events).complete;
  expect(lifecycle).toBe(true);
  expect(evaluateResultEvidence({ outcome: "conversation.finished", networkSettled: true, ledgerDrained: true, logComplete: true,
    business: true, interaction: { applicable: false }, lifecycle, jobsSettled: browserJobsSettled(events) }))
    .toMatchObject({ classification: "unknown", passed: false, reasons: ["jobs_unknown"] });
});

it("distinguishes target upload jobs from direct chooser uploads by their canonical input", () => {
  const owner = { conversationId: "c", runId: "r", toolCallId: "upload" };
  const input = { target: { by: "css", value: "#file" }, artifactId: 7 };
  const output = { ok: true, state: "succeeded", jobId: "j", result: { performed: true } };
  const tool = { id: 3, type: "tool.finished", ...owner, content: { toolName: "upload_file" }, input, output };
  const job = { id: 4, type: "browser.job.state", ...owner, content: { jobId: "j", state: "succeeded" } };
  expect(browserJobsSettled([tool])).toBeNull();
  expect(browserJobsSettled([tool, job])).toBe(true);
  expect(browserJobsSettled([tool, { ...job, toolCallId: "different" }])).toBeNull();
  const chooser = { ...tool, input: { chooserId: "chooser", artifactId: 7 }, output: { chooserId: "chooser", state: "completed" } };
  expect(browserJobsSettled([chooser])).toBe(true);
  for (const bad of [undefined, {}, { chooserId: "", artifactId: 7 }, { target: null, artifactId: 7 }, { target: [], artifactId: 7 }, { ...input, chooserId: "chooser" }]) {
    expect(browserJobsSettled([{ ...tool, input: bad }])).toBeNull();
  }
  const encoded = { ...tool, valueEncoding: 5, content: toLogValue(tool.content, undefined, 5),
    input: toLogValue(input, undefined, 5), output: toLogValue(output, undefined, 5) };
  expect(browserJobsSettled([encoded])).toBeNull();
  expect(browserJobsSettled([encoded, job])).toBe(true);
  expect(browserJobsSettled([{ ...encoded, input: { $type: "array-buffer", base64: "invalid", byteLength: 1 } }])).toBeNull();
  const compact = { ...tool, output: { $ref: 2, resultAccess: { artifactId: 2, path: ["result"] } } };
  const artifact = { id: 2, type: "tool.result.data", ...owner, content: { bytes: 9000 }, output };
  expect(browserJobsSettled([compact, artifact, job])).toBe(true);
  expect(browserJobsSettled([compact, artifact])).toBeNull();
  const graph = { ...artifact, output: null, artifactGraph: { version: 1, key: "parts", root: [1, 0] } };
  expect(browserJobsSettled([compact, graph, job])).toBe(true);
  expect(browserJobsSettled([compact, graph])).toBeNull();
});

it("keeps uncertain tool failures unknown even when no job state is recorded", () => {
  const owner = { conversationId: "c", runId: "r", toolCallId: "t" };
  const failure = (error: unknown) => ({ id: 3, type: "tool.failed", ...owner, content: { toolName: "upload_file" }, output: { ok: false, error }, error });
  const known = { code: "invalid-input", message: "Invalid argument", retryable: false };
  expect(browserJobsSettled([failure(known)])).toBe(true);
  expect(browserJobsSettled([failure({ ...known, effectUnknown: false })])).toBe(true);
  expect(browserJobsSettled([failure({ ...known, effectUnknown: true })])).toBeNull();
  expect(browserJobsSettled([failure({ ...known, effectUnknown: "yes" })])).toBeNull();
  expect(browserJobsSettled([failure(undefined)])).toBeNull();
  expect(browserJobsSettled([{ ...failure(known), error: { ...known, effectUnknown: true } }])).toBeNull();
  expect(browserJobsSettled([{ ...failure(known), content: { toolName: "upload_file", effectUnknown: true } }])).toBeNull();
  expect(browserJobsSettled([{ ...failure(known), valueEncoding: 5, output: toLogValue({ ok: false, error: { ...known, effectUnknown: true } }, undefined, 5), error: toLogValue(known, undefined, 5) }])).toBeNull();
  const events = [
    { id: 1, type: "conversation.message", conversationId: "c", runId: "r", content: { id: "m", role: "assistant", parts: [{ type: "tool-upload_file", toolCallId: "t" }] } },
    { id: 2, type: "tool.started", ...owner },
    failure({ ...known, effectUnknown: true }),
  ];
  const lifecycle = toolLifecycleEvidence(events).complete;
  expect(lifecycle).toBe(true);
  expect(evaluateResultEvidence({ outcome: "conversation.finished", networkSettled: true, ledgerDrained: true, logComplete: true,
    business: true, interaction: { applicable: false }, lifecycle, jobsSettled: browserJobsSettled(events) }))
    .toMatchObject({ classification: "unknown", passed: false, reasons: ["jobs_unknown"] });
});

it("requires canonical terminal evidence for a foreground job that failed", () => {
  const owner = { conversationId: "c", runId: "r", toolCallId: "t" };
  const error = { code: "execution-failed", message: "Known failure", retryable: false };
  const output = { jobId: "j", ok: false, state: "failed", error };
  const failure = { id: 3, type: "tool.failed", ...owner, content: { toolName: "execute_program" }, output, error };
  const job = { id: 4, type: "browser.job.state", ...owner, content: { jobId: "j", state: "failed" }, output: { ok: false, error } };
  expect(browserJobsSettled([failure])).toBeNull();
  expect(browserJobsSettled([failure, job])).toBe(true);
  expect(browserJobsSettled([failure, { ...job, content: { jobId: "j", state: "succeeded" } }])).toBeNull();
  expect(browserJobsSettled([failure, { ...job, output: { ok: false, error: { ...error, code: "different" } } }])).toBeNull();
  expect(browserJobsSettled([{ ...failure, error: { ...error, message: "different" } }, job])).toBeNull();
  expect(browserJobsSettled([failure, { ...job, toolCallId: "other" }])).toBeNull();
  expect(browserJobsSettled([failure, { ...job, conversationId: "other" }])).toBeNull();
  expect(browserJobsSettled([{ ...failure, output: { ...output, jobId: 7 } }, job])).toBeNull();
  expect(browserJobsSettled([{ ...failure, output: { ...output, state: "succeeded" } }, job])).toBeNull();
  expect(browserJobsSettled([{ ...failure, output: { ok: false, state: "failed", error } }])).toBeNull();
  expect(browserJobsSettled([{ ...failure, content: undefined }, job])).toBeNull();
  expect(browserJobsSettled([{ ...failure, output: { ...output, envelopeWrapped: true, result: { jobId: "other" } } }, job])).toBeNull();
  // A failure before job creation can still have a known outcome.
  expect(browserJobsSettled([{ ...failure, output: { ok: false, error } }])).toBe(true);
  const encoded = { ...failure, valueEncoding: 5, content: toLogValue(failure.content, undefined, 5), output: toLogValue(output, undefined, 5), error: toLogValue(error, undefined, 5) };
  expect(browserJobsSettled([encoded])).toBeNull();
  expect(browserJobsSettled([encoded, job])).toBe(true);
  const events = [
    { id: 1, type: "conversation.message", conversationId: "c", runId: "r", content: { id: "m", role: "assistant", parts: [{ type: "tool-execute_program", toolCallId: "t" }] } },
    { id: 2, type: "tool.started", ...owner }, failure,
  ];
  const lifecycle = toolLifecycleEvidence(events).complete;
  expect(lifecycle).toBe(true);
  expect(evaluateResultEvidence({ outcome: "conversation.finished", networkSettled: true, ledgerDrained: true, logComplete: true,
    business: true, interaction: { applicable: false }, lifecycle, jobsSettled: browserJobsSettled(events) }))
    .toMatchObject({ classification: "unknown", passed: false, reasons: ["jobs_unknown"] });
});

it("correlates compressed failed job results without confusing pre-dispatch errors", () => {
  const owner = { conversationId: "c", runId: "r", toolCallId: "t" };
  const error = { code: "execution-failed", message: "Known failure" };
  const tool = { id: 5, type: "tool.failed", ...owner, content: { toolName: "execute_program" }, output: { ok: false, error, $ref: 2 }, error };
  const artifact = { id: 2, type: "tool.result.data", ...owner, content: { bytes: 9000 }, output: { jobId: "j", ok: false, state: "failed", error } };
  const job = { id: 4, type: "browser.job.state", ...owner, content: { jobId: "j", state: "failed" }, output: { ok: false, error } };
  expect(browserJobsSettled([tool])).toBeNull();
  expect(browserJobsSettled([tool, artifact])).toBeNull();
  expect(browserJobsSettled([tool, artifact, job])).toBe(true);
  expect(browserJobsSettled([tool, { ...artifact, runId: "other" }, job])).toBeNull();
  const graph = { ...artifact, output: null, artifactGraph: { version: 1, key: "parts", root: [1, 0] } };
  expect(browserJobsSettled([tool, graph, job])).toBe(true);
  expect(browserJobsSettled([tool, graph])).toBeNull();
  expect(browserJobsSettled([tool, graph, job, { ...job, id: 6, content: { jobId: "other", state: "failed" } }])).toBeNull();
  expect(browserJobsSettled([tool, graph, { ...job, content: { jobId: "j", state: "succeeded" } }])).toBeNull();
  expect(browserJobsSettled([tool, graph, { ...job, output: { ok: false, error: { ...error, message: "different" } } }])).toBeNull();
});
