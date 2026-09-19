export function requireDebuggee(value: unknown, method: string): asserts value is chrome.debugger.Debuggee {
  const target = value as chrome.debugger.Debuggee | undefined;
  if (target && (
    Number.isInteger(target.tabId) && target.tabId! >= 0
    || typeof target.targetId === "string" && target.targetId.length > 0
    || typeof target.extensionId === "string" && target.extensionId.length > 0
  )) return;
  throw new TypeError(`chrome.debugger.${method} requires { tabId: number }, { targetId: string }, or { extensionId: string }; verify the queried tab or target exists.`);
}
