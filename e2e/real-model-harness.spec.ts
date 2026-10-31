import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test, commandResponse, textResponse, startProvider, closeServer } from "./fixtures";

async function runHarness(baseURL: string, directory: string, scenario = "cross-frame-order") {
  return promisify(execFile)(process.execPath, [resolve("node_modules/@playwright/test/cli.js"), "test", "e2e/real-model-evaluation.spec.ts", "--retries=0", "--reporter=line", "--trace=off", `--output=${resolve(directory, "playwright")}`], {
    timeout: 100_000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, SURFWAX_REAL_MODEL_EVAL: "1", SURFWAX_EVAL_PROVIDER: "local-mock", SURFWAX_EVAL_MODEL: "test-model",
      SURFWAX_EVAL_BASE_URL: baseURL, SURFWAX_EVAL_API_KEY: "local-test-secret", SURFWAX_EVAL_SCENARIO: scenario,
      SURFWAX_EVAL_SEED: "17", SURFWAX_EVAL_TIMEOUT_MS: "90000", SURFWAX_EVAL_REPORT_DIR: resolve(directory, "reports"),
      SURFWAX_EVIDENCE_PATH: resolve(directory, "evidence") },
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
]) test(`real-model entry grades the local scripted ${scenario.name} level`, async () => {
  test.setTimeout(120_000);
  const provider = await startProvider([commandResponse("execute_program", { code: scenario.code, timeoutMs: 60_000 }, "local-level"), textResponse("Done"), textResponse("Title")]);
  const directory = await mkdtemp(resolve(tmpdir(), "surfwax-eval-harness-"));
  try {
    await runHarness(provider.baseURL, directory, scenario.name);
    expect(await readReport(directory)).toMatchObject({ scenario: scenario.name, outcome: "conversation.finished", businessVerified: true,
      networkSettled: true, toolsWithExactlyOneTerminal: true });
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
