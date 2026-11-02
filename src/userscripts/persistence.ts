import type { EventLogger } from "../logging";
import { safeDiagnosticError } from "../diagnostic-error";
import { scriptChanges, scriptDefinition, scriptId } from "./schema";

export const USER_SCRIPTS_STORAGE_KEY = "side-agent:user-scripts";
export const USER_SCRIPTS_ERROR_KEY = "side-agent:user-scripts-error";
export const USER_SCRIPTS_WORLDS_KEY = "side-agent:user-script-worlds";
export const USER_SCRIPTS_LEGACY_KEY = "side-agent:user-scripts-unparsed";
export const USER_SCRIPTS_DISABLED_KEY = "side-agent:user-scripts-disabled";

type UserScriptsApi = Pick<typeof chrome.userScripts, "getScripts" | "register" | "unregister">
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
    options.logger?.telemetry({ type: "userscript.unavailable", content: null });
    return false;
  }
  const stored = await chromeApi.storage.local.get([USER_SCRIPTS_STORAGE_KEY, USER_SCRIPTS_DISABLED_KEY, USER_SCRIPTS_WORLDS_KEY]);
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
  if (stored[USER_SCRIPTS_STORAGE_KEY] === undefined) {
    await snapshotUserScripts(options);
    return true;
  }
  const desiredIds = new Set(desired.map((script) => script.id));
  for (const script of active) {
    if (!desiredIds.has(script.id)) await api.unregister({ ids: [script.id] });
  }
  const byId = new Map(active.map((script) => [script.id, script]));
  for (const script of desired) {
    if (disabledIds.has(script.id)) continue;
    const current = byId.get(script.id);
    if (!current) await api.register([script]);
    else if (JSON.stringify(current) !== JSON.stringify(script)) {
      // update() merges properties, so omitted optional fields would survive.
      // Re-register the declaration exactly, restoring the prior projection if
      // registration fails; storage remains authoritative for a later retry.
      await api.unregister({ ids: [script.id] });
      try { await api.register([script]); }
      catch (error) {
        try { await api.register([current]); } catch (rollbackError) {
          options.logger?.telemetry({ type: "userscript.rollback.failed", content: { scriptId: script.id, operation: "restore", step: "register-previous" }, error: safeDiagnosticError(rollbackError) });
          throw new AggregateError([error, rollbackError], `User script ${script.id} restore failed: ${String(error)}; rollback registration failed: ${String(rollbackError)}`, { cause: error });
        }
        throw error;
      }
    }
  }
  // Storage is the declaration; the native registry is only its executable
  // projection. Normalize a legacy active/disabled conflict without taking a
  // reverse snapshot that could make unrelated native drift canonical.
  const normalized = desired.filter((script) => !disabledIds.has(script.id));
  if (normalized.length !== desired.length) await chromeApi.storage.local.set({ [USER_SCRIPTS_STORAGE_KEY]: normalized });
  options.logger?.telemetry({ type: "userscript.restored", content: { count: desired.length } });
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
    ...(worlds ? { [USER_SCRIPTS_WORLDS_KEY]: worlds } : {}),
  });
  options.logger?.telemetry({ type: "userscript.snapshot", content: { count: scripts.length } });
  return true;
}

let tail: Promise<unknown> = Promise.resolve();
export function serializeUserScripts<T>(operation: () => Promise<T>): Promise<T> {
  const task = tail.then(operation);
  tail = task.catch(() => undefined);
  return task;
}

export function callUserScripts(method: string, args: unknown[], options: { chromeApi?: UserScriptsChrome; logger?: EventLogger; beforeExecute?: () => void } = {}): Promise<unknown> {
  return serializeUserScripts(async () => {
    options.beforeExecute?.();
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
    if (!chromeApi.userScripts) throw new Error("Allow User Scripts 未开启，或 Chrome 不支持该操作。");
    if (!["replace", "setEnabled", "delete", "create", "edit"].includes(method)) throw new Error("不支持的脚本操作。");
    if (method === "create" || method === "replace") scriptDefinition.parse(args[0]);
    if (method === "edit") {
      const input = args[0] as { id?: unknown; changes?: unknown } | undefined;
      scriptId.parse(input?.id);
      scriptChanges.parse(input?.changes);
    }
    let stored = await chromeApi.storage.local.get([USER_SCRIPTS_STORAGE_KEY, USER_SCRIPTS_DISABLED_KEY]);
    // A pre-existing native registry is the initial declaration until the
    // first snapshot succeeds. Never overwrite it with a single new script.
    if (stored[USER_SCRIPTS_STORAGE_KEY] === undefined) {
      await restoreUserScripts(options);
      stored = await chromeApi.storage.local.get([USER_SCRIPTS_STORAGE_KEY, USER_SCRIPTS_DISABLED_KEY]);
    }
    const saved = scriptsFromStorage(stored[USER_SCRIPTS_STORAGE_KEY]);
    const disabled = scriptsFromStorage(stored[USER_SCRIPTS_DISABLED_KEY]);
    const id = method === "create" || method === "replace"
      ? (args[0] as chrome.userScripts.RegisteredUserScript).id
      : (args[0] as { id?: unknown })?.id;
    scriptId.parse(id);
    const scriptIdValue = id as string;
    const savedScript = saved.find((item) => item.id === scriptIdValue);
    const disabledScript = disabled.find((item) => item.id === scriptIdValue);
    const previous = (await chromeApi.userScripts.getScripts({ ids: [scriptIdValue] }))[0];
    const declared = disabledScript ?? savedScript;
    let next: chrome.userScripts.RegisteredUserScript | undefined;
    let enabled = false;

    if (method === "create") {
      if (declared) throw new Error("脚本 ID 已存在。");
      next = args[0] as chrome.userScripts.RegisteredUserScript;
      enabled = true;
    } else if (method === "edit" || method === "replace") {
      if (method === "edit" && !declared) throw new Error("找不到该脚本。");
      next = method === "edit"
        ? { ...declared!, ...(args[0] as { changes: Record<string, unknown> }).changes } as chrome.userScripts.RegisteredUserScript
        : args[0] as chrome.userScripts.RegisteredUserScript;
      if (method === "edit") for (const [key, value] of Object.entries((args[0] as { changes: Record<string, unknown> }).changes)) {
        if (value === null) delete (next as unknown as Record<string, unknown>)[key];
      }
      scriptDefinition.parse(next);
      enabled = !disabledScript;
    } else if (method === "setEnabled") {
      const requested = (args[0] as { enabled?: unknown }).enabled;
      if (typeof requested !== "boolean") throw new Error("无效的脚本操作。");
      next = declared;
      if (!next) throw new Error("找不到该脚本，请刷新状态。");
      enabled = requested;
    } else if (method === "delete") {
      if (!declared) throw new Error("找不到该脚本，请刷新状态。");
    }

    // Only reconcile this declaration. Unrelated saved scripts may still be
    // awaiting startup recovery; never replace them with a registry snapshot.
    const nativeMatches = enabled && previous && JSON.stringify(previous) === JSON.stringify(next);
    const replaceNative = Boolean(previous && !nativeMatches);
    const registerNative = Boolean(enabled && next && !nativeMatches);
    options.beforeExecute?.();
    let removed = false;
    let registered = false;
    try {
      if (replaceNative) { await chromeApi.userScripts.unregister({ ids: [scriptIdValue] }); removed = true; }
      if (registerNative) { await chromeApi.userScripts.register([next!]); registered = true; }
      const update = (scripts: chrome.userScripts.RegisteredUserScript[], replacement?: chrome.userScripts.RegisteredUserScript) => {
        const index = scripts.findIndex((item) => item.id === scriptIdValue);
        if (index < 0) return replacement ? [...scripts, replacement] : scripts;
        if (!replacement) return scripts.filter((item) => item.id !== scriptIdValue);
        return scripts.map((item, itemIndex) => itemIndex === index ? replacement : item);
      };
      const activeNext = update(saved, enabled ? next : undefined);
      const disabledNext = update(disabled, !enabled ? next : undefined);
      const changes: Record<string, unknown> = {};
      if (JSON.stringify(saved) !== JSON.stringify(activeNext)) changes[USER_SCRIPTS_STORAGE_KEY] = activeNext;
      if (JSON.stringify(disabled) !== JSON.stringify(disabledNext)) changes[USER_SCRIPTS_DISABLED_KEY] = disabledNext;
      if (Object.keys(changes).length) await chromeApi.storage.local.set(changes);
    } catch (error) {
      // Storage is still authoritative. Restore the previous projection when
      // possible; startup reconciliation repairs an interrupted rollback.
      const failures: Array<{ step: string; error: unknown }> = [];
      if (registered) try { await chromeApi.userScripts.unregister({ ids: [scriptIdValue] }); } catch (failure) { failures.push({ step: "unregister-replacement", error: failure }); }
      if (removed && previous) try { await chromeApi.userScripts.register([previous]); } catch (failure) { failures.push({ step: "register-previous", error: failure }); }
      if (failures.length) {
        options.logger?.telemetry({ type: "userscript.rollback.failed", content: { scriptId: scriptIdValue, operation: method, failures: failures.map((failure) => ({ ...failure, error: safeDiagnosticError(failure.error) })) }, error: safeDiagnosticError(error) });
        throw new AggregateError([error, ...failures.map((failure) => failure.error)], `User script ${scriptIdValue} ${method} failed: ${String(error)}; rollback failed: ${failures.map(({ step, error: failure }) => `${step}: ${String(failure)}`).join("; ")}`, { cause: error });
      }
      throw error;
    }
    return { id: scriptIdValue, enabled };
  });
}
