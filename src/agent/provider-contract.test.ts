import { ToolLoopAgent, tool } from "ai";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ModelConfig } from "../types";
import { createModel } from "./model";

type Contract = {
  name: string;
  config: ModelConfig;
  first: object;
  final: object;
  hasToolResult(body: any): boolean;
};

const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
const openAIFirst = { id: "one", object: "chat.completion", created: 1, model: "test", choices: [{ index: 0, message: { role: "assistant", content: null,
  tool_calls: [{ id: "call", type: "function", function: { name: "echo", arguments: '{"value":"ok"}' } }] }, finish_reason: "tool_calls" }], usage };
const openAIFinal = { id: "two", object: "chat.completion", created: 2, model: "test", choices: [{ index: 0, message: { role: "assistant", content: "done" }, finish_reason: "stop" }], usage };
const responsesUsage = { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } };
const responsesFirst = { id: "one", created_at: 1, model: "test", output: [{ type: "function_call", id: "fc", call_id: "call", name: "echo", arguments: '{"value":"ok"}' }], usage: responsesUsage };
const responsesFinal = { id: "two", created_at: 2, model: "test", output: [{ type: "message", id: "message", role: "assistant", content: [{ type: "output_text", text: "done", annotations: [] }] }], usage: responsesUsage };
const contracts: Contract[] = [
  {
    name: "OpenAI-compatible chat",
    config: { sdk: "@ai-sdk/openai-compatible", baseURL: "https://provider.test/v1", apiKey: "key", model: "test" },
    first: openAIFirst,
    final: openAIFinal,
    hasToolResult: (body) => body.messages.some((message: any) => message.role === "tool" && message.tool_call_id === "call"),
  },
  {
    name: "Anthropic Messages",
    config: { sdk: "@ai-sdk/anthropic", baseURL: "https://provider.test", apiKey: "key", model: "test" },
    first: { type: "message", id: "one", model: "test", content: [{ type: "tool_use", id: "call", name: "echo", input: { value: "ok" } }], stop_reason: "tool_use", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
    final: { type: "message", id: "two", model: "test", content: [{ type: "text", text: "done" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
    hasToolResult: (body) => body.messages.some((message: any) => message.content?.some((part: any) => part.type === "tool_result" && part.tool_use_id === "call")),
  },
  {
    name: "Google Gemini",
    config: { sdk: "@ai-sdk/google", baseURL: "https://provider.test/v1beta", apiKey: "key", model: "test" },
    first: { candidates: [{ content: { role: "model", parts: [{ functionCall: { id: "call", name: "echo", args: { value: "ok" } } }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } },
    final: { candidates: [{ content: { role: "model", parts: [{ text: "done" }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } },
    hasToolResult: (body) => body.contents.some((message: any) => message.parts?.some((part: any) => part.functionResponse?.id === "call")),
  },
];

describe.each(contracts)("$name tool contract", ({ config, first, final, hasToolResult }) => {
  it("round-trips a tool call and result before final text", async () => {
    const bodies: any[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      bodies.push(await request.clone().json());
      return new Response(JSON.stringify(bodies.length === 1 ? first : final), { headers: { "Content-Type": "application/json" } });
    });
    const model = await createModel(config, undefined, undefined, { fetch });
    const execute = vi.fn(async ({ value }: { value: string }) => ({ value }));
    const agent = new ToolLoopAgent({ model, tools: { echo: tool({ description: "Echo a value.", inputSchema: z.object({ value: z.string() }), execute }) } });
    const result = await agent.generate({ prompt: "echo ok" });
    expect(result.text).toBe("done");
    expect(execute).toHaveBeenCalledWith({ value: "ok" }, expect.any(Object));
    expect(bodies).toHaveLength(2);
    expect(hasToolResult(bodies[1])).toBe(true);
  }, 20_000);
});

const adapterConfigs: Array<{ name: string; config: ModelConfig }> = [
  { name: "Watsonx", config: { sdk: "watsonx-ai-provider", baseURL: "", model: "ibm/granite", providerSettings: { apiKey: "key", projectId: "project" } } },
  { name: "SAP", config: { sdk: "@jerome-benoit/sap-ai-provider-v2", baseURL: "", model: "test", providerSettings: {
    serviceKeyJson: JSON.stringify({ url: "https://auth.test", clientid: "client", clientsecret: "secret" }), deploymentUrl: "https://orchestration.test", resourceGroup: "rg",
  } } },
  { name: "GitLab", config: { sdk: "gitlab-ai-provider", baseURL: "", model: "duo-chat-gpt-5-1", providerSettings: {
    apiKey: "key", instanceUrl: "https://gitlab.test", aiGatewayUrl: "https://cloud.gitlab.test",
  } } },
];

describe.each(adapterConfigs)("$name adapter tool contract", ({ config, name }) => {
  it("preserves a tool result through its protocol adapter", async () => {
    const providerBodies: any[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (request.url.includes("iam.cloud.ibm.com") || request.url.endsWith("/oauth/token")) {
        return new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }), { headers: { "Content-Type": "application/json" } });
      }
      if (request.url.includes("direct_access")) {
        return new Response(JSON.stringify({ token: "token", headers: {} }), { headers: { "Content-Type": "application/json" } });
      }
      providerBodies.push(await request.clone().json());
      const response = name === "GitLab"
        ? providerBodies.length === 1 ? responsesFirst : responsesFinal
        : providerBodies.length === 1 ? openAIFirst : openAIFinal;
      return new Response(JSON.stringify(name === "SAP" ? { final_result: response } : response), { headers: { "Content-Type": "application/json" } });
    });
    const model = await createModel(config, undefined, undefined, { fetch });
    const execute = vi.fn(async ({ value }: { value: string }) => ({ value }));
    const agent = new ToolLoopAgent({ model, tools: { echo: tool({ description: "Echo a value.", inputSchema: z.object({ value: z.string() }), execute }) } });
    await expect(agent.generate({ prompt: "echo ok" })).resolves.toMatchObject({ text: "done" });
    expect(execute).toHaveBeenCalledOnce();
    expect(providerBodies).toHaveLength(2);
    expect(JSON.stringify(providerBodies[1])).toContain(name === "GitLab" ? '"type":"function_call_output"' : '"tool_call_id":"call"');
  }, 20_000);
});
