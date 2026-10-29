import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, type MockResponse } from "./fixtures";
import { upgradeEventStore } from "../src/logging";

test("upgrades an actual v8 IndexedDB without rebuilding or deleting legacy records", async () => {
  const provider = await startProvider([]);
  const opened = await openExtension();
  try {
    const page = await opened.context.newPage();
    await page.goto(`${provider.origin}/automation`);
    const result = await page.evaluate(async (upgradeSource) => {
      const name = `diagnostic-migration-${crypto.randomUUID()}`;
      const open = (version: number, upgrade: (db: IDBDatabase, transaction: IDBTransaction) => void) => new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(name, version);
        request.onupgradeneeded = () => upgrade(request.result, request.transaction!);
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      let db = await open(8, (database) => {
        const store = database.createObjectStore("events", { keyPath: "id", autoIncrement: true });
        store.createIndex("conversationId", "conversationId"); store.createIndex("type", "type");
        store.createIndex("conversationType", ["conversationId", "type"]); store.createIndex("runType", ["runId", "type"]);
        store.add({ id: 1, type: "legacy", content: { preserved: true } });
      });
      db.close();
      const upgrade = new Function("EVENT_STORE", "DIAGNOSTIC_INDEX_STORE", "CONVERSATION_INDEX", "TYPE_INDEX", "CONVERSATION_TYPE_INDEX", "RUN_TYPE_INDEX", "OBSOLETE_ID_INDEXES", `return (${upgradeSource});`)(
        "events", "diagnosticCaptureIndex", "conversationId", "type", "conversationType", "runType", ["typeId", "conversationTypeId", "runTypeId", "conversationIdId"],
      ) as (db: IDBDatabase, transaction: IDBTransaction) => void;
      db = await open(9, upgrade);
      const transaction = db.transaction(["events", "diagnosticCaptureIndex"], "readonly");
      const read = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      const [events, index] = await Promise.all([read(transaction.objectStore("events").getAll()), read(transaction.objectStore("diagnosticCaptureIndex").getAll())]);
      db.close(); indexedDB.deleteDatabase(name);
      return { events, index };
    }, upgradeEventStore.toString());
    expect(result).toEqual({ events: [{ id: 1, type: "legacy", content: { preserved: true } }], index: [] });
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("indexes diagnostic capture events atomically in the canonical database", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  responses.push(commandResponse("execute_program", { code: `return await net.fetch({context:'page',url:${JSON.stringify(`${provider.origin}/target`)}});` }, "capture-fetch"),
    commandResponse("list_requests", {}, "list-capture"), textResponse("INDEXED_CAPTURE_OK"));
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/automation`);
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("capture a network request");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("INDEXED_CAPTURE_OK", { timeout: 45_000 });
    const indexed = await opened.page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("side-agent-runtime");
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      const transaction = db.transaction(["events", "diagnosticCaptureIndex"], "readonly");
      const index = transaction.objectStore("diagnosticCaptureIndex");
      const get = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      const [keys, ids] = await Promise.all([get(index.getAllKeys()), get(index.getAll())]);
      const records = await Promise.all(ids.map((id) => get(transaction.objectStore("events").get(id))));
      db.close();
      return keys.map((key, i) => ({ key, id: ids[i], record: records[i] }));
    });
    expect(indexed.length).toBeGreaterThan(0);
    for (const { key, id, record } of indexed) {
      expect(record.type).toBe("browser.diagnostic");
      expect(key).toEqual([record.conversationId, record.content.tabId, record.content.epoch, id]);
      expect(record.id).toBe(id);
    }
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("reads a capture beyond the live cache through the diagnostic index", async () => {
  test.setTimeout(120_000);
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  responses.push(
    commandResponse("execute_program", { timeoutMs: 90_000, code: `return await page.evaluate(async () => { for (let start = 0; start < 1020; start += 30) await Promise.all(Array.from({length: Math.min(30, 1020-start)}, (_, index) => fetch('/target?capture=' + (start+index)).then(response => response.text()))); return 'captured'; });` }, "many-requests"),
    commandResponse("list_requests", { limit: 2 }, "first-capture-page"),
    (request) => {
      const result = JSON.parse(request.messages.findLast((entry: any) => entry.role === "tool").content);
      expect(result).toMatchObject({ ok: true, result: { integrity: "complete", hasMore: true, nextOffset: 2, requests: expect.any(Array) } });
      expect(result.result.requests).toHaveLength(2);
      return textResponse("LARGE_CAPTURE_INDEX_OK");
    },
  );
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage(); await target.goto(`${provider.origin}/automation`);
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("capture many requests and inspect the first page");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("LARGE_CAPTURE_INDEX_OK", { timeout: 100_000 });
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
