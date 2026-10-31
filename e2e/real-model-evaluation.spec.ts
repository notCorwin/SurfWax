import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect } from "@playwright/test";
import { test, openExtension, dispose, configure, readEvents, closeServer } from "./fixtures";
import { modelProxy, usageEvidence } from "./evaluation/model-proxy";
import { businessScore, orderFixture } from "./evaluation/order-fixture";
import { claimsFixture, claimsScore } from "./evaluation/claims-fixture";
import { sequenceFixture, sequenceInteractionScore, sequenceScore } from "./evaluation/sequence-fixture";
import { dispatchFixture, dispatchScore } from "./evaluation/dispatch-fixture";
import { uploadFixture, uploadScore } from "./evaluation/upload-fixture";
import { pointerFixture, pointerInteractionScore, pointerScore } from "./evaluation/pointer-fixture";
import { recoveryFixture, recoveryScore } from "./evaluation/recovery-fixture";
import { multitabFixture, multitabScore } from "./evaluation/multitab-fixture";
import { manifestFixture, manifestScore } from "./evaluation/manifest-fixture";
import { rollingFixture, rollingInteractionScore, rollingScore } from "./evaluation/rolling-fixture";
import { chooserPromptFixture, chooserPromptScore } from "./evaluation/chooser-prompt-fixture";
import { networkFixture, networkScore } from "./evaluation/network-level-fixture";
import { trackFixtureRequests } from "./evaluation/network-quiescence";
import { trackServerResponses, type ServerActivity } from "./evaluation/server-quiescence";
import { waitForEvaluationQuiescence } from "./evaluation/quiescence";
import { completedProgramOperations, toolLifecycleEvidence } from "./evaluation/tool-lifecycle";
import { evaluateResultEvidence } from "./evaluation/result-evidence";
import { deadlineEvidence } from "./evaluation/deadline-evidence";
import { SCENARIOS } from "./evaluation/scenarios";
import { buildFingerprint, fileFingerprint, type BuildFingerprint } from "./evaluation/build-fingerprint";

test.use({ trace: "off", screenshot: "off", video: "off" });

// An explicit opt-in is required: this test may incur provider charges.
test("@real-model browser task", async () => {
  test.skip(process.env.SURFWAX_REAL_MODEL_EVAL !== "1", "Explicit real-model opt-in required");
  const taskTimeoutMs = Number(process.env.SURFWAX_EVAL_TIMEOUT_MS ?? 600_000);
  if (!Number.isSafeInteger(taskTimeoutMs) || taskTimeoutMs <= 0 || taskTimeoutMs > 2_147_423_647) throw new Error("Invalid evaluation timeout");
  // Keep setup, evidence collection and teardown outside the task's time budget.
  test.setTimeout(taskTimeoutMs + 60_000);
  const upstream = process.env.SURFWAX_EVAL_BASE_URL;
  const key = process.env.SURFWAX_EVAL_API_KEY;
  const model = process.env.SURFWAX_EVAL_MODEL;
  const providerName = process.env.SURFWAX_EVAL_PROVIDER;
  if (!upstream || !key || !model || !providerName) throw new Error("Set SURFWAX_EVAL_BASE_URL, SURFWAX_EVAL_API_KEY, SURFWAX_EVAL_MODEL and SURFWAX_EVAL_PROVIDER");
  const seed = Number(process.env.SURFWAX_EVAL_SEED ?? 17);
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 999999) throw new Error("Invalid seed");
  const scenario = process.env.SURFWAX_EVAL_SCENARIO ?? "cross-frame-order";
  if (!(SCENARIOS as readonly string[]).includes(scenario)) throw new Error("Invalid scenario");
  const suitePlanHash = process.env.SURFWAX_EVAL_SUITE_PLAN_HASH;
  const suiteSampleId = process.env.SURFWAX_EVAL_SUITE_SAMPLE_ID;
  const suiteRepeatText = process.env.SURFWAX_EVAL_SUITE_REPEAT;
  let suiteIdentity: { planHash: string; sampleId: string; repeat: number } | null = null;
  if (suitePlanHash !== undefined || suiteSampleId !== undefined || suiteRepeatText !== undefined) {
    const repeat = Number(suiteRepeatText);
    if (!suitePlanHash || !/^[a-f0-9]{64}$/.test(suitePlanHash) || !suiteSampleId || !/^[a-f0-9]{64}$/.test(suiteSampleId)
      || !suiteRepeatText || !/^[1-9]\d*$/.test(suiteRepeatText) || !Number.isSafeInteger(repeat)) throw new Error("Invalid suite sample identity");
    const expectedId = createHash("sha256").update(JSON.stringify([suitePlanHash, scenario, seed, repeat])).digest("hex");
    if (suiteSampleId !== expectedId) throw new Error("Suite sample identity does not match this task");
    suiteIdentity = { planHash: suitePlanHash, sampleId: suiteSampleId, repeat };
  }
  const service = seed % 2 ? "express" : "economy";
  const order = `ORDER-${seed}`;
  const started = Date.now();
  const proxy = await modelProxy(upstream, key);
  let fixture: Awaited<ReturnType<typeof orderFixture>> | Awaited<ReturnType<typeof claimsFixture>> | Awaited<ReturnType<typeof sequenceFixture>> | Awaited<ReturnType<typeof dispatchFixture>> | Awaited<ReturnType<typeof uploadFixture>> | Awaited<ReturnType<typeof pointerFixture>> | Awaited<ReturnType<typeof recoveryFixture>> | Awaited<ReturnType<typeof multitabFixture>> | Awaited<ReturnType<typeof manifestFixture>> | Awaited<ReturnType<typeof rollingFixture>> | Awaited<ReturnType<typeof chooserPromptFixture>> | Awaited<ReturnType<typeof networkFixture>> | undefined;
  let opened: Awaited<ReturnType<typeof openExtension>> | undefined;
  let events: any[] = [], outcome = "setup_failed", business: boolean | null = null, interaction: boolean | null = null;
  const interactionApplicable = scenario === "sequence-editor" || scenario === "pointer-drag" || scenario === "rolling-queue";
  let passed = false, ledgerDrained = false, logComplete = false;
  let networkSettled: boolean | null = null;
  let taskStartedAt: number | null = null, taskDeadlineAt: number | null = null, terminalTimestamp: string | null = null;
  let deadlineState: "pending" | "on_time" | "late" | "unknown" | null = null;
  let tracker: ReturnType<typeof trackFixtureRequests> | undefined;
  let serverTracker: ReturnType<typeof trackServerResponses> | undefined;
  let serverActivity: ServerActivity | null = null;
  let browserProduct: string | null = null;
  const extensionDirectory = resolve(process.env.SURFWAX_EXTENSION_PATH ?? "dist");
  let extensionBuild: BuildFingerprint | null = null, lockfileSha256: string | null = null;
  try {
    let prompt: string;
    let grade: () => boolean;
    let gradeInteraction: (() => boolean) | undefined;
    if (scenario === "network-identity") {
      const network = await networkFixture(seed); fixture = network; prompt = network.prompt;
      grade = () => networkScore(network.evidence());
    } else if (scenario === "chooser-prompt") {
      const chooser = await chooserPromptFixture(seed); fixture = chooser; prompt = chooser.prompt;
      grade = () => chooserPromptScore(chooser.evidence());
    } else if (scenario === "rolling-queue") {
      const queue = await rollingFixture(seed); fixture = queue; prompt = queue.prompt;
      grade = () => rollingScore(queue.evidence());
      gradeInteraction = () => rollingInteractionScore(queue.evidence());
    } else if (scenario === "long-manifest") {
      const manifest = await manifestFixture(seed); fixture = manifest; prompt = manifest.prompt;
      grade = () => manifestScore(manifest.evidence());
    } else if (scenario === "window-transfer") {
      const transfer = await multitabFixture(seed); fixture = transfer; prompt = transfer.prompt;
      grade = () => multitabScore(transfer.evidence());
    } else if (scenario === "uncertain-write") {
      const recovery = await recoveryFixture(seed); fixture = recovery; prompt = recovery.prompt;
      grade = () => recoveryScore(recovery.evidence());
    } else if (scenario === "pointer-drag") {
      const pointer = await pointerFixture(seed); fixture = pointer; prompt = pointer.prompt;
      grade = () => pointerScore(pointer.evidence());
      gradeInteraction = () => pointerInteractionScore(pointer.evidence());
    } else if (scenario === "dossier-upload") {
      const upload = await uploadFixture(seed); fixture = upload; prompt = upload.prompt;
      grade = () => uploadScore(upload.evidence());
    } else if (scenario === "sequence-editor") {
      const sequence = await sequenceFixture(seed); fixture = sequence; prompt = sequence.prompt;
      grade = () => sequenceScore(sequence.evidence());
      gradeInteraction = () => sequenceInteractionScore(sequence.evidence());
    } else if (scenario === "dispatch-review") {
      const dispatch = await dispatchFixture(seed); fixture = dispatch; prompt = dispatch.prompt;
      grade = () => dispatchScore(dispatch.evidence());
    } else if (scenario === "claims-queue") {
      const claims = await claimsFixture(seed); fixture = claims; prompt = claims.prompt;
      grade = () => claimsScore(claims.evidence());
    } else {
      const checkout = await orderFixture(); fixture = checkout;
      prompt = `Submit order ${order} using ${service} service and confirm details.`;
      grade = () => businessScore(checkout.evidence(), order, service);
    }
    serverTracker = trackServerResponses(fixture.server);
    [extensionBuild, lockfileSha256] = await Promise.all([
      buildFingerprint(extensionDirectory).catch(() => null), fileFingerprint(resolve("package-lock.json")).catch(() => null),
    ]);
    opened = await openExtension();
    // The extension handles dialogs; Playwright must not auto-dismiss them.
    opened.context.on("page", (page) => page.on("dialog", () => {}));
    const alternateOrigin = new URL(fixture.origin);
    alternateOrigin.hostname = "localhost";
    tracker = trackFixtureRequests(opened.context, [fixture.origin, alternateOrigin.origin]);
    const target = await opened.context.newPage();
    await target.goto(fixture.origin);
    const frame = target.frames().find((item) => item.url().includes("localhost"));
    if (!frame) throw new Error("Fixture frame missing");
    const options = await configure(opened.context, opened.page, proxy.baseURL);
    await options.getByLabel("Model ID", { exact: true }).fill(model);
    await options.getByLabel("API Key", { exact: true }).fill(proxy.token);
    await options.getByRole("button", { name: "保存配置" }).click();
    await expect.poll(() => options.evaluate(async ({ expectedModel, expectedToken, expectedBaseURL }) => {
      const values = await chrome.storage.local.get("side-agent:model-config");
      const saved = values["side-agent:model-config"] as { profiles?: Record<string, { model?: string; providerSettings?: { apiKey?: string }; baseURL?: string }> } | undefined;
      const profile = saved?.profiles?.custom;
      return profile?.model === expectedModel && profile?.providerSettings?.apiKey === expectedToken && profile?.baseURL === expectedBaseURL;
    }, { expectedModel: model, expectedToken: proxy.token, expectedBaseURL: proxy.baseURL })).toBe(true);
    await options.close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill(prompt);
    taskStartedAt = Date.now();
    taskDeadlineAt = taskStartedAt + taskTimeoutMs;
    await opened.page.getByTestId("composer-input").press("Enter");
    outcome = "running";
    while (Date.now() < taskDeadlineAt) {
      events = await readEvents(opened.page);
      const observed = deadlineEvidence(events, taskStartedAt, taskDeadlineAt);
      if (observed.state !== "pending") break;
      const remaining = Math.min(1000, Math.max(0, taskDeadlineAt - Date.now()));
      await new Promise((resolveWait) => setTimeout(resolveWait, remaining));
    }
    // An unsettled network may still contain a submission or decoy request.
    const quiet = await waitForEvaluationQuiescence(tracker, serverTracker, 500, 5000);
    networkSettled = quiet.settled;
    events = await readEvents(opened.page);
    const observed = deadlineEvidence(events, taskStartedAt, taskDeadlineAt);
    deadlineState = observed.state;
    terminalTimestamp = observed.terminalTimestamp;
    logComplete = observed.logTerminalPresent;
    outcome = observed.state === "on_time" ? observed.terminal! : observed.state === "unknown" ? "terminal_time_unknown" : "timed_out";
    browserProduct = await opened.context.newCDPSession(opened.page).then((session) => session.send("Browser.getVersion")).then((version) => version.product).catch(() => null);
    // Stop page timers and drain all server requests before reading the ledger.
    // Otherwise a delayed effect can arrive after the score has been decided.
    await opened.context.close();
    await closeServer(fixture.server);
    ledgerDrained = true;
    serverActivity = serverTracker.snapshot();
    // Requests observed after the quiet check invalidate that observation.
    if (serverActivity.active !== quiet.server.active || serverActivity.finished !== quiet.server.finished || serverActivity.interrupted !== quiet.server.interrupted) networkSettled = false;
    if (networkSettled) {
      business = grade();
      if (gradeInteraction) interaction = gradeInteraction();
    }
  } finally {
    tracker?.dispose();
    serverActivity ??= serverTracker?.snapshot() ?? null;
    serverTracker?.dispose();
    const extensionBuildAfter = extensionBuild ? await buildFingerprint(extensionDirectory).catch(() => null) : null;
    const extensionBuildStable = extensionBuild && extensionBuildAfter ? extensionBuild.sha256 === extensionBuildAfter.sha256 : null;
    if (opened) events = await readEvents(opened.page).catch(() => events);
    const head = (() => { try { return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(); } catch { return null; } })();
    const dirty = (() => { try { return !!execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim(); } catch { return null; } })();
    const browser = !browserProduct && opened ? await opened.context.newCDPSession(opened.page).then((session) => session.send("Browser.getVersion")).catch(() => null) : null;
    const terminals = events.filter((event) => ["tool.finished", "tool.failed"].includes(event.type));
    const starts = events.filter((event) => event.type === "tool.started");
    const toolLifecycle = logComplete ? toolLifecycleEvidence(events) : null;
    const result = evaluateResultEvidence({ outcome, networkSettled, ledgerDrained, logComplete, business,
      interaction: interactionApplicable ? { applicable: true, verified: interaction } : { applicable: false }, lifecycle: toolLifecycle?.complete ?? null });
    passed = result.passed;
    const toolNames = starts.reduce<Record<string, number>>((counts, event) => {
      const name = typeof event.content?.toolName === "string" ? event.content.toolName : "unknown";
      counts[name] = (counts[name] ?? 0) + 1;
      return counts;
    }, {});
    const report = { scenario, seed, provider: providerName, model, suiteIdentity, gitHead: head, gitDirty: dirty, browser: browserProduct ?? browser?.product ?? null,
      extensionBuild, extensionBuildStable, lockfileSha256,
      outcome, ...result, taskTimeoutMs, taskStartedAt, taskDeadlineAt, terminalTimestamp, deadlineState,
      networkSettled, ledgerDrained, logComplete, serverActivity, elapsedMs: Date.now() - started, providerUsageByStep: usageEvidence(events),
      requests: proxy.requests, requestBytes: proxy.requests.reduce((sum, request) => sum + request.bytes, 0),
      toolCalls: starts.length, toolNames, completedProgramOperations: completedProgramOperations(events), toolTerminalResults: terminals.length,
      toolsWithExactlyOneTerminal: result.lifecycleVerified, toolLifecycle };
    const directory = resolve(process.env.SURFWAX_EVAL_REPORT_DIR ?? ".dev/verification/model-evals");
    await mkdir(directory, { recursive: true });
    await writeFile(resolve(directory, `${Date.now()}-${seed}-${randomUUID()}.json`), JSON.stringify(report, null, 2), { flag: "wx" });
    if (opened) await dispose(opened.context, opened.userDataDirectory);
    if (fixture) await closeServer(fixture.server);
    await closeServer(proxy.server);
  }
  if (!passed) throw new Error("Evaluation did not complete with the required results; see the report");
});
