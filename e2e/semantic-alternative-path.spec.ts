import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { closeServer, commandResponse, expect, startProvider, test, textResponse, type MockResponse } from "./fixtures";

// A local script establishes the evaluator's scope, not a model success rate.
test("semantic queue accepts locator actions without semantic snapshots", async () => {
  test.setTimeout(120_000);
  const responses: MockResponse[] = [];
  let jobId = "", polls = 0;
  const afterTool: MockResponse = (request) => {
    const message = request.messages.findLast((entry: any) => entry.role === "tool");
    if (!message) { responses.unshift(afterTool); return textResponse("Title"); }
    const result = JSON.parse(message.content);
    if (result.accepted && result.complete === false || result.terminal === false) {
      jobId = result.jobId ?? jobId;
      responses.unshift(afterTool);
      return commandResponse("get_job", { jobId, after: result.nextCursor, waitMs: 10_000 }, `poll-${++polls}`);
    }
    return textResponse("Done");
  };
  responses.push(commandResponse("execute_program", { timeoutMs: 60_000, code: `
    const desk = page.frameLocator('iframe[title="Semantic queue"]');
    const progress = desk.locator('#progress');
    await progress.filter({hasText:'Completed 0 of 12'}).waitFor();
    for (let index = 1; index <= 12; index++) {
      await desk.locator('button').filter({hasText:'Next TASK-'}).click();
      await progress.filter({hasText:index === 12 ? 'Queue complete' : 'Completed ' + index + ' of 12'}).waitFor();
    }
    return 'done';` }, "locator-only"), afterTool, textResponse("Title"));
  const provider = await startProvider(responses);
  const directory = await mkdtemp(resolve(tmpdir(), "surfwax-semantic-alternative-"));
  try {
    const executablePath = test.info().project.use.launchOptions?.executablePath;
    await promisify(execFile)(process.execPath, [resolve("node_modules/@playwright/test/cli.js"), "test", "e2e/real-model-evaluation.spec.ts",
      "--retries=0", "--reporter=line", "--trace=off", `--output=${resolve(directory, "playwright")}`], {
      timeout: 100_000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, SURFWAX_CHROME_138_PATH: "", ...(executablePath ? { SURFWAX_CHROME_PATH: executablePath } : {}),
        SURFWAX_REAL_MODEL_EVAL: "1", SURFWAX_EVAL_PROVIDER: "local-mock", SURFWAX_EVAL_MODEL: "test-model",
        SURFWAX_EVAL_BASE_URL: provider.baseURL, SURFWAX_EVAL_API_KEY: "local-test-secret", SURFWAX_EVAL_SCENARIO: "semantic-delta",
        SURFWAX_EVAL_SEED: "17", SURFWAX_EVAL_TIMEOUT_MS: "90000", SURFWAX_EVAL_REPORT_DIR: resolve(directory, "reports"),
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
