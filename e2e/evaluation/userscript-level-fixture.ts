import { createServer, type Server } from "node:http";
import { isDeepStrictEqual } from "node:util";

export type Script = chrome.userScripts.RegisteredUserScript;
type Receipt = { name: unknown; documentId: unknown; stamp: unknown; accepted: boolean };
type Submission = { accepted: boolean };
type Action = { type: "visit" | "receipt" | "submit"; name: string | null };
export interface UserscriptFixture {
  origin: string;
  server: Server;
  prompt: string;
  preset: { target: Script; decoy: Script };
  evidence(): { expected: Record<string, string>; visits: { name: string; documentId: string }[]; receipts: Receipt[]; submissions: Submission[]; actions: Action[] };
}
export type RegistryEvidence = { registered: Script[]; active: Script[]; disabled: Script[] };

/** The business ledger and the native/persisted registry are independent evidence. */
export function userscriptScore(evidence: ReturnType<UserscriptFixture["evidence"]>, registry: RegistryEvidence, preset: UserscriptFixture["preset"]): boolean {
  const { registered, active, disabled } = registry;
  if (![registered, active, disabled].every(Array.isArray)) return false;
  if (registered.length !== 1 || active.length !== 1 || disabled.length !== 1) return false;
  const native = registered[0]!, stored = active[0]!;
  if (native.id !== preset.target.id || stored.id !== preset.target.id || disabled[0]!.id !== preset.decoy.id) return false;
  // Check the executable registration against persistence, without prescribing
  // a particular world, run time, or match pattern for a working repair.
  if (native.allFrames !== true || stored.allFrames !== true || native.world !== stored.world
    || native.runAt !== stored.runAt || !isDeepStrictEqual(native.matches, stored.matches)
    || !isDeepStrictEqual(native.js, stored.js)
    || !isDeepStrictEqual(disabled[0], preset.decoy)) return false;
  const names = Object.keys(evidence.expected);
  const expectedActions: Action[] = names.flatMap((name) => [{ type: "visit", name }, { type: "receipt", name }]);
  expectedActions.push({ type: "submit", name: null });
  if (JSON.stringify(evidence.actions) !== JSON.stringify(expectedActions)) return false;
  if (evidence.visits.length !== names.length || evidence.receipts.length !== names.length || evidence.submissions.length !== 1
    || !evidence.submissions[0]!.accepted) return false;
  if (JSON.stringify(evidence.visits.map((visit) => visit.name)) !== JSON.stringify(names)
    || JSON.stringify(evidence.receipts.map((receipt) => receipt.name)) !== JSON.stringify(names)
    || new Set(evidence.visits.map((visit) => visit.documentId)).size !== names.length) return false;
  return names.every((name) => {
    const visit = evidence.visits.find((item) => item.name === name);
    const receipt = evidence.receipts.filter((item) => item.name === name);
    return !!visit && receipt.length === 1 && receipt[0]!.accepted && receipt[0]!.documentId === visit.documentId
      && receipt[0]!.stamp === evidence.expected[name];
  });
}

/** Eight distinct documents in a cross-origin frame; every execution and submission is recorded. */
export async function userscriptFixture(seed: number): Promise<UserscriptFixture> {
  const names = ["Atlas", "Birch", "Coral", "Drift", "Elm", "Finch", "Grove", "Harbor"];
  const expected = Object.fromEntries(names.map((name, index) => [name, `STAMP-${seed}-${index}-${(Math.imul(seed + index + 1, 7919) >>> 0).toString(36)}`]));
  const target: Script = { id: "record-stamp", matches: ["http://localhost/*"], allFrames: false, runAt: "document_end", world: "MAIN",
    js: [{ code: "document.documentElement.dataset.stamp = 'BROKEN';" }] };
  const decoy: Script = { id: "record-archive", matches: ["http://localhost/*"], allFrames: false, runAt: "document_end", world: "MAIN",
    js: [{ code: "document.documentElement.dataset.archive = 'kept';" }] };
  const visits: { name: string; documentId: string }[] = [];
  const receipts: Receipt[] = [];
  const submissions: Submission[] = [];
  const actions: Action[] = [];
  let documentSequence = 0;
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://fixture.local").pathname;
    if (request.method === "GET" && path === "/") {
      const address = server.address();
      if (!address || typeof address === "string") { response.writeHead(500).end(); return; }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><title>Record desk</title><main><h1>Record desk</h1>
        <p>Open records in this order: ${names.join(", ")}. Wait for each stamp to say Ready before opening the next record.</p>
        ${names.map((name) => `<button id="${name.toLowerCase()}">Open ${name}</button>`).join("")}<button id="submit">Submit records</button><output id="status">Not submitted</output>
        <iframe title="Record" src="about:blank" style="width:650px;height:180px"></iframe></main>
        <script>const frame=document.querySelector('iframe');
          for (const name of ${JSON.stringify(names)}) document.querySelector('#'+name.toLowerCase()).onclick=()=>{frame.src='http://localhost:${address.port}/record/'+name;};
          document.querySelector('#submit').onclick=async()=>{const response=await fetch('/submit',{method:'POST'});document.querySelector('#status').textContent=response.ok?'Submitted':'Rejected';};
        </script>`);
      return;
    }
    if (request.method === "GET" && path.startsWith("/record/")) {
      const name = path.slice("/record/".length);
      if (!Object.hasOwn(expected, name)) { response.writeHead(404).end(); return; }
      const documentId = `document-${++documentSequence}`;
      visits.push({ name, documentId }); actions.push({ type: "visit", name });
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><html><head><title>${name} record</title></head><body data-expected-stamp="${expected[name]}"><main><h1>${name} record</h1><output id="stamp">Waiting for stamp</output></main>
        <script>
          const observer=new MutationObserver(()=>{if(!document.documentElement.hasAttribute('data-stamp'))return; observer.disconnect();
            const stamp=document.documentElement.dataset.stamp; document.querySelector('#stamp').textContent='Stamp received: '+stamp;
            void fetch('/receipt',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:${JSON.stringify(name)},documentId:${JSON.stringify(documentId)},stamp})}).then(r=>{document.querySelector('#stamp').textContent=r.ok?'Ready':'Stamp rejected';});
          }); observer.observe(document.documentElement,{attributes:true,attributeFilter:['data-stamp']});
        </script></body></html>`);
      return;
    }
    if (request.method === "POST" && path === "/receipt") {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const body = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
        const visit = visits.find((item) => item.documentId === body.documentId);
        const accepted = Object.keys(body).sort().join(",") === "documentId,name,stamp" && !!visit && visit.name === body.name
          && typeof body.name === "string" && expected[body.name] === body.stamp && !receipts.some((item) => item.documentId === body.documentId);
        receipts.push({ name: body.name ?? null, documentId: body.documentId ?? null, stamp: body.stamp ?? null, accepted });
        actions.push({ type: "receipt", name: typeof body.name === "string" ? body.name : null });
        response.writeHead(accepted ? 201 : 400).end();
      } catch { receipts.push({ name: null, documentId: null, stamp: null, accepted: false }); actions.push({ type: "receipt", name: null }); response.writeHead(400).end(); }
      return;
    }
    if (request.method === "POST" && path === "/submit") {
      const accepted = visits.length === names.length && receipts.length === names.length && receipts.every((item) => item.accepted)
        && JSON.stringify(visits.map((item) => item.name)) === JSON.stringify(Object.keys(expected))
        && JSON.stringify(receipts.map((item) => item.name)) === JSON.stringify(Object.keys(expected)) && submissions.length === 0
        && JSON.stringify(actions) === JSON.stringify(Object.keys(expected).flatMap((name) => [{ type: "visit", name }, { type: "receipt", name }]));
      actions.push({ type: "submit", name: null }); submissions.push({ accepted }); response.writeHead(accepted ? 201 : 400).end(); return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Cannot start userscript fixture");
  return { origin: `http://127.0.0.1:${address.port}`, server,
    prompt: `Fix and enable the existing user script "record-stamp". On every record page, it must set document.documentElement.dataset.stamp to document.body.dataset.expectedStamp. Open the records in this order: ${names.join(', ')}. Wait for each to say Ready before opening the next. Submit once. Keep the other script unchanged.`,
    preset: { target: structuredClone(target), decoy: structuredClone(decoy) },
    evidence: () => structuredClone({ expected, visits, receipts, submissions, actions }) };
}
