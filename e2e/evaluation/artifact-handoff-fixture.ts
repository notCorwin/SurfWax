import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";

type Attempt = { bytes: number | null; sha256: string | null; accepted: boolean };

export interface ArtifactHandoffFixture {
  origin: string;
  server: Server;
  prompt: string;
  evidence(): { expectedCodeUnits: number; expectedBytes: number; expectedSha256: string; attempts: Attempt[] };
}

/** Every submission is retained; an incorrect or duplicate attempt cannot be repaired. */
export function artifactHandoffScore(evidence: ReturnType<ArtifactHandoffFixture["evidence"]>): boolean {
  const attempt = evidence.attempts[0];
  return evidence.attempts.length === 1 && !!attempt?.accepted
    && attempt.bytes === evidence.expectedBytes && attempt.sha256 === evidence.expectedSha256;
}

/** The page generates its source locally; the judge separately computes the expected UTF-8 bytes. */
export async function artifactHandoffFixture(seed: number): Promise<ArtifactHandoffFixture> {
  if (!Number.isSafeInteger(seed)) throw new Error("Invalid handoff seed");
  const count = 2048;
  let state = (seed ^ 0x59f0b6d3) >>> 0;
  const rows: string[] = [];
  const symbols = ["海🌊", "é", "e\u0301", "𐍈", "東京"];
  for (let index = 0; index < count; index++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    rows.push(`ROW-${String(index).padStart(4, "0")}-${state.toString(16).padStart(8, "0")}-${symbols[state % symbols.length]}-${symbols[index % symbols.length]}`);
  }
  const expected = rows.join("\n");
  const expectedCodeUnits = expected.length;
  const expectedBytes = Buffer.byteLength(expected, "utf8");
  const expectedSha256 = createHash("sha256").update(expected, "utf8").digest("hex");
  const attempts: Attempt[] = [];

  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://fixture.local").pathname;
    if (request.method === "GET" && path === "/") {
      const address = server.address();
      if (!address || typeof address === "string") { response.writeHead(500).end(); return; }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(`<!doctype html><title>Handoff portal</title><main><h1>Handoff portal</h1><iframe title="Handoff desk" src="http://localhost:${address.port}/desk" style="width:760px;height:600px"></iframe></main>`);
      return;
    }
    if (request.method === "GET" && path === "/desk") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(`<!doctype html><title>Handoff desk</title><main><h1>Handoff desk</h1>
        <p>Copy the source data exactly into Complete copy and submit once.</p>
        <label>Source data <textarea id="source" readonly rows="8" cols="70"></textarea></label>
        <label>Complete copy <textarea id="payload" rows="8" cols="70"></textarea></label>
        <button id="submit" type="button">Submit copy</button><output id="status" aria-live="polite">Not submitted</output></main>
        <script>
          const symbols = ['海🌊', 'é', 'e\u0301', '𐍈', '東京'];
          let state = (${seed} ^ 0x59f0b6d3) >>> 0; const rows = [];
          for (let index = 0; index < ${count}; index++) {
            state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
            rows.push('ROW-' + String(index).padStart(4, '0') + '-' + state.toString(16).padStart(8, '0') + '-' + symbols[state % symbols.length] + '-' + symbols[index % symbols.length]);
          }
          document.querySelector('#source').value = rows.join('\\n');
          document.querySelector('#submit').onclick = async () => {
            const button = document.querySelector('#submit'); button.disabled = true;
            try {
              const result = await fetch('/submit', {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({payload:document.querySelector('#payload').value})});
              document.querySelector('#status').textContent = result.ok ? 'Submitted' : 'Rejected';
            } catch { document.querySelector('#status').textContent = 'Submission failed'; }
            finally { button.disabled = false; }
          };
        </script>`);
      return;
    }
    if (request.method === "POST" && path === "/submit") {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).join(",") !== "payload" || typeof (body as { payload?: unknown }).payload !== "string") throw new Error("Invalid submission");
        const payload = (body as { payload: string }).payload;
        const bytes = Buffer.byteLength(payload, "utf8");
        const sha256 = createHash("sha256").update(payload, "utf8").digest("hex");
        const accepted = attempts.length === 0 && bytes === expectedBytes && sha256 === expectedSha256;
        attempts.push({ bytes, sha256, accepted });
        response.writeHead(accepted ? 201 : 400, { "content-type": "application/json" }).end(JSON.stringify({ status: accepted ? "submitted" : "rejected" }));
      } catch {
        attempts.push({ bytes: null, sha256: null, accepted: false });
        response.writeHead(400, { "content-type": "application/json" }).end('{"status":"rejected"}');
      }
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Cannot start handoff fixture");
  return {
    origin: `http://127.0.0.1:${address.port}`, server,
    prompt: "In the handoff desk, copy Source data exactly into Complete copy and submit once.",
    evidence: () => ({ expectedCodeUnits, expectedBytes, expectedSha256, attempts: structuredClone(attempts) }),
  };
}
