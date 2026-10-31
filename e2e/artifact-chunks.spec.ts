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
      commandResponse("execute_program", { code: 'const sparse = new Array(4000000); for (let i=0;i<sparse.length;i+=2048) sparse[i]=i; return {rows:Array.from({length:50000},(_,i)=>i), text:"abc".repeat(150000), sparse};' }, "produce"),
      (request) => { artifactId = lastTool(request).$ref; expect(artifactId).toEqual(expect.any(Number)); return textResponse("STORED"); },
      textResponse("Large artifact"),
    );
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await opened.page.evaluate(() => {
      const state = globalThis as any;
      const add = IDBObjectStore.prototype.add;
      state.__artifactWrites = { active: 0, max: 0, total: 0 };
      IDBObjectStore.prototype.add = function(value, key) {
        const request = key === undefined ? add.call(this, value) : add.call(this, value, key);
        if (this.name === "events" && value?.type === "artifact.part") {
          const writes = state.__artifactWrites;
          writes.total++; writes.active++; writes.max = Math.max(writes.max, writes.active);
          const finished = () => { writes.active--; };
          request.addEventListener("success", finished, { once: true });
          request.addEventListener("error", finished, { once: true });
        }
        return request;
      };
      state.__restoreArtifactWrites = () => { IDBObjectStore.prototype.add = add; };
    });
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Store data");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("STORED", { timeout: 60000 });
    const writePressure = await opened.page.evaluate(() => {
      const state = globalThis as any;
      state.__restoreArtifactWrites();
      return state.__artifactWrites;
    });
    expect(writePressure.total).toBeGreaterThan(64);
    expect(writePressure.max).toBeLessThanOrEqual(64);
    expect(writePressure.active).toBe(0);
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
    await opened.page.evaluate(() => {
      const state = globalThis as any;
      state.__artifactReadIds = [];
      state.__artifactIndexVisits = [];
      const originalGet = IDBObjectStore.prototype.get;
      const originalCursor = IDBObjectStore.prototype.openCursor;
      IDBObjectStore.prototype.get = function(key) {
        if (this.name === "events") state.__artifactReadIds.push(key);
        return originalGet.call(this, key);
      };
      IDBObjectStore.prototype.openCursor = function(...args) {
        const request = originalCursor.apply(this, args);
        if (this.name === "artifactPartIndex") request.addEventListener("success", () => {
          if (request.result) state.__artifactIndexVisits.push(request.result.key);
        });
        return request;
      };
      state.__restoreArtifactInstrumentation = () => {
        IDBObjectStore.prototype.get = originalGet;
        IDBObjectStore.prototype.openCursor = originalCursor;
      };
    });
    const values = Array.from({ length: Math.ceil(4_000_000 / 2048) }, (_, index) => index * 2048)
      .filter((value) => value >= 2_000_000 && value < 2_200_000);
    responses.push(
      commandResponse("execute_program", { code: `const slice = await artifacts.read(${artifactId}, {path:['result','sparse'],offset:2000000,limit:200000}); const keys=Object.keys(slice).map(Number); return {length:slice.length,count:keys.length,first:slice[keys[0]],last:slice[keys.at(-1)]};` }, "wide"),
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true, result: { length: 200000, count: values.length, first: values[0], last: values.at(-1) } }); return textResponse("WIDE_SPARSE_OK"); },
    );
    await opened.page.getByTestId("composer-input").fill("Read a wide sparse page");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("WIDE_SPARSE_OK", { timeout: 60000 });
    const io = await opened.page.evaluate(async () => {
      const state = globalThis as any;
      state.__restoreArtifactInstrumentation();
      const ids = [...new Set(state.__artifactReadIds)] as number[];
      const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open("side-agent-runtime"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      const transaction = db.transaction("events", "readonly");
      const events = await Promise.all(ids.map((id) => new Promise<any>((resolve, reject) => { const request = transaction.objectStore("events").get(id); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); })));
      db.close();
      return { parts: events.filter((event) => event?.type === "artifact.part" && event.artifactPart?.section.startsWith("i:")).map((event) => event.artifactPart.section), visits: state.__artifactIndexVisits.length };
    });
    expect(io.parts.length).toBe(values.length);
    expect(io.parts.every((section: string) => Number(section.slice(2)) >= Math.floor(2_000_000 / 128) && Number(section.slice(2)) <= Math.floor(2_199_999 / 128))).toBe(true);
    expect(io.visits).toBeLessThan(values.length * 4);
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
