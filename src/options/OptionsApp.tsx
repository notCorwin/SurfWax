import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { EventLogger, getLogStore, type LogCategory, type LogEvent } from "../logging";
import type { PersistedModelConfig } from "../sidepanel/config";
import {
  isCompleteModelConfig,
  loadModelConfig,
  saveModelConfig,
} from "../sidepanel/config";
import { UserScriptsPanel } from "../userscripts/UserScriptsPanel";
import "../styles.css";
import "./styles.css";

const emptyConfig: PersistedModelConfig = {
  baseURL: "",
  apiKey: "",
  model: "",
};

type SaveState = "idle" | "saving" | "saved" | "error";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function OptionsApp() {
  const [config, setConfig] = useState<PersistedModelConfig>(emptyConfig);
  const [ready, setReady] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [message, setMessage] = useState("");
  const eventLogger = useMemo(() => new EventLogger(), []);

  useEffect(() => {
    let active = true;
    void loadModelConfig(emptyConfig)
      .then((stored) => {
        if (!active) return;
        setConfig(stored);
        setReady(true);
      })
      .catch((error) => {
        if (!active) return;
        setReady(true);
        setSaveState("error");
        setMessage(`配置读取失败：${errorText(error)}`);
      });

    return () => {
      active = false;
    };
  }, []);

  const updateField = (field: keyof PersistedModelConfig, value: string) => {
    setConfig((current) => ({ ...current, [field]: value }));
    setSaveState("idle");
    setMessage("");
  };

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!isCompleteModelConfig(config)) {
      setSaveState("error");
      setMessage("请完整填写 Base URL、Model ID 和 API Key");
      return;
    }

    setSaveState("saving");
    setMessage("");
    try {
      await saveModelConfig(config);
      setSaveState("saved");
      setMessage("配置已保存，Side Panel 会立即使用新配置");
    } catch (error) {
      setSaveState("error");
      setMessage(`配置保存失败：${errorText(error)}`);
    }
  };

  return (
    <main className="options-shell">
      <header className="options-header">
        <p className="options-eyebrow">SIDE AGENT RUNTIME</p>
        <h1>模型设置</h1>
        <p>在这里管理 Side Agent 使用的 OpenAI-compatible Provider 配置。</p>
      </header>

      <Card className="options-card" data-testid="options-card">
        <form onSubmit={(event) => void save(event)}>
          <CardHeader className="options-card-header">
            <CardTitle>Provider 配置</CardTitle>
            <CardDescription>配置只保存在当前浏览器扩展的 chrome.storage.local 中。</CardDescription>
          </CardHeader>
          <CardContent className="options-card-content">
            <div className="options-field">
              <Label htmlFor="base-url">Base URL</Label>
              <Input
                id="base-url"
                value={config.baseURL}
                onChange={(event) => updateField("baseURL", event.target.value)}
                disabled={!ready || saveState === "saving"}
              />
            </div>
            <div className="options-field">
              <Label htmlFor="model-id">Model ID</Label>
              <Input
                id="model-id"
                value={config.model}
                onChange={(event) => updateField("model", event.target.value)}
                disabled={!ready || saveState === "saving"}
              />
            </div>
            <div className="options-field">
              <Label htmlFor="api-key">API Key</Label>
              <Input
                id="api-key"
                type="password"
                value={config.apiKey}
                onChange={(event) => updateField("apiKey", event.target.value)}
                disabled={!ready || saveState === "saving"}
              />
            </div>
          </CardContent>
          <CardFooter className="options-actions">
            <Button type="submit" className="save-button" disabled={!ready || saveState === "saving"}>
              {saveState === "saving" ? "保存中…" : "保存配置"}
            </Button>
          </CardFooter>
          {message && <p className={`save-message ${saveState}`} role="status">{message}</p>}
        </form>
      </Card>
      <UserScriptsPanel logger={eventLogger} mode="options" />
      <EventLogViewer logger={eventLogger} />
    </main>
  );
}

function formatEvent(event: LogEvent): string {
  try {
    return JSON.stringify(event, null, 2) ?? String(event);
  } catch {
    return String(event);
  }
}

function EventLogViewer({ logger }: { logger: EventLogger }) {
  const store = useMemo(() => getLogStore(), []);
  const [events, setEvents] = useState<LogEvent[]>([]);
  const [category, setCategory] = useState<LogCategory | "">("");
  const [search, setSearch] = useState("");
  const [beforeId, setBeforeId] = useState<number | undefined>();
  const [hasMore, setHasMore] = useState(false);
  const [status, setStatus] = useState("");

  const load = useCallback(async (cursor?: number, append = false) => {
    try {
      const result = await store.list({
        limit: 101,
        beforeId: cursor,
        search,
        ...(category ? { category } : {}),
      });
      setHasMore(result.length > 100);
      setEvents((current) => append ? [...current, ...result.slice(0, 100)] : result.slice(0, 100));
      setStatus("");
    } catch (error) {
      setStatus(`日志读取失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }, [category, search, store]);

  useEffect(() => {
    setBeforeId(undefined);
    void load();
  }, [load]);

  const exportLogs = async () => {
    const all = (await store.all()).sort((left, right) => left.id - right.id);
    const content = all.map((event) => JSON.stringify(event)).join("\n");
    const url = URL.createObjectURL(new Blob([content], { type: "application/x-ndjson" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `side-agent-runtime-${new Date().toISOString().replaceAll(":", "-")}.jsonl`;
    link.click();
    URL.revokeObjectURL(url);
    logger.record({ category: "system", type: "logs.exported", content: { count: all.length } });
    setStatus(`已导出 ${all.length} 条日志`);
  };

  const clearLogs = async () => {
    if (!window.confirm("确定清空全部本地事件日志吗？此操作不可恢复。")) return;
    try {
      await store.clear();
      setEvents([]);
      setBeforeId(undefined);
      setHasMore(false);
      setStatus("日志已清空");
    } catch (error) {
      setStatus(`日志清空失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const loadMore = () => {
    const cursor = events.at(-1)?.id;
    if (cursor === undefined) return;
    setBeforeId(cursor);
    void load(cursor, true);
  };

  return (
    <section className="event-log" data-testid="event-log">
      <div className="event-log-header">
        <div>
          <h2>本地事件日志</h2>
          <p>事件日志是对话、模型上下文和恢复会话的唯一来源，保存在本地 IndexedDB。</p>
        </div>
        <div className="event-log-actions">
          <button type="button" className="secondary-button" data-testid="event-log-refresh" onClick={() => void load()}>刷新</button>
          <button type="button" className="secondary-button" data-testid="event-log-export" onClick={() => void exportLogs()}>导出 JSONL</button>
          <button type="button" className="text-button danger" data-testid="event-log-clear" onClick={() => void clearLogs()}>清空</button>
        </div>
      </div>
      <div className="event-log-filters">
        <select aria-label="日志分类" value={category} onChange={(event) => setCategory(event.target.value as LogCategory | "")}>
          <option value="">全部分类</option>
          <option value="conversation">conversation</option>
          <option value="model">model</option>
          <option value="tool">tool</option>
          <option value="request">request</option>
          <option value="userscript">userscript</option>
          <option value="system">system</option>
        </select>
        <input aria-label="搜索日志" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索事件或正文" />
      </div>
      <div className="event-log-rows">
        {events.length === 0 ? <p className="event-log-empty">暂无日志。</p> : events.map((event) => (
          <details className="event-log-row" key={event.id}>
            <summary>
              <span>{event.category}</span>
              <strong>{event.type}</strong>
              <time>{event.timestamp}</time>
            </summary>
            <pre>{formatEvent(event)}</pre>
          </details>
        ))}
      </div>
      {hasMore && <button type="button" className="secondary-button" onClick={loadMore}>加载更早日志</button>}
      {status && <p className="event-log-status" role="status">{status}</p>}
    </section>
  );
}
