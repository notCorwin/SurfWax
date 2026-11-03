import { createServer } from "node:http";
import { once } from "node:events";
import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, closeServer, type MockResponse } from "./fixtures";

const lastTool = (request: any) => {
  const content = request.messages.findLast((entry: any) => entry.role === "tool").content;
  return JSON.parse(Array.isArray(content) ? content.find((part: any) => part.type === "text").text : content);
};

// Exercises the model-facing catalog and actual side effects, not a model's decision-making.
test("purpose-specific tools fetch data and finish a dialog-blocked form submission", async () => {
  test.setTimeout(90_000);
  const submitted: string[] = [];
  const server = createServer((request, response) => {
    if (request.url === "/data") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ reference: "REF-42" }));
    } else if (request.url === "/submit" && request.method === "POST") {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => { submitted.push(body); response.writeHead(204).end(); });
    } else {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><title>Purpose tools</title>
        <ul><li data-code="A">First</li><li data-code="B">Second</li></ul>
        <label>Reference <input id="reference"></label><button id="submit">Submit</button><output>Pending</output>
        <script>document.querySelector('#submit').onclick = async () => {
          const answer = prompt('Confirm submission?');
          if (answer !== 'yes') return;
          await fetch('/submit', {method:'POST', body:document.querySelector('#reference').value});
          document.querySelector('output').textContent = 'Submitted';
        };</script>`);
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port");
  const origin = `http://127.0.0.1:${address.port}`;
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    const target = await opened.context.newPage();
    await target.goto(origin);
    target.on("dialog", () => {});
    let jobId = "", subscriptionId = "", polls = 0;
    const poll: MockResponse = (request) => {
      const result = lastTool(request);
      if (result.terminal) {
        expect(result).toMatchObject({ ok: true, state: "succeeded" });
        return textResponse("PURPOSE_TOOLS_DONE");
      }
      responses.unshift(poll);
      return commandResponse("get_job", { jobId, after: result.nextCursor, waitMs: 10_000 }, `purpose-poll-${++polls}`);
    };
    responses.push(
      (request) => {
        const names = request.tools.map((item: any) => item.function.name);
        expect(names).toEqual(expect.arrayContaining(["read_elements", "send_page_request", "fill", "click", "subscribe_event", "wait_event", "handle_dialog", "get_job"]));
        expect(names).not.toEqual(expect.arrayContaining(["execute_program"]));
        expect(names).not.toEqual(expect.arrayContaining(["evaluate_js"]));
        expect(names).not.toEqual(expect.arrayContaining(["send_cdp"]));
        return commandResponse("read_elements", { target: { by: "css", value: "li" }, limit: 1, attributes: ["data-code"] }, "read-first-item");
      },
      (request) => {
        expect(lastTool(request)).toMatchObject({ ok: true, result: { total: 2, items: [{ index: 0, text: "First", attributes: { "data-code": "A" } }], nextOffset: 1 } });
        return commandResponse("read_elements", { target: { by: "css", value: "li" }, offset: 1, limit: 1, attributes: ["data-code"] }, "read-second-item");
      },
      (request) => {
        expect(lastTool(request)).toMatchObject({ ok: true, result: { total: 2, items: [{ index: 1, text: "Second", attributes: { "data-code": "B" } }] } });
        return commandResponse("send_page_request", { url: `${origin}/data` }, "read-reference");
      },
      (request) => {
        const result = lastTool(request);
        expect(result).toMatchObject({ ok: true, result: { status: 200 } });
        const reference = JSON.parse(result.result.body).reference;
        expect(reference).toBe("REF-42");
        return commandResponse("fill", { target: { by: "label", value: "Reference" }, value: reference }, "fill-reference");
      },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true }); return commandResponse("subscribe_event", { kind: "dialog" }, "subscribe-dialog"); },
      (request) => { subscriptionId = lastTool(request).subscriptionId; expect(subscriptionId).toEqual(expect.any(String)); return commandResponse("click", { target: { by: "css", value: "#submit" }, background: true, timeoutMs: 30_000 }, "submit-form"); },
      (request) => { const result = lastTool(request); expect(result).toMatchObject({ accepted: true, complete: false }); jobId = result.jobId; return commandResponse("wait_event", { subscriptionId, waitMs: 10_000 }, "wait-dialog"); },
      (request) => {
        const dialog = lastTool(request).events.find((event: any) => event.kind === "dialog");
        expect(dialog.payload.message).toBe("Confirm submission?");
        return commandResponse("handle_dialog", { dialogId: dialog.payload.dialogId, accept: true, prompt: "yes" }, "answer-dialog");
      },
      (request) => { expect(lastTool(request)).toMatchObject({ state: "completed" }); return commandResponse("get_job", { jobId, waitMs: 10_000 }, "submit-job"); },
      poll,
      textResponse("Submit the reference"),
    );
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Fetch the reference and submit it.");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("PURPOSE_TOOLS_DONE", { timeout: 70_000 });
    await expect(target.locator("output")).toHaveText("Submitted");
    expect(submitted).toEqual(["REF-42"]);
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
    await closeServer(server);
  }
});
