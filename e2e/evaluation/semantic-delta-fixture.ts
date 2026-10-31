import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";

type Item = { id: string; next: boolean };
type Attempt = { id: unknown; revision: unknown; trusted: unknown; accepted: boolean };
export interface SemanticDeltaFixture {
  origin: string;
  server: Server;
  prompt: string;
  evidence(): { expectedIds: string[]; attempts: Attempt[]; completedIds: string[]; initialIds: string[]; remainingIds: string[]; longId: string };
}

/** All attempts count; an incorrect or stale action cannot be repaired. */
export function semanticDeltaScore(evidence: ReturnType<SemanticDeltaFixture["evidence"]>): boolean {
  return evidence.expectedIds.length === 12 && evidence.attempts.length === 12 && evidence.completedIds.length === 12
    && evidence.expectedIds.every((id, index) => evidence.completedIds[index] === id && evidence.attempts[index]?.accepted === true
      && evidence.attempts[index]?.id === id && evidence.attempts[index]?.revision === index);
}

/** Page-reported trusted clicks detect ordinary synthetic clicks, not forged requests. */
export function semanticDeltaInteractionScore(evidence: ReturnType<SemanticDeltaFixture["evidence"]>): boolean {
  return semanticDeltaScore(evidence) && evidence.attempts.every((attempt) => attempt.trusted === true);
}

/** A 120-row grid reuses and physically reorders the same DOM nodes every round. */
export async function semanticDeltaFixture(seed: number): Promise<SemanticDeltaFixture> {
  const hash = (text: string) => createHash("sha256").update(text).digest("hex");
  const initialIds = Array.from({ length: 120 }, (_, index) => `TASK-${hash(`${seed}:item:${index}`).slice(0, 12).toUpperCase()}`);
  const longId = initialIds[119]!;
  const expectedIds = initialIds.slice(0, 119).sort((a, b) => hash(`${seed}:queue:${a}`).localeCompare(hash(`${seed}:queue:${b}`))).slice(0, 12);
  const attempts: Attempt[] = [], completedIds: string[] = [];
  let ids = [...initialIds];
  const view = () => {
    const revision = completedIds.length;
    const sorted = [...ids].sort((a, b) => hash(`${seed}:revision:${revision}:${a}`).localeCompare(hash(`${seed}:revision:${revision}:${b}`)));
    return { revision, complete: revision === expectedIds.length,
      items: sorted.map((id): Item => ({ id, next: revision < expectedIds.length && id === expectedIds[revision] })) };
  };
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://fixture.local").pathname;
    if (request.method === "GET" && path === "/") {
      const address = server.address();
      if (!address || typeof address === "string") { response.writeHead(500).end(); return; }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(`<!doctype html><title>Semantic queue portal</title><main><h1>Semantic queue portal</h1><iframe title="Semantic queue" src="http://localhost:${address.port}/queue" style="width:1140px;height:530px"></iframe></main>`);
      return;
    }
    if (request.method === "GET" && path === "/queue") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(`<!doctype html><title>Semantic queue</title><style>ul{display:grid;grid-template-columns:repeat(10,minmax(0,1fr));gap:2px;padding:0;list-style:none}li{min-width:0}li button{display:block;width:100%;height:25px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}</style><main><h1>Semantic queue</h1>
        <p>Process the item marked Next until the queue is complete.</p><output id="progress" aria-live="polite">Loading</output><output id="notice" aria-live="polite"></output>
        <ul aria-label="Work items">${Array.from({ length: 120 }, () => '<li><button type="button"></button></li>').join("")}</ul></main><script>
          const list = document.querySelector('ul'), progress = document.querySelector('#progress'), notice = document.querySelector('#notice');
          const longId = ${JSON.stringify(longId)}; let revision = 0, busy = false;
          function render(view) {
            revision = view.revision;
            const nodes = [...list.children], shift = view.revision % nodes.length;
            list.append(...nodes.slice(shift), ...nodes.slice(0, shift));
            [...list.children].forEach((row, index) => {
              const item = view.items[index], button = row.querySelector('button');
              const label = (item.next ? 'Next ' : 'Waiting ') + item.id;
              button.textContent = label; button.setAttribute('aria-label', label + (item.id === longId ? ' ' + '海🌊'.repeat(2500) : ''));
              button.dataset.id = item.id; button.dataset.revision = String(view.revision); button.disabled = busy || view.complete;
            });
            progress.textContent = view.complete ? 'Queue complete' : 'Completed ' + revision + ' of 12';
          }
          list.addEventListener('click', async event => {
            const button = event.target.closest('button'); if (!button || busy) return;
            const id = button.dataset.id, current = Number(button.dataset.revision); busy = true;
            for (const item of list.querySelectorAll('button')) item.disabled = true;
            try {
              const response = await fetch('/process', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id,revision:current,trusted:event.isTrusted})});
              const body = await response.json(); busy = false; render(body.view);
              notice.textContent = response.ok ? 'Processed ' + id : 'Rejected ' + id;
            } catch { busy = false; for (const item of list.querySelectorAll('button')) item.disabled = false; notice.textContent = 'Request failed'; }
          });
          fetch('/current', {cache:'no-store'}).then(response => response.json()).then(render);
        </script>`);
      return;
    }
    if (request.method === "GET" && path === "/current") {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(view()));
      return;
    }
    if (request.method === "POST" && path === "/process") {
      try {
        const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const body = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
        const revision = completedIds.length;
        const accepted = Object.keys(body).sort().join(",") === "id,revision,trusted" && typeof body.trusted === "boolean"
          && revision < expectedIds.length && body.id === expectedIds[revision] && body.revision === revision;
        attempts.push({ id: body.id ?? null, revision: body.revision ?? null, trusted: body.trusted ?? null, accepted });
        if (accepted) {
          completedIds.push(expectedIds[revision]!);
          ids = [...ids.filter((id) => id !== expectedIds[revision]), `NEW-${hash(`${seed}:new:${revision}`).slice(0, 12).toUpperCase()}`];
        }
        response.writeHead(accepted ? 200 : 409, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify({ view: view() }));
      } catch {
        attempts.push({ id: null, revision: null, trusted: null, accepted: false });
        response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ view: view() }));
      }
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Cannot start semantic queue fixture");
  return { origin: `http://127.0.0.1:${address.port}`, server,
    prompt: "Process the item marked Next, one at a time, until all 12 items are complete. Do not process Waiting items.",
    evidence: () => structuredClone({ expectedIds, attempts, completedIds, initialIds, remainingIds: ids, longId }) };
}
