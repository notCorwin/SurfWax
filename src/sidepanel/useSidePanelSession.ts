import { useEffect, useState } from "react";
import type { ModelConfig } from "../types";
import { activeRunIdentity } from "../agent/coordinator";
import {
  EMPTY_MODEL_CONFIG,
  MODEL_CONFIG_STORAGE_KEY,
  isCompleteModelConfig,
  loadModelConfig,
  selectedModelConfig,
} from "./config";

const EMPTY_CONFIG: ModelConfig = { sdk: "@ai-sdk/openai-compatible", providerSettings: {}, baseURL: "", model: "" };

export type SidePanelSession = {
  config: ModelConfig;
  systemPrompt?: string;
  configReady: boolean;
  error?: unknown;
  configured: boolean;
  chatKey: string;
};

export function useSidePanelSession(): SidePanelSession {
  const [modelSettings, setModelSettings] = useState(EMPTY_MODEL_CONFIG);
  const [configReady, setConfigReady] = useState(false);
  const [error, setError] = useState<unknown>();

  useEffect(() => {
    let active = true;
    let deferred = false;
    let controller: AbortController | undefined;
    const refresh = async (initial = false) => {
      controller?.abort();
      const current = new AbortController();
      controller = current;
      const isCurrent = () => active && controller === current && !current.signal.aborted;
      try {
        // Runtime hydration is read-only: a stale load must never write an old
        // settings snapshot over a newer choice. Options Save persists routing.
        const stored = await loadModelConfig(undefined, undefined, { signal: current.signal, persistMigration: false });
        if (!isCurrent()) return;
        const running = !initial && await activeRunIdentity();
        if (!isCurrent()) return;
        if (running) { deferred = true; return; }
        deferred = false;
        setModelSettings(stored);
        setError(undefined);
      } catch (cause) {
        if (isCurrent()) setError(cause);
      } finally {
        if (isCurrent()) setConfigReady(true);
      }
    };
    const storageChanged = (changes: { [key: string]: chrome.storage.StorageChange }, area: string) => {
      if (area === "local" && changes[MODEL_CONFIG_STORAGE_KEY]) void refresh();
    };
    const runChanged = (message: { type?: string; identity?: unknown }) => {
      if (deferred && message.type === "surf-wax:run-state" && !message.identity) void refresh();
    };

    void refresh(true);
    chrome.storage.onChanged.addListener(storageChanged);
    chrome.runtime.onMessage.addListener(runChanged);
    return () => {
      active = false;
      controller?.abort();
      chrome.storage.onChanged.removeListener(storageChanged);
      chrome.runtime.onMessage.removeListener(runChanged);
    };
  }, []);

  const config = selectedModelConfig(modelSettings) ?? EMPTY_CONFIG;
  return {
    config,
    systemPrompt: modelSettings.systemPrompt,
    configReady,
    error,
    configured: configReady && Boolean(modelSettings.selectedProviderId) && isCompleteModelConfig(config),
    chatKey: `${config.providerId ?? ""}\u0000${config.sdk ?? ""}\u0000${config.baseURL}\u0000${JSON.stringify(config.providerSettings ?? {})}\u0000${config.model}\u0000${config.contextWindowOverride ?? ""}\u0000${modelSettings.systemPrompt ?? ""}`,
  };
}
