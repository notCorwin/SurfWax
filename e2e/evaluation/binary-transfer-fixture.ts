import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";

type Generation = { name: unknown; accepted: boolean };
type Upload = { name: unknown; bytes: number | null; sha256: string | null; accepted: boolean; generatedBefore: number };

export interface BinaryTransferFixture {
  origin: string;
  server: Server;
  prompt: string;
  evidence(): { expected: { name: string; bytes: number; sha256: string }; generations: Generation[]; uploads: Upload[] };
}

/** All generated-file and submission attempts count; neither can be repaired by retrying. */
export function binaryTransferScore(evidence: ReturnType<BinaryTransferFixture["evidence"]>): boolean {
  const { expected, generations, uploads } = evidence;
  return generations.length === 1 && generations[0]!.accepted && generations[0]!.name === expected.name
    && uploads.length === 1 && uploads[0]!.accepted && uploads[0]!.generatedBefore === 1
    && uploads[0]!.name === expected.name && uploads[0]!.bytes === expected.bytes && uploads[0]!.sha256 === expected.sha256;
}

/** The bytes are independently constructed in the browser and judge; no HTTP route serves the file. */
export async function binaryTransferFixture(seed: number): Promise<BinaryTransferFixture> {
  const length = 65_539;
  let state = (seed ^ 0x79bde41f) >>> 0;
  const bytes = Buffer.alloc(length);
  for (let index = 0; index < length; index++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    bytes[index] = state >>> 24;
  }
  bytes.set([0, 255, 128, 13, 10], 0);
  const name = `sample-${seed}.bin`;
  const expected = { name, bytes: length, sha256: createHash("sha256").update(bytes).digest("hex") };
  const generations: Generation[] = [], uploads: Upload[] = [];
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://fixture.local").pathname;
    if (request.method === "GET" && path === "/") {
      const address = server.address();
      if (!address || typeof address === "string") { response.writeHead(500).end(); return; }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(`<!doctype html><title>Transfer desk</title><style>#desks{display:flex;gap:12px}</style><main><h1>Transfer desk</h1>
        <p>Generate the file at Source, then attach the same file at Destination and submit once.</p>
        <div id="desks">
        <iframe title="Source" src="http://localhost:${address.port}/source" style="width:470px;height:220px"></iframe>
        <iframe title="Destination" src="http://127.0.0.1:${address.port}/destination" style="width:470px;height:220px"></iframe></div></main>`);
      return;
    }
    if (request.method === "GET" && path === "/source") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(`<!doctype html><title>Source</title><main><h1>Source</h1>
        <button id="generate" type="button">Generate file</button><a id="file" hidden download="${name}">Generated file</a>
        <output id="status" aria-live="polite">Not generated</output></main><script>
          document.querySelector('#generate').onclick = async event => {
            event.currentTarget.disabled = true;
            let state = (${seed} ^ 0x79bde41f) >>> 0; const bytes = new Uint8Array(${length});
            for (let index = 0; index < bytes.length; index++) { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; bytes[index] = state >>> 24; }
            bytes.set([0, 255, 128, 13, 10], 0);
            const anchor = document.querySelector('#file'); anchor.href = URL.createObjectURL(new Blob([bytes], {type:'application/octet-stream'}));
            try { const response = await fetch('/generated', {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({name:${JSON.stringify(name)}})});
              anchor.hidden = !response.ok; document.querySelector('#status').textContent = response.ok ? 'Ready' : 'Generation rejected';
            } catch { document.querySelector('#status').textContent = 'Generation failed'; }
          };
        </script>`);
      return;
    }
    if (request.method === "GET" && path === "/destination") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(`<!doctype html><title>Destination</title><main><h1>Destination</h1>
        <input id="file" type="file" hidden><button id="choose" type="button">Choose file</button><output id="chosen">No file selected</output>
        <button id="submit" type="button">Submit file</button><output id="status" aria-live="polite">Not submitted</output></main><script>
          const input = document.querySelector('#file'); document.querySelector('#choose').onclick = () => input.click();
          input.onchange = () => { document.querySelector('#chosen').textContent = input.files[0]?.name ?? 'No file selected'; };
          document.querySelector('#submit').onclick = async () => {
            const file = input.files[0];
            try {
              let binary = ''; if (file) { const bytes = new Uint8Array(await file.arrayBuffer());
                for (let index = 0; index < bytes.length; index += 8192) binary += String.fromCharCode(...bytes.subarray(index, index + 8192)); }
              const response = await fetch('/upload', {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({name:file?.name ?? null,base64:btoa(binary)})});
              document.querySelector('#status').textContent = response.ok ? 'Submitted' : 'Rejected';
            } catch { document.querySelector('#status').textContent = 'Submission failed'; }
          };
        </script>`);
      return;
    }
    if (request.method === "POST" && path === "/generated") {
      try {
        const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const body = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
        const accepted = Object.keys(body).join(",") === "name" && body.name === name && generations.length === 0;
        generations.push({ name: body.name ?? null, accepted });
        response.writeHead(accepted ? 201 : 409).end();
      } catch { generations.push({ name: null, accepted: false }); response.writeHead(400).end(); }
      return;
    }
    if (request.method === "POST" && path === "/upload") {
      try {
        const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const body = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
        if (Object.keys(body).sort().join(",") !== "base64,name" || typeof body.name !== "string" || typeof body.base64 !== "string") throw new Error("Invalid upload");
        const data = Buffer.from(body.base64, "base64");
        if (data.toString("base64") !== body.base64) throw new Error("Invalid base64");
        const sha256 = createHash("sha256").update(data).digest("hex");
        const generatedBefore = generations.length;
        const accepted = generations.length === 1 && generations[0]!.accepted && uploads.length === 0
          && body.name === expected.name && data.length === expected.bytes && sha256 === expected.sha256;
        uploads.push({ name: body.name, bytes: data.length, sha256, accepted, generatedBefore });
        response.writeHead(accepted ? 201 : 400).end();
      } catch { uploads.push({ name: null, bytes: null, sha256: null, accepted: false, generatedBefore: generations.length }); response.writeHead(400).end(); }
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Cannot start binary transfer fixture");
  return { origin: `http://127.0.0.1:${address.port}`, server,
    prompt: "Generate the file at Source, then attach that same file at Destination and submit once.",
    evidence: () => structuredClone({ expected, generations, uploads }) };
}
