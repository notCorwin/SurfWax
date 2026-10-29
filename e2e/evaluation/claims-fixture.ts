import { createServer, type Server } from "node:http";

type Claim = { id: string; region: "APAC" | "EMEA" | "AMER"; amount: number; status: "pending" | "paid" | "approved"; revision: number };
type Attempt = { id: unknown; revision: unknown; accepted: boolean };

export interface ClaimsFixture {
  origin: string;
  server: Server;
  prompt: string;
  evidence(): { claims: Claim[]; attempts: Attempt[]; expectedIds: string[] };
}

/** Fixed boundary cases, reordered by seed, so a model must inspect every page. */
function claimsForSeed(seed: number): Claim[] {
  const values: Array<Pick<Claim, "region" | "amount" | "status">> = [
    { region: "APAC", amount: 500, status: "pending" },
    { region: "APAC", amount: 100 + seed % 300, status: "pending" },
    { region: "APAC", amount: 499, status: "pending" },
    { region: "APAC", amount: 501, status: "pending" },
    { region: "APAC", amount: 300, status: "paid" },
    { region: "EMEA", amount: 250, status: "pending" },
    { region: "AMER", amount: 500, status: "pending" },
    { region: "EMEA", amount: 700, status: "paid" },
    { region: "APAC", amount: 900, status: "pending" },
  ];
  const claims = values.map((value, index) => ({ ...value, id: `CLM-${seed}-${index + 1}`, revision: 1 }));
  let state = (seed ^ 0x9e3779b9) >>> 0;
  const shuffle = <T>(items: T[]): T[] => {
    for (let index = items.length - 1; index > 0; index--) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      const other = state % (index + 1);
      [items[index], items[other]] = [items[other]!, items[index]!];
    }
    return items;
  };
  const eligible = shuffle(claims.slice(0, 3));
  const other = shuffle(claims.slice(3));
  return shuffle(eligible.map((claim, index) => shuffle([claim, other[index * 2]!, other[index * 2 + 1]!]))).flat();
}

export function claimsScore(evidence: ReturnType<ClaimsFixture["evidence"]>): boolean {
  const expected = [...evidence.expectedIds].sort();
  const attempts = evidence.attempts;
  if (attempts.length !== expected.length || attempts.some((attempt) => !attempt.accepted || typeof attempt.id !== "string")) return false;
  if (JSON.stringify(attempts.map((attempt) => attempt.id).sort()) !== JSON.stringify(expected)) return false;
  return evidence.claims.every((claim) => expected.includes(claim.id) ? claim.status === "approved" : claim.status !== "approved");
}

/** The business ledger is private to the test process; the page only has claim and approval endpoints. */
export async function claimsFixture(seed: number): Promise<ClaimsFixture> {
  const claims = claimsForSeed(seed);
  const expectedIds = claims.filter((claim) => claim.region === "APAC" && claim.amount <= 500 && claim.status === "pending").map((claim) => claim.id);
  const attempts: Attempt[] = [];
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://fixture.local").pathname;
    if (request.method === "GET" && path === "/") {
      const address = server.address();
      if (!address || typeof address === "string") { response.writeHead(500).end(); return; }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><title>Claims</title><main><h1>Claims review</h1><iframe title="Claims queue" src="http://localhost:${address.port}/queue" style="width:850px;height:520px"></iframe></main>`);
      return;
    }
    if (request.method === "GET" && path === "/queue") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><title>Claims queue</title><main><h1>Claims queue</h1>
        <table><thead><tr><th>Claim</th><th>Region</th><th>Amount USD</th><th>Status</th><th>Action</th></tr></thead><tbody>
        ${Array.from({ length: 3 }, () => '<tr><td></td><td></td><td></td><td></td><td><button type="button">Approve</button></td></tr>').join("")}
        </tbody></table><button id="previous">Previous page</button><span id="page"></span><button id="next">Next page</button><output id="notice" aria-live="polite"></output></main>
        <script>
          let claims = [], page = 0; const rows = [...document.querySelectorAll('tbody tr')];
          function render() {
            rows.forEach((row, index) => {
              const claim = claims[page * rows.length + index]; row.hidden = !claim;
              if (!claim) return;
              [...row.cells].slice(0,4).forEach((cell, i) => cell.textContent = [claim.id, claim.region, '$' + claim.amount, claim.status][i]);
              const button = row.querySelector('button'); button.hidden = claim.status !== 'pending';
              button.dataset.id = claim.id; button.dataset.revision = String(claim.revision); button.setAttribute('aria-label', 'Approve ' + claim.id);
            });
            document.querySelector('#page').textContent = 'Page ' + (page + 1) + ' of ' + Math.max(1, Math.ceil(claims.length / rows.length));
            document.querySelector('#previous').disabled = page === 0;
            document.querySelector('#next').disabled = (page + 1) * rows.length >= claims.length;
          }
          document.querySelector('#previous').onclick = () => { if (page > 0) { page--; render(); } };
          document.querySelector('#next').onclick = () => { if ((page + 1) * rows.length < claims.length) { page++; render(); } };
          document.querySelector('tbody').addEventListener('click', async (event) => {
            const button = event.target.closest('button'); if (!button || button.disabled) return;
            const id = button.dataset.id, revision = Number(button.dataset.revision); button.disabled = true;
            try {
              const response = await fetch('/approve', {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({id,revision})});
              const body = await response.json();
              if (response.ok) { const index = claims.findIndex((claim) => claim.id === id); if (index >= 0) claims[index] = body; }
              document.querySelector('#notice').textContent = response.ok ? 'Approved ' + id : 'Approval failed for ' + id;
            } catch { document.querySelector('#notice').textContent = 'Approval failed for ' + id; }
            finally { button.disabled = false; render(); }
          });
          fetch('/claims').then(response => response.json()).then(value => { claims = value; render(); });
        </script>`);
      return;
    }
    if (request.method === "GET" && path === "/claims") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(claims));
      return;
    }
    if (request.method === "POST" && path === "/approve") {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id?: unknown; revision?: unknown };
        const claim = claims.find((item) => item.id === body?.id);
        const accepted = Boolean(claim && claim.status === "pending" && claim.revision === body?.revision);
        attempts.push({ id: body?.id, revision: body?.revision, accepted });
        if (!accepted) { response.writeHead(409, { "content-type": "application/json" }).end('{"error":"stale or invalid claim"}'); return; }
        claim!.status = "approved"; claim!.revision++;
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(claim));
      } catch {
        attempts.push({ id: null, revision: null, accepted: false });
        response.writeHead(400, { "content-type": "application/json" }).end('{"error":"invalid request"}');
      }
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Cannot start claims fixture");
  return { origin: `http://127.0.0.1:${address.port}`, server,
    prompt: "Approve every pending APAC claim with an amount of $500 or less, including across all pages. Leave all other claims unchanged.",
    evidence: () => ({ claims: structuredClone(claims), attempts: structuredClone(attempts), expectedIds: [...expectedIds] }) };
}
