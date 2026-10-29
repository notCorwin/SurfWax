import { once } from "node:events";
import { createServer } from "node:http";
import { expect } from "@playwright/test";
import { test, startProvider, openExtension, dispose, configure, readEvents } from "./fixtures";

test("runs an atomic tool through the text completions endpoint and returns its result to the model", async () => {
  const requests: any[] = [];
  const provider = createServer((request, response) => {
    const headers = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "POST, OPTIONS" };
    if (request.method === "OPTIONS") { response.writeHead(204, headers); response.end(); return; }
    if (request.method !== "POST" || request.url !== "/v1/completions") { response.writeHead(404, headers); response.end(); return; }
    const body: Buffer[] = [];
    request.on("data", (part) => body.push(part));
    request.on("end", () => {
      requests.push(JSON.parse(Buffer.concat(body).toString("utf8")));
      const text = requests.length === 1
        ? `SURFWAX_TOOL_CALLS:${JSON.stringify([{ name: "click", arguments: { target: { by: "css", value: "#completion-button" } } }])}`
        : requests.length === 2 ? "COMPLETION_TASK_DONE" : "Completion task";
      response.writeHead(200, { ...headers, "content-type": "application/json" });
      response.end(JSON.stringify({ id: "completion", object: "text_completion", created: 1, model: "test-model",
        choices: [{ index: 0, text, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    });
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  const address = provider.address();
  if (!address || typeof address === "string") throw new Error("Completion provider did not bind");
  const pages = await startProvider([]);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${pages.origin}/automation`);
    await target.evaluate(() => {
      const button = document.createElement("button"); button.id = "completion-button"; button.textContent = "Submit";
      button.onclick = () => { document.body.dataset.completionClicks = String(Number(document.body.dataset.completionClicks || 0) + 1); };
      document.body.append(button);
    });
    const options = await configure(opened.context, opened.page, `http://127.0.0.1:${address.port}/v1`);
    await options.getByLabel("模型端点协议").click();
    await options.getByRole("option", { name: "OpenAI Completions", exact: true }).click();
    await options.getByRole("button", { name: "保存配置" }).click();
    await expect(options.getByRole("status")).toContainText("配置已保存");
    await options.close(); await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Click Submit once");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("COMPLETION_TASK_DONE", { timeout: 60_000 });
    await expect(target.locator("body")).toHaveAttribute("data-completion-clicks", "1");
    expect(requests[0].prompt).toContain('"name":"click"');
    expect(requests[1].prompt).toContain("SURFWAX_TOOL_RESULTS:");
    expect(requests[1].prompt.startsWith(requests[0].prompt)).toBe(true);
    const events = await readEvents(opened.page);
    expect(events.filter((event) => event.type === "tool.finished" && event.content?.toolName === "click")).toHaveLength(1);
  } finally {
    await dispose(opened.context, opened.userDataDirectory, pages.server);
    await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()));
  }
});
