import { describe, expect, it } from "vitest";
import { gradeViteFacts, viteOracle } from "../e2e/public-web/vite-oracle";
import type { FrozenSource } from "../e2e/public-web/sources";

const versions = ["5.4.0", "6.0.0", "7.0.0"];
const ranges = ["^18.0.0 || >=20.0.0", "^18.0.0 || ^20.0.0 || >=22.0.0", "^20.19.0 || >=22.12.0"];
const deps = [["^0.21.3", "^4.13.0"], ["^0.24.0", "^4.23.0"], ["^0.25.0", "^4.40.0"]];
const sources: FrozenSource[] = versions.map((version, i) => ({ url: `https://registry.npmjs.org/vite/${version}`, finalUrl: "", status: 200, fetchedAt: "", sha256: "", body: JSON.stringify({ version, engines: { node: ranges[i] }, dependencies: { esbuild: deps[i][0], rollup: deps[i][1] } }) }));

describe("Vite oracle", () => {
  it("rejects missing or changed source data", () => {
    expect(() => viteOracle(sources.slice(1))).toThrow();
    expect(() => viteOracle([{ ...sources[0], body: "{}" }, ...sources.slice(1)])).toThrow();
  });
  it("rejects empty, omitted, incorrect and fabricated source answers", () => {
    const oracle = viteOracle(sources);
    const valid = { highest_matching_candidate: "6.0.0", candidates: oracle.map(item => ({ ...item, sources: [`https://github.com/vitejs/vite/blob/v${item.vite_version}/packages/vite/package.json`] })) };
    expect(gradeViteFacts(valid, oracle)).toBe(true);
    expect(gradeViteFacts({ ...valid, candidates: valid.candidates.map(item => ({ ...item, sources: item.sources.map(url => url.replace("https://github.com/vitejs/vite/blob/", "https://raw.githubusercontent.com/vitejs/vite/")) })) }, oracle)).toBe(true);
    expect(gradeViteFacts({}, oracle)).toBe(false);
    expect(gradeViteFacts({ ...valid, candidates: valid.candidates.slice(1) }, oracle)).toBe(false);
    expect(gradeViteFacts({ ...valid, highest_matching_candidate: "7.0.0" }, oracle)).toBe(false);
    expect(gradeViteFacts({ ...valid, candidates: valid.candidates.map(item => ({ ...item, sources: ["https://example.com"] })) }, oracle)).toBe(false);
  });
});

import { canonicalUrl, finalAnswer, snapshotEvidence } from "../e2e/public-web/evidence";

it("accepts browser snapshot evidence only from actual completed tool outputs", () => {
  const snapshot = { url: "https://example.org/source/", observationId: "obs", items: [{ text: "source" }] };
  const events = [
    { id: 1, type: "conversation.message", content: { id: "a", role: "assistant", parts: [{ type: "text", text: JSON.stringify(snapshot) }] } },
    { id: 2, type: "tool.started", content: snapshot },
    { id: 3, type: "tool.failed", output: snapshot },
    { id: 4, type: "tool.finished", content: {toolName: "navigate"}, output: { pageSnapshot: snapshot } },
    { id: 5, type: "tool.finished", content: {toolName: "execute_program"}, output: { result: { pageSnapshot: snapshot } } },
  ] as any;
  expect(snapshotEvidence(events)).toEqual([{ eventId: 4, url: snapshot.url, observationId: "obs", itemCount: 1, partial: false, text: JSON.stringify(snapshot.items), tabId: null, at: NaN }]);
  expect(canonicalUrl("https://example.org/source/#section")).toBe("https://example.org/source");
  expect(canonicalUrl("https://example.org/source?version=1")).not.toBe(canonicalUrl("https://example.org/source?version=2"));
});

it("does not grade an earlier correct draft when the last assistant message has no valid JSON", () => {
  const events = [
    { id: 1, type: "conversation.message", content: { id: "a", role: "assistant", parts: [{ type: "text", text: '```json\n{"results":[]}\n```' }] } },
    { id: 2, type: "conversation.message", content: { id: "b", role: "assistant", parts: [{ type: "text", text: "Unable to verify" }] } },
  ] as any;
  expect(finalAnswer(events)).toEqual({ text: "Unable to verify", value: null });
});

import { verifyBrowsing } from "../e2e/public-web/evidence";
it("requires relevant visible facts and honors newer navigation failures and language equivalence", () => {
  const url = "https://developer.chrome.com/docs/extensions/reference/api/userScripts";
  const docs = [{ url, status: 200, at: "2026-11-12T00:00:00.000Z", duringTask: false, pageId: 1, tabId: 1 }];
  const snapshots = [{ eventId: 4, url: url + "?hl=en", observationId: "obs", itemCount: 1, partial: false, text: "execute 135", tabId: 1, at: Date.parse(docs[0].at) + 1000 }];
  const required = [{ url, terms: ["execute", "135"] }];
  expect(verifyBrowsing(required, docs, snapshots).complete).toBe(true);
  expect(verifyBrowsing(required, docs, [{ ...snapshots[0], partial: true }]).complete).toBe(false);
  expect(verifyBrowsing(required, docs, [{ ...snapshots[0], tabId: 2 }]).complete).toBe(false);
  expect(verifyBrowsing(required, docs, [{ ...snapshots[0], text: "unrelated" }]).complete).toBe(false);
  const blocked = verifyBrowsing(required, [...docs, { ...docs[0], status: 403, duringTask: true, at: "2026-11-12T00:00:02.000Z" }], snapshots);
  expect(blocked).toMatchObject({ complete: false, blocked: true });
  expect(verifyBrowsing(required, [], [], [{ url: url + "?hl=en", status: 200, text: "execute 135" }])).toMatchObject({ complete: true, blocked: false });
  expect(verifyBrowsing(required, [], [], [{ url: "https://example.org", status: 200, text: "execute 135" }]).complete).toBe(false);
});

import { nobelOracle, gradeNobel } from "../e2e/public-web/nobel-oracle";
it("rejects incomplete Nobel sources, missing co-laureates, duplicates and rounded near-miss shares", () => {
  expect(() => nobelOracle({ body: '{"nobelPrizes":[]}' } as FrozenSource)).toThrow("incomplete");
  const expected = [[{ year: 2001, share: "1/2", names: ["A"], co: [["B"]], source_url: "https://www.nobelprize.org/prizes/chemistry/2001/summary/" }]];
  const award = { year: 2001, share: "2/4", co_laureates: ["B"], source_url: expected[0][0].source_url };
  const result = { name: "A", awards: [award] };
  expect(gradeNobel({ results: [result] }, expected)).toBe(true);
  for (const bad of [{ ...award, share: "9007199254740993/18014398509481984" }, { ...award, co_laureates: [] }])
    expect(gradeNobel({ results: [{ ...result, awards: [bad] }] }, expected)).toBe(false);
  expect(gradeNobel({ results: [result, result] }, expected)).toBe(false);
  expect(gradeNobel({ results: [] }, expected)).toBe(false);
});

import { httpEvidence, settledReadJobs } from "../e2e/public-web/http-evidence";
import { partitionArtifact } from "../src/artifact-graph";
it("requires native response ownership and actual artifact delivery, including partitioned sources", async () => {
  const url = "https://raw.githubusercontent.com/vitejs/vite/v5.4.0/packages/vite/package.json";
  const body = "verified public facts " + "x".repeat(9000);
  const base = { timestamp: "2026-11-12T00:00:00.000Z", conversationId: "c", runId: "r", toolCallId: "request" };
  const { graph, parts } = partitionArtifact({ result: { url, status: 200, body } });
  const artifact = { ...base, id: 100, type: "tool.result.data", content: {}, artifactGraph: graph, valueEncoding: 5 };
  const request = { ...base, id: 101, type: "tool.finished", content: { toolName: "send_extension_request" }, input: { url }, output: { ok: true, $ref: 100 } };
  const delivered = body.slice(0, 40);
  const read = { ...base, id: 102, toolCallId: "read", type: "tool.finished", content: { toolName: "read_artifact" }, input: { artifactId: 100, path: ["result", "body"] }, output: { ok: true, result: delivered, partial: true, sourceAccess: { artifactId: 100, path: ["result", "body"] } } };
  const events = [...parts.map((part, index) => ({ ...base, id: index + 1, type: "artifact.part", artifactPart: { ...part, key: graph.key, owner: "c" }, output: part.value })), artifact, request, read] as any;
  expect(await httpEvidence(events)).toEqual([{ eventId: 101, url, status: 200, text: delivered }]);
  expect(await httpEvidence(events.slice(0, -1))).toEqual([]);
  expect(await httpEvidence(events.map((event: any) => event.id === 100 ? { ...event, toolCallId: "unrelated" } : event))).toEqual([]);
  expect(await httpEvidence([{ ...request, content: { toolName: "execute_program" }, output: { ok: true, result: { url, status: 200, body } } }] as any)).toEqual([]);
});

it("accepts settled interrupted reads, rejects active jobs and refuses missing job ownership", () => {
  const base = { timestamp: "2026-11-12T00:00:00.000Z", conversationId: "c", runId: "r", toolCallId: "call" };
  const state = { ...base, id: 1, type: "browser.job.state", content: { jobId: "j", state: "running" } };
  const tool = { ...base, id: 3, type: "tool.failed", content: { toolName: "read_text" }, output: { ok: false, jobId: "j" } };
  expect(settledReadJobs([state, tool] as any)).toBe(false);
  expect(settledReadJobs([state, { ...state, id: 2, content: { jobId: "j", state: "interrupted" } }, tool] as any)).toBe(true);
  expect(settledReadJobs([tool] as any)).toBe(null);
  expect(settledReadJobs([{ ...tool, type: "tool.finished", content: { toolName: "send_extension_request" }, output: { ok: true, result: {} } }] as any)).toBe(null);
  expect(settledReadJobs([state, { ...state, id: 2, content: { jobId: "j", state: "succeeded" } }, { ...tool, toolCallId: "observer", content: { toolName: "get_job" } }] as any)).toBe(true);
});

import { finalizePublicEvidence, pollPublicEvidence } from "../e2e/public-web/evidence";

describe("final canonical observation", () => {
  const startedAt = Date.parse("2026-01-01T00:00:00.000Z"), deadlineAt = startedAt + 1000;
  const submission = { id: 1, type: "conversation.submitted", conversationId: "c", runId: "r", timestamp: new Date(startedAt).toISOString() };
  const terminal = { id: 3, type: "conversation.finished", conversationId: "c", runId: "r", timestamp: new Date(startedAt + 500).toISOString() };
  const unknown = { id: 2, type: "tool.failed", conversationId: "c", runId: "r", toolCallId: "t", content: { toolName: "navigate", effectUnknown: true }, output: { ok: false } };
  const run = async (changes: Record<string, unknown> = {}) => {
    let raw: unknown;
    const result = await finalizePublicEvidence({ prior: [submission] as any, hasObservation: true, read: async () => [submission, unknown, terminal] as any,
      persist: async events => { raw = structuredClone(events); }, startedAt, deadlineAt, outcome: "setup_failed", reason: "poll failed", runError: "poll failed", deadlineExpired: false,
      required: () => [], documents: [], navigationFailures: [], grade: () => true, redact: error => error instanceof Error ? error.message : String(error), ...changes });
    return { ...result, raw };
  };
  it("retains the poll error while reporting the final terminal and unknown effect from the saved events", async () => {
    let prior: any[] = [];
    let pollError: string | null = null;
    try { await pollPublicEvidence(async () => { throw new Error("poll failed"); }, Date.now(), Date.now() + 1000, events => { prior = events; }); }
    catch (error) { pollError = (error as Error).message; }
    const result = await run({ prior, hasObservation: false, runError: pollError, reason: pollError });
    expect(result.raw).toEqual(result.events);
    expect(result.events).toContainEqual(terminal);
    expect(result.capture).toEqual({ status: "succeeded", error: null, hasObservation: true });
    expect(result.outcome).toBe("setup_failed");
    expect(result.reason).toBe("poll failed");
    expect(result.derived?.effectCertainty).toBeNull();
    expect(result.derived?.lifecycle).toEqual((await import("../e2e/evaluation/tool-lifecycle")).toolLifecycleEvidence(result.raw as any));
  });
  it("retains the previous observation and marks failed final capture incomplete", async () => {
    const result = await run({ read: async () => { throw new Error("read failed"); }, runError: null, reason: "", outcome: "setup_failed" });
    expect(result.raw).toEqual([submission]);
    expect(result.events).toEqual(result.raw);
    expect(result.capture).toEqual({ status: "failed", error: "read failed", hasObservation: true });
    expect(result.derived?.effectCertainty).toBeNull();
    expect(result.outcome).toBe("setup_failed");
  });
  it.each(["timed_out", "failed"] as const)("does not upgrade %s after a late final read", async outcome => {
    const result = await run({ outcome, reason: "original", runError: null, deadlineExpired: outcome === "timed_out", read: async () => [submission, terminal] });
    expect(result.outcome).toBe(outcome);
    expect(result.outcome).not.toBe("passed");
  });
  it("preserves raw events and the original error when evidence derivation throws", async () => {
    const result = await run({ required: () => { throw new Error("derivation failed"); } });
    expect(result.raw).toEqual(result.events);
    expect(result.reason).toBe("poll failed");
    expect(result.derivationError).toBe("derivation failed");
    expect(result.capture.status).toBe("succeeded");
  });
});

