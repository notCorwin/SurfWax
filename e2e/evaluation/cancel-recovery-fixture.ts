import { createServer, type Server } from "node:http";

type Attempt = { reference: unknown; accepted: boolean; order: number };
type Check = { reference: string; committed: boolean; responseHeld: boolean; order: number };

export interface CancelRecoveryFixture {
  origin: string;
  server: Server;
  prompt: string;
  committed: Promise<void>;
  release(): void;
  evidence(): { expectedReference: string; committedReference: string | null; attempts: Attempt[]; checks: Check[]; decoyClicks: number };
}

/** Business evidence cannot establish whether a browser task was actually cancelled. */
export function cancelRecoveryScore(evidence: ReturnType<CancelRecoveryFixture["evidence"]>): boolean {
  if (evidence.decoyClicks || evidence.attempts.length !== 1 || evidence.checks.length !== 1 || evidence.committedReference !== evidence.expectedReference) return false;
  const attempt = evidence.attempts[0]!, check = evidence.checks[0]!;
  return attempt.accepted && attempt.reference === evidence.expectedReference
    && check.reference === evidence.expectedReference && check.committed && check.responseHeld && check.order > attempt.order;
}

/** Commit immediately, but keep the original HTTP response open until the test releases it. */
export async function cancelRecoveryFixture(seed: number): Promise<CancelRecoveryFixture> {
  if (!Number.isSafeInteger(seed)) throw new Error("Invalid recovery seed");
  const expectedReference = `REC-${seed}-${(Math.imul(seed, 7919) >>> 0).toString(36).toUpperCase()}`;
  let committedReference: string | null = null, decoyClicks = 0, order = 0, released = false;
  const attempts: Attempt[] = [], checks: Check[] = [];
  let committedResolve!: () => void, releaseResolve!: () => void;
  const committed = new Promise<void>((resolve) => { committedResolve = resolve; });
  const responseRelease = new Promise<void>((resolve) => { releaseResolve = resolve; });
  const release = () => { if (!released) { released = true; releaseResolve(); } };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture.local");
    if (request.method === "GET" && url.pathname === "/") {
      const address = server.address();
      if (!address || typeof address === "string") { response.writeHead(500).end(); return; }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(`<!doctype html><title>Recovery portal</title><main><h1>Recovery portal</h1><iframe title="Recovery desk" src="http://localhost:${address.port}/desk" style="width:720px;height:350px"></iframe><button id="decoy">Submit transaction</button></main><script>document.querySelector('#decoy').onclick=()=>{void fetch('/decoy',{method:'POST'})}</script>`);
      return;
    }
    if (request.method === "GET" && url.pathname === "/desk") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(`<!doctype html><title>Recovery desk</title><main><h1>Recovery desk</h1><p>Submit the reference once; check its status if confirmation is delayed.</p><label>Transaction reference <input id="reference"></label><button id="submit">Submit transaction</button><button id="check">Check status</button><output id="submit-status" aria-live="polite">Not submitted</output><output id="check-status" aria-live="polite">Not checked</output></main><script>
        const input=document.querySelector('#reference'), submitted=document.querySelector('#submit-status'), checked=document.querySelector('#check-status');
        document.querySelector('#submit').onclick=async()=>{ submitted.textContent='Waiting for confirmation'; try { const result=await fetch('/submit',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({reference:input.value})}); const body=await result.json(); submitted.textContent=result.ok&&body.status==='completed'?'Submitted':'Rejected'; } catch { submitted.textContent='Confirmation unavailable'; } };
        document.querySelector('#check').onclick=async()=>{try { const result=await fetch('/status?reference='+encodeURIComponent(input.value),{cache:'no-store'});const data=await result.json(); checked.textContent=data.completed?'Completed '+input.value:'Not found '+input.value; } catch { checked.textContent='Status unavailable'; }};
      </script>`);
      return;
    }
    if (request.method === "POST" && url.pathname === "/decoy") { decoyClicks++; response.writeHead(204).end(); return; }
    if (request.method === "GET" && url.pathname === "/status") {
      const reference = url.searchParams.get("reference") ?? "";
      const found = committedReference !== null && committedReference === reference;
      checks.push({ reference, committed: found, responseHeld: !released, order: ++order });
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify({ completed: found }));
      return;
    }
    if (request.method === "POST" && url.pathname === "/submit") {
      try {
        const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
        const valid = Object.keys(body).join(",") === "reference" && body.reference === expectedReference;
        const accepted = valid && committedReference === null;
        attempts.push({ reference: body.reference ?? null, accepted, order: ++order });
        if (!accepted) { response.writeHead(valid ? 409 : 400, { "content-type": "application/json" }).end('{"status":"rejected"}'); return; }
        committedReference = expectedReference;
        response.writeHead(201, { "content-type": "application/json", "cache-control": "no-store" });
        response.flushHeaders();
        committedResolve();
        await responseRelease;
        if (!response.destroyed) response.end('{"status":"completed"}');
      } catch {
        attempts.push({ reference: null, accepted: false, order: ++order });
        if (!response.destroyed) response.writeHead(400).end();
      }
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Cannot start recovery fixture");
  return { origin: `http://127.0.0.1:${address.port}`, server, committed, release,
    prompt: `Submit transaction ${expectedReference} once and check its status if confirmation is delayed.`,
    evidence: () => ({ expectedReference, committedReference, attempts: structuredClone(attempts), checks: structuredClone(checks), decoyClicks }) };
}
