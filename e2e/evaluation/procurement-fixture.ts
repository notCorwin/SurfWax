import { createServer, type Server } from "node:http";

type Invoice = {
  id: string;
  region: "APAC" | "EMEA";
  status: "pending" | "paid" | "approved";
  amount: number;
  hold: boolean;
  revision: number;
};
type Attempt = { id: unknown; revision: unknown; decision: unknown; reason: unknown; memo: unknown; accepted: boolean };
export interface ProcurementFixture {
  origin: string;
  server: Server;
  prompt: string;
  evidence(): { invoices: Invoice[]; expectedIds: string[]; attempts: Attempt[] };
}

function eligible(invoice: Invoice): boolean {
  return invoice.status === "pending" && invoice.region === "APAC" && invoice.amount <= 500 && !invoice.hold;
}

export function procurementScore(evidence: ReturnType<ProcurementFixture["evidence"]>): boolean {
  const expected = [...evidence.expectedIds].sort();
  if (evidence.attempts.length !== expected.length || evidence.attempts.some((attempt) => !attempt.accepted || typeof attempt.id !== "string")) return false;
  if (JSON.stringify(evidence.attempts.map((attempt) => attempt.id).sort()) !== JSON.stringify(expected)) return false;
  return evidence.invoices.every((invoice) => expected.includes(invoice.id) ? invoice.status === "approved" : invoice.status !== "approved");
}

/** Seeded business state and all submission attempts stay outside the browser. */
export async function procurementFixture(seed: number): Promise<ProcurementFixture> {
  const values: Array<Omit<Invoice, "id" | "revision">> = [
    { region: "APAC", status: "pending", amount: 500, hold: false },
    { region: "APAC", status: "pending", amount: 240, hold: false },
    { region: "APAC", status: "pending", amount: 499, hold: true },
    { region: "APAC", status: "pending", amount: 501, hold: false },
    { region: "APAC", status: "paid", amount: 120, hold: false },
    { region: "EMEA", status: "pending", amount: 100, hold: false },
    { region: "APAC", status: "pending", amount: 1, hold: false },
    { region: "APAC", status: "pending", amount: 500, hold: true },
    { region: "EMEA", status: "pending", amount: 500, hold: false },
    { region: "APAC", status: "pending", amount: 499, hold: false },
    { region: "APAC", status: "paid", amount: 499, hold: false },
    { region: "APAC", status: "pending", amount: 502, hold: false },
    { region: "APAC", status: "pending", amount: 320, hold: false },
    { region: "EMEA", status: "paid", amount: 200, hold: true },
    { region: "APAC", status: "pending", amount: 400, hold: false },
    { region: "APAC", status: "pending", amount: 1, hold: true },
  ];
  const invoices: Invoice[] = values.map((value, index) => ({ ...value, id: `INV-${seed}-${index + 1}`, revision: 1 }));
  let state = seed >>> 0;
  for (let index = invoices.length - 1; index > 0; index--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const other = state % (index + 1);
    [invoices[index], invoices[other]] = [invoices[other]!, invoices[index]!];
  }
  const expectedIds = invoices.filter(eligible).map((invoice) => invoice.id);
  const attempts: Attempt[] = [];
  const json = (response: import("node:http").ServerResponse, status: number, value: unknown) => response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(value));
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://fixture.local").pathname;
    if (request.method === "GET" && path === "/") {
      const address = server.address();
      if (!address || typeof address === "string") { response.writeHead(500).end(); return; }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><title>Procurement portal</title><main><h1>Procurement portal</h1><p>Invoices awaiting review</p><iframe title="Invoice queue" src="http://localhost:${address.port}/queue" style="width:900px;height:650px"></iframe></main>`);
      return;
    }
    if (request.method === "GET" && path === "/queue") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><title>Invoice queue</title><main><h1>Invoice queue</h1>
        <table><thead><tr><th>Invoice</th><th>Region</th><th>Status</th><th>Action</th></tr></thead><tbody>
        <tr><td></td><td></td><td></td><td><button type="button">Review</button></td></tr><tr><td></td><td></td><td></td><td><button type="button">Review</button></td></tr>
        </tbody></table><button id="previous">Previous page</button><span id="page"></span><button id="next">Next page</button>
        <section id="detail" hidden aria-label="Invoice details"><h2>Invoice details</h2><p id="detail-id"></p><p id="amount"></p><p id="hold"></p>
          <label>Decision <select id="decision"><option value="">Select decision</option><option>Approve</option><option>Reject</option></select></label>
          <label>Reason <select id="reason"><option value="">Select reason</option><option>Within policy</option><option>Exception</option></select></label>
          <label>Memo <input id="memo"></label><button id="submit">Submit review</button><button id="close">Close details</button>
        </section><output id="notice" aria-live="polite"></output></main>
        <script>
          let invoices = [], page = 0, selected = null; const rows = [...document.querySelectorAll('tbody tr')];
          function render() {
            rows.forEach((row, index) => {
              const invoice = invoices[page * rows.length + index]; row.hidden = !invoice;
              if (!invoice) return;
              [...row.cells].slice(0, 3).forEach((cell, i) => cell.textContent = [invoice.id, invoice.region, invoice.status][i]);
              const button = row.querySelector('button'); button.dataset.id = invoice.id; button.setAttribute('aria-label', 'Review ' + invoice.id);
            });
            document.querySelector('#page').textContent = 'Page ' + (page + 1) + ' of ' + Math.max(1, Math.ceil(invoices.length / rows.length));
            document.querySelector('#previous').disabled = page === 0;
            document.querySelector('#next').disabled = (page + 1) * rows.length >= invoices.length;
          }
          function closeDetail() { selected = null; document.querySelector('#detail').hidden = true; }
          document.querySelector('#previous').onclick = () => { if (page > 0) { page--; closeDetail(); render(); } };
          document.querySelector('#next').onclick = () => { if ((page + 1) * rows.length < invoices.length) { page++; closeDetail(); render(); } };
          document.querySelector('#close').onclick = closeDetail;
          document.querySelector('tbody').addEventListener('click', async (event) => {
            const button = event.target.closest('button'); if (!button) return;
            closeDetail(); document.querySelector('#notice').textContent = 'Loading invoice…';
            const result = await fetch('/invoice/' + encodeURIComponent(button.dataset.id));
            if (!result.ok) { document.querySelector('#notice').textContent = 'Unable to load invoice'; return; }
            selected = await result.json();
            document.querySelector('#detail-id').textContent = 'Invoice: ' + selected.id;
            document.querySelector('#amount').textContent = 'Amount: $' + selected.amount;
            document.querySelector('#hold').textContent = 'Hold: ' + (selected.hold ? 'Yes' : 'No');
            document.querySelector('#decision').value = ''; document.querySelector('#reason').value = ''; document.querySelector('#memo').value = '';
            document.querySelector('#detail').hidden = false; document.querySelector('#notice').textContent = '';
          });
          document.querySelector('#submit').onclick = async () => {
            if (!selected) return;
            const button = document.querySelector('#submit'); button.disabled = true;
            try {
              const body = { id:selected.id, revision:selected.revision, decision:document.querySelector('#decision').value, reason:document.querySelector('#reason').value, memo:document.querySelector('#memo').value };
              const result = await fetch('/review', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
              if (result.ok) { const invoice = await result.json(); const index = invoices.findIndex((item) => item.id === invoice.id); if (index >= 0) invoices[index] = invoice; closeDetail(); render(); }
              document.querySelector('#notice').textContent = result.ok ? 'Review submitted for ' + body.id : 'Review rejected for ' + body.id;
            } catch { document.querySelector('#notice').textContent = 'Review failed'; }
            finally { button.disabled = false; }
          };
          fetch('/invoices').then((result) => result.json()).then((value) => { invoices = value; render(); });
        </script>`);
      return;
    }
    if (request.method === "GET" && path === "/invoices") {
      json(response, 200, invoices.map(({ id, region, status }) => ({ id, region, status })));
      return;
    }
    if (request.method === "GET" && path.startsWith("/invoice/")) {
      const invoice = invoices.find((item) => item.id === decodeURIComponent(path.slice("/invoice/".length)));
      // Details come from a separate, asynchronous business service.
      await new Promise((resolve) => setTimeout(resolve, 80));
      json(response, invoice ? 200 : 404, invoice ?? { error: "not found" });
      return;
    }
    if (request.method === "POST" && path === "/review") {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Partial<Attempt>;
        const invoice = invoices.find((item) => item.id === body?.id);
        const accepted = Boolean(invoice && eligible(invoice) && invoice.revision === body?.revision && body.decision === "Approve" && body.reason === "Within policy" && body.memo === "Approved under APAC policy");
        attempts.push({ id: body?.id, revision: body?.revision, decision: body?.decision, reason: body?.reason, memo: body?.memo, accepted });
        if (!accepted) { json(response, 409, { error: "invalid review" }); return; }
        invoice!.status = "approved"; invoice!.revision++;
        json(response, 200, invoice);
      } catch {
        attempts.push({ id: null, revision: null, decision: null, reason: null, memo: null, accepted: false });
        json(response, 400, { error: "invalid request" });
      }
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Cannot start procurement fixture");
  return {
    origin: `http://127.0.0.1:${address.port}`, server,
    prompt: "Review all invoice pages. Approve every pending APAC invoice for $500 or less that is not on hold. For each approval choose Within policy and enter the memo Approved under APAC policy. Leave all other invoices unchanged.",
    evidence: () => ({ invoices: structuredClone(invoices), expectedIds: [...expectedIds], attempts: structuredClone(attempts) }),
  };
}
