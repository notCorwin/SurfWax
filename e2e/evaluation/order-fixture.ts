import { createServer, type Server } from "node:http";

type Order = { order: string; service: string; confirmed: boolean };

export interface OrderFixture {
  origin: string;
  server: Server;
  /** Snapshot lives in the test process and has no corresponding HTTP read/reset endpoint. */
  evidence(): { orders: unknown[]; decoyClicks: number };
}

export function businessScore(evidence: { orders: unknown[]; decoyClicks: number }, order: string, service: string): boolean {
  if (evidence.decoyClicks !== 0 || evidence.orders.length !== 1) return false;
  const actual = evidence.orders[0];
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
  const record = actual as Record<string, unknown>;
  return Object.keys(record).length === 3 && record.order === order && record.service === service && record.confirmed === true;
}

/** A two-origin checkout whose business effects are held outside the browser. */
export async function orderFixture(): Promise<OrderFixture> {
  const orders: unknown[] = [];
  let decoyClicks = 0;
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://fixture.local").pathname;
    if (request.method === "GET" && path === "/") {
      const address = server.address();
      if (!address || typeof address === "string") { response.writeHead(500).end(); return; }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><title>Order Portal</title><main><h1>Order portal</h1><iframe title="Checkout" src="http://localhost:${address.port}/checkout" style="width:540px;height:360px"></iframe><button id="decoy">Submit order</button></main>
        <script>document.querySelector('#decoy').addEventListener('click', () => { void fetch('/decoy', {method:'POST'}); });</script>`);
      return;
    }
    if (request.method === "GET" && path === "/checkout") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><title>Checkout</title><main><label>Order reference <input id="order"></label>
        <label>Service <select id="service"><option value="standard">Standard</option><option value="express">Express</option><option value="economy">Economy</option></select></label>
        <label><input type="checkbox" id="confirmed"> Confirm details</label><button id="submit">Submit order</button><output id="status">Not submitted</output></main>
        <script>document.querySelector('#submit').addEventListener('click', async () => {
          const body = {order:document.querySelector('#order').value, service:document.querySelector('#service').value, confirmed:document.querySelector('#confirmed').checked};
          try { const response = await fetch('/orders', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
            document.querySelector('#status').textContent = response.ok ? 'Submitted ' + body.order : 'Submission failed';
          } catch { document.querySelector('#status').textContent = 'Submission failed'; }
        });</script>`);
      return;
    }
    if (request.method === "POST" && path === "/decoy") {
      decoyClicks += 1;
      response.writeHead(204).end();
      return;
    }
    if (request.method === "POST" && path === "/orders") {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Partial<Order>;
        // Count all attempts, including invalid or duplicated submissions.
        orders.push(value);
        const valid = value && typeof value === "object" && typeof value.order === "string" && typeof value.service === "string" && typeof value.confirmed === "boolean";
        response.writeHead(valid ? 201 : 400, { "content-type": "application/json" }).end(JSON.stringify({ status: valid ? "submitted" : "invalid" }));
      } catch {
        orders.push(null);
        response.writeHead(400).end();
      }
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Cannot start order fixture");
  return { origin: `http://127.0.0.1:${address.port}`, server, evidence: () => ({ orders: structuredClone(orders), decoyClicks }) };
}
