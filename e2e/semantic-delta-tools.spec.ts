import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, closeServer, readEvents, type MockResponse } from "./fixtures";
import { semanticDeltaFixture, semanticDeltaInteractionScore, semanticDeltaScore } from "./evaluation/semantic-delta-fixture";
import { applySemanticDelta, SemanticPages, type SemanticItem } from "./evaluation/semantic-state";
import { toolLifecycleEvidence } from "./evaluation/tool-lifecycle";

// A scripted provider consumes the real paginated observations, not a model score.
for (const seed of [17, 72]) test(`reassembles semantic continuations and acts on fresh refs (seed ${seed})`, async () => {
  test.setTimeout(300_000);
  const fixture = await semanticDeltaFixture(seed), responses: MockResponse[] = [];
  const provider = await startProvider(responses), opened = await openExtension();
  let problem: unknown, observationId = "", rounds = 0, pageCount = 0, fullPages = 0, deltaPages = 0, freshPages = 0, deltaChanges = 0, freshChecks = 0;
  let state: SemanticItem[] = [], pages = new SemanticPages(), cursor: string | undefined, kind: "full" | "delta" | "fresh" = "full";
  const frame = { by: "css", value: 'iframe[title="Semantic queue"]' };
  const done = () => textResponse("SEMANTIC_DELTA_TOOLS_DONE");
  const after = (handler: (result: any) => ReturnType<typeof commandResponse>): MockResponse => {
    const step: MockResponse = (request) => {
      const message = request.messages.findLast((item: any) => item.role === "tool");
      if (!message) { responses.unshift(step); return textResponse("Semantic queue"); }
      try { const content = message.content; return handler(JSON.parse(Array.isArray(content) ? content.find((part: any) => part.type === "text").text : content)); }
      catch (error) { problem = error; return done(); }
    };
    return step;
  };
  const capture = (nextKind: typeof kind) => {
    kind = nextKind; pages = new SemanticPages(); cursor = undefined;
    responses.unshift(readPage);
    return commandResponse("inspect_page", { budget: 6000, region: { by: "css", value: "main", frame }, ...(kind === "delta" ? { since: observationId } : { full: true }) }, `semantic-capture-${rounds}-${kind}`);
  };
  const act = (ref: string) => {
    responses.unshift(after((result) => {
      expect(result.ok).toBe(true); rounds++;
      responses.unshift(after((verified) => {
        expect(verified).toMatchObject({ ok: true, result: { verified: true } });
        return rounds === 12 ? done() : rounds === 1 ? capture("delta") : findNext();
      }));
      return commandResponse("verify_state", { target: { by: "css", value: "#progress", frame }, textIncludes: rounds === 12 ? "Queue complete" : `Completed ${rounds} of 12`, timeoutMs: 10_000 }, `semantic-progress-${rounds}`);
    }));
    return commandResponse("click", { target: { id: ref } }, `semantic-click-${rounds}`);
  };
  const findNext = () => {
    responses.unshift(after((result) => {
      expect(result.total).toBe(1);
      const ref = result.elements?.[0]?.id;
      expect(ref).toEqual(expect.any(String));
      return act(ref);
    }));
    return commandResponse("find_elements", { target: { by: "role", value: "button", name: "Next TASK-", frame } }, `semantic-find-${rounds}`);
  };
  const readPage: MockResponse = after((result) => {
    // The long aria-label suffix is never painted in this fixture. It must not
    // leak through any full, delta, continuation or lookahead page.
    expect(JSON.stringify(result)).not.toContain("海");
    expect(JSON.stringify(result)).not.toContain("🌊");
    cursor = pages.append(result, cursor); pageCount++;
    if (kind === "full") fullPages++; else if (kind === "delta") deltaPages++; else freshPages++;
    expect(pageCount).toBeLessThan(500);
    if (cursor) { responses.unshift(readPage); return commandResponse("inspect_page", { cursor, budget: 6000 }, `semantic-page-${pageCount}`); }
    const observation = pages.result();
    if (kind === "full") {
      expect(observation.mode).toBe("full"); state = observation.items;
      expect(state.length).toBeGreaterThanOrEqual(120);
    } else if (kind === "delta") {
      expect(observation).toMatchObject({ mode: "delta", baseObservationId: observationId }); deltaChanges += observation.items.length;
      state = applySemanticDelta(state, observation.items);
    } else {
      expect(observation.mode).toBe("full"); expect(observation.items).toEqual(state); freshChecks++;
    }
    observationId = observation.observationId;
    if (kind === "delta") return capture("fresh");
    // The narrow cross-frame buttons may have an unproven ellipsized name.
    // Resolve the current Next control explicitly and act on the fresh ref.
    return findNext();
  });
  try {
    const target = await opened.context.newPage(); await target.goto(fixture.origin);
    responses.push(
      commandResponse("verify_state", { target: { by: "css", value: "#progress", frame }, textIncludes: "Completed 0 of 12", timeoutMs: 10_000 }, "semantic-ready"),
      after((result) => { expect(result).toMatchObject({ ok: true, result: { verified: true } }); return capture("full"); }),
      textResponse("Semantic queue"),
    );
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill(fixture.prompt);
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("SEMANTIC_DELTA_TOOLS_DONE", { timeout: 280_000 });
    if (problem) throw problem;
    expect(rounds).toBe(12);
    expect(fullPages).toBeGreaterThan(1);
    expect(deltaPages).toBeGreaterThan(0);
    expect(freshPages).toBeGreaterThan(1);
    expect(deltaChanges).toBeGreaterThan(11);
    expect(freshChecks).toBe(1);
    await expect.poll(() => semanticDeltaScore(fixture.evidence())).toBe(true);
    expect(semanticDeltaInteractionScore(fixture.evidence())).toBe(true);
    expect(toolLifecycleEvidence(await readEvents(opened.page)).complete).toBe(true);
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); await closeServer(fixture.server); }
});
