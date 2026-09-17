import type { ModelConfig } from "../types";
import { resolveModelLimit } from "./model-limits";

export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningEffort = typeof REASONING_EFFORTS[number];
export type ReasoningSource = "endpoint" | "models.dev" | "unknown";
export type ReasoningState = {
  selected: ReasoningEffort | null;
  choices: readonly ReasoningEffort[];
  source: ReasoningSource;
  ready: boolean;
};

const STORAGE_KEY = "side-agent:reasoning-selections";
const LEARNED_TTL_MS = 24 * 60 * 60 * 1000;
type Storage = { get(key: string): Promise<Record<string, unknown>>; set(items: Record<string, unknown>): Promise<void> };
type SavedSettings = { manual?: ReasoningEffort; rejected?: ReasoningEffort[]; fieldUnsupported?: boolean; learnedAt?: number };

function efforts(value: unknown): ReasoningEffort[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return REASONING_EFFORTS.filter((effort) => value.includes(effort));
}

export function endpointEfforts(catalog: unknown, modelId: string): ReasoningEffort[] | undefined {
  if (!catalog || typeof catalog !== "object" || !Array.isArray((catalog as { data?: unknown }).data)) return undefined;
  const model = (catalog as { data: unknown[] }).data.find((entry) =>
    entry && typeof entry === "object" && (entry as { id?: unknown }).id === modelId,
  ) as { reasoning?: { supported_efforts?: unknown; mandatory?: boolean } | boolean; reasoning_options?: Array<{ type?: string; values?: unknown }> } | undefined;
  if (!model) return undefined;
  if (model.reasoning === false) return [];
  const advertised = model.reasoning && typeof model.reasoning === "object" ? model.reasoning.supported_efforts : undefined;
  const available = advertised === null ? [...REASONING_EFFORTS]
    : efforts(advertised) ?? efforts(model.reasoning_options?.find((option) => option.type === "effort")?.values)
      ?? (model.reasoning_options ? [] : undefined);
  return model.reasoning && typeof model.reasoning === "object" && model.reasoning.mandatory
    ? available?.filter((effort) => effort !== "none") : available;
}

export class ReasoningSettings {
  private state: ReasoningState = { selected: "none", choices: REASONING_EFFORTS, source: "unknown", ready: false };
  private listeners = new Set<() => void>();
  private rejected = new Set<ReasoningEffort>();
  private manual = false;
  private fieldUnsupported = false;
  readonly ready: Promise<void>;

  constructor(private config: ModelConfig, private options: {
    storage?: Storage;
    fetch?: typeof globalThis.fetch;
    modelLimit?: typeof resolveModelLimit;
  } = {}) {
    this.ready = this.initialize();
  }

  snapshot = (): ReasoningState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private publish(next: ReasoningState): void {
    this.state = next;
    this.listeners.forEach((listener) => listener());
  }

  private key(): string {
    return `${this.config.baseURL.trim().replace(/\/+$/, "")}\u0000${this.config.model.trim()}`;
  }

  private storage(): Storage | undefined {
    return this.options.storage ?? (typeof chrome !== "undefined" ? chrome.storage?.local : undefined);
  }

  private async persist(): Promise<void> {
    const storage = this.storage();
    if (!storage) return;
    const values = (await storage.get(STORAGE_KEY).catch(() => ({} as Record<string, unknown>)))[STORAGE_KEY];
    const saved = values && typeof values === "object" && !Array.isArray(values) ? values as Record<string, unknown> : {};
    const value: SavedSettings = {
      ...(this.manual && this.state.selected ? { manual: this.state.selected } : {}),
      ...(this.rejected.size || this.fieldUnsupported ? {
        rejected: [...this.rejected], fieldUnsupported: this.fieldUnsupported, learnedAt: Date.now(),
      } : {}),
    };
    await storage.set({ [STORAGE_KEY]: { ...saved, [this.key()]: value } });
  }

  select(effort: ReasoningEffort): void {
    if (!this.state.ready || !this.state.choices.includes(effort)) return;
    this.manual = true;
    this.publish({ ...this.state, selected: effort });
    void this.persist().catch(() => undefined);
  }

  reject(effort: ReasoningEffort, supported?: readonly ReasoningEffort[], fieldUnsupported = false): ReasoningEffort | null {
    if (fieldUnsupported) {
      this.fieldUnsupported = true;
      this.publish({ selected: null, choices: [], source: this.state.source, ready: true });
      void this.persist().catch(() => undefined);
      return null;
    }
    this.rejected.add(effort);
    const choices = (supported ?? this.state.choices).filter((candidate) => !this.rejected.has(candidate));
    const next = choices[0] ?? null;
    this.publish({ ...this.state, choices, selected: next });
    void this.persist().catch(() => undefined);
    return next;
  }

  private async initialize(): Promise<void> {
    const storage = this.storage();
    const saved = storage ? (await storage.get(STORAGE_KEY).catch(() => ({} as Record<string, unknown>)))[STORAGE_KEY] : undefined;
    const value = saved && typeof saved === "object" ? (saved as Record<string, unknown>)[this.key()] : undefined;
    const stored = value && typeof value === "object" ? value as SavedSettings : undefined;
    const manual = REASONING_EFFORTS.find((effort) => effort === (stored?.manual ?? value));
    this.manual = Boolean(manual);
    if (stored?.learnedAt && Date.now() - stored.learnedAt < LEARNED_TTL_MS) {
      this.fieldUnsupported = stored.fieldUnsupported === true;
      this.rejected = new Set(efforts(stored.rejected) ?? []);
    }
    const baseURL = this.config.baseURL.trim().replace(/\/+$/, "");
    const fetcher = this.options.fetch ?? globalThis.fetch.bind(globalThis);
    const endpoint = await fetcher(`${baseURL}/models`, {
        headers: { Authorization: `Bearer ${this.config.apiKey}` },
        signal: AbortSignal.timeout(5_000),
      }).then((response) => response.ok ? response.json() : undefined).then((body) => endpointEfforts(body, this.config.model)).catch(() => undefined);
    const catalog = endpoint === undefined
      ? await (this.options.modelLimit ?? resolveModelLimit)({ ...this.config, contextWindowOverride: undefined })
        .then((limit) => efforts(limit?.reasoningEfforts)).catch(() => undefined)
      : undefined;
    const source: ReasoningSource = endpoint !== undefined ? "endpoint" : catalog !== undefined ? "models.dev" : "unknown";
    const choices = this.fieldUnsupported ? [] : (endpoint ?? catalog ?? [...REASONING_EFFORTS]).filter((effort) => !this.rejected.has(effort));
    const selected = choices.length ? (manual && choices.includes(manual) ? manual : choices[0]!) : null;
    this.publish({ selected, choices, source, ready: true });
  }
}

const settings = new Map<string, ReasoningSettings>();

export function reasoningSettingsFor(config: ModelConfig): ReasoningSettings {
  const key = `${config.baseURL.trim().replace(/\/+$/, "")}\u0000${config.model.trim()}\u0000${config.apiKey}`;
  let current = settings.get(key);
  if (!current) {
    current = new ReasoningSettings(config);
    settings.set(key, current);
  }
  return current;
}
