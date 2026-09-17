import { useEffect, useRef, useState } from "react";
import { LoaderCircleIcon } from "lucide-react";
import { Tabs } from "radix-ui";
import { Button } from "../components/ui/button";
import { CodeEditor } from "./CodeEditor";
import { formatUserScriptCode } from "./format-code";
import { USER_SCRIPTS_DISABLED_KEY, USER_SCRIPTS_ERROR_KEY, USER_SCRIPTS_LEGACY_KEY, USER_SCRIPTS_STORAGE_KEY } from "./persistence";
import "../styles.css";
import "../options/styles.css";
import "./styles.css";

type Script = chrome.userScripts.RegisteredUserScript;
type Field = "id" | "matches" | "code";
const TEMPLATE: Script = { id: "", matches: [], js: [{ code: "" }], world: "USER_SCRIPT" };

async function call(method: string, ...args: unknown[]): Promise<any> {
  const response = await chrome.runtime.sendMessage({ type: "surf-wax:user-scripts", method, args });
  if (!response?.ok) throw new Error(response?.error ?? "用户脚本操作失败");
  return response.result;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseScript(text: string): Script | null {
  try { return JSON.parse(text) as Script; }
  catch { return null; }
}

function editableAsForm(script: Script | null): script is Script & { matches: string[]; js: [{ code: string }] } {
  return !!script && typeof script.id === "string" && Array.isArray(script.matches) && script.matches.every((match) => typeof match === "string") && Array.isArray(script.js)
    && script.js.length === 1 && typeof script.js[0]?.code === "string";
}

export function ScriptsApp() {
  const [scripts, setScripts] = useState<Script[]>([]);
  const [disabledIds, setDisabledIds] = useState<string[]>([]);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [registered, setRegistered] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [draftError, setDraftError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<Field, string>>>({});
  const [message, setMessage] = useState("");
  const [restoreError, setRestoreError] = useState("");
  const [legacy, setLegacy] = useState<unknown>();
  const [selected, setSelected] = useState("");
  const [search, setSearch] = useState("");
  const [view, setView] = useState<"manager" | "editor">(location.hash === "#edit" ? "editor" : "manager");
  const [mode, setMode] = useState<"form" | "json">("form");
  const [draft, setDraft] = useState(JSON.stringify(TEMPLATE, null, 2));
  const savedDraft = useRef(JSON.stringify(TEMPLATE, null, 2));
  const draftRevision = useRef(0);
  const [action, setAction] = useState<"saving" | "deleting" | "refreshing" | "toggling" | "formatting" | null>(null);
  const busy = action !== null;
  const parsed = parseScript(draft);
  const formReady = editableAsForm(parsed);
  const dirty = draft !== savedDraft.current;
  const visibleScripts = scripts.filter((script) => `${script.id} ${Array.isArray(script.matches) ? script.matches.join(" ") : ""}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (draft === savedDraft.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [draft]);

  const refresh = async (reconcile = true) => {
    const stored = await chrome.storage.local.get([USER_SCRIPTS_STORAGE_KEY, USER_SCRIPTS_DISABLED_KEY, USER_SCRIPTS_ERROR_KEY, USER_SCRIPTS_LEGACY_KEY]);
    setRestoreError(String(stored[USER_SCRIPTS_ERROR_KEY] ?? ""));
    setLegacy(stored[USER_SCRIPTS_LEGACY_KEY]);
    const saved = stored[USER_SCRIPTS_STORAGE_KEY];
    const activeScripts: Script[] = Array.isArray(saved) ? saved : [];
    const disabledScripts: Script[] = Array.isArray(stored[USER_SCRIPTS_DISABLED_KEY]) ? stored[USER_SCRIPTS_DISABLED_KEY] : [];
    const inactive = disabledScripts.filter((script) => !activeScripts.some((item) => item.id === script.id));
    setScripts([...activeScripts, ...inactive]);
    setDisabledIds(inactive.map((script) => script.id));
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
      if (area === "local" && (changes[USER_SCRIPTS_STORAGE_KEY] || changes[USER_SCRIPTS_DISABLED_KEY] || changes[USER_SCRIPTS_ERROR_KEY] || changes[USER_SCRIPTS_LEGACY_KEY])) void refresh(false);
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, []);

  const changeView = (next: "manager" | "editor") => {
    if (next === "manager" && dirty) {
      if (!confirm("当前脚本有未保存的修改，确定放弃吗？")) return;
      draftRevision.current += 1;
      setDraft(savedDraft.current);
      setDraftError("");
      setFieldErrors({});
    }
    setView(next);
    history.replaceState(null, "", next === "editor" ? "#edit" : "#manage");
  };

  const choose = (script?: Script, force = false) => {
    if (!force && dirty && !confirm("当前脚本有未保存的修改，确定放弃吗？")) return;
    const revision = ++draftRevision.current;
    const nextDraft = JSON.stringify(script ?? TEMPLATE, null, 2);
    setSelected(script?.id ?? "");
    setDraft(nextDraft);
    savedDraft.current = nextDraft;
    setMode(editableAsForm(script ?? TEMPLATE) ? "form" : "json");
    setDraftError("");
    setFieldErrors({});
    if (!force) setMessage("");
    if (!force) { setView("editor"); history.replaceState(null, "", "#edit"); }
    if (script && editableAsForm(script) && script.js[0].code.trim()) {
      void formatUserScriptCode(script.js[0].code).then((code) => {
        if (draftRevision.current !== revision) return;
        const formatted = JSON.stringify({ ...script, js: [{ ...script.js[0], code }] }, null, 2);
        savedDraft.current = formatted;
        setDraft(formatted);
      }).catch(() => undefined);
    }
  };

  const updateField = (field: Field, value: string) => {
    if (!formReady) return;
    draftRevision.current += 1;
    const next: Script = { ...parsed };
    if (field === "id") next.id = value;
    if (field === "matches") next.matches = value.split("\n");
    if (field === "code") next.js = [{ ...parsed.js[0], code: value }];
    setDraft(JSON.stringify(next, null, 2));
    setFieldErrors((current) => ({ ...current, [field]: undefined }));
    setMessage("");
  };

  const save = async () => {
    setError("");
    setDraftError("");
    setFieldErrors({});
    setMessage("");
    let script = parseScript(draft);
    if (!script || typeof script !== "object" || Array.isArray(script)) {
      setDraftError("脚本定义不是有效的 JSON 对象。");
      document.getElementById("script-definition")?.focus();
      return;
    }
    if (mode === "form" && editableAsForm(script)) {
      const errors: Partial<Record<Field, string>> = {};
      if (!script.id.trim()) errors.id = "请输入脚本 ID。";
      const matches = script.matches.map((match) => match.trim()).filter(Boolean);
      if (!matches.length) errors.matches = "请填写至少一条网站匹配规则。";
      if (!script.js[0].code.trim()) errors.code = "请输入 JavaScript 代码。";
      if (Object.keys(errors).length) {
        setFieldErrors(errors);
        (Object.keys(errors)[0] === "code" ? document.querySelector<HTMLElement>("#script-code .cm-content") : document.getElementById(`script-${Object.keys(errors)[0]}`))?.focus();
        return;
      }
      script = { ...script, id: script.id.trim(), matches };
    }
    if (typeof script.id !== "string" || !script.id || !Array.isArray(script.matches) || !Array.isArray(script.js) || !script.js.length) {
      setDraftError("请填写脚本 ID、matches 和 js。");
      document.getElementById("script-definition")?.focus();
      return;
    }
    if (selected && script.id !== selected) {
      setDraftError("编辑时不能更改脚本 ID；请新建脚本。");
      document.getElementById("script-definition")?.focus();
      return;
    }
    setAction("saving");
    setMessage("正在保存脚本…");
    try {
      let formatWarning = "";
      if (mode === "form" && editableAsForm(script)) {
        try { script = { ...script, js: [{ ...script.js[0], code: await formatUserScriptCode(script.js[0].code) }] }; }
        catch (cause) { formatWarning = errorText(cause).split("\n")[0]; }
      }
      if (selected) await call("replace", script);
      else await call("register", [script]);
      choose(script, true);
      await refresh();
      setMessage(formatWarning ? `脚本已保存，但代码未格式化：${formatWarning}` : "脚本已保存");
    } catch (cause) { setError(errorText(cause)); }
    finally { setAction(null); }
  };

  const remove = async () => {
    if (!selected || !confirm(`确定删除脚本 ${selected} 吗？`)) return;
    setAction("deleting");
    setError("");
    setMessage("正在删除脚本…");
    try {
      await call("delete", { id: selected });
      choose(undefined, true);
      setView("manager");
      history.replaceState(null, "", "#manage");
      await refresh();
      setMessage("脚本已删除");
    } catch (cause) { setError(errorText(cause)); }
    finally { setAction(null); }
  };

  const toggle = async (id: string, enable: boolean) => {
    setAction("toggling");
    setError("");
    setMessage(enable ? "正在启用脚本…" : "正在停用脚本…");
    try {
      await call("setEnabled", { id, enabled: enable });
      await refresh(false);
      setMessage(enable ? "脚本已启用" : "脚本已停用");
    } catch (cause) { setError(errorText(cause)); }
    finally { setAction(null); }
  };

  const formatNow = async () => {
    if (!formReady || !parsed.js[0].code.trim()) return;
    setAction("formatting");
    setFieldErrors({});
    setMessage("正在格式化代码…");
    try {
      updateField("code", await formatUserScriptCode(parsed.js[0].code));
      setMessage("代码已格式化");
    } catch (cause) { setFieldErrors({ code: `格式化失败：${errorText(cause).split("\n")[0]}` }); }
    finally { setAction(null); }
  };

  const refreshManually = async () => {
    setAction("refreshing");
    setMessage("正在刷新状态…");
    try { await refresh(); setMessage("状态已刷新"); }
    catch (cause) { setError(errorText(cause)); }
    finally { setAction(null); }
  };

  return <main className="options-shell scripts-shell" data-testid="user-scripts-panel">
    <a className="skip-link" href="#scripts-content">跳转到脚本</a>
    <header className="options-header"><h1>用户脚本</h1><p>管理自动运行的脚本，并编辑它们的网站范围与代码。</p></header>
    {available === false && <p role="status" className="scripts-notice">在 chrome://extensions 的 Surf Wax 详情页开启 Allow User Scripts，然后点击刷新状态。</p>}
    {restoreError && <p role="alert">恢复失败：{restoreError}</p>}
    {legacy !== undefined && <details><summary>无法迁移的旧数据（已保留）</summary><pre>{JSON.stringify(legacy, null, 2)}</pre></details>}
    {error && available !== false && <p role="alert">{error}</p>}
    <Tabs.Root id="scripts-content" className="scripts-tabs" value={view} onValueChange={(value) => changeView(value as "manager" | "editor")}>
      <Tabs.List className="scripts-tab-list" aria-label="用户脚本页面">
        <Tabs.Trigger value="manager" disabled={busy}>脚本管理</Tabs.Trigger>
        <Tabs.Trigger value="editor" disabled={busy}>脚本编辑</Tabs.Trigger>
      </Tabs.List>
      <Tabs.Content value="manager" className="scripts-tab-content">
      <section className="scripts-sidebar" aria-label="脚本管理">
        <div className="scripts-sidebar-heading"><h2>已保存脚本 <span>{scripts.length}</span></h2><Button type="button" variant="outline" disabled={busy} onClick={() => choose()}>新建脚本</Button></div>
        {scripts.length > 0 && <><label htmlFor="script-search">搜索脚本</label><input id="script-search" type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索 ID 或网站…" /></>}
        <div className="scripts-list" aria-label="已保存脚本">
          {visibleScripts.map((script) => <div className="script-row" key={script.id}>
            <button className="script-item" type="button" aria-pressed={selected === script.id} disabled={busy} onClick={() => choose(script)}>
              <span className="script-item-title">{script.id}</span>
              <span className="script-item-sites">{Array.isArray(script.matches) ? script.matches.join(", ") : "未设置网站"}</span>
              <span className="script-item-status">{disabledIds.includes(script.id) ? "○ 已停用" : registered.includes(script.id) ? "● 已注册" : "○ 待恢复"}</span>
            </button>
            <Button type="button" variant="outline" size="sm" disabled={busy || !available} aria-label={`${disabledIds.includes(script.id) ? "启用" : "停用"} ${script.id}`} onClick={() => void toggle(script.id, disabledIds.includes(script.id))}>{disabledIds.includes(script.id) ? "启用" : "停用"}</Button>
          </div>)}
          {!scripts.length && <p className="scripts-empty">还没有脚本。点击“新建脚本”开始。</p>}
          {scripts.length > 0 && !visibleScripts.length && <p className="scripts-empty">没有匹配的脚本。</p>}
        </div>
        <Button type="button" variant="outline" disabled={busy} onClick={() => void refreshManually()}>{action === "refreshing" && <LoaderCircleIcon className="animate-spin" aria-hidden="true" />}刷新状态</Button>
      </section>
      </Tabs.Content>
      <Tabs.Content value="editor" className="scripts-tab-content">
        <section className="scripts-editor" aria-labelledby="scripts-editor-title">
          <div className="scripts-section-heading"><div><h2 id="scripts-editor-title">{selected || "新建脚本"}</h2><p>{dirty ? "有未保存的修改" : selected ? "已保存" : "填写后保存，脚本将在匹配的网站自动运行"}</p></div>
            <Button type="button" variant="outline" disabled={busy || (mode === "json" && !formReady)} onClick={() => { draftRevision.current += 1; setMode(mode === "form" ? "json" : "form"); setDraftError(""); }}>{mode === "form" ? "JSON 高级编辑" : "返回表单"}</Button>
          </div>
          {mode === "form" && formReady ? <div className="scripts-fields">
            <div className="scripts-field"><label htmlFor="script-id">脚本 ID</label><p>用于识别脚本，保存后不可更改。</p><input id="script-id" name="scriptId" value={parsed.id} disabled={!!selected || busy} aria-invalid={!!fieldErrors.id} aria-describedby={fieldErrors.id ? "script-id-error" : undefined} onChange={(event) => updateField("id", event.target.value)} placeholder="例如：page-helper" />{fieldErrors.id && <p id="script-id-error" className="field-error" role="alert">{fieldErrors.id}</p>}</div>
            <div className="scripts-field"><label htmlFor="script-matches">运行于哪些网站</label><p>每行一条 Chrome 网站匹配规则，例如 https://example.com/*</p><textarea id="script-matches" name="scriptMatches" spellCheck={false} value={parsed.matches.join("\n")} aria-invalid={!!fieldErrors.matches} aria-describedby={fieldErrors.matches ? "script-matches-error" : undefined} onChange={(event) => updateField("matches", event.target.value)} placeholder="https://example.com/*" />{fieldErrors.matches && <p id="script-matches-error" className="field-error" role="alert">{fieldErrors.matches}</p>}</div>
            <div className="scripts-field"><div className="scripts-code-heading"><label id="script-code-label">JavaScript 代码</label><Button type="button" variant="outline" size="sm" disabled={busy || !parsed.js[0].code.trim()} onClick={() => void formatNow()}>{action === "formatting" && <LoaderCircleIcon className="animate-spin" aria-hidden="true" />}格式化代码</Button></div><p>JavaScript 和 CSS_* 字符串语法高亮；保存时自动格式化静态 CSS。</p><CodeEditor value={parsed.js[0].code} onChange={(value) => updateField("code", value)} invalid={!!fieldErrors.code} errorId={fieldErrors.code ? "script-code-error" : undefined} />{fieldErrors.code && <p id="script-code-error" className="field-error" role="alert">{fieldErrors.code}</p>}</div>
          </div> : <div className="scripts-field"><label htmlFor="script-definition">完整脚本定义（JSON）</label><p>{formReady ? "可编辑 world、runAt 等高级字段；返回表单时会保留这些字段。" : "此脚本包含多个代码源、文件源或不完整字段，请在此编辑完整定义。"}</p><textarea id="script-definition" name="scriptDefinition" spellCheck={false} aria-invalid={!!draftError} aria-describedby={draftError ? "script-definition-error" : undefined} value={draft} onChange={(event) => { draftRevision.current += 1; setDraft(event.target.value); setDraftError(""); setMessage(""); }} /></div>}
          {draftError && <p id="script-definition-error" className="field-error" role="alert">{draftError}</p>}
          <div className="scripts-actions"><Button type="button" disabled={busy || !available} onClick={() => void save()}>{action === "saving" && <LoaderCircleIcon className="animate-spin" aria-hidden="true" />}保存</Button><Button type="button" variant="destructive" disabled={busy || !available || !selected} onClick={() => void remove()}>{action === "deleting" && <LoaderCircleIcon className="animate-spin" aria-hidden="true" />}删除</Button></div>
        </section>
      </Tabs.Content>
      {message && <p role="status" className="scripts-message">{message}</p>}
    </Tabs.Root>
  </main>;
}
