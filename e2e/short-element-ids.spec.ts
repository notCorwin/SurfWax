import { expect, type Page } from "@playwright/test";
import { test, openExtension, dispose } from "./fixtures";

test.use({ screenshot: "off", trace: "off" });

async function allocate(panel: Page, count: number): Promise<string[]> {
  const origin = process.env.SURFWAX_DEV_SERVER_URL;
  if (!origin) throw new Error("Short ID regression requires the development extension server");
  await panel.waitForLoadState("networkidle");
  return panel.evaluate(async ({ origin, count }) => {
    const { ElementIds } = await import(`${origin}/src/chrome/element-ids.ts`);
    const registry = new ElementIds(() => {}), session = {};
    return registry.assign(Array.from({ length: count }, (_, index) => ({ session, generation: 0,
      owner: "test-run", sourceId: `private-node-${index}`, actionable: true })));
  }, { origin, count });
}

test("allocates compact unique element IDs across concurrent extension views and reloads", async () => {
  const opened = await openExtension();
  try {
    const other = await opened.context.newPage();
    await other.goto(opened.page.url());
    const batches = await Promise.all([allocate(opened.page, 24), allocate(other, 24)]);
    const ids = batches.flat();
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every(id => /^[0-9a-z]+$/.test(id))).toBe(true);
    await opened.page.reload();
    const [next] = await allocate(opened.page, 1);
    expect(parseInt(next!, 36)).toBeGreaterThan(Math.max(...ids.map(id => parseInt(id, 36))));
    expect(await opened.page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("surf-wax-element-ids", 1);
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      try {
        return await new Promise<number>((resolve, reject) => {
          const request = db.transaction("counter").objectStore("counter").count();
          request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
        });
      } finally { db.close(); }
    })).toBe(0);
  } finally { await dispose(opened.context, opened.userDataDirectory); }
});
