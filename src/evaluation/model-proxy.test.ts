// @vitest-environment node
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { businessScore, evidence, modelProxy, usageEvidence } from "../../e2e/evaluation/model-proxy";

const localFetch = globalThis.fetch;
const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))); });

describe("real model evaluation evidence", () => {
  it("scores fixture state independently and rejects duplicate or decoy submissions", () => {
    const order = { order: "ORDER-17", service: "express", confirmed: true };
    expect(businessScore([order], null, "ORDER-17", "express")).toBe(true);
    expect(businessScore([order, order], null, "ORDER-17", "express")).toBe(false);
    expect(businessScore([order], "1", "ORDER-17", "express")).toBe(false);
    expect(businessScore([{ ...order, confirmed: false }], null, "ORDER-17", "express")).toBe(false);
  });
  it("records schema and exact prefix without retaining prompt text", () => {
    const first = evidence(JSON.stringify({ tools: [{ name: "click" }], messages: [{ role: "system", content: "private prompt" }] }));
    const next = evidence(JSON.stringify({ tools: [{ name: "click" }], messages: [{ role: "system", content: "private prompt" }, { role: "user", content: "order" }] }), first.messages);
    const changed = evidence(JSON.stringify({ tools: [{ name: "click" }], messages: [{ role: "system", content: "other" }] }), first.messages);
    expect(next.evidence.previousMessagesArePrefix).toBe(true);
    expect(changed.evidence.previousMessagesArePrefix).toBe(false);
    expect(first.evidence.schemaHash).toBe(next.evidence.schemaHash);
    expect(JSON.stringify(next.evidence)).not.toContain("private prompt");
  });

  it("preserves real usage and represents unavailable counts as null", () => {
    expect(usageEvidence([{ type: "model.step.finished", usage: { inputTokens: { total: 30, cacheRead: 20 }, outputTokens: { total: 5, reasoning: 2 } } },
      { type: "model.step.finished" }])).toEqual([
      { inputTokens: 30, outputTokens: 5, totalTokens: null, cachedInputTokens: 20, reasoningTokens: 2 },
      { inputTokens: null, outputTokens: null, totalTokens: null, cachedInputTokens: null, reasoningTokens: null },
    ]);
  });

  it("forwards to a local mock using the supplied credential without recording it", async () => {
    vi.stubGlobal("fetch", localFetch);
    let authorization = "";
    const upstream = createServer(async (request, response) => {
      authorization = request.headers.authorization ?? "";
      for await (const _chunk of request) { /* consume */ }
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"usage":{"prompt_tokens":3}}');
    });
    servers.push(upstream);
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("missing address");
    const proxy = await modelProxy(`http://127.0.0.1:${address.port}/v1`, "fake-secret");
    servers.push(proxy.server);
    const unauthorized = await fetch(`${proxy.baseURL}/chat/completions`, { method: "POST" });
    expect(unauthorized.status).toBe(401);
    const response = await fetch(`${proxy.baseURL}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${proxy.token}` },
      body: JSON.stringify({ messages: [{ role: "user", content: "private message" }], tools: [] }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ usage: { prompt_tokens: 3 } });
    expect(authorization).toBe("Bearer fake-secret");
    expect(proxy.requests).toHaveLength(1);
    expect(proxy.requests[0]?.providerUsage?.inputTokens).toBe(3);
    expect(JSON.stringify(proxy.requests)).not.toContain("fake-secret");
    expect(JSON.stringify(proxy.requests)).not.toContain("private message");
  });
});
