import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fitWindowToScreen } from "../../scripts/development-extension.mjs";
import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { configure, openExtension, readEvents, dispose, closeServer } from "../fixtures";
import { modelProxy } from "../evaluation/model-proxy";
import { buildFingerprint, type BuildFingerprint } from "../evaluation/build-fingerprint";
import { finalizePublicEvidence, pollPublicEvidence, type DocumentEvidence } from "./evidence";
import { sourceReader, type FrozenSource } from "./sources";
import type { publicTasks } from "./tasks";

type Task = (typeof publicTasks)[number];
type Outcome = "passed" | "failed" | "blocked" | "timed_out" | "setup_failed";

export async function runPublicTask(task: Task, timeoutMs: number): Promise<Outcome> {
  const root = resolve(process.env.SURFWAX_PUBLIC_WEB_REPORT_DIR ?? ".dev/verification/public-web", `${Date.now()}-${task.id}-${randomUUID()}`);
  await mkdir(root, { recursive: true, mode: 0o700 });
  let opened: Awaited<ReturnType<typeof openExtension>> | undefined;
  let proxy: Awaited<ReturnType<typeof modelProxy>> | undefined;
  let sources: FrozenSource[] = [], expected: unknown, requiredUrls: string[] = [];
  let events: any[] = [], outcome: Outcome = "setup_failed", phase = "oracle_preflight", reason = "";
  let startedAt: number | null = null, deadlineAt: number | null = null;
  const gitHeadAtStart = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const gitDirtyAtStart = !!execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim();
  let buildBefore: BuildFingerprint | null = null, buildAfter: BuildFingerprint | null = null;
  const documents: DocumentEvidence[] = [];
  let nextPageId = 0;
  const pageTabs = new Map<number, number>();
  const pageAssociations: Promise<void>[] = [];
  const navigationFailures: { url: string; error: string | null; duringTask: boolean }[] = [];
  let browser: string | null = null;
  let runError: string | null = null;
  let hasObservation = false;
  let deadlineExpired = false;
  let progressAt = 0;
  try {
    const read = sourceReader();
    ({ sources, expected, requiredUrls } = await task.prepare(read));
    await writeFile(resolve(root, "sources.json"), JSON.stringify(sources, null, 2), { flag: "wx", mode: 0o600 });
    phase = "extension_setup";
    const base = process.env.SURFWAX_EVAL_BASE_URL, key = process.env.SURFWAX_EVAL_API_KEY, model = process.env.SURFWAX_EVAL_MODEL;
    if (!base || !key || !model) throw new Error("Set SURFWAX_EVAL_BASE_URL, SURFWAX_EVAL_API_KEY and SURFWAX_EVAL_MODEL");
    proxy = await modelProxy(base, key);
    buildBefore = await buildFingerprint(resolve(process.env.SURFWAX_EXTENSION_PATH ?? "dist"));
    opened = await openExtension(undefined, { viewport: null });
    await fitWindowToScreen(opened.context, opened.page);
    browser = opened.context.browser()?.version() ?? null;
    const watch = (page: Page) => {
      const pageId = ++nextPageId;
      pageAssociations.push((async () => {
        const session = await opened!.context.newCDPSession(page);
        try {
          const { targetInfo } = await session.send("Target.getTargetInfo");
          const tabId = await opened!.page.evaluate(async id => (await chrome.debugger.getTargets()).find(target => target.id === id)?.tabId ?? null, targetInfo.targetId);
          if (tabId !== null) pageTabs.set(pageId, tabId);
        } finally { await session.detach(); }
      })().catch(() => {}));
      page.on("dialog", () => {});
      page.on("response", response => {
        if (!response.request().isNavigationRequest() || response.request().resourceType() !== "document" || response.frame() !== page.mainFrame()) return;
        documents.push({ pageId, tabId: null, url: response.url(), status: response.status(), at: new Date().toISOString(), duringTask: startedAt !== null });
      });
      page.on("requestfailed", request => {
        if (request.isNavigationRequest() && request.resourceType() === "document")
          navigationFailures.push({ url: request.url(), error: request.failure()?.errorText ?? null, duringTask: startedAt !== null });
      });
    };
    opened.context.pages().forEach(watch); opened.context.on("page", watch);
    const settings = await configure(opened.context, opened.page, proxy.baseURL, 256_000, { goalMode: true });
    await settings.getByLabel("Model ID", { exact: true }).fill(model);
    await settings.getByLabel("API Key", { exact: true }).fill(proxy.token);
    await settings.getByRole("button", { name: "保存配置" }).click();
    await expect.poll(() => settings.evaluate(async ({ model, token }) => {
      const stored = (await chrome.storage.local.get("side-agent:model-config"))["side-agent:model-config"] as any;
      return stored?.profiles?.custom?.model === model && stored?.profiles?.custom?.providerSettings?.apiKey === token;
    }, { model, token: proxy!.token })).toBe(true);
    await settings.close();
    phase = "browser_preflight";
    // Only the starting page is opened by the harness; all evidence collection belongs to the agent.
    const target = await opened.context.newPage();
    const response = await target.goto(task.startUrl, { waitUntil: "load", timeout: 45_000 });
    if (!response?.ok()) throw new Error("Starting website is unavailable");
    await target.bringToFront(); // This browser is always headless.
    phase = "agent_run";
    await opened.page.getByTestId("composer-input").fill(task.prompt);
    startedAt = Date.now(); deadlineAt = startedAt + timeoutMs;
    await opened.page.getByTestId("composer-input").press("Enter");
    deadlineExpired = await pollPublicEvidence(timeout => readBounded(opened!.page, timeout), startedAt, deadlineAt, observation => {
      events = observation; hasObservation = true;
      if (Date.now() - progressAt > 30_000) { console.log(JSON.stringify({ task: task.id, elapsedMs: Date.now() - startedAt!, toolCalls: events.filter(event => event.type === "tool.started").length })); progressAt = Date.now(); }
    });
  } catch (error) {
    outcome = phase === "oracle_preflight" || phase === "browser_preflight" ? "blocked" : "setup_failed";
    // Error details are local evidence; credentials are never copied from config or requests.
    reason = error instanceof Error ? error.message : "Evaluation operation failed";
    for (const value of [process.env.SURFWAX_EVAL_API_KEY, proxy?.token]) if (value) reason = reason.replaceAll(value, "[redacted]");
    runError = reason;
  } finally {
    // Freeze one observation for both the summary and events.json.
    try {
    await Promise.allSettled(pageAssociations);
    for (const doc of documents) doc.tabId = pageTabs.get(doc.pageId) ?? null;
    const result = await finalizePublicEvidence({
      prior: events, hasObservation, read: opened && startedAt !== null ? () => readBounded(opened!.page, 5000) : undefined,
      persist: observation => writeFile(resolve(root, "events.json"), JSON.stringify(observation, null, 2), { flag: "wx", mode: 0o600 }),
      startedAt, deadlineAt, outcome, reason, runError, deadlineExpired,
      required: () => requiredUrls.map(url => ({ url, terms: task.evidenceTerms(expected, url), alternatives: task.evidenceUrls(url) })),
      documents, navigationFailures, grade: value => task.grade(value, expected),
      redact: error => {
        let message = error instanceof Error ? error.message : "Evaluation operation failed";
        for (const value of [process.env.SURFWAX_EVAL_API_KEY, proxy?.token]) if (value) message = message.replaceAll(value, "[redacted]");
        return message;
      },
    });
    ({ outcome, reason } = result);
    const { capture, derivationError, derived } = result;
    if (buildBefore) buildAfter = await buildFingerprint(resolve(process.env.SURFWAX_EXTENSION_PATH ?? "dist")).catch(() => null);
    if (outcome === "passed" && buildBefore?.sha256 !== buildAfter?.sha256) { outcome = "setup_failed"; reason = "Extension build changed during evaluation"; }
    const gitDirty = !!execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim();
    const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const report = { task: task.id, title: task.title, difficulty: task.difficulty, outcome, reason, runError, capture, derivationError, phase, gitHead: head, gitDirty, gitHeadAtStart, gitDirtyAtStart,
      model: process.env.SURFWAX_EVAL_MODEL, browser, timeoutMs, startedAt, deadlineAt, elapsedMs: startedAt ? Date.now() - startedAt : null,
      buildBefore, buildAfter, sources: sources.map(({ body: _body, ...metadata }) => metadata), requiredUrls, documents, navigationFailures,
      browsing: derived?.browsing ?? null, httpEvidence: derived?.http.map(({ text, ...metadata }) => ({ ...metadata, deliveredCharacters: text.length })) ?? null, snapshots: derived?.snapshots.map(({ text: _text, ...metadata }) => metadata) ?? null, finalAnswer: derived?.answer ?? null, correct: derived?.correct ?? null, lifecycle: derived?.lifecycle ?? null, jobs: derived?.jobs ?? null, effectCertainty: derived?.effectCertainty ?? null, readOnlyResearch: true, usage: derived?.usage ?? null, requests: structuredClone(proxy?.requests ?? []) };
      await writeFile(resolve(root, "report.json"), JSON.stringify(report, null, 2), { flag: "wx", mode: 0o600 });
      console.log(JSON.stringify({ outcome, reason, report: resolve(root, "report.json") }));
    } finally {
      await Promise.allSettled([...(opened ? [dispose(opened.context, opened.userDataDirectory)] : []), ...(proxy ? [closeServer(proxy.server)] : [])]);
    }
  }
  return outcome;
}

async function readBounded(page: Page, timeout: number): Promise<any[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([readEvents(page), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Canonical event read timed out")), timeout); })]); }
  finally { clearTimeout(timer); }
}
