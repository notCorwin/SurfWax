import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";

type Step = { accepted: boolean };
type Submission = { accepted: boolean; bytes: number | null; sha256: string | null; opensBefore: number; generationsBefore: number; closesBefore: number };

export interface ClosedEventFixture {
  origin: string;
  server: Server;
  prompt: string;
  evidence(): { expectedCodes: string[]; sourceOpens: number; generations: Step[]; closes: Step[]; submissions: Submission[] };
}

/** Every source opening, generation, close and submission counts, including failures. */
export function closedEventScore(evidence: ReturnType<ClosedEventFixture["evidence"]>): boolean {
  const { expectedCodes, sourceOpens, generations, closes, submissions } = evidence;
  if (expectedCodes.length !== 180 || sourceOpens !== 1 || generations.length !== 1 || !generations[0]!.accepted
    || closes.length !== 1 || !closes[0]!.accepted || submissions.length !== 1) return false;
  const input = expectedCodes.join("\n"), entry = submissions[0]!;
  return entry.accepted && entry.opensBefore === 1 && entry.generationsBefore === 1 && entry.closesBefore === 1
    && entry.bytes === Buffer.byteLength(input) && entry.sha256 === createHash("sha256").update(input).digest("hex");
}

/** The popup emits fewer than the subscription capacity; the event stream itself is not a trusted ledger. */
export async function closedEventFixture(seed: number): Promise<ClosedEventFixture> {
  const expectedCodes = Array.from({ length: 180 }, (_, index) => `AUD-${seed}-${String(index).padStart(3, "0")}-${createHash("sha256").update(`${seed}:${index}`).digest("hex").slice(0, 20).toUpperCase()}`);
  const expected = expectedCodes.join("\n"), sha256 = createHash("sha256").update(expected).digest("hex");
  const generations: Step[] = [], closes: Step[] = [], submissions: Submission[] = [];
  let sourceOpens = 0;
  const parse = async (request: AsyncIterable<unknown>) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  };
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://fixture.local").pathname;
    if (request.method === "GET" && path === "/") {
      const address = server.address();
      if (!address || typeof address === "string") { response.writeHead(500).end(); return; }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(`<!doctype html><title>Audit portal</title><main><h1>Audit portal</h1>
        <button id="open">Open source</button><iframe title="Destination" src="http://localhost:${address.port}/destination" style="width:720px;height:380px"></iframe></main>
        <script>document.querySelector('#open').onclick=()=>window.open('http://localhost:${address.port}/source','audit-source','width=720,height=360');</script>`);
      return;
    }
    if (request.method === "GET" && path === "/destination") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(`<!doctype html><title>Destination</title><main><h1>Destination</h1>
        <label>Audit codes <textarea rows="8" cols="75"></textarea></label><button id="submit">Submit audit</button><output id="status">Not submitted</output></main>
        <script>document.querySelector('#submit').onclick=async()=>{try{const response=await fetch('/submit',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({codes:document.querySelector('textarea').value})});document.querySelector('#status').textContent=response.ok?'Submitted':'Rejected';}catch{document.querySelector('#status').textContent='Submission failed';}};</script>`);
      return;
    }
    if (request.method === "GET" && path === "/source") {
      sourceOpens++;
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(`<!doctype html><title>Audit source</title><main><h1>Audit source</h1>
        <p>Generate the audit log. Collect the AUDIT entries in order; HEARTBEAT entries are not audit codes.</p>
        <button id="generate">Generate audit log</button><button id="close" disabled>Close source</button><output id="status">Not generated</output></main><script>
        const codes=${JSON.stringify(expectedCodes)};
        document.querySelector('#generate').onclick=async event=>{event.currentTarget.disabled=true;codes.forEach((code,index)=>{console.warn('AUDIT '+code);if(index%20===19)console.log('HEARTBEAT '+index);});
          try{const response=await fetch('/generated',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({count:codes.length})});document.querySelector('#status').textContent=response.ok?'Ready to close':'Generation rejected';document.querySelector('#close').disabled=!response.ok;}catch{document.querySelector('#status').textContent='Generation failed';}};
        document.querySelector('#close').onclick=async()=>{try{const response=await fetch('/close-source',{method:'POST'});if(response.ok)window.close();else document.querySelector('#status').textContent='Close rejected';}catch{document.querySelector('#status').textContent='Close failed';}};
        </script>`);
      return;
    }
    if (request.method === "POST" && path === "/generated") {
      try {
        const body = await parse(request), accepted = Object.keys(body).join(",") === "count" && body.count === 180
          && sourceOpens === 1 && generations.length === 0 && closes.length === 0 && submissions.length === 0;
        generations.push({ accepted }); response.writeHead(accepted ? 201 : 409).end();
      } catch { generations.push({ accepted: false }); response.writeHead(400).end(); }
      return;
    }
    if (request.method === "POST" && path === "/close-source") {
      const accepted = sourceOpens === 1 && generations.length === 1 && generations[0]!.accepted && closes.length === 0 && submissions.length === 0;
      closes.push({ accepted }); response.writeHead(accepted ? 204 : 409).end(); return;
    }
    if (request.method === "POST" && path === "/submit") {
      const counts = { opensBefore: sourceOpens, generationsBefore: generations.length, closesBefore: closes.length };
      try {
        const body = await parse(request);
        if (Object.keys(body).join(",") !== "codes" || typeof body.codes !== "string") throw new Error("Invalid submission");
        const bytes = Buffer.byteLength(body.codes), digest = createHash("sha256").update(body.codes).digest("hex");
        const accepted = counts.opensBefore === 1 && counts.generationsBefore === 1 && generations[0]!.accepted
          && counts.closesBefore === 1 && closes[0]!.accepted && submissions.length === 0
          && bytes === Buffer.byteLength(expected) && digest === sha256;
        submissions.push({ accepted, bytes, sha256: digest, ...counts }); response.writeHead(accepted ? 201 : 400).end();
      } catch { submissions.push({ accepted: false, bytes: null, sha256: null, ...counts }); response.writeHead(400).end(); }
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Cannot start closed-event fixture");
  return { origin: `http://127.0.0.1:${address.port}`, server,
    prompt: "Open Source, generate its audit log, then close it using Close source. Enter all 180 AUDIT codes in order, one per line, at Destination and submit once. Ignore HEARTBEAT entries.",
    evidence: () => structuredClone({ expectedCodes, sourceOpens, generations, closes, submissions }) };
}
