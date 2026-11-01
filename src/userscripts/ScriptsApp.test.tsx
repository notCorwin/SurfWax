import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { USER_SCRIPTS_STORAGE_KEY } from "./persistence";
import { ScriptsApp } from "./ScriptsApp";

vi.mock("./CodeEditor", () => ({ CodeEditor: () => null }));

type ChangeListener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => void;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let listeners: Set<ChangeListener>;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  history.replaceState(null, "", "#manage");
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  listeners = new Set();
});

it("ignores an obsolete registration failure after a successful newer refresh", async () => {
  const old = deferred<chrome.userScripts.RegisteredUserScript[]>();
  const script = { id: "current", matches: ["https://example.com/*"], js: [{ code: "1" }] };
  const getScripts = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue([script]);
  vi.stubGlobal("chrome", {
    storage: { local: { get: vi.fn(async () => ({ [USER_SCRIPTS_STORAGE_KEY]: [script] })) }, onChanged: { addListener: (listener: ChangeListener) => listeners.add(listener), removeListener: (listener: ChangeListener) => listeners.delete(listener) } },
    userScripts: { getScripts }, runtime: { sendMessage: vi.fn(async () => ({ ok: true })) },
  });
  await act(async () => root.render(<ScriptsApp />));
  await act(async () => { for (const listener of listeners) listener({ [USER_SCRIPTS_STORAGE_KEY]: {} }, "local"); });
  expect(host.textContent).toContain("已注册");
  await act(async () => { old.reject(new Error("old request failed")); await old.promise.catch(() => undefined); });
  expect(host.textContent).toContain("已注册");
  expect(host.textContent).not.toContain("用户脚本操作失败");
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

it("does not replace a newer storage refresh with a late older result", async () => {
  const old = deferred<Record<string, unknown>>();
  const script = (id: string) => ({ id, matches: ["https://example.com/*"], js: [{ code: "1" }] });
  const get = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue({ [USER_SCRIPTS_STORAGE_KEY]: [script("new-script")] });
  vi.stubGlobal("chrome", {
    storage: { local: { get }, onChanged: { addListener: (listener: ChangeListener) => listeners.add(listener), removeListener: (listener: ChangeListener) => listeners.delete(listener) } },
    userScripts: { getScripts: vi.fn(async () => []) },
    runtime: { sendMessage: vi.fn(async () => ({ ok: true })) },
  });
  await act(async () => root.render(<ScriptsApp />));
  await act(async () => { for (const listener of listeners) listener({ [USER_SCRIPTS_STORAGE_KEY]: {} }, "local"); });
  expect(host.textContent).toContain("new-script");
  await act(async () => { old.resolve({ [USER_SCRIPTS_STORAGE_KEY]: [script("old-script")] }); await old.promise; });
  expect(host.textContent).toContain("new-script");
  expect(host.textContent).not.toContain("old-script");
});
