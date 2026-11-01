import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { closeServer, commandResponse, expect, startProvider, test, textResponse, type MockResponse } from "./fixtures";

// A local script establishes the evaluator's scope, not a model success rate.
test("semantic queue accepts locator actions without semantic snapshots", async () => {
  test.setTimeout(300_000);
  const responses: MockResponse[] = [];
  const frame = { by: "css", value: 'iframe[title="Semantic queue"]' } as const;
  const progress = { by: "css", value: "#progress", frame } as const;
  const afterTool = (next: ReturnType<typeof commandResponse> | ReturnType<typeof textResponse>): MockResponse => {
    const step: MockResponse = (request) => {
      const message = request.messages.findLast((entry: any) => entry.role === "tool");
      if (!message) { responses.unshift(step); return textResponse("Title"); }
      const result = JSON.parse(message.content);
      expect(result.ok).toBe(true);
      if (result.result && typeof result.result === "object" && "verified" in result.result) expect(result.result.verified).toBe(true);
      return next;
    };
    return step;
  };
  responses.push(commandResponse("verify_state", { target: progress, textIncludes: "Completed 0 of 12", timeoutMs: 20_000 }, "initial-progress"));
  for (let index = 1; index <= 12; index++) {
    responses.push(afterTool(commandResponse("click", { target: { by: "role", value: "button", name: "Next TASK-", frame }, timeoutMs: 20_000 }, `click-${index}`)));
    responses.push(afterTool(commandResponse("verify_state", { target: progress, textIncludes: index === 12 ? "Queue complete" : `Completed ${index} of 12`, timeoutMs: 20_000 }, `verify-${index}`)));
  }
  responses.push(afterTool(textResponse("Done")), textResponse("Title"));
  const provider = await startProvider(responses);
  const directory = await mkdtemp(resolve(tmpdir(), "surfwax-semantic-alternative-"));
  try {
    const executablePath = test.info().project.use.launchOptions?.executablePath;
    await promisify(execFile)(process.execPath, [resolve("node_modules/@playwright/test/cli.js"), "test", "e2e/real-model-evaluation.spec.ts",
      "--retries=0", "--reporter=line", "--trace=off", `--output=${resolve(directory, "playwright")}`], {
      timeout: 280_000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, SURFWAX_CHROME_138_PATH: "", ...(executablePath ? { SURFWAX_CHROME_PATH: executablePath } : {}),
        SURFWAX_REAL_MODEL_EVAL: "1", SURFWAX_EVAL_PROVIDER: "local-mock", SURFWAX_EVAL_MODEL: "test-model",
        SURFWAX_EVAL_BASE_URL: provider.baseURL, SURFWAX_EVAL_API_KEY: "local-test-secret", SURFWAX_EVAL_SCENARIO: "semantic-delta",
        SURFWAX_EVAL_SEED: "17", SURFWAX_EVAL_TIMEOUT_MS: "260000", SURFWAX_EVAL_REPORT_DIR: resolve(directory, "reports"),
        SURFWAX_EVIDENCE_PATH: resolve(directory, "evidence") },
    });
    const reports = await readdir(resolve(directory, "reports"));
    expect(reports).toHaveLength(1);
    const report = JSON.parse(await readFile(resolve(directory, "reports", reports[0]!), "utf8"));
    expect(report).toMatchObject({ scenario: "semantic-delta", outcome: "conversation.finished", classification: "passed",
      businessVerified: true, interactionApplicable: true, interactionVerified: true, lifecycleVerified: true, jobsSettled: true });
    expect(report.completedProgramOperations["page.inspect"]).toBeUndefined();
    const clicks = Object.entries(report.completedProgramOperations as Record<string, number>)
      .filter(([operation]) => operation.endsWith(".click")).reduce((sum, [, count]) => sum + count, 0);
    expect(clicks).toBe(12);
  } finally {
    await closeServer(provider.server);
    await rm(directory, { recursive: true, force: true });
  }
});
