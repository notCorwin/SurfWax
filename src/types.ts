export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type ChromeToolInput = {
  code: string;
  tabId?: number;
  world?: "MAIN" | "USER_SCRIPT";
};

export type ModelConfig = {
  baseURL: string;
  apiKey: string;
  model: string;
  contextWindowOverride?: number;
};
