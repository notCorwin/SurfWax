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

export type PageToolInput = {
  code: string;
  tabId?: number;
  timeoutMs?: number;
};

export type ModelConfig = {
  baseURL: string;
  apiKey: string;
  model: string;
  contextWindowOverride?: number;
};

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
