import type { EventLogger } from "../logging";

export const USER_SCRIPTS_STORAGE_KEY = "side-agent:user-scripts";
export const USER_SCRIPTS_DATA_KEY = "side-agent:user-scripts-data";
export const USER_SCRIPTS_ERROR_KEY = "side-agent:user-scripts-error";
export const USER_SCRIPTS_WORLDS_KEY = "side-agent:user-script-worlds";
export const USER_SCRIPTS_LEGACY_KEY = "side-agent:user-scripts-unparsed";
export const USER_SCRIPTS_DISABLED_KEY = "side-agent:user-scripts-disabled";
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
  const stored = await chromeApi.storage.local.get([USER_SCRIPTS_STORAGE_KEY, USER_SCRIPTS_DISABLED_KEY, USER_SCRIPTS_DATA_KEY, USER_SCRIPTS_WORLDS_KEY]);
  const desired = scriptsFromStorage(stored[USER_SCRIPTS_STORAGE_KEY]);
  const disabledIds = new Set(scriptsFromStorage(stored[USER_SCRIPTS_DISABLED_KEY]).map((script) => script.id));
  const registered = await api.getScripts();
  const worlds = stored[USER_SCRIPTS_WORLDS_KEY];
  if (worlds !== undefined && !Array.isArray(worlds)) throw new Error("保存的脚本 world 配置无法识别；原始数据已保留。");
  const currentWorlds = await api.getWorldConfigurations?.() ?? [];
  for (const world of worlds ?? []) {
    const current = currentWorlds.find((item) => item.worldId === world.worldId);
    if (JSON.stringify(current) !== JSON.stringify(world)) await api.configureWorld?.(world);
  }
  for (const script of registered) {
    if (disabledIds.has(script.id)) await api.unregister({ ids: [script.id] });
  }
  const active = registered.filter((script) => !disabledIds.has(script.id));
  if (stored[USER_SCRIPTS_STORAGE_KEY] === undefined && active.length) {
    await snapshotUserScripts(options);
    return true;
  }
  const byId = new Map(active.map((script) => [script.id, script]));
  for (const script of desired) {
    if (disabledIds.has(script.id)) continue;
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
    if (method === "list" || method === "read") {
      const stored = await chromeApi.storage.local.get([USER_SCRIPTS_STORAGE_KEY, USER_SCRIPTS_DISABLED_KEY]);
      const active = scriptsFromStorage(stored[USER_SCRIPTS_STORAGE_KEY]);
      const disabled = scriptsFromStorage(stored[USER_SCRIPTS_DISABLED_KEY]);
      if (method === "list") return [
        ...active.filter((script) => !disabled.some((item) => item.id === script.id)).map(({ id, matches }) => ({ id, matches, enabled: true })),
        ...disabled.map(({ id, matches }) => ({ id, matches, enabled: false })),
      ];
      const id = args[0] as string;
      const script = disabled.find((item) => item.id === id) ?? active.find((item) => item.id === id);
      if (!script) throw new Error("找不到该脚本。");
      return { script, enabled: !disabled.some((item) => item.id === id) };
    }
    const api = chromeApi.userScripts as unknown as Record<string, (...params: unknown[]) => Promise<unknown>> | undefined;
    if (!api || !["replace", "setEnabled", "delete", "create", "edit"].includes(method) && typeof api[method] !== "function") throw new Error("Allow User Scripts 未开启，或 Chrome 不支持该操作。");
    if (method === "create") {
      const script = args[0] as chrome.userScripts.RegisteredUserScript;
      const stored = await chromeApi.storage.local.get([USER_SCRIPTS_STORAGE_KEY, USER_SCRIPTS_DISABLED_KEY]);
      if ([...scriptsFromStorage(stored[USER_SCRIPTS_STORAGE_KEY]), ...scriptsFromStorage(stored[USER_SCRIPTS_DISABLED_KEY])].some((item) => item.id === script.id)
        || (await chromeApi.userScripts!.getScripts({ ids: [script.id] })).length) throw new Error("脚本 ID 已存在。");
      await chromeApi.userScripts!.register([script]);
      await snapshotUserScripts(options);
      return { id: script.id, enabled: true };
    }
    if (method === "setEnabled" || method === "delete") {
      const { id, enabled } = args[0] as { id: string; enabled?: boolean };
      if (typeof id !== "string" || !id || method === "setEnabled" && typeof enabled !== "boolean") throw new Error("无效的脚本操作。");
      const stored = await chromeApi.storage.local.get([USER_SCRIPTS_STORAGE_KEY, USER_SCRIPTS_DISABLED_KEY]);
      const saved = scriptsFromStorage(stored[USER_SCRIPTS_STORAGE_KEY]);
      const disabled = scriptsFromStorage(stored[USER_SCRIPTS_DISABLED_KEY]);
      const active = (await chromeApi.userScripts!.getScripts({ ids: [id] }))[0];
      const script = active ?? disabled.find((item) => item.id === id) ?? saved.find((item) => item.id === id);
      if (!script) throw new Error("找不到该脚本，请刷新状态。");
      if (method === "setEnabled" && enabled) {
        if (!active) await chromeApi.userScripts!.register([script]);
        await chromeApi.storage.local.set({ [USER_SCRIPTS_DISABLED_KEY]: disabled.filter((item) => item.id !== id) });
      } else {
        await chromeApi.storage.local.set({ [USER_SCRIPTS_DISABLED_KEY]: method === "delete" ? disabled.filter((item) => item.id !== id) : [...disabled.filter((item) => item.id !== id), script] });
        try { if (active) await chromeApi.userScripts!.unregister({ ids: [id] }); }
        catch (error) {
          await chromeApi.storage.local.set({ [USER_SCRIPTS_DISABLED_KEY]: disabled });
          throw error;
        }
      }
      await snapshotUserScripts(options);
      return { id, enabled: method === "setEnabled" && enabled === true };
    }
    if (method === "replace" || method === "edit") {
      const id = method === "edit" ? (args[0] as { id: string }).id : (args[0] as chrome.userScripts.RegisteredUserScript).id;
      const stored = await chromeApi.storage.local.get([USER_SCRIPTS_STORAGE_KEY, USER_SCRIPTS_DISABLED_KEY]);
      const disabled = scriptsFromStorage(stored[USER_SCRIPTS_DISABLED_KEY]);
      const previous = (await chromeApi.userScripts!.getScripts({ ids: [id] }))[0];
      const current = previous ?? disabled.find((item) => item.id === id) ?? scriptsFromStorage(stored[USER_SCRIPTS_STORAGE_KEY]).find((item) => item.id === id);
      if (method === "edit" && !current) throw new Error("找不到该脚本。");
      const script = method === "edit"
        ? { ...current!, ...(args[0] as { changes: Record<string, unknown> }).changes } as chrome.userScripts.RegisteredUserScript
        : args[0] as chrome.userScripts.RegisteredUserScript;
      if (method === "edit") for (const [key, value] of Object.entries((args[0] as { changes: Record<string, unknown> }).changes)) {
        if (value === null) delete (script as unknown as Record<string, unknown>)[key];
      }
      if (!previous && disabled.some((item) => item.id === id)) {
        await chromeApi.storage.local.set({ [USER_SCRIPTS_DISABLED_KEY]: disabled.map((item) => item.id === id ? script : item) });
        return { id, enabled: false };
      }
      if (previous) await chromeApi.userScripts!.unregister({ ids: [id] });
      try { await chromeApi.userScripts!.register([script]); }
      catch (error) {
        if (previous) await chromeApi.userScripts!.register([previous]);
        throw error;
      }
      await snapshotUserScripts(options);
      return { id, enabled: true };
    }
    const result = await api[method](...args);
    if (["register", "update", "unregister", "configureWorld", "resetWorldConfiguration"].includes(method)) await snapshotUserScripts(options);
    return result;
  });
}
