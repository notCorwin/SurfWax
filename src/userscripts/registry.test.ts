import { describe, expect, it, vi } from "vitest";
import {
  USER_SCRIPTS_STORAGE_KEY,
  UserScriptRegistry,
  type UserScriptStorage,
} from "./registry";

function memoryStorage(initial: unknown[] = []) {
  let records = initial;
  const storage = {
    get: vi.fn(async () => ({ [USER_SCRIPTS_STORAGE_KEY]: records })),
    set: vi.fn(async (items: Record<string, unknown>) => {
      records = items[USER_SCRIPTS_STORAGE_KEY] as unknown[];
    }),
  } as unknown as UserScriptStorage;
  return { storage, read: () => records };
}

function fakeApi() {
  return {
    register: vi.fn(async () => undefined),
    update: vi.fn(async () => undefined),
    unregister: vi.fn(async () => undefined),
    getScripts: vi.fn(async () => []),
    execute: vi.fn(async () => [{ frameId: 0, result: "ok" }]),
  };
}

const definition = {
  id: "page-helper",
  matches: ["<all_urls>"],
  js: [{ code: "document.documentElement.dataset.agent = 'ready';" }],
  world: "MAIN" as const,
};

function makeRegistry() {
  const api = fakeApi();
  const storage = memoryStorage();
  const registry = new UserScriptRegistry({
    chromeApi: { userScripts: api } as never,
    storage: storage.storage,
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  });
  return { api, storage, registry };
}

describe("UserScriptRegistry", () => {
  it("persists native scripts and unregisters an edited script when it is disabled", async () => {
    const { api, registry } = makeRegistry();

    await registry.replace(definition, { label: "Page helper" });
    await registry.replace({ ...definition, js: [{ code: "document.title;" }] }, { enabled: false });

    expect(api.register).toHaveBeenCalledTimes(1);
    expect(api.unregister).toHaveBeenCalledWith({ ids: [definition.id] });
    await expect(registry.list()).resolves.toMatchObject([{
      id: definition.id,
      label: "Page helper",
      enabled: false,
      js: [{ code: "document.title;" }],
    }]);
  });

  it("keeps agent register/update/unregister on the single chrome tool path", async () => {
    const { api, registry, storage } = makeRegistry();

    await expect(registry.handleAgentCall("userScripts.register", [[definition]])).resolves.toEqual({
      handled: true,
      value: undefined,
    });
    await expect(registry.handleAgentCall("userScripts.update", [[{
      id: definition.id,
      js: [{ code: "document.title;" }],
    }]])).resolves.toMatchObject({ handled: true });
    await registry.handleAgentCall("userScripts.unregister", [{ ids: [definition.id] }]);

    expect(api.register).toHaveBeenCalledWith([definition]);
    expect(api.update).toHaveBeenCalledWith([{ id: definition.id, js: [{ code: "document.title;" }] }]);
    expect(api.unregister).toHaveBeenCalledWith({ ids: [definition.id] });
    expect(storage.read()).toEqual([]);
  });

  it("lets the agent view saved scripts and execute native injections", async () => {
    const { api, registry } = makeRegistry();

    await registry.handleAgentCall("userScripts.register", [[definition]]);
    const scripts = await registry.handleAgentCall("userScripts.getScripts", []);
    expect(scripts).toMatchObject({ handled: true, value: [definition] });

    const injection = {
      target: { tabId: 7 },
      js: [{ code: "document.title" }],
      world: "MAIN",
    };
    await registry.handleAgentCall("userScripts.execute", [injection]);
    expect(api.execute).toHaveBeenCalledWith(injection);
  });

  it("updates disabled scripts in Harness storage without re-registering them", async () => {
    const { api, registry } = makeRegistry();

    await registry.replace(definition, { enabled: false });
    await registry.handleAgentCall("userScripts.update", [[{
      id: definition.id,
      js: [{ code: "document.body.dataset.updated = 'yes';" }],
    }]]);

    expect(api.update).not.toHaveBeenCalled();
    await expect(registry.list()).resolves.toMatchObject([{
      id: definition.id,
      enabled: false,
      js: [{ code: "document.body.dataset.updated = 'yes';" }],
    }]);
  });

  it("executes current script source in the selected tab", async () => {
    const { api, registry } = makeRegistry();

    await expect(registry.execute(definition, 7)).resolves.toEqual([{ frameId: 0, result: "ok" }]);
    expect(api.execute).toHaveBeenCalledWith({
      target: { tabId: 7 },
      js: definition.js,
      world: "MAIN",
      injectImmediately: true,
    });
  });
});
