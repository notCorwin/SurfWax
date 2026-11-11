import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import {
  closeServer,
  commandResponse,
  expect,
  startProvider,
  test,
  textResponse,
  type MockResponse,
} from "./fixtures";

async function runHarness(
  baseURL: string,
  directory: string,
  scenario = "cross-frame-order",
  timeoutMs = 90_000,
  extraEnv: Record<string, string> = {},
  signal?: AbortSignal,
) {
  // The nested evaluator shares the outer test's installed Chrome and dev server.
  const executablePath = test.info().project.use.launchOptions?.executablePath;
  return promisify(execFile)(
    process.execPath,
    [
      resolve("node_modules/@playwright/test/cli.js"),
      "test",
      "e2e/real-model-evaluation.spec.ts",
      "--retries=0",
      "--reporter=line",
      "--trace=off",
      `--output=${resolve(directory, "playwright")}`,
    ],
    {
      signal,
      timeout: timeoutMs + 30_000,
      maxBuffer: 4 * 1024 * 1024,
      env: {
        ...process.env,
        ...(executablePath ? { SURFWAX_CHROME_PATH: executablePath } : {}),
        SURFWAX_REAL_MODEL_EVAL: "1",
        SURFWAX_EVAL_PROVIDER: "local-mock",
        SURFWAX_EVAL_MODEL: "test-model",
        SURFWAX_EVAL_BASE_URL: baseURL,
        SURFWAX_EVAL_API_KEY: "local-test-secret",
        SURFWAX_EVAL_SCENARIO: scenario,
        SURFWAX_EVAL_SEED: "17",
        SURFWAX_EVAL_TIMEOUT_MS: String(timeoutMs),
        SURFWAX_EVAL_REPORT_DIR: resolve(directory, "reports"),
        SURFWAX_EVIDENCE_PATH: resolve(directory, "evidence"),
        ...extraEnv,
      },
    },
  );
}

async function readReport(directory: string) {
  const reports = await readdir(resolve(directory, "reports"));
  expect(reports).toHaveLength(1);
  const json = await readFile(
    resolve(directory, "reports", reports[0]!),
    "utf8",
  );
  expect(json).not.toContain("local-test-secret");
  return JSON.parse(json);
}

test("a completed order with an unfinished background job remains unknown", async () => {
  test.setTimeout(120_000);
  const responses: MockResponse[] = [];
  let accepted: any;
  const afterBackground: MockResponse = (request) => {
    const message = request.messages.findLast(
      (entry: any) => entry.role === "tool",
    );
    if (!message) {
      responses.unshift(afterBackground);
      return textResponse("Order");
    }
    accepted = JSON.parse(message.content);
    return textResponse("Done");
  };
  const frame = { by: "css", value: 'iframe[title="Checkout"]' };
  const target = (by: string, value: string) => ({ by, value, frame });
  const steps = [
    {
      tool: "fill",
      input: { target: target("label", "Order reference"), value: "ORDER-17" },
    },
    {
      tool: "select_option",
      input: { target: target("label", "Service"), value: "express" },
    },
    {
      tool: "check_element",
      input: { target: target("label", "Confirm details") },
    },
    {
      tool: "click",
      input: {
        target: { ...target("role", "button"), name: "Submit order" },
        timeoutMs: 30_000,
      },
    },
    {
      tool: "verify_state",
      input: {
        target: target("css", "#status"),
        textIncludes: "Submitted ORDER-17",
        timeoutMs: 10_000,
      },
    },
  ];
  let index = 0,
    firstJobId = "",
    firstPolls = 0;
  const afterOrder: MockResponse = (request) => {
    const message = request.messages.findLast(
      (entry: any) => entry.role === "tool",
    );
    if (!message) {
      responses.unshift(afterOrder);
      return textResponse("Order");
    }
    const result = JSON.parse(message.content);
    if (
      (result.accepted && result.complete === false) ||
      result.terminal === false
    ) {
      firstJobId = result.jobId ?? firstJobId;
      responses.unshift(afterOrder);
      return commandResponse(
        "get_job",
        { jobId: firstJobId, after: result.nextCursor, waitMs: 10_000 },
        `order-poll-${++firstPolls}`,
      );
    }
    if (!result.ok || result.state !== "succeeded")
      throw new Error(`Order tool failed: ${JSON.stringify(result)}`);
    if (steps[index]!.tool === "verify_state")
      expect(result.result).toMatchObject({ verified: true });
    index++;
    if (index < steps.length) {
      responses.unshift(afterOrder);
      return commandResponse(
        steps[index]!.tool,
        steps[index]!.input,
        `order-${index}`,
      );
    }
    responses.unshift(afterBackground);
    return commandResponse(
      "verify_state",
      {
        target: target("css", "#status"),
        textIncludes: "Never submitted",
        timeoutMs: 60_000,
        background: true,
      },
      "delayed-order",
    );
  };
  responses.push(
    commandResponse(steps[0]!.tool, steps[0]!.input, "order-0"),
    afterOrder,
    textResponse("Order"),
  );
  const provider = await startProvider(responses);
  const directory = await mkdtemp(resolve(tmpdir(), "surfwax-eval-harness-"));
  try {
    const failure = await runHarness(
      provider.baseURL,
      directory,
      "cross-frame-order",
      20_000,
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ code: 1 });
    expect(accepted).toMatchObject({ accepted: true, complete: false });
    expect(await readReport(directory)).toMatchObject({
      outcome: "timed_out",
      classification: "unknown",
      passed: false,
      businessVerified: true,
      lifecycleVerified: null,
      jobsSettled: null,
      reasons: expect.arrayContaining(["jobs_unknown"]),
    });
  } finally {
    await closeServer(provider.server);
    await rm(directory, { recursive: true, force: true });
  }
});
