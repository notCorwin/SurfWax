/**
 * GitLab Duo aliases mapped to the model IDs expected by its native proxy.
 * Catalog aliases: https://github.com/anomalyco/models.dev/tree/dev/providers/gitlab/models
 * Keep this dependency-free so sdk:check can detect new catalog aliases.
 */
export const GITLAB_MODELS: Record<string, { provider: "openai" | "anthropic"; model: string }> = {
  "duo-chat-fable-5-1": { provider: "anthropic", model: "claude-fable-5-1" },
  "duo-chat-fable-5": { provider: "anthropic", model: "claude-fable-5" },
  "duo-chat-opus-5-5": { provider: "anthropic", model: "claude-opus-5-5" },
  "duo-chat-opus-5": { provider: "anthropic", model: "claude-opus-5" },
  "duo-chat-opus-4-8": { provider: "anthropic", model: "claude-opus-4-8" },
  "duo-chat-opus-4-7": { provider: "anthropic", model: "claude-opus-4-7" },
  "duo-chat-opus-4-6": { provider: "anthropic", model: "claude-opus-4-6" },
  "duo-chat-sonnet-5-5": { provider: "anthropic", model: "claude-sonnet-5-5" },
  "duo-chat-sonnet-5": { provider: "anthropic", model: "claude-sonnet-5" },
  "duo-chat-sonnet-4-6": { provider: "anthropic", model: "claude-sonnet-4-6" },
  "duo-chat-opus-4-5": { provider: "anthropic", model: "claude-opus-4-5-20251101" },
  "duo-chat-sonnet-4-5": { provider: "anthropic", model: "claude-sonnet-4-5-20250929" },
  "duo-chat-haiku-4-5": { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
  "duo-chat-gpt-6-1-sol": { provider: "openai", model: "gpt-6.1-sol" },
  "duo-chat-gpt-6-sol": { provider: "openai", model: "gpt-6-sol" },
  "duo-chat-gpt-6-luna": { provider: "openai", model: "gpt-6-luna" },
  "duo-chat-gpt-6-astra": { provider: "openai", model: "gpt-6-astra" },
  "duo-chat-gpt-5-1": { provider: "openai", model: "gpt-5.1-2025-11-13" },
  "duo-chat-gpt-5-2": { provider: "openai", model: "gpt-5.2-2025-12-11" },
  "duo-chat-gpt-5-4": { provider: "openai", model: "gpt-5.4-2026-03-05" },
  "duo-chat-gpt-5-5": { provider: "openai", model: "gpt-5.5-2026-04-23" },
  "duo-chat-gpt-5-mini": { provider: "openai", model: "gpt-5-mini-2025-08-07" },
  "duo-chat-gpt-5-4-mini": { provider: "openai", model: "gpt-5.4-mini" },
  "duo-chat-gpt-5-4-nano": { provider: "openai", model: "gpt-5.4-nano" },
  "duo-chat-gpt-5-6-sol": { provider: "openai", model: "gpt-5.6-sol" },
  "duo-chat-gpt-5-6-terra": { provider: "openai", model: "gpt-5.6-terra" },
  "duo-chat-gpt-5-6-luna": { provider: "openai", model: "gpt-5.6-luna" },
  "duo-chat-gpt-5-codex": { provider: "openai", model: "gpt-5-codex" },
  "duo-chat-gpt-5-2-codex": { provider: "openai", model: "gpt-5.2-codex" },
  "duo-chat-gpt-5-3-codex": { provider: "openai", model: "gpt-5.3-codex" },
};
