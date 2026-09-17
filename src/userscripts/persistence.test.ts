import { describe, expect, it, vi } from "vitest";
import { callUserScripts, restoreUserScripts, snapshotUserScripts, USER_SCRIPTS_DATA_KEY, USER_SCRIPTS_LEGACY_KEY, USER_SCRIPTS_STORAGE_KEY, USER_SCRIPTS_WORLDS_KEY } from "./persistence";

function fakeChrome(options: { available?: boolean; stored?: Record<string, unknown>; registered?: chrome.userScripts.RegisteredUserScript[] } = {}) {
  const stored = { ...(options.stored ?? {}) };
  let registered = [...(options.registered ?? [])];
  let worlds: chrome.userScripts.WorldProperties[] = [];
  const api = {
    getScripts: vi.fn(async () => [...registered]),
    register: vi.fn(async (scripts: chrome.userScripts.RegisteredUserScript[]) => { registered.push(...scripts); }),
    update: vi.fn(async (scripts: chrome.userScripts.RegisteredUserScript[]) => {
      for (const script of scripts) registered = registered.map((item) => item.id === script.id ? { ...item, ...script } : item);
    }),
    unregister: vi.fn(async (filter?: { ids?: string[] }) => { registered = filter?.ids ? registered.filter((item) => !filter.ids!.includes(item.id)) : []; }),
    getWorldConfigurations: vi.fn(async () => [...worlds]),
    configureWorld: vi.fn(async (world: chrome.userScripts.WorldProperties) => { worlds = [...worlds.filter((item) => item.worldId !== world.worldId), world]; }),
  };
  return {
    stored,
    api,
    chromeApi: {
      storage: { local: {
        async get(keys: string | string[]) {
          const list = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(list.map((key) => [key, stored[key]]));
        },
        async set(items: Record<string, unknown>) { Object.assign(stored, items); },
      } },
      ...(options.available === false ? {} : { userScripts: api }),
    },
  };
}

describe("user script persistence", () => {
  it("keeps unknown legacy data intact while the native API is unavailable", async () => {
    const fake = fakeChrome({ available: false, stored: { [USER_SCRIPTS_STORAGE_KEY]: [{ id: "legacy" }] } });
    await expect(restoreUserScripts({ chromeApi: fake.chromeApi as never })).resolves.toBe(false);
    expect(fake.stored[USER_SCRIPTS_STORAGE_KEY]).toEqual([{ id: "legacy" }]);
  });

  it("keeps invalid legacy data intact and never unregisters native scripts", async () => {
    const fake = fakeChrome({ stored: { [USER_SCRIPTS_STORAGE_KEY]: [{ id: "legacy" }] } });
    await expect(restoreUserScripts({ chromeApi: fake.chromeApi as never })).rejects.toThrow("原始数据已保留");
    expect(fake.stored[USER_SCRIPTS_STORAGE_KEY]).toEqual([{ id: "legacy" }]);
    expect(fake.api.unregister).not.toHaveBeenCalled();
    await callUserScripts("register", [[{ id: "new", matches: ["<all_urls>"], js: [{ code: "1" }] }]], { chromeApi: fake.chromeApi as never });
    expect(fake.stored[USER_SCRIPTS_LEGACY_KEY]).toEqual([{ id: "legacy" }]);
  });

  it("restores missing and changed definitions without unregistering other scripts", async () => {
    const legacy = { id: "legacy", matches: ["<all_urls>"], js: [{ code: "1" }] };
    const fake = fakeChrome({ registered: [legacy] });
    await restoreUserScripts({ chromeApi: fake.chromeApi as never });
    expect(fake.api.unregister).not.toHaveBeenCalled();
    expect(fake.stored[USER_SCRIPTS_DATA_KEY]).toEqual({ version: 3 });

    const saved = { id: "saved", matches: ["<all_urls>"], js: [{ code: "2" }] };
    fake.stored[USER_SCRIPTS_STORAGE_KEY] = [saved, { ...legacy, js: [{ code: "3" }] }];
    await restoreUserScripts({ chromeApi: fake.chromeApi as never });
    expect(fake.api.register).toHaveBeenLastCalledWith([saved]);
    expect(fake.api.update).toHaveBeenCalledWith([{ ...legacy, js: [{ code: "3" }] }]);
    expect(fake.api.unregister).not.toHaveBeenCalled();
    await snapshotUserScripts({ chromeApi: fake.chromeApi as never });
    expect(fake.stored[USER_SCRIPTS_STORAGE_KEY]).toHaveLength(2);
  });

  it("serializes concurrent changes and saves the native result immediately", async () => {
    const fake = fakeChrome({ stored: { [USER_SCRIPTS_STORAGE_KEY]: [] } });
    const first = { id: "first", matches: ["<all_urls>"], js: [{ code: "1" }] };
    const second = { id: "second", matches: ["<all_urls>"], js: [{ code: "2" }] };
    await Promise.all([
      callUserScripts("register", [[first]], { chromeApi: fake.chromeApi as never }),
      callUserScripts("register", [[second]], { chromeApi: fake.chromeApi as never }),
    ]);
    expect(fake.stored[USER_SCRIPTS_STORAGE_KEY]).toEqual([first, second]);
  });

  it("restores custom USER_SCRIPT world configuration before scripts", async () => {
    const world = { worldId: "custom", messaging: true };
    const script = { id: "custom-world", matches: ["<all_urls>"], js: [{ code: "1" }], worldId: "custom" };
    const fake = fakeChrome({ stored: { [USER_SCRIPTS_STORAGE_KEY]: [script], [USER_SCRIPTS_WORLDS_KEY]: [world] } });
    await restoreUserScripts({ chromeApi: fake.chromeApi as never });
    expect(fake.api.configureWorld).toHaveBeenCalledWith(world);
    expect(fake.api.register).toHaveBeenCalledWith([script]);
    expect(fake.stored[USER_SCRIPTS_WORLDS_KEY]).toEqual([world]);
  });
});
