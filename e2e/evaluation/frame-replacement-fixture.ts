import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";

type Attempt = { round: unknown; slot: unknown; token: unknown; trusted: unknown; accepted: boolean };
type Item = { round: number; slot: number; token: string };
export interface FrameReplacementFixture {
  origin: string;
  server: Server;
  prompt: string;
  evidence(): { expected: Item[]; attempts: Attempt[]; completed: Item[] };
}

/** All attempts count: a wrong frame, stale click, or duplicate cannot be repaired. */
export function frameReplacementScore(evidence: ReturnType<FrameReplacementFixture["evidence"]>): boolean {
  return evidence.expected.length === 12 && evidence.completed.length === 12 && evidence.attempts.length === 12
    && evidence.expected.every((expected, index) => {
      const actual = evidence.attempts[index], completed = evidence.completed[index];
      return !!actual && !!completed && actual.accepted && actual.round === expected.round && actual.slot === expected.slot
        && actual.token === expected.token && completed.round === expected.round && completed.slot === expected.slot
        && completed.token === expected.token;
    });
}

/** Page-reported isTrusted detects ordinary synthetic clicks, not forged HTTP or adversarial pages. */
export function frameReplacementInteractionScore(evidence: ReturnType<FrameReplacementFixture["evidence"]>): boolean {
  return frameReplacementScore(evidence) && evidence.attempts.every((attempt) => attempt.trusted === true);
}

/** Replace both cross-origin iframe elements on every accepted action. */
export async function frameReplacementFixture(seed: number): Promise<FrameReplacementFixture> {
  const total = 12;
  const expected: Item[] = Array.from({ length: total }, (_, round) => {
    const slot = createHash("sha256").update(`slot:${seed}:${round}`).digest()[0]! & 1;
    return { round, slot, token: createHash("sha256").update(`${seed}:${round}:${slot}`).digest("hex").slice(0, 20) };
  });
  const attempts: Attempt[] = [], completed: Item[] = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture.local"), path = url.pathname;
    if (request.method === "GET" && path === "/") {
      const address = server.address();
      if (!address || typeof address === "string") { response.writeHead(500).end(); return; }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(`<!doctype html><title>Work queue</title><style>#slots{display:flex;gap:12px}</style><main><h1>Work queue</h1>
        <p>Confirm the item marked Next. Wait for the queue to advance before confirming the next item.</p>
        <output id="progress" aria-live="polite">Loading</output><div id="slots"></div></main><script>
          let round=0; const total=${total}, nextSlots=${JSON.stringify(expected.map((item) => item.slot))}, slots=document.querySelector('#slots'), progress=document.querySelector('#progress');
          function render(){
            progress.textContent='Loading'; slots.replaceChildren();
            if(round===total){progress.textContent='Queue complete';return;}
            let ready=0; const next=nextSlots[round];
            for(let slot=0;slot<2;slot++){
              const region=document.createElement('section'); region.dataset.next=String(slot===next);
              const label=document.createElement('h2'); label.textContent=slot===next?'Next':'Waiting';
              const frame=document.createElement('iframe'); frame.title='Work item';frame.style='width:360px;height:160px';
              frame.onload=()=>{if(++ready===2)progress.textContent='Completed '+round+' of '+total;};
              frame.src='http://localhost:${address.port}/item?round='+round+'&slot='+slot;
              region.append(label,frame);slots.append(region);
            }
          }
          addEventListener('message',event=>{
            if(event.origin!=='http://localhost:${address.port}' || !event.data || event.data.kind!=='accepted' || event.data.round!==round) return;
            const frame=slots.querySelector('section[data-next="true"] iframe');
            if(!frame || event.source!==frame.contentWindow) return;
            round++;render();
          });
          render();
        </script>`);
      return;
    }
    if (request.method === "GET" && path === "/item") {
      const round = Number(url.searchParams.get("round")), slot = Number(url.searchParams.get("slot"));
      if (!Number.isInteger(round) || round < 0 || round >= total || (slot !== 0 && slot !== 1)
        || url.searchParams.get("round") === null || url.searchParams.get("slot") === null) { response.writeHead(404).end(); return; }
      const token = createHash("sha256").update(`${seed}:${round}:${slot}`).digest("hex").slice(0, 20);
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(`<!doctype html><title>Work item</title><main><h1>Work item</h1>
        <p>Item ${round + 1} of ${total}</p><button type="button">Confirm</button><output id="status">Ready</output></main><script>
          document.querySelector('button').onclick=async event=>{
            const response=await fetch('/confirm',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({round:${round},slot:${slot},token:${JSON.stringify(token)},trusted:event.isTrusted})});
            document.querySelector('#status').textContent=response.ok?'Confirmed':'Rejected';
            if(response.ok)parent.postMessage({kind:'accepted',round:${round}},'http://127.0.0.1:${addressPort(server)}');
          };
        </script>`);
      return;
    }
    if (request.method === "POST" && path === "/confirm") {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const body = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
        const current = expected[completed.length];
        const validKeys = Object.keys(body).sort().join(",") === "round,slot,token,trusted" && typeof body.trusted === "boolean";
        const accepted = validKeys && !!current && body.round === current.round && body.slot === current.slot && body.token === current.token;
        attempts.push({ round: body.round ?? null, slot: body.slot ?? null, token: body.token ?? null, trusted: body.trusted ?? null, accepted });
        if (accepted) completed.push({ ...current! });
        response.writeHead(accepted ? 200 : 409, { "cache-control": "no-store" }).end();
      } catch { attempts.push({ round: null, slot: null, token: null, trusted: null, accepted: false }); response.writeHead(400).end(); }
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { origin: `http://127.0.0.1:${addressPort(server)}`, server,
    prompt: "Confirm the item marked Next, one at a time, until all 12 items are complete. Do not confirm Waiting items.",
    evidence: () => structuredClone({ expected, attempts, completed }) };
}

function addressPort(server: Server): number {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Cannot determine fixture port");
  return address.port;
}
