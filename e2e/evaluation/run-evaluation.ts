import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect } from "@playwright/test";
import { openExtension, dispose, configure, readEvents, closeServer, enableUserScripts } from "../fixtures";
import { modelProxy, usageEvidence } from "./model-proxy";
import { businessScore, orderFixture } from "./order-fixture";
import { claimsFixture, claimsScore } from "./claims-fixture";
import { sequenceFixture, sequenceInteractionScore, sequenceScore } from "./sequence-fixture";
import { dispatchFixture, dispatchScore } from "./dispatch-fixture";
import { uploadFixture, uploadScore } from "./upload-fixture";
import { pointerFixture, pointerInteractionScore, pointerScore } from "./pointer-fixture";
import { recoveryFixture, recoveryScore } from "./recovery-fixture";
import { multitabFixture, multitabScore } from "./multitab-fixture";
import { manifestFixture, manifestScore } from "./manifest-fixture";
import { rollingFixture, rollingInteractionScore, rollingScore } from "./rolling-fixture";
import { chooserPromptFixture, chooserPromptScore } from "./chooser-prompt-fixture";
import { networkFixture, networkScore } from "./network-level-fixture";
import { userscriptFixture, userscriptScore, type UserscriptFixture, type RegistryEvidence } from "./userscript-level-fixture";
import { browserJobsSettled } from "./job-evidence";
import { verifyUserScript } from "./userscript-verification";
import { frameReplacementFixture, frameReplacementScore, frameReplacementInteractionScore, type FrameReplacementFixture } from "./frame-replacement-fixture";
import { binaryTransferFixture, binaryTransferScore, type BinaryTransferFixture } from "./binary-transfer-fixture";
import { closedEventFixture, closedEventScore, type ClosedEventFixture } from "./closed-event-fixture";
import { semanticDeltaFixture, semanticDeltaScore, semanticDeltaInteractionScore, type SemanticDeltaFixture } from "./semantic-delta-fixture";
import { trackFixtureRequests } from "./network-quiescence";
import { trackServerResponses, type ServerActivity } from "./server-quiescence";
import { waitForEvaluationQuiescence } from "./quiescence";
import { completedProgramOperations, toolLifecycleEvidence } from "./tool-lifecycle";
import { evaluateResultEvidence, lastAgentResponse, requiresInteraction } from "./result-evidence";
import { deadlineEvidence } from "./deadline-evidence";
import { buildFingerprint, evaluationFingerprint, fileFingerprint, type BuildFingerprint } from "./build-fingerprint";

import type { EvaluationOptions } from "./options";

/** One evaluation owns browser activity, evidence capture, report writing and cleanup. */
export async function runEvaluation(options: EvaluationOptions): Promise<void> {
  const { upstream, key, model, providerName, taskTimeoutMs, seed, scenario, suiteIdentity, extensionDirectory } = options;
  const service = seed % 2 ? "express" : "economy";
  const order = `ORDER-${seed}`;
  const started = Date.now();
  const proxy = await modelProxy(upstream, key);
  let fixture: Awaited<ReturnType<typeof orderFixture>> | Awaited<ReturnType<typeof claimsFixture>> | Awaited<ReturnType<typeof sequenceFixture>> | Awaited<ReturnType<typeof dispatchFixture>> | Awaited<ReturnType<typeof uploadFixture>> | Awaited<ReturnType<typeof pointerFixture>> | Awaited<ReturnType<typeof recoveryFixture>> | Awaited<ReturnType<typeof multitabFixture>> | Awaited<ReturnType<typeof manifestFixture>> | Awaited<ReturnType<typeof rollingFixture>> | Awaited<ReturnType<typeof chooserPromptFixture>> | Awaited<ReturnType<typeof networkFixture>> | UserscriptFixture | FrameReplacementFixture | BinaryTransferFixture | ClosedEventFixture | SemanticDeltaFixture | undefined;
  let scriptLevel: UserscriptFixture | undefined, scriptRegistry: RegistryEvidence | null = null, scriptExecutionVerified: boolean | null = null, scriptLedgerVerified: boolean | null = null;
  let opened: Awaited<ReturnType<typeof openExtension>> | undefined;
  let events: any[] = [], outcome = "setup_failed", business: boolean | null = null, interaction: boolean | null = null;
  const interactionApplicable = requiresInteraction(scenario);
  let passed = false, ledgerDrained = false, logComplete = false;
  let networkSettled: boolean | null = null;
  let jobsSettled: boolean | null = null;
  let taskStartedAt: number | null = null, taskDeadlineAt: number | null = null, terminalTimestamp: string | null = null;
  let deadlineState: "pending" | "on_time" | "late" | "unknown" | null = null;
  let tracker: ReturnType<typeof trackFixtureRequests> | undefined;
  let serverTracker: ReturnType<typeof trackServerResponses> | undefined;
  let serverActivity: ServerActivity | null = null;
  let browserProduct: string | null = null;
  let extensionBuild: BuildFingerprint | null = null, lockfileSha256: string | null = null;
  let evaluationSource: Awaited<ReturnType<typeof evaluationFingerprint>> | null = null;
  const failures: unknown[] = [];
  try {
    evaluationSource = await evaluationFingerprint(resolve(".")).catch(() => null);
    let prompt: string;
    let grade: () => boolean | null;
    let gradeInteraction: (() => boolean) | undefined;
    if (scenario === "semantic-delta") {
      const semantic = await semanticDeltaFixture(seed); fixture = semantic; prompt = semantic.prompt;
      grade = () => semanticDeltaScore(semantic.evidence());
      gradeInteraction = () => semanticDeltaInteractionScore(semantic.evidence());
    } else if (scenario === "closed-event-ledger") {
      const closed = await closedEventFixture(seed); fixture = closed; prompt = closed.prompt;
      grade = () => closedEventScore(closed.evidence());
    } else if (scenario === "binary-transfer") {
      const transfer = await binaryTransferFixture(seed); fixture = transfer; prompt = transfer.prompt;
      grade = () => binaryTransferScore(transfer.evidence());
    } else if (scenario === "frame-replacement") {
      const replacement = await frameReplacementFixture(seed); fixture = replacement; prompt = replacement.prompt;
      grade = () => frameReplacementScore(replacement.evidence());
      gradeInteraction = () => frameReplacementInteractionScore(replacement.evidence());
    } else if (scenario === "userscript-repair") {
      scriptLevel = await userscriptFixture(seed); fixture = scriptLevel; prompt = scriptLevel.prompt;
      grade = () => {
        if (!scriptRegistry || !scriptLevel) return null;
        scriptLedgerVerified = userscriptScore(scriptLevel.evidence(), scriptRegistry, scriptLevel.preset, true);
        return scriptLedgerVerified === false ? false : scriptExecutionVerified;
      };
    } else if (scenario === "network-identity") {
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
    opened = await openExtension(undefined, { extensionPath: extensionDirectory });
    if (scriptLevel) {
      await enableUserScripts(opened.context, opened.extensionId, opened.page);
      await opened.page.evaluate(async ({ target, decoy }) => chrome.storage.local.set({
        "side-agent:user-scripts": [], "side-agent:user-scripts-disabled": [target, decoy],
      }), scriptLevel.preset);
    }
    // The extension handles dialogs; Playwright must not auto-dismiss them.
    opened.context.on("page", (page) => page.on("dialog", () => {}));
    const alternateOrigin = new URL(fixture.origin);
    alternateOrigin.hostname = "localhost";
    tracker = trackFixtureRequests(opened.context, [fixture.origin, alternateOrigin.origin]);
    const target = await opened.context.newPage();
    await target.goto(fixture.origin);
    const frame = target.frames().find((item) => item.url().includes("localhost"));
    if (!frame && !scriptLevel) throw new Error("Fixture frame missing");
    const options = await configure(opened.context, opened.page, proxy.baseURL, undefined, { goalMode: true });
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
    let quiet = await waitForEvaluationQuiescence(tracker, serverTracker, 500, 5000);
    const initialNetworkSettled = quiet.settled;
    events = await readEvents(opened.page);
    const observed = deadlineEvidence(events, taskStartedAt, taskDeadlineAt);
    deadlineState = observed.state;
    terminalTimestamp = observed.terminalTimestamp;
    logComplete = observed.logTerminalPresent;
    outcome = observed.state === "on_time" ? observed.terminal! : observed.state === "unknown" ? "terminal_time_unknown" : "timed_out";
    jobsSettled = logComplete ? browserJobsSettled(events) : null;
    if (scriptLevel && outcome === "conversation.finished" && initialNetworkSettled && jobsSettled === true) {
      scriptExecutionVerified = await verifyUserScript(opened.context, scriptLevel.createVerification());
      // The independent verification itself uses the fixture network.
      quiet = await waitForEvaluationQuiescence(tracker, serverTracker, 500, 5000);
    }
    networkSettled = initialNetworkSettled && quiet.settled;
    browserProduct = await opened.context.newCDPSession(opened.page).then((session) => session.send("Browser.getVersion")).then((version) => version.product).catch(() => null);
    if (scriptLevel) scriptRegistry = await opened.page.evaluate(async () => {
      const registered = await chrome.userScripts.getScripts();
      const values = await chrome.storage.local.get(["side-agent:user-scripts", "side-agent:user-scripts-disabled"]);
      const active = values["side-agent:user-scripts"], disabled = values["side-agent:user-scripts-disabled"];
      if (!Array.isArray(active) || !Array.isArray(disabled)) throw new Error("Script state unavailable");
      return { registered, active, disabled };
    }).catch(() => null);
    // Capture job state before closing the extension: shutdown can cancel a
    // still-running job and make its terminal state misleading for this run.
    try { events = await readEvents(opened.page); jobsSettled = logComplete ? browserJobsSettled(events) : null; }
    catch { jobsSettled = null; }
    if (scriptLevel && jobsSettled !== true) scriptExecutionVerified = null;
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
  } catch (error) {
    failures.push(error);
  } finally {
    try {
      tracker?.dispose();
      serverActivity ??= serverTracker?.snapshot() ?? null;
      serverTracker?.dispose();
      const extensionBuildAfter = extensionBuild ? await buildFingerprint(extensionDirectory).catch(() => null) : null;
      const extensionBuildStable = extensionBuild && extensionBuildAfter ? extensionBuild.sha256 === extensionBuildAfter.sha256 : null;
      const evaluationSourceAfter = evaluationSource ? await evaluationFingerprint(resolve(".")).catch(() => null) : null;
      const evaluationSourceStable = evaluationSource && evaluationSourceAfter ? evaluationSource.sha256 === evaluationSourceAfter.sha256 : null;
      if (opened) events = await readEvents(opened.page).catch(() => events);
      const head = (() => { try { return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(); } catch { return null; } })();
      const dirty = (() => { try { return !!execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim(); } catch { return null; } })();
      const browser = !browserProduct && opened ? await opened.context.newCDPSession(opened.page).then((session) => session.send("Browser.getVersion")).catch(() => null) : null;
      const terminals = events.filter((event) => ["tool.finished", "tool.failed"].includes(event.type));
      const starts = events.filter((event) => event.type === "tool.started");
      const toolLifecycle = logComplete ? toolLifecycleEvidence(events) : null;
      const result = evaluateResultEvidence({ outcome, networkSettled, ledgerDrained, logComplete, jobsSettled, business,
        interaction: interactionApplicable ? { applicable: true, verified: interaction } : { applicable: false }, lifecycle: toolLifecycle?.complete ?? null });
      passed = result.passed;
      const toolNames = starts.reduce<Record<string, number>>((counts, event) => {
        const name = typeof event.content?.toolName === "string" ? event.content.toolName : "unknown";
        counts[name] = (counts[name] ?? 0) + 1;
        return counts;
      }, {});
      // Provider streams can still finish while the report is being written.
      // Derive every field from the same immutable observation.
      const requests = structuredClone(proxy.requests);
      const report = { scenario, seed, provider: providerName, model, suiteIdentity, gitHead: head, gitDirty: dirty, browser: browserProduct ?? browser?.product ?? null,
        extensionBuild, extensionBuildStable, evaluationSource, evaluationSourceStable, lockfileSha256,
        outcome, ...result, taskTimeoutMs, taskStartedAt, taskDeadlineAt, terminalTimestamp, deadlineState,
        networkSettled, ledgerDrained, logComplete, scriptExecutionVerified, scriptLedgerVerified, serverActivity, elapsedMs: Date.now() - started, providerUsageByStep: usageEvidence(events),
        requests, lastAgentResponse: lastAgentResponse(requests), requestBytes: requests.reduce((sum, request) => sum + request.bytes, 0),
        toolCalls: starts.length, toolNames, completedProgramOperations: completedProgramOperations(events), toolTerminalResults: terminals.length,
        toolsWithExactlyOneTerminal: result.lifecycleVerified, toolLifecycle };
      const directory = options.reportDirectory;
      await mkdir(directory, { recursive: true });
      const reportName = `${Date.now()}-${seed}-${randomUUID()}.json`;
      await writeFile(resolve(directory, reportName), JSON.stringify(report, null, 2), { flag: "wx" });
      if (options.eventsDirectory) {
        const eventsDirectory = options.eventsDirectory;
        await mkdir(eventsDirectory, { recursive: true });
        await writeFile(resolve(eventsDirectory, reportName), JSON.stringify(events, null, 2), { flag: "wx", mode: 0o600 });
      }
    } catch (error) {
      failures.push(error);
    }
    // Report failures must not leak browsers or loopback servers into the caller.
    const cleanup = await Promise.allSettled([
      ...(opened ? [dispose(opened.context, opened.userDataDirectory)] : []),
      ...(fixture ? [closeServer(fixture.server)] : []),
      closeServer(proxy.server),
    ]);
    for (const result of cleanup) if (result.status === "rejected") failures.push(result.reason);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Evaluation and evidence cleanup failed", { cause: failures[0] });
  if (!passed) throw new Error("Evaluation did not complete with the required results; see the report");
}
