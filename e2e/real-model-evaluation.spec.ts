import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect } from "@playwright/test";
import { test, openExtension, dispose, configure, readEvents, closeServer } from "./fixtures";
import { modelProxy, usageEvidence } from "./evaluation/model-proxy";
import { businessScore, orderFixture } from "./evaluation/order-fixture";

test.use({ trace: "off", screenshot: "off", video: "off" });

// An explicit opt-in is required: this test may incur provider charges.
test("@real-model cross-frame order", async () => {
  test.skip(process.env.SURFWAX_REAL_MODEL_EVAL !== "1", "Explicit real-model opt-in required");
  test.setTimeout(Number(process.env.SURFWAX_EVAL_TIMEOUT_MS ?? 600_000));
  const upstream = process.env.SURFWAX_EVAL_BASE_URL;
  const key = process.env.SURFWAX_EVAL_API_KEY;
  const model = process.env.SURFWAX_EVAL_MODEL;
  const providerName = process.env.SURFWAX_EVAL_PROVIDER;
  if (!upstream || !key || !model || !providerName) throw new Error("Set SURFWAX_EVAL_BASE_URL, SURFWAX_EVAL_API_KEY, SURFWAX_EVAL_MODEL and SURFWAX_EVAL_PROVIDER");
  const seed = Number(process.env.SURFWAX_EVAL_SEED ?? 17);
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 999999) throw new Error("Invalid seed");
  const service = seed % 2 ? "express" : "economy";
  const order = `ORDER-${seed}`;
  const started = Date.now();
  const proxy = await modelProxy(upstream, key);
  let fixture: Awaited<ReturnType<typeof orderFixture>> | undefined;
  let opened: Awaited<ReturnType<typeof openExtension>> | undefined;
  let events: any[] = [], outcome = "setup_failed", businessVerified = false;
  try {
    fixture = await orderFixture();
    opened = await openExtension();
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
    await opened.page.getByTestId("composer-input").fill(`Submit order ${order} using ${service} service and confirm details.`);
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
    const networkSettled = await target.waitForLoadState("networkidle", { timeout: 5000 }).then(() => true, () => false);
    businessVerified = networkSettled && businessScore(fixture.evidence(), order, service);
  } finally {
    if (opened) events = await readEvents(opened.page).catch(() => events);
    const head = (() => { try { return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(); } catch { return null; } })();
    const dirty = (() => { try { return !!execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim(); } catch { return null; } })();
    const browser = opened ? await opened.context.newCDPSession(opened.page).then((session) => session.send("Browser.getVersion")).catch(() => null) : null;
    const terminals = events.filter((event) => ["tool.finished", "tool.failed"].includes(event.type));
    const starts = events.filter((event) => event.type === "tool.started");
    const report = { scenario: "cross-frame-order", seed, provider: providerName, model, gitHead: head, gitDirty: dirty, browser: browser?.product ?? null,
      outcome, businessVerified, elapsedMs: Date.now() - started, providerUsageByStep: usageEvidence(events),
      requests: proxy.requests, requestBytes: proxy.requests.reduce((sum, request) => sum + request.bytes, 0),
      toolCalls: starts.length, toolTerminalResults: terminals.length,
      toolsWithExactlyOneTerminal: starts.length > 0 && starts.every((start) => terminals.filter((end) => end.runId === start.runId && end.toolCallId === start.toolCallId).length === 1) };
    const directory = resolve(".dev/verification/model-evals");
    await mkdir(directory, { recursive: true });
    await writeFile(resolve(directory, `${Date.now()}-${seed}.json`), JSON.stringify(report, null, 2));
    if (opened) await dispose(opened.context, opened.userDataDirectory);
    if (fixture) await closeServer(fixture.server);
    await closeServer(proxy.server);
  }
  if (outcome !== "conversation.finished" || !businessVerified) throw new Error("Evaluation did not complete with a correct business result; see the report");
});
