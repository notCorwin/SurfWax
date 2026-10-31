import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";

type Attempt = { bytes: number | null; sha256: string | null; accepted: boolean; pagesReadBefore: number };

export interface ManifestFixture {
  origin: string;
  server: Server;
  prompt: string;
  evidence(): { pageReads: number[]; pageCount: number; expectedBytes: number; expectedCodeUnits: number; expectedSha256: string; attempts: Attempt[] };
}

/** A correct final value cannot cancel an earlier invalid or duplicate submission. */
export function manifestScore(evidence: ReturnType<ManifestFixture["evidence"]>): boolean {
  if (evidence.attempts.length !== 1 || !evidence.attempts[0]?.accepted || evidence.attempts[0].pagesReadBefore !== evidence.pageCount) return false;
  if (evidence.attempts[0].bytes !== evidence.expectedBytes || evidence.attempts[0].sha256 !== evidence.expectedSha256) return false;
  const seen = new Set(evidence.pageReads);
  return Array.from({ length: evidence.pageCount }, (_, index) => index).every((index) => seen.has(index));
}

/** One page at a time is served; the judge and the full manifest stay in the test process. */
export async function manifestFixture(seed: number): Promise<ManifestFixture> {
  const pageCount = 20, pageSize = 60;
  const entries = Array.from({ length: pageCount * pageSize }, (_, index) => {
    const hash = createHash("sha256").update(`${seed}:${index}`).digest("hex");
    return { sort: hash, code: `PKG-${seed}-${index.toString().padStart(4, "0")}-${hash.slice(0, 28).toUpperCase()}-海🌊` };
  });
  entries.sort((left, right) => left.sort < right.sort ? -1 : left.sort > right.sort ? 1 : 0);
  const codes = entries.map((entry) => entry.code);
  const manifest = codes.join("\n");
  const expectedBytes = Buffer.byteLength(manifest, "utf8");
  const expectedSha256 = createHash("sha256").update(manifest, "utf8").digest("hex");
  const pageReads: number[] = [];
  const attempts: Attempt[] = [];

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture.local");
    if (request.method === "GET" && url.pathname === "/") {
      const address = server.address();
      if (!address || typeof address === "string") { response.writeHead(500).end(); return; }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><title>Manifest portal</title><main><h1>Manifest portal</h1><iframe title="Manifest desk" src="http://localhost:${address.port}/desk" style="width:760px;height:700px"></iframe></main>`);
      return;
    }
    if (request.method === "GET" && url.pathname === "/desk") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><title>Manifest desk</title><main><h1>Manifest desk</h1>
        <p>Copy all 1,200 tracking codes in their displayed order from every page. Put one code per line in the complete manifest and submit it once.</p>
        <output id="page" aria-live="polite">Loading</output>
        <button type="button" id="previous" disabled>Previous page</button><button type="button" id="next" disabled>Next page</button>
        <label>Complete manifest <textarea id="manifest" rows="6" cols="70"></textarea></label>
        <button type="button" id="submit">Submit manifest</button><output id="status" aria-live="polite">Not submitted</output>
        <ol aria-label="Tracking codes">${Array.from({ length: pageSize }, () => "<li></li>").join("")}</ol></main>
        <script>
          const rows = [...document.querySelectorAll('ol li')], previous = document.querySelector('#previous'), next = document.querySelector('#next');
          const page = document.querySelector('#page'), status = document.querySelector('#status');
          let index = 0, total = 0;
          async function load(value) {
            previous.disabled = true; next.disabled = true; page.textContent = 'Loading';
            try {
              const response = await fetch('/api/page?index=' + value, {cache:'no-store'});
              if (!response.ok) throw new Error('page unavailable');
              const data = await response.json(); index = data.index; total = data.total;
              rows.forEach((row, position) => { row.textContent = data.codes[position] ?? ''; });
              page.textContent = 'Page ' + (index + 1) + ' of ' + total;
              previous.disabled = index === 0; next.disabled = index + 1 >= total;
            } catch { page.textContent = 'Page unavailable'; }
          }
          previous.onclick = () => { if (index > 0) void load(index - 1); };
          next.onclick = () => { if (index + 1 < total) void load(index + 1); };
          document.querySelector('#submit').onclick = async () => {
            const button = document.querySelector('#submit'); button.disabled = true;
            try {
              const response = await fetch('/submit', {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({manifest:document.querySelector('#manifest').value})});
              status.textContent = response.ok ? 'Manifest submitted' : 'Manifest rejected';
            } catch { status.textContent = 'Manifest submission failed'; }
            finally { button.disabled = false; }
          };
          void load(0);
        </script>`);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/page") {
      const raw = url.searchParams.get("index");
      const index = raw !== null && /^(0|[1-9]\d*)$/.test(raw) ? Number(raw) : -1;
      if (!Number.isSafeInteger(index) || index < 0 || index >= pageCount) { response.writeHead(404).end(); return; }
      // A completed response does not prove that a model actually read the UI.
      response.once("finish", () => pageReads.push(index));
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify({ index, total: pageCount, codes: codes.slice(index * pageSize, (index + 1) * pageSize) }));
      return;
    }
    if (request.method === "POST" && url.pathname === "/submit") {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).join(",") !== "manifest" || typeof (value as { manifest?: unknown }).manifest !== "string") throw new Error("invalid submission");
        const submitted = (value as { manifest: string }).manifest;
        const bytes = Buffer.byteLength(submitted, "utf8");
        const sha256 = createHash("sha256").update(submitted, "utf8").digest("hex");
        const accepted = bytes === expectedBytes && sha256 === expectedSha256;
        attempts.push({ bytes, sha256, accepted, pagesReadBefore: new Set(pageReads).size });
        response.writeHead(accepted ? 201 : 400, { "content-type": "application/json" }).end(JSON.stringify({ status: accepted ? "submitted" : "rejected" }));
      } catch {
        attempts.push({ bytes: null, sha256: null, accepted: false, pagesReadBefore: new Set(pageReads).size });
        response.writeHead(400, { "content-type": "application/json" }).end('{"status":"rejected"}');
      }
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Cannot start manifest fixture");
  return {
    origin: `http://127.0.0.1:${address.port}`, server,
    prompt: "In the manifest desk, copy all 1,200 tracking codes from every page in their displayed order, one per line, and submit the complete manifest once.",
    evidence: () => ({ pageReads: [...pageReads], pageCount, expectedBytes, expectedCodeUnits: manifest.length, expectedSha256, attempts: structuredClone(attempts) }),
  };
}
