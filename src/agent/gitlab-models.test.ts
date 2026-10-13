import { generateText } from "ai";
import { describe, expect, it, vi } from "vitest";
import { createModel } from "./model";

const newAliases = [
  { alias: "duo-chat-gpt-6-1-sol", provider: "openai", model: "gpt-6.1-sol" },
  { alias: "duo-chat-gpt-6-sol", provider: "openai", model: "gpt-6-sol" },
  { alias: "duo-chat-gpt-6-luna", provider: "openai", model: "gpt-6-luna" },
  { alias: "duo-chat-opus-5-5", provider: "anthropic", model: "claude-opus-5-5" },
  { alias: "duo-chat-sonnet-5-5", provider: "anthropic", model: "claude-sonnet-5-5" },
];

describe.each(newAliases)("GitLab alias $alias", ({ alias, provider, model: nativeModel }) => {
  it("sends the exact native model through the authenticated proxy", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const body = await request.clone().json();
      if (request.url === "https://gitlab.test/api/v4/ai/third_party_agents/direct_access") {
        expect(request.method).toBe("POST");
        expect(request.headers.get("authorization")).toBe("Bearer gitlab-token");
        expect(body).toEqual({ feature_flags: { DuoAgentPlatformNext: true } });
        return Response.json({ token: "proxy-token", headers: { "x-gitlab-unit-test": "yes" } });
      }
      expect(request.url).toBe(`https://gateway.test/ai/v1/proxy/${provider}/v1/${provider === "openai" ? "responses" : "messages"}`);
      expect(request.headers.get("authorization")).toBe("Bearer proxy-token");
      expect(request.headers.get("x-api-key")).toBeNull();
      expect(request.headers.get("x-gitlab-unit-test")).toBe("yes");
      expect(body.model).toBe(nativeModel);
      expect(JSON.stringify(body)).not.toContain(alias);
      return Response.json(provider === "openai"
        ? { id: "response", created_at: 1, model: nativeModel,
          output: [{ type: "message", id: "message", role: "assistant", content: [{ type: "output_text", text: "ok", annotations: [] }] }],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }
        : { type: "message", id: "message", role: "assistant", model: nativeModel,
          content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 } });
    });
    const model = await createModel({ sdk: "gitlab-ai-provider", baseURL: "", model: alias,
      providerSettings: { apiKey: "gitlab-token", instanceUrl: "https://gitlab.test", aiGatewayUrl: "https://gateway.test" } },
    undefined, undefined, { fetch });
    const result = await generateText({ model, prompt: "test" });
    expect(result.text).toBe("ok");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

it.each(["duo-chat-unknown", "toString", "__proto__"])("rejects unknown GitLab alias %s before authentication", async (alias) => {
  const fetch = vi.fn();
  await expect(createModel({ sdk: "gitlab-ai-provider", baseURL: "", model: alias,
    providerSettings: { apiKey: "gitlab-token" } }, undefined, undefined, { fetch }))
    .rejects.toThrow(`Unsupported GitLab Duo model: ${alias}`);
  expect(fetch).not.toHaveBeenCalled();
});
