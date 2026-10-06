export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type PageExecutionTarget = {
  kind: "page";
  tabId: number;
  world: "MAIN" | "ISOLATED" | "USER_SCRIPT";
  frameId?: number;
  documentId?: string;
};

export type BrowserSelector = {
  by: "role" | "text" | "label" | "placeholder" | "alt" | "title" | "testId" | "css";
  value: string;
  name?: string;
  exact?: boolean;
  index?: number;
  frame?: { by: "css"; value: string };
};

export type BrowserTarget =
  | { ref: string }
  | BrowserSelector
  | { point: { observationId: string; x: number; y: number } };

export const MODEL_SDKS = [
  "@ai-sdk/amazon-bedrock",
  "@ai-sdk/anthropic",
  "@ai-sdk/azure",
  "@ai-sdk/cerebras",
  "@ai-sdk/cohere",
  "@ai-sdk/deepinfra",
  "@ai-sdk/deepseek",
  "@ai-sdk/gateway",
  "@ai-sdk/google",
  "@ai-sdk/google-vertex",
  "@ai-sdk/google-vertex/anthropic",
  "@ai-sdk/groq",
  "@ai-sdk/mistral",
  "@ai-sdk/openai",
  "@ai-sdk/openai-compatible",
  "@ai-sdk/perplexity",
  "@ai-sdk/togetherai",
  "@ai-sdk/vercel",
  "@ai-sdk/xai",
  "@aihubmix/ai-sdk-provider",
  "@jerome-benoit/sap-ai-provider-v2",
  "@openrouter/ai-sdk-provider",
  "@qvac/ai-sdk-provider",
  "@saladtechnologies-oss/ai-sdk-provider",
  "ai-gateway-provider",
  "gitlab-ai-provider",
  "merge-gateway-ai-sdk-provider",
  "venice-ai-sdk-provider",
  "watsonx-ai-provider",
] as const;

export type ModelSdk = typeof MODEL_SDKS[number];

export function isModelSdk(value: unknown): value is ModelSdk {
  return typeof value === "string" && (MODEL_SDKS as readonly string[]).includes(value);
}

export type ModelConfig = {
  providerId?: string;
  sdk?: ModelSdk;
  providerSettings?: Record<string, string>;
  /** Legacy fields are read during migration and kept optional for restored tests/conversations. */
  transport?: ModelTransport;
  baseURL: string;
  apiKey?: string;
  model: string;
  contextWindowOverride?: number;
  imageInput?: "auto" | "enabled" | "disabled";
};

export type ModelTransport = "gateway" | "openai-compatible";
