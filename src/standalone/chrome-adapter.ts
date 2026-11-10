import type { ExecutorChrome } from "../chrome/executor";
import { CdpConnection } from "./cdp";

type Source = { tabId?: number; targetId?: string; sessionId?: string };
function event() {
  const listeners = new Set<(...args: any[]) => void>();
  return { addListener: (fn: (...args: any[]) => void) => { listeners.add(fn); }, removeListener: (fn: (...args: any[]) => void) => { listeners.delete(fn); },
    emit: (...args: any[]) => { for (const fn of listeners) fn(...args); } };
}
export const OBSERVATION_WORLD = "surf-wax-standalone-observation";

/** Translate the Chrome API surface used by the executor into real CDP operations. */
export async function createChromeAdapter(cdp: CdpConnection) {
  let nextId = 0, activeId: number | undefined;
  const ids = new Map<string, number>();
  const targets = new Map<number, any>();
  const sessions = new Map<number, Promise<string>>();
  const roots = new Map<string, number>();
  const children = new Map<string, number>();
  const onEvent = event(), onDetach = event(), onCreated = event(), onRemoved = event();
  const remember = (info: any) => {
    if (info.type !== "page") return undefined;
    let id = ids.get(info.targetId);
    if (id === undefined) { id = ++nextId; ids.set(info.targetId, id); }
    const tab = { id, windowId: 1, index: id - 1, active: id === activeId, title: info.title, url: info.url, targetId: info.targetId, ...(info.openerId && ids.has(info.openerId) ? { openerTabId: ids.get(info.openerId) } : {}) };
    targets.set(id, tab);
    return tab;
  };
  const get = async (id: number) => {
    const tab = targets.get(id);
    if (!tab) throw new Error(`CommandError[invalid-tab-id]: ${id}; call list_tabs for live tab IDs.`);
    return { ...tab, active: id === activeId };
  };
  const attach = async (source: Source) => {
    const tabId = source.tabId ?? ids.get(source.targetId!);
    if (tabId === undefined) throw new Error("A live page tab is required for CDP attachment.");
    let pending = sessions.get(tabId);
    if (!pending) {
      pending = (async () => {
        const tab = await get(tabId);
        const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: tab.targetId, flatten: true });
        roots.set(sessionId, tabId);
        return sessionId as string;
      })();
      sessions.set(tabId, pending);
      void pending.catch(() => { if (sessions.get(tabId) === pending) sessions.delete(tabId); });
    }
    return pending;
  };
  const command = async (source: Source, method: string, params?: object) => cdp.send(method, params, source.sessionId ?? await attach(source));
  cdp.listeners.add(({ method, params, sessionId }) => {
    if (method === "Target.targetCreated") { const tab = remember(params.targetInfo); if (tab) onCreated.emit(tab); }
    if (method === "Target.targetInfoChanged") remember(params.targetInfo);
    if (method === "Target.targetDestroyed") {
      const id = ids.get(params.targetId);
      if (id !== undefined) { targets.delete(id); sessions.delete(id); onRemoved.emit(id, { windowId: 1, isWindowClosing: false }); }
    }
    if (method === "Target.attachedToTarget" && sessionId) {
      const tabId = roots.get(sessionId) ?? children.get(sessionId);
      if (tabId !== undefined) children.set(params.sessionId, tabId);
    }
    if (method === "Target.detachedFromTarget") {
      const id = roots.get(params.sessionId);
      if (id !== undefined) { roots.delete(params.sessionId); sessions.delete(id); onDetach.emit({ tabId: id }, "target_closed"); }
      children.delete(params.sessionId);
    }
    const tabId = roots.get(sessionId) ?? children.get(sessionId);
    if (tabId !== undefined) onEvent.emit({ tabId, ...(roots.has(sessionId) ? {} : { sessionId }) }, method, params);
  });
  await cdp.send("Target.setDiscoverTargets", { discover: true });
  const { targetInfos } = await cdp.send("Target.getTargets");
  for (const info of targetInfos) remember(info);
  activeId = targets.keys().next().value;
  const query = async (filter: { active?: boolean } = {}) => [...targets.values()].filter(tab => !filter.active || tab.id === activeId).map(tab => ({ ...tab, active: tab.id === activeId }));
  const window = async () => ({ id: 1, tabs: await query() });
  const unsupported = async () => { throw new Error("CommandError[extension-required]: This capability requires Chrome extension APIs; test it with the extension harness."); };
  const api = {
    debugger: {
      onEvent, onDetach,
      getTargets: async () => [...targets.values()].map(tab => ({ id: tab.targetId, tabId: tab.id, type: "page", title: tab.title, url: tab.url, attached: sessions.has(tab.id) })),
      attach: async (source: Source) => { await attach(source); },
      detach: async (source: Source) => {
        const id = source.tabId ?? ids.get(source.targetId!);
        const pending = id === undefined ? undefined : sessions.get(id);
        if (pending) { const sessionId = await pending; roots.delete(sessionId); sessions.delete(id!); await cdp.send("Target.detachFromTarget", { sessionId }); }
      },
      sendCommand: command,
    },
    tabs: {
      get, query, onCreated, onRemoved,
      create: async ({ url = "about:blank" }: { url?: string }) => {
        const { targetId } = await cdp.send("Target.createTarget", { url });
        const tab = remember({ targetId, type: "page", title: "", url })!;
        activeId = tab.id; return get(tab.id);
      },
      update: async (id: number) => { const tab = await get(id); await cdp.send("Target.activateTarget", { targetId: tab.targetId }); activeId = id; return get(id); },
      remove: async (id: number) => { const tab = await get(id); await cdp.send("Target.closeTarget", { targetId: tab.targetId }); },
    },
    windows: { getCurrent: window, get: async (id: number) => { if (id !== 1) throw new Error("Standalone window not found."); return window(); } },
    scripting: { executeScript: async ({ target, func, args = [] }: { target: { tabId: number }; func: Function; args?: unknown[] }) => {
      const source = { tabId: target.tabId };
      const { frameTree } = await command(source, "Page.getFrameTree");
      const { executionContextId } = await command(source, "Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: OBSERVATION_WORLD });
      const result = await command(source, "Runtime.callFunctionOn", { executionContextId, functionDeclaration: func.toString(), arguments: args.map(value => ({ value })), returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
      return [{ frameId: 0, result: result.result.value }];
    } },
    downloads: { search: unsupported, download: unsupported, onCreated: event(), onChanged: event(), onErased: event() },
  };
  return api as unknown as ExecutorChrome;
}
