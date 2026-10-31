import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";

type FileDigest = { name: string; bytes: number; sha256: string };
type UploadAttempt = { files: FileDigest[]; accepted: boolean };

export interface UploadFixture {
  origin: string;
  server: Server;
  prompt: string;
  evidence(): { downloads: string[]; attempts: UploadAttempt[]; expected: FileDigest[] };
}

/** Every submission is recorded, including malformed, invalid, or repeated requests. */
export function uploadScore(evidence: ReturnType<UploadFixture["evidence"]>): boolean {
  if (evidence.attempts.length !== 1 || !evidence.attempts[0]!.accepted) return false;
  if (evidence.expected.some((file) => !evidence.downloads.includes(file.name))) return false;
  const canonical = (files: FileDigest[]) => JSON.stringify([...files].sort((a, b) => a.name.localeCompare(b.name)));
  return canonical(evidence.attempts[0]!.files) === canonical(evidence.expected);
}

/** Binary source files and an upload form served inside a cross-origin frame. */
export async function uploadFixture(seed: number): Promise<UploadFixture> {
  let state = (seed ^ 0xc3a5c85c) >>> 0;
  const bytes = Buffer.alloc(32771);
  for (let index = 0; index < bytes.length; index++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    bytes[index] = state >>> 24;
  }
  // The binary contains invalid UTF-8, zeros, and more than one typical transfer chunk.
  bytes.set([0, 255, 128, 10], 0);
  const files = [
    { name: `manifest-${seed}.txt`, type: "text/plain; charset=utf-8", bytes: Buffer.from(`Dossier ${seed}\r\nSeal: Café 波浪\r\n`, "utf8") },
    { name: `sample-${seed}.bin`, type: "application/octet-stream", bytes },
  ];
  const digest = (file: { name: string; bytes: Buffer }): FileDigest => ({ name: file.name, bytes: file.bytes.length, sha256: createHash("sha256").update(file.bytes).digest("hex") });
  const expected = files.map(digest);
  const downloads: string[] = [];
  const attempts: UploadAttempt[] = [];
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://fixture.local").pathname;
    if (request.method === "GET" && path === "/") {
      const address = server.address();
      if (!address || typeof address === "string") { response.writeHead(500).end(); return; }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><title>Dossier</title><main><h1>Dossier portal</h1><iframe title="Document desk" src="http://localhost:${address.port}/desk" style="width:700px;height:420px"></iframe></main>`);
      return;
    }
    if (request.method === "GET" && path === "/desk") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><title>Document desk</title><main><h1>Document desk</h1>
        <p>Retrieve both source files, then attach both unchanged and submit them together once.</p>
        <ul>${files.map((file, index) => `<li><a href="/source/${index}" download="${file.name}">Download ${file.name}</a></li>`).join("")}</ul>
        <input id="files" type="file" multiple hidden><button type="button" id="choose">Choose files</button>
        <output id="chosen" aria-live="polite">No files selected</output><button type="button" id="submit">Submit dossier</button>
        <output id="status" aria-live="polite">Not submitted</output></main><script>
        const input = document.querySelector('#files');
        document.querySelector('#choose').onclick = () => input.click();
        input.onchange = () => { document.querySelector('#chosen').textContent = Array.from(input.files, file => file.name).join(', ') || 'No files selected'; };
        document.querySelector('#submit').onclick = async () => {
          const button = document.querySelector('#submit'); button.disabled = true;
          try {
            const files = await Promise.all(Array.from(input.files, async file => {
              const bytes = new Uint8Array(await file.arrayBuffer()); let binary = '';
              for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
              return {name:file.name, base64:btoa(binary)};
            }));
            const response = await fetch('/upload', {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({files})});
            document.querySelector('#status').textContent = response.ok ? 'Dossier submitted' : 'Dossier rejected';
          } catch { document.querySelector('#status').textContent = 'Dossier failed'; }
          finally { button.disabled = false; }
        };
        </script>`);
      return;
    }
    if (request.method === "GET" && /^\/source\/[01]$/.test(path)) {
      const file = files[Number(path.at(-1))]!;
      downloads.push(file.name);
      response.writeHead(200, { "content-type": file.type, "content-disposition": `attachment; filename="${file.name}"`, "cache-control": "no-store" }).end(file.bytes);
      return;
    }
    if (request.method === "POST" && path === "/upload") {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).join(",") !== "files" || !Array.isArray((value as {files?: unknown}).files)) throw new Error("invalid submission");
        const submitted = (value as { files: unknown[] }).files.map((file) => {
          if (!file || typeof file !== "object" || Array.isArray(file)) throw new Error("invalid file");
          const record = file as Record<string, unknown>;
          if (Object.keys(record).sort().join(",") !== "base64,name" || typeof record.name !== "string" || typeof record.base64 !== "string") throw new Error("invalid file");
          const bytes = Buffer.from(record.base64, "base64");
          if (bytes.toString("base64") !== record.base64) throw new Error("invalid base64");
          return digest({name: record.name, bytes});
        });
        const accepted = uploadScore({ downloads: expected.map((file) => file.name), expected, attempts: [{ files: submitted, accepted: true }] });
        attempts.push({ files: submitted, accepted });
        response.writeHead(accepted ? 201 : 400, { "content-type": "application/json" }).end(JSON.stringify({ status: accepted ? "submitted" : "rejected" }));
      } catch {
        attempts.push({ files: [], accepted: false });
        response.writeHead(400, { "content-type": "application/json" }).end('{"status":"rejected"}');
      }
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Cannot start upload fixture");
  return {
    origin: `http://127.0.0.1:${address.port}`, server,
    prompt: "In the document desk, retrieve both source files, then attach both unchanged and submit the dossier once.",
    evidence: () => ({ downloads: [...downloads], attempts: structuredClone(attempts), expected: structuredClone(expected) }),
  };
}
