import type { EventLogger } from "../logging";

export type UserScriptWorld = "MAIN" | "USER_SCRIPT";
export type UserScriptRunAt = "document_start" | "document_end" | "document_idle";
export type UserScriptSource = { code: string } | { file: string };

export type UserScriptDefinition = {
  id: string;
  matches: string[];
  js: UserScriptSource[];
  excludeMatches?: string[];
  includeGlobs?: string[];
  excludeGlobs?: string[];
  runAt?: UserScriptRunAt;
  world?: UserScriptWorld;
  worldId?: string;
  allFrames?: boolean;
};

export type StoredUserScript = UserScriptDefinition & {
  label: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type UserScriptStorage = Pick<chrome.storage.StorageArea, "get" | "set">;

type UserScriptApi = {
  register(scripts: chrome.userScripts.RegisteredUserScript[]): Promise<void>;
  update(scripts: chrome.userScripts.RegisteredUserScript[]): Promise<void>;
  unregister(filter?: chrome.userScripts.UserScriptFilter): Promise<void>;
  getScripts(filter?: chrome.userScripts.UserScriptFilter): Promise<chrome.userScripts.RegisteredUserScript[]>;
  execute<T>(injection: chrome.userScripts.UserScriptInjection): Promise<chrome.userScripts.InjectionResult<T>[]>;
};

type UserScriptChromeApi = {
  storage?: typeof chrome.storage;
  userScripts?: UserScriptApi;
};

type AgentUserScriptUpdate = {
  id: string;
  matches?: string[];
  js?: UserScriptSource[];
  excludeMatches?: string[];
  includeGlobs?: string[];
  excludeGlobs?: string[];
  runAt?: UserScriptRunAt;
  world?: UserScriptWorld;
  worldId?: string;
  allFrames?: boolean;
};

export const USER_SCRIPTS_STORAGE_KEY = "side-agent:user-scripts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringArray(value: unknown, field: string, required: true): string[];
function stringArray(value: unknown, field: string, required?: false): string[] | undefined;
function stringArray(value: unknown, field: string, required = false): string[] | undefined {
  if (value === undefined && !required) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.trim())) {
    throw new Error(`${field} must be an array of non-empty strings`);
  }
  return [...value];
}

function sources(value: unknown, required: true): UserScriptSource[];
function sources(value: unknown, required?: false): UserScriptSource[] | undefined;
function sources(value: unknown, required = true): UserScriptSource[] | undefined {
  if (value === undefined && !required) return undefined;
  if (!Array.isArray(value) || value.length === 0) throw new Error("js must be a non-empty array");
  return value.map((item, index) => {
    if (!isRecord(item)) throw new Error(`js[${index}] must be an object`);
    const hasCode = typeof item.code === "string" && item.code.length > 0;
    const hasFile = typeof item.file === "string" && item.file.trim().length > 0;
    if (hasCode === hasFile) throw new Error(`js[${index}] must contain exactly one non-empty code or file`);
    return hasCode ? { code: item.code as string } : { file: (item.file as string).trim() };
  });
}

function validateId(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("User script id is required");
  const id = value.trim();
  if (id.startsWith("_")) throw new Error("User script id cannot start with _");
  return id;
}

function normalizeDefinition(value: unknown): UserScriptDefinition {
  if (!isRecord(value)) throw new Error("User script definition must be an object");
  const matches = stringArray(value.matches, "matches", true)!;
  const js = sources(value.js)!;
  const world = value.world === undefined ? undefined : value.world;
  if (world !== undefined && world !== "MAIN" && world !== "USER_SCRIPT") {
    throw new Error("world must be MAIN or USER_SCRIPT");
  }
  const worldId = value.worldId === undefined ? undefined : value.worldId;
  if (worldId !== undefined && (typeof worldId !== "string" || !worldId.trim() || worldId.trim().startsWith("_"))) {
    throw new Error("worldId must be a non-empty string that does not start with _");
  }
  if (world === "MAIN" && worldId !== undefined) throw new Error("worldId is only valid for USER_SCRIPT");
  const runAt = value.runAt === undefined ? undefined : value.runAt;
  if (runAt !== undefined && runAt !== "document_start" && runAt !== "document_end" && runAt !== "document_idle") {
    throw new Error("runAt must be document_start, document_end, or document_idle");
  }
  if (value.allFrames !== undefined && typeof value.allFrames !== "boolean") {
    throw new Error("allFrames must be a boolean");
  }

  const excludeMatches = stringArray(value.excludeMatches, "excludeMatches");
  const includeGlobs = stringArray(value.includeGlobs, "includeGlobs");
  const excludeGlobs = stringArray(value.excludeGlobs, "excludeGlobs");
  return {
    id: validateId(value.id),
    matches,
    js,
    ...(excludeMatches === undefined ? {} : { excludeMatches }),
    ...(includeGlobs === undefined ? {} : { includeGlobs }),
    ...(excludeGlobs === undefined ? {} : { excludeGlobs }),
    ...(runAt === undefined ? {} : { runAt: runAt as UserScriptRunAt }),
    ...(world === undefined ? {} : { world: world as UserScriptWorld }),
    ...(worldId === undefined ? {} : { worldId: worldId.trim() }),
    ...(value.allFrames === undefined ? {} : { allFrames: value.allFrames as boolean }),
  };
}

function normalizeUpdate(value: unknown): AgentUserScriptUpdate {
  if (!isRecord(value)) throw new Error("User script update must be an object");
  const update: AgentUserScriptUpdate = { id: validateId(value.id) };
  if (value.matches !== undefined) update.matches = stringArray(value.matches, "matches", true);
  if (value.js !== undefined) update.js = sources(value.js, true);
  if (value.excludeMatches !== undefined) update.excludeMatches = stringArray(value.excludeMatches, "excludeMatches", true);
  if (value.includeGlobs !== undefined) update.includeGlobs = stringArray(value.includeGlobs, "includeGlobs", true);
  if (value.excludeGlobs !== undefined) update.excludeGlobs = stringArray(value.excludeGlobs, "excludeGlobs", true);
  if (value.runAt !== undefined) {
    if (value.runAt !== "document_start" && value.runAt !== "document_end" && value.runAt !== "document_idle") {
      throw new Error("runAt must be document_start, document_end, or document_idle");
    }
    update.runAt = value.runAt;
  }
  if (value.world !== undefined) {
    if (value.world !== "MAIN" && value.world !== "USER_SCRIPT") throw new Error("world must be MAIN or USER_SCRIPT");
    update.world = value.world;
  }
  if (value.worldId !== undefined) {
    if (typeof value.worldId !== "string" || !value.worldId.trim() || value.worldId.trim().startsWith("_")) {
      throw new Error("worldId must be a non-empty string that does not start with _");
    }
    if (value.world === "MAIN") throw new Error("worldId is only valid for USER_SCRIPT");
    update.worldId = value.worldId.trim();
  }
  if (value.allFrames !== undefined) {
    if (typeof value.allFrames !== "boolean") throw new Error("allFrames must be a boolean");
    update.allFrames = value.allFrames;
  }
  return update;
}

function nativeDefinition(definition: UserScriptDefinition): chrome.userScripts.RegisteredUserScript {
  const {
    id,
    matches,
    js,
    excludeMatches,
    includeGlobs,
    excludeGlobs,
    runAt,
    world,
    worldId,
    allFrames,
  } = definition;
  return {
    id,
    matches,
    js,
    ...(excludeMatches === undefined ? {} : { excludeMatches }),
    ...(includeGlobs === undefined ? {} : { includeGlobs }),
    ...(excludeGlobs === undefined ? {} : { excludeGlobs }),
    ...(runAt === undefined ? {} : { runAt }),
    ...(world === undefined ? {} : { world }),
    ...(worldId === undefined ? {} : { worldId }),
    ...(allFrames === undefined ? {} : { allFrames }),
  };
}

function nativeUpdate(update: AgentUserScriptUpdate): chrome.userScripts.RegisteredUserScript {
  return update as chrome.userScripts.RegisteredUserScript;
}

function defaultStorage(chromeApi: UserScriptChromeApi): UserScriptStorage {
  if (!chromeApi.storage?.local) throw new Error("Chrome storage is unavailable");
  return chromeApi.storage.local;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Operation aborted", "AbortError");
}

export class UserScriptRegistry {
  private readonly chromeApi: UserScriptChromeApi;
  private readonly storage: UserScriptStorage;
  private readonly logger?: EventLogger;
  private readonly now: () => Date;
  private pending: Promise<void> = Promise.resolve();

  constructor(options: { chromeApi?: UserScriptChromeApi; storage?: UserScriptStorage; logger?: EventLogger; now?: () => Date } = {}) {
    this.chromeApi = options.chromeApi ?? (globalThis.chrome as UserScriptChromeApi);
    this.storage = options.storage ?? defaultStorage(this.chromeApi);
    this.logger = options.logger;
    this.now = options.now ?? (() => new Date());
  }

  isAvailable(): boolean {
    return Boolean(this.chromeApi.userScripts);
  }

  async list(): Promise<StoredUserScript[]> {
    return this.load();
  }

  async replace(value: unknown, options: { label?: string; enabled?: boolean; actor?: "user" | "agent" } = {}): Promise<StoredUserScript> {
    const actor = options.actor ?? "user";
    return this.withFailureLog(this.enqueue(async () => {
      const definition = normalizeDefinition(value);
      const records = await this.load();
      const existing = records.find((script) => script.id === definition.id);
      const enabled = options.enabled ?? existing?.enabled ?? true;
      const now = this.now().toISOString();
      const next: StoredUserScript = {
        ...definition,
        label: options.label === undefined ? existing?.label ?? definition.id : options.label.trim() || definition.id,
        enabled,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };

      if (existing?.enabled) {
        const api = this.requireApi();
        await api.unregister({ ids: [definition.id] });
        if (enabled) {
          try {
            await api.register([nativeDefinition(definition)]);
          } catch (error) {
            await api.register([nativeDefinition(existing)]).catch(() => undefined);
            throw error;
          }
        }
      } else if (enabled) {
        await this.requireApi().register([nativeDefinition(definition)]);
      }

      await this.write(records.some((script) => script.id === definition.id)
        ? records.map((script) => script.id === definition.id ? next : script)
        : [...records, next]);
      this.recordEvent("replace", actor, next);
      return next;
    }), "replace", actor, value);
  }

  async setEnabled(id: string, enabled: boolean, actor: "user" | "agent" = "user"): Promise<void> {
    return this.withFailureLog(this.enqueue(async () => {
      const records = await this.load();
      const script = records.find((item) => item.id === id);
      if (!script) throw new Error(`Unknown user script: ${id}`);
      if (script.enabled === enabled) return;

      if (enabled) await this.requireApi().register([nativeDefinition(script)]);
      else await this.requireApi().unregister({ ids: [id] });

      await this.write(records.map((item) => item.id === id
        ? { ...item, enabled, updatedAt: this.now().toISOString() }
        : item));
      this.recordEvent(enabled ? "enable" : "disable", actor, { id, enabled });
    }), enabled ? "enable" : "disable", actor, { id, enabled });
  }

  async remove(id: string, actor: "user" | "agent" = "user"): Promise<void> {
    return this.withFailureLog(this.enqueue(async () => {
      const records = await this.load();
      const script = records.find((item) => item.id === id);
      if (!script) return;
      if (script.enabled) await this.requireApi().unregister({ ids: [id] });
      await this.write(records.filter((item) => item.id !== id));
      this.recordEvent("delete", actor, { id });
    }), "delete", actor, { id });
  }

  async execute(value: unknown, tabId: number, actor: "user" | "agent" = "user", signal?: AbortSignal): Promise<unknown> {
    return this.withFailureLog(this.enqueue(async () => {
      throwIfAborted(signal);
      const definition = normalizeDefinition(value);
      if (!Number.isInteger(tabId) || tabId < 0) throw new Error("A valid target tabId is required");
      const result = await this.requireApi().execute({
        target: {
          tabId,
          ...(definition.allFrames === undefined ? {} : { allFrames: definition.allFrames }),
        },
        js: definition.js as [chrome.userScripts.ScriptSource, ...chrome.userScripts.ScriptSource[]],
        ...(definition.world === undefined ? {} : { world: definition.world }),
        ...(definition.worldId === undefined ? {} : { worldId: definition.worldId }),
        injectImmediately: true,
      });
      throwIfAborted(signal);
      this.recordEvent("execute", actor, { id: definition.id, tabId, result });
      return result;
    }), "execute", actor, { tabId, value });
  }

  async restore(): Promise<void> {
    return this.withFailureLog(this.enqueue(async () => {
      const records = await this.load();
      const api = this.requireApi();
      const managedIds = records.map((script) => script.id);
      if (managedIds.length) await api.unregister({ ids: managedIds });
      for (const script of records.filter((item) => item.enabled)) {
        try {
          await api.register([nativeDefinition(script)]);
        } catch (error) {
          this.recordEvent("restore-error", "system", { id: script.id, error });
        }
      }
      this.recordEvent("restore", "system", { count: records.filter((item) => item.enabled).length });
    }), "restore", "system", null);
  }

  async handleAgentCall(path: string, args: unknown[], signal?: AbortSignal): Promise<{ handled: boolean; value?: unknown }> {
    if (path !== "userScripts.register" && path !== "userScripts.update" && path !== "userScripts.unregister" && path !== "userScripts.getScripts" && path !== "userScripts.execute") {
      return { handled: false };
    }

    const operation = this.withFailureLog(this.enqueue(async () => {
      throwIfAborted(signal);
      const api = this.requireApi();
      if (path === "userScripts.getScripts") {
        const filter = this.readFilter(args[0]);
        const records = await this.load();
        const native = await api.getScripts(filter);
        const nativeIds = new Set(native.map((script) => script.id));
        const ids = filter?.ids as string[] | undefined;
        const savedButUnregistered = records
          .filter((script) => (!ids || ids.includes(script.id)) && !nativeIds.has(script.id))
          .map(nativeDefinition);
        this.recordEvent("getScripts", "agent", filter ?? null);
        return { handled: true, value: [...native, ...savedButUnregistered] };
      }

      if (path === "userScripts.execute") {
        if (!isRecord(args[0])) throw new Error("userScripts.execute requires an injection object");
        const result = await this.abortable(api.execute(args[0] as unknown as chrome.userScripts.UserScriptInjection), signal);
        throwIfAborted(signal);
        this.recordEvent("execute", "agent", { injection: args[0], result });
        return { handled: true, value: result };
      }

      if (path === "userScripts.register") {
        const definitions = this.readDefinitionList(args[0]);
        const records = await this.load();
        const ids = new Set(definitions.map((script) => script.id));
        const native = await api.getScripts({ ids: [...ids] });
        if (ids.size !== definitions.length || native.length > 0 || definitions.some((script) => records.some((item) => item.id === script.id))) {
          throw new Error("User script id is already registered");
        }
        await api.register(definitions.map(nativeDefinition));
        const now = this.now().toISOString();
        await this.write([...records, ...definitions.map((script) => ({
          ...script,
          label: script.id,
          enabled: true,
          createdAt: now,
          updatedAt: now,
        }))]);
        this.recordEvent("register", "agent", definitions);
        return { handled: true, value: undefined };
      }

      if (path === "userScripts.update") {
        const updates = this.readUpdateList(args[0]);
        const records = await this.load();
        const ids = updates.map((update) => update.id);
        const native = await api.getScripts({ ids });
        const nativeById = new Map(native.map((script) => [script.id, script]));
        const nextById = new Map(records.map((script) => [script.id, script]));
        const nativeUpdates: AgentUserScriptUpdate[] = [];
        for (const update of updates) {
          const stored = nextById.get(update.id);
          const current = stored ?? nativeById.get(update.id);
          if (!current) throw new Error(`Unknown user script: ${update.id}`);
          const base = normalizeDefinition(current);
          const nextDefinition = { ...base, ...update };
          if (nextDefinition.world === "MAIN") delete nextDefinition.worldId;
          const now = this.now().toISOString();
          nextById.set(update.id, {
            ...nextDefinition,
            label: stored?.label ?? update.id,
            enabled: stored?.enabled ?? true,
            createdAt: stored?.createdAt ?? now,
            updatedAt: now,
          });
          if (stored?.enabled !== false) nativeUpdates.push(update);
        }
        if (nativeUpdates.length) await api.update(nativeUpdates.map(nativeUpdate));
        await this.write([...nextById.values()]);
        this.recordEvent("update", "agent", updates);
        return { handled: true, value: undefined };
      }

      const filter = this.readFilter(args[0]);
      await api.unregister(filter);
      const records = await this.load();
      const ids = Array.isArray(filter?.ids) ? filter.ids as string[] : undefined;
      await this.write(ids ? records.filter((script) => !ids.includes(script.id)) : []);
      this.recordEvent("unregister", "agent", filter ?? null);
      return { handled: true, value: undefined };
    }), path, "agent", args);
    return this.abortable(operation, signal);
  }

  private readDefinitionList(value: unknown): UserScriptDefinition[] {
    if (!Array.isArray(value) || value.length === 0) throw new Error("userScripts.register requires a non-empty script array");
    return value.map(normalizeDefinition);
  }

  private readUpdateList(value: unknown): AgentUserScriptUpdate[] {
    if (!Array.isArray(value) || value.length === 0) throw new Error("userScripts.update requires a non-empty script array");
    return value.map(normalizeUpdate);
  }

  private readFilter(value: unknown): chrome.userScripts.UserScriptFilter | undefined {
    if (value === undefined) return undefined;
    if (!isRecord(value) || (value.ids !== undefined && (!Array.isArray(value.ids) || !value.ids.every((id) => typeof id === "string")))) {
      throw new Error("userScripts filter must contain an ids array");
    }
    return value as chrome.userScripts.UserScriptFilter;
  }

  private requireApi(): UserScriptApi {
    if (!this.chromeApi.userScripts) {
      throw new Error("chrome.userScripts is unavailable; enable Allow User Scripts for this extension");
    }
    return this.chromeApi.userScripts;
  }

  private async load(): Promise<StoredUserScript[]> {
    const result = await this.storage.get(USER_SCRIPTS_STORAGE_KEY);
    if (!Array.isArray(result[USER_SCRIPTS_STORAGE_KEY])) return [];
    return result[USER_SCRIPTS_STORAGE_KEY].flatMap((item: unknown) => {
      if (!isRecord(item)) return [];
      try {
        const definition = normalizeDefinition(item);
        return [{
          ...definition,
          label: typeof item.label === "string" && item.label.trim() ? item.label.trim() : definition.id,
          enabled: item.enabled !== false,
          createdAt: typeof item.createdAt === "string" ? item.createdAt : this.now().toISOString(),
          updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : this.now().toISOString(),
        } satisfies StoredUserScript];
      } catch {
        return [];
      }
    });
  }

  private async write(records: StoredUserScript[]): Promise<void> {
    await this.storage.set({ [USER_SCRIPTS_STORAGE_KEY]: records });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation);
    this.pending = result.then(() => undefined, () => undefined);
    return result;
  }

  private withFailureLog<T>(promise: Promise<T>, operation: string, actor: "user" | "agent" | "system", payload: unknown): Promise<T> {
    return promise.catch((error) => {
      this.recordEvent("error", actor, { operation, payload, error });
      throw error;
    });
  }

  private recordEvent(event: string, actor: "user" | "agent" | "system", payload: unknown): void {
    this.logger?.record({
      category: "userscript",
      type: `userscript.${event}`,
      content: { actor, payload },
      ...(event === "error" ? { error: payload } : {}),
    });
  }

  private abortable<T>(promise: PromiseLike<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return Promise.resolve(promise);
    return new Promise((resolve, reject) => {
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        reject(new DOMException("Operation aborted", "AbortError"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      Promise.resolve(promise).then((value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      }, (error) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(error);
      });
      if (signal.aborted) onAbort();
    });
  }
}
