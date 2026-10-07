import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activeRunIdentity } from "../agent/coordinator";
import { MODEL_CONFIG_STORAGE_KEY } from "./config";
import { useSidePanelSession, type SidePanelSession } from "./useSidePanelSession";

vi.mock("../agent/coordinator", () => ({ activeRunIdentity: vi.fn(async () => undefined) }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const legacy = () => ({ selectedProviderId: "openai", profiles: { openai: {
  providerId: "openai", sdk: "@ai-sdk/openai", baseURL: "https://provider.test/v1", model: "legacy", providerSettings: { apiKey: "saved" },
} } });
const custom = (model: string) => ({ selectedProviderId: "custom", profiles: { custom: {
  providerId: "custom", sdk: "@ai-sdk/openai-compatible", baseURL: "https://custom.test/v1", model, providerSettings: { apiKey: "saved" },
} } });
const catalog = { openai: { npm: "@ai-sdk/openai", models: { legacy: { provider: { shape: "completions" } } } } };

type ChangeListener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => void;
let listeners: Set<ChangeListener>;
let values: Record<string, unknown>;
let set: ReturnType<typeof vi.fn>;
let latest: SidePanelSession;
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
let mounted: boolean;

function Harness() {
  latest = useSidePanelSession();
  return <output>{latest.config.model}</output>;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  listeners = new Set();
  values = { [MODEL_CONFIG_STORAGE_KEY]: legacy() };
  set = vi.fn(async (items: Record<string, unknown>) => { Object.assign(values, items); });
  vi.stubGlobal("chrome", {
    storage: {
      local: { get: vi.fn(async (key: string) => ({ [key]: values[key] })), set },
      onChanged: { addListener: (listener: ChangeListener) => listeners.add(listener), removeListener: (listener: ChangeListener) => listeners.delete(listener) },
    },
    runtime: { onMessage: { addListener: vi.fn(), removeListener: vi.fn() } },
  });
  vi.mocked(activeRunIdentity).mockReset().mockResolvedValue(undefined);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  mounted = true;
});

afterEach(async () => {
  if (mounted) await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

async function replaceSettings(settings: unknown) {
  await act(async () => {
    values[MODEL_CONFIG_STORAGE_KEY] = settings;
    for (const listener of listeners) listener({ [MODEL_CONFIG_STORAGE_KEY]: { newValue: settings } }, "local");
  });
}

describe("sidepanel configuration refresh", () => {
  it("recovers from offline and HTTP 503 without reopening the panel or changing settings", async () => {
    vi.useFakeTimers();
    const original = values[MODEL_CONFIG_STORAGE_KEY];
    const fetch = vi.fn()
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(new Response("temporarily unavailable", { status: 503 }))
      .mockResolvedValueOnce(Response.json(catalog));
    vi.stubGlobal("fetch", fetch);
    try {
      await act(async () => root.render(<Harness />));
      expect(fetch).toHaveBeenCalledOnce();
      expect(latest.configReady).toBe(false);
      expect(latest.configured).toBe(false);
      expect(latest.error).toBeUndefined();

      await act(async () => { await vi.advanceTimersToNextTimerAsync(); });
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(latest.configReady).toBe(false);
      expect(latest.error).toBeUndefined();

      await act(async () => { await vi.advanceTimersToNextTimerAsync(); });
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(latest.configReady).toBe(true);
      expect(latest.configured).toBe(true);
      expect(latest.config.model).toBe("legacy");
      expect(latest.config.modelProvider?.shape).toBe("completions");
      expect(latest.error).toBeUndefined();
      expect(values[MODEL_CONFIG_STORAGE_KEY]).toBe(original);
      expect(set.mock.calls.some(([items]) => Object.hasOwn(items, MODEL_CONFIG_STORAGE_KEY))).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it("hydrates legacy routing without persisting a stale settings snapshot", async () => {
    const original = values[MODEL_CONFIG_STORAGE_KEY];
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(catalog)));
    await act(async () => root.render(<Harness />));
    expect(latest.configReady).toBe(true);
    expect(latest.config.modelProvider?.shape).toBe("completions");
    expect(latest.configured).toBe(true);
    expect(values[MODEL_CONFIG_STORAGE_KEY]).toBe(original);
    expect(set.mock.calls.some(([items]) => Object.hasOwn(items, MODEL_CONFIG_STORAGE_KEY))).toBe(false);
  });

  it("aborts an old refresh and never lets its late result replace newer settings", async () => {
    const pending = deferred<Response>();
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      // Deliberately ignore cancellation to exercise stale-result guards too.
      return pending.promise;
    }));
    await act(async () => root.render(<Harness />));
    expect(latest.configReady).toBe(false);
    expect(signal?.aborted).toBe(false);
    const newer = custom("new-profile");
    await replaceSettings(newer);
    expect(signal?.aborted).toBe(true);
    expect(latest.config.model).toBe("new-profile");
    expect(latest.error).toBeUndefined();
    await act(async () => pending.resolve(Response.json(catalog)));
    expect(latest.config.model).toBe("new-profile");
    expect(latest.error).toBeUndefined();
    expect(values[MODEL_CONFIG_STORAGE_KEY]).toBe(newer);
    expect(set.mock.calls.some(([items]) => Object.hasOwn(items, MODEL_CONFIG_STORAGE_KEY))).toBe(false);
  });

  it("aborts an in-flight catalog request and removes listeners on unmount", async () => {
    let signal: AbortSignal | undefined;
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      signal = init?.signal ?? undefined;
      signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
    }));
    vi.stubGlobal("fetch", fetch);
    await act(async () => root.render(<Harness />));
    expect(signal?.aborted).toBe(false);
    await act(async () => { root.unmount(); mounted = false; });
    expect(signal?.aborted).toBe(true);
    expect(listeners.size).toBe(0);
    expect(fetch).toHaveBeenCalledOnce();
    expect(set).not.toHaveBeenCalled();
  });

  it("also ignores a stale result delayed by the active-run check", async () => {
    values[MODEL_CONFIG_STORAGE_KEY] = custom("initial");
    await act(async () => root.render(<Harness />));
    const pending = deferred<Awaited<ReturnType<typeof activeRunIdentity>>>();
    vi.mocked(activeRunIdentity).mockImplementationOnce(() => pending.promise);
    await replaceSettings(custom("older"));
    expect(latest.config.model).toBe("initial");
    await replaceSettings(custom("newest"));
    expect(latest.config.model).toBe("newest");
    await act(async () => pending.resolve(undefined));
    expect(latest.config.model).toBe("newest");
    expect(latest.error).toBeUndefined();
  });

  it("keeps transient failure pending and cancels retry backoff when the panel closes", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () => { throw new TypeError("offline"); });
    vi.stubGlobal("fetch", fetch);
    try {
      await act(async () => root.render(<Harness />));
      expect(fetch).toHaveBeenCalledOnce();
      expect(latest.configReady).toBe(false);
      expect(latest.error).toBeUndefined();
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      await act(async () => { root.unmount(); mounted = false; });
      await vi.runAllTimersAsync();
      expect(fetch).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
      expect(set).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});
