import { useCallback, useEffect, useMemo, useState, type FC } from "react";
import type { EventLogger } from "../logging";
import {
  UserScriptRegistry,
  USER_SCRIPTS_STORAGE_KEY,
  type StoredUserScript,
  type UserScriptDefinition,
  type UserScriptSource,
  type UserScriptWorld,
} from "./registry";

type SourceDraft = { type: "code" | "file"; value: string };

type ScriptDraft = {
  id: string;
  label: string;
  enabled: boolean;
  matches: string;
  excludeMatches: string;
  includeGlobs: string;
  excludeGlobs: string;
  runAt: "document_start" | "document_end" | "document_idle";
  world: UserScriptWorld;
  worldId: string;
  allFrames: boolean;
  sources: SourceDraft[];
};

const DEFAULT_DRAFT: ScriptDraft = {
  id: "",
  label: "",
  enabled: true,
  matches: "*://*/*",
  excludeMatches: "",
  includeGlobs: "",
  excludeGlobs: "",
  runAt: "document_idle",
  world: "USER_SCRIPT",
  worldId: "",
  allFrames: false,
  sources: [{ type: "code", value: "" }],
};

function lines(value: string): string[] | undefined {
  const result = value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  return result.length ? result : undefined;
}

function draftFromScript(script: StoredUserScript): ScriptDraft {
  return {
    id: script.id,
    label: script.label,
    enabled: script.enabled,
    matches: script.matches.join("\n"),
    excludeMatches: script.excludeMatches?.join("\n") ?? "",
    includeGlobs: script.includeGlobs?.join("\n") ?? "",
    excludeGlobs: script.excludeGlobs?.join("\n") ?? "",
    runAt: script.runAt ?? "document_idle",
    world: script.world ?? "USER_SCRIPT",
    worldId: script.worldId ?? "",
    allFrames: script.allFrames ?? false,
    sources: script.js.map((source) => "code" in source
      ? { type: "code", value: source.code }
      : { type: "file", value: source.file }),
  };
}

function definitionFromDraft(draft: ScriptDraft): UserScriptDefinition {
  const sources: UserScriptSource[] = draft.sources.map((source) => source.type === "code"
    ? { code: source.value }
    : { file: source.value });
  return {
    id: draft.id,
    matches: lines(draft.matches) ?? [],
    js: sources,
    ...(lines(draft.excludeMatches) ? { excludeMatches: lines(draft.excludeMatches) } : {}),
    ...(lines(draft.includeGlobs) ? { includeGlobs: lines(draft.includeGlobs) } : {}),
    ...(lines(draft.excludeGlobs) ? { excludeGlobs: lines(draft.excludeGlobs) } : {}),
    runAt: draft.runAt,
    world: draft.world,
    ...(draft.worldId.trim() ? { worldId: draft.worldId.trim() } : {}),
    allFrames: draft.allFrames,
  };
}

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type UserScriptsPanelProps = {
  logger?: EventLogger;
  mode?: "sidepanel" | "options";
};

export const UserScriptsPanel: FC<UserScriptsPanelProps> = ({ logger, mode = "sidepanel" }) => {
  const registry = useMemo(() => new UserScriptRegistry({ logger }), [logger]);
  const [open, setOpen] = useState(mode === "options");
  const [scripts, setScripts] = useState<StoredUserScript[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ScriptDraft>(DEFAULT_DRAFT);
  const [status, setStatus] = useState("");
  const [testResult, setTestResult] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setScripts(await registry.list());
    } catch (error) {
      setStatus(`脚本读取失败：${errorText(error)}`);
    }
  }, [registry]);

  useEffect(() => {
    void refresh();
    const handleStorageChange = (changes: { [key: string]: chrome.storage.StorageChange }, areaName: string) => {
      if (areaName === "local" && changes[USER_SCRIPTS_STORAGE_KEY]) void refresh();
    };
    if (typeof chrome !== "undefined") chrome.storage?.onChanged?.addListener(handleStorageChange);
    return () => {
      if (typeof chrome !== "undefined") chrome.storage?.onChanged?.removeListener(handleStorageChange);
    };
  }, [refresh]);

  const edit = (script: StoredUserScript) => {
    setEditingId(script.id);
    setDraft(draftFromScript(script));
    setTestResult("");
    setStatus("");
    setOpen(true);
  };

  const newScript = () => {
    setEditingId(null);
    setDraft({ ...DEFAULT_DRAFT, id: `script-${Date.now()}` });
    setTestResult("");
    setStatus("");
    setOpen(true);
  };

  const save = async () => {
    setBusy(true);
    setStatus("");
    try {
      const saved = await registry.replace(definitionFromDraft(draft), {
        label: draft.label,
        enabled: draft.enabled,
        actor: "user",
      });
      setScripts(await registry.list());
      setEditingId(saved.id);
      setDraft(draftFromScript(saved));
      setStatus("脚本已保存");
    } catch (error) {
      setStatus(`脚本保存失败：${errorText(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (script: StoredUserScript) => {
    setBusy(true);
    setStatus("");
    try {
      await registry.setEnabled(script.id, !script.enabled);
      await refresh();
      if (editingId === script.id) setDraft((current) => ({ ...current, enabled: !script.enabled }));
    } catch (error) {
      setStatus(`脚本状态更新失败：${errorText(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (script: StoredUserScript) => {
    if (!window.confirm(`确定删除脚本“${script.label}”吗？`)) return;
    setBusy(true);
    setStatus("");
    try {
      await registry.remove(script.id);
      const nextScripts = await registry.list();
      setScripts(nextScripts);
      if (editingId === script.id) {
        setEditingId(null);
        setDraft(DEFAULT_DRAFT);
      }
      setStatus("脚本已删除");
    } catch (error) {
      setStatus(`脚本删除失败：${errorText(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setBusy(true);
    setStatus("");
    setTestResult("");
    try {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (tab?.id === undefined) throw new Error("找不到当前活动标签页");
      const result = await registry.execute(definitionFromDraft(draft), tab.id, "user");
      setTestResult(formatJson(result));
      setStatus("脚本测试完成");
    } catch (error) {
      setStatus(`脚本测试失败：${errorText(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const updateDraft = <K extends keyof ScriptDraft>(key: K, value: ScriptDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  return (
    <section className={`user-scripts ${mode}`} data-testid="user-scripts-section">
      <div className="user-scripts-heading">
        <div>
          <h2>用户脚本</h2>
          <p>通过原生 Chrome User Scripts API 管理页面脚本。</p>
        </div>
        <div className="user-scripts-heading-actions">
          <button type="button" className="secondary-button" data-testid="user-scripts-toggle" onClick={() => setOpen((value) => !value)}>
            {open ? "收起" : "管理"}
          </button>
          <button type="button" className="primary-button" data-testid="user-script-new" onClick={newScript}>
            新建
          </button>
        </div>
      </div>

      {open && (
        <div className="user-scripts-body" data-testid="user-scripts-panel">
          {!registry.isAvailable() && (
            <p className="user-scripts-warning" role="status">
              当前浏览器未开放 chrome.userScripts。请在扩展详情中开启“Allow User Scripts”。
            </p>
          )}
          <div className="user-scripts-list" data-testid="user-scripts-list">
            {scripts.length === 0 ? (
              <p className="user-scripts-empty">还没有已保存的脚本。</p>
            ) : scripts.map((script) => (
              <div className={`user-script-row ${script.enabled ? "enabled" : "disabled"}`} key={script.id}>
                <button type="button" className="user-script-select" onClick={() => edit(script)}>
                  <strong>{script.label}</strong>
                  <span>{script.id}</span>
                </button>
                <label className="user-script-toggle">
                  <input
                    type="checkbox"
                    checked={script.enabled}
                    disabled={busy}
                    data-testid={`user-script-enabled-${script.id}`}
                    onChange={() => void toggle(script)}
                  />
                  <span>{script.enabled ? "启用" : "禁用"}</span>
                </label>
                <button type="button" className="text-button danger" disabled={busy} onClick={() => void remove(script)}>删除</button>
              </div>
            ))}
          </div>

          <div className="user-script-editor" data-testid="user-script-editor">
            <div className="user-script-editor-title">
              <h3>{editingId ? `编辑：${draft.label || draft.id}` : "新建脚本"}</h3>
              {editingId && <span>{draft.enabled ? "启用中" : "已禁用"}</span>}
            </div>
            <div className="user-script-grid">
              <label>ID<input value={draft.id} disabled={Boolean(editingId) || busy} onChange={(event) => updateDraft("id", event.target.value)} /></label>
              <label>名称<input value={draft.label} disabled={busy} onChange={(event) => updateDraft("label", event.target.value)} placeholder="可选" /></label>
            </div>
            <label>匹配规则（每行一个）<textarea value={draft.matches} disabled={busy} onChange={(event) => updateDraft("matches", event.target.value)} rows={2} /></label>
            <div className="user-script-grid">
              <label>排除匹配<textarea value={draft.excludeMatches} disabled={busy} onChange={(event) => updateDraft("excludeMatches", event.target.value)} rows={2} /></label>
              <label>Include globs<textarea value={draft.includeGlobs} disabled={busy} onChange={(event) => updateDraft("includeGlobs", event.target.value)} rows={2} /></label>
              <label>Exclude globs<textarea value={draft.excludeGlobs} disabled={busy} onChange={(event) => updateDraft("excludeGlobs", event.target.value)} rows={2} /></label>
            </div>
            <div className="user-script-grid">
              <label>执行世界<select value={draft.world} disabled={busy} onChange={(event) => setDraft((current) => ({ ...current, world: event.target.value as UserScriptWorld, worldId: event.target.value === "MAIN" ? "" : current.worldId }))}><option value="USER_SCRIPT">USER_SCRIPT</option><option value="MAIN">MAIN</option></select></label>
              <label>运行时机<select value={draft.runAt} disabled={busy} onChange={(event) => updateDraft("runAt", event.target.value as ScriptDraft["runAt"])}><option value="document_start">document_start</option><option value="document_end">document_end</option><option value="document_idle">document_idle</option></select></label>
              <label>World ID<input value={draft.worldId} disabled={busy || draft.world === "MAIN"} onChange={(event) => updateDraft("worldId", event.target.value)} placeholder="可选" /></label>
            </div>
            <label className="user-script-checkbox"><input type="checkbox" checked={draft.allFrames} disabled={busy} onChange={(event) => updateDraft("allFrames", event.target.checked)} />注入所有 frame</label>
            <div className="user-script-sources">
              <div className="user-script-sources-title"><strong>JavaScript source</strong><button type="button" className="text-button" disabled={busy} onClick={() => updateDraft("sources", [...draft.sources, { type: "code", value: "" }])}>添加 source</button></div>
              {draft.sources.map((source, index) => (
                <div className="user-script-source" key={`${index}-${source.type}`}>
                  <select value={source.type} disabled={busy} onChange={(event) => setDraft((current) => ({ ...current, sources: current.sources.map((item, itemIndex) => itemIndex === index ? { ...item, type: event.target.value as SourceDraft["type"] } : item) }))}><option value="code">code</option><option value="file">file</option></select>
                  {source.type === "code" ? <textarea value={source.value} disabled={busy} data-testid="user-script-code" onChange={(event) => setDraft((current) => ({ ...current, sources: current.sources.map((item, itemIndex) => itemIndex === index ? { ...item, value: event.target.value } : item) }))} rows={7} /> : <input value={source.value} disabled={busy} placeholder="extension-relative/path.js" onChange={(event) => setDraft((current) => ({ ...current, sources: current.sources.map((item, itemIndex) => itemIndex === index ? { ...item, value: event.target.value } : item) }))} />}
                  <button type="button" className="text-button danger" disabled={busy || draft.sources.length === 1} onClick={() => updateDraft("sources", draft.sources.filter((_, itemIndex) => itemIndex !== index))}>移除</button>
                </div>
              ))}
            </div>
            <div className="user-script-editor-actions">
              <button type="button" className="secondary-button" disabled={busy} data-testid="user-script-test" onClick={() => void test()}>测试当前脚本</button>
              <button type="button" className="primary-button" disabled={busy} data-testid="user-script-save" onClick={() => void save()}>保存脚本</button>
            </div>
            {testResult && <pre className="user-script-test-result" data-testid="user-script-test-result">{testResult}</pre>}
          </div>
          {status && <p className="user-scripts-status" role="status">{status}</p>}
        </div>
      )}
    </section>
  );
};

export default UserScriptsPanel;
