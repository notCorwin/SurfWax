import { useEffect, useState } from "react";
import type { ModelConfig } from "../types";
import { MODEL_CONFIG_STORAGE_KEY, isCompleteModelConfig, loadModelConfig } from "./config";

const EMPTY_CONFIG: ModelConfig = { baseURL: "", apiKey: "", model: "" };

export type SidePanelSession = {
  config: ModelConfig;
  configReady: boolean;
  error?: unknown;
  configured: boolean;
  chatKey: string;
};

export function useSidePanelSession(): SidePanelSession {
  const [config, setConfig] = useState<ModelConfig>(EMPTY_CONFIG);
  const [configReady, setConfigReady] = useState(false);
  const [error, setError] = useState<unknown>();

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const stored = await loadModelConfig(EMPTY_CONFIG);
        if (!active) return;
        setConfig(stored);
        setError(undefined);
      } catch (cause) {
        if (active) setError(cause);
      } finally {
        if (active) setConfigReady(true);
      }
    };
    const storageChanged = (changes: { [key: string]: chrome.storage.StorageChange }, area: string) => {
      if (area === "local" && changes[MODEL_CONFIG_STORAGE_KEY]) void refresh();
    };

    void refresh();
    chrome.storage.onChanged.addListener(storageChanged);
    return () => {
      active = false;
      chrome.storage.onChanged.removeListener(storageChanged);
    };
  }, []);

  return {
    config,
    configReady,
    error,
    configured: configReady && isCompleteModelConfig(config),
    chatKey: `${config.baseURL}\u0000${config.model}\u0000${config.contextWindowOverride ?? ""}`,
  };
}
