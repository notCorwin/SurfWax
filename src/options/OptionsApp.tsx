import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { ChevronRightIcon, LoaderCircleIcon } from "lucide-react";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "../components/ui/card";
import { Field, FieldGroup, FieldLabel } from "../components/ui/field";
import { Input } from "../components/ui/input";
import { ErrorNotice } from "../components/ui/error-notice";
import { EventLogger } from "../logging";
import { resolveModelLimit, type ModelLimit } from "../agent/model-limits";
import type { JevConfig } from "../types";
import type { PersistedJevConfig, PersistedModelConfig } from "../sidepanel/config";
import {
  DEFAULT_JEV_CONFIG,
  isCompleteModelConfig,
  loadJevConfig,
  loadModelConfig,
  saveJevConfig,
  saveModelConfig,
} from "../sidepanel/config";
import "../styles.css";
import "./styles.css";

const EMPTY_CONFIG: PersistedModelConfig = { baseURL: "", apiKey: "", model: "" };
const EMPTY_JEV_CONFIG: PersistedJevConfig = DEFAULT_JEV_CONFIG;
type Status = "idle" | "saving" | "clearing" | "saved" | "error";

export function OptionsApp() {
  const [config, setConfig] = useState(EMPTY_CONFIG);
  const [jevConfig, setJevConfig] = useState<JevConfig>(EMPTY_JEV_CONFIG);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState("");
  const [errorDetail, setErrorDetail] = useState<unknown>();
  const [matchedLimit, setMatchedLimit] = useState<ModelLimit>();
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof PersistedModelConfig, string>>>({});
  const [jevFieldErrors, setJevFieldErrors] = useState<Partial<Record<keyof PersistedJevConfig, string>>>({});
  const savedConfig = useRef(JSON.stringify({ config: EMPTY_CONFIG, jevConfig: EMPTY_JEV_CONFIG }));
  const matchingKey = useRef("");
  const fail = (summary: string, error: unknown) => {
    setStatus("error");
    setMessage(summary);
    setErrorDetail(error);
  };
  const logger = useMemo(() => new EventLogger({ onError: (error) => fail("事件日志不可用。", error) }), []);

  useEffect(() => {
    let active = true;
    void Promise.all([loadModelConfig(EMPTY_CONFIG), loadJevConfig(EMPTY_JEV_CONFIG)]).then(([stored, storedJev]) => {
      if (!active) return;
      setConfig(stored);
      setJevConfig(storedJev);
      savedConfig.current = JSON.stringify({ config: stored, jevConfig: storedJev });
      matchingKey.current = `${stored.baseURL}\u0000${stored.model}`;
      if (isCompleteModelConfig(stored)) {
        void resolveModelLimit({ ...stored, contextWindowOverride: undefined }).then((limit) => {
          if (active && matchingKey.current === `${stored.baseURL}\u0000${stored.model}`) setMatchedLimit(limit);
        }).catch(() => undefined);
      }
    }).catch((error) => {
      if (!active) return;
      fail("配置读取失败。", error);
    }).finally(() => {
      if (active) setReady(true);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (JSON.stringify({ config, jevConfig }) === savedConfig.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [config, jevConfig]);

  const update = (field: keyof PersistedModelConfig, value: string) => {
    setConfig((current) => ({ ...current, [field]: field === "contextWindowOverride" ? (value ? Number(value) : undefined) : value }));
    setFieldErrors((current) => ({ ...current, [field]: undefined }));
    if (field === "baseURL" || field === "model") {
      matchingKey.current = "";
      setMatchedLimit(undefined);
    }
    setStatus("idle");
    setMessage("");
    setErrorDetail(undefined);
  };

  const updateJev = (field: keyof PersistedJevConfig, value: string) => {
    setJevConfig((current) => ({ ...current, [field]: field === "threshold" ? Number(value) : value }));
    setJevFieldErrors((current) => ({ ...current, [field]: undefined }));
    setStatus("idle");
    setMessage("");
    setErrorDetail(undefined);
  };

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const errors: Partial<Record<keyof PersistedModelConfig, string>> = {};
    if (!config.baseURL.trim()) errors.baseURL = "请输入 Base URL";
    else {
      try {
        const url = new URL(config.baseURL);
        if (url.protocol !== "http:" && url.protocol !== "https:") errors.baseURL = "请输入 HTTP 或 HTTPS 地址";
      } catch { errors.baseURL = "请输入有效的网址"; }
    }
    if (!config.model.trim()) errors.model = "请输入 Model ID";
    if (!config.apiKey.trim()) errors.apiKey = "请输入 API Key";
    if (config.contextWindowOverride !== undefined && (!Number.isSafeInteger(config.contextWindowOverride) || config.contextWindowOverride <= 0)) {
      errors.contextWindowOverride = "请输入正整数 token 数";
    }
    const jevErrors: Partial<Record<keyof PersistedJevConfig, string>> = {};
    if (jevConfig.apiKey.trim()) {
      if (!jevConfig.baseURL.trim()) jevErrors.baseURL = "请输入 Jev Base URL";
      else {
        try {
          const url = new URL(jevConfig.baseURL);
          if (url.protocol !== "http:" && url.protocol !== "https:") jevErrors.baseURL = "请输入有效的 Jev HTTP 或 HTTPS 地址";
        } catch { jevErrors.baseURL = "请输入有效的 Jev 网址"; }
      }
      if (!jevConfig.model.trim()) jevErrors.model = "请输入 Jev Model ID";
    }
    if (!Number.isFinite(jevConfig.threshold) || jevConfig.threshold < 0.01 || jevConfig.threshold > 0.99
      || Math.abs(jevConfig.threshold * 100 - Math.round(jevConfig.threshold * 100)) > 1e-8) {
      jevErrors.threshold = "请输入 0.01 到 0.99 之间、精确到百分位的数值";
    }
    setFieldErrors(errors);
    setJevFieldErrors(jevErrors);
    if (Object.keys(errors).length || Object.keys(jevErrors).length) {
      setStatus("error");
      setMessage("请检查标出的字段");
      setErrorDetail(undefined);
      if (errors.contextWindowOverride) document.getElementById("context-window")?.closest("details")?.setAttribute("open", "");
      const firstMainError = Object.keys(errors)[0] as keyof PersistedModelConfig | undefined;
      const firstJevError = Object.keys(jevErrors)[0] as keyof PersistedJevConfig | undefined;
      const firstErrorId = firstMainError
        ? ({ baseURL: "base-url", model: "model-id", apiKey: "api-key", contextWindowOverride: "context-window" }[firstMainError])
        : firstJevError
          ? ({ baseURL: "jev-base-url", model: "jev-model-id", apiKey: "jev-api-key", threshold: "jev-threshold" }[firstJevError])
          : undefined;
      if (firstErrorId) document.getElementById(firstErrorId)?.focus();
      return;
    }

    setStatus("saving");
    setMessage("正在保存配置…");
    try {
      await Promise.all([saveModelConfig(config), saveJevConfig(jevConfig)]);
      savedConfig.current = JSON.stringify({ config, jevConfig });
      setStatus("saved");
      setMessage("配置已保存，Side Panel 会立即使用新配置");
      matchingKey.current = `${config.baseURL}\u0000${config.model}`;
      void resolveModelLimit({ ...config, contextWindowOverride: undefined }).then((limit) => {
        if (matchingKey.current === `${config.baseURL}\u0000${config.model}`) setMatchedLimit(limit);
      }).catch(() => undefined);
    } catch (error) {
      fail("配置保存失败。", error);
    }
  };

  const clearLog = async () => {
    if (!globalThis.confirm("确定清空全部本地对话与事件日志吗？此操作不可恢复。")) return;
    setStatus("clearing");
    setMessage("正在清空对话与日志…");
    try {
      await chrome.runtime.sendMessage({ type: "side-agent:clear-log" }).catch(() => undefined);
      await logger.clear();
      setStatus("saved");
      setMessage("对话与事件日志已清空");
    } catch (error) {
      fail("日志清空失败。", error);
    }
  };

  const busy = !ready || status === "saving" || status === "clearing";

  return (
    <main className="options-shell">
      <a className="skip-link" href="#options-content">跳转到配置</a>
      <header className="options-header">
        <h1>模型设置</h1>
        <p>配置 OpenAI-compatible Provider，并管理本地 canonical event log。</p>
      </header>

      <Card id="options-content" tabIndex={-1} data-testid="options-card">
        <form noValidate onSubmit={(event) => void save(event)}>
          <CardHeader>
            <CardTitle>Provider 配置</CardTitle>
            <CardDescription>仅保存在当前扩展的 chrome.storage.local。</CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <Field data-disabled={busy || undefined}>
                <FieldLabel htmlFor="base-url">Base URL</FieldLabel>
                <Input id="base-url" name="baseURL" type="url" autoComplete="url" aria-invalid={!!fieldErrors.baseURL} aria-describedby={fieldErrors.baseURL ? "base-url-error" : undefined} value={config.baseURL} disabled={busy} onChange={(event) => update("baseURL", event.target.value)} />
                {fieldErrors.baseURL && <p id="base-url-error" className="field-error" role="alert">{fieldErrors.baseURL}</p>}
              </Field>
              <Field data-disabled={busy || undefined}>
                <FieldLabel htmlFor="model-id">Model ID</FieldLabel>
                <Input id="model-id" name="model" autoComplete="off" aria-invalid={!!fieldErrors.model} aria-describedby={fieldErrors.model ? "model-id-error" : undefined} value={config.model} disabled={busy} onChange={(event) => update("model", event.target.value)} />
                {fieldErrors.model && <p id="model-id-error" className="field-error" role="alert">{fieldErrors.model}</p>}
              </Field>
              <Field data-disabled={busy || undefined}>
                <FieldLabel htmlFor="api-key">API Key</FieldLabel>
                <Input id="api-key" name="apiKey" type="password" autoComplete="off" aria-invalid={!!fieldErrors.apiKey} aria-describedby={fieldErrors.apiKey ? "api-key-error" : undefined} value={config.apiKey} disabled={busy} onChange={(event) => update("apiKey", event.target.value)} />
                {fieldErrors.apiKey && <p id="api-key-error" className="field-error" role="alert">{fieldErrors.apiKey}</p>}
              </Field>
              <Field>
                <FieldLabel>上下文窗口自动匹配</FieldLabel>
                <p data-testid="model-limit-match" className="model-limit-match">
                  {matchedLimit ? `${matchedLimit.provider}/${matchedLimit.model} · ${matchedLimit.context.toLocaleString()} tokens`
                    : "尚无匹配结果；可在下方手动设置窗口大小。"}
                </p>
                {config.contextWindowOverride && <p className="model-limit-match">当前生效：手动指定 {config.contextWindowOverride.toLocaleString()} tokens</p>}
              </Field>
              <details className="advanced-settings">
                <summary><ChevronRightIcon aria-hidden="true" /><span>高级设置：手动指定上下文窗口</span></summary>
                <Field data-disabled={busy || undefined}>
                  <FieldLabel htmlFor="context-window">窗口大小（tokens）</FieldLabel>
                  <Input id="context-window" name="contextWindowOverride" type="number" min="1" step="1" aria-invalid={!!fieldErrors.contextWindowOverride} aria-describedby={fieldErrors.contextWindowOverride ? "context-window-error" : undefined} value={config.contextWindowOverride ?? ""} disabled={busy}
                    onChange={(event) => update("contextWindowOverride", event.target.value)} />
                  {fieldErrors.contextWindowOverride && <p id="context-window-error" className="field-error" role="alert">{fieldErrors.contextWindowOverride}</p>}
                </Field>
              </details>
            </FieldGroup>
          </CardContent>
          <CardFooter>
            <Button type="submit" disabled={busy} aria-busy={status === "saving"}>
              {status === "saving" && <LoaderCircleIcon className="animate-spin" aria-hidden="true" />}
              保存配置
            </Button>
          </CardFooter>
        </form>
      </Card>

      <Card data-testid="jev-config-card">
        <form noValidate onSubmit={(event) => void save(event)}>
          <CardHeader>
            <CardTitle>Jev 消息选择压缩（可选）</CardTitle>
            <CardDescription>上下文达到阈值时可选择 Jev 重选；清空 API Key 即停用 Jev。</CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <Field data-disabled={busy || undefined}>
                <FieldLabel htmlFor="jev-base-url">Jev Base URL</FieldLabel>
                <Input id="jev-base-url" name="jevBaseURL" type="url" autoComplete="url" aria-invalid={!!jevFieldErrors.baseURL} aria-describedby={jevFieldErrors.baseURL ? "jev-base-url-error" : undefined} value={jevConfig.baseURL} disabled={busy} onChange={(event) => updateJev("baseURL", event.target.value)} />
                {jevFieldErrors.baseURL && <p id="jev-base-url-error" className="field-error" role="alert">{jevFieldErrors.baseURL}</p>}
              </Field>
              <Field data-disabled={busy || undefined}>
                <FieldLabel htmlFor="jev-model-id">Jev Model ID</FieldLabel>
                <Input id="jev-model-id" name="jevModel" autoComplete="off" aria-invalid={!!jevFieldErrors.model} aria-describedby={jevFieldErrors.model ? "jev-model-id-error" : undefined} value={jevConfig.model} disabled={busy} onChange={(event) => updateJev("model", event.target.value)} />
                {jevFieldErrors.model && <p id="jev-model-id-error" className="field-error" role="alert">{jevFieldErrors.model}</p>}
              </Field>
              <Field data-disabled={busy || undefined}>
                <FieldLabel htmlFor="jev-api-key">Jev API Key</FieldLabel>
                <Input id="jev-api-key" name="jevApiKey" type="password" autoComplete="off" aria-invalid={!!jevFieldErrors.apiKey} aria-describedby={jevFieldErrors.apiKey ? "jev-api-key-error" : undefined} value={jevConfig.apiKey} disabled={busy} onChange={(event) => updateJev("apiKey", event.target.value)} />
                {jevFieldErrors.apiKey && <p id="jev-api-key-error" className="field-error" role="alert">{jevFieldErrors.apiKey}</p>}
              </Field>
              <Field data-disabled={busy || undefined}>
                <FieldLabel htmlFor="jev-threshold">最低保留评分</FieldLabel>
                <Input id="jev-threshold" name="jevThreshold" type="number" min="0.01" max="0.99" step="0.01" aria-invalid={!!jevFieldErrors.threshold} aria-describedby={jevFieldErrors.threshold ? "jev-threshold-error" : undefined} value={jevConfig.threshold} disabled={busy} onChange={(event) => updateJev("threshold", event.target.value)} />
                {jevFieldErrors.threshold && <p id="jev-threshold-error" className="field-error" role="alert">{jevFieldErrors.threshold}</p>}
              </Field>
            </FieldGroup>
          </CardContent>
          <CardFooter>
            <Button type="submit" disabled={busy} aria-busy={status === "saving"}>
              {status === "saving" && <LoaderCircleIcon className="animate-spin" aria-hidden="true" />}
              保存 Jev 配置
            </Button>
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
            {status === "clearing" && <LoaderCircleIcon className="animate-spin" aria-hidden="true" />}
            清空对话与日志
          </Button>
        </CardFooter>
      </Card>

      {message && (status === "error" && errorDetail !== undefined
        ? <ErrorNotice summary={message} error={errorDetail} />
        : <p className="options-status" data-state={status} role={status === "error" ? "alert" : "status"}>{message}</p>)}
    </main>
  );
}
