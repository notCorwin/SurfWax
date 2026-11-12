import { expect, it, vi } from "vitest";
import { callUserScripts, USER_SCRIPTS_STORAGE_KEY, USER_SCRIPTS_DISABLED_KEY } from "./persistence";

it("protects stale replacements and preserves native projection through failures", async () => {
  let tail = Promise.resolve();
  vi.stubGlobal("navigator", { locks: { request: (_name: string, operation: () => Promise<unknown>) => {
    const next = tail.then(operation); tail = next.then(() => {}, () => {}); return next;
  } } });
  const data: Record<string, unknown> = { [USER_SCRIPTS_STORAGE_KEY]: [], [USER_SCRIPTS_DISABLED_KEY]: [] };
  let native: chrome.userScripts.RegisteredUserScript[] = [];
  let failSet = false;
  const register = vi.fn(async (scripts: chrome.userScripts.RegisteredUserScript[]) => { native.push(...structuredClone(scripts)); });
  const chromeApi = {
    storage: { local: { get: async (keys: string[]) => Object.fromEntries(keys.map(k => [k, structuredClone(data[k])])), set: async (items: Record<string, unknown>) => { if (failSet) { failSet = false; throw new Error("storage failure"); } Object.assign(data, structuredClone(items)); } } },
    userScripts: { getScripts: async (filter?: { ids?: string[] }) => structuredClone(filter?.ids ? native.filter(s => filter.ids!.includes(s.id)) : native), register, unregister: async ({ ids }: { ids: string[] }) => { native = native.filter(s => !ids.includes(s.id)); } },
  } as unknown as NonNullable<Parameters<typeof callUserScripts>[2]>["chromeApi"];
  const call = (method: string, ...args: unknown[]) => callUserScripts(method, args, { chromeApi });
  const script = { id: "one", matches: ["https://example.com/*"], js: [{ code: "1" }] };
  try {
    await call("create", script);
    const old = await call("readForEdit", "one");
    await call("delete", { id: "one" });
    register.mockClear();
    await expect(call("replace", script, old)).rejects.toThrow("脚本已更改或删除");
    expect(register).not.toHaveBeenCalled();
    await call("create", script);
    await expect(call("replace", script, old)).rejects.toThrow("脚本已更改或删除");
    const draft = await call("readForEdit", "one");
    await call("edit", { id: "one", changes: { js: [{ code: "2" }] } });
    await expect(call("replace", script, draft)).rejects.toThrow("脚本已更改或删除");
    const beforeToggle = await call("readForEdit", "one");
    await call("setEnabled", { id: "one", enabled: false });
    await expect(call("replace", script, beforeToggle)).rejects.toThrow("脚本已更改或删除");
    const disabled = await call("readForEdit", "one");
    await call("replace", { ...script, js: [{ code: "3" }] }, disabled);
    expect(native).toEqual([]);
    expect((await call("read", "one") as { enabled: boolean }).enabled).toBe(false);
    await call("setEnabled", { id: "one", enabled: true });
    const baseline = await call("readForEdit", "one");
    failSet = true;
    await expect(call("replace", script, baseline)).rejects.toThrow("storage failure");
    expect(native[0].js).toEqual([{ code: "3" }]);
    expect((await call("read", "one") as { script: typeof script }).script.js).toEqual([{ code: "3" }]);
    await call("replace", script, await call("readForEdit", "one"));
    expect(native[0].js).toEqual(script.js);
  } finally { vi.unstubAllGlobals(); }
});
