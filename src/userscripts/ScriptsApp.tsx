import { useEffect, useRef, useState } from "react";
import { ArrowLeftIcon, CodeXmlIcon, DownloadIcon, LoaderCircleIcon, PlusIcon, UploadIcon } from "lucide-react";
import { Alert, AlertDescription } from "../components/ui/alert";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../components/ui/alert-dialog";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Checkbox } from "../components/ui/checkbox";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../components/ui/empty";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "../components/ui/field";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { CodeEditor } from "./CodeEditor";
import { formatUserScriptCode } from "./format-code";
import { USER_SCRIPTS_DISABLED_KEY, USER_SCRIPTS_ERROR_KEY, USER_SCRIPTS_LEGACY_KEY, USER_SCRIPTS_STORAGE_KEY } from "./persistence";
import "../styles.css";
import "../options/styles.css";
import "./styles.css";

type Script = chrome.userScripts.RegisteredUserScript;
type Field = "id" | "matches" | "code";
const TEMPLATE: Script = { id: "", matches: [], js: [{ code: "" }], world: "USER_SCRIPT" };
const SCRIPT_FIELDS = new Set(["allFrames", "excludeGlobs", "excludeMatches", "id", "includeGlobs", "js", "matches", "runAt", "world", "worldId"]);

function isScript(value: unknown): value is Script {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const script = value as Partial<Script>;
  return Object.keys(script).every((key) => SCRIPT_FIELDS.has(key))
    && typeof script.id === "string" && !!script.id && !script.id.startsWith("_")
    && Array.isArray(script.matches) && script.matches.length > 0 && script.matches.every((match) => typeof match === "string")
    && Array.isArray(script.js) && script.js.length > 0 && script.js.every((source) => source && typeof source === "object"
      && Object.keys(source).every((key) => key === "code" || key === "file")
      && (typeof source.code === "string") !== (typeof source.file === "string"));
}

function parseImport(text: string): Script[] {
  const value: unknown = JSON.parse(text);
  if (!Array.isArray(value) || !value.every(isScript)) throw new Error("文件必须是 Chrome RegisteredUserScript 对象数组；请检查原生字段、id、matches 和 js。");
  const ids = value.map((script) => script.id);
  if (new Set(ids).size !== ids.length) throw new Error("文件中存在重复的脚本 ID。");
  return value;
}

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
  const [checkedIds, setCheckedIds] = useState<string[]>([]);
  const [importScripts, setImportScripts] = useState<Script[] | null>(null);
  const [overwriteIds, setOverwriteIds] = useState<string[]>([]);
  const [deleteIds, setDeleteIds] = useState<string[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<"form" | "json">("form");
  const [draft, setDraft] = useState(JSON.stringify(TEMPLATE, null, 2));
  const savedDraft = useRef(JSON.stringify(TEMPLATE, null, 2));
  const draftRevision = useRef(0);
  const [action, setAction] = useState<"saving" | "deleting" | "refreshing" | "toggling" | "formatting" | "importing" | null>(null);
  const busy = action !== null;
  const parsed = parseScript(draft);
  const formReady = editableAsForm(parsed);
  const dirty = draft !== savedDraft.current;
  const visibleScripts = scripts.filter((script) => `${script.id} ${Array.isArray(script.matches) ? script.matches.join(" ") : ""}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const visibleIds = visibleScripts.map((script) => script.id);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (draft === savedDraft.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [draft]);

  useEffect(() => {
    const onPopState = () => {
      const next = location.hash === "#edit" ? "editor" : "manager";
      if (next === "manager" && view === "editor" && dirty) {
        if (!confirm("当前脚本有未保存的修改，确定放弃吗？")) {
          history.pushState(null, "", "#edit");
          return;
        }
        draftRevision.current += 1;
        setDraft(savedDraft.current);
        setDraftError("");
        setFieldErrors({});
      }
      setView(next);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [dirty, view]);

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
    history.pushState(null, "", next === "editor" ? "#edit" : "#manage");
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
    if (!force) { setView("editor"); history.pushState(null, "", "#edit"); }
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
    if (!isScript(script)) {
      setDraftError("请填写脚本 ID、matches 和 js，并仅使用 Chrome 原生字段。");
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

  const remove = async (ids: string[]) => {
    if (!ids.length) return;
    setAction("deleting");
    setError("");
    setMessage(`正在删除 ${ids.length} 个脚本…`);
    try {
      const failed: string[] = [];
      for (const id of ids) {
        try { await call("delete", { id }); }
        catch (cause) { failed.push(`${id}：${errorText(cause)}`); }
      }
      if (ids.includes(selected) && !failed.some((item) => item.startsWith(`${selected}：`))) {
        choose(undefined, true);
        setView("manager");
        history.replaceState(null, "", "#manage");
      }
      setDeleteIds([]);
      await refresh();
      setCheckedIds((current) => current.filter((id) => !ids.includes(id) || failed.some((item) => item.startsWith(`${id}：`))));
      setMessage(failed.length ? `已删除 ${ids.length - failed.length} 个；${failed.length} 个失败。` : `已删除 ${ids.length} 个脚本`);
      if (failed.length) setError(failed.join("\n"));
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

  const copyScript = () => {
    if (!parsed || !selected) return;
    const source = scripts.find((script) => script.id === selected);
    if (!source) return;
    let id = `${source.id}-copy`;
    for (let number = 2; scripts.some((script) => script.id === id); number++) id = `${source.id}-copy-${number}`;
    draftRevision.current += 1;
    const next = JSON.stringify({ ...source, id }, null, 2);
    setSelected("");
    setDraft(next);
    savedDraft.current = JSON.stringify(TEMPLATE, null, 2);
    setMode(editableAsForm(source) ? "form" : "json");
    setMessage("副本尚未保存，请检查脚本 ID 后保存。");
  };

  const toggleMany = async (ids: string[], enable: boolean) => {
    if (!ids.length) return;
    setAction("toggling");
    setError("");
    try {
      const failed: string[] = [];
      for (const id of ids) {
        if (disabledIds.includes(id) === !enable) continue;
        try { await call("setEnabled", { id, enabled: enable }); }
        catch (cause) { failed.push(`${id}：${errorText(cause)}`); }
      }
      await refresh(false);
      setMessage(failed.length ? `操作完成，${failed.length} 个脚本失败。` : `已${enable ? "启用" : "停用"}所选脚本`);
      if (failed.length) setError(failed.join("\n"));
    } catch (cause) { setError(errorText(cause)); }
    finally { setAction(null); }
  };

  const exportScripts = (ids?: string[]) => {
    const exported = ids ? scripts.filter((script) => ids.includes(script.id)) : scripts;
    if (!exported.length) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(exported, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "surf-wax-user-scripts.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    setMessage(`已导出 ${exported.length} 个原生 Chrome 用户脚本（不含启停状态）。`);
  };

  const loadImport = async (file?: File) => {
    if (!file) return;
    setError("");
    setImportScripts(null);
    setOverwriteIds([]);
    try { setImportScripts(parseImport(await file.text())); }
    catch (cause) { setError(`无法读取导入文件：${errorText(cause)}`); }
    if (fileInput.current) fileInput.current.value = "";
  };

  const applyImport = async () => {
    if (!importScripts) return;
    setAction("importing");
    setError("");
    try {
      const failed: string[] = [];
      let imported = 0;
      for (const script of importScripts) {
        const existing = scripts.some((item) => item.id === script.id);
        if (existing && !overwriteIds.includes(script.id)) continue;
        try {
          await call(existing ? "replace" : "register", existing ? script : [script]);
          imported++;
        } catch (cause) { failed.push(`${script.id}：${errorText(cause)}`); }
      }
      await refresh(false);
      setImportScripts(null);
      setOverwriteIds([]);
      setMessage(`已导入 ${imported} 个脚本${failed.length ? `，${failed.length} 个失败` : ""}。`);
      if (failed.length) setError(failed.join("\n"));
    } catch (cause) { setError(errorText(cause)); }
    finally { setAction(null); }
  };

  return <main className="options-shell scripts-shell" data-testid="user-scripts-panel">
    <a className="skip-link" href="#scripts-content">跳转到脚本</a>
    <header className="options-header"><h1>用户脚本</h1><p>使用 Chrome 原生 User Scripts 管理自动运行的代码。</p></header>
    {available === false && <Alert role="status"><AlertDescription>在 chrome://extensions 的 Surf Wax 详情页开启 Allow User Scripts，然后刷新状态。</AlertDescription></Alert>}
    {restoreError && <Alert variant="destructive"><AlertDescription>恢复失败：{restoreError}</AlertDescription></Alert>}
    {legacy !== undefined && <details><summary>无法迁移的旧数据（已保留）</summary><pre>{JSON.stringify(legacy, null, 2)}</pre></details>}
    {error && available !== false && <Alert variant="destructive"><AlertDescription className="whitespace-pre-line">{error}</AlertDescription></Alert>}
    {message && <p role="status" className="scripts-message">{message}</p>}
    <div id="scripts-content">
      {view === "manager" ? <Card>
        <CardHeader><CardTitle><h2>已保存脚本 <span className="text-muted-foreground tabular-nums">{scripts.length}</span></h2></CardTitle><CardDescription>搜索、选择和管理已注册或已停用的脚本。</CardDescription></CardHeader>
        <CardContent className="flex flex-col gap-5">
          <div className="scripts-toolbar">
            {scripts.length > 0 && <Button type="button" disabled={busy} onClick={() => choose()}><PlusIcon data-icon="inline-start" />新建脚本</Button>}
            <Button type="button" variant="outline" disabled={busy} onClick={() => fileInput.current?.click()}><UploadIcon data-icon="inline-start" />导入 JSON</Button>
            <Button type="button" variant="outline" disabled={busy || !scripts.length} onClick={() => exportScripts()}><DownloadIcon data-icon="inline-start" />导出全部</Button>
            <input ref={fileInput} className="sr-only" type="file" accept=".json,application/json" aria-label="选择 Chrome 用户脚本 JSON 文件" onChange={(event) => void loadImport(event.target.files?.[0])} />
          </div>
          {scripts.length > 0 && <Field><FieldLabel htmlFor="script-search">搜索脚本</FieldLabel><Input id="script-search" type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索 ID 或网站…" /></Field>}
          {visibleScripts.length > 0 && <div className="scripts-selection">
            <label className="scripts-check-label"><Checkbox checked={visibleIds.every((id) => checkedIds.includes(id))} onCheckedChange={(checked) => setCheckedIds((current) => checked ? [...new Set([...current, ...visibleIds])] : current.filter((id) => !visibleIds.includes(id)))} aria-label="选择当前搜索结果" />选择当前结果</label>
            <span className="text-muted-foreground text-sm tabular-nums">已选 {checkedIds.length} 个</span>
          </div>}
          {checkedIds.length > 0 && <div className="scripts-toolbar" aria-label="批量操作">
            <Button type="button" variant="outline" size="sm" disabled={busy || !available} onClick={() => void toggleMany(checkedIds, true)}>批量启用</Button>
            <Button type="button" variant="outline" size="sm" disabled={busy || !available} onClick={() => void toggleMany(checkedIds, false)}>批量停用</Button>
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => exportScripts(checkedIds)}>导出所选</Button>
            <Button type="button" variant="destructive" size="sm" disabled={busy || !available} onClick={() => setDeleteIds(checkedIds)}>批量删除</Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setCheckedIds([])}>清除选择</Button>
          </div>}
          <div className="scripts-list" aria-label="已保存脚本">
            {visibleScripts.map((script) => <div className="script-row" key={script.id}>
              <Checkbox checked={checkedIds.includes(script.id)} onCheckedChange={(checked) => setCheckedIds((current) => checked ? [...current, script.id] : current.filter((id) => id !== script.id))} aria-label={`选择 ${script.id}`} />
              <button className="script-item" type="button" disabled={busy} onClick={() => choose(script)}>
                <span className="script-item-title">{script.id}</span>
                <span className="script-item-sites">{script.matches?.join(", ") ?? "未设置网站"}</span>
                <Badge variant={disabledIds.includes(script.id) ? "secondary" : registered.includes(script.id) ? "default" : "outline"}>{disabledIds.includes(script.id) ? "已停用" : registered.includes(script.id) ? "已注册" : "待恢复"}</Badge>
              </button>
              <Button type="button" variant="outline" size="sm" disabled={busy || !available} aria-label={`${disabledIds.includes(script.id) ? "启用" : "停用"} ${script.id}`} onClick={() => void toggle(script.id, disabledIds.includes(script.id))}>{disabledIds.includes(script.id) ? "启用" : "停用"}</Button>
            </div>)}
            {!scripts.length && <Empty><EmptyHeader><EmptyMedia variant="icon"><CodeXmlIcon aria-hidden="true" /></EmptyMedia><EmptyTitle>还没有脚本</EmptyTitle><EmptyDescription>新建脚本，或导入 Chrome 原生脚本 JSON。</EmptyDescription></EmptyHeader><EmptyContent><Button type="button" onClick={() => choose()}>新建脚本</Button></EmptyContent></Empty>}
            {scripts.length > 0 && !visibleScripts.length && <Empty><EmptyHeader><EmptyTitle>没有匹配的脚本</EmptyTitle><EmptyDescription>试试其他 ID 或网站关键词。</EmptyDescription></EmptyHeader></Empty>}
          </div>
          <Button type="button" variant="ghost" className="self-start" disabled={busy} onClick={() => void refreshManually()}>{action === "refreshing" && <LoaderCircleIcon data-icon="inline-start" className="animate-spin" aria-hidden="true" />}刷新状态</Button>
        </CardContent>
      </Card> : <Card>
          <CardHeader><div className="scripts-editor-header"><Button type="button" variant="ghost" disabled={busy} onClick={() => changeView("manager")}><ArrowLeftIcon data-icon="inline-start" />返回列表</Button><div className="scripts-toolbar"><Button type="button" variant="outline" disabled={busy || !selected || dirty} onClick={copyScript}>复制为新脚本</Button><Button type="button" variant="outline" disabled={busy || (mode === "json" && !formReady)} onClick={() => { draftRevision.current += 1; setMode(mode === "form" ? "json" : "form"); setDraftError(""); }}>{mode === "form" ? "JSON 高级编辑" : "返回表单"}</Button></div></div>
          <CardTitle><h2 id="scripts-editor-title">{selected || "新建脚本"}</h2></CardTitle><CardDescription>{dirty ? "有未保存的修改" : selected ? "已保存" : "填写后保存，脚本将在匹配的网站自动运行"}</CardDescription></CardHeader>
        <CardContent className="flex flex-col gap-6">
          {mode === "form" && formReady ? <FieldGroup>
            <Field data-invalid={!!fieldErrors.id} data-disabled={!!selected || busy}><FieldLabel htmlFor="script-id">脚本 ID</FieldLabel><FieldDescription>用于识别脚本，保存后不可更改。</FieldDescription><Input id="script-id" name="scriptId" value={parsed.id} disabled={!!selected || busy} aria-invalid={!!fieldErrors.id} aria-describedby={fieldErrors.id ? "script-id-error" : undefined} onChange={(event) => updateField("id", event.target.value)} placeholder="例如：page-helper" />{fieldErrors.id && <FieldError id="script-id-error">{fieldErrors.id}</FieldError>}</Field>
            <Field data-invalid={!!fieldErrors.matches}><FieldLabel htmlFor="script-matches">运行于哪些网站</FieldLabel><FieldDescription>每行一条 Chrome 网站匹配规则，例如 https://example.com/*</FieldDescription><Textarea id="script-matches" name="scriptMatches" spellCheck={false} value={parsed.matches.join("\n")} aria-invalid={!!fieldErrors.matches} aria-describedby={fieldErrors.matches ? "script-matches-error" : undefined} onChange={(event) => updateField("matches", event.target.value)} placeholder="https://example.com/*" />{fieldErrors.matches && <FieldError id="script-matches-error">{fieldErrors.matches}</FieldError>}</Field>
            <Field data-invalid={!!fieldErrors.code}><div className="scripts-code-heading"><FieldLabel id="script-code-label">JavaScript 代码</FieldLabel><Button type="button" variant="outline" size="sm" disabled={busy || !parsed.js[0].code.trim()} onClick={() => void formatNow()}>{action === "formatting" && <LoaderCircleIcon data-icon="inline-start" className="animate-spin" aria-hidden="true" />}格式化代码</Button></div><FieldDescription>JavaScript 和 CSS_* 字符串语法高亮；保存时自动格式化静态 CSS。</FieldDescription><CodeEditor value={parsed.js[0].code} onChange={(value) => updateField("code", value)} invalid={!!fieldErrors.code} errorId={fieldErrors.code ? "script-code-error" : undefined} />{fieldErrors.code && <FieldError id="script-code-error">{fieldErrors.code}</FieldError>}</Field>
          </FieldGroup> : <Field data-invalid={!!draftError}><FieldLabel htmlFor="script-definition">完整脚本定义（JSON）</FieldLabel><FieldDescription>{formReady ? "可编辑 world、runAt 等 Chrome 原生字段；返回表单时会保留。" : "此脚本包含多个代码源、文件源或不完整字段，请在此编辑完整定义。"}</FieldDescription><Textarea id="script-definition" name="scriptDefinition" spellCheck={false} aria-invalid={!!draftError} aria-describedby={draftError ? "script-definition-error" : undefined} value={draft} onChange={(event) => { draftRevision.current += 1; setDraft(event.target.value); setDraftError(""); setMessage(""); }} />{draftError && <FieldError id="script-definition-error">{draftError}</FieldError>}</Field>}
          <div className="scripts-actions"><Button type="button" disabled={busy || !available} onClick={() => void save()}>{action === "saving" && <LoaderCircleIcon data-icon="inline-start" className="animate-spin" aria-hidden="true" />}保存</Button><Button type="button" variant="destructive" disabled={busy || !available || !selected} onClick={() => setDeleteIds([selected])}>删除</Button></div>
        </CardContent>
      </Card>}
    </div>
    {importScripts && <Card><CardHeader><CardTitle><h2>预览导入</h2></CardTitle><CardDescription>新脚本将启用；同名脚本仅在勾选覆盖后替换，并保留本地启停状态。</CardDescription></CardHeader><CardContent className="flex flex-col gap-4"><div className="scripts-import-list">{importScripts.map((script) => { const exists = scripts.some((item) => item.id === script.id); return <label className="scripts-import-row" key={script.id}><Checkbox aria-label={exists ? `覆盖 ${script.id}` : `新增 ${script.id}`} checked={!exists || overwriteIds.includes(script.id)} disabled={!exists} onCheckedChange={(checked) => setOverwriteIds((current) => checked ? [...current, script.id] : current.filter((id) => id !== script.id))} /><span className="min-w-0 break-words">{script.id}</span><Badge variant={exists ? "secondary" : "outline"}>{exists ? "覆盖同名" : "新增"}</Badge></label>; })}</div><div className="scripts-actions"><Button type="button" disabled={busy || !available} onClick={() => void applyImport()}>{action === "importing" && <LoaderCircleIcon data-icon="inline-start" className="animate-spin" aria-hidden="true" />}导入所选</Button><Button type="button" variant="outline" disabled={busy} onClick={() => setImportScripts(null)}>取消</Button></div></CardContent></Card>}
    <AlertDialog open={deleteIds.length > 0} onOpenChange={(open) => { if (!open) setDeleteIds([]); }}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>删除 {deleteIds.length} 个脚本？</AlertDialogTitle><AlertDialogDescription>脚本将从 Chrome 注销并从本地记录删除，此操作不可撤销。</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel><AlertDialogAction variant="destructive" onClick={() => void remove(deleteIds)}>确认删除</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </main>;
}
