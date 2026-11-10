import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect } from "@playwright/test";
import { test, openExtension, dispose, configure, readEvents, closeServer } from "./fixtures";
import { buildFingerprint } from "./evaluation/build-fingerprint";
import { deadlineEvidence } from "./evaluation/deadline-evidence";
import { frameReplacementFixture } from "./evaluation/frame-replacement-fixture";
import { modelProxy } from "./evaluation/model-proxy";

test.use({ trace: "off", screenshot: "off", video: "off" });

/** Hash Vite's development sources, not just its generated extension stubs. */
async function sourceFingerprint(): Promise<string> {
  const paths: string[] = ["vite.config.ts", "playwright.config.ts", "package.json", "package-lock.json", "options.html", "program-sandbox.html", "sidepanel.html", "userscripts.html",
    "e2e/fixtures.ts", "e2e/real-model-frame-ref.spec.ts", "e2e/evaluation/frame-replacement-fixture.ts", "e2e/evaluation/model-proxy.ts", "e2e/evaluation/deadline-evidence.ts"];
  const walk = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Unexpected symbolic link: ${path}`);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) paths.push(path);
    }
  };
  await Promise.all([walk("src"), walk("manifests")]);
  const hash = createHash("sha256");
  for (const path of paths.sort()) {
    const bytes = await readFile(path);
    hash.update(JSON.stringify([path, bytes.length, createHash("sha256").update(bytes).digest("hex")]));
  }
  return hash.digest("hex");
}

/** Extract only real owner handles that the model observed in tool results. */
function nextFrameRefs(output: any): string[] {
  const snapshots = [output, output?.pageSnapshot];
  const refs: string[] = [];
  for (const snapshot of snapshots) {
    if (!Array.isArray(snapshot?.items)) continue;
    let heading = "";
    for (const item of snapshot.items) {
      if (item?.role === "heading" && (item.name === "Next" || item.name === "Waiting")) heading = item.name;
      if (heading === "Next" && item?.role === "Iframe" && typeof item.frameRef === "string" && /^f[A-Za-z0-9_-]{22}$/.test(item.frameRef)) {
        refs.push(item.frameRef);
      }
    }
  }
  return refs;
}

test("identifies the Next frame only from its actual snapshot owner row", () => {
  const next = `f${"A".repeat(22)}`, waiting = `f${"B".repeat(22)}`;
  const snapshot = { items: [{ role: "heading", name: "Waiting" }, { role: "Iframe", frameRef: waiting },
    { role: "heading", name: "Next" }, { role: "Iframe", frameRef: next }] };
  expect(nextFrameRefs({ pageSnapshot: snapshot })).toEqual([next]);
  expect(nextFrameRefs({ items: [{ role: "paragraph", name: `[frameRef=${next}]` }] })).toEqual([]);
});

test("@real-model targeted short frameRef copy and click", async () => {
  test.skip(process.env.SURFWAX_REAL_MODEL_EVAL !== "1", "Explicit real-model opt-in required");
  const timeoutMs = Number(process.env.SURFWAX_EVAL_TIMEOUT_MS ?? 180_000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_423_647) throw new Error("Invalid evaluation timeout");
  test.setTimeout(timeoutMs + 60_000);
  const upstream = process.env.SURFWAX_EVAL_BASE_URL, key = process.env.SURFWAX_EVAL_API_KEY, model = process.env.SURFWAX_EVAL_MODEL;
  if (!upstream || !key || !model) throw new Error("Set SURFWAX_EVAL_BASE_URL, SURFWAX_EVAL_API_KEY and SURFWAX_EVAL_MODEL");
  const seed = Number(process.env.SURFWAX_EVAL_SEED ?? 17);
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 999999) throw new Error("Invalid seed");
  const directory = resolve(process.env.SURFWAX_EVAL_REPORT_DIR ?? ".dev/verification/frame-ref-probe");
  const extensionDirectory = resolve(process.env.SURFWAX_EXTENSION_PATH ?? "dist");
  const basename = `${Date.now()}-${seed}-${randomUUID()}`;
  let fixture: Awaited<ReturnType<typeof frameReplacementFixture>> | undefined;
  let proxy: Awaited<ReturnType<typeof modelProxy>> | undefined;
  let opened: Awaited<ReturnType<typeof openExtension>> | undefined;
  let events: any[] = [], report: Record<string, unknown> = {}, error: unknown;
  const startedAt = Date.now();
  try {
    const [sourceBefore, buildBefore] = await Promise.all([sourceFingerprint(), buildFingerprint(extensionDirectory)]);
    const gitHead = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const gitDirty = Boolean(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim());
    fixture = await frameReplacementFixture(seed);
    proxy = await modelProxy(upstream, key);
    opened = await openExtension();
    const target = await opened.context.newPage();
    await target.goto(fixture.origin);
    await expect(target.locator("#progress")).toHaveText("Completed 0 of 12");
    const options = await configure(opened.context, opened.page, proxy.baseURL, undefined, { goalMode: true });
    await options.getByLabel("Model ID", { exact: true }).fill(model);
    await options.getByLabel("API Key", { exact: true }).fill(proxy.token);
    await options.getByRole("button", { name: "保存配置" }).click();
    await expect(options.getByRole("status")).toContainText("配置已保存");
    await options.close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill(
      "Inspect the queue. Confirm the single item marked Next, then stop. For the click, use a role locator for the Confirm button with target.frame.ref set to the exact frameRef observed on the Next iframe. Do not include an element ref in that target. Do not confirm Waiting items."
    );
    const taskStartedAt = Date.now(), deadlineAt = taskStartedAt + timeoutMs;
    await opened.page.getByTestId("composer-input").press("Enter");
    let deadline = deadlineEvidence([], taskStartedAt, deadlineAt);
    while (Date.now() < deadlineAt) {
      events = await readEvents(opened.page);
      deadline = deadlineEvidence(events, taskStartedAt, deadlineAt);
      if (deadline.state !== "pending") break;
      await new Promise((done) => setTimeout(done, Math.min(1000, Math.max(0, deadlineAt - Date.now()))));
    }
    events = await readEvents(opened.page);
    deadline = deadlineEvidence(events, taskStartedAt, deadlineAt);
    // Close the browser before reading the final server ledger so no late
    // browser action can be counted after the proof is decided.
    await opened.context.close();
    await closeServer(fixture.server);
    const evidence = fixture.evidence();
    const candidates = events.flatMap((event, index) => {
      const target = event.input?.target;
      if (event.type !== "tool.started" || event.content?.toolName !== "click" || target?.by !== "role"
        || target.value !== "button" || target.name !== "Confirm" || target.ref !== undefined || typeof target.frame?.ref !== "string") return [];
      const observed = events.slice(0, index).filter((prior) => prior.type === "tool.finished").flatMap((prior) => nextFrameRefs(prior.output));
      const terminal = events.find((item, terminalIndex) => terminalIndex > index && item.type === "tool.finished"
        && item.toolCallId === event.toolCallId && item.output?.ok === true && item.output?.state === "succeeded");
      return [{ ref: target.frame.ref, observedOnNext: observed.includes(target.frame.ref), terminalSucceeded: Boolean(terminal), toolCallId: event.toolCallId }];
    });
    const expected = evidence.expected[0], attempt = evidence.attempts[0];
    const effectVerified = evidence.attempts.length === 1 && evidence.completed.length === 1 && !!expected && !!attempt
      && attempt.accepted === true && attempt.trusted === true && attempt.round === expected.round && attempt.slot === expected.slot && attempt.token === expected.token;
    const sourceAfter = await sourceFingerprint(), buildAfter = await buildFingerprint(extensionDirectory);
    report = { model, seed, gitHead, gitDirty, elapsedMs: Date.now() - startedAt, taskTimeoutMs: timeoutMs,
      deadline, sourceBefore, sourceAfter, sourceStable: sourceBefore === sourceAfter,
      buildBefore, buildAfter, extensionStable: buildBefore.sha256 === buildAfter.sha256,
      candidates, effectVerified, evidence, requests: proxy.requests };
  } catch (caught) {
    error = caught;
    report = { ...report, setupOrExecutionError: caught instanceof Error ? caught.message : String(caught), elapsedMs: Date.now() - startedAt };
  } finally {
    if (opened && !events.length && !opened.page.isClosed()) events = await readEvents(opened.page).catch(() => []);
    if (opened) await dispose(opened.context, opened.userDataDirectory).catch(() => undefined);
    if (fixture) await closeServer(fixture.server).catch(() => undefined);
    if (proxy) await closeServer(proxy.server).catch(() => undefined);
    await mkdir(join(directory, "events"), { recursive: true });
    await mkdir(join(directory, "reports"), { recursive: true });
    await writeFile(join(directory, "events", `${basename}.json`), JSON.stringify(events, null, 2));
    await writeFile(join(directory, "reports", `${basename}.json`), JSON.stringify(report, null, 2));
  }
  if (error) throw error;
  expect(report.sourceStable).toBe(true);
  expect(report.extensionStable).toBe(true);
  expect(report.effectVerified).toBe(true);
  expect(report.candidates).toEqual(expect.arrayContaining([expect.objectContaining({ observedOnNext: true, terminalSucceeded: true })]));
});
