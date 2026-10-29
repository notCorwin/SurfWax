import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, type MockResponse } from "./fixtures";

const lastTool = (request: any) => {
  const content = request.messages.findLast((message: any) => message.role === "tool").content;
  return JSON.parse(Array.isArray(content) ? content.find((part: any) => part.type === "text").text : content);
};

test("persists large native results in indexed canonical parts and reads pages after reload", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  let artifactId = 0;
  try {
    const target = await opened.context.newPage(); await target.goto(`${provider.origin}/automation`);
    responses.push(
      commandResponse("execute_program", { code: 'return {rows:Array.from({length:50000},(_,i)=>i), text:"abc".repeat(150000)};' }, "produce"),
      (request) => { artifactId = lastTool(request).$ref; expect(artifactId).toEqual(expect.any(Number)); return textResponse("STORED"); },
      textResponse("Large artifact"),
    );
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Store data");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("STORED", { timeout: 60000 });
    const persisted = await opened.page.evaluate(async (id) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open("side-agent-runtime"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      const tx = db.transaction(["events", "artifactPartIndex"], "readonly");
      const root = await new Promise<any>((resolve, reject) => { const request = tx.objectStore("events").get(id); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      const count = await new Promise<number>((resolve, reject) => { const request = tx.objectStore("artifactPartIndex").count(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      db.close(); return { root, count };
    }, artifactId);
    expect(persisted.root.artifactGraph?.version).toBe(1);
    expect(persisted.root.output).toBeNull(); expect(persisted.count).toBeGreaterThan(10);
    await opened.page.reload();
    await opened.page.getByTestId("conversation-menu").click();
    await opened.page.locator(".conversation-item", { hasText: "Large artifact" }).locator(".conversation-select").click();
    await expect(opened.page.locator(".markdown-body").last()).toContainText("STORED");
    responses.push(
      commandResponse("read_artifact", { artifactId, path: ["result", "rows"], offset: 32100, limit: 3 }, "page"),
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true, result: [32100, 32101, 32102] }); return commandResponse("read_artifact", { artifactId, path: ["result", "text"], offset: 100001, limit: 5 }, "text"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true, result: "cabca" }); return textResponse("RESTORED"); },
    );
    await opened.page.getByTestId("composer-input").fill("Read data pages");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("RESTORED", { timeout: 60000 });
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
