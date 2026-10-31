import { expect } from "@playwright/test";
import { test, commandResponse, startProvider, openExtension, dispose, configure, type MockResponse } from "./fixtures";

test("rolls back every artifact part when a later write batch fails", async () => {
  const responses: MockResponse[] = [
    commandResponse("execute_program", { code: 'return "abc".repeat(500000);' }, "large-result"),
  ];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    await opened.page.evaluate(() => {
      const state = globalThis as any;
      const add = IDBObjectStore.prototype.add;
      state.__artifactFailure = { indexed: 0, aborted: false };
      IDBObjectStore.prototype.add = function(value, key) {
        if (this.name === "artifactPartIndex" && ++state.__artifactFailure.indexed === 65) {
          this.transaction.addEventListener("abort", () => { state.__artifactFailure.aborted = true; }, { once: true });
          throw new DOMException("Injected later batch failure", "QuotaExceededError");
        }
        return key === undefined ? add.call(this, value) : add.call(this, value, key);
      };
      state.__restoreArtifactFailure = () => { IDBObjectStore.prototype.add = add; };
    });
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Create a large result");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect.poll(() => opened.page.evaluate(() => (globalThis as any).__artifactFailure?.aborted), { timeout: 30000 }).toBe(true);
    const persisted = await opened.page.evaluate(async () => {
      (globalThis as any).__restoreArtifactFailure();
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("side-agent-runtime");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const transaction = db.transaction(["events", "artifactPartIndex"], "readonly");
      const all = new Promise<any[]>((resolve, reject) => {
        const request = transaction.objectStore("events").getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const count = new Promise<number>((resolve, reject) => {
        const request = transaction.objectStore("artifactPartIndex").count();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const [events, indexed] = await Promise.all([all, count]);
      db.close();
      return { indexed, artifacts: events.filter((event) => event.type === "artifact.part" || event.type === "tool.result.data").length };
    });
    expect(persisted).toEqual({ indexed: 0, artifacts: 0 });
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
