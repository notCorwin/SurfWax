import type { EventLogger } from "../logging";

export const USER_SCRIPTS_STORAGE_KEY = "side-agent:user-scripts";
export const USER_SCRIPTS_DATA_KEY = "side-agent:user-scripts-data";
export const USER_SCRIPTS_ERROR_KEY = "side-agent:user-scripts-error";
export const USER_SCRIPTS_WORLDS_KEY = "side-agent:user-script-worlds";
export const USER_SCRIPTS_LEGACY_KEY = "side-agent:user-scripts-unparsed";
const DATA_VERSION = 3;

type UserScriptsApi = Pick<typeof chrome.userScripts, "getScripts" | "register" | "unregister" | "update">
  & Partial<Pick<typeof chrome.userScripts, "getWorldConfigurations" | "configureWorld">>;
type UserScriptsChrome = {
  storage: { local: Pick<chrome.storage.StorageArea, "get" | "set"> };
  userScripts?: UserScriptsApi;
};

function scriptsFromStorage(value: unknown): chrome.userScripts.RegisteredUserScript[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((script) => script && typeof script === "object"
    && typeof script.id === "string" && Array.isArray(script.matches) && Array.isArray(script.js))) {
    throw new Error("保存的用户脚本格式无法识别；原始数据已保留，请手动检查。");
  }
  return value as chrome.userScripts.RegisteredUserScript[];
}

export async function restoreUserScripts(options: { chromeApi?: UserScriptsChrome; logger?: EventLogger } = {}): Promise<boolean> {
  const chromeApi = options.chromeApi ?? globalThis.chrome;
  const api = chromeApi.userScripts;
  if (!api) {
    options.logger?.record({ type: "userscript.unavailable", content: null });
    return false;
  }
  const stored = await chromeApi.storage.local.get([USER_SCRIPTS_STORAGE_KEY, USER_SCRIPTS_DATA_KEY, USER_SCRIPTS_WORLDS_KEY]);
  const desired = scriptsFromStorage(stored[USER_SCRIPTS_STORAGE_KEY]);
  const registered = await api.getScripts();
  const worlds = stored[USER_SCRIPTS_WORLDS_KEY];
  if (worlds !== undefined && !Array.isArray(worlds)) throw new Error("保存的脚本 world 配置无法识别；原始数据已保留。");
  const currentWorlds = await api.getWorldConfigurations?.() ?? [];
  for (const world of worlds ?? []) {
    const current = currentWorlds.find((item) => item.worldId === world.worldId);
    if (JSON.stringify(current) !== JSON.stringify(world)) await api.configureWorld?.(world);
  }
  if (stored[USER_SCRIPTS_STORAGE_KEY] === undefined && registered.length) {
    await snapshotUserScripts(options);
    return true;
  }
  const byId = new Map(registered.map((script) => [script.id, script]));
  for (const script of desired) {
    const current = byId.get(script.id);
    if (!current) await api.register([script]);
    else if (JSON.stringify(current) !== JSON.stringify(script)) await api.update([script]);
  }
  await snapshotUserScripts(options);
  options.logger?.record({ type: "userscript.restored", content: { count: desired.length } });
  return true;
}

export async function snapshotUserScripts(options: { chromeApi?: UserScriptsChrome; logger?: EventLogger } = {}): Promise<boolean> {
  const chromeApi = options.chromeApi ?? globalThis.chrome;
  if (!chromeApi.userScripts) return false;
  const scripts = await chromeApi.userScripts.getScripts();
  const stored = await chromeApi.storage.local.get([USER_SCRIPTS_STORAGE_KEY, USER_SCRIPTS_LEGACY_KEY]);
  let legacy: Record<string, unknown> = {};
  try { scriptsFromStorage(stored[USER_SCRIPTS_STORAGE_KEY]); }
  catch {
    if (stored[USER_SCRIPTS_LEGACY_KEY] === undefined) legacy = { [USER_SCRIPTS_LEGACY_KEY]: stored[USER_SCRIPTS_STORAGE_KEY] };
  }
  const worlds = await chromeApi.userScripts.getWorldConfigurations?.();
  await chromeApi.storage.local.set({
    ...legacy,
    [USER_SCRIPTS_STORAGE_KEY]: scripts,
    [USER_SCRIPTS_DATA_KEY]: { version: DATA_VERSION },
    ...(worlds ? { [USER_SCRIPTS_WORLDS_KEY]: worlds } : {}),
  });
  options.logger?.record({ type: "userscript.snapshot", content: { count: scripts.length } });
  return true;
}

let tail: Promise<unknown> = Promise.resolve();
export function serializeUserScripts<T>(operation: () => Promise<T>): Promise<T> {
  const task = tail.then(operation);
  tail = task.catch(() => undefined);
  return task;
}

export function callUserScripts(method: string, args: unknown[], options: { chromeApi?: UserScriptsChrome; logger?: EventLogger } = {}): Promise<unknown> {
  return serializeUserScripts(async () => {
    const chromeApi = options.chromeApi ?? globalThis.chrome;
    const api = chromeApi.userScripts as unknown as Record<string, (...params: unknown[]) => Promise<unknown>> | undefined;
    if (!api || method !== "replace" && typeof api[method] !== "function") throw new Error("Allow User Scripts 未开启，或 Chrome 不支持该操作。");
    if (method === "replace") {
      const script = args[0] as chrome.userScripts.RegisteredUserScript;
      const previous = (await chromeApi.userScripts!.getScripts({ ids: [script.id] }))[0];
      if (previous) await chromeApi.userScripts!.unregister({ ids: [script.id] });
      try { await chromeApi.userScripts!.register([script]); }
      catch (error) {
        if (previous) await chromeApi.userScripts!.register([previous]);
        throw error;
      }
      await snapshotUserScripts(options);
      return;
    }
    const result = await api[method](...args);
    if (["register", "update", "unregister", "configureWorld", "resetWorldConfiguration"].includes(method)) await snapshotUserScripts(options);
    return result;
  });
}
