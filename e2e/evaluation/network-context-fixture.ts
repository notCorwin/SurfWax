import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";

type PrivateRead = { authenticated: boolean };
type PublicRead = { origin: string | null; pageOrigin: boolean };
type Submission = { privateMatch: boolean; publicMatch: boolean; accepted: boolean };
export interface NetworkContextFixture {
  origin: string;
  publicOrigin: string;
  privateServer: Server;
  publicServer: Server;
  prompt: string;
  evidence(): { privateReads: PrivateRead[]; publicReads: PublicRead[]; submissions: Submission[] };
}

/** Business and request counts cannot prove which browser execution context was used. */
export function networkContextScore(evidence: ReturnType<NetworkContextFixture["evidence"]>): boolean {
  const submission = evidence.submissions[0];
  return evidence.privateReads.length === 1 && evidence.privateReads[0]?.authenticated === true
    && (evidence.publicReads.length === 1 || evidence.publicReads.length === 2 && evidence.publicReads[0]?.pageOrigin === true)
    && evidence.submissions.length === 1
    && submission?.privateMatch === true && submission.publicMatch === true && submission.accepted === true;
}

/** The private code requires the page's HttpOnly cookie; the other origin sends no CORS headers. */
export async function networkContextFixture(seed: number): Promise<NetworkContextFixture> {
  if (!Number.isSafeInteger(seed)) throw new Error("Invalid network context seed");
  const nonce = randomBytes(24).toString("hex");
  const token = (label: string) => createHash("sha256").update(`${seed}:${nonce}:${label}`).digest("hex");
  const session = token("session"), privateCode = token("private"), publicCode = token("public");
  const privateReads: PrivateRead[] = [], publicReads: PublicRead[] = [], submissions: Submission[] = [];
  let privateOrigin = "";
  const publicServer = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture.local");
    if (request.method === "GET" && url.pathname === "/public-code") {
      const origin = typeof request.headers.origin === "string" ? request.headers.origin : null;
      publicReads.push({ origin, pageOrigin: !!privateOrigin && origin === privateOrigin });
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify({ code: publicCode }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => { publicServer.once("error", reject); publicServer.listen(0, "127.0.0.1", resolve); });
  const publicAddress = publicServer.address();
  if (!publicAddress || typeof publicAddress === "string") throw new Error("Cannot start public network fixture");
  const publicOrigin = `http://127.0.0.1:${publicAddress.port}`;
  const privateServer = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture.local");
    if (request.method === "GET" && url.pathname === "/") {
      const address = privateServer.address();
      if (!address || typeof address === "string") { response.writeHead(500).end(); return; }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
        "set-cookie": `handoff=${session}; HttpOnly; SameSite=Strict; Path=/` }).end(`<!doctype html><title>Network code desk</title><main><h1>Network code desk</h1>
          <p>Read both codes and submit them once.</p><p>Private code URL: <code id="private-url">http://127.0.0.1:${address.port}/private-code</code></p>
          <p>Public code URL: <code id="public-url">${publicOrigin}/public-code</code></p>
          <label>Private code <input id="private-code"></label><label>Public code <input id="public-code"></label>
          <button type="button" id="submit">Submit codes</button><output id="status" aria-live="polite">Not submitted</output></main>
          <script>document.querySelector('#submit').onclick=async()=>{const response=await fetch('/submit',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({privateCode:document.querySelector('#private-code').value,publicCode:document.querySelector('#public-code').value})});document.querySelector('#status').textContent=response.ok?'Submitted':'Rejected';};</script>`);
      return;
    }
    if (request.method === "GET" && url.pathname === "/private-code") {
      const cookies = (request.headers.cookie ?? "").split(/;\s*/);
      const authenticated = cookies.includes(`handoff=${session}`);
      privateReads.push({ authenticated });
      response.writeHead(authenticated ? 200 : 401, { "content-type": "application/json", "cache-control": "no-store" })
        .end(JSON.stringify(authenticated ? { code: privateCode } : { error: "unauthorized" }));
      return;
    }
    if (request.method === "POST" && url.pathname === "/submit") {
      try {
        const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
        const privateMatch = body.privateCode === privateCode, publicMatch = body.publicCode === publicCode;
        const accepted = Object.keys(body).sort().join(",") === "privateCode,publicCode" && privateMatch && publicMatch && submissions.length === 0;
        submissions.push({ privateMatch, publicMatch, accepted });
        response.writeHead(accepted ? 201 : 400, { "content-type": "application/json" }).end(JSON.stringify({ status: accepted ? "submitted" : "rejected" }));
      } catch {
        submissions.push({ privateMatch: false, publicMatch: false, accepted: false });
        response.writeHead(400).end();
      }
      return;
    }
    response.writeHead(404).end();
  });
  try {
    await new Promise<void>((resolve, reject) => { privateServer.once("error", reject); privateServer.listen(0, "127.0.0.1", resolve); });
    const address = privateServer.address();
    if (!address || typeof address === "string") throw new Error("Cannot start private network fixture");
    privateOrigin = `http://127.0.0.1:${address.port}`;
    return { origin: privateOrigin, publicOrigin, privateServer, publicServer,
      prompt: "Read the private and public codes at the network code desk, then submit both once.",
      evidence: () => structuredClone({ privateReads, publicReads, submissions }) };
  } catch (error) {
    publicServer.close();
    throw error;
  }
}
