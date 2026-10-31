import { createServer, type Server } from "node:http";

type Attempt = { id: unknown; revision: unknown; trusted: unknown; accepted: boolean };

export interface RollingFixture {
  origin: string;
  server: Server;
  prompt: string;
  evidence(): { expectedIds: string[]; completedIds: string[]; attempts: Attempt[] };
}

/** Every attempt matters: a wrong or repeated action cannot be repaired later. */
export function rollingScore(evidence: ReturnType<RollingFixture["evidence"]>): boolean {
  const expected = evidence.expectedIds;
  return expected.length === 30 && evidence.completedIds.length === expected.length
    && evidence.attempts.length === expected.length
    && evidence.completedIds.every((id, index) => id === expected[index])
    && evidence.attempts.every((attempt, index) => attempt.accepted && attempt.id === expected[index] && attempt.revision === index);
}

/** Page-reported trusted clicks distinguish ordinary synthetic clicks, not adversarial HTTP forgery. */
export function rollingInteractionScore(evidence: ReturnType<RollingFixture["evidence"]>): boolean {
  return rollingScore(evidence) && evidence.attempts.every((attempt) => attempt.trusted === true);
}

/** Five persistent DOM rows are reused while their business identities change. */
export async function rollingFixture(seed: number): Promise<RollingFixture> {
  const expectedIds = Array.from({ length: 30 }, (_, index) => `JOB-${seed}-${String(index + 1).padStart(2, "0")}`);
  let state = (seed ^ 0x9e3779b9) >>> 0;
  for (let index = expectedIds.length - 1; index > 0; index--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const other = state % (index + 1);
    [expectedIds[index], expectedIds[other]] = [expectedIds[other]!, expectedIds[index]!];
  }
  const attempts: Attempt[] = [];
  const completedIds: string[] = [];
  const rowsAt = (revision: number) => {
    if (revision >= expectedIds.length) return [];
    const next = expectedIds[revision]!;
    const slot = (seed + revision * 2) % 5;
    const waiting = expectedIds.slice(revision + 1, revision + 5);
    while (waiting.length < 4) waiting.push(`HOLD-${seed}-${waiting.length + 1}`);
    return Array.from({ length: 5 }, (_, index) => index === slot
      ? { id: next, label: "Next" }
      : { id: waiting[index < slot ? index : index - 1]!, label: "Waiting" });
  };
  const view = () => ({ revision: completedIds.length, total: expectedIds.length, complete: completedIds.length === expectedIds.length, rows: rowsAt(completedIds.length) });

  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://fixture.local").pathname;
    if (request.method === "GET" && path === "/") {
      const address = server.address();
      if (!address || typeof address === "string") { response.writeHead(500).end(); return; }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><title>Work portal</title><main><h1>Work portal</h1><iframe title="Rolling queue" src="http://localhost:${address.port}/queue" style="width:760px;height:520px"></iframe></main>`);
      return;
    }
    if (request.method === "GET" && path === "/queue") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><title>Rolling queue</title><main><h1>Rolling queue</h1>
        <p>Process the row marked Next, one at a time, until all jobs are complete.</p>
        <output id="progress" aria-live="polite">Loading</output><output id="notice" aria-live="polite"></output>
        <table><thead><tr><th>Job</th><th>Queue</th><th>Action</th></tr></thead><tbody>
        ${Array.from({ length: 5 }, () => '<tr hidden><td></td><td></td><td><button type="button">Process</button></td></tr>').join("")}
        </tbody></table></main><script>
        const rows = [...document.querySelectorAll('tbody tr')], progress = document.querySelector('#progress'), notice = document.querySelector('#notice');
        let revision = 0, busy = false;
        function render(view) {
          revision = view.revision;
          rows.forEach((row, index) => {
            const item = view.rows[index]; row.hidden = !item;
            if (!item) return;
            row.cells[0].textContent = item.id; row.cells[1].textContent = item.label;
            row.cells[1].style.fontWeight = item.label === 'Next' ? 'bold' : 'normal';
            const button = row.querySelector('button'); button.dataset.id = item.id; button.disabled = busy;
            row.setAttribute('data-next', String(item.label === 'Next'));
          });
          progress.textContent = view.complete ? 'Queue complete' : 'Completed ' + revision + ' of ' + view.total;
        }
        document.querySelector('tbody').addEventListener('click', async (event) => {
          const button = event.target.closest('button'); if (!button || busy) return;
          const id = button.dataset.id, current = revision; busy = true; rows.forEach(row => row.querySelector('button').disabled = true);
          try {
            const response = await fetch('/process', {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({id,revision:current,trusted:event.isTrusted})});
            const body = await response.json(); busy = false; render(body.view);
            notice.textContent = response.ok ? 'Processed ' + id : 'Rejected ' + id;
          } catch { busy = false; rows.forEach(row => row.querySelector('button').disabled = false); notice.textContent = 'Processing failed'; }
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
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const body = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
        const revision = completedIds.length;
        const keys = Object.keys(body).sort().join(",");
        const accepted = (keys === "id,revision" || keys === "id,revision,trusted" && typeof body.trusted === "boolean") && revision < expectedIds.length
          && body.id === expectedIds[revision] && body.revision === revision;
        attempts.push({ id: body.id ?? null, revision: body.revision ?? null, trusted: body.trusted ?? null, accepted });
        if (accepted) completedIds.push(expectedIds[revision]!);
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
  if (!address || typeof address === "string") throw new Error("Cannot start rolling queue fixture");
  return {
    origin: `http://127.0.0.1:${address.port}`, server,
    prompt: "In the rolling queue, process the row marked Next until all 30 jobs are complete. Do not process any other row.",
    evidence: () => ({ expectedIds: [...expectedIds], completedIds: [...completedIds], attempts: structuredClone(attempts) }),
  };
}
