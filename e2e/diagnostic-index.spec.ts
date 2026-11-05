import { createHash } from "node:crypto";
import type { Duplex } from "node:stream";
import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, readEvents, type MockResponse } from "./fixtures";
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
      const upgrade = new Function("EVENT_STORE", "DIAGNOSTIC_INDEX_STORE", "CONVERSATION_INDEX", "TYPE_INDEX", "CONVERSATION_TYPE_INDEX", "RUN_TYPE_INDEX", "RUN_TOOL_TYPE_INDEX", "ARTIFACT_INDEX_STORE", "OBSOLETE_ID_INDEXES", `return (${upgradeSource});`)(
        "events", "diagnosticCaptureIndex", "conversationId", "type", "conversationType", "runType", "runToolType", "artifactPartIndex", ["typeId", "conversationTypeId", "runTypeId", "conversationIdId"],
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
  responses.push(commandResponse("send_page_request", { url: `${provider.origin}/target` }, "capture-fetch"),
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

test("reads a capture beyond the live cache while live WebSocket quotes keep arriving", { tag: "@user-journey" }, async () => {
  test.setTimeout(120_000);
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const sockets = new Set<Duplex>();
  provider.server.on("upgrade", (request, socket) => {
    const accept = createHash("sha1").update(String(request.headers["sec-websocket-key"]) + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    sockets.add(socket);
    let tick = 0;
    const timer = setInterval(() => { const payload = Buffer.from(String(++tick)); socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload])); }, 1);
    socket.on("error", () => socket.destroy());
    socket.on("close", () => { clearInterval(timer); sockets.delete(socket); });
  });
  responses.push(
    commandResponse("click", { target: { by: "css", value: "#start-capture" }, timeoutMs: 30_000 }, "many-requests"),
    (request) => {
      const result = JSON.parse(request.messages.findLast((entry: any) => entry.role === "tool").content);
      expect(result).toMatchObject({ ok: true });
      return commandResponse("verify_state", { target: { by: "css", value: "#capture-status" }, textIncludes: "captured", timeoutMs: 90_000 }, "capture-complete");
    },
    (request) => {
      const result = JSON.parse(request.messages.findLast((entry: any) => entry.role === "tool").content);
      expect(result).toMatchObject({ ok: true, result: { verified: true } });
      return commandResponse("list_requests", { limit: 2 }, "first-capture-page");
    },
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
    await target.evaluate(() => {
      const button = document.createElement("button"); button.id = "start-capture"; button.textContent = "Capture requests";
      const status = document.createElement("output"); status.id = "capture-status"; status.textContent = "waiting";
      button.onclick = async () => {
        for (let start = 0; start < 1020; start += 30)
          await Promise.all(Array.from({ length: Math.min(30, 1020 - start) }, (_, index) => fetch(`/target?capture=${start + index}`).then((response) => response.text())));
        const quote = document.createElement("output"); quote.style.cssText = "display:inline-block;width:150px;height:24px;overflow:hidden;font:16px monospace"; document.body.append(quote);
        const socket = new WebSocket(location.origin.replace("http", "ws") + "/quotes");
        socket.onmessage = (event) => { quote.textContent = "Quote " + event.data; status.textContent = "captured"; };
      };
      document.body.append(button, status);
    });
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("capture many requests and inspect the first page");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("LARGE_CAPTURE_INDEX_OK", { timeout: 100_000 });
    const events = await readEvents(opened.page);
    const result = events.find(event => event.type === "tool.finished" && event.toolCallId?.endsWith("first-capture-page"));
    expect(result?.latencyMs).toBeLessThan(5000);
    expect(events.some(event => event.type === "browser.diagnostic" && event.content?.method === "Network.webSocketFrameReceived")).toBe(true);
  } finally { for (const socket of sockets) socket.destroy(); await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
