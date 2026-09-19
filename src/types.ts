export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type ChromeTarget = {
  kind: "auto" | "extension" | "service-worker" | "page" | "offscreen" | "devtools" | "native";
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

export type ModelConfig = {
  baseURL: string;
  apiKey: string;
  model: string;
  contextWindowOverride?: number;
};

export type JevConfig = {
  baseURL: string;
  apiKey: string;
  model: string;
  threshold: number;
};
