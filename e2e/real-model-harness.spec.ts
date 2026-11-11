import { runEvaluation } from "./evaluation/run-evaluation";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  closeServer,
  commandResponse,
  expect,
  startProvider,
  test,
  textResponse,
  type MockResponse,
} from "./fixtures";

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
    const failure = await runEvaluation({
      upstream: provider.baseURL,
      key: "local-test-secret",
      providerName: "local-mock",
      model: "test-model",
      scenario: "cross-frame-order",
      seed: 17,
      taskTimeoutMs: 20_000,
      suiteIdentity: null,
      extensionDirectory: resolve(process.env.SURFWAX_EXTENSION_PATH!),
      reportDirectory: resolve(directory, "reports"),
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ message: "Evaluation did not complete with the required results; see the report" });
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


test("closes evaluation resources when report persistence fails", async () => {
  const provider = await startProvider([textResponse("Done"), textResponse("Order")]);
  const directory = await mkdtemp(resolve(tmpdir(), "surfwax-eval-cleanup-"));
  const reportDirectory = resolve(directory, "reports");
  const resources = () => process.getActiveResourcesInfo()
    .filter((type) => type === "TCPServerWrap" || type === "ProcessWrap").sort();
  const before = resources();
  try {
    await writeFile(reportDirectory, "not a directory");
    await expect(runEvaluation({
      upstream: provider.baseURL,
      key: "local-test-secret",
      providerName: "local-mock",
      model: "test-model",
      scenario: "cross-frame-order",
      seed: 17,
      taskTimeoutMs: 1,
      suiteIdentity: null,
      extensionDirectory: resolve(process.env.SURFWAX_EXTENSION_PATH!),
      reportDirectory,
    })).rejects.toMatchObject({ code: "EEXIST" });
    await expect.poll(resources).toEqual(before);
  } finally {
    await closeServer(provider.server);
    await rm(directory, { recursive: true, force: true });
  }
});
