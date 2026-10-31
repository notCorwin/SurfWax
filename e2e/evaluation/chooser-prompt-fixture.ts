import { createServer, type Server } from "node:http";

type Attempt = { desk: string; name: unknown; contents: unknown; answer: unknown; accepted: boolean };

export interface ChooserPromptFixture {
  origin: string;
  server: Server;
  prompt: string;
  evidence(): { expected: { name: string; contents: string; answer: string }; attempts: Attempt[] };
}

/** Every submission, including a cancelled prompt or a wrong desk, remains in the ledger. */
export function chooserPromptScore(evidence: ReturnType<ChooserPromptFixture["evidence"]>): boolean {
  if (evidence.attempts.length !== 1) return false;
  const attempt = evidence.attempts[0]!;
  return attempt.accepted && attempt.desk === "intake" && attempt.name === evidence.expected.name
    && attempt.contents === evidence.expected.contents && attempt.answer === evidence.expected.answer;
}

/** A file chooser whose change handler immediately opens a native confirmation prompt. */
export async function chooserPromptFixture(seed: number): Promise<ChooserPromptFixture> {
  const expected = { name: `receipt-${seed}.txt`, contents: `Receipt ${seed} — 海 🌊`, answer: `CONFIRM-${seed}-${(Math.imul(seed, 7919) >>> 0).toString(36).toUpperCase()}` };
  const attempts: Attempt[] = [];
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://fixture.local").pathname;
    if (request.method === "GET" && path === "/") {
      const address = server.address();
      if (!address || typeof address === "string") { response.writeHead(500).end(); return; }
      const frames = [
        `<iframe title="Intake desk" src="http://localhost:${address.port}/intake" style="width:600px;height:260px"></iframe>`,
        `<iframe title="Archive desk" src="http://127.0.0.1:${address.port}/archive" style="width:600px;height:260px"></iframe>`,
      ];
      if (seed % 2 === 0) frames.reverse();
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><title>Receipt portal</title><main><h1>Receipt portal</h1>
        ${frames.join("")}</main>`);
      return;
    }
    if (request.method === "GET" && (path === "/intake" || path === "/archive")) {
      const desk = path.slice(1);
      const title = desk === "intake" ? "Intake desk" : "Archive desk";
      const data = desk === "intake" ? expected : { name: `archive-${seed}.txt`, contents: `Archive ${seed}`, answer: `ARCHIVE-${seed}` };
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><title>${title}</title><main><h1>${title}</h1>
        <p>File name: <strong id="filename"></strong></p><p>File contents: <strong id="contents"></strong></p><p>Confirmation code: <strong id="answer"></strong></p>
        <input type="file" id="file" hidden><button type="button" id="choose">Choose receipt</button><output id="status" aria-live="polite">No receipt submitted</output></main>
        <script>
          const data = ${JSON.stringify(data)};
          for (const key of ['filename','contents','answer']) document.querySelector('#'+key).textContent = key === 'filename' ? data.name : data[key];
          const input = document.querySelector('#file');
          document.querySelector('#choose').onclick = () => input.click();
          input.onchange = () => {
            const answer = prompt('Enter the confirmation code displayed on this desk');
            const file = input.files[0];
            void (async () => {
              try {
                const body = {name:file?.name ?? null, contents:file ? await file.text() : null, answer};
                const response = await fetch('/receive/${desk}', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
                document.querySelector('#status').textContent = response.ok ? 'Receipt accepted' : 'Receipt rejected';
              } catch { document.querySelector('#status').textContent = 'Receipt failed'; }
            })();
          };
        </script>`);
      return;
    }
    if (request.method === "POST" && (path === "/receive/intake" || path === "/receive/archive")) {
      const desk = path.slice("/receive/".length);
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
        const accepted = Object.keys(body).sort().join(",") === "answer,contents,name" && desk === "intake"
          && body.name === expected.name && body.contents === expected.contents && body.answer === expected.answer;
        attempts.push({ desk, name: body.name ?? null, contents: body.contents ?? null, answer: body.answer ?? null, accepted });
        response.writeHead(accepted ? 201 : 400, { "content-type": "application/json" }).end(JSON.stringify({ status: accepted ? "accepted" : "rejected" }));
      } catch {
        attempts.push({ desk, name: null, contents: null, answer: null, accepted: false });
        response.writeHead(400, { "content-type": "application/json" }).end('{"status":"rejected"}');
      }
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Cannot start receipt fixture");
  return { origin: `http://127.0.0.1:${address.port}`, server,
    prompt: `At the intake desk, upload the displayed receipt file and enter its displayed confirmation code when prompted. Submit once.`,
    evidence: () => ({ expected: { ...expected }, attempts: structuredClone(attempts) }) };
}
