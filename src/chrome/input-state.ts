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

/** A physical code distinguishes e.g. left and right Shift, which share a key. */
export function inputKeyIdentity(params: Record<string, any>): string | undefined {
  if (typeof params.code === "string" && params.code) return `code:${params.code}`;
  if (typeof params.key === "string" && params.key) return `key:${params.key}`;
  if (Number.isInteger(params.windowsVirtualKeyCode) && params.windowsVirtualKeyCode > 0) return `windows:${params.windowsVirtualKeyCode}`;
  if (Number.isInteger(params.nativeVirtualKeyCode) && params.nativeVirtualKeyCode > 0) return `native:${params.nativeVirtualKeyCode}`;
  return undefined;
}

export function inputSemanticKey(params: Record<string, any>): string | undefined {
  if (typeof params.key === "string" && params.key && params.key !== "Unidentified") return params.key;
  return typeof params.code === "string" ? /^(Alt|Control|Meta|Shift)(?:Left|Right)$/.exec(params.code)?.[1] : undefined;
}

/** A release may omit a code supplied on keydown; use a fallback only if unique. */
export function heldKeyIdentity(keys: Map<string, Record<string, any>>, params: Record<string, any>): string | undefined {
  const identity = inputKeyIdentity(params);
  if (identity && keys.has(identity)) return identity;
  const field = typeof params.code === "string" && params.code ? "code"
    : typeof params.key === "string" && params.key ? "key"
    : Number.isInteger(params.windowsVirtualKeyCode) && params.windowsVirtualKeyCode > 0 ? "windowsVirtualKeyCode"
    : Number.isInteger(params.nativeVirtualKeyCode) && params.nativeVirtualKeyCode > 0 ? "nativeVirtualKeyCode" : undefined;
  if (!field) return undefined;
  const matches = [...keys].filter(([, held]) => held[field] === params[field]);
  if (matches.length === 1) return matches[0]![0];
  // A raw keydown can omit code while a later keyup supplies it. Only match
  // such a keydown by a lower-priority field; an explicitly different code
  // must never release another physical key with the same semantic name.
  if (field === "code" && matches.length === 0) {
    const fallback = typeof params.key === "string" && params.key ? "key"
      : Number.isInteger(params.windowsVirtualKeyCode) && params.windowsVirtualKeyCode > 0 ? "windowsVirtualKeyCode"
      : Number.isInteger(params.nativeVirtualKeyCode) && params.nativeVirtualKeyCode > 0 ? "nativeVirtualKeyCode" : undefined;
    if (!fallback) return undefined;
    const candidates = [...keys].filter(([, held]) => !(typeof held.code === "string" && held.code) && held[fallback] === params[fallback]);
    if (candidates.length === 1) return candidates[0]![0];
  }
  return undefined;
}

export function updateHeldInputState(state: HeldInputState, command: string, params: Record<string, any>, deferRelease = false, rawCdp = false): void {
  if (Number.isFinite(params.x)) state.x = params.x;
  if (Number.isFinite(params.y)) state.y = params.y;
  if (command === "Input.dispatchKeyEvent") {
    const key = params.type === "keyUp" ? heldKeyIdentity(state.keys, params) : inputKeyIdentity(params);
    if (key && params.type === "keyUp" && !deferRelease) state.keys.delete(key);
    else if (key && (params.type === "keyDown" || params.type === "rawKeyDown")) state.keys.set(key, { ...params });
  }
  if (command === "Input.dispatchMouseEvent") {
    const button = params.button ?? (rawCdp ? "none" : "left");
    if (params.type === "mousePressed" && button !== "none") state.buttons.set(button, { ...params });
    else if (params.type === "mouseReleased" && !deferRelease && button !== "none") state.buttons.delete(button);
  }
}

export function shouldPersistInputState(state: Pick<HeldInputState, "buttons">, type: unknown): boolean {
  return state.buttons.size > 0 || type === "mousePressed" || type === "mouseReleased";
}
