import { createServer, type Server } from "node:http";

type Attempt = { reference: unknown; answer: unknown; accepted: boolean };

export interface DispatchFixture {
  origin: string;
  server: Server;
  prompt: string;
  evidence(): { reference: string; reviewVisits: number; attempts: Attempt[] };
}

/** The receipt is held by the test process, not by the page or the model. */
export function dispatchScore(evidence: ReturnType<DispatchFixture["evidence"]>): boolean {
  return evidence.reviewVisits > 0 && evidence.attempts.length === 1 &&
    evidence.attempts[0]!.accepted && evidence.attempts[0]!.reference === evidence.reference;
}

/** Open a cross-origin review window and respond to its native prompt. */
export async function dispatchFixture(seed: number): Promise<DispatchFixture> {
  const reference = `DSP-${seed}`;
  const code = `CONFIRM-${(Math.imul(seed, 7919) >>> 0).toString(36).toUpperCase()}`;
  let reviewVisits = 0;
  const attempts: Attempt[] = [];
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://fixture.local").pathname;
    if (request.method === "GET" && path === "/") {
      const address = server.address();
      if (!address || typeof address === "string") { response.writeHead(500).end(); return; }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><title>Dispatch</title><main><h1>Dispatch portal</h1><iframe title="Dispatch desk" src="http://localhost:${address.port}/desk" style="width:650px;height:300px"></iframe></main>`);
      return;
    }
    if (request.method === "GET" && path === "/desk") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><title>Dispatch desk</title><main><h1>Dispatch desk</h1><p>Reference: ${reference}</p><button id="review">Open dispatch review</button></main>
        <script>document.querySelector('#review').addEventListener('click', () => window.open('/review', '_blank'));</script>`);
      return;
    }
    if (request.method === "GET" && path === "/review") {
      reviewVisits++;
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><title>Dispatch review</title><main><h1>Dispatch review</h1><p>Reference: ${reference}</p><p>Confirmation code: <strong>${code}</strong></p><button id="dispatch">Confirm dispatch</button><output id="status" aria-live="polite">Not dispatched</output></main>
        <script>document.querySelector('#dispatch').addEventListener('click', async () => {
          const answer = window.prompt('Enter the confirmation code shown on this page');
          try {
            const response = await fetch('/dispatch', {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({reference:${JSON.stringify(reference)}, answer})});
            document.querySelector('#status').textContent = response.ok ? 'Dispatched' : 'Dispatch rejected';
          } catch { document.querySelector('#status').textContent = 'Dispatch failed'; }
        });</script>`);
      return;
    }
    if (request.method === "POST" && path === "/dispatch") {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
        const accepted = Object.keys(record).length === 2 && record.reference === reference && record.answer === code;
        attempts.push({ reference: record.reference ?? null, answer: record.answer ?? null, accepted });
        response.writeHead(accepted ? 201 : 400, { "content-type": "application/json" }).end(JSON.stringify({ status: accepted ? "dispatched" : "rejected" }));
      } catch {
        attempts.push({ reference: null, answer: null, accepted: false });
        response.writeHead(400).end();
      }
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Cannot start dispatch fixture");
  return {
    origin: `http://127.0.0.1:${address.port}`, server,
    prompt: `Dispatch ${reference} using its review window. Enter the confirmation code shown there when prompted.`,
    evidence: () => ({ reference, reviewVisits, attempts: structuredClone(attempts) }),
  };
}
