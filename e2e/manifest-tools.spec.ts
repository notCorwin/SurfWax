import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, closeServer, type MockResponse } from "./fixtures";
import { manifestFixture, manifestScore } from "./evaluation/manifest-fixture";

// Scripted extension execution validates the tool path, not model performance.
test("extension tools preserve and submit the complete paginated manifest via an artifact", async () => {
  test.setTimeout(300_000);
  const fixture = await manifestFixture(17), responses: MockResponse[] = [];
  const provider = await startProvider(responses), opened = await openExtension();
  const frame = { by: "css", value: 'iframe[title="Manifest desk"]' };
  let artifactId = 0, problem: unknown, page = 1, first = "", lastPage = "", submission: any;
  const collected: string[] = [];
  const done = () => textResponse("MANIFEST_TOOL_PATH_DONE");
  const after = (handler: (result: any) => ReturnType<typeof commandResponse>): MockResponse => {
    const step: MockResponse = (request) => {
      const message = request.messages.findLast((entry: any) => entry.role === "tool");
      if (!message) { responses.unshift(step); return textResponse("Manifest"); }
      try { const content = message.content; return handler(JSON.parse(Array.isArray(content) ? content.find((part: any) => part.type === "text").text : content)); }
      catch (error) { problem = error; return done(); }
    };
    return step;
  };
  const readPage = () => {
    responses.unshift(after((result) => {
      expect(result).toMatchObject({ ok: true, result: expect.any(String) });
      collected.push(result.result);
      if (page === 20) {
        responses.unshift(after((result) => {
          expect(result).toMatchObject({ ok: true, result: { id: expect.any(Number) } }); artifactId = result.result.id;
          responses.unshift(after((result) => {
            expect(result).toMatchObject({ ok: true, result: expect.any(String) }); first = result.result;
            const encodedLength = Buffer.from(collected.join("\n"), "utf8").toString("base64").length;
            responses.unshift(after((result) => {
              expect(result).toMatchObject({ ok: true, result: expect.any(String) }); lastPage = result.result;
              responses.unshift(after((result) => {
                expect(result.ok).toBe(true);
                responses.unshift(after((result) => { submission = result; return done(); }));
                return commandResponse("click", { target: { by: "role", value: "button", name: "Submit manifest", frame } }, "submit-manifest");
              }));
              return commandResponse("fill_from_artifact", { artifactId, target: { by: "label", value: "Complete manifest", frame } }, "fill-manifest");
            }));
            return commandResponse("read_artifact", { artifactId, path: ["base64"], offset: encodedLength - 32, limit: 32 }, "manifest-last");
          }));
          return commandResponse("read_artifact", { artifactId, path: ["base64"], offset: 0, limit: 32 }, "manifest-first");
        }));
        return commandResponse("create_text_artifact", { filename: "manifest.txt", text: collected.join("\n") }, "save-manifest");
      }
      responses.unshift(after((result) => {
        expect(result.ok).toBe(true); page++;
        responses.unshift(after((result) => { expect(result).toMatchObject({ ok: true, result: { verified: true } }); return readPage(); }));
        return commandResponse("verify_state", { target: { by: "css", value: "#page", frame }, textIncludes: `Page ${page} of 20`, timeoutMs: 10_000 }, `page-ready-${page}`);
      }));
      return commandResponse("click", { target: { by: "role", value: "button", name: "Next page", frame } }, `page-next-${page}`);
    }));
    return commandResponse("read_text", { target: { by: "role", value: "list", name: "Tracking codes", frame } }, `read-page-${page}`);
  };
  try {
    const target = await opened.context.newPage(); await target.goto(fixture.origin);
    responses.push(
      commandResponse("verify_state", { target: { by: "css", value: "#page", frame }, textIncludes: "Page 1 of 20", timeoutMs: 10_000 }, "first-page-ready"),
      after((result) => { expect(result).toMatchObject({ ok: true, result: { verified: true } }); return readPage(); }),
      textResponse("Manifest"),
    );
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill(fixture.prompt);
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("MANIFEST_TOOL_PATH_DONE", { timeout: 280_000 });
    if (problem) throw problem;
    const encoded = Buffer.from(collected.join("\n"), "utf8").toString("base64");
    expect(collected).toHaveLength(20);
    expect(artifactId).toBeGreaterThan(0);
    expect(first).toBe(encoded.slice(0, 32));
    expect(lastPage).toBe(encoded.slice(-32));
    expect(collected[19]).toContain("海🌊");
    expect(submission).toMatchObject({ ok: true });
    await expect.poll(() => manifestScore(fixture.evidence())).toBe(true);
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
    await closeServer(fixture.server);
  }
});
