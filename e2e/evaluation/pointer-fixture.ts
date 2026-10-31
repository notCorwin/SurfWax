import { createServer, type Server } from "node:http";

type Attempt = { parcel: unknown; dock: unknown; witness: unknown; accepted: boolean };

export interface PointerFixture {
  origin: string;
  server: Server;
  prompt: string;
  evidence(): { attempts: Attempt[]; expected: { parcel: string; dock: string } };
}

/** Score every attempted drop, not merely the final visible state. */
export function pointerScore(evidence: ReturnType<PointerFixture["evidence"]>): boolean {
  const attempt = evidence.attempts[0];
  return evidence.attempts.length === 1 && Boolean(attempt?.accepted)
    && attempt?.parcel === evidence.expected.parcel && attempt.dock === evidence.expected.dock;
}

/** Page-reported input evidence detects ordinary bypasses, but is not tamper proof. */
export function pointerInteractionScore(evidence: ReturnType<PointerFixture["evidence"]>): boolean {
  if (!pointerScore(evidence)) return false;
  const witness = evidence.attempts[0]!.witness;
  if (!witness || typeof witness !== "object" || Array.isArray(witness)) return false;
  const record = witness as Record<string, unknown>;
  return record.trustedDown === true && record.trustedMoveHeld === true && record.trustedUp === true
    && typeof record.startScroll === "number" && typeof record.endScroll === "number"
    && record.endScroll > record.startScroll + 100;
}

/** Cross-origin pointer drag to a target outside a nested scrolling viewport. */
export async function pointerFixture(seed: number): Promise<PointerFixture> {
  const expected = { parcel: `Parcel-${seed}-A`, dock: `Dock-${seed}-A` };
  const other = { parcel: `Parcel-${seed}-B`, dock: `Dock-${seed}-B` };
  const parcels = seed % 2 ? [expected, other] : [other, expected];
  const docks = seed % 2 ? [other, expected] : [expected, other];
  const attempts: Attempt[] = [];
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://fixture.local").pathname;
    if (request.method === "GET" && path === "/") {
      const address = server.address();
      if (!address || typeof address === "string") { response.writeHead(500).end(); return; }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><title>Freight portal</title><main><h1>Freight portal</h1><iframe title="Loading desk" src="http://localhost:${address.port}/desk" style="width:720px;height:510px"></iframe></main>`);
      return;
    }
    if (request.method === "GET" && path === "/desk") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><title>Loading desk</title><main><h1>Loading desk</h1><p>Drag each parcel to its dock. Scroll inside the loading area to reach the docks.</p>
        <div id="area" aria-label="Loading area" style="height:300px;overflow:auto;border:1px solid black">
          <section><h2>Parcels</h2>${parcels.map((item) => `<button type="button" data-parcel="${item.parcel}" style="width:150px;height:60px;margin:8px">${item.parcel}</button>`).join("")}</section>
          <div aria-hidden="true" style="height:750px"></div>
          <section><h2>Docks</h2>${docks.map((item) => `<button type="button" data-dock="${item.dock}" style="width:150px;height:60px;margin:8px">${item.dock}</button>`).join("")}</section>
        </div><output id="status" aria-live="polite">No drop</output></main>
        <script>
          const area = document.querySelector('#area'), status = document.querySelector('#status');
          for (const source of document.querySelectorAll('[data-parcel]')) {
            let witness, activePointer;
            source.addEventListener('pointerdown', event => {
              if (event.button !== 0) return;
              activePointer = event.pointerId;
              witness = {trustedDown:event.isTrusted, trustedMoveHeld:false, trustedUp:false, startScroll:area.scrollTop, endScroll:area.scrollTop};
              source.setPointerCapture(event.pointerId);
            });
            source.addEventListener('pointermove', event => {
              if (witness && event.pointerId === activePointer && event.isTrusted && (event.buttons & 1)) witness.trustedMoveHeld = true;
            });
            source.addEventListener('pointerup', async event => {
              if (!witness || event.pointerId !== activePointer) return;
              witness.trustedUp = event.isTrusted && event.button === 0 && event.buttons === 0; witness.endScroll = area.scrollTop;
              const dock = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-dock]')?.dataset.dock ?? null;
              const body = {parcel:source.dataset.parcel, dock, witness}; witness = undefined; activePointer = undefined;
              try { const response = await fetch('/drop', {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(body)}); status.textContent = response.ok ? 'Parcel delivered' : 'Drop rejected'; }
              catch { status.textContent = 'Drop failed'; }
            });
          }
        </script>`);
      return;
    }
    if (request.method === "POST" && path === "/drop") {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
        const accepted = Object.keys(record).sort().join(",") === "dock,parcel,witness"
          && record.parcel === expected.parcel && record.dock === expected.dock;
        attempts.push({ parcel: record.parcel ?? null, dock: record.dock ?? null, witness: record.witness ?? null, accepted });
        response.writeHead(accepted ? 201 : 400, { "content-type": "application/json" }).end(JSON.stringify({ status: accepted ? "delivered" : "rejected" }));
      } catch {
        attempts.push({ parcel: null, dock: null, witness: null, accepted: false });
        response.writeHead(400).end();
      }
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Cannot start pointer fixture");
  return {
    origin: `http://127.0.0.1:${address.port}`, server,
    prompt: `Drag ${expected.parcel} to ${expected.dock} once in the loading desk.`,
    evidence: () => ({ attempts: structuredClone(attempts), expected: { ...expected } }),
  };
}
