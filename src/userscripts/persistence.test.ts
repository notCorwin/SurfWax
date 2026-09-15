import { describe, expect, it, vi } from "vitest";
import { restoreUserScripts, snapshotUserScripts, USER_SCRIPTS_DATA_KEY, USER_SCRIPTS_STORAGE_KEY } from "./persistence";

function fakeChrome(options: { available?: boolean; stored?: Record<string, unknown>; registered?: chrome.userScripts.RegisteredUserScript[] } = {}) {
  const stored = { ...(options.stored ?? {}) };
  let registered = [...(options.registered ?? [])];
  const api = {
    getScripts: vi.fn(async () => [...registered]),
    register: vi.fn(async (scripts: chrome.userScripts.RegisteredUserScript[]) => { registered.push(...scripts); }),
    unregister: vi.fn(async () => { registered = []; }),
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
  it("marks the 0.2 reset pending until the native API becomes available", async () => {
    const fake = fakeChrome({ available: false, stored: { [USER_SCRIPTS_STORAGE_KEY]: [{ id: "legacy" }] } });
    await expect(restoreUserScripts({ chromeApi: fake.chromeApi as never })).resolves.toBe(false);
    expect(fake.stored[USER_SCRIPTS_STORAGE_KEY]).toEqual([]);
    expect(fake.stored[USER_SCRIPTS_DATA_KEY]).toEqual({ version: 2, resetPending: true });
  });

  it("removes legacy registrations, restores saved native definitions, and snapshots changes", async () => {
    const legacy = { id: "legacy", matches: ["<all_urls>"], js: [{ code: "1" }] };
    const fake = fakeChrome({ registered: [legacy] });
    await restoreUserScripts({ chromeApi: fake.chromeApi as never });
    expect(fake.api.unregister).toHaveBeenCalled();
    expect(fake.stored[USER_SCRIPTS_DATA_KEY]).toEqual({ version: 2, resetPending: false });

    const saved = { id: "saved", matches: ["<all_urls>"], js: [{ code: "2" }] };
    fake.stored[USER_SCRIPTS_STORAGE_KEY] = [saved];
    await restoreUserScripts({ chromeApi: fake.chromeApi as never });
    expect(fake.api.register).toHaveBeenLastCalledWith([saved]);
    await snapshotUserScripts({ chromeApi: fake.chromeApi as never });
    expect(fake.stored[USER_SCRIPTS_STORAGE_KEY]).toEqual([saved]);
  });
});
