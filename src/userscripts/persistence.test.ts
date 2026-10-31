import { describe, expect, it, vi } from "vitest";
import { callUserScripts, restoreUserScripts, snapshotUserScripts, USER_SCRIPTS_DATA_KEY, USER_SCRIPTS_DISABLED_KEY, USER_SCRIPTS_STORAGE_KEY, USER_SCRIPTS_WORLDS_KEY } from "./persistence";

function fakeChrome(options: { available?: boolean; stored?: Record<string, unknown>; registered?: chrome.userScripts.RegisteredUserScript[] } = {}) {
  const stored = { ...(options.stored ?? {}) };
  let registered = [...(options.registered ?? [])];
  let worlds: chrome.userScripts.WorldProperties[] = [];
  const api = {
    getScripts: vi.fn(async (filter?: { ids?: string[] }) => registered.filter((script) => !filter?.ids || filter.ids.includes(script.id))),
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
    await expect(callUserScripts("create", [{ id: "new", matches: ["<all_urls>"], js: [{ code: "1" }] }], { chromeApi: fake.chromeApi as never })).rejects.toThrow("原始数据已保留");
    expect(fake.stored[USER_SCRIPTS_STORAGE_KEY]).toEqual([{ id: "legacy" }]);
    expect(fake.api.register).not.toHaveBeenCalled();
  });

  it("restores saved scripts before creating a script after the native registry was cleared", async () => {
    const saved = { id: "saved", matches: ["<all_urls>"], js: [{ code: "1" }] };
    const created = { id: "created", matches: ["<all_urls>"], js: [{ code: "2" }] };
    const fake = fakeChrome({ stored: { [USER_SCRIPTS_STORAGE_KEY]: [saved] } });
    await callUserScripts("create", [created], { chromeApi: fake.chromeApi as never });
    expect(await fake.api.getScripts()).toEqual([saved, created]);
    expect(fake.stored[USER_SCRIPTS_STORAGE_KEY]).toEqual([saved, created]);
  });

  it("preserves the full declaration when recovery fails partway and retries before the next write", async () => {
    const first = { id: "first", matches: ["<all_urls>"], js: [{ code: "1" }] };
    const second = { id: "second", matches: ["<all_urls>"], js: [{ code: "2" }] };
    const created = { id: "created", matches: ["<all_urls>"], js: [{ code: "3" }] };
    const fake = fakeChrome({ stored: { [USER_SCRIPTS_STORAGE_KEY]: [first, second] } });
    fake.api.register.mockImplementationOnce(fake.api.register.getMockImplementation()!).mockRejectedValueOnce(new Error("restore failed"));
    const options = { chromeApi: fake.chromeApi as never };
    await expect(callUserScripts("create", [created], options)).rejects.toThrow("restore failed");
    expect(fake.stored[USER_SCRIPTS_STORAGE_KEY]).toEqual([first, second]);
    expect(fake.api.register).not.toHaveBeenCalledWith([created]);
    await callUserScripts("create", [created], options);
    expect(await fake.api.getScripts()).toEqual([first, second, created]);
    expect(fake.stored[USER_SCRIPTS_STORAGE_KEY]).toEqual([first, second, created]);
  });

  it("allows a script that cannot be restored to be disabled without losing other saved scripts", async () => {
    const bad = { id: "bad", matches: ["<all_urls>"], js: [{ code: "1" }] };
    const other = { id: "other", matches: ["<all_urls>"], js: [{ code: "2" }] };
    const fake = fakeChrome({ stored: { [USER_SCRIPTS_STORAGE_KEY]: [bad, other] } });
    fake.api.register.mockRejectedValueOnce(new Error("unsupported script"));
    const options = { chromeApi: fake.chromeApi as never };
    await expect(callUserScripts("create", [{ id: "new", matches: ["<all_urls>"], js: [{ code: "3" }] }], options)).rejects.toThrow("unsupported script");
    await callUserScripts("setEnabled", [{ id: "bad", enabled: false }], options);
    expect(fake.stored[USER_SCRIPTS_STORAGE_KEY]).toEqual([other]);
    expect(fake.stored[USER_SCRIPTS_DISABLED_KEY]).toEqual([bad]);
    await restoreUserScripts(options);
    expect(await fake.api.getScripts()).toEqual([other]);
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
    expect(fake.stored[USER_SCRIPTS_STORAGE_KEY]).toEqual([saved, { ...legacy, js: [{ code: "3" }] }]);
    await snapshotUserScripts({ chromeApi: fake.chromeApi as never });
    expect(fake.stored[USER_SCRIPTS_STORAGE_KEY]).toHaveLength(2);
  });

  it("removes unrelated native registry drift without promoting it into storage", async () => {
    const saved = { id: "saved", matches: ["<all_urls>"], js: [{ code: "1" }] };
    const foreign = { id: "foreign", matches: ["<all_urls>"], js: [{ code: "2" }] };
    const fake = fakeChrome({ registered: [foreign], stored: { [USER_SCRIPTS_STORAGE_KEY]: [saved] } });
    await restoreUserScripts({ chromeApi: fake.chromeApi as never });
    expect(fake.stored[USER_SCRIPTS_STORAGE_KEY]).toEqual([saved]);
    expect(await fake.api.getScripts()).toEqual([saved]);
    expect(fake.api.unregister).toHaveBeenCalledWith({ ids: [foreign.id] });
  });

  it("serializes concurrent changes and saves the native result immediately", async () => {
    const fake = fakeChrome({ stored: { [USER_SCRIPTS_STORAGE_KEY]: [] } });
    const first = { id: "first", matches: ["<all_urls>"], js: [{ code: "1" }] };
    const second = { id: "second", matches: ["<all_urls>"], js: [{ code: "2" }] };
    await Promise.all([
      callUserScripts("create", [first], { chromeApi: fake.chromeApi as never }),
      callUserScripts("create", [second], { chromeApi: fake.chromeApi as never }),
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

  it("keeps disabled definitions through snapshots, edits and restarts", async () => {
    const script = { id: "saved", matches: ["<all_urls>"], js: [{ code: "1" }] };
    const fake = fakeChrome({ registered: [script], stored: { [USER_SCRIPTS_STORAGE_KEY]: [script] } });
    const options = { chromeApi: fake.chromeApi as never };
    await callUserScripts("setEnabled", [{ id: script.id, enabled: false }], options);
    expect(await fake.api.getScripts()).toEqual([]);
    expect(fake.stored[USER_SCRIPTS_STORAGE_KEY]).toEqual([]);
    expect(fake.stored[USER_SCRIPTS_DISABLED_KEY]).toEqual([script]);
    await fake.api.register([script]);
    fake.stored[USER_SCRIPTS_STORAGE_KEY] = [script];
    await restoreUserScripts(options);
    expect(await fake.api.getScripts()).toEqual([]);
    expect(fake.stored[USER_SCRIPTS_STORAGE_KEY]).toEqual([]);
    const edited = { ...script, js: [{ code: "2" }] };
    await callUserScripts("replace", [edited], options);
    expect(fake.stored[USER_SCRIPTS_DISABLED_KEY]).toEqual([edited]);
    expect(await fake.api.getScripts()).toEqual([]);
    await callUserScripts("setEnabled", [{ id: script.id, enabled: true }], options);
    expect(await fake.api.getScripts()).toEqual([edited]);
    expect(fake.stored[USER_SCRIPTS_DISABLED_KEY]).toEqual([]);
    await callUserScripts("setEnabled", [{ id: script.id, enabled: false }], options);
    await callUserScripts("delete", [{ id: script.id }], options);
    expect(fake.stored[USER_SCRIPTS_DISABLED_KEY]).toEqual([]);
    expect(fake.stored[USER_SCRIPTS_STORAGE_KEY]).toEqual([]);
  });

  it("keeps an active script if Chrome refuses to disable it", async () => {
    const script = { id: "saved", matches: ["<all_urls>"], js: [{ code: "1" }] };
    const fake = fakeChrome({ registered: [script], stored: { [USER_SCRIPTS_STORAGE_KEY]: [script] } });
    fake.api.unregister.mockRejectedValueOnce(new Error("Chrome refused"));
    await expect(callUserScripts("setEnabled", [{ id: script.id, enabled: false }], { chromeApi: fake.chromeApi as never })).rejects.toThrow("Chrome refused");
    expect(await fake.api.getScripts()).toEqual([script]);
    expect(fake.stored[USER_SCRIPTS_DISABLED_KEY] ?? []).toEqual([]);
    expect(fake.stored[USER_SCRIPTS_STORAGE_KEY]).toEqual([script]);
  });

  it("rejects invalid definitions before mutating the registry or saved scripts", async () => {
    const script = { id: "saved", matches: ["<all_urls>"], js: [{ code: "1" }] };
    const fake = fakeChrome({ registered: [script], stored: { [USER_SCRIPTS_STORAGE_KEY]: [script] } });
    const options = { chromeApi: fake.chromeApi as never };
    for (const invalid of [{ ...script, matches: [""] }, { ...script, js: [{ code: "" }] }, { ...script, allFrames: "yes" }]) {
      await expect(callUserScripts("replace", [invalid], options)).rejects.toThrow();
    }
    await expect(callUserScripts("register", [[script]], options)).rejects.toThrow("不支持的脚本操作");
    expect(await fake.api.getScripts()).toEqual([script]);
    expect(fake.stored[USER_SCRIPTS_STORAGE_KEY]).toEqual([script]);
    expect(fake.api.unregister).not.toHaveBeenCalled();
  });

  it("runs the agent's create, list, read, edit and enable flow without changing script identity", async () => {
    const fake = fakeChrome({ stored: { [USER_SCRIPTS_STORAGE_KEY]: [] } });
    const options = { chromeApi: fake.chromeApi as never };
    const script = { id: "agent-script", matches: ["https://example.com/*"], js: [{ code: "1" }], runAt: "document_start" as const };
    await expect(callUserScripts("create", [script], options)).resolves.toEqual({ id: script.id, enabled: true });
    await expect(callUserScripts("create", [script], options)).rejects.toThrow("脚本 ID 已存在");
    await expect(callUserScripts("list", [], options)).resolves.toEqual([{ id: script.id, matches: script.matches, enabled: true }]);
    await expect(callUserScripts("read", [script.id], options)).resolves.toEqual({ script, enabled: true });
    await callUserScripts("setEnabled", [{ id: script.id, enabled: false }], options);
    await expect(callUserScripts("create", [{ ...script, js: [{ code: "replacement" }] }], options)).rejects.toThrow("脚本 ID 已存在");
    expect(await fake.api.getScripts()).toEqual([]);
    expect(fake.stored[USER_SCRIPTS_DISABLED_KEY]).toEqual([script]);
    await callUserScripts("setEnabled", [{ id: script.id, enabled: false }], options);
    expect(fake.stored[USER_SCRIPTS_DISABLED_KEY]).toHaveLength(1);
    await expect(callUserScripts("edit", [{ id: script.id, changes: { js: [{ code: "2" }], runAt: null } }], options)).resolves.toEqual({ id: script.id, enabled: false });
    const edited = { id: script.id, matches: script.matches, js: [{ code: "2" }] };
    await expect(callUserScripts("read", [script.id], options)).resolves.toEqual({ script: edited, enabled: false });
    await expect(callUserScripts("setEnabled", [{ id: script.id, enabled: true }], options)).resolves.toEqual({ id: script.id, enabled: true });
    expect(await fake.api.getScripts()).toEqual([edited]);
    await expect(callUserScripts("list", [], options)).resolves.toEqual([{ id: script.id, matches: script.matches, enabled: true }]);
  });
});
