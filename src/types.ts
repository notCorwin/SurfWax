export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type ChromeTarget = {
  kind: "auto" | "extension" | "service-worker" | "page" | "offscreen" | "devtools";
  tabId?: number;
  frameId?: number;
  documentId?: string;
  world?: "MAIN" | "ISOLATED" | "USER_SCRIPT";
  targetId?: string;
  sessionId?: string;
};

export type ChromeToolInput = {
  code: string;
  target?: ChromeTarget;
  timeoutMs?: number;
  /** Legacy page target fields kept so restored conversations remain executable. */
  tabId?: number;
  world?: "MAIN" | "USER_SCRIPT";
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

export type BrowserStep =
  | { type: "goto"; url: string }
  | { type: "click" | "doubleClick" | "hover"; target: BrowserTarget }
  | { type: "fill"; target: BrowserTarget; value: string }
  | { type: "clear"; target: BrowserTarget }
  | { type: "press"; target?: BrowserTarget; key: string }
  | { type: "insertText"; target?: BrowserTarget; text: string }
  | { type: "select"; target: BrowserTarget; values: string[] }
  | { type: "check"; target: BrowserTarget; checked?: boolean }
  | { type: "drag"; from: BrowserTarget; to: BrowserTarget }
  | { type: "upload"; target: BrowserTarget; files: Array<{ name: string; mimeType?: string; text?: string; base64?: string; url?: string }> }
  | { type: "expect"; target?: BrowserTarget; state?: "attached" | "detached" | "visible" | "hidden" | "enabled" | "editable" | "checked"; text?: string; value?: string; url?: string };

export type BrowserInput = {
  mode: "observe";
  tabId?: number;
  detail?: "auto" | "semantic" | "visual";
  since?: string;
  timeoutMs?: number;
} | {
  mode: "act";
  tabId?: number;
  observationId?: string;
  steps: BrowserStep[];
  timeoutMs?: number;
} | {
  mode: "run";
  code: string;
  target?: ChromeTarget;
  timeoutMs?: number;
} | {
  mode: "result";
  id: number;
  path?: string | Array<string | number>;
  offset?: number;
  limit?: number;
};

export const MODEL_SDKS = [
  "@ai-sdk/amazon-bedrock",
  "@ai-sdk/anthropic",
  "@ai-sdk/azure",
  "@ai-sdk/cerebras",
  "@ai-sdk/cohere",
  "@ai-sdk/deepinfra",
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

export type JevConfig = {
  provider: JevProvider;
  baseURL: string;
  apiKey: string;
  model: string;
  threshold: number;
};

export type JevProvider =
  | "typesafe"
  | "vercel"
  | "openrouter"
  | "cloudflare"
  | "litellm"
  | "opper"
  | "aimlapi"
  | "custom-systemone"
  | "custom-decisions";
