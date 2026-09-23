import { isModelSdk, type ModelConfig, type ModelSdk } from "../types";

export type ProviderSettingField = {
  key: string;
  label: string;
  type?: "text" | "password" | "url" | "textarea";
  required?: boolean;
  placeholder?: string;
  description?: string;
};

export type ProviderDescriptor = {
  id: string;
  npm?: string;
  api?: string;
  env?: string[];
};

const API_KEY: ProviderSettingField = { key: "apiKey", label: "API Key", type: "password", required: true };
const field = (key: string, label: string, options: Omit<ProviderSettingField, "key" | "label"> = {}): ProviderSettingField => ({ key, label, ...options });

export function sdkFor(config: Pick<ModelConfig, "providerId" | "sdk" | "transport" | "baseURL">): ModelSdk {
  if (config.providerId === "deepseek" || config.sdk === "@ai-sdk/openai-compatible" && URL.canParse(config.baseURL)
    && new URL(config.baseURL).hostname === "api.deepseek.com") return "@ai-sdk/deepseek";
  return config.sdk ?? (config.transport === "gateway" ? "@ai-sdk/gateway" : "@ai-sdk/openai-compatible");
}

export function settingsFor(config: Pick<ModelConfig, "providerSettings" | "apiKey">): Record<string, string> {
  return { ...(config.providerSettings ?? {}), ...(config.providerSettings?.apiKey || !config.apiKey ? {} : { apiKey: config.apiKey }) };
}

export function defaultBaseURL(sdk: ModelSdk): string {
  switch (sdk) {
    case "ai-gateway-provider": return "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/v1";
    case "gitlab-ai-provider": return "https://gitlab.com";
    case "watsonx-ai-provider": return "https://us-south.ml.cloud.ibm.com";
    case "venice-ai-sdk-provider": return "https://api.venice.ai/api/v1";
    default: return "";
  }
}

export function providerSettingFields(provider: ProviderDescriptor): ProviderSettingField[] {
  if (!isModelSdk(provider.npm)) return [];
  switch (provider.npm) {
    case "@ai-sdk/amazon-bedrock": return [
      field("region", "Region", { required: true, placeholder: "us-east-1" }),
      field("apiKey", "Bearer Token", { type: "password", description: "Bearer Token，或填写下方 Access Key 凭据。" }),
      field("accessKeyId", "Access Key ID"),
      field("secretAccessKey", "Secret Access Key", { type: "password" }),
      field("sessionToken", "Session Token（可选）", { type: "password" }),
    ];
    case "@ai-sdk/azure": return [
      field("resourceName", "Resource Name", { required: true, description: "用于生成 Azure OpenAI Base URL。" }),
      API_KEY,
    ];
    case "@ai-sdk/google-vertex": return [
      field("project", "Project", { required: true }),
      field("location", "Location", { required: true, placeholder: "us-central1" }),
      field("apiKey", "API Key", { type: "password", description: "API Key，或粘贴下方 Service Account JSON。" }),
      field("serviceAccountJson", "Service Account JSON", { type: "textarea" }),
    ];
    case "@ai-sdk/google-vertex/anthropic": return [
      field("project", "Project", { required: true }),
      field("location", "Location", { required: true, placeholder: "us-east5" }),
      field("serviceAccountJson", "Service Account JSON", { type: "textarea", required: true }),
    ];
    case "ai-gateway-provider": return [
      API_KEY,
      field("accountId", "Cloudflare Account ID", { required: true }),
      field("gatewayId", "AI Gateway ID", { required: true }),
    ];
    case "gitlab-ai-provider": return [
      field("apiKey", "GitLab Token", { type: "password", required: true }),
      field("instanceUrl", "GitLab Instance URL", { type: "url", placeholder: "https://gitlab.com" }),
      field("aiGatewayUrl", "AI Gateway URL", { type: "url", placeholder: "https://cloud.gitlab.com" }),
    ];
    case "watsonx-ai-provider": return [
      API_KEY,
      field("projectId", "Project ID", { required: true }),
    ];
    case "@jerome-benoit/sap-ai-provider-v2": return [
      field("serviceKeyJson", "SAP AI Core Service Key JSON", { type: "textarea", required: true }),
      field("resourceGroup", "Resource Group", { placeholder: "default" }),
      field("deploymentUrl", "Orchestration Deployment URL", { type: "url", required: true }),
    ];
    case "@qvac/ai-sdk-provider": return [
      API_KEY,
      field("endpoint", "QVAC OpenAI-compatible Endpoint", { type: "url", required: true, placeholder: "http://127.0.0.1:8000/v1" }),
    ];
  }

  const templateVariables = [...(provider.api?.matchAll(/\$\{([A-Z0-9_]+)\}/g) ?? [])].map((match) => match[1]!);
  return [API_KEY, ...templateVariables.map((key) => field(key, key, { required: true }))];
}

export function resolveEndpoint(template: string, providerSettings: Record<string, string>): string {
  const aliases: Record<string, string> = {
    AWS_REGION: "region", AZURE_RESOURCE_NAME: "resourceName", GOOGLE_VERTEX_PROJECT: "project",
    GOOGLE_VERTEX_PROJECT_ID: "project", GOOGLE_VERTEX_LOCATION: "location", CLOUDFLARE_ACCOUNT_ID: "accountId",
    CLOUDFLARE_GATEWAY_ID: "gatewayId", WATSONX_AI_PROJECT_ID: "projectId",
  };
  return template.replace(/\$\{([A-Z0-9_]+)\}/g, (_, key: string) => encodeURIComponent(providerSettings[key]?.trim() ?? providerSettings[aliases[key] ?? ""]?.trim() ?? ""));
}

export function resolvedBaseURL(config: ModelConfig): string {
  const settings = settingsFor(config);
  const sdk = sdkFor(config);
  if (sdk === "@ai-sdk/azure" && settings.resourceName) {
    return `https://${settings.resourceName.trim()}.openai.azure.com/openai/v1`;
  }
  if (sdk === "ai-gateway-provider") return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(settings.accountId?.trim() ?? "")}/ai/v1`;
  if (sdk === "gitlab-ai-provider") return (settings.instanceUrl || defaultBaseURL(sdk)).trim().replace(/\/+$/, "");
  if (sdk === "@jerome-benoit/sap-ai-provider-v2") return settings.deploymentUrl?.trim().replace(/\/+$/, "") ?? "";
  if (sdk === "@qvac/ai-sdk-provider") return settings.endpoint?.trim() || config.baseURL.trim();
  if (!config.baseURL.trim()) return defaultBaseURL(sdk);
  return resolveEndpoint(config.baseURL.trim(), settings).replace(/\/+$/, "");
}

function parseServiceAccount(value: string): { clientEmail: string; privateKey: string; privateKeyId?: string } | undefined {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (typeof parsed.client_email !== "string" || typeof parsed.private_key !== "string") return undefined;
    return {
      clientEmail: parsed.client_email,
      privateKey: parsed.private_key,
      ...(typeof parsed.private_key_id === "string" ? { privateKeyId: parsed.private_key_id } : {}),
    };
  } catch { return undefined; }
}

export function googleCredentials(config: ModelConfig) {
  return parseServiceAccount(settingsFor(config).serviceAccountJson ?? "");
}

export function modelConfigErrors(config: ModelConfig, fields?: ProviderSettingField[]): Record<string, string> {
  const errors: Record<string, string> = {};
  const sdk = sdkFor(config);
  const settings = settingsFor(config);
  if (!config.model.trim()) errors.model = "请输入 Model ID";
  if (config.contextWindowOverride !== undefined && (!Number.isSafeInteger(config.contextWindowOverride) || config.contextWindowOverride <= 0)) {
    errors.contextWindowOverride = "请输入正整数 token 数";
  }

  for (const item of fields ?? providerSettingFields({ id: config.providerId ?? "custom", npm: sdk, api: config.baseURL })) {
    if (item.required && !settings[item.key]?.trim()) errors[item.key] = `请输入${item.label}`;
  }
  if (sdk === "@ai-sdk/amazon-bedrock" && !settings.apiKey?.trim() && !(settings.accessKeyId?.trim() && settings.secretAccessKey?.trim())) {
    errors.apiKey = "请输入 Bearer Token，或填写 Access Key ID 与 Secret Access Key";
  }
  if (sdk === "@ai-sdk/google-vertex" && !settings.apiKey?.trim() && !googleCredentials(config)) {
    errors.serviceAccountJson = "请输入 API Key，或有效的 Service Account JSON";
  }
  if (sdk === "@ai-sdk/google-vertex/anthropic" && !googleCredentials(config)) errors.serviceAccountJson = "请输入有效的 Service Account JSON";
  if (sdk === "@jerome-benoit/sap-ai-provider-v2" && settings.serviceKeyJson) {
    try {
      const key = JSON.parse(settings.serviceKeyJson) as Record<string, any>;
      if (!(key.url ?? key.uaa?.url) || !(key.clientid ?? key.uaa?.clientid) || !(key.clientsecret ?? key.uaa?.clientsecret)) {
        errors.serviceKeyJson = "Service Key 缺少 url、clientid 或 clientsecret";
      }
    } catch { errors.serviceKeyJson = "请输入有效的 JSON"; }
  }

  const endpoint = resolvedBaseURL(config);
  if (sdk === "@ai-sdk/openai-compatible" && !endpoint) errors.baseURL = "请输入 Base URL";
  if (endpoint && /\$\{/.test(endpoint)) errors.baseURL = "请填写 Endpoint 模板变量";
  if (endpoint) {
    try {
      const url = new URL(endpoint);
      if (url.protocol !== "http:" && url.protocol !== "https:") errors.baseURL = "请输入 HTTP 或 HTTPS 地址";
    } catch { errors.baseURL = "请输入有效的网址"; }
  }
  return errors;
}

export function isOpenAIShapedSdk(sdk: ModelSdk): boolean {
  return sdk === "@ai-sdk/openai-compatible" || sdk === "@ai-sdk/deepseek" || sdk === "@qvac/ai-sdk-provider" || sdk === "venice-ai-sdk-provider"
    || sdk === "ai-gateway-provider" || sdk === "watsonx-ai-provider" || sdk === "gitlab-ai-provider";
}
