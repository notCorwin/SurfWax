import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, type MockResponse } from "./fixtures";

const lastTool = (request: any) => {
  const content = request.messages.findLast((message: any) => message.role === "tool").content;
  return JSON.parse(Array.isArray(content) ? content.find((part: any) => part.type === "text").text : content);
};

test("persists indexed artifact parts and reads a bounded page after reload", async () => {
  const responses: MockResponse[] = [], provider = await startProvider(responses), opened = await openExtension();
  const text = "abc".repeat(500_000), encoded = Buffer.from(text).toString("base64");
  let artifactId = 0;
  try {
    const target = await opened.context.newPage(); await target.goto(`${provider.origin}/automation`);
    responses.push(commandResponse("create_text_artifact", { filename: "large.txt", text }, "produce"),
      (request) => { artifactId = lastTool(request).result.id; expect(artifactId).toEqual(expect.any(Number)); return textResponse("STORED"); }, textResponse("Large artifact"));
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await opened.page.evaluate(() => {
      const state = globalThis as any, add = IDBObjectStore.prototype.add;
      state.__artifactWrites = { active: 0, max: 0, total: 0 };
      IDBObjectStore.prototype.add = function(value, key) {
        const request = key === undefined ? add.call(this, value) : add.call(this, value, key);
        if (this.name === "events" && value?.type === "artifact.part") {
          const writes = state.__artifactWrites; writes.total++; writes.active++; writes.max = Math.max(writes.max, writes.active);
          const finished = () => { writes.active--; };
          request.addEventListener("success", finished, { once: true }); request.addEventListener("error", finished, { once: true });
        }
        return request;
      };
      state.__restoreArtifactWrites = () => { IDBObjectStore.prototype.add = add; };
    });
    await target.bringToFront(); await opened.page.getByTestId("composer-input").fill("Store data"); await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("STORED", { timeout: 60_000 });
    const writes = await opened.page.evaluate(() => { const state = globalThis as any; state.__restoreArtifactWrites(); return state.__artifactWrites; });
    expect(writes.total).toBeGreaterThan(64); expect(writes.max).toBeLessThanOrEqual(64); expect(writes.active).toBe(0);
    const persisted = await opened.page.evaluate(async (id) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open("side-agent-runtime"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      const tx = db.transaction(["events", "artifactPartIndex"], "readonly");
      const root = await new Promise<any>((resolve, reject) => { const request = tx.objectStore("events").get(id); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      const count = await new Promise<number>((resolve, reject) => { const request = tx.objectStore("artifactPartIndex").count(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      db.close(); return { root, count };
    }, artifactId);
    expect(persisted.root.artifactGraph?.version).toBe(1); expect(persisted.root.output).toBeNull(); expect(persisted.count).toBeGreaterThan(64);
    await opened.page.reload(); await opened.page.getByTestId("conversation-menu").click();
    await opened.page.locator(".conversation-item", { hasText: "Large artifact" }).locator(".conversation-select").click();
    await expect(opened.page.locator(".markdown-body").last()).toContainText("STORED");
    await opened.page.evaluate(() => {
      const state = globalThis as any, originalGet = IDBObjectStore.prototype.get;
      state.__artifactReadIds = [];
      IDBObjectStore.prototype.get = function(key) { if (this.name === "events") state.__artifactReadIds.push(key); return originalGet.call(this, key); };
      state.__restoreArtifactReads = () => { IDBObjectStore.prototype.get = originalGet; };
    });
    responses.push(commandResponse("read_artifact", { artifactId, path: ["base64"], offset: 100001, limit: 5 }, "page"),
      (request) => { expect(lastTool(request)).toEqual({ evidenceId: expect.any(String), ok: true, result: encoded.slice(100001, 100006) }); return textResponse("RESTORED"); });
    await opened.page.getByTestId("composer-input").fill("Read a data page"); await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("RESTORED", { timeout: 60_000 });
    const readParts = await opened.page.evaluate(async () => {
      const state = globalThis as any; state.__restoreArtifactReads(); const ids = [...new Set(state.__artifactReadIds)] as number[];
      const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open("side-agent-runtime"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      const transaction = db.transaction("events", "readonly");
      const events = await Promise.all(ids.map((id) => new Promise<any>((resolve, reject) => { const request = transaction.objectStore("events").get(id); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); })));
      db.close(); return events.filter((event) => event?.type === "artifact.part" && event.artifactPart?.section === "text").length;
    });
    expect(readParts).toBeGreaterThan(0); expect(readParts).toBeLessThanOrEqual(2);
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
