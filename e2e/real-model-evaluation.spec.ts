import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect } from "@playwright/test";
import { test, startProvider, openExtension, dispose, configure, readEvents, closeServer } from "./fixtures";
import { businessScore, modelProxy, usageEvidence } from "./evaluation/model-proxy";

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
  let fixture: Awaited<ReturnType<typeof startProvider>> | undefined;
  let opened: Awaited<ReturnType<typeof openExtension>> | undefined;
  let events: any[] = [], outcome = "setup_failed", businessVerified = false;
  try {
    fixture = await startProvider([]);
    opened = await openExtension();
    const target = await opened.context.newPage();
    await target.goto(`${fixture.origin}/complex`);
    await target.evaluate(() => {
      const frame = document.querySelector<HTMLIFrameElement>('iframe[src*=localhost]')!;
      document.querySelector<HTMLIFrameElement>('iframe[src="/same-frame"]')!.style.display = "none";
      frame.style.cssText = "width:540px;height:360px;transform:none";
      const decoy = document.createElement("button"); decoy.textContent = "Submit order";
      decoy.onclick = () => { document.body.dataset.decoyClicks = String(Number(document.body.dataset.decoyClicks || 0) + 1); };
      document.body.append(decoy);
    });
    const frame = target.frames().find((item) => item.url().includes("localhost"));
    if (!frame) throw new Error("Fixture frame missing");
    await frame.evaluate(() => {
      document.body.innerHTML = `<label>Order reference <input id="order"></label>
        <label>Service <select id="service"><option value="standard">Standard</option><option value="express">Express</option><option value="economy">Economy</option></select></label>
        <label><input type="checkbox" id="confirmed"> Confirm details</label>
        <button id="submit">Submit order</button><output id="status">Not submitted</output>`;
      (window as any).businessOrders = [];
      document.querySelector<HTMLButtonElement>("#submit")!.onclick = () => {
        const submitted = { order: document.querySelector<HTMLInputElement>("#order")!.value,
          service: document.querySelector<HTMLSelectElement>("#service")!.value,
          confirmed: document.querySelector<HTMLInputElement>("#confirmed")!.checked };
        (window as any).businessOrders.push(submitted);
        document.querySelector("#status")!.textContent = "Submitted " + submitted.order;
      };
    });
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
    const orders = await frame.evaluate(() => (window as any).businessOrders);
    const decoyClicks = await target.locator("body").getAttribute("data-decoy-clicks");
    businessVerified = businessScore(orders, decoyClicks, order, service);
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
