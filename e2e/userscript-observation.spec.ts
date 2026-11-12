import { expect } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { commandResponse, configure, delayedResponse, dispose, enableUserScripts, openExtension, readEvents, startProvider, test, textResponse } from "./fixtures";
import { fitWindowToScreen } from "../scripts/development-extension.mjs";

test("observation receipts do not execute user-script getters or proxies", async () => {
  test.setTimeout(140_000);
  const directory = process.env.SURFWAX_WORLD_SAFETY_EVIDENCE ?? `.dev/verification/observation-world/safety-${new Date().toISOString().replaceAll(":", "-")}`;
  await mkdir(directory, { recursive: true });
  const fingerprint = async () => Object.fromEntries(await Promise.all(["src/chrome/automation.ts", "src/chrome/executor.ts", "src/chrome/snapshot-observation-primitives.js", "e2e/userscript-observation.spec.ts"]
    .map(async path => [path, createHash("sha256").update(await readFile(path)).digest("hex")])));
  const sourceBefore = await fingerprint();
  const records: any[] = [], assertions: any[] = [], contexts: any[] = [], consoleEvents: any[] = [];
  const liveContexts = new Map<number, any>();
  const started = Date.now();
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
    protocol.on("Runtime.executionContextCreated", event => { contexts.push(event.context); liveContexts.set(event.context.id, event.context); });
    protocol.on("Runtime.executionContextDestroyed", event => liveContexts.delete(event.executionContextId));
    protocol.on("Runtime.executionContextsCleared", () => liveContexts.clear());
    protocol.on("Runtime.consoleAPICalled", event => consoleEvents.push(event));
    await protocol.send("Runtime.enable");
    const { targetInfo } = await protocol.send("Target.getTargetInfo");
    const worker = opened.context.serviceWorkers().find(worker => new URL(worker.url()).hostname === opened.extensionId)!;
    const tabId = await worker.evaluate(async id => (await chrome.debugger.getTargets()).find(target => target.id === id)!.tabId!, targetInfo.targetId);
    let index = 0;
    async function call(name: string, input: any = {}, global = false, success = true): Promise<any> {
      await ready;
      const send = responder!;
      ready = new Promise(resolve => { readyResolve = resolve; });
      currentId = `observation-${++index}`;
      const output = new Promise(resolve => { outputResolve = resolve; });
      const args = global ? { timeoutMs: 15000, ...input } : { timeoutMs: 15000, tabId, ...input };
      const started = Date.now();
      send(commandResponse(name, args, currentId));
      let timer: ReturnType<typeof setTimeout> | undefined;
      const result: any = await Promise.race([output, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`No terminal tool output for ${currentId}: ${name}`)), 20_000);
      })]).finally(() => clearTimeout(timer));
      records.push({ name, input: args, elapsedMs: Date.now() - started, output: result });
      expect(result?.ok ?? !result?.error).toBe(success);
      await writeFile(`${directory}/progress.json`, JSON.stringify({ started, records, assertions, contexts, consoleEvents }, null, 2));
      return result?.ok === undefined ? { ok: !result?.error, result: result?.result ?? result } : result;
    }
    const url = `${provider.origin}/target`;
    await opened.page.getByTestId("composer-input").fill("Run the supplied browser checks and wait for each independent verification.");
    await opened.page.getByTestId("composer-input").press("Enter");
    await call("switch_tab", { tabId }, true);
    await call("navigate", { url });
    const consoleSubscription = await call("subscribe_event", { kind: "console" });
    const found = await call("find_elements", { target: { by: "css", value: "main" } });
    const oldId = found.result.elements[0].id;
    const matches = [`${new URL(url).origin}/*`];
    const getterCode = `const g=globalThis,d=document,S=Symbol,C=console;d.documentElement.dataset.getterHits="0";d.documentElement.dataset.bindingHits="0";d.documentElement.dataset.consoleHits="0";d.documentElement.dataset.debugHits="0";d.documentElement.dataset.consoleCalls="0";const hit=key=>d.documentElement.dataset[key]=String(Number(d.documentElement.dataset[key])+1);C.debug("surf-wax.observation-world.v1","forged-page-log");Object.defineProperty(C,"debug",{configurable:true,get(){hit("debugHits");return ()=>hit("consoleCalls")}});Object.defineProperty(g,"console",{configurable:true,get(){hit("consoleHits");return C}});Object.defineProperty(g,S.for("surf-wax.snapshot-observation-primitives.v2"),{configurable:true,get(){hit("getterHits");return {worldIdentity:"forged"}}});Object.defineProperty(g,"globalThis",{configurable:true,get(){hit("bindingHits");return g}});Object.defineProperty(g,"Symbol",{configurable:true,get(){hit("bindingHits");return S}});`;
    const proxyCode = `const d=document;d.documentElement.dataset.proxyHits="0";const hit=()=>d.documentElement.dataset.proxyHits=String(Number(d.documentElement.dataset.proxyHits)+1);globalThis[Symbol.for("surf-wax.snapshot-observation-primitives.v2")]=new Proxy({worldIdentity:"forged"},{get(t,k){hit();return Reflect.get(t,k)},ownKeys(t){hit();return Reflect.ownKeys(t)},getOwnPropertyDescriptor(t,k){hit();return Reflect.getOwnPropertyDescriptor(t,k)},getPrototypeOf(t){hit();return Reflect.getPrototypeOf(t)}});`;
    await call("create_script", { definition: { id: "observation-default", matches, runAt: "document_end", js: [{ code: getterCode }] } }, true);
    await call("create_script", { definition: { id: "observation-named", matches, worldId: "observation-extra", runAt: "document_end", js: [{ code: proxyCode }] } }, true);
    const counters = () => target.evaluate(() => ({ getter: document.documentElement.dataset.getterHits, bindings: document.documentElement.dataset.bindingHits,
      proxy: document.documentElement.dataset.proxyHits, console: document.documentElement.dataset.consoleHits, debug: document.documentElement.dataset.debugHits, consoleCalls: document.documentElement.dataset.consoleCalls }));
    const assertSafeObservation = async (stage: string) => {
      expect(await counters()).toEqual({ getter: "0", bindings: "0", proxy: "0", console: "0", debug: "0", consoleCalls: "0" });
      const verified = await call("verify_state", { target: { by: "css", value: "main" }, state: "visible" });
      expect(verified.result.verified).toBe(true);
      const observed = await call("inspect_page", { region: { by: "css", value: "main" }, full: true, budget: 12000 });
      expect(observed.result.partial ?? false).toBe(false);
      expect(JSON.stringify(observed.result)).toContain("ready");
      expect(await target.locator("main").innerText()).toBe("ready");
      const actual = await counters();
      expect(actual).toEqual({ getter: "0", bindings: "0", proxy: "0", console: "0", debug: "0", consoleCalls: "0" });
      assertions.push({ stage, actual });
    };
    await call("reload");
    await assertSafeObservation("normal default and named worlds coexist without executing candidate code");
    const expired = await call("read_attribute", { target: { id: oldId }, name: "id" }, false, false);
    expect(["stale-ref", "stale-id"]).toContain(expired.error.code);
    assertions.push({ stage: "navigation rejects the previous document reference", error: expired.error });
    // Negative control: execute f90's exact old expression, independently of
    // the fixed extension. It must demonstrate the getter/proxy side effects.
    const legacySource = execFileSync("git", ["show", "f90e01b:src/chrome/automation.ts"], { encoding: "utf8" });
    const expression = 'globalThis[Symbol.for("surf-wax.snapshot-observation-primitives.v2")]?.worldIdentity';
    expect(legacySource).toContain(expression);
    const { frameTree } = await protocol.send("Page.getFrameTree");
    const candidates = [...liveContexts.values()].filter(context => context.auxData?.frameId === frameTree.frame.id
      && context.auxData?.type === "isolated" && context.origin.replace(/\/$/, "") === `chrome-extension://${opened.extensionId}`);
    expect(candidates.length).toBeGreaterThanOrEqual(3);
    for (const context of candidates) await protocol.send("Runtime.evaluate", { expression, contextId: context.id, returnByValue: true, generatePreview: false });
    const unsafe = await counters();
    expect(Number(unsafe.getter)).toBeGreaterThan(0); expect(Number(unsafe.bindings)).toBeGreaterThan(0); expect(Number(unsafe.proxy)).toBeGreaterThan(0);
    assertions.push({ stage: "f90 exact expression executes candidate getters and proxy traps", sourceSHA256: createHash("sha256").update(legacySource).digest("hex"), expression, contexts: candidates, actual: unsafe });
    await call("reload");
    await assertSafeObservation("new document resets counters and safely re-identifies the observation world");
    const publicEvents = await call("wait_event", { subscriptionId: consoleSubscription.result.subscriptionId, after: consoleSubscription.result.cursor, waitMs: 0 }, true);
    expect(JSON.stringify(publicEvents.result)).toContain("forged-page-log");
    const nativeReceipts = consoleEvents.filter(event => event.type === "debug" && event.args?.[0]?.value === "surf-wax.observation-world.v1"
      && typeof event.args?.[1]?.value === "string" && event.args[1].value !== "forged-page-log");
    expect(nativeReceipts.length).toBeGreaterThan(0);
    for (const receipt of nativeReceipts) expect(JSON.stringify(publicEvents.result)).not.toContain(receipt.args[1].value);
    assertions.push({ stage: "only active matching internal receipts consumed; forged prefix stays visible", nativeReceipts: nativeReceipts.length });
    await call("unsubscribe_event", { subscriptionId: consoleSubscription.result.subscriptionId }, true);
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
      await writeFile(`${directory}/report.json`, JSON.stringify({ createdAt: new Date().toISOString(), startedAt: new Date(started).toISOString(),
        sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), sourceBefore, sourceAfter,
        sourcesStable: JSON.stringify(sourceBefore) === JSON.stringify(sourceAfter), failure, cleanupError, consoleEvents,
        harnessStatus: test.info().status, cleanupCompleted: !cleanupError, records, assertions, contexts, events }, null, 2));
    }
  }
});
