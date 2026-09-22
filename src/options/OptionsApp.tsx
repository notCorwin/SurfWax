import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { ChevronRightIcon, LoaderCircleIcon } from "lucide-react";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "../components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "../components/ui/field";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { ErrorNotice } from "../components/ui/error-notice";
import { SearchCombobox, type SearchComboboxOption } from "./SearchCombobox";
import { EventLogger } from "../logging";
import { loadModelCatalog, modelProviderPresets, resolveModelLimit, type ModelLimit, type ModelProviderPreset } from "../agent/model-limits";
import { modelConfigErrors, resolvedBaseURL, type ProviderSettingField } from "../agent/model-sdks";
import type { ModelProfile } from "../sidepanel/config";
import {
  EMPTY_MODEL_CONFIG,
  isCompleteModelConfig,
  loadModelConfig,
  saveModelConfig,
  selectedModelConfig,
} from "../sidepanel/config";
import "../styles.css";
import "./styles.css";

type Status = "idle" | "saving" | "clearing" | "saved" | "error";
type ModelField = "providerId" | "baseURL" | "model" | "contextWindowOverride" | "imageInput" | string;

export function OptionsApp() {
  const [modelSettings, setModelSettings] = useState(EMPTY_MODEL_CONFIG);
  const [providers, setProviders] = useState<ModelProviderPreset[]>([]);
  const [providerInput, setProviderInput] = useState("");
  const [catalogError, setCatalogError] = useState<unknown>();
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState("");
  const [errorDetail, setErrorDetail] = useState<unknown>();
  const [matchedLimit, setMatchedLimit] = useState<ModelLimit>();
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<ModelField, string>>>({});
  const savedConfig = useRef(JSON.stringify({ modelSettings: EMPTY_MODEL_CONFIG, providerInput: "" }));
  const matchingKey = useRef("");
  const storedProfile = selectedModelConfig(modelSettings);
  const selectedProvider = providers.find((provider) => provider.id === modelSettings.selectedProviderId);
  const providerOptions = useMemo<SearchComboboxOption[]>(() => [
    { value: "custom", label: "自定义 Endpoint" },
    ...providers.filter((provider) => provider.id === "vercel").map((provider) => ({ value: provider.id, label: provider.name })),
    ...providers.filter((provider) => provider.id !== "vercel").map((provider) => ({ value: provider.id, label: provider.name })),
  ], [providers]);
  const config = storedProfile && selectedProvider
    ? { ...storedProfile, baseURL: selectedProvider.baseURL, sdk: selectedProvider.sdk }
    : storedProfile;
  const settingFields: ProviderSettingField[] = selectedProvider?.fields ?? [{ key: "apiKey", label: "API Key", type: "password", required: true }];
  const fail = (summary: string, error: unknown) => {
    setStatus("error");
    setMessage(summary);
    setErrorDetail(error);
  };
  const logger = useMemo(() => new EventLogger({ onError: (error) => fail("事件日志不可用。", error) }), []);

  useEffect(() => {
    let active = true;
    void Promise.all([
      loadModelConfig(),
      loadModelCatalog().then(modelProviderPresets).catch((error) => { setCatalogError(error); return []; }),
    ]).then(([stored, catalogProviders]) => {
      if (!active) return;
      setModelSettings(stored);
      setProviderInput(stored.selectedProviderId);
      setProviders(catalogProviders);
      savedConfig.current = JSON.stringify({ modelSettings: stored, providerInput: stored.selectedProviderId });
      const selected = selectedModelConfig(stored);
      const preset = catalogProviders.find((provider) => provider.id === stored.selectedProviderId);
      const effective = selected && preset ? { ...selected, baseURL: preset.baseURL, sdk: preset.sdk } : selected;
      matchingKey.current = effective ? `${effective.baseURL}\u0000${effective.model}` : "";
      if (effective && isCompleteModelConfig(effective)) {
        void resolveModelLimit({ ...effective, contextWindowOverride: undefined }).then((limit) => {
          if (active && matchingKey.current === `${effective.baseURL}\u0000${effective.model}`) setMatchedLimit(limit);
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
      if (JSON.stringify({ modelSettings, providerInput }) === savedConfig.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [modelSettings, providerInput]);

  const update = (field: Exclude<ModelField, "providerId">, value: string) => {
    if (!config) return;
    setModelSettings((current) => ({ ...current, profiles: { ...current.profiles, [config.providerId]: {
      ...config, [field]: field === "contextWindowOverride" ? (value ? Number(value) : undefined) : value,
    } } }));
    setFieldErrors((current) => ({ ...current, [field]: undefined }));
    if (field === "baseURL" || field === "model") {
      matchingKey.current = "";
      setMatchedLimit(undefined);
    }
    setStatus("idle");
    setMessage("");
    setErrorDetail(undefined);
  };

  const updateSetting = (key: string, value: string) => {
    if (!config) return;
    setModelSettings((current) => ({ ...current, profiles: { ...current.profiles, [config.providerId]: {
      ...config, providerSettings: { ...config.providerSettings, [key]: value },
    } } }));
    setFieldErrors((current) => ({ ...current, [key]: undefined }));
    setStatus("idle");
    setMessage("");
    setErrorDetail(undefined);
  };

  const updateSystemPrompt = (value: string) => {
    setModelSettings((current) => ({ ...current, systemPrompt: value }));
    setStatus("idle");
    setMessage("");
    setErrorDetail(undefined);
  };

  const changeProvider = (value: string) => {
    setProviderInput(value);
    const preset = providers.find((provider) => provider.id === value);
    if (value !== "custom" && !preset) return;
    setModelSettings((current) => ({
      selectedProviderId: value,
      profiles: current.profiles[value] ? current.profiles : { ...current.profiles, [value]: {
        providerId: value,
        sdk: preset?.sdk ?? "@ai-sdk/openai-compatible",
        providerSettings: {},
        baseURL: preset?.baseURL ?? "",
        model: "",
        imageInput: "auto",
      } satisfies ModelProfile },
    }));
    setFieldErrors({});
    setMatchedLimit(undefined);
    setStatus("idle");
    setMessage("");
    setErrorDetail(undefined);
  };

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const errors: Partial<Record<ModelField, string>> = {};
    if (!modelSettings.selectedProviderId || providerInput !== modelSettings.selectedProviderId) errors.providerId = "请选择 Provider";
    if (config) Object.assign(errors, modelConfigErrors(config, settingFields));
    setFieldErrors(errors);
    if (Object.keys(errors).length) {
      setStatus("error");
      setMessage("请检查标出的字段");
      setErrorDetail(undefined);
      const firstMainError = ["providerId", "baseURL", "model", ...settingFields.map(({ key }) => key), "contextWindowOverride"]
        .find((key) => errors[key]) as ModelField | undefined;
      const firstErrorId = firstMainError
        ? ({ providerId: "provider-id", baseURL: "base-url", model: "model-id", apiKey: "api-key", contextWindowOverride: "context-window", imageInput: "image-input" }[firstMainError] ?? `provider-setting-${firstMainError}`)
        : undefined;
      if (firstErrorId) {
        const field = document.getElementById(firstErrorId);
        field?.closest("details")?.setAttribute("open", "");
        field?.focus();
      }
      return;
    }

    setStatus("saving");
    setMessage("正在保存配置…");
    try {
      const savedModelSettings = { ...modelSettings, profiles: { ...modelSettings.profiles,
        ...(config ? { [config.providerId]: config } : {}),
      } };
      await saveModelConfig(savedModelSettings);
      setModelSettings(savedModelSettings);
      savedConfig.current = JSON.stringify({ modelSettings: savedModelSettings, providerInput });
      setStatus("saved");
      setMessage("配置已保存，Side Panel 会立即使用新配置");
      if (config) {
        matchingKey.current = `${config.baseURL}\u0000${config.model}`;
        void resolveModelLimit({ ...config, contextWindowOverride: undefined }).then((limit) => {
          if (matchingKey.current === `${config.baseURL}\u0000${config.model}`) setMatchedLimit(limit);
        }).catch(() => undefined);
      }
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
        <p>选择 Models.dev Provider 或配置自定义 Endpoint，并管理本地 canonical event log。</p>
      </header>

      <Card id="options-content" tabIndex={-1} data-testid="options-card">
        <form noValidate onSubmit={(event) => void save(event)}>
          <CardHeader>
            <CardTitle>Provider 配置</CardTitle>
            <CardDescription>仅保存在当前扩展的 chrome.storage.local。</CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <Field data-disabled={busy || undefined} data-invalid={!!fieldErrors.providerId || undefined}>
                <FieldLabel htmlFor="provider-id">Provider</FieldLabel>
                <SearchCombobox id="provider-id" name="providerId" options={providerOptions} value={providerInput}
                  onValueChange={changeProvider} disabled={busy} placeholder="搜索或选择 Provider…"
                  aria-invalid={!!fieldErrors.providerId} aria-describedby={fieldErrors.providerId ? "provider-id-error" : "provider-description"} />
                <FieldDescription id="provider-description">
                  {!ready ? "正在加载 Models.dev Provider 目录…" : catalogError
                    ? "Models.dev 暂时不可用；仍可选择 custom 使用自定义 Endpoint。"
                    : `已载入 ${providers.length.toLocaleString()} 个内置 Provider；每个 Provider 独立保存配置。`}
                </FieldDescription>
                {fieldErrors.providerId && <p id="provider-id-error" className="field-error" role="alert">{fieldErrors.providerId}</p>}
              </Field>
              {config && <>
                {modelSettings.selectedProviderId === "custom" ? <Field data-disabled={busy || undefined} data-invalid={!!fieldErrors.baseURL || undefined}>
                  <FieldLabel htmlFor="base-url">Base URL</FieldLabel>
                  <Input id="base-url" name="baseURL" type="url" autoComplete="url" aria-invalid={!!fieldErrors.baseURL} aria-describedby={fieldErrors.baseURL ? "base-url-error" : undefined} value={config.baseURL} disabled={busy} onChange={(event) => update("baseURL", event.target.value)} />
                  {fieldErrors.baseURL && <p id="base-url-error" className="field-error" role="alert">{fieldErrors.baseURL}</p>}
                </Field> : <Field>
                  <FieldLabel>Endpoint</FieldLabel>
                  <p className="model-limit-match">{resolvedBaseURL(config) || "由 SDK 使用默认 Endpoint"}</p>
                </Field>}
                <Field data-disabled={busy || undefined} data-invalid={!!fieldErrors.model || undefined}>
                  <FieldLabel htmlFor="model-id">Model ID</FieldLabel>
                  <SearchCombobox id="model-id" name="model" allowCustom
                    options={selectedProvider?.models.map((model) => ({ value: model.id, label: model.name })) ?? []}
                    value={config.model} disabled={busy} onValueChange={(value) => update("model", value)}
                    aria-invalid={!!fieldErrors.model} aria-describedby={fieldErrors.model ? "model-id-error" : undefined} />
                  {fieldErrors.model && <p id="model-id-error" className="field-error" role="alert">{fieldErrors.model}</p>}
                  {selectedProvider && selectedProvider.models.length === 0 && <FieldDescription>
                    Models.dev 当前没有符合文本输出与 tool_call 条件的目录模型；可手填 Model ID，浏览器工具可能不可用。
                  </FieldDescription>}
                </Field>
                {settingFields.map((item) => {
                  const id = item.key === "apiKey" ? "api-key" : `provider-setting-${item.key}`;
                  const errorId = `${id}-error`;
                  const value = config.providerSettings[item.key] ?? "";
                  return <Field key={item.key} data-disabled={busy || undefined} data-invalid={!!fieldErrors[item.key] || undefined}>
                    <FieldLabel htmlFor={id}>{item.label}</FieldLabel>
                    {item.type === "textarea"
                      ? <Textarea id={id} name={item.key} autoComplete="off" placeholder={item.placeholder} aria-invalid={!!fieldErrors[item.key]}
                        aria-describedby={fieldErrors[item.key] ? errorId : undefined} value={value} disabled={busy} onChange={(event) => updateSetting(item.key, event.target.value)} />
                      : <Input id={id} name={item.key} type={item.type ?? "text"} autoComplete="off" placeholder={item.placeholder}
                        aria-invalid={!!fieldErrors[item.key]} aria-describedby={fieldErrors[item.key] ? errorId : undefined} value={value} disabled={busy}
                        onChange={(event) => updateSetting(item.key, event.target.value)} />}
                    {item.description && <FieldDescription>{item.description}</FieldDescription>}
                    {fieldErrors[item.key] && <p id={errorId} className="field-error" role="alert">{fieldErrors[item.key]}</p>}
                  </Field>;
                })}
                {matchedLimit?.source === "estimated" && <Field>
                  <FieldLabel>上下文窗口未匹配</FieldLabel>
                  <p data-testid="model-limit-match" className="model-limit-match">
                    Models.dev 未提供可靠匹配；当前按 {matchedLimit.context.toLocaleString()} tokens 估算，可在高级设置中手动覆盖。
                  </p>
                  {config.contextWindowOverride && <p className="model-limit-match">当前生效：手动指定 {config.contextWindowOverride.toLocaleString()} tokens</p>}
                </Field>}
              </>}
              <details className="advanced-settings">
                <summary><ChevronRightIcon aria-hidden="true" /><span>高级设置</span></summary>
                <div className="advanced-settings-content">
                  <FieldSet>
                    <FieldLegend>系统提示词</FieldLegend>
                    <Field data-disabled={busy || undefined}>
                      <FieldLabel htmlFor="system-prompt">自定义系统提示词</FieldLabel>
                      <Textarea id="system-prompt" name="systemPrompt" autoComplete="off" value={modelSettings.systemPrompt ?? ""} disabled={busy}
                        onChange={(event) => updateSystemPrompt(event.target.value)} />
                      <FieldDescription>留空使用内置提示词；填写后将完整替换内置提示词。所有 Provider 共用此设置。</FieldDescription>
                    </Field>
                  </FieldSet>
                  <FieldSet>
                    <FieldLegend>上下文窗口</FieldLegend>
                    <Field data-disabled={busy || !config || undefined} data-invalid={!!fieldErrors.contextWindowOverride || undefined}>
                      <FieldLabel htmlFor="context-window">窗口大小（tokens）</FieldLabel>
                      <Input id="context-window" name="contextWindowOverride" type="number" min="1" step="1" aria-invalid={!!fieldErrors.contextWindowOverride} aria-describedby={fieldErrors.contextWindowOverride ? "context-window-error" : undefined} value={config?.contextWindowOverride ?? ""} disabled={busy || !config}
                        onChange={(event) => update("contextWindowOverride", event.target.value)} />
                      {fieldErrors.contextWindowOverride && <p id="context-window-error" className="field-error" role="alert">{fieldErrors.contextWindowOverride}</p>}
                    </Field>
                  </FieldSet>
                  <FieldSet>
                    <FieldLegend>图片输入</FieldLegend>
                    <Field data-disabled={busy || !config || undefined}>
                      <FieldLabel htmlFor="image-input">视觉能力</FieldLabel>
                      <Select value={config?.imageInput ?? "auto"} disabled={busy || !config} onValueChange={(value) => update("imageInput", value)}>
                        <SelectTrigger id="image-input" aria-label="图片输入能力" className="w-full"><SelectValue /></SelectTrigger>
                        <SelectContent position="popper"><SelectGroup>
                          <SelectItem value="auto">自动检测</SelectItem>
                          <SelectItem value="enabled">支持</SelectItem>
                          <SelectItem value="disabled">不支持</SelectItem>
                        </SelectGroup></SelectContent>
                      </Select>
                      <FieldDescription>自动模式读取模型目录；未知模型默认仅使用语义路径。</FieldDescription>
                    </Field>
                  </FieldSet>
                </div>
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
