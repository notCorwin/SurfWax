import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { Readable } from "node:stream";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export interface RequestEvidence {
  kind: "agent" | "auxiliary";
  bytes: number;
  schemaHash: string | null;
  schemaBytes: number | null;
  systemHash: string;
  previousMessagesArePrefix: boolean | null;
  responseStatus: number | null;
  responseComplete: boolean;
  providerUsage: { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null; cachedInputTokens: number | null; reasoningTokens: number | null } | null;
}

/** Only derived evidence survives this call; prompt and tool arguments are never recorded. */
export function evidence(body: string, previousMessages?: unknown[]): { evidence: RequestEvidence; messages: unknown[] } {
  const request = JSON.parse(body);
  const messages = Array.isArray(request.messages) ? request.messages : [];
  const system = messages.filter((message: any) => message?.role === "system" || message?.role === "developer");
  const schema = Array.isArray(request.tools) ? request.tools : null;
  return { evidence: {
    kind: schema ? "agent" : "auxiliary", bytes: Buffer.byteLength(body), schemaHash: schema ? digest(schema) : null,
    schemaBytes: schema ? Buffer.byteLength(JSON.stringify(schema)) : null,
    systemHash: digest(system),
    previousMessagesArePrefix: schema && previousMessages ? previousMessages.length <= messages.length &&
      previousMessages.every((message, index) => digest(message) === digest(messages[index])) : null,
    responseStatus: null, responseComplete: false, providerUsage: null,
  }, messages };
}

function responseUsage(response: any): RequestEvidence["providerUsage"] {
  const usage = response?.usage;
  if (!usage || typeof usage !== "object") return null;
  const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;
  return { inputTokens: number(usage.prompt_tokens), outputTokens: number(usage.completion_tokens), totalTokens: number(usage.total_tokens),
    cachedInputTokens: number(usage.prompt_tokens_details?.cached_tokens), reasoningTokens: number(usage.completion_tokens_details?.reasoning_tokens) };
}

/** A loopback-only forwarder: credentials and complete bodies are never logged or persisted. */
export async function modelProxy(upstreamBase: string, key: string): Promise<{ baseURL: string; token: string; requests: RequestEvidence[]; server: Server }> {
  const upstream = new URL(upstreamBase);
  if (!["http:", "https:"].includes(upstream.protocol) || upstream.username || upstream.password || upstream.search || upstream.hash) {
    throw new Error("Invalid evaluation base URL");
  }
  const requests: RequestEvidence[] = [];
  const token = randomUUID();
  let previous: unknown[] | undefined;
  const server = createServer(async (req, res) => {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "authorization, content-type");
    res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") { res.writeHead(204).end(); return; }
    if (req.method === "GET" && req.url === "/v1/models") { res.writeHead(200, { "content-type": "application/json" }).end('{"data":[]}'); return; }
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") { res.writeHead(404).end(); return; }
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401).end(); return; }
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString("utf8");
      const measured = evidence(body, previous);
      requests.push(measured.evidence);
      if (measured.evidence.kind === "agent") previous = measured.messages;
      const destination = new URL(`${upstream.pathname.replace(/\/$/, "")}/chat/completions`, upstream.origin);
      const response = await fetch(destination, { method: "POST", redirect: "manual", headers: {
        authorization: `Bearer ${key}`, "content-type": "application/json",
      }, body });
      measured.evidence.responseStatus = response.status;
      res.writeHead(response.status, { "content-type": response.headers.get("content-type") ?? "application/json" });
      if (response.body) {
        const stream = Readable.fromWeb(response.body as any);
        const sse = response.headers.get("content-type")?.includes("text/event-stream");
        let buffer = "";
        const inspect = (value: string) => { try { measured.evidence.providerUsage = responseUsage(JSON.parse(value)) ?? measured.evidence.providerUsage; } catch { /* partial or non-JSON */ } };
        stream.on("data", (chunk: Buffer) => {
          buffer += chunk.toString("utf8");
          if (sse) {
            const lines = buffer.split("\n"); buffer = lines.pop() ?? "";
            for (const line of lines) if (line.startsWith("data:")) inspect(line.slice(5).trim());
            if (buffer.length > 2_000_000) buffer = "";
          } else if (buffer.length > 2_000_000) buffer = "";
        });
        stream.on("end", () => { if (!sse) inspect(buffer); else if (buffer.startsWith("data:")) inspect(buffer.slice(5).trim()); measured.evidence.responseComplete = true; });
        stream.on("error", () => res.destroy());
        stream.pipe(res);
      } else { measured.evidence.responseComplete = true; res.end(); }
    } catch { if (!res.headersSent) res.writeHead(502); res.end(); }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Cannot start evaluation proxy");
  return { baseURL: `http://127.0.0.1:${address.port}/v1`, token, requests, server };
}

export function usageEvidence(events: any[]) {
  return events.filter((event) => event.type === "model.step.finished").map((event) => {
    const usage = event.usage ?? {};
    const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;
    return { inputTokens: number(usage.inputTokens?.total ?? usage.inputTokens), outputTokens: number(usage.outputTokens?.total ?? usage.outputTokens),
      totalTokens: number(usage.totalTokens), cachedInputTokens: number(usage.inputTokens?.cacheRead ?? usage.cachedInputTokens),
      reasoningTokens: number(usage.outputTokens?.reasoning ?? usage.reasoningTokens) };
  });
}
