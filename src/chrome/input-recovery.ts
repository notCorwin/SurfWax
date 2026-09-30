import { fromLogValue, type LogEvent } from "../logging";

type InputState = {
  tabId?: number; debuggee: chrome.debugger.Debuggee & { sessionId?: string }; x: number; y: number;
  keys: Record<string, unknown>[]; buttons: [string, Record<string, unknown>][];
};
type DebuggerApi = Pick<typeof chrome.debugger, "attach" | "sendCommand" | "detach">;

/** Restore only orphaned runs, after their page guards have been released. */
export async function recoverBrowserInput(events: readonly LogEvent[], orphanRunIds: readonly string[], debuggerApi: DebuggerApi): Promise<{ recovered: number; failures: { tabId: number; error: string }[] }> {
  const orphaned = new Set(orphanRunIds);
  const latest = new Map<string, InputState>();
  for (const event of events) {
    if (event.type !== "browser.input.state" || !event.runId || !orphaned.has(event.runId)) continue;
    const state = fromLogValue(event.content) as InputState;
    if (!state || !Number.isInteger(state.tabId) || !state.debuggee) continue;
    latest.set(JSON.stringify([event.runId, state.tabId, state.debuggee.sessionId]), state);
  }
  const tabs = new Map<number, { x: number; y: number; keys: Map<string, Record<string, unknown>>; buttons: Map<string, Record<string, unknown>> }>();
  for (const state of latest.values()) {
    if (!(state.keys?.length || state.buttons?.length)) continue;
    let tab = tabs.get(state.tabId!);
    if (!tab) { tab = { x: state.x, y: state.y, keys: new Map(), buttons: new Map() }; tabs.set(state.tabId!, tab); }
    tab.x = state.x; tab.y = state.y;
    for (const key of state.keys ?? []) if (typeof key.key === "string") tab.keys.set(key.key, key);
    for (const [button, params] of state.buttons ?? []) tab.buttons.set(button, params);
  }
  let recovered = 0;
  const failures: { tabId: number; error: string }[] = [];
  for (const [tabId, state] of tabs) {
    const debuggee = { tabId };
    try {
      try { await debuggerApi.attach(debuggee, "1.3"); } catch (error) {
        if (!/already attached/i.test(String(error))) throw error;
      }
      for (const params of state.keys.values()) await debuggerApi.sendCommand(debuggee, "Input.dispatchKeyEvent", { ...params, text: undefined, unmodifiedText: undefined, type: "keyUp", modifiers: 0 });
      for (const [button, params] of state.buttons) await debuggerApi.sendCommand(debuggee, "Input.dispatchMouseEvent", { ...params, type: "mouseReleased", x: state.x, y: state.y, button, buttons: 0, modifiers: 0 });
      await debuggerApi.sendCommand(debuggee, "Input.cancelDragging", {});
      recovered += 1;
    } catch (error) { failures.push({ tabId, error: String(error) }); }
    finally { await debuggerApi.detach(debuggee).catch(() => undefined); }
  }
  return { recovered, failures };
}
