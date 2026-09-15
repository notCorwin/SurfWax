import type { EventLogger } from "../logging";

export const USER_SCRIPTS_STORAGE_KEY = "side-agent:user-scripts";
export const USER_SCRIPTS_DATA_KEY = "side-agent:user-scripts-data";
const DATA_VERSION = 2;

type UserScriptsApi = Pick<typeof chrome.userScripts, "getScripts" | "register" | "unregister">;
type UserScriptsChrome = {
  storage: { local: Pick<chrome.storage.StorageArea, "get" | "set"> };
  userScripts?: UserScriptsApi;
};

type DataState = {
  version: number;
  resetPending: boolean;
};

function scriptsFromStorage(value: unknown): chrome.userScripts.RegisteredUserScript[] {
  return Array.isArray(value) ? value as chrome.userScripts.RegisteredUserScript[] : [];
}

export async function restoreUserScripts(options: {
  chromeApi?: UserScriptsChrome;
  logger?: EventLogger;
} = {}): Promise<boolean> {
  const chromeApi = options.chromeApi ?? globalThis.chrome;
  const storage = chromeApi.storage.local;
  const stored = await storage.get([USER_SCRIPTS_STORAGE_KEY, USER_SCRIPTS_DATA_KEY]);
  const state = stored[USER_SCRIPTS_DATA_KEY] as Partial<DataState> | undefined;
  const resetPending = state?.version !== DATA_VERSION
    || state.resetPending === true;

  if (resetPending) {
    await storage.set({
      [USER_SCRIPTS_STORAGE_KEY]: [],
      [USER_SCRIPTS_DATA_KEY]: { version: DATA_VERSION, resetPending: true } satisfies DataState,
    });
  }

  const api = chromeApi.userScripts;
  if (!api) {
    options.logger?.record({
      type: "userscript.unavailable",
      content: { resetPending },
    });
    return false;
  }

  if (resetPending) {
    await api.unregister();
    await storage.set({
      [USER_SCRIPTS_DATA_KEY]: { version: DATA_VERSION, resetPending: false } satisfies DataState,
    });
    options.logger?.record({ type: "userscript.reset", content: null });
    return true;
  }

  const scripts = scriptsFromStorage(stored[USER_SCRIPTS_STORAGE_KEY]);
  const registered = await api.getScripts();
  if (registered.length) await api.unregister();
  if (scripts.length) await api.register(scripts);
  options.logger?.record({ type: "userscript.restored", content: { count: scripts.length } });
  return true;
}

export async function snapshotUserScripts(options: {
  chromeApi?: UserScriptsChrome;
  logger?: EventLogger;
} = {}): Promise<boolean> {
  const chromeApi = options.chromeApi ?? globalThis.chrome;
  if (!chromeApi.userScripts) return false;

  const scripts = await chromeApi.userScripts.getScripts();
  await chromeApi.storage.local.set({
    [USER_SCRIPTS_STORAGE_KEY]: scripts,
    [USER_SCRIPTS_DATA_KEY]: { version: DATA_VERSION, resetPending: false } satisfies DataState,
  });
  options.logger?.record({ type: "userscript.snapshot", content: { count: scripts.length } });
  return true;
}
