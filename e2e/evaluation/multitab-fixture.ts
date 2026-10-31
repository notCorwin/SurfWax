import { createServer, type Server } from "node:http";

type Attempt = { window: string; value: unknown; accepted: boolean };

export interface MultitabFixture {
  origin: string;
  server: Server;
  prompt: string;
  evidence(): { expectedCode: string; visits: { source: number; destination: number }; attempts: Attempt[] };
}

/** The test process owns the append-only submission ledger; page text is not proof. */
export function multitabScore(evidence: ReturnType<MultitabFixture["evidence"]>): boolean {
  const attempt = evidence.attempts[0];
  return evidence.visits.source > 0 && evidence.visits.destination > 0 && evidence.attempts.length === 1
    && attempt?.window === "destination" && attempt.accepted && attempt.value === evidence.expectedCode;
}

/** Two similar popups opened by a cross-origin iframe; each has the same form controls. */
export async function multitabFixture(seed: number): Promise<MultitabFixture> {
  const expectedCode = `MOVE-${seed}-${(Math.imul(seed + 17, 7919) >>> 0).toString(36).toUpperCase()}`;
  const decoyCode = `MOVE-${seed}-${(Math.imul(seed + 29, 6151) >>> 0).toString(36).toUpperCase()}`;
  const visits = { source: 0, destination: 0 };
  const attempts: Attempt[] = [];
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://fixture.local").pathname;
    if (request.method === "GET" && path === "/") {
      const address = server.address();
      if (!address || typeof address === "string") { response.writeHead(500).end(); return; }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><title>Transfer portal</title><main><h1>Transfer portal</h1><iframe title="Window launcher" src="http://localhost:${address.port}/launcher" style="width:600px;height:300px"></iframe></main>`);
      return;
    }
    if (request.method === "GET" && path === "/launcher") {
      const address = server.address();
      if (!address || typeof address === "string") { response.writeHead(500).end(); return; }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><title>Window launcher</title><main><h1>Window launcher</h1><button id="source">Open source window</button><button id="destination">Open destination window</button></main>
        <script>document.querySelector('#source').onclick = () => window.open('/window/source', '_blank');
        document.querySelector('#destination').onclick = () => window.open('http://127.0.0.1:${address.port}/window/destination', '_blank');</script>`);
      return;
    }
    if (request.method === "GET" && (path === "/window/source" || path === "/window/destination")) {
      const windowName = path.endsWith("source") ? "source" : "destination";
      visits[windowName]++;
      const title = windowName === "source" ? "Source desk" : "Destination desk";
      const code = windowName === "source" ? expectedCode : decoyCode;
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(`<!doctype html><title>${title}</title><main><h1>${title}</h1><p>Displayed code: <strong>${code}</strong></p>
        <label>Transfer code <input id="code"></label><button id="submit">Submit transfer</button><output id="status" aria-live="polite">Not submitted</output></main>
        <script>document.querySelector('#submit').onclick = async () => {
          const value = document.querySelector('#code').value;
          try { const response = await fetch('/submit/${windowName}', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({value})});
            document.querySelector('#status').textContent = response.ok ? 'Transfer submitted' : 'Transfer rejected';
          } catch { document.querySelector('#status').textContent = 'Transfer failed'; }
        };</script>`);
      return;
    }
    if (request.method === "POST" && (path === "/submit/source" || path === "/submit/destination")) {
      const windowName = path.endsWith("source") ? "source" : "destination";
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const record = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
        const valid = Object.keys(record).join(",") === "value" && record.value === expectedCode;
        const accepted = windowName === "destination" && valid;
        attempts.push({ window: windowName, value: record.value ?? null, accepted });
        response.writeHead(accepted ? 201 : 400, { "content-type": "application/json" }).end(JSON.stringify({ status: accepted ? "submitted" : "rejected" }));
      } catch {
        attempts.push({ window: windowName, value: null, accepted: false });
        response.writeHead(400).end();
      }
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Cannot start multitab fixture");
  return {
    origin: `http://127.0.0.1:${address.port}`, server,
    prompt: "Open the source and destination windows. Copy the displayed code from the source window into the destination window and submit the transfer once.",
    evidence: () => ({ expectedCode, visits: { ...visits }, attempts: structuredClone(attempts) }),
  };
}
