import { expect } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { commandResponse, configure, delayedResponse, dispose, enableUserScripts, openExtension, readEvents, startProvider, test, textResponse } from "./fixtures";
import { fitWindowToScreen } from "../scripts/development-extension.mjs";

test("observations retain the trusted isolated world beside default and named user-script worlds", async () => {
  test.setTimeout(300_000);
  const real = process.env.SURFWAX_OBSERVATION_REAL_SITE === "1";
  const directory = `.dev/verification/observation-world/${real ? "wikipedia" : "regression"}-${new Date().toISOString().replaceAll(":", "-")}`;
  await mkdir(directory, { recursive: true });
  const fingerprint = async () => Object.fromEntries(await Promise.all(["src/chrome/automation.ts", "src/chrome/snapshot-observation-primitives.js", "e2e/userscript-observation.spec.ts"]
    .map(async path => [path, createHash("sha256").update(await readFile(path)).digest("hex")])));
  const sourceBefore = await fingerprint();
  const records: any[] = [], assertions: any[] = [], contexts: any[] = [];
  const responses: any[] = [];
  let responder: ((value: any) => void) | undefined;
  let readyResolve: (() => void) | undefined;
  let ready = new Promise<void>(resolve => { readyResolve = resolve; });
  let outputResolve: ((value: any) => void) | undefined;
  let currentId: string | undefined;
  let finished = false;
  const handler = (request: any): any => {
    if (finished) return textResponse("Observation checks completed.");
    if (currentId) {
      const message = request.messages.findLast((message: any) => message.role === "tool");
      const content = message?.content;
      const raw = Array.isArray(content) ? content.find((part: any) => part.type === "text")?.text : content;
      outputResolve?.(typeof raw === "string" ? JSON.parse(raw) : raw);
      outputResolve = undefined; currentId = undefined;
    }
    const value = textResponse("Waiting for the independent page assertion.");
    const gate = new Promise<void>(release => { responder = next => { Object.assign(value, next); release(); }; });
    readyResolve?.(); responses.push(handler);
    return delayedResponse(value, 0, gate);
  };
  responses.push(handler);
  const provider = await startProvider(responses);
  const opened = await openExtension(undefined, { viewport: null });
  let failure: string | undefined;
  try {
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await enableUserScripts(opened.context, opened.extensionId, opened.page);
    const target = await opened.context.newPage();
    await fitWindowToScreen(opened.context, target);
    const protocol = await opened.context.newCDPSession(target);
    protocol.on("Runtime.executionContextCreated", event => contexts.push(event.context));
    await protocol.send("Runtime.enable");
    const { targetInfo } = await protocol.send("Target.getTargetInfo");
    const worker = opened.context.serviceWorkers().find(worker => new URL(worker.url()).hostname === opened.extensionId)!;
    const tabId = await worker.evaluate(async id => (await chrome.debugger.getTargets()).find(target => target.id === id)!.tabId!, targetInfo.targetId);
    let index = 0;
    async function call(name: string, input: any = {}, global = false): Promise<any> {
      await ready;
      const send = responder!;
      ready = new Promise(resolve => { readyResolve = resolve; });
      currentId = `observation-${++index}`;
      const output = new Promise(resolve => { outputResolve = resolve; });
      const args = global ? input : { tabId, ...input };
      const started = Date.now();
      send(commandResponse(name, args, currentId));
      let timer: ReturnType<typeof setTimeout> | undefined;
      const result: any = await Promise.race([output, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`No terminal tool output for ${currentId}: ${name}`)), 65_000);
      })]).finally(() => clearTimeout(timer));
      records.push({ name, input: args, elapsedMs: Date.now() - started, output: result });
      expect(result?.ok ?? !result?.error).toBe(true);
      return result?.ok === undefined ? { ok: !result?.error, result: result?.result ?? result } : result;
    }
    const url = real ? "https://en.wikipedia.org/wiki/JavaScript" : `${provider.origin}/target`;
    const selector = real ? "h1" : "main", text = real ? "JavaScript" : "ready";
    await opened.page.getByTestId("composer-input").fill("Run the supplied browser checks and wait for each independent verification.");
    await opened.page.getByTestId("composer-input").press("Enter");
    await call("switch_tab", { tabId }, true);
    await call("navigate", { url });
    const assertObservation = async (stage: string, version: string | undefined, named: boolean) => {
      const actual = await target.evaluate(() => ({ version: document.documentElement.dataset.observationScript,
        named: document.documentElement.dataset.namedObservationScript === "ran", heading: document.querySelector("h1")?.textContent }));
      expect(actual.version).toBe(version); expect(actual.named).toBe(named);
      const verified = await call("verify_state", { target: { by: "css", value: selector }, ...(real ? { state: "visible" } : { textEquals: text }) });
      expect(verified.result.verified).toBe(true);
      const observed = await call("inspect_page", { region: { by: "css", value: selector }, full: true, budget: 12000 });
      expect(observed.result.partial ?? false).toBe(false);
      expect(JSON.stringify(observed.result)).toContain(text);
      const read = await call(real ? "read_attribute" : "read_text", { target: { by: "css", value: selector }, ...(real ? { name: "id" } : {}) });
      expect(read.result).toBe(real ? await target.locator(selector).getAttribute("id") : text);
      assertions.push({ stage, actual, calls: records.slice(-3).map(record => record.name) });
    };
    await assertObservation("before user scripts", undefined, false);
    const code = (version: string) => `globalThis[Symbol.for("surf-wax.snapshot-observation-primitives.v2")]={worldIdentity:"forged"};document.documentElement.dataset.observationScript=${JSON.stringify(version)};`;
    const matches = [`${new URL(url).origin}/*`];
    await call("create_script", { definition: { id: "observation-default", matches, runAt: "document_end", js: [{ code: code("v1") }] } }, true);
    await call("create_script", { definition: { id: "observation-named", matches, worldId: "observation-extra", runAt: "document_end", js: [{ code: 'document.documentElement.dataset.namedObservationScript="ran";' }] } }, true);
    await call("reload");
    await assertObservation("default and named worlds", "v1", true);
    // The deterministic regression covers every transition. The live-site
    // admission repeats only the coexistence and recovery boundaries.
    if (!real) {
      await call("update_script", { scriptId: "observation-default", changes: { js: [{ code: code("v2") }] } }, true);
      await call("reload");
      await assertObservation("updated user script", "v2", true);
      await call("disable_script", { scriptId: "observation-named" }, true);
      await call("reload");
      await assertObservation("disabled named world", "v2", false);
      await call("enable_script", { scriptId: "observation-named" }, true);
      await call("reload");
      await assertObservation("enabled named world", "v2", true);
    }
    for (const scriptId of ["observation-default", "observation-named"]) await call("delete_script", { scriptId }, true);
    await call("reload");
    await assertObservation("deleted user scripts", undefined, false);
    await protocol.detach();
  } catch (error) { failure = String(error); throw error; }
  finally {
    finished = true; responder?.(textResponse("Observation checks completed."));
    const events = await readEvents(opened.page).catch(() => []);
    let cleanupError: string | undefined;
    try { await dispose(opened.context, opened.userDataDirectory, provider.server); }
    catch (error) { cleanupError = String(error); throw error; }
    finally {
      const sourceAfter = await fingerprint();
      await writeFile(`${directory}/report.json`, JSON.stringify({ createdAt: new Date().toISOString(), realSite: real,
        sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), sourceBefore, sourceAfter,
        sourcesStable: JSON.stringify(sourceBefore) === JSON.stringify(sourceAfter), failure, cleanupError,
        harnessStatus: test.info().status, cleanupCompleted: !cleanupError, records, assertions, contexts, events }, null, 2));
    }
  }
});
