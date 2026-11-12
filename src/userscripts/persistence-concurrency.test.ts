import { expect, it, vi } from "vitest";
import { callUserScripts, USER_SCRIPTS_STORAGE_KEY, USER_SCRIPTS_DISABLED_KEY, USER_SCRIPTS_WORLDS_KEY, restoreUserScripts } from "./persistence";

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
    const created = await call("create", script) as { baseline: { script: typeof script; enabled: boolean; revision: string } };
    expect(created.baseline.script).toEqual(script);
    expect(created.baseline.enabled).toBe(true);
    expect(created.baseline.revision).toBeTruthy();
    // Chrome may return the same declaration in a different property order.
    data[USER_SCRIPTS_STORAGE_KEY] = [{ js: [{ code: "1" }], matches: ["https://example.com/*"], id: "one" }];
    register.mockClear();
    await call("replace", script, created.baseline);
    expect((await call("readForEdit", "one") as { revision: string }).revision).toBe(created.baseline.revision);
    expect(register).not.toHaveBeenCalled();
    const other = { ...script, id: "other" };
    await call("create", other);
    await call("edit", { id: "other", changes: { js: [{ code: "other change" }] } });
    await call("setEnabled", { id: "one", enabled: true });
    await call("replace", script, created.baseline);
    const old = await call("readForEdit", "one");
    await call("delete", { id: "one" });
    register.mockClear();
    await expect(call("replace", script, old)).rejects.toThrow("脚本已更改或删除");
    expect(register).not.toHaveBeenCalled();
    await call("create", script);
    await expect(call("replace", script, old)).rejects.toThrow("脚本已更改或删除");
    const draft = await call("readForEdit", "one");
    await call("edit", { id: "one", changes: { js: [{ code: "2" }] } });
    await expect(call("replace", script, created.baseline)).rejects.toThrow("脚本已更改或删除");
    await expect(call("replace", script, draft)).rejects.toThrow("脚本已更改或删除");
    const beforeToggle = await call("readForEdit", "one");
    await call("setEnabled", { id: "one", enabled: false });
    await expect(call("replace", script, beforeToggle)).rejects.toThrow("脚本已更改或删除");
    const disabled = await call("readForEdit", "one");
    await call("replace", { ...script, js: [{ code: "3" }] }, disabled);
    expect(native.find(s => s.id === "one")).toBeUndefined();
    expect((await call("read", "one") as { enabled: boolean }).enabled).toBe(false);
    await call("setEnabled", { id: "one", enabled: true });
    const baseline = await call("readForEdit", "one");
    failSet = true;
    await expect(call("replace", script, baseline)).rejects.toThrow("storage failure");
    expect(native.find(s => s.id === "one")?.js).toEqual([{ code: "3" }]);
    expect((await call("read", "one") as { script: typeof script }).script.js).toEqual([{ code: "3" }]);
    await call("replace", script, await call("readForEdit", "one"));
    expect(native.find(s => s.id === "one")?.js).toEqual(script.js);
  } finally { vi.unstubAllGlobals(); }
});


it("restores only declarations and worlds whose values differ", async () => {
  const script = { id: "one", matches: ["https://example.com/*"], js: [{ code: "1" }] };
  const world = { worldId: "w", csp: "script-src 'self'", messaging: true };
  const data: Record<string, unknown> = { [USER_SCRIPTS_STORAGE_KEY]: [script], [USER_SCRIPTS_DISABLED_KEY]: [], [USER_SCRIPTS_WORLDS_KEY]: [world] };
  let currentScript = { js: [{ code: "1" }], matches: ["https://example.com/*"], id: "one" };
  let currentWorld = { messaging: true, csp: "script-src 'self'", worldId: "w" };
  const register = vi.fn(async () => {}), unregister = vi.fn(async () => {}), configureWorld = vi.fn(async () => {});
  const chromeApi = { storage: { local: { get: async () => structuredClone(data), set: async () => {} } }, userScripts: {
    getScripts: async () => [currentScript], getWorldConfigurations: async () => [currentWorld], register, unregister, configureWorld,
  } } as unknown as NonNullable<Parameters<typeof restoreUserScripts>[0]>["chromeApi"];
  await restoreUserScripts({ chromeApi });
  expect(register).not.toHaveBeenCalled(); expect(unregister).not.toHaveBeenCalled(); expect(configureWorld).not.toHaveBeenCalled();
  currentScript = { ...currentScript, js: [{ code: "changed" }] };
  currentWorld = { ...currentWorld, messaging: false };
  await restoreUserScripts({ chromeApi });
  expect(unregister).toHaveBeenCalledOnce(); expect(register).toHaveBeenCalledOnce(); expect(configureWorld).toHaveBeenCalledWith(world);
});
