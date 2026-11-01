import { useEffect, useState } from "react";
import { modelLimitKey, resolveModelLimit, type ModelLimit } from "../agent/model-limits";
import { isCompleteModelConfig } from "../sidepanel/config";
import type { ModelConfig } from "../types";

/** Match the current configuration only; a late lookup cannot affect a later selection. */
export function useModelLimit(config: ModelConfig | undefined, ready: boolean): ModelLimit | undefined {
  const [result, setResult] = useState<{ key: string; limit: ModelLimit | undefined }>();
  const complete = ready && isCompleteModelConfig(config);
  const requested = complete && config ? { ...config, contextWindowOverride: undefined } : undefined;
  const key = requested ? modelLimitKey(requested) : undefined;

  useEffect(() => {
    if (!requested || !key || !complete) return;
    let active = true;
    void resolveModelLimit(requested).then((limit) => {
      if (active) setResult({ key, limit });
    }).catch(() => undefined);
    return () => { active = false; };
  }, [key, complete]);

  return complete && result && result.key === key ? result.limit : undefined;
}
