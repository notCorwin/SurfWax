export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type ChromeToolInput = {
  code: string;
};

export type ModelConfig = {
  baseURL: string;
  apiKey: string;
  model: string;
  contextWindowOverride?: number;
};
