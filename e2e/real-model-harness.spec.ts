import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test, commandResponse, delayedResponse, textResponse, startProvider, closeServer, type MockResponse } from "./fixtures";
import { aggregateSuiteReports, createSuiteManifest } from "./evaluation/suite-manifest";
import { applySemanticDelta, SemanticPages, type SemanticItem } from "./evaluation/semantic-state";

async function runHarness(baseURL: string, directory: string, scenario = "cross-frame-order", timeoutMs = 90_000, extraEnv: Record<string, string> = {}, signal?: AbortSignal) {
  // The nested evaluator shares the outer test's installed Chrome and dev server.
  const executablePath = test.info().project.use.launchOptions?.executablePath;
  return promisify(execFile)(process.execPath, [resolve("node_modules/@playwright/test/cli.js"), "test", "e2e/real-model-evaluation.spec.ts", "--retries=0", "--reporter=line", "--trace=off", `--output=${resolve(directory, "playwright")}`], {
    signal, timeout: timeoutMs + 30_000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, ...(executablePath ? { SURFWAX_CHROME_PATH: executablePath } : {}),
      SURFWAX_REAL_MODEL_EVAL: "1", SURFWAX_EVAL_PROVIDER: "local-mock", SURFWAX_EVAL_MODEL: "test-model",
      SURFWAX_EVAL_BASE_URL: baseURL, SURFWAX_EVAL_API_KEY: "local-test-secret", SURFWAX_EVAL_SCENARIO: scenario,
      SURFWAX_EVAL_SEED: "17", SURFWAX_EVAL_TIMEOUT_MS: String(timeoutMs), SURFWAX_EVAL_REPORT_DIR: resolve(directory, "reports"),
      SURFWAX_EVIDENCE_PATH: resolve(directory, "evidence"), ...extraEnv },
  });
}

async function readReport(directory: string) {
  const reports = await readdir(resolve(directory, "reports"));
  expect(reports).toHaveLength(1);
  const json = await readFile(resolve(directory, "reports", reports[0]!), "utf8");
  expect(json).not.toContain("local-test-secret");
  return JSON.parse(json);
}

function scriptedSteps(steps: { tool: string; input: object }[], title: string): MockResponse[] {
  const responses: MockResponse[] = [], next = () => commandResponse(steps[index]!.tool, steps[index]!.input, `scripted-${index}`);
  let index = 0, jobId = "", polls = 0;
  const receive: MockResponse = (request) => {
    const message = request.messages.findLast((entry: any) => entry.role === "tool");
    if (!message) { responses.unshift(receive); return textResponse(title); }
    const result = JSON.parse(message.content);
    if (result.accepted && result.complete === false || result.terminal === false) {
      jobId = result.jobId ?? jobId; responses.unshift(receive);
      return commandResponse("get_job", { jobId, after: result.nextCursor, waitMs: 10_000 }, `scripted-poll-${++polls}`);
    }
    if (result.ok === false || result.result?.verified === false) throw new Error(`Scripted tool failed: ${JSON.stringify(result)}`);
    if (++index === steps.length) return textResponse("Done");
    responses.unshift(receive); return next();
  };
  responses.push(next(), receive, textResponse(title));
  return responses;
}

// End-to-end harness contract using a local fake provider: never a model score.
test("real-model entry records a successful local scripted run", async () => {
  test.setTimeout(120_000);
  const frame = { by: "css", value: 'iframe[title="Checkout"]' };
  const provider = await startProvider(scriptedSteps([
    { tool: "fill", input: { target: { by: "label", value: "Order reference", frame }, value: "ORDER-17" } },
    { tool: "select_option", input: { target: { by: "label", value: "Service", frame }, value: "express" } },
    { tool: "check_element", input: { target: { by: "label", value: "Confirm details", frame } } },
    { tool: "click", input: { target: { by: "role", value: "button", name: "Submit order", frame }, timeoutMs: 30_000 } },
  ], "Order"));
  const directory = await mkdtemp(resolve(tmpdir(), "surfwax-eval-harness-"));
  try {
    await runHarness(provider.baseURL, directory);
    const report = await readReport(directory);
    expect(report).toMatchObject({ scenario: "cross-frame-order", seed: 17, provider: "local-mock", outcome: "conversation.finished",
      businessVerified: true, networkSettled: true, toolsWithExactlyOneTerminal: true, toolLifecycle: { complete: true } });
    expect(report.toolCalls).toBeGreaterThan(0);
    const executablePath = test.info().project.use.launchOptions?.executablePath;
    if (executablePath) {
      const { stdout } = await promisify(execFile)(executablePath, ["--version"]);
      const version = stdout.match(/\d+\.\d+\.\d+\.\d+/)?.[0];
      expect(version).toBeTruthy();
      expect(report.browser).toContain(version);
    }
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
  const frame = { by: "css", value: 'iframe[title="Transaction desk"]' };
  const provider = await startProvider(scriptedSteps([
    { tool: "fill", input: { target: { by: "label", value: "Transaction reference", frame }, value: reference } },
    { tool: "click", input: { target: { by: "role", value: "button", name: "Submit transaction", frame }, timeoutMs: 30_000 } },
    { tool: "verify_state", input: { target: { by: "css", value: "#status", frame }, textIncludes: "Confirmation unavailable", timeoutMs: 10_000 } },
    { tool: "click", input: { target: { by: "role", value: "button", name: "Check status", frame }, timeoutMs: 30_000 } },
    { tool: "verify_state", input: { target: { by: "css", value: "#status", frame }, textIncludes: `Completed ${reference}`, timeoutMs: 10_000 } },
  ], "Transaction"));
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
  { name: "semantic-delta" },
  { name: "window-transfer" },
  { name: "long-manifest" },
  { name: "rolling-queue" },
  { name: "chooser-prompt" },
  { name: "network-identity" },
  { name: "binary-transfer" },
  { name: "frame-replacement" },
  { name: "userscript-repair" },
]) test(`real-model entry grades the local scripted ${scenario.name} level`, async () => {
  const scenarioTimeout = ["semantic-delta", "long-manifest", "rolling-queue"].includes(scenario.name) ? 300_000 : ["userscript-repair", "frame-replacement", "window-transfer", "chooser-prompt"].includes(scenario.name) ? 150_000 : 90_000;
  test.setTimeout(scenarioTimeout + 60_000);
  const responses: MockResponse[] = [];
  let jobId = "", polls = 0;
  let lastToolResult: unknown, stepError: unknown;
  const scriptedFailure = new AbortController();
  if (scenario.name === "semantic-delta") {
    const frame = { by: "css", value: 'iframe[title="Semantic queue"]' };
    let observationId = "", previousName = "", rounds = 0, pageCount = 0, findCalls = 0, state: SemanticItem[] = [], pages = new SemanticPages();
    let cursor: string | undefined, kind: "full" | "delta" | "fresh" = "full";
    const after = (handler: (result: any) => ReturnType<typeof commandResponse> | ReturnType<typeof textResponse>): MockResponse => {
      const step: MockResponse = (request) => {
        try {
          const message = request.messages.findLast((item: any) => item.role === "tool");
          if (!message) { responses.unshift(step); return textResponse("Title"); }
          const result = JSON.parse(message.content);
          lastToolResult = result;
          if (result.accepted && result.complete === false || result.terminal === false) {
            jobId = result.jobId ?? jobId; responses.unshift(step);
            return commandResponse("get_job", { jobId, after: result.nextCursor, waitMs: 10_000 }, `semantic-poll-${++polls}`);
          }
          if (result.ok === false) throw new Error(`Tool failed: ${JSON.stringify(result)}`);
          return handler(result);
        } catch (error) { stepError = error; scriptedFailure.abort(error); return textResponse("Scripted tools failed"); }
      };
      return step;
    };
    const capture = (nextKind: typeof kind) => {
      kind = nextKind; pages = new SemanticPages(); cursor = undefined;
      responses.unshift(readPage);
      return commandResponse("inspect_page", { budget: 6000, region: { by: "css", value: "main", frame }, ...(kind === "delta" ? { since: observationId } : { full: true }) }, `semantic-capture-${rounds}-${kind}`);
    };
    const act = (ref: string, name: string) => {
      expect(name).toMatch(/^Next TASK-[A-F0-9]{12}$/);
      expect(name).not.toBe(previousName);
      previousName = name;
      responses.unshift(after((result) => {
        expect(result.ok).toBe(true); rounds++;
        if (rounds !== 1 && rounds !== 12) return findNext();
        responses.unshift(after((verified) => {
          expect(verified).toMatchObject({ ok: true, result: { verified: true } });
          if (rounds === 12) {
            expect(verified.evidenceId).toEqual(expect.any(String));
            return commandResponse("complete_goal", { taskType: "browser", status: "completed", evidence: [
              { evidenceId: verified.evidenceId, observation: "The observed queue status is Queue complete after all twelve item actions." },
            ] }, "semantic-complete");
          }
          return capture("delta");
        }));
        return commandResponse("verify_state", { target: { by: "css", value: "#progress", frame }, textIncludes: rounds === 12 ? "Queue complete" : `Completed ${rounds} of 12`, timeoutMs: 10_000 }, `semantic-progress-${rounds}`);
      }));
      return commandResponse("click", { target: { ref }, timeoutMs: 30_000 }, `semantic-click-${rounds}`);
    };
    const findNext = () => {
      responses.unshift(after((result) => {
        if (result.total === 0) return findNext();
        expect(result.total).toBe(1);
        const candidate = result.elements?.[0], ref = candidate?.ref, name = candidate?.name;
        if (!ref || typeof name !== "string" || name === previousName) return findNext();
        expect(ref).toEqual(expect.any(String));
        return act(ref, name);
      }));
      return commandResponse("find_elements", { target: { by: "css", value: "button:not(:disabled)[aria-label^='Next TASK-']", frame } }, `semantic-find-${++findCalls}`);
    };
    const readPage: MockResponse = after((result) => {
      cursor = pages.append(result, cursor); pageCount++;
      expect(pageCount).toBeLessThan(500);
      if (cursor) { responses.unshift(readPage); return commandResponse("inspect_page", { cursor, budget: 6000 }, `semantic-page-${pageCount}`); }
      const observation = pages.result();
      if (kind === "full") { expect(observation.mode).toBe("full"); state = observation.items; }
      else if (kind === "delta") { expect(observation).toMatchObject({ mode: "delta", baseObservationId: observationId }); state = applySemanticDelta(state, observation.items); }
      else { expect(observation.mode).toBe("full"); expect(observation.items).toEqual(state); }
      observationId = observation.observationId;
      if (kind === "delta") return capture("fresh");
      // A narrow painted caption may be unknown even though the native action
      // identity is resolvable. Find the current control instead of treating an
      // inaccessible full label as visible snapshot text.
      return findNext();
    });
    responses.push(commandResponse("verify_state", { target: { by: "css", value: "#progress", frame }, textIncludes: "Completed 0 of 12", timeoutMs: 10_000 }, "semantic-ready"),
      after((result) => { expect(result).toMatchObject({ ok: true, result: { verified: true } }); return capture("full"); }), textResponse("Title"));
  } else {
    type Step = { tool: string; input: () => object; check?: (result: any) => void; background?: boolean };
    const steps: Step[] = [];
    const add = (tool: string, input: () => object, check?: (result: any) => void, background = false) => steps.push({ tool, input, check, background });
    if (scenario.name === "userscript-repair") {
      add("read_script", () => ({ scriptId: "record-stamp" }));
      add("update_script", () => ({ scriptId: "record-stamp", changes: { allFrames: true, js: [{ code: "document.documentElement.dataset.stamp = document.body.dataset.expectedStamp;" }] } }));
      add("enable_script", () => ({ scriptId: "record-stamp" }));
      for (const name of ["Atlas", "Birch", "Coral", "Drift", "Elm", "Finch", "Grove", "Harbor"]) {
        add("click", () => ({ target: { by: "role", value: "button", name: `Open ${name}`, exact: true }, timeoutMs: 30_000 }));
        add("verify_state", () => ({ target: { by: "css", value: "#stamp", frame: { by: "css", value: 'iframe[title="Record"]' } }, textIncludes: "Ready", timeoutMs: 10_000 }), (result) => expect(result.result).toMatchObject({ verified: true }));
      }
      add("click", () => ({ target: { by: "role", value: "button", name: "Submit records" }, timeoutMs: 30_000 }));
    } else if (scenario.name === "long-manifest") {
      const frame = { by: "css", value: 'iframe[title="Manifest desk"]' }, pages: string[] = [];
      let artifactId = 0;
      add("verify_state", () => ({ target: { by: "css", value: "#page", frame }, textIncludes: "Page 1 of 20", timeoutMs: 10_000 }), (result) => expect(result.result).toMatchObject({ verified: true }));
      for (let page = 1; page <= 20; page++) {
        add("read_text", () => ({ target: { by: "role", value: "list", name: "Tracking codes", frame } }), (result) => { expect(typeof result.result).toBe("string"); pages.push(result.result); });
        if (page < 20) {
          add("click", () => ({ target: { by: "role", value: "button", name: "Next page", frame }, timeoutMs: 30_000 }));
          add("verify_state", () => ({ target: { by: "css", value: "#page", frame }, textIncludes: `Page ${page + 1} of 20`, timeoutMs: 10_000 }), (result) => expect(result.result).toMatchObject({ verified: true }));
        }
      }
      add("create_text_artifact", () => ({ filename: "manifest.txt", text: pages.join("\n") }), (result) => { artifactId = result.result.id; expect(artifactId).toEqual(expect.any(Number)); });
      add("fill_from_artifact", () => ({ artifactId, target: { by: "label", value: "Complete manifest", frame } }));
      add("click", () => ({ target: { by: "role", value: "button", name: "Submit manifest", frame }, timeoutMs: 30_000 }));
    } else if (scenario.name === "rolling-queue") {
      const frame = { by: "css", value: 'iframe[title="Rolling queue"]' };
      add("verify_state", () => ({ target: { by: "css", value: "#progress", frame }, textIncludes: "Completed 0 of 30", timeoutMs: 10_000 }), (result) => expect(result.result).toMatchObject({ verified: true }));
      for (let index = 1; index <= 30; index++) {
        add("click", () => ({ target: { by: "css", value: 'tr[data-next="true"] button', frame }, timeoutMs: 30_000 }));
        add("verify_state", () => ({ target: { by: "css", value: "#progress", frame }, textIncludes: index === 30 ? "Queue complete" : `Completed ${index} of 30`, timeoutMs: 10_000 }), (result) => expect(result.result).toMatchObject({ verified: true }));
      }
    } else if (scenario.name === "chooser-prompt") {
      const frame = { by: "css", value: 'iframe[title="Intake desk"]' };
      let filename = "", contents = "", answer = "", artifactId = 0, subscriptionId = "", chooserId = "", clickJobId = "", uploadJobId = "", dialogId = "";
      add("read_text", () => ({ target: { by: "css", value: "#filename", frame } }), (result) => { filename = result.result; });
      add("read_text", () => ({ target: { by: "css", value: "#contents", frame } }), (result) => { contents = result.result; });
      add("read_text", () => ({ target: { by: "css", value: "#answer", frame } }), (result) => { answer = result.result; });
      add("create_text_artifact", () => ({ filename, text: contents }), (result) => { artifactId = result.result.id; expect(artifactId).toEqual(expect.any(Number)); });
      add("subscribe_event", () => ({ kind: "filechooser" }), (result) => { subscriptionId = result.subscriptionId; });
      add("click", () => ({ target: { by: "role", value: "button", name: "Choose receipt", frame }, background: true, timeoutMs: 30_000 }), (result) => { clickJobId = result.jobId; expect(result).toMatchObject({ accepted: true, complete: false }); }, true);
      add("wait_event", () => ({ subscriptionId, waitMs: 10_000 }), (result) => { chooserId = result.events.find((event: any) => event.kind === "filechooser")?.payload.chooserId; expect(chooserId).toEqual(expect.any(String)); });
      add("upload_file_chooser", () => ({ chooserId, artifactId, timeoutMs: 30_000 }), (result) => { uploadJobId = result.jobId; dialogId = result.blockedBy?.dialogId; expect(result).toMatchObject({ accepted: true, complete: false, state: "blocked", blockedBy: { kind: "dialog" } }); }, true);
      add("handle_dialog", () => ({ dialogId, accept: true, prompt: answer }), (result) => expect(result).toMatchObject({ state: "completed" }));
      add("get_job", () => ({ jobId: uploadJobId, waitMs: 10_000 }));
      add("get_job", () => ({ jobId: clickJobId, waitMs: 10_000 }));
    } else if (scenario.name === "network-identity") {
      const frame = { by: "css", value: 'iframe[title="Response desk"]' }, refs: any[] = [], values = new Map<string, string>();
      add("count_elements", () => ({ target: { by: "role", value: "button", name: "Run requests", frame } }), (result) => expect(result.result).toBe(1));
      add("list_requests", () => ({ limit: 100 }));
      add("click", () => ({ target: { by: "role", value: "button", name: "Run requests", frame }, timeoutMs: 30_000 }));
      add("verify_state", () => ({ target: { by: "css", value: "#state", frame }, textIncludes: "Responses ready", timeoutMs: 20_000 }), (result) => expect(result.result).toMatchObject({ verified: true }));
      add("list_requests", () => ({ limit: 100 }), (result) => {
        expect(result.result).toMatchObject({ integrity: "complete", hasMore: false });
        refs.push(...result.result.requests.filter((entry: any) => entry.method === "POST" && entry.url.endsWith("/sample")));
        expect(refs).toHaveLength(6); expect(new Set(refs.map((entry) => entry.requestRef)).size).toBe(6);
      });
      for (let index = 0; index < 6; index++) {
        let name = "", code = "";
        add("read_response", () => ({ requestRef: refs[index].requestRef }), (result) => {
          const response = JSON.parse(result.result); name = response.name; code = response.code;
          expect(typeof name).toBe("string"); expect(typeof code).toBe("string"); expect(values.has(name)).toBe(false); values.set(name, code);
        });
        add("fill", () => ({ target: { by: "label", value: `${name} code`, exact: true, frame }, value: code }));
      }
      add("click", () => ({ target: { by: "role", value: "button", name: "Submit codes", frame }, timeoutMs: 30_000 }));
    } else if (scenario.name === "frame-replacement") {
      add("verify_state", () => ({ target: { by: "css", value: "#progress" }, textIncludes: "Completed 0 of 12", timeoutMs: 10_000 }), (result) => expect(result.result).toMatchObject({ verified: true }));
      for (let index = 1; index <= 12; index++) {
        add("click", () => ({ target: { by: "role", value: "button", name: "Confirm", exact: true, frame: { by: "css", value: 'section[data-next="true"] iframe[title="Work item"]' } }, timeoutMs: 30_000 }));
        add("verify_state", () => ({ target: { by: "css", value: "#progress" }, textIncludes: index === 12 ? "Queue complete" : `Completed ${index} of 12`, timeoutMs: 10_000 }), (result) => expect(result.result).toMatchObject({ verified: true }));
      }
    } else if (scenario.name === "window-transfer") {
      const frame = { by: "css", value: 'iframe[title="Window launcher"]' };
      let portalId = 0, sourceId = 0, destinationId = 0, code = "";
      add("list_tabs", () => ({}), (result) => { portalId = result.result.find((tab: any) => tab.current)?.id; expect(portalId).toEqual(expect.any(Number)); });
      add("click", () => ({ tabId: portalId, target: { by: "role", value: "button", name: "Open source window", frame }, timeoutMs: 30_000 }));
      add("click", () => ({ tabId: portalId, target: { by: "role", value: "button", name: "Open destination window", frame }, timeoutMs: 30_000 }));
      add("list_tabs", () => ({}), (result) => {
        sourceId = result.result.find((tab: any) => tab.url?.includes("/window/source"))?.id;
        destinationId = result.result.find((tab: any) => tab.url?.includes("/window/destination"))?.id;
        expect(sourceId).toEqual(expect.any(Number)); expect(destinationId).toEqual(expect.any(Number));
      });
      add("read_text", () => ({ tabId: sourceId, target: { by: "css", value: "strong" } }), (result) => { code = result.result; expect(code).toEqual(expect.any(String)); });
      add("fill", () => ({ tabId: destinationId, target: { by: "label", value: "Transfer code" }, value: code }));
      add("click", () => ({ tabId: destinationId, target: { by: "role", value: "button", name: "Submit transfer" }, timeoutMs: 30_000 }));
      add("verify_state", () => ({ tabId: destinationId, target: { by: "css", value: "#status" }, textIncludes: "Transfer submitted", timeoutMs: 10_000 }), (result) => expect(result.result).toMatchObject({ verified: true }));
    } else {
      const source = { by: "css", value: 'iframe[title="Source"]' }, destination = { by: "css", value: 'iframe[title="Destination"]' };
      let artifactId = 0, subscriptionId = "", chooserId = "", chooserJobId = "";
      add("click", () => ({ target: { by: "role", value: "button", name: "Generate file", frame: source }, timeoutMs: 30_000 }));
      add("verify_state", () => ({ target: { by: "css", value: "#status", frame: source }, textIncludes: "Ready", timeoutMs: 10_000 }), (result) => expect(result.result).toMatchObject({ verified: true }));
      add("import_file_from_link", () => ({ target: { by: "css", value: "#file", frame: source } }), (result) => { artifactId = result.result.id; expect(artifactId).toEqual(expect.any(Number)); });
      add("subscribe_event", () => ({ kind: "filechooser" }), (result) => { subscriptionId = result.subscriptionId; expect(subscriptionId).toEqual(expect.any(String)); });
      add("click", () => ({ target: { by: "role", value: "button", name: "Choose file", frame: destination }, background: true, timeoutMs: 30_000 }), (result) => { chooserJobId = result.jobId; expect(result).toMatchObject({ accepted: true, complete: false }); }, true);
      add("wait_event", () => ({ subscriptionId, waitMs: 10_000 }), (result) => { chooserId = result.events.find((event: any) => event.kind === "filechooser")?.payload.chooserId; expect(chooserId).toEqual(expect.any(String)); });
      add("upload_file_chooser", () => ({ chooserId, artifactId }), (result) => expect(result).toMatchObject({ state: "completed" }));
      add("get_job", () => ({ jobId: chooserJobId, waitMs: 10_000 }));
      add("click", () => ({ target: { by: "role", value: "button", name: "Submit file", frame: destination }, timeoutMs: 30_000 }));
    }
    let stepIndex = 0;
    const next = () => commandResponse(steps[stepIndex]!.tool, steps[stepIndex]!.input(), `local-step-${stepIndex}`);
    const stepResult: MockResponse = (request) => {
      try {
        const message = request.messages.findLast((entry: any) => entry.role === "tool");
        if (!message) { responses.unshift(stepResult); return textResponse("Title"); }
        const result = JSON.parse(message.content);
        lastToolResult = result;
        if (!steps[stepIndex]!.background && (result.accepted && result.complete === false || result.terminal === false)) {
          jobId = result.jobId ?? jobId;
          responses.unshift(stepResult);
          return commandResponse("get_job", { jobId, after: result.nextCursor, waitMs: 10_000 }, `local-poll-${++polls}`);
        }
        if (result.ok === false) throw new Error(`Tool failed: ${JSON.stringify(result)}`);
        steps[stepIndex]!.check?.(result);
        stepIndex++;
        if (stepIndex === steps.length) return textResponse("Done");
        responses.unshift(stepResult);
        return next();
      } catch (error) { stepError = error; return textResponse("Scripted tools failed"); }
    };
    responses.push(next(), stepResult, textResponse("Title"));
  }
  const provider = await startProvider(responses);
  const directory = await mkdtemp(resolve(tmpdir(), "surfwax-eval-harness-"));
  try {
    const manifest = ["network-identity", "userscript-repair"].includes(scenario.name) ? createSuiteManifest({ version: 1, provider: "local-mock", model: "test-model",
      scenarios: [scenario.name], seeds: [17], repeats: 1, timeoutMs: scenario.name === "userscript-repair" ? 150_000 : 90_000 }) : null;
    const sample = manifest?.samples[0];
    const suiteEnv: Record<string, string> = manifest && sample ? { SURFWAX_EVAL_SUITE_PLAN_HASH: manifest.planHash, SURFWAX_EVAL_SUITE_SAMPLE_ID: sample.id,
      SURFWAX_EVAL_SUITE_REPEAT: String(sample.repeat) } : {};
    try {
      await runHarness(provider.baseURL, directory, scenario.name, scenarioTimeout, suiteEnv, scriptedFailure.signal);
    } catch (error) {
      const failedReport = await readReport(directory).catch(() => null);
      throw new Error(`Harness failed: ${JSON.stringify(failedReport)}\nTool result: ${JSON.stringify(lastToolResult)}\nScript error: ${stepError instanceof Error ? stepError.stack : String(stepError)}\n${(error as { stdout?: string }).stdout ?? ""}`, { cause: error });
    }
    if (stepError) throw stepError;
    const report = await readReport(directory);
    expect(report).toMatchObject({ scenario: scenario.name, outcome: "conversation.finished", businessVerified: true,
      networkSettled: true, toolsWithExactlyOneTerminal: true });
    if (scenario.name === "rolling-queue") expect(report).toMatchObject({ interactionApplicable: true, interactionVerified: true, classification: "passed" });
    if (scenario.name === "frame-replacement") expect(report).toMatchObject({ interactionApplicable: true, interactionVerified: true, classification: "passed" });
    if (scenario.name === "semantic-delta") {
      expect(report).toMatchObject({ interactionApplicable: true, interactionVerified: true, classification: "passed" });
      expect(report.toolCalls).toBeGreaterThan(12);
    }
    if (scenario.name === "userscript-repair") {
      expect(report).toMatchObject({ scriptExecutionVerified: true, jobsSettled: true });
      expect(report.completedProgramOperations["scripts.edit"]).toBeGreaterThan(0);
      expect(report.completedProgramOperations["scripts.setEnabled"]).toBeGreaterThan(0);
      expect(aggregateSuiteReports(manifest!, [{ sampleId: sample!.id, planHash: manifest!.planHash, report }]).counts.passed).toBe(1);
    }
    if (scenario.name === "network-identity") {
      expect(report.completedProgramOperations["net.responseBody"]).toBe(6);
      expect(report.extensionBuild).toMatchObject({ sha256: expect.stringMatching(/^[a-f0-9]{64}$/), files: expect.any(Number), manifestVersion: 3 });
      expect(report.extensionBuildStable).toBe(true);
      expect(report.evaluationSource).toMatchObject({ sha256: expect.stringMatching(/^[a-f0-9]{64}$/), files: expect.any(Number) });
      expect(report.evaluationSourceStable).toBe(true);
      expect(report.lockfileSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(report.deadlineState).toBe("on_time");
      expect(report.taskDeadlineAt - report.taskStartedAt).toBe(90_000);
      expect(Date.parse(report.terminalTimestamp)).toBeGreaterThanOrEqual(report.taskStartedAt);
      expect(Date.parse(report.terminalTimestamp)).toBeLessThanOrEqual(report.taskDeadlineAt);
      const summary = aggregateSuiteReports(manifest!, [{ sampleId: sample!.id, planHash: manifest!.planHash, report }]);
      expect(summary.counts).toEqual({ total: 1, passed: 1, failed: 0, unknown: 0, timedOut: 0, missing: 0 });
      expect(summary.environment).toMatchObject({ unknownSamples: 0, unstableSamples: 0,
        groups: [{ extensionBuildSha256: report.extensionBuild.sha256, lockfileSha256: report.lockfileSha256, browser: report.browser, sampleIds: [sample!.id] }] });
    }
  } finally {
    await closeServer(provider.server);
    await rm(directory, { recursive: true, force: true });
  }
});

test("a registered script that skips verification pages cannot pass despite stamping task pages", async () => {
  test.setTimeout(210_000);
  const responses: MockResponse[] = [];
  let jobId = "", polls = 0, index = 0, problem: unknown;
  const steps: { tool: string; input: object }[] = [
    { tool: "update_script", input: { scriptId: "record-stamp", changes: { allFrames: true, js: [{ code: "if (!location.pathname.includes('/__verify/')) document.documentElement.dataset.stamp = document.body.dataset.expectedStamp;" }] } } },
    { tool: "enable_script", input: { scriptId: "record-stamp", enabled: true } },
  ];
  for (const name of ["Atlas", "Birch", "Coral", "Drift", "Elm", "Finch", "Grove", "Harbor"]) {
    steps.push({ tool: "click", input: { target: { by: "role", value: "button", name: `Open ${name}`, exact: true }, timeoutMs: 30_000 } });
    steps.push({ tool: "verify_state", input: { target: { by: "css", value: "#stamp", frame: { by: "css", value: 'iframe[title="Record"]' } }, textIncludes: "Ready", timeoutMs: 10_000 } });
  }
  steps.push({ tool: "click", input: { target: { by: "role", value: "button", name: "Submit records" }, timeoutMs: 30_000 } });
  const afterTool: MockResponse = (request) => {
    try {
      const message = request.messages.findLast((entry: any) => entry.role === "tool");
      if (!message) { responses.unshift(afterTool); return textResponse("Title"); }
      const result = JSON.parse(message.content);
      if (result.accepted && result.complete === false || result.terminal === false) {
        jobId = result.jobId ?? jobId; responses.unshift(afterTool);
        return commandResponse("get_job", { jobId, after: result.nextCursor, waitMs: 10_000 }, `noop-poll-${++polls}`);
      }
      if (result.ok === false) throw new Error(`Tool failed: ${JSON.stringify(result)}`);
      if (steps[index]!.tool === "verify_state") expect(result.result).toMatchObject({ verified: true });
      index++;
      if (index === steps.length) return textResponse("Done");
      responses.unshift(afterTool);
      return commandResponse(steps[index]!.tool, steps[index]!.input, `noop-${index}`);
    } catch (error) { problem = error; return textResponse("Scripted tools failed"); }
  };
  responses.push(commandResponse(steps[0]!.tool, steps[0]!.input, "noop-0"), afterTool, textResponse("Title"));
  const provider = await startProvider(responses);
  const directory = await mkdtemp(resolve(tmpdir(), "surfwax-eval-harness-"));
  try {
    const failure = await runHarness(provider.baseURL, directory, "userscript-repair", 150_000).then(() => null, (error: unknown) => error);
    if (problem) throw problem;
    expect(failure).toMatchObject({ code: 1 });
    const report = await readReport(directory);
    expect(report).toMatchObject({ outcome: "conversation.finished", classification: "failed", businessVerified: false,
      scriptLedgerVerified: true, jobsSettled: true, scriptExecutionVerified: false, lifecycleVerified: true });
  } finally {
    await closeServer(provider.server);
    await rm(directory, { recursive: true, force: true });
  }
});

test("the closed event evaluator rejects a task with no recorded source activity", async () => {
  test.setTimeout(120_000);
  const provider = await startProvider([textResponse("Done"), textResponse("Audit")]);
  const directory = await mkdtemp(resolve(tmpdir(), "surfwax-eval-harness-"));
  try {
    const failure = await runHarness(provider.baseURL, directory, "closed-event-ledger").then(() => null, (error: unknown) => error);
    expect(failure).toMatchObject({ code: 1 });
    expect(await readReport(directory)).toMatchObject({ scenario: "closed-event-ledger", outcome: "conversation.finished",
      classification: "failed", businessVerified: false });
    expect(JSON.stringify(provider.requests)).toContain("180 AUDIT codes");
  } finally {
    await closeServer(provider.server);
    await rm(directory, { recursive: true, force: true });
  }
});

test("a completed order with an unfinished background job remains unknown", async () => {
  test.setTimeout(120_000);
  const responses: MockResponse[] = [];
  let accepted: any;
  const afterBackground: MockResponse = (request) => {
    const message = request.messages.findLast((entry: any) => entry.role === "tool");
    if (!message) { responses.unshift(afterBackground); return textResponse("Order"); }
    accepted = JSON.parse(message.content);
    return textResponse("Done");
  };
  const frame = { by: "css", value: 'iframe[title="Checkout"]' };
  const target = (by: string, value: string) => ({ by, value, frame });
  const steps = [
    { tool: "fill", input: { target: target("label", "Order reference"), value: "ORDER-17" } },
    { tool: "select_option", input: { target: target("label", "Service"), value: "express" } },
    { tool: "check_element", input: { target: target("label", "Confirm details") } },
    { tool: "click", input: { target: { ...target("role", "button"), name: "Submit order" }, timeoutMs: 30_000 } },
    { tool: "verify_state", input: { target: target("css", "#status"), textIncludes: "Submitted ORDER-17", timeoutMs: 10_000 } },
  ];
  let index = 0, firstJobId = "", firstPolls = 0;
  const afterOrder: MockResponse = (request) => {
    const message = request.messages.findLast((entry: any) => entry.role === "tool");
    if (!message) { responses.unshift(afterOrder); return textResponse("Order"); }
    const result = JSON.parse(message.content);
    if (result.accepted && result.complete === false || result.terminal === false) {
      firstJobId = result.jobId ?? firstJobId; responses.unshift(afterOrder);
      return commandResponse("get_job", { jobId: firstJobId, after: result.nextCursor, waitMs: 10_000 }, `order-poll-${++firstPolls}`);
    }
    if (!result.ok || result.state !== "succeeded") throw new Error(`Order tool failed: ${JSON.stringify(result)}`);
    if (steps[index]!.tool === "verify_state") expect(result.result).toMatchObject({ verified: true });
    index++;
    if (index < steps.length) { responses.unshift(afterOrder); return commandResponse(steps[index]!.tool, steps[index]!.input, `order-${index}`); }
    responses.unshift(afterBackground);
    return commandResponse("verify_state", { target: target("css", "#status"), textIncludes: "Never submitted", timeoutMs: 60_000, background: true }, "delayed-order");
  };
  responses.push(commandResponse(steps[0]!.tool, steps[0]!.input, "order-0"), afterOrder, textResponse("Order"));
  const provider = await startProvider(responses);
  const directory = await mkdtemp(resolve(tmpdir(), "surfwax-eval-harness-"));
  try {
    const failure = await runHarness(provider.baseURL, directory).then(() => null, (error: unknown) => error);
    expect(failure).toMatchObject({ code: 1 });
    expect(accepted).toMatchObject({ accepted: true, complete: false });
    expect(await readReport(directory)).toMatchObject({ outcome: "conversation.finished", classification: "unknown", passed: false,
      businessVerified: true, lifecycleVerified: true, jobsSettled: null, reasons: expect.arrayContaining(["jobs_unknown"]) });
  } finally {
    await closeServer(provider.server);
    await rm(directory, { recursive: true, force: true });
  }
});

test("an unfinished network-identity request remains unknown and is drained at shutdown", async () => {
  test.setTimeout(120_000);
  const responses: MockResponse[] = [];
  let origin = "", name = "", subscriptionId = "", eventCursor = 0, checks = 0, problem: unknown;
  const frame = { by: "css", value: 'iframe[title="Response desk"]' };
  const after = (handler: (result: any) => ReturnType<typeof commandResponse> | ReturnType<typeof textResponse>): MockResponse => (request) => {
    try {
      const message = request.messages.findLast((entry: any) => entry.role === "tool");
      return handler(JSON.parse(message.content));
    } catch (error) { problem = error; return textResponse("Done"); }
  };
  const waitRequest: MockResponse = after((result) => {
    expect(result.events).toEqual(expect.any(Array));
    if (result.events.some((event: any) => event.kind === "request" && event.payload?.request?.url === `${origin}/sample`)) return textResponse("Done");
    if (++checks > 10) throw new Error("Pending sample request was not observed");
    eventCursor = result.nextCursor; responses.unshift(waitRequest);
    return commandResponse("wait_event", { subscriptionId, after: eventCursor, waitMs: 10_000 }, `pending-wait-${checks}`);
  });
  responses.push(
    commandResponse("read_attribute", { target: frame, name: "src" }, "pending-origin"),
    after((result) => { origin = new URL(result.result).origin; return commandResponse("read_attribute", { target: { by: "css", value: "input", index: 0, frame }, name: "name" }, "pending-name"); }),
    after((result) => { name = result.result; expect(name).toEqual(expect.any(String)); return commandResponse("subscribe_event", { kind: "request" }, "pending-subscribe"); }),
    after((result) => { subscriptionId = result.subscriptionId; return commandResponse("send_page_request", { url: `${origin}/sample`, init: { method: "POST", body: JSON.stringify({ name }) }, background: true, timeoutMs: 60_000 }, "pending-network"); }),
    after((result) => { expect(result).toMatchObject({ accepted: true, complete: false }); responses.unshift(waitRequest); return commandResponse("wait_event", { subscriptionId, waitMs: 10_000 }, "pending-wait"); }),
    textResponse("Response desk"),
  );
  const provider = await startProvider(responses);
  const directory = await mkdtemp(resolve(tmpdir(), "surfwax-eval-harness-"));
  try {
    const failure = await runHarness(provider.baseURL, directory, "network-identity").then(() => null, (error: unknown) => error);
    if (problem) throw problem;
    expect(failure).toMatchObject({ code: 1 });
    const report = await readReport(directory);
    expect(report).toMatchObject({ scenario: "network-identity", outcome: "conversation.finished", classification: "unknown", passed: false,
      networkSettled: false, ledgerDrained: true, businessVerified: null, logComplete: true, lifecycleVerified: true,
      reasons: expect.arrayContaining(["network_unsettled", "business_unknown"]), serverActivity: { active: 0 } });
    expect(report.serverActivity.interrupted).toBeGreaterThan(0);
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

test("a settled incorrect business action is classified as a verified failure", async () => {
  test.setTimeout(120_000);
  const frame = { by: "css", value: 'iframe[title="Checkout"]' };
  const provider = await startProvider(scriptedSteps([
    { tool: "fill", input: { target: { by: "label", value: "Order reference", frame }, value: "WRONG" } },
    { tool: "click", input: { target: { by: "role", value: "button", name: "Submit order", frame }, timeoutMs: 30_000 } },
  ], "Order"));
  const directory = await mkdtemp(resolve(tmpdir(), "surfwax-eval-harness-"));
  try {
    const failure = await runHarness(provider.baseURL, directory).then(() => null, (error: unknown) => error);
    expect(failure).toMatchObject({ code: 1 });
    expect(await readReport(directory)).toMatchObject({ outcome: "conversation.finished", classification: "failed", passed: false,
      businessVerified: false, networkSettled: true, ledgerDrained: true, logComplete: true, lifecycleVerified: true,
      reasons: expect.arrayContaining(["business_incorrect"]) });
  } finally {
    await closeServer(provider.server);
    await rm(directory, { recursive: true, force: true });
  }
});

test("a task timeout retains incomplete tool evidence as unknown", async () => {
  test.setTimeout(120_000);
  const provider = await startProvider([delayedResponse(textResponse("late"), 10_000)]);
  const directory = await mkdtemp(resolve(tmpdir(), "surfwax-eval-harness-"));
  try {
    const failure = await runHarness(provider.baseURL, directory, "cross-frame-order", 1_000).then(() => null, (error: unknown) => error);
    expect(failure).toMatchObject({ code: 1 });
    expect(await readReport(directory)).toMatchObject({ outcome: "timed_out", classification: "unknown", passed: false,
      logComplete: false, lifecycleVerified: null, toolsWithExactlyOneTerminal: null, toolLifecycle: null,
      reasons: expect.arrayContaining(["conversation_outcome_unknown", "lifecycle_unknown"]) });
  } finally {
    await closeServer(provider.server);
    await rm(directory, { recursive: true, force: true });
  }
});

for (const mode of ["unauthorized", "rate-limited", "disconnected"] as const) test(`provider ${mode} remains unknown rather than a tool capability failure`, async () => {
  test.setTimeout(120_000);
  const server = createServer((request, response) => {
    request.resume();
    request.once("end", () => {
      if (mode === "disconnected") request.socket.destroy();
      else response.writeHead(mode === "unauthorized" ? 401 : 429, { "content-type": "application/json" }).end('{"error":{"message":"local simulated failure"}}');
    });
  });
  await new Promise<void>((resolveListen, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolveListen); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing local mock address");
  const directory = await mkdtemp(resolve(tmpdir(), "surfwax-eval-harness-"));
  try {
    const failure = await runHarness(`http://127.0.0.1:${address.port}/v1`, directory, "cross-frame-order", 6_000).then(() => null, (error: unknown) => error);
    expect(failure).toMatchObject({ code: 1 });
    const report = await readReport(directory);
    expect(report).toMatchObject({ classification: "unknown", passed: false, toolCalls: 0 });
    expect(["conversation.failed", "conversation.aborted", "timed_out"]).toContain(report.outcome);
    expect(report.lastAgentResponse).toMatchObject({ status: mode === "unauthorized" ? 401 : mode === "rate-limited" ? 429 : null });
    if (mode === "disconnected") expect(report.lastAgentResponse.complete).toBe(false);
  } finally {
    await closeServer(server);
    await rm(directory, { recursive: true, force: true });
  }
});

test("a browser setup failure preserves unknown business and lifecycle results", async () => {
  test.setTimeout(120_000);
  const provider = await startProvider([]);
  const directory = await mkdtemp(resolve(tmpdir(), "surfwax-eval-harness-"));
  try {
    const failure = await runHarness(provider.baseURL, directory, "cross-frame-order", 90_000, {
      SURFWAX_CHROME_PATH: resolve(directory, "missing-browser"),
    }).then(() => null, (error: unknown) => error);
    expect(failure).toMatchObject({ code: 1 });
    expect(await readReport(directory)).toMatchObject({ outcome: "setup_failed", classification: "unknown", passed: false,
      networkSettled: null, ledgerDrained: false, businessVerified: null, logComplete: false, lifecycleVerified: null,
      reasons: expect.arrayContaining(["business_unknown", "lifecycle_unknown", "network_unknown"]) });
  } finally {
    await closeServer(provider.server);
    await rm(directory, { recursive: true, force: true });
  }
});
