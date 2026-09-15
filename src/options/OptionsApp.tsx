import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "../components/ui/card";
import { Field, FieldGroup, FieldLabel } from "../components/ui/field";
import { Input } from "../components/ui/input";
import { EventLogger } from "../logging";
import type { PersistedModelConfig } from "../sidepanel/config";
import { isCompleteModelConfig, loadModelConfig, saveModelConfig } from "../sidepanel/config";
import "../styles.css";
import "./styles.css";

const EMPTY_CONFIG: PersistedModelConfig = { baseURL: "", apiKey: "", model: "" };
type Status = "idle" | "saving" | "clearing" | "saved" | "error";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function OptionsApp() {
  const [config, setConfig] = useState(EMPTY_CONFIG);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState("");
  const logger = useMemo(() => new EventLogger({ onError: (error) => {
    setStatus("error");
    setMessage(`事件日志不可用：${errorText(error)}`);
  } }), []);

  useEffect(() => {
    let active = true;
    void loadModelConfig(EMPTY_CONFIG).then((stored) => {
      if (active) setConfig(stored);
    }).catch((error) => {
      if (!active) return;
      setStatus("error");
      setMessage(`配置读取失败：${errorText(error)}`);
    }).finally(() => {
      if (active) setReady(true);
    });
    return () => {
      active = false;
    };
  }, []);

  const update = (field: keyof PersistedModelConfig, value: string) => {
    setConfig((current) => ({ ...current, [field]: value }));
    setStatus("idle");
    setMessage("");
  };

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!isCompleteModelConfig(config)) {
      setStatus("error");
      setMessage("请完整填写 Base URL、Model ID 和 API Key");
      return;
    }

    setStatus("saving");
    setMessage("");
    try {
      await saveModelConfig(config);
      setStatus("saved");
      setMessage("配置已保存，Side Panel 会立即使用新配置");
    } catch (error) {
      setStatus("error");
      setMessage(`配置保存失败：${errorText(error)}`);
    }
  };

  const clearLog = async () => {
    if (!globalThis.confirm("确定清空全部本地对话与事件日志吗？此操作不可恢复。")) return;
    setStatus("clearing");
    setMessage("");
    try {
      await chrome.runtime.sendMessage({ type: "side-agent:clear-log" }).catch(() => undefined);
      await logger.clear();
      setStatus("saved");
      setMessage("对话与事件日志已清空");
    } catch (error) {
      setStatus("error");
      setMessage(`日志清空失败：${errorText(error)}`);
    }
  };

  const busy = !ready || status === "saving" || status === "clearing";

  return (
    <main className="options-shell">
      <header className="options-header">
        <h1>模型设置</h1>
        <p>配置 OpenAI-compatible Provider，并管理本地 canonical event log。</p>
      </header>

      <Card data-testid="options-card">
        <form onSubmit={(event) => void save(event)}>
          <CardHeader>
            <CardTitle>Provider 配置</CardTitle>
            <CardDescription>仅保存在当前扩展的 chrome.storage.local。</CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <Field data-disabled={busy || undefined}>
                <FieldLabel htmlFor="base-url">Base URL</FieldLabel>
                <Input id="base-url" type="url" required value={config.baseURL} disabled={busy} onChange={(event) => update("baseURL", event.target.value)} />
              </Field>
              <Field data-disabled={busy || undefined}>
                <FieldLabel htmlFor="model-id">Model ID</FieldLabel>
                <Input id="model-id" required value={config.model} disabled={busy} onChange={(event) => update("model", event.target.value)} />
              </Field>
              <Field data-disabled={busy || undefined}>
                <FieldLabel htmlFor="api-key">API Key</FieldLabel>
                <Input id="api-key" type="password" required value={config.apiKey} disabled={busy} onChange={(event) => update("apiKey", event.target.value)} />
              </Field>
            </FieldGroup>
          </CardContent>
          <CardFooter>
            <Button type="submit" disabled={busy}>{status === "saving" ? "保存中…" : "保存配置"}</Button>
          </CardFooter>
        </form>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>本地会话</CardTitle>
          <CardDescription>事件日志是聊天界面、恢复会话与模型上下文的唯一来源。</CardDescription>
        </CardHeader>
        <CardFooter>
          <Button type="button" variant="destructive" data-testid="event-log-clear" disabled={busy} onClick={() => void clearLog()}>
            {status === "clearing" ? "清空中…" : "清空对话与日志"}
          </Button>
        </CardFooter>
      </Card>

      {message && <p className="options-status" data-state={status} role="status">{message}</p>}
    </main>
  );
}
