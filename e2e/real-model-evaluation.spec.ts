import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
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
import { trackFixtureRequests } from "./evaluation/network-quiescence";
import { trackServerResponses, type ServerActivity } from "./evaluation/server-quiescence";
import { waitForEvaluationQuiescence } from "./evaluation/quiescence";
import { completedProgramOperations, toolLifecycleEvidence } from "./evaluation/tool-lifecycle";

test.use({ trace: "off", screenshot: "off", video: "off" });

// An explicit opt-in is required: this test may incur provider charges.
test("@real-model browser task", async () => {
  test.skip(process.env.SURFWAX_REAL_MODEL_EVAL !== "1", "Explicit real-model opt-in required");
  test.setTimeout(Number(process.env.SURFWAX_EVAL_TIMEOUT_MS ?? 600_000));
  const upstream = process.env.SURFWAX_EVAL_BASE_URL;
  const key = process.env.SURFWAX_EVAL_API_KEY;
  const model = process.env.SURFWAX_EVAL_MODEL;
  const providerName = process.env.SURFWAX_EVAL_PROVIDER;
  if (!upstream || !key || !model || !providerName) throw new Error("Set SURFWAX_EVAL_BASE_URL, SURFWAX_EVAL_API_KEY, SURFWAX_EVAL_MODEL and SURFWAX_EVAL_PROVIDER");
  const seed = Number(process.env.SURFWAX_EVAL_SEED ?? 17);
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 999999) throw new Error("Invalid seed");
  const scenario = process.env.SURFWAX_EVAL_SCENARIO ?? "cross-frame-order";
  if (!["cross-frame-order", "claims-queue", "sequence-editor", "dispatch-review", "dossier-upload", "pointer-drag", "uncertain-write"].includes(scenario)) throw new Error("Invalid scenario");
  const service = seed % 2 ? "express" : "economy";
  const order = `ORDER-${seed}`;
  const started = Date.now();
  const proxy = await modelProxy(upstream, key);
  let fixture: Awaited<ReturnType<typeof orderFixture>> | Awaited<ReturnType<typeof claimsFixture>> | Awaited<ReturnType<typeof sequenceFixture>> | Awaited<ReturnType<typeof dispatchFixture>> | Awaited<ReturnType<typeof uploadFixture>> | Awaited<ReturnType<typeof pointerFixture>> | Awaited<ReturnType<typeof recoveryFixture>> | undefined;
  let opened: Awaited<ReturnType<typeof openExtension>> | undefined;
  let events: any[] = [], outcome = "setup_failed", businessVerified = false, interactionVerified: boolean | null = null;
  let lifecycleVerified = false;
  let networkSettled: boolean | null = null;
  let tracker: ReturnType<typeof trackFixtureRequests> | undefined;
  let serverTracker: ReturnType<typeof trackServerResponses> | undefined;
  let serverActivity: ServerActivity | null = null;
  let browserProduct: string | null = null;
  try {
    let prompt: string;
    let grade: () => boolean;
    let gradeInteraction: (() => boolean) | undefined;
    if (scenario === "uncertain-write") {
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
    await opened.page.getByTestId("composer-input").press("Enter");
    outcome = "running";
    const deadline = Date.now() + Number(process.env.SURFWAX_EVAL_TIMEOUT_MS ?? 600_000) - 30_000;
    while (Date.now() < deadline) {
      events = await readEvents(opened.page);
      const terminal = events.find((event) => ["conversation.finished", "conversation.failed", "conversation.aborted"].includes(event.type));
      if (terminal) { outcome = terminal.type; break; }
      await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
    }
    // An unsettled network may still contain a submission or decoy request.
    const quiet = await waitForEvaluationQuiescence(tracker, serverTracker, 500, 5000);
    networkSettled = quiet.settled;
    events = await readEvents(opened.page);
    browserProduct = await opened.context.newCDPSession(opened.page).then((session) => session.send("Browser.getVersion")).then((version) => version.product).catch(() => null);
    // Stop page timers and drain all server requests before reading the ledger.
    // Otherwise a delayed effect can arrive after the score has been decided.
    await opened.context.close();
    await closeServer(fixture.server);
    serverActivity = serverTracker.snapshot();
    // Requests observed after the quiet check invalidate that observation.
    if (serverActivity.active !== quiet.server.active || serverActivity.finished !== quiet.server.finished || serverActivity.interrupted !== quiet.server.interrupted) networkSettled = false;
    businessVerified = networkSettled && grade();
    interactionVerified = networkSettled && gradeInteraction ? gradeInteraction() : null;
  } finally {
    tracker?.dispose();
    serverActivity ??= serverTracker?.snapshot() ?? null;
    serverTracker?.dispose();
    if (opened) events = await readEvents(opened.page).catch(() => events);
    const head = (() => { try { return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(); } catch { return null; } })();
    const dirty = (() => { try { return !!execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim(); } catch { return null; } })();
    const browser = !browserProduct && opened ? await opened.context.newCDPSession(opened.page).then((session) => session.send("Browser.getVersion")).catch(() => null) : null;
    const terminals = events.filter((event) => ["tool.finished", "tool.failed"].includes(event.type));
    const starts = events.filter((event) => event.type === "tool.started");
    const toolLifecycle = toolLifecycleEvidence(events);
    lifecycleVerified = toolLifecycle.complete;
    const toolNames = starts.reduce<Record<string, number>>((counts, event) => {
      const name = typeof event.content?.toolName === "string" ? event.content.toolName : "unknown";
      counts[name] = (counts[name] ?? 0) + 1;
      return counts;
    }, {});
    const report = { scenario, seed, provider: providerName, model, gitHead: head, gitDirty: dirty, browser: browserProduct ?? browser?.product ?? null,
      outcome, businessVerified, interactionVerified, networkSettled, serverActivity, elapsedMs: Date.now() - started, providerUsageByStep: usageEvidence(events),
      requests: proxy.requests, requestBytes: proxy.requests.reduce((sum, request) => sum + request.bytes, 0),
      toolCalls: starts.length, toolNames, completedProgramOperations: completedProgramOperations(events), toolTerminalResults: terminals.length,
      toolsWithExactlyOneTerminal: lifecycleVerified, toolLifecycle };
    const directory = resolve(process.env.SURFWAX_EVAL_REPORT_DIR ?? ".dev/verification/model-evals");
    await mkdir(directory, { recursive: true });
    await writeFile(resolve(directory, `${Date.now()}-${seed}-${randomUUID()}.json`), JSON.stringify(report, null, 2), { flag: "wx" });
    if (opened) await dispose(opened.context, opened.userDataDirectory);
    if (fixture) await closeServer(fixture.server);
    await closeServer(proxy.server);
  }
  if (outcome !== "conversation.finished" || !businessVerified || interactionVerified === false || !lifecycleVerified) throw new Error("Evaluation did not complete with the required results; see the report");
});
