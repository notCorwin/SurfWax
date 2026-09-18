import { useEffect, useState } from "react";
import type { JevConfig, ModelConfig } from "../types";
import {
  DEFAULT_JEV_CONFIG,
  JEV_CONFIG_STORAGE_KEY,
  MODEL_CONFIG_STORAGE_KEY,
  isCompleteJevConfig,
  isCompleteModelConfig,
  loadJevConfig,
  loadModelConfig,
} from "./config";

const EMPTY_CONFIG: ModelConfig = { baseURL: "", apiKey: "", model: "" };

export type SidePanelSession = {
  config: ModelConfig;
  jevConfig: JevConfig;
  configReady: boolean;
  error?: unknown;
  configured: boolean;
  jevConfigured: boolean;
  chatKey: string;
};

export function useSidePanelSession(): SidePanelSession {
  const [config, setConfig] = useState<ModelConfig>(EMPTY_CONFIG);
  const [jevConfig, setJevConfig] = useState<JevConfig>(DEFAULT_JEV_CONFIG);
  const [configReady, setConfigReady] = useState(false);
  const [error, setError] = useState<unknown>();

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const [stored, storedJev] = await Promise.all([
          loadModelConfig(EMPTY_CONFIG),
          loadJevConfig(),
        ]);
        if (!active) return;
        setConfig(stored);
        setJevConfig(storedJev);
        setError(undefined);
      } catch (cause) {
        if (active) setError(cause);
      } finally {
        if (active) setConfigReady(true);
      }
    };
    const storageChanged = (changes: { [key: string]: chrome.storage.StorageChange }, area: string) => {
      if (area === "local" && (changes[MODEL_CONFIG_STORAGE_KEY] || changes[JEV_CONFIG_STORAGE_KEY])) void refresh();
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
    jevConfig,
    configReady,
    error,
    configured: configReady && isCompleteModelConfig(config),
    jevConfigured: configReady && isCompleteJevConfig(jevConfig),
    chatKey: `${config.baseURL}\u0000${config.model}\u0000${config.contextWindowOverride ?? ""}\u0000${jevConfig.baseURL}\u0000${jevConfig.model}\u0000${jevConfig.apiKey}`,
  };
}
