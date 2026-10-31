import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, closeServer, readEvents, type MockResponse } from "./fixtures";
import { networkFixture, networkScore } from "./evaluation/network-level-fixture";
import { completedProgramOperations, toolLifecycleEvidence } from "./evaluation/tool-lifecycle";

// Scripted choices validate the network tool path, not a model's performance.
test("extension distinguishes concurrent same-URL responses using their request references", async () => {
  test.setTimeout(90_000);
  const fixture = await networkFixture(17), responses: MockResponse[] = [];
  const provider = await startProvider(responses), opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(fixture.origin);
    let result: any;
    const step: MockResponse = (request) => {
      const message = request.messages.findLast((entry: any) => entry.role === "tool");
      if (!message) { responses.unshift(step); return textResponse("Response desk"); }
      result = JSON.parse(message.content);
      return textResponse("NETWORK_IDENTITY_TOOL_DONE");
    };
    responses.push(commandResponse("execute_program", { timeoutMs: 60_000, code: `
      const desk = page.frameLocator('iframe[title="Response desk"]');
      // Bind and observe before the run; requests made before attachment are not history.
      await desk.getByRole('button', {name:'Run requests'}).count();
      await net.requests({limit:100});
      await desk.getByRole('button', {name:'Run requests'}).click();
      await desk.locator('#state').filter({hasText:'Responses ready'}).waitFor();
      const captured = await net.requests({limit:100});
      if (captured.integrity !== 'complete' || captured.hasMore !== false) throw new Error('Network history is incomplete');
      const refs = captured.requests.filter(item => item.method === 'POST' && item.url.endsWith('/sample'));
      if (refs.length !== 6 || new Set(refs.map(item => item.requestRef)).size !== 6) throw new Error('Expected six distinct captured requests');
      const values = {};
      for (const entry of refs) {
        const body = await net.responseBody(entry.requestRef);
        if (typeof body !== 'string') throw new Error('Response body unavailable');
        const response = JSON.parse(body);
        if (typeof response.name !== 'string' || typeof response.code !== 'string' || values[response.name]) throw new Error('Invalid or duplicate response');
        values[response.name] = response.code;
      }
      for (const [name, code] of Object.entries(values)) await desk.getByLabel(name + ' code', {exact:true}).fill(code);
      await desk.getByRole('button', {name:'Submit codes'}).click();
      return {references: refs.length, unique: new Set(refs.map(item => item.requestRef)).size, names: Object.keys(values).length, historyComplete: true};`,
    }, "network-identity"), step, textResponse("Response desk"));
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill(fixture.prompt);
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("NETWORK_IDENTITY_TOOL_DONE", { timeout: 75_000 });
    const events = await readEvents(opened.page);
    expect(result, JSON.stringify(events.filter((event) => event.type === "browser.job.progress").map((event) => event.content))).toMatchObject({
      ok: true, state: "succeeded", result: { references: 6, unique: 6, names: 6, historyComplete: true },
    });
    await expect.poll(() => networkScore(fixture.evidence())).toBe(true);
    const operations = completedProgramOperations(events);
    expect(operations["net.requests"]).toBeGreaterThanOrEqual(2);
    expect(operations["net.responseBody"]).toBe(6);
    expect(toolLifecycleEvidence(events).complete).toBe(true);
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); await closeServer(fixture.server); }
});
