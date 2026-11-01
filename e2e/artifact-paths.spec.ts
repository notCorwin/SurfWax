import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, type MockResponse } from "./fixtures";

const lastTool = (request: any) => {
  const content = request.messages.findLast((message: any) => message.role === "tool").content;
  return JSON.parse(Array.isArray(content) ? content.find((part: any) => part.type === "text").text : content);
};

test("reads stored artifact paths without treating missing or inherited values as successful results", async () => {
  const responses: MockResponse[] = [], provider = await startProvider(responses), opened = await openExtension();
  let artifactId = 0;
  try {
    const target = await opened.context.newPage(); await target.goto(`${provider.origin}/automation`);
    responses.push(
      commandResponse("create_text_artifact", { filename: "sample.txt", text: "example" }, "produce-artifact"),
      (request) => { artifactId = lastTool(request).result.id; expect(artifactId).toEqual(expect.any(Number)); return commandResponse("read_artifact", { artifactId, path: ["filename"] }, "read-name"); },
      (request) => { expect(lastTool(request)).toEqual({ evidenceId: expect.any(String), ok: true, result: "sample.txt" }); return commandResponse("read_artifact", { artifactId, path: ["base64"], offset: 0, limit: 4 }, "read-slice"); },
      (request) => { expect(lastTool(request)).toEqual({ evidenceId: expect.any(String), ok: true, result: "ZXhh" }); return commandResponse("read_artifact", { artifactId, path: ["missing"] }, "read-missing"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: false, error: { code: "result-path-not-found" } }); return commandResponse("read_artifact", { artifactId, path: ["constructor"] }, "read-inherited"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: false, error: { code: "result-path-not-found" } }); return textResponse("ARTIFACT_PATHS_OK"); },
      textResponse("产物路径"),
    );
    await (await configure(opened.context, opened.page, provider.baseURL)).close(); await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Read the stored data and check its missing paths"); await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("ARTIFACT_PATHS_OK", { timeout: 60_000 });
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
