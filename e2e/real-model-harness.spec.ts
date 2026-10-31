import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test, commandResponse, delayedResponse, textResponse, startProvider, closeServer, type MockResponse } from "./fixtures";
import { aggregateSuiteReports, createSuiteManifest } from "./evaluation/suite-manifest";

async function runHarness(baseURL: string, directory: string, scenario = "cross-frame-order", timeoutMs = 90_000, extraEnv: Record<string, string> = {}) {
  return promisify(execFile)(process.execPath, [resolve("node_modules/@playwright/test/cli.js"), "test", "e2e/real-model-evaluation.spec.ts", "--retries=0", "--reporter=line", "--trace=off", `--output=${resolve(directory, "playwright")}`], {
    timeout: 100_000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, SURFWAX_REAL_MODEL_EVAL: "1", SURFWAX_EVAL_PROVIDER: "local-mock", SURFWAX_EVAL_MODEL: "test-model",
      SURFWAX_EVAL_BASE_URL: baseURL, SURFWAX_EVAL_API_KEY: "local-test-secret", SURFWAX_EVAL_SCENARIO: scenario,
      SURFWAX_EVAL_SEED: "17", SURFWAX_EVAL_TIMEOUT_MS: String(timeoutMs), SURFWAX_EVAL_REPORT_DIR: resolve(directory, "reports"),
      SURFWAX_EVIDENCE_PATH: resolve(directory, "evidence"), ...extraEnv },
  });
}

async function readReport(directory: string) {
  const reports = await readdir(resolve(directory, "reports"));
  expect(reports).toHaveLength(1);
  const json = await readFile(resolve(directory, "reports", reports[0]!), "utf8");
  expect(json).not.toContain("local-test-secret");
  return JSON.parse(json);
}

// End-to-end harness contract using a local fake provider: never a model score.
test("real-model entry records a successful local scripted run", async () => {
  test.setTimeout(120_000);
  const provider = await startProvider([
    commandResponse("execute_program", { code: `
      const desk = page.frameLocator('iframe[title="Checkout"]');
      await desk.getByLabel('Order reference').fill('ORDER-17');
      await desk.getByLabel('Service').selectOption('express');
      await desk.getByLabel('Confirm details').check();
      await desk.getByRole('button', {name:'Submit order'}).click();
      return 'done';`, timeoutMs: 30_000 }, "local-order"),
    textResponse("Done"), textResponse("Order"),
  ]);
  const directory = await mkdtemp(resolve(tmpdir(), "surfwax-eval-harness-"));
  try {
    await runHarness(provider.baseURL, directory);
    const report = await readReport(directory);
    expect(report).toMatchObject({ scenario: "cross-frame-order", seed: 17, provider: "local-mock", outcome: "conversation.finished",
      businessVerified: true, networkSettled: true, toolsWithExactlyOneTerminal: true, toolLifecycle: { complete: true } });
    expect(report.toolCalls).toBeGreaterThan(0);
    expect(report.serverActivity.active).toBe(0);
    expect(report.completedProgramOperations["page.frameLocator.getByRole.click"]).toBeGreaterThan(0);
  } finally {
    await closeServer(provider.server);
    await rm(directory, { recursive: true, force: true });
  }
});

test("real-model entry accepts recovery after the intentional response interruption", async () => {
  test.setTimeout(120_000);
  const reference = `TX-17-${(Math.imul(17, 7919) >>> 0).toString(36).toUpperCase()}`;
  const provider = await startProvider([
    commandResponse("execute_program", { code: `
      const desk = page.frameLocator('iframe[title="Transaction desk"]');
      await desk.getByLabel('Transaction reference').fill(${JSON.stringify(reference)});
      await desk.getByRole('button', {name:'Submit transaction'}).click();
      await desk.locator('#status').filter({hasText:'Confirmation unavailable'}).waitFor();
      await desk.getByRole('button', {name:'Check status'}).click();
      await desk.locator('#status').filter({hasText:${JSON.stringify(`Completed ${reference}`)}}).waitFor();
      return 'done';`, timeoutMs: 30_000 }, "local-recovery"),
    textResponse("Done"), textResponse("Transaction"),
  ]);
  const directory = await mkdtemp(resolve(tmpdir(), "surfwax-eval-harness-"));
  try {
    await runHarness(provider.baseURL, directory, "uncertain-write");
    const report = await readReport(directory);
    expect(report).toMatchObject({ scenario: "uncertain-write", outcome: "conversation.finished", businessVerified: true,
      networkSettled: true, toolsWithExactlyOneTerminal: true, serverActivity: { active: 0 } });
    expect(report.serverActivity.interrupted).toBeGreaterThan(0);
  } finally {
    await closeServer(provider.server);
    await rm(directory, { recursive: true, force: true });
  }
});

for (const scenario of [
  { name: "window-transfer", code: `
    const launcher = page.frameLocator('iframe[title="Window launcher"]');
    const waiting = page.waitForEvent('popup');
    await launcher.getByRole('button', {name:'Open source window'}).click();
    const source = await waiting;
    await launcher.getByRole('button', {name:'Open destination window'}).click();
    let tab; for (let i = 0; i < 100; i++) { tab = (await browser.tabs.list()).find(item => item.url && item.url.includes('/window/destination')); if (tab) break; await sleep(50); }
    if (!tab) throw new Error('Destination window missing');
    const destination = await browser.page(tab.id);
    await destination.getByLabel('Transfer code').fill(await source.locator('strong').textContent());
    await destination.getByRole('button', {name:'Submit transfer'}).click(); return 'done';` },
  { name: "long-manifest", code: `
    const desk = page.frameLocator('iframe[title="Manifest desk"]'), current = desk.locator('#page'), pages = [];
    await current.filter({hasText:'Page 1 of 20'}).waitFor();
    for (let index = 1; index <= 20; index++) {
      pages.push(await desk.getByRole('list', {name:'Tracking codes'}).innerText());
      if (index < 20) { await desk.getByRole('button', {name:'Next page'}).click(); await current.filter({hasText:'Page ' + (index + 1) + ' of 20'}).waitFor(); }
    }
    await desk.getByLabel('Complete manifest').fill(pages.join('\\n'));
    await desk.getByRole('button', {name:'Submit manifest'}).click(); return 'done';` },
  { name: "rolling-queue", code: `
    const queue = page.frameLocator('iframe[title="Rolling queue"]'), progress = queue.locator('#progress');
    await progress.filter({hasText:'Completed 0 of 30'}).waitFor();
    for (let index = 1; index <= 30; index++) {
      await queue.getByRole('row').filter({hasText:'Next'}).getByRole('button', {name:'Process'}).click();
      await progress.filter({hasText: index === 30 ? 'Queue complete' : 'Completed ' + index + ' of 30'}).waitFor();
    }
    return 'done';` },
  { name: "chooser-prompt", code: `
    const desk = page.frameLocator('iframe[title="Intake desk"]');
    const name = await desk.locator('#filename').textContent(), text = await desk.locator('#contents').textContent();
    const answer = await desk.locator('#answer').textContent();
    const waiting = page.waitForEvent('filechooser');
    const action = desk.getByRole('button', {name:'Choose receipt'}).click();
    const chooser = await waiting;
    const dialogWait = page.waitForEvent('dialog');
    const upload = chooser.setFiles([{name, text}]);
    const dialog = await dialogWait; await dialog.accept(answer);
    await upload; await action; return 'done';` },
  { name: "network-identity", code: `
    const desk = page.frameLocator('iframe[title="Response desk"]');
    await desk.getByRole('button', {name:'Run requests'}).count();
    await net.requests({limit:100});
    await desk.getByRole('button', {name:'Run requests'}).click();
    await desk.locator('#state').filter({hasText:'Responses ready'}).waitFor();
    const captured = await net.requests({limit:100});
    if (captured.integrity !== 'complete' || captured.hasMore !== false) throw new Error('Network history is incomplete');
    const refs = captured.requests.filter(item => item.method === 'POST' && item.url.endsWith('/sample'));
    if (refs.length !== 6 || new Set(refs.map(item => item.requestRef)).size !== 6) throw new Error('Expected six distinct requests');
    const values = {};
    for (const entry of refs) {
      const body = await net.responseBody(entry.requestRef);
      if (typeof body !== 'string') throw new Error('Response unavailable');
      const response = JSON.parse(body);
      if (typeof response.name !== 'string' || typeof response.code !== 'string' || values[response.name]) throw new Error('Invalid response');
      values[response.name] = response.code;
    }
    for (const [name, code] of Object.entries(values)) await desk.getByLabel(name + ' code', {exact:true}).fill(code);
    await desk.getByRole('button', {name:'Submit codes'}).click(); return 'done';` },
  { name: "binary-transfer", code: `
    const source = page.frameLocator('iframe[title="Source"]');
    const destination = page.frameLocator('iframe[title="Destination"]');
    await source.getByRole('button', {name:'Generate file'}).click();
    await source.locator('#status').filter({hasText:'Ready'}).waitFor();
    const file = source.locator('#file');
    const name = await file.getAttribute('download');
    const bytes = await file.evaluate(async anchor => new Uint8Array(await (await fetch(anchor.href)).arrayBuffer()));
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    const waiting = page.waitForEvent('filechooser');
    const click = destination.getByRole('button', {name:'Choose file'}).click();
    const chooser = await waiting;
    await chooser.setFiles([{name, base64:btoa(binary)}]);
    await click;
    await destination.locator('#chosen').filter({hasText:name}).waitFor();
    await destination.getByRole('button', {name:'Submit file'}).click();
    return 'done';` },
  { name: "frame-replacement", code: `
    const progress = page.locator('#progress');
    await progress.filter({hasText:'Completed 0 of 12'}).waitFor();
    for (let index = 1; index <= 12; index++) {
      await page.frameLocator('section[data-next="true"] iframe[title="Work item"]').getByRole('button', {name:'Confirm', exact:true}).click();
      await progress.filter({hasText: index === 12 ? 'Queue complete' : 'Completed ' + index + ' of 12'}).waitFor();
    }
    return 'done';` },
  { name: "userscript-repair", code: `
    const script = await browser.scripts.read('record-stamp');
    if (script.enabled) throw new Error('Expected a disabled script');
    await browser.scripts.edit('record-stamp', {allFrames:true, js:[{code:"document.documentElement.dataset.stamp = document.body.dataset.expectedStamp;"}]});
    await browser.scripts.setEnabled('record-stamp', true);
    const frame = page.frameLocator('iframe[title="Record"]');
    for (const name of ['Atlas','Birch','Coral','Drift','Elm','Finch','Grove','Harbor']) {
      await page.getByRole('button', {name:'Open ' + name, exact:true}).click();
      await frame.getByRole('heading', {name:name + ' record', exact:true}).waitFor();
      await frame.locator('#stamp').filter({hasText:'Ready'}).waitFor();
    }
    await page.getByRole('button', {name:'Submit records'}).click();
    return 'done';` },
]) test(`real-model entry grades the local scripted ${scenario.name} level`, async () => {
  test.setTimeout(120_000);
  const responses: MockResponse[] = [];
  let jobId = "", polls = 0;
  let lastToolResult: unknown;
  const afterTool: MockResponse = (request) => {
    const message = request.messages.findLast((entry: any) => entry.role === "tool");
    if (!message) { responses.unshift(afterTool); return textResponse("Title"); }
    const result = JSON.parse(message.content);
    lastToolResult = result;
    if (result.accepted && result.complete === false || result.terminal === false) {
      jobId = result.jobId ?? jobId;
      responses.unshift(afterTool);
      return commandResponse("get_job", { jobId, after: result.nextCursor, waitMs: 10_000 }, `local-poll-${++polls}`);
    }
    return textResponse("Done");
  };
  responses.push(commandResponse("execute_program", { code: scenario.code, timeoutMs: 60_000 }, "local-level"), afterTool, textResponse("Title"));
  const provider = await startProvider(responses);
  const directory = await mkdtemp(resolve(tmpdir(), "surfwax-eval-harness-"));
  try {
    const manifest = ["network-identity", "userscript-repair"].includes(scenario.name) ? createSuiteManifest({ version: 1, provider: "local-mock", model: "test-model",
      scenarios: [scenario.name], seeds: [17], repeats: 1, timeoutMs: 90_000 }) : null;
    const sample = manifest?.samples[0];
    const suiteEnv: Record<string, string> = manifest && sample ? { SURFWAX_EVAL_SUITE_PLAN_HASH: manifest.planHash, SURFWAX_EVAL_SUITE_SAMPLE_ID: sample.id,
      SURFWAX_EVAL_SUITE_REPEAT: String(sample.repeat) } : {};
    try {
      await runHarness(provider.baseURL, directory, scenario.name, 90_000, suiteEnv);
    } catch (error) {
      const failedReport = await readReport(directory).catch(() => null);
      throw new Error(`Harness failed: ${JSON.stringify(failedReport)}\nTool result: ${JSON.stringify(lastToolResult)}\n${(error as { stdout?: string }).stdout ?? ""}`, { cause: error });
    }
    const report = await readReport(directory);
    expect(report).toMatchObject({ scenario: scenario.name, outcome: "conversation.finished", businessVerified: true,
      networkSettled: true, toolsWithExactlyOneTerminal: true });
    if (scenario.name === "rolling-queue") expect(report).toMatchObject({ interactionApplicable: true, interactionVerified: true, classification: "passed" });
    if (scenario.name === "frame-replacement") expect(report).toMatchObject({ interactionApplicable: true, interactionVerified: true, classification: "passed" });
    if (scenario.name === "userscript-repair") {
      expect(report).toMatchObject({ scriptExecutionVerified: true, scriptJobsSettled: true });
      expect(report.completedProgramOperations["scripts.edit"]).toBeGreaterThan(0);
      expect(report.completedProgramOperations["scripts.setEnabled"]).toBeGreaterThan(0);
      expect(aggregateSuiteReports(manifest!, [{ sampleId: sample!.id, planHash: manifest!.planHash, report }]).counts.passed).toBe(1);
    }
    if (scenario.name === "network-identity") {
      expect(report.completedProgramOperations["net.responseBody"]).toBe(6);
      expect(report.extensionBuild).toMatchObject({ sha256: expect.stringMatching(/^[a-f0-9]{64}$/), files: expect.any(Number), manifestVersion: 3 });
      expect(report.extensionBuildStable).toBe(true);
      expect(report.evaluationSource).toMatchObject({ sha256: expect.stringMatching(/^[a-f0-9]{64}$/), files: expect.any(Number) });
      expect(report.evaluationSourceStable).toBe(true);
      expect(report.lockfileSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(report.deadlineState).toBe("on_time");
      expect(report.taskDeadlineAt - report.taskStartedAt).toBe(90_000);
      expect(Date.parse(report.terminalTimestamp)).toBeGreaterThanOrEqual(report.taskStartedAt);
      expect(Date.parse(report.terminalTimestamp)).toBeLessThanOrEqual(report.taskDeadlineAt);
      const summary = aggregateSuiteReports(manifest!, [{ sampleId: sample!.id, planHash: manifest!.planHash, report }]);
      expect(summary.counts).toEqual({ total: 1, passed: 1, failed: 0, unknown: 0, timedOut: 0, missing: 0 });
      expect(summary.environment).toMatchObject({ unknownSamples: 0, unstableSamples: 0,
        groups: [{ extensionBuildSha256: report.extensionBuild.sha256, lockfileSha256: report.lockfileSha256, browser: report.browser, sampleIds: [sample!.id] }] });
    }
  } finally {
    await closeServer(provider.server);
    await rm(directory, { recursive: true, force: true });
  }
});

test("a no-op registered script cannot pass by writing stamps directly into the task pages", async () => {
  test.setTimeout(120_000);
  const responses: MockResponse[] = [];
  let jobId = "", polls = 0;
  const afterTool: MockResponse = (request) => {
    const message = request.messages.findLast((entry: any) => entry.role === "tool");
    if (!message) { responses.unshift(afterTool); return textResponse("Title"); }
    const result = JSON.parse(message.content);
    if (result.accepted && result.complete === false || result.terminal === false) {
      jobId = result.jobId ?? jobId; responses.unshift(afterTool);
      return commandResponse("get_job", { jobId, after: result.nextCursor, waitMs: 10_000 }, `noop-poll-${++polls}`);
    }
    return textResponse("Done");
  };
  responses.push(commandResponse("execute_program", { timeoutMs: 60_000, code: `
    await browser.scripts.edit('record-stamp', {allFrames:true, js:[{code:'void 0'}]});
    await browser.scripts.setEnabled('record-stamp', true);
    const frame = page.frameLocator('iframe[title="Record"]');
    for (const name of ['Atlas','Birch','Coral','Drift','Elm','Finch','Grove','Harbor']) {
      await page.getByRole('button', {name:'Open ' + name, exact:true}).click();
      await frame.getByRole('heading', {name:name + ' record', exact:true}).waitFor();
      await frame.locator('body').evaluate(body => { body.ownerDocument.documentElement.dataset.stamp = body.dataset.expectedStamp; });
      await frame.locator('#stamp').filter({hasText:'Ready'}).waitFor();
    }
    await page.getByRole('button', {name:'Submit records'}).click();
    return 'done';` }, "noop-script"), afterTool, textResponse("Title"));
  const provider = await startProvider(responses);
  const directory = await mkdtemp(resolve(tmpdir(), "surfwax-eval-harness-"));
  try {
    const failure = await runHarness(provider.baseURL, directory, "userscript-repair").then(() => null, (error: unknown) => error);
    expect(failure).toMatchObject({ code: 1 });
    const report = await readReport(directory);
    expect(report).toMatchObject({ outcome: "conversation.finished", classification: "failed", businessVerified: false,
      scriptLedgerVerified: true, scriptJobsSettled: true, scriptExecutionVerified: false, lifecycleVerified: true });
  } finally {
    await closeServer(provider.server);
    await rm(directory, { recursive: true, force: true });
  }
});

test("an unfinished network-identity request remains unknown and is drained at shutdown", async () => {
  test.setTimeout(120_000);
  const provider = await startProvider([
    commandResponse("execute_program", { timeoutMs: 30_000, code: `
      const desk = page.frameLocator('iframe[title="Response desk"]');
      await desk.getByRole('button', {name:'Run requests'}).count();
      await net.requests({limit:100});
      await desk.locator('input').first().evaluate(input => {
        const name = input.name;
        void fetch('/sample', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name})}).catch(() => {});
      });
      for (let index = 0; index < 100; index++) {
        const captured = await net.requests({limit:100});
        if (captured.requests.some(entry => entry.method === 'POST' && entry.url.endsWith('/sample'))) return 'request started';
        await sleep(50);
      }
      throw new Error('Sample request was not observed');`,
    }, "pending-network"), textResponse("Done"), textResponse("Response desk"),
  ]);
  const directory = await mkdtemp(resolve(tmpdir(), "surfwax-eval-harness-"));
  try {
    const failure = await runHarness(provider.baseURL, directory, "network-identity").then(() => null, (error: unknown) => error);
    expect(failure).toMatchObject({ code: 1 });
    const report = await readReport(directory);
    expect(report).toMatchObject({ scenario: "network-identity", outcome: "conversation.finished", classification: "unknown", passed: false,
      networkSettled: false, ledgerDrained: true, businessVerified: null, logComplete: true, lifecycleVerified: true,
      reasons: expect.arrayContaining(["network_unsettled", "business_unknown"]), serverActivity: { active: 0 } });
    expect(report.serverActivity.interrupted).toBeGreaterThan(0);
  } finally {
    await closeServer(provider.server);
    await rm(directory, { recursive: true, force: true });
  }
});

test("real-model entry retains a failed scripted run without tool calls", async () => {
  test.setTimeout(120_000);
  const provider = await startProvider([textResponse("Done"), textResponse("Order")]);
  const directory = await mkdtemp(resolve(tmpdir(), "surfwax-eval-harness-"));
  try {
    const failure = await runHarness(provider.baseURL, directory).then(() => null, (error: unknown) => error);
    expect(failure).toMatchObject({ code: 1 });
    expect(await readReport(directory)).toMatchObject({ outcome: "conversation.finished", businessVerified: false,
      toolsWithExactlyOneTerminal: false, toolLifecycle: { complete: false, started: 0 } });
  } finally {
    await closeServer(provider.server);
    await rm(directory, { recursive: true, force: true });
  }
});

test("a settled incorrect business action is classified as a verified failure", async () => {
  test.setTimeout(120_000);
  const provider = await startProvider([
    commandResponse("execute_program", { code: `
      const desk = page.frameLocator('iframe[title="Checkout"]');
      await desk.getByLabel('Order reference').fill('WRONG');
      await desk.getByRole('button', {name:'Submit order'}).click(); return 'done';`, timeoutMs: 30_000 }, "wrong-order"),
    textResponse("Done"), textResponse("Order"),
  ]);
  const directory = await mkdtemp(resolve(tmpdir(), "surfwax-eval-harness-"));
  try {
    const failure = await runHarness(provider.baseURL, directory).then(() => null, (error: unknown) => error);
    expect(failure).toMatchObject({ code: 1 });
    expect(await readReport(directory)).toMatchObject({ outcome: "conversation.finished", classification: "failed", passed: false,
      businessVerified: false, networkSettled: true, ledgerDrained: true, logComplete: true, lifecycleVerified: true,
      reasons: expect.arrayContaining(["business_incorrect"]) });
  } finally {
    await closeServer(provider.server);
    await rm(directory, { recursive: true, force: true });
  }
});

test("a task timeout retains incomplete tool evidence as unknown", async () => {
  test.setTimeout(120_000);
  const provider = await startProvider([delayedResponse(textResponse("late"), 10_000)]);
  const directory = await mkdtemp(resolve(tmpdir(), "surfwax-eval-harness-"));
  try {
    const failure = await runHarness(provider.baseURL, directory, "cross-frame-order", 1_000).then(() => null, (error: unknown) => error);
    expect(failure).toMatchObject({ code: 1 });
    expect(await readReport(directory)).toMatchObject({ outcome: "timed_out", classification: "unknown", passed: false,
      logComplete: false, lifecycleVerified: null, toolsWithExactlyOneTerminal: null, toolLifecycle: null,
      reasons: expect.arrayContaining(["conversation_outcome_unknown", "lifecycle_unknown"]) });
  } finally {
    await closeServer(provider.server);
    await rm(directory, { recursive: true, force: true });
  }
});

for (const mode of ["unauthorized", "rate-limited", "disconnected"] as const) test(`provider ${mode} remains unknown rather than a tool capability failure`, async () => {
  test.setTimeout(120_000);
  const server = createServer((request, response) => {
    request.resume();
    request.once("end", () => {
      if (mode === "disconnected") request.socket.destroy();
      else response.writeHead(mode === "unauthorized" ? 401 : 429, { "content-type": "application/json" }).end('{"error":{"message":"local simulated failure"}}');
    });
  });
  await new Promise<void>((resolveListen, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolveListen); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing local mock address");
  const directory = await mkdtemp(resolve(tmpdir(), "surfwax-eval-harness-"));
  try {
    const failure = await runHarness(`http://127.0.0.1:${address.port}/v1`, directory, "cross-frame-order", 6_000).then(() => null, (error: unknown) => error);
    expect(failure).toMatchObject({ code: 1 });
    const report = await readReport(directory);
    expect(report).toMatchObject({ classification: "unknown", passed: false, toolCalls: 0 });
    expect(["conversation.failed", "conversation.aborted", "timed_out"]).toContain(report.outcome);
    expect(report.lastAgentResponse).toMatchObject({ status: mode === "unauthorized" ? 401 : mode === "rate-limited" ? 429 : null });
    if (mode === "disconnected") expect(report.lastAgentResponse.complete).toBe(false);
  } finally {
    await closeServer(server);
    await rm(directory, { recursive: true, force: true });
  }
});

test("a browser setup failure preserves unknown business and lifecycle results", async () => {
  test.setTimeout(120_000);
  const provider = await startProvider([]);
  const directory = await mkdtemp(resolve(tmpdir(), "surfwax-eval-harness-"));
  try {
    const failure = await runHarness(provider.baseURL, directory, "cross-frame-order", 90_000, {
      SURFWAX_CHROME_PATH: resolve(directory, "missing-browser"), SURFWAX_CHROME_138_PATH: "",
    }).then(() => null, (error: unknown) => error);
    expect(failure).toMatchObject({ code: 1 });
    expect(await readReport(directory)).toMatchObject({ outcome: "setup_failed", classification: "unknown", passed: false,
      networkSettled: null, ledgerDrained: false, businessVerified: null, logComplete: false, lifecycleVerified: null,
      reasons: expect.arrayContaining(["business_unknown", "lifecycle_unknown", "network_unknown"]) });
  } finally {
    await closeServer(provider.server);
    await rm(directory, { recursive: true, force: true });
  }
});
