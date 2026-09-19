import type { JevProvider } from "./types";

export const JEV_PROVIDER_PRESETS: Record<JevProvider, {
  label: string;
  baseURL: string;
  model: string;
  placeholder: string;
  description: string;
}> = {
  typesafe: {
    label: "TypeSafe AI",
    baseURL: "https://api.typesafe.ai",
    model: "jev-latest",
    placeholder: "https://api.typesafe.ai",
    description: "TypeSafe System One API。",
  },
  vercel: {
    label: "Vercel AI Gateway",
    baseURL: "https://ai-gateway.vercel.sh/v4/ai",
    model: "typesafe-ai/jev",
    placeholder: "https://ai-gateway.vercel.sh/v4/ai",
    description: "通过 AI SDK 7 Evaluation API 调用。",
  },
  openrouter: {
    label: "OpenRouter",
    baseURL: "https://openrouter.ai/api",
    model: "typesafe/jev-1.13",
    placeholder: "https://openrouter.ai/api",
    description: "通过 Alpha Decisions API 调用。",
  },
  cloudflare: {
    label: "Cloudflare Workers AI",
    baseURL: "",
    model: "typesafe/jev",
    placeholder: "https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai",
    description: "Base URL 中需要填写 Cloudflare Account ID。",
  },
  litellm: {
    label: "LiteLLM Proxy",
    baseURL: "",
    model: "jev-latest",
    placeholder: "https://your-litellm.example/typesafe",
    description: "Base URL 应指向 LiteLLM 的 /typesafe 透传入口。",
  },
  opper: {
    label: "Opper",
    baseURL: "https://api.opper.ai/v3/compat",
    model: "typesafe/jev-1.13.0",
    placeholder: "https://api.opper.ai/v3/compat",
    description: "通过 Opper 的 System One 兼容接口调用。",
  },
  aimlapi: {
    label: "AI/ML API",
    baseURL: "https://api.aimlapi.com",
    model: "typesafe/jev",
    placeholder: "https://api.aimlapi.com",
    description: "通过 Decisions API 调用。",
  },
  "custom-systemone": {
    label: "自定义 System One",
    baseURL: "",
    model: "jev-latest",
    placeholder: "https://your-gateway.example",
    description: "在 Base URL 后调用 /v1/systemone。",
  },
  "custom-decisions": {
    label: "自定义 Decisions",
    baseURL: "",
    model: "typesafe/jev",
    placeholder: "https://your-gateway.example",
    description: "在 Base URL 后调用 /v1/decisions。",
  },
};

export const JEV_PROVIDERS = Object.keys(JEV_PROVIDER_PRESETS) as JevProvider[];

export function isJevProvider(value: unknown): value is JevProvider {
  return typeof value === "string" && Object.hasOwn(JEV_PROVIDER_PRESETS, value);
}
