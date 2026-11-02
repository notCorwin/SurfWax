import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, closeServer, readEvents, type MockResponse } from "./fixtures";
import { uploadFixture, uploadScore } from "./evaluation/upload-fixture";
import { toolLifecycleEvidence } from "./evaluation/tool-lifecycle";

// The scripted provider checks the tool path and the server checks the binary files.
test("extension tools import and upload the dossier through a chooser", async () => {
  test.setTimeout(120_000);
  const fixture = await uploadFixture(17), responses: MockResponse[] = [];
  const provider = await startProvider(responses), opened = await openExtension();
  const frame = { by: "css", value: 'iframe[title="Document desk"]' };
  const sourceOrigin = fixture.origin.replace("127.0.0.1", "localhost");
  let problem: unknown;
  const files: { url: string; filename: string }[] = [], artifactIds: number[] = [];
  const done = () => textResponse("UPLOAD_TOOL_PATH_DONE");
  const after = (handler: (result: any) => ReturnType<typeof commandResponse>): MockResponse => (request) => {
    try {
      const content = request.messages.findLast((entry: any) => entry.role === "tool").content;
      return handler(JSON.parse(Array.isArray(content) ? content.find((part: any) => part.type === "text").text : content));
    } catch (error) { problem = error; return done(); }
  };
  try {
    const target = await opened.context.newPage();
    await target.goto(fixture.origin);
    responses.push(
      commandResponse("read_elements", { target: { by: "role", value: "link", frame }, attributes: ["download", "href"] }, "read-sources"),
      after((result) => {
        expect(result).toMatchObject({ ok: true, result: { total: 2 } });
        for (const item of result.result.items) files.push({ url: new URL(item.attributes.href, sourceOrigin).href, filename: item.attributes.download });
        return commandResponse("import_file_from_url", files[0]!, "import-first");
      }),
      after((result) => { expect(result).toMatchObject({ ok: true, result: { id: expect.any(Number) } }); artifactIds.push(result.result.id); return commandResponse("import_file_from_url", files[1]!, "import-second"); }),
      after((result) => { expect(result).toMatchObject({ ok: true, result: { id: expect.any(Number) } }); artifactIds.push(result.result.id); return commandResponse("click", { target: { by: "role", value: "button", name: "Choose files", frame }, timeoutMs: 30_000 }, "open-chooser"); }),
      after((result) => {
        expect(result.fileChoosers).toHaveLength(1);
        expect(result.fileChoosers[0]).toMatchObject({ chooserId: expect.any(String), mode: "selectMultiple" });
        return commandResponse("upload_file", { chooserId: result.fileChoosers[0].chooserId, artifactId: artifactIds }, "upload-files");
      }),
      after((result) => { expect(result).toMatchObject({ state: "completed" }); return commandResponse("click", { target: { by: "role", value: "button", name: "Submit dossier", frame }, timeoutMs: 30_000 }, "submit-dossier"); }),
      after((result) => { expect(result, JSON.stringify(result)).toMatchObject({ ok: true }); return done(); }),
      textResponse("Dossier"),
    );
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill(fixture.prompt);
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("UPLOAD_TOOL_PATH_DONE", { timeout: 100_000 });
    if (problem) throw problem;
    await expect.poll(() => uploadScore(fixture.evidence())).toBe(true);
    expect(toolLifecycleEvidence(await readEvents(opened.page)).complete).toBe(true);
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); await closeServer(fixture.server); }
});
