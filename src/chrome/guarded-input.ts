import { targetEditor } from "./interaction-guard";

/** Resolve a target into this extension's content-script world without changing the DOM. */
type Debuggee = chrome.debugger.Debuggee & { sessionId?: string };
type Send = (source: Debuggee, method: string, params?: Record<string, unknown>) => Promise<any>;
type World = { id: number; frameId: string };

const sourceKey = (source: Debuggee) => JSON.stringify([source.tabId ?? null, source.targetId ?? null, source.extensionId ?? null, source.sessionId ?? null]);
const PROBE = `function(runId) {
  const guard = globalThis.__surfWaxBlocker;
  return Boolean(this.isConnected && this.ownerDocument === document && guard && guard.runId === runId && typeof guard.insertTarget === 'function');
}`;
const INSERT = `function(runId, text, replace) {
  const guard = globalThis.__surfWaxBlocker;
  if (!guard || guard.runId !== runId || typeof guard.insertTarget !== 'function') return { ok: false, reason: 'guard-unavailable' };
  return guard.insertTarget(this, text, replace);
}`;

export class GuardedInputContexts {
  private readonly worlds = new Map<string, Map<number, World>>();
  private readonly cached = new Map<string, { source: string; world: World }>();
  private readonly pending = new Map<string, Promise<World>>();
  constructor(private readonly extensionOrigin: string, private readonly send: Send) {}

  event(source: Debuggee, method: string, params: any): void {
    const key = sourceKey(source);
    if (method === "Runtime.executionContextCreated") {
      const context = params?.context;
      if (context?.origin !== this.extensionOrigin || context?.auxData?.type !== "isolated"
        || !Number.isSafeInteger(context?.id) || typeof context?.auxData?.frameId !== "string") return;
      const worlds = this.worlds.get(key) ?? new Map<number, World>();
      worlds.set(context.id, { id: context.id, frameId: context.auxData.frameId });
      this.worlds.set(key, worlds);
    } else if (method === "Runtime.executionContextDestroyed") {
      this.worlds.get(key)?.delete(params?.executionContextId);
    } else if (method === "Runtime.executionContextsCleared") {
      this.worlds.delete(key);
    } else if (method === "Target.detachedFromTarget" && typeof params?.sessionId === "string") {
      this.worlds.delete(sourceKey({ ...source, sessionId: params.sessionId }));
    }
  }

  detach(source: Debuggee): void {
    if (source.sessionId) this.worlds.delete(sourceKey(source));
    else {
      const prefix = JSON.stringify([source.tabId ?? null, source.targetId ?? null, source.extensionId ?? null]).slice(0, -1);
      for (const key of this.worlds.keys()) if (key.startsWith(`${prefix},`)) this.worlds.delete(key);
    }
  }

  clear(): void { this.worlds.clear(); this.cached.clear(); this.pending.clear(); }

  private current(source: string, world: World): boolean { return this.worlds.get(source)?.get(world.id) === world; }
  private key(source: Debuggee, backendNodeId: number, runId: string): string { return JSON.stringify([sourceKey(source), backendNodeId, runId]); }

  private async resolve(source: Debuggee, world: World, backendNodeId: number): Promise<string> {
    const result = await this.send(source, "DOM.resolveNode", { backendNodeId, executionContextId: world.id });
    const objectId = result?.object?.objectId;
    if (typeof objectId !== "string" || !objectId) throw new Error("AutomationError[guard-target-unavailable]: Could not resolve the focused node");
    return objectId;
  }

  private async release(source: Debuggee, objectId: string): Promise<void> {
    await this.send(source, "Runtime.releaseObject", { objectId }).catch(() => undefined);
  }

  private async find(source: Debuggee, backendNodeId: number, runId: string): Promise<World> {
    const sourceId = sourceKey(source), cacheKey = this.key(source, backendNodeId, runId);
    const cached = this.cached.get(cacheKey);
    if (cached && this.current(cached.source, cached.world)) {
      this.cached.delete(cacheKey); this.cached.set(cacheKey, cached);
      return cached.world;
    }
    this.cached.delete(cacheKey);
    let flight = this.pending.get(cacheKey);
    if (!flight) {
      flight = (async () => {
        const candidates = [...(this.worlds.get(sourceId)?.values() ?? [])];
        const matches: World[] = [];
        for (const world of candidates) {
          if (!this.current(sourceId, world)) continue;
          let objectId: string | undefined;
          try {
            objectId = await this.resolve(source, world, backendNodeId);
            if (!this.current(sourceId, world)) continue;
            const response = await this.send(source, "Runtime.callFunctionOn", { objectId, functionDeclaration: PROBE,
              arguments: [{ value: runId }], returnByValue: true });
            if (response?.exceptionDetails) throw new Error("AutomationError[guard-context-unavailable]: Could not inspect target world");
            if (response?.result?.value === true && this.current(sourceId, world)) matches.push(world);
          } catch (error) {
            if (this.current(sourceId, world)) throw error;
          } finally { if (objectId) await this.release(source, objectId); }
        }
        if (matches.length !== 1 || !this.current(sourceId, matches[0]!))
          throw new Error(`AutomationError[guard-context-unavailable]: Expected one target world, found ${matches.length}`);
        const world = matches[0]!;
        this.cached.set(cacheKey, { source: sourceId, world });
        if (this.cached.size > 256) this.cached.delete(this.cached.keys().next().value!);
        return world;
      })();
      this.pending.set(cacheKey, flight);
    }
    try { return await flight; }
    finally { if (this.pending.get(cacheKey) === flight) this.pending.delete(cacheKey); }
  }

  async insert(source: Debuggee, backendNodeId: number, runId: string, text: string, validate: () => void, replace = false): Promise<void> {
    if (!Number.isSafeInteger(backendNodeId) || backendNodeId < 1 || !runId) throw new Error("AutomationError[guard-target-unavailable]: Invalid focused node");
    validate();
    const sourceId = sourceKey(source), world = await this.find(source, backendNodeId, runId);
    if (!this.current(sourceId, world)) throw new Error("AutomationError[guard-context-unavailable]: Target world expired");
    const objectId = await this.resolve(source, world, backendNodeId);
    try {
      validate();
      if (!this.current(sourceId, world)) throw new Error("AutomationError[guard-context-unavailable]: Target world expired");
      const response = await this.send(source, "Runtime.callFunctionOn", { objectId, functionDeclaration: INSERT,
        arguments: [{ value: runId }, { value: text }, { value: replace }], returnByValue: true });
      if (response?.exceptionDetails) throw new Error("AutomationError[guard-insert-failed]: Target insertion threw");
      const result = response?.result?.value;
      if (result?.ok !== true) throw new Error(`AutomationError[guard-insert-failed]: ${typeof result?.reason === "string" ? result.reason : "missing-result"}`);
    } finally { await this.release(source, objectId); }
  }

  async insertUnguarded(source: Debuggee, backendNodeId: number, text: string, replace: boolean, validate: () => void): Promise<void> {
    if (!Number.isSafeInteger(backendNodeId) || backendNodeId < 1) throw new Error("AutomationError[guard-target-unavailable]: Invalid focused node");
    validate();
    const response = await this.send(source, "DOM.resolveNode", { backendNodeId });
    const objectId = response?.object?.objectId;
    if (typeof objectId !== "string" || !objectId) throw new Error("AutomationError[guard-target-unavailable]: Could not resolve the focused node");
    try {
      validate();
      const result = await this.send(source, "Runtime.callFunctionOn", { objectId,
        functionDeclaration: `function(text, replace) { return (${targetEditor.toString()})(this, text, replace); }`,
        arguments: [{ value: text }, { value: replace }], returnByValue: true });
      if (result?.exceptionDetails) throw new Error("AutomationError[guard-insert-failed]: Target insertion threw");
      if (result?.result?.value?.ok !== true) throw new Error(`AutomationError[guard-insert-failed]: ${result?.result?.value?.reason ?? "missing-result"}`);
    } finally { await this.release(source, objectId); }
  }
}
