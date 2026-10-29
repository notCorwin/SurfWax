export type HeldInputState = {
  debuggee: chrome.debugger.Debuggee;
  tabId?: number;
  runId?: string;
  x: number;
  y: number;
  keys: Map<string, Record<string, any>>;
  buttons: Map<string, Record<string, any>>;
};

export function debuggeeKey(debuggee: chrome.debugger.Debuggee): string {
  return debuggee.targetId ? `target:${debuggee.targetId}`
    : debuggee.tabId !== undefined ? `tab:${debuggee.tabId}` : `extension:${debuggee.extensionId}`;
}

export function createHeldInputState(debuggee: chrome.debugger.Debuggee, tabId?: number, runId?: string): HeldInputState {
  return { debuggee, tabId, runId, x: 0, y: 0, keys: new Map(), buttons: new Map() };
}

export function updateHeldInputState(state: HeldInputState, command: string, params: Record<string, any>, deferRelease = false): void {
  if (Number.isFinite(params.x)) state.x = params.x;
  if (Number.isFinite(params.y)) state.y = params.y;
  if (command === "Input.dispatchKeyEvent") {
    if (typeof params.key === "string" && params.key) {
      if (params.type === "keyUp" && !deferRelease) state.keys.delete(params.key);
      else if (params.type === "keyDown" || params.type === "rawKeyDown") state.keys.set(params.key, { ...params });
    }
  }
  if (command === "Input.dispatchMouseEvent") {
    if (params.type === "mousePressed") state.buttons.set(params.button ?? "left", { ...params });
    else if (params.type === "mouseReleased" && !deferRelease) state.buttons.delete(params.button ?? "left");
  }
}

export function shouldPersistInputState(state: Pick<HeldInputState, "buttons">, type: unknown): boolean {
  return state.buttons.size > 0 || type === "mousePressed" || type === "mouseReleased";
}
