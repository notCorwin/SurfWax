import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { ModelConfig } from "../types";
import type { ModelLimit } from "../agent/model-limits";
import { useModelLimit } from "./useModelLimit";

const lookup = vi.hoisted(() => vi.fn());
vi.mock("../agent/model-limits", async (importOriginal) => ({
  ...await importOriginal<typeof import("../agent/model-limits")>(),
  resolveModelLimit: lookup,
}));

it("ignores late results when the provider or effective endpoint changes", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  lookup.mockReset();
  const pending: Array<(value: ModelLimit) => void> = [];
  lookup.mockImplementation(() => new Promise<ModelLimit>((resolve) => pending.push(resolve)));
  const config: ModelConfig = { providerId: "custom", sdk: "@ai-sdk/openai-compatible", baseURL: "https://example.test/v1", model: "shared", providerSettings: { apiKey: "test" } };
  const container = document.createElement("div"), root = createRoot(container);
  const View = ({ value }: { value: ModelConfig }) => createElement("span", null, useModelLimit(value, true)?.context ?? "pending");
  const render = (value: ModelConfig) => act(() => root.render(createElement(View, { value })));
  try {
    await render(config);
    await render({ ...config, providerId: "another" });
    expect(pending).toHaveLength(2);
    await act(() => pending[1]!({ provider: "another", model: "shared", context: 200, source: "models.dev" }));
    expect(container.textContent).toBe("200");
    await act(() => pending[0]!({ provider: "custom", model: "shared", context: 100, source: "estimated" }));
    expect(container.textContent).toBe("200");

    await render({ ...config, providerId: "another", baseURLOverride: "https://proxy.test/v1" });
    expect(container.textContent).toBe("pending");
    expect(pending).toHaveLength(3);
    await act(() => pending[2]!({ provider: "another", model: "shared", context: 300, source: "models.dev" }));
    expect(container.textContent).toBe("300");
  } finally { await act(() => root.unmount()); }
});

it("does not resolve a model whose SDK is unsupported", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  lookup.mockReset();
  const config: ModelConfig = { providerId: "provider", sdk: "@ai-sdk/openai-compatible", baseURL: "https://example.test/v1", model: "model", providerSettings: { apiKey: "test" }, modelProvider: { npm: "unsupported-sdk" } };
  const container = document.createElement("div"), root = createRoot(container);
  const View = () => createElement("span", null, useModelLimit(config, true)?.context ?? "unavailable");
  try {
    await act(() => root.render(createElement(View)));
    expect(container.textContent).toBe("unavailable");
    expect(lookup).not.toHaveBeenCalled();
  } finally { await act(() => root.unmount()); }
});
