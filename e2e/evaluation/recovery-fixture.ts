import { createServer, type Server } from "node:http";

type Attempt = { body: unknown; accepted: boolean; responseLost: boolean };
type StatusCheck = { reference: string; committed: boolean; afterResponseLost: boolean };

export interface RecoveryFixture {
  origin: string;
  server: Server;
  prompt: string;
  evidence(): { expectedReference: string; committedReference: string | null; attempts: Attempt[]; checks: StatusCheck[]; decoyClicks: number };
}

/** A successful outcome requires the committed write and a subsequent status read. */
export function recoveryScore(evidence: ReturnType<RecoveryFixture["evidence"]>): boolean {
  if (evidence.decoyClicks !== 0 || evidence.attempts.length !== 1 || evidence.committedReference !== evidence.expectedReference) return false;
  const attempt = evidence.attempts[0]!;
  if (!attempt.accepted || !attempt.responseLost || !attempt.body || typeof attempt.body !== "object" || Array.isArray(attempt.body)) return false;
  const body = attempt.body as Record<string, unknown>;
  return Object.keys(body).join(",") === "reference" && body.reference === evidence.expectedReference
    && evidence.checks.some((check) => check.committed && check.afterResponseLost && check.reference === evidence.expectedReference);
}

/** The first valid write commits, then loses its response. All attempts are retained outside the page. */
export async function recoveryFixture(seed: number): Promise<RecoveryFixture> {
  const expectedReference = `TX-${seed}-${(Math.imul(seed, 7919) >>> 0).toString(36).toUpperCase()}`;
  let committedReference: string | null = null;
  let responseLost = false;
  const attempts: Attempt[] = [];
  const checks: StatusCheck[] = [];
  let decoyClicks = 0;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture.local");
    if (request.method === "GET" && url.pathname === "/") {
      const address = server.address();
      if (!address || typeof address === "string") { response.writeHead(500).end(); return; }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><title>Transaction portal</title><main><h1>Transaction portal</h1><iframe title="Transaction desk" src="http://localhost:${address.port}/desk" style="width:720px;height:420px"></iframe><button id="decoy">Submit transaction</button></main><script>document.querySelector('#decoy').onclick = () => { void fetch('/decoy', {method:'POST'}); };</script>`);
      return;
    }
    if (request.method === "GET" && url.pathname === "/desk") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><title>Transaction desk</title><main><h1>Transaction desk</h1><p>Submit each reference only once. If confirmation is unavailable, check status before deciding whether another submission is needed.</p><label>Transaction reference <input id="reference"></label><button id="submit">Submit transaction</button><button id="check">Check status</button><output id="status" aria-live="polite">Not submitted</output></main><script>
        const reference = document.querySelector('#reference'), status = document.querySelector('#status');
        document.querySelector('#submit').onclick = async () => {
          try {
            const response = await fetch('/submit', {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({reference:reference.value})});
            const result = await response.json();
            status.textContent = response.ok && result.status === 'completed' ? 'Submitted' : 'Submission rejected';
          } catch { status.textContent = 'Confirmation unavailable. Check status before retrying.'; }
        };
        document.querySelector('#check').onclick = async () => {
          try {
            const response = await fetch('/status?reference=' + encodeURIComponent(reference.value), {cache:'no-store'});
            const result = await response.json();
            status.textContent = result.completed ? 'Completed ' + reference.value : 'Not found ' + reference.value;
          } catch { status.textContent = 'Status unavailable'; }
        };
      </script>`);
      return;
    }
    if (request.method === "POST" && url.pathname === "/decoy") { decoyClicks++; response.writeHead(204).end(); return; }
    if (request.method === "GET" && url.pathname === "/status") {
      const reference = url.searchParams.get("reference") ?? "";
      const committed = committedReference !== null && committedReference === reference;
      checks.push({ reference, committed, afterResponseLost: responseLost });
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify({ completed: committed }));
      return;
    }
    if (request.method === "POST" && url.pathname === "/submit") {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const record = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
        const valid = Object.keys(record).join(",") === "reference" && record.reference === expectedReference;
        const accepted = valid && committedReference === null;
        const attempt: Attempt = { body, accepted, responseLost: false };
        attempts.push(attempt);
        if (!accepted) { response.writeHead(valid ? 409 : 400, { "content-type": "application/json" }).end('{"status":"rejected"}'); return; }
        committedReference = expectedReference;
        // Send incomplete response headers/body before disconnecting. This stops
        // Chromium transparently retrying a POST that received no response at all.
        response.writeHead(201, { "content-type": "application/json", "content-length": "100" });
        response.write('{"status":', () => { response.destroy(); responseLost = true; attempt.responseLost = true; });
      } catch {
        attempts.push({ body: null, accepted: false, responseLost: false });
        if (!response.destroyed) response.writeHead(400).end();
      }
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Cannot start recovery fixture");
  return {
    origin: `http://127.0.0.1:${address.port}`, server,
    prompt: `Submit transaction ${expectedReference} exactly once and verify that it completed.`,
    evidence: () => ({ expectedReference, committedReference, attempts: structuredClone(attempts), checks: structuredClone(checks), decoyClicks }),
  };
}
