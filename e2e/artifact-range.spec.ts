import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, type MockResponse } from "./fixtures";

const lastTool = (request: any) => {
  const content = request.messages.findLast((message: any) => message.role === "tool").content;
  return JSON.parse(Array.isArray(content) ? content.find((part: any) => part.type === "text").text : content);
};

test("execute_program enforces the same range contract for ordinary and partitioned artifacts", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  let ids: number[] = [];
  try {
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    responses.push(
      commandResponse("execute_program", { code: `
const small = await artifacts.text('small.txt', 'abcd');
const large = await artifacts.text('large.txt', 'abcd'.repeat(80000));
const ids = [small.id, large.id], samples = [], empty = [], errors = [];
for (const id of ids) {
  samples.push(await artifacts.read(id, {path:['base64'], offset:1, limit:2}));
  empty.push(await artifacts.read(id, {path:['base64'], offset:0, limit:0}));
  for (const field of ['offset', 'limit']) for (const value of [1.5, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    try { await artifacts.read(id, {path:['base64'], [field]:value}); errors.push('accepted'); }
    catch (error) { errors.push(error.code); }
  }
}
return {ids, samples, empty, count:errors.length, allRejected:errors.every(code => code === 'invalid-result-range')};` }, "range-contract"),
      (request) => {
        const output = lastTool(request);
        expect(output).toMatchObject({ ok: true, result: { samples: ["WJ", "WJ"], empty: ["", ""], count: 20, allRejected: true } });
        ids = output.result.ids;
        return textResponse("ARTIFACT_RANGE_OK");
      },
      textResponse("产物分页参数"),
    );
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Check artifact ranges");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("ARTIFACT_RANGE_OK", { timeout: 60000 });
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
