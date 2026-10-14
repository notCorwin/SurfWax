import type { ModelConfig, ModelSdk } from "../types";
import { googleCredentials, isOpenAIShapedSdk, sdkFor, settingsFor } from "./model-sdks";

export type ProviderModule = Record<string, any>;
export type ProviderModuleLoader = () => Promise<ProviderModule>;
export type ProviderAuth = "api-key" | "aws" | "google-service-account" | "azure-api-key" | "oauth" | "gitlab-direct-access";

export type ProviderAdapter = {
  sdk: ModelSdk;
  protocol: "openai" | "openai-compatible" | "native";
  auth: ProviderAuth;
  requiresMaxTokens: boolean;
};

const SDK_LOADERS: Record<ModelSdk, ProviderModuleLoader> = {
  "@ai-sdk/amazon-bedrock": () => import("@ai-sdk/amazon-bedrock"),
  "@ai-sdk/amazon-bedrock/mantle": () => import("@ai-sdk/amazon-bedrock/mantle"),
  "@ai-sdk/anthropic": () => import("@ai-sdk/anthropic"),
  "@ai-sdk/azure": () => import("@ai-sdk/azure"),
  "@ai-sdk/cerebras": () => import("@ai-sdk/cerebras"),
  "@ai-sdk/cohere": () => import("@ai-sdk/cohere"),
  "@ai-sdk/deepinfra": () => import("@ai-sdk/deepinfra"),
  "@ai-sdk/deepseek": () => import("@ai-sdk/deepseek"),
  "@ai-sdk/gateway": () => import("@ai-sdk/gateway"),
  "@ai-sdk/google": () => import("@ai-sdk/google"),
  "@ai-sdk/google-vertex": () => import("@ai-sdk/google-vertex/edge"),
  "@ai-sdk/google-vertex/anthropic": () => import("@ai-sdk/google-vertex/anthropic/edge"),
  "@ai-sdk/groq": () => import("@ai-sdk/groq"),
  "@ai-sdk/mistral": () => import("@ai-sdk/mistral"),
  "@ai-sdk/openai": () => import("@ai-sdk/openai"),
  "@ai-sdk/openai-compatible": () => import("@ai-sdk/openai-compatible"),
  "@ai-sdk/perplexity": () => import("@ai-sdk/perplexity"),
  "@ai-sdk/togetherai": () => import("@ai-sdk/togetherai"),
  "@ai-sdk/vercel": () => import("@ai-sdk/vercel"),
  "@ai-sdk/xai": () => import("@ai-sdk/xai"),
  "@aihubmix/ai-sdk-provider": () => import("@aihubmix/ai-sdk-provider"),
  "@openrouter/ai-sdk-provider": () => import("@openrouter/ai-sdk-provider"),
  "@saladtechnologies-oss/ai-sdk-provider": () => import("@saladtechnologies-oss/ai-sdk-provider"),
  "merge-gateway-ai-sdk-provider": () => import("merge-gateway-ai-sdk-provider"),
  "@qvac/ai-sdk-provider": () => import("@ai-sdk/openai-compatible"),
  "venice-ai-sdk-provider": () => import("@ai-sdk/openai-compatible"),
  "ai-gateway-provider": () => import("@ai-sdk/openai-compatible"),
  "gitlab-ai-provider": () => import("@ai-sdk/openai-compatible"),
  "watsonx-ai-provider": () => import("@ai-sdk/openai-compatible"),
  "@jerome-benoit/sap-ai-provider-v2": () => import("@ai-sdk/openai-compatible"),
};

export function providerAdapterFor(config: ModelConfig): ProviderAdapter {
  const sdk = sdkFor(config);
  const settings = settingsFor(config);
  const serviceAccount = Boolean(googleCredentials(config) && !settings.apiKey);
  const auth: ProviderAuth = sdk === "@ai-sdk/amazon-bedrock" || sdk === "@ai-sdk/amazon-bedrock/mantle" ? "aws"
    : config.providerId === "google-vertex" && serviceAccount || sdk === "@ai-sdk/google-vertex/anthropic" ? "google-service-account"
      : (config.providerId === "azure" || config.providerId === "azure-cognitive-services") && sdk === "@ai-sdk/openai-compatible" ? "azure-api-key"
        : sdk === "gitlab-ai-provider" ? "gitlab-direct-access"
          : sdk === "watsonx-ai-provider" || sdk === "@jerome-benoit/sap-ai-provider-v2" ? "oauth" : "api-key";
  return { sdk, protocol: sdk === "@ai-sdk/openai" || sdk === "@ai-sdk/azure" ? "openai"
    : isOpenAIShapedSdk(sdk) ? "openai-compatible" : "native", auth,
    requiresMaxTokens: sdk === "@ai-sdk/anthropic" || sdk === "@ai-sdk/google-vertex/anthropic" };
}

export function loadProviderModule(sdk: ModelSdk, override?: ProviderModuleLoader): Promise<ProviderModule> {
  return (override ?? SDK_LOADERS[sdk])();
}
