// @vitest-environment node
import { expect, it } from "vitest";
import { browserJobsSettled } from "../../e2e/evaluation/job-evidence";

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
