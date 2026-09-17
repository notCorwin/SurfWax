import { useEffect, useState } from "react";
import { Button } from "../components/ui/button";
import { USER_SCRIPTS_ERROR_KEY, USER_SCRIPTS_LEGACY_KEY, USER_SCRIPTS_STORAGE_KEY } from "./persistence";
import "../styles.css";
import "../options/styles.css";
import "./styles.css";

type Script = chrome.userScripts.RegisteredUserScript;
const TEMPLATE: Script = { id: "", matches: ["<all_urls>"], js: [{ code: "" }], world: "USER_SCRIPT" };

async function call(method: string, ...args: unknown[]): Promise<any> {
  const response = await chrome.runtime.sendMessage({ type: "surf-wax:user-scripts", method, args });
  if (!response?.ok) throw new Error(response?.error ?? "用户脚本操作失败");
  return response.result;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function ScriptsApp() {
  const [scripts, setScripts] = useState<Script[]>([]);
  const [available, setAvailable] = useState(false);
  const [registered, setRegistered] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [restoreError, setRestoreError] = useState("");
  const [legacy, setLegacy] = useState<unknown>();
  const [selected, setSelected] = useState("");
  const [draft, setDraft] = useState(JSON.stringify(TEMPLATE, null, 2));
  const [tabs, setTabs] = useState<chrome.tabs.Tab[]>([]);
  const [target, setTarget] = useState("");
  const [result, setResult] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = async (reconcile = true) => {
    const stored = await chrome.storage.local.get([USER_SCRIPTS_STORAGE_KEY, USER_SCRIPTS_ERROR_KEY, USER_SCRIPTS_LEGACY_KEY]);
    setRestoreError(String(stored[USER_SCRIPTS_ERROR_KEY] ?? ""));
    setLegacy(stored[USER_SCRIPTS_LEGACY_KEY]);
    const saved = stored[USER_SCRIPTS_STORAGE_KEY];
    setScripts(Array.isArray(saved) ? saved : []);
    setTabs((await chrome.tabs.query({})).filter((tab) => tab.id && /^https?:|^file:/.test(tab.url ?? "")));
    try {
      if (!chrome.userScripts) throw new Error("Allow User Scripts 尚未开启");
      await chrome.userScripts.getScripts();
      setAvailable(true);
    } catch (cause) {
      setAvailable(false);
      setRegistered([]);
      setError(errorText(cause));
      return;
    }
    try {
      if (reconcile) await call("restore");
      setRegistered((await chrome.userScripts.getScripts()).map((script) => script.id));
      setError("");
    } catch (cause) { setError(errorText(cause)); }
  };

  useEffect(() => {
    void refresh();
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === "local" && (changes[USER_SCRIPTS_STORAGE_KEY] || changes[USER_SCRIPTS_ERROR_KEY] || changes[USER_SCRIPTS_LEGACY_KEY])) void refresh(false);
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, []);

  const choose = (script?: Script) => {
    setSelected(script?.id ?? "");
    setDraft(JSON.stringify(script ?? TEMPLATE, null, 2));
    setResult("");
  };

  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const script = JSON.parse(draft) as Script;
      if (!script || typeof script.id !== "string" || !script.id || !Array.isArray(script.matches) || !Array.isArray(script.js)) {
        throw new Error("请填写脚本 ID、matches 和 js。");
      }
      if (selected && script.id !== selected) throw new Error("编辑时不能更改脚本 ID；请新建脚本。");
      if (selected) await call("replace", script);
      else await call("register", [script]);
      choose(script);
      await refresh();
    } catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  };

  const remove = async () => {
    if (!selected || !confirm(`确定删除脚本 ${selected} 吗？`)) return;
    setBusy(true);
    try {
      await call("unregister", { ids: [selected] });
      choose();
      await refresh();
    } catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  };

  const run = async () => {
    setBusy(true);
    setError("");
    try {
      const script = JSON.parse(draft) as Script;
      if (!Number.isInteger(Number(target))) throw new Error("请选择目标网页。");
      const output = await call("execute", {
        target: { tabId: Number(target) }, js: script.js, world: script.world ?? "USER_SCRIPT", ...(script.worldId ? { worldId: script.worldId } : {}),
      });
      setResult(JSON.stringify(output, null, 2));
    } catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  };

  return <main className="options-shell scripts-shell" data-testid="user-scripts-panel">
    <header className="options-header"><h1>用户脚本</h1><p>管理此扩展注册的 Chrome User Scripts。</p></header>
    {!available && <p role="status">在 chrome://extensions 的 Surf Wax 详情页开启 Allow User Scripts，然后点击刷新。</p>}
    {restoreError && <p role="alert">恢复失败：{restoreError}</p>}
    {legacy !== undefined && <details><summary>无法迁移的旧数据（已保留）</summary><pre>{JSON.stringify(legacy, null, 2)}</pre></details>}
    {error && <p role="alert">{error}</p>}
    <div className="scripts-actions"><Button type="button" onClick={() => void refresh()}>刷新状态</Button><Button type="button" variant="outline" onClick={() => choose()}>新建脚本</Button></div>
    <div className="scripts-list" aria-label="已保存脚本">
      {scripts.map((script) => <Button type="button" variant={selected === script.id ? "default" : "outline"} key={script.id} onClick={() => choose(script)}>{script.id} · {registered.includes(script.id) ? "已注册" : "待恢复"}</Button>)}
      {!scripts.length && <p>尚无脚本</p>}
    </div>
    <label htmlFor="script-definition">脚本定义（Chrome RegisteredUserScript JSON）</label>
    <textarea id="script-definition" spellCheck={false} value={draft} onChange={(event) => setDraft(event.target.value)} />
    <div className="scripts-actions"><Button type="button" disabled={busy || !available} onClick={() => void save()}>保存</Button><Button type="button" variant="destructive" disabled={busy || !available || !selected} onClick={() => void remove()}>删除</Button></div>
    <label htmlFor="script-target">立即运行于</label>
    <select id="script-target" value={target} onChange={(event) => setTarget(event.target.value)}>
      <option value="">选择网页标签页</option>
      {tabs.map((tab) => <option key={tab.id} value={tab.id}>{tab.title || tab.url} — {tab.url}</option>)}
    </select>
    <Button type="button" disabled={busy || !available || !target} onClick={() => void run()}>运行脚本</Button>
    {result && <pre aria-label="运行结果">{result}</pre>}
  </main>;
}
