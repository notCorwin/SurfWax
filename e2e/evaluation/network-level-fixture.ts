import { createHash } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";

type Sample = { name: unknown; accepted: boolean };
type Ack = { name: unknown; accepted: boolean };
type Submission = { values: unknown; accepted: boolean; requestsBefore: number; responsesBefore: number; acknowledgementsBefore: number };

export interface NetworkFixture {
  origin: string;
  server: Server;
  prompt: string;
  evidence(): { names: string[]; expectedCodes: string[]; requests: Sample[]; responses: string[]; acknowledgements: Ack[]; submissions: Submission[] };
}

/** The server ledger is independent of the page's displayed status and the model's final text. */
export function networkScore(evidence: ReturnType<NetworkFixture["evidence"]>): boolean {
  const { names, expectedCodes, requests, responses, acknowledgements, submissions } = evidence;
  const reverse = [...names].reverse();
  return names.length === 6 && expectedCodes.length === names.length
    && requests.length === names.length && requests.every((item) => item.accepted && typeof item.name === "string")
    && new Set(requests.map((item) => item.name)).size === names.length
    && names.every((name) => requests.some((item) => item.name === name))
    && JSON.stringify(responses) === JSON.stringify(reverse)
    && acknowledgements.length === names.length && acknowledgements.every((item, index) => item.accepted && item.name === reverse[index])
    && submissions.length === 1 && submissions[0]!.accepted && submissions[0]!.requestsBefore === names.length
    && submissions[0]!.responsesBefore === names.length && submissions[0]!.acknowledgementsBefore === names.length
    && JSON.stringify(submissions[0]!.values) === JSON.stringify(expectedCodes);
}

/** Same-URL concurrent requests, released in reverse order only after each previous response is acknowledged. */
export async function networkFixture(seed: number): Promise<NetworkFixture> {
  const names = ["Atlas", "Birch", "Coral", "Delta", "Elm", "Flint"];
  let state = (seed ^ 0xa511e9b3) >>> 0;
  for (let index = names.length - 1; index > 0; index--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const other = state % (index + 1);
    [names[index], names[other]] = [names[other]!, names[index]!];
  }
  const expectedCodes = names.map((name) => `CODE-${createHash("sha256").update(`${seed}:${name}`).digest("hex").slice(0, 16).toUpperCase()}`);
  const codes = new Map(names.map((name, index) => [name, expectedCodes[index]!]));
  const releaseOrder = [...names].reverse();
  const pending = new Map<string, ServerResponse>();
  const requests: Sample[] = [], responses: string[] = [], acknowledgements: Ack[] = [], submissions: Submission[] = [];
  let nextResponse = 0, waitingForAck: string | undefined;
  const release = () => {
    if (waitingForAck || nextResponse >= releaseOrder.length || pending.size !== names.length) return;
    const name = releaseOrder[nextResponse]!;
    const response = pending.get(name)!;
    waitingForAck = name;
    responses.push(name);
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify({ name, code: codes.get(name) }));
  };
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
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><title>Response desk</title><main><h1>Response portal</h1><iframe title="Response desk" src="http://localhost:${address.port}/desk" style="width:720px;height:650px"></iframe></main>`);
      return;
    }
    if (request.method === "GET" && path === "/desk") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><title>Response desk</title><main><h1>Response desk</h1>
        <p>Run the requests. Each response from /sample contains a name and code. Enter the code for each named field and submit once.</p>
        <button id="run" type="button">Run requests</button><output id="state" aria-live="polite">Not started</output>
        <form><fieldset><legend>Response codes</legend>${names.map((name) => `<label>${name} code <input name="${name}"></label><br>`).join("")}</fieldset>
        <button type="submit">Submit codes</button></form><output id="notice" aria-live="polite">Not submitted</output></main>
        <script>
          const names = ${JSON.stringify(names)}, run = document.querySelector('#run'), state = document.querySelector('#state');
          run.onclick = async () => {
            run.disabled = true; state.textContent = 'Running';
            try {
              await Promise.all(names.map(async name => {
                const response = await fetch('/sample', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name})});
                if (!response.ok) throw new Error('request rejected');
                const result = await response.json();
                const ack = await fetch('/ack', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(result)});
                if (!ack.ok) throw new Error('acknowledgement rejected');
              }));
              state.textContent = 'Responses ready';
            } catch { state.textContent = 'Requests failed'; }
          };
          document.querySelector('form').onsubmit = async event => {
            event.preventDefault();
            const values = names.map(name => document.querySelector('input[name="' + name + '"]').value);
            try {
              const response = await fetch('/submit', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({values})});
              document.querySelector('#notice').textContent = response.ok ? 'Codes submitted' : 'Codes rejected';
            } catch { document.querySelector('#notice').textContent = 'Submission failed'; }
          };
        </script>`);
      return;
    }
    if (request.method === "POST" && path === "/sample") {
      try {
        const body = await parse(request), name = body.name;
        const accepted = Object.keys(body).join(",") === "name" && typeof name === "string" && codes.has(name) && !pending.has(name);
        requests.push({ name: name ?? null, accepted });
        if (!accepted) { response.writeHead(409).end(); return; }
        pending.set(name as string, response);
        release();
      } catch { requests.push({ name: null, accepted: false }); response.writeHead(400).end(); }
      return;
    }
    if (request.method === "POST" && path === "/ack") {
      try {
        const body = await parse(request), name = body.name;
        const accepted = Object.keys(body).sort().join(",") === "code,name" && typeof name === "string"
          && name === waitingForAck && codes.get(name) === body.code;
        acknowledgements.push({ name: name ?? null, accepted });
        if (!accepted) { response.writeHead(409).end(); return; }
        waitingForAck = undefined;
        nextResponse++;
        response.writeHead(204).end();
        setImmediate(release);
      } catch { acknowledgements.push({ name: null, accepted: false }); response.writeHead(400).end(); }
      return;
    }
    if (request.method === "POST" && path === "/submit") {
      try {
        const body = await parse(request), values = body.values;
        const accepted = Object.keys(body).join(",") === "values" && Array.isArray(values)
          && JSON.stringify(values) === JSON.stringify(expectedCodes);
        submissions.push({ values, accepted, requestsBefore: requests.length, responsesBefore: responses.length, acknowledgementsBefore: acknowledgements.length });
        response.writeHead(accepted ? 201 : 400, { "content-type": "application/json" }).end(JSON.stringify({ status: accepted ? "submitted" : "rejected" }));
      } catch { submissions.push({ values: null, accepted: false, requestsBefore: requests.length, responsesBefore: responses.length, acknowledgementsBefore: acknowledgements.length }); response.writeHead(400).end(); }
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Cannot start network identity fixture");
  return { origin: `http://127.0.0.1:${address.port}`, server,
    prompt: "At the response desk, run the requests, read each named code from the captured responses, enter the corresponding codes, and submit once.",
    evidence: () => ({ names: [...names], expectedCodes: [...expectedCodes], requests: structuredClone(requests), responses: [...responses], acknowledgements: structuredClone(acknowledgements), submissions: structuredClone(submissions) }) };
}
