import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, type MockResponse } from "./fixtures";

const lastTool = (request: any) => {
  const content = request.messages.findLast((message: any) => message.role === "tool").content;
  return JSON.parse(Array.isArray(content) ? content.find((part: any) => part.type === "text").text : content);
};

test("read_artifact enforces the same range and path contract for ordinary and partitioned artifacts", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  const ids: number[] = [];
  let problem: unknown;
  const done = () => textResponse("ARTIFACT_RANGE_OK");
  const after = (handler: (result: any) => ReturnType<typeof commandResponse> | ReturnType<typeof textResponse>): MockResponse => (request) => {
    try { return handler(lastTool(request)); } catch (error) { problem = error; return done(); }
  };
  try {
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    responses.push(
      commandResponse("create_text_artifact", { filename: "small.txt", text: "abcd" }, "small-artifact"),
      after((result) => { expect(result).toMatchObject({ ok: true, result: { id: expect.any(Number) } }); ids.push(result.result.id); return commandResponse("create_text_artifact", { filename: "large.txt", text: "abcd".repeat(80000) }, "large-artifact"); }),
      after((result) => { expect(result).toMatchObject({ ok: true, result: { id: expect.any(Number) } }); ids.push(result.result.id); return commandResponse("read_artifact", { artifactId: ids[0], path: ["base64"], offset: 1, limit: 2 }, "small-slice"); }),
      after((result) => { expect(result).toEqual({ evidenceId: expect.any(String), ok: true, result: "WJ" }); return commandResponse("read_artifact", { artifactId: ids[1], path: ["base64"], offset: 1, limit: 2 }, "large-slice"); }),
      after((result) => { expect(result).toEqual({ evidenceId: expect.any(String), ok: true, result: "WJ" }); return commandResponse("read_artifact", { artifactId: ids[0], path: ["base64"], offset: 999999, limit: 2 }, "small-end"); }),
      after((result) => { expect(result).toEqual({ evidenceId: expect.any(String), ok: true, result: "" }); return commandResponse("read_artifact", { artifactId: ids[1], path: ["base64"], offset: 999999, limit: 2 }, "large-end"); }),
      after((result) => { expect(result).toEqual({ evidenceId: expect.any(String), ok: true, result: "" }); return commandResponse("read_artifact", { artifactId: ids[0], path: ["missing"] }, "small-missing"); }),
      after((result) => { expect(result).toMatchObject({ ok: false, error: { code: "result-path-not-found" } }); return commandResponse("read_artifact", { artifactId: ids[1], path: ["missing"] }, "large-missing"); }),
      after((result) => { expect(result).toMatchObject({ ok: false, error: { code: "result-path-not-found" } }); return done(); }),
      textResponse("产物分页参数"),
    );
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Check artifact ranges");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("ARTIFACT_RANGE_OK", { timeout: 60000 });
    if (problem) throw problem;
    const partitioned = await opened.page.evaluate(async (artifactIds) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open("side-agent-runtime"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      const tx = db.transaction("events", "readonly");
      const events = await Promise.all(artifactIds.map((id) => new Promise<any>((resolve, reject) => { const request = tx.objectStore("events").get(id); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); })));
      db.close();
      return events.map((event) => Boolean(event?.artifactGraph));
    }, ids);
    expect(partitioned).toEqual([false, true]);
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
