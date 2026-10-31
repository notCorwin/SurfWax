import { createServer, type Server } from "node:http";

type Submission = { sequence: string[]; reference: string; confirmed: boolean };
type Attempt = { body: unknown; accepted: boolean };

export interface SequenceFixture {
  origin: string;
  server: Server;
  prompt: string;
  evidence(): { attempts: Attempt[]; decoyClicks: number; expected: Submission };
}

/** The judge checks the complete external ledger, including rejected and duplicate attempts. */
export function sequenceScore(evidence: ReturnType<SequenceFixture["evidence"]>): boolean {
  if (evidence.decoyClicks !== 0 || evidence.attempts.length !== 1) return false;
  const attempt = evidence.attempts[0]!;
  if (!attempt.accepted || !attempt.body || typeof attempt.body !== "object" || Array.isArray(attempt.body)) return false;
  const body = attempt.body as Record<string, unknown>;
  return Object.keys(body).sort().join(",") === "confirmed,reference,sequence"
    && body.reference === evidence.expected.reference && body.confirmed === true
    && Array.isArray(body.sequence) && JSON.stringify(body.sequence) === JSON.stringify(evidence.expected.sequence);
}

/** Nested cross-origin frames and a shadow-root keyboard list whose nodes are replaced after every move. */
export async function sequenceFixture(seed: number): Promise<SequenceFixture> {
  const names = ["Coral", "Kelp", "Drift", "Tide", "Reef"];
  let state = (seed ^ 0xa511e9b3) >>> 0;
  const shuffle = (items: string[]) => {
    const result = [...items];
    for (let i = result.length - 1; i > 0; i--) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      const j = state % (i + 1);
      [result[i], result[j]] = [result[j]!, result[i]!];
    }
    return result;
  };
  const expected: Submission = { sequence: shuffle(names), reference: `DSP-${seed}-A/7`, confirmed: true };
  let initial = shuffle(names);
  if (JSON.stringify(initial) === JSON.stringify(expected.sequence)) initial = [...initial.slice(1), initial[0]!];
  const attempts: Attempt[] = [];
  let decoyClicks = 0;
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://fixture.local").pathname;
    if (request.method === "GET" && path === "/") {
      const address = server.address();
      if (!address || typeof address === "string") { response.writeHead(500).end(); return; }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><title>Dispatch</title><main><h1>Dispatch center</h1><iframe title="Dispatch workspace" src="http://localhost:${address.port}/workspace" style="width:850px;height:620px"></iframe><button id="decoy">Send dispatch</button></main><script>document.querySelector('#decoy').onclick = () => { void fetch('/decoy', {method:'POST'}); };</script>`);
      return;
    }
    if (request.method === "GET" && path === "/workspace") {
      const address = server.address();
      if (!address || typeof address === "string") { response.writeHead(500).end(); return; }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><title>Workspace</title><main><h1>Dispatch workspace</h1><iframe title="Sequence editor" src="http://127.0.0.1:${address.port}/editor" style="width:760px;height:540px"></iframe></main>`);
      return;
    }
    if (request.method === "GET" && path === "/editor") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><title>Sequence editor</title><dispatch-editor></dispatch-editor><script>
        class DispatchEditor extends HTMLElement {
          connectedCallback() {
            const root = this.attachShadow({mode:'open'});
            root.innerHTML = '<main><h1>Sequence editor</h1><p>Focus a shipment and use Arrow Up or Arrow Down to change its position.</p><ol aria-label="Shipment order"></ol><label>Dispatch reference <input></label><label><input type="checkbox"> Confirm dispatch</label><button type="button">Send dispatch</button><output aria-live="polite">Not sent</output></main>';
            let sequence = ${JSON.stringify(initial)};
            const list = root.querySelector('ol'), output = root.querySelector('output');
            const render = (focusName) => {
              list.replaceChildren(...sequence.map((name) => {
                const li = document.createElement('li'), button = document.createElement('button');
                button.type = 'button'; button.textContent = name; button.setAttribute('aria-label', name);
                button.addEventListener('keydown', (event) => {
                  if (!['ArrowUp','ArrowDown'].includes(event.key)) return;
                  event.preventDefault(); const index = sequence.indexOf(name), next = index + (event.key === 'ArrowUp' ? -1 : 1);
                  if (next < 0 || next >= sequence.length) return;
                  [sequence[index],sequence[next]] = [sequence[next],sequence[index]]; render(name);
                });
                li.append(button); return li;
              }));
              if (focusName) [...list.querySelectorAll('button')].find((button) => button.textContent === focusName)?.focus();
            };
            render();
            root.querySelector('main > button').onclick = async () => {
              const body = {sequence, reference:root.querySelector('input:not([type=checkbox])').value, confirmed:root.querySelector('input[type=checkbox]').checked};
              try { const response = await fetch('/dispatch', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}); output.textContent = response.ok ? 'Dispatch sent' : 'Dispatch rejected'; }
              catch { output.textContent = 'Dispatch failed'; }
            };
          }
        }
        customElements.define('dispatch-editor', DispatchEditor);
      </script>`);
      return;
    }
    if (request.method === "POST" && path === "/decoy") { decoyClicks++; response.writeHead(204).end(); return; }
    if (request.method === "POST" && path === "/dispatch") {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const valid = sequenceScore({ attempts: [{ body, accepted: true }], decoyClicks: 0, expected });
        attempts.push({ body, accepted: valid });
        response.writeHead(valid ? 201 : 400, { "content-type": "application/json" }).end(JSON.stringify({ status: valid ? "sent" : "rejected" }));
      } catch {
        attempts.push({ body: null, accepted: false });
        response.writeHead(400).end();
      }
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Cannot start sequence fixture");
  return {
    origin: `http://127.0.0.1:${address.port}`, server,
    prompt: `In the dispatch workspace, arrange the shipments in this exact order: ${expected.sequence.join(", ")}. Enter dispatch reference ${expected.reference}, confirm the dispatch, and send it once.`,
    evidence: () => ({ attempts: structuredClone(attempts), decoyClicks, expected: structuredClone(expected) }),
  };
}
