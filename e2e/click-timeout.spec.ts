import { expect } from "@playwright/test";
import {
  commandResponse,
  configure,
  dispose,
  openExtension,
  startProvider,
  test,
  textResponse,
  type MockResponse,
} from "./fixtures";

const lastTool = (request: any) => {
  const content = request.messages.findLast(
    (entry: any) => entry.role === "tool",
  ).content;
  return JSON.parse(
    Array.isArray(content)
      ? content.find((part: any) => part.type === "text").text
      : content,
  );
};

test("a covered click returns promptly with the page and can be retried after dismissing the overlay", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    await (
      await configure(opened.context, opened.page, provider.baseURL)
    ).close();
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    await target.evaluate(() => {
      document.body.innerHTML =
        '<button id="target">Open lesson</button><div id="overlay" style="position:fixed;inset:0;background:white"><button id="dismiss">Dismiss overlay</button></div>';
      document.querySelector("#target")!.addEventListener("click", () => {
        document.body.dataset.clicked = "yes";
      });
      document
        .querySelector("#dismiss")!
        .addEventListener("click", () =>
          document.querySelector("#overlay")!.remove(),
        );
    });
    let elapsed = 0;
    responses.push(
      () => {
        elapsed = Date.now();
        return commandResponse(
          "click",
          { target: { by: "css", value: "#target" } },
          "covered",
        );
      },
      (request) => {
        elapsed = Date.now() - elapsed;
        expect(elapsed).toBeLessThan(4_000);
        expect(lastTool(request), JSON.stringify(lastTool(request).error)).toMatchObject({
          ok: false,
          error: { code: "intercepted" },
          timeoutMs: 5_000,
          timeoutSource: "default",
          pageSnapshot: expect.any(Object),
        });
        expect(JSON.stringify(lastTool(request).pageSnapshot)).toContain(
          "Dismiss overlay",
        );
        return commandResponse(
          "click",
          { target: { by: "css", value: "#dismiss" } },
          "dismiss",
        );
      },
      (request) => {
        expect(lastTool(request)).toMatchObject({ ok: true });
        return commandResponse(
          "click",
          { target: { by: "css", value: "#target" }, timeoutMs: 10_000 },
          "retry",
        );
      },
      (request) => {
        expect(lastTool(request)).toMatchObject({
          ok: true,
          timeoutMs: 10_000,
          timeoutSource: "explicit",
        });
        return textResponse("CLICK_RECOVERED");
      },
      textResponse("点击恢复"),
    );
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Open the lesson");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText(
      "CLICK_RECOVERED",
      { timeout: 30_000 },
    );
    await expect(target.locator("body")).toHaveAttribute("data-clicked", "yes");
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});

// Exercise production tools without a provider, through the standalone CDP adapter.
test("atomic targets fail promptly and imports preserve dispatch certainty", async () => {
  const { chromium } = await import("@playwright/test");
  const { createServer } = await import("node:http");
  const { connectToolRuntime } = await import("../src/standalone/runtime");
  const reserve = createServer();
  await new Promise<void>((resolve) => reserve.listen(0, "127.0.0.1", resolve));
  const port = (reserve.address() as { port: number }).port;
  await new Promise<void>((resolve) => reserve.close(() => resolve()));
  let hits = 0;
  let onFetch: (() => void) | undefined;
  const server = createServer((req, res) => {
    if (req.url === "/file" || req.url === "/slow") {
      hits++;
      if (req.url === "/slow") {
        onFetch?.();
        return;
      }
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("original bytes");
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    if (req.url === "/frame")
      res.end(
        '<a href="/file" download="manifest.txt">Download manifest</a><label>Identity<input></label>',
      );
    else
      res.end(
        `<a href="/file" download>Duplicate</a><a href="/file" download>Duplicate</a><a href="/file" download="bound.txt">Bound</a><a href="/slow" download="slow.txt">Slow</a><label>Repeated<input></label><label>Repeated<input></label><input aria-label="Disabled" disabled><iframe src="http://localhost:${(server.address() as { port: number }).port}/frame"></iframe>`,
      );
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = await chromium.launch({
    headless: true,
    chromiumSandbox: true,
    executablePath: process.env.SURFWAX_CHROME_PATH,
    args: [`--remote-debugging-port=${port}`],
  });
  const page = await browser.newPage();
  await page.goto(origin);
  const runtime = await connectToolRuntime(`http://127.0.0.1:${port}`);
  const call = (name: string, input: unknown, signal?: AbortSignal) =>
    runtime.call(name, input, signal) as Promise<any>;
  const link = (name: string, frame?: object) => ({
    by: "role",
    value: "link",
    name,
    exact: true,
    ...(frame ? { frame } : {}),
  });
  const originalAppend = runtime.logger.append.bind(runtime.logger);
  try {
    for (const [name, input, code] of [
      [
        "import_file_from_link",
        { target: link("Download manifest") },
        "not-found",
      ],
      ["import_file_from_link", { target: link("Duplicate") }, "strict-mode"],
      [
        "import_file_from_link",
        { target: link("Bound", { by: "css", value: "iframe.missing" }) },
        "not-found",
      ],
      [
        "fill",
        { target: { by: "label", value: "Identity" }, value: "test" },
        "not-found",
      ],
      [
        "fill",
        { target: { by: "label", value: "Repeated" }, value: "test" },
        "strict-mode",
      ],
    ] as const) {
      const started = Date.now();
      const result = await call(name, input);
      expect(Date.now() - started).toBeLessThan(4_000);
      expect(result).toMatchObject({
        ok: false,
        error: { code, effectUnknown: false },
      });
      expect(JSON.stringify(result)).toContain("list_frames");
      expect(hits).toBe(0);
    }
    expect(
      await call("fill", {
        target: { by: "label", value: "Disabled" },
        value: "test",
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "disabled", effectUnknown: false },
    });
    expect(
      await call("fill", {
        target: {
          by: "label",
          value: "Identity",
          frame: { by: "css", value: "iframe" },
        },
        value: "frame value",
      }),
    ).toMatchObject({ ok: true });
    await expect(page.frameLocator("iframe").locator("input")).toHaveValue(
      "frame value",
    );
    expect(
      await call("import_file_from_link", {
        target: link("Download manifest", { by: "css", value: "iframe" }),
      }),
    ).toMatchObject({ ok: true });
    expect(hits).toBe(1);
    const found = await call("find_elements", {
      target: link("Download manifest", { by: "css", value: "iframe" }),
    });
    const id = found.elements[0].id;
    expect(
      await call("import_file_from_link", { target: { id } }),
    ).toMatchObject({ ok: true });
    expect(hits).toBe(2);

    // Replace the resolved node at the persistence boundary before page dispatch.
    runtime.logger.append = async (...args) => {
      const event = args[0] as any;
      if (
        event.type === "browser.job.progress" &&
        event.content?.operation === "artifacts.importLink" &&
        event.content?.state === "dispatched-unknown"
      ) {
        await page
          .getByRole("link", { name: "Bound", exact: true })
          .evaluate((el) => el.replaceWith(el.cloneNode(true)));
      }
      return originalAppend(...args);
    };
    expect(
      await call("import_file_from_link", { target: link("Bound") }),
    ).toMatchObject({
      ok: false,
      error: { code: "detached", effectUnknown: true },
    });
    expect(hits).toBe(2);

    // Cancellation during artifact persistence is after the fetch dispatch.
    const persisting = new AbortController();
    runtime.logger.append = async (...args) => {
      const event = args[0] as any;
      const result = await originalAppend(...args);
      if (event.type === "tool.result.data") persisting.abort();
      return result;
    };
    expect(
      await call(
        "import_file_from_url",
        { url: `${origin}/file`, filename: "persisted.txt" },
        persisting.signal,
      ),
    ).toMatchObject({ ok: false, error: { effectUnknown: true } });
    expect(hits).toBe(3);
    const completed = new AbortController();
    runtime.logger.append = async (...args) => {
      const event = args[0] as any;
      const result = await originalAppend(...args);
      if (
        event.type === "browser.job.progress" &&
        event.content?.operation === "artifacts.importUrl" &&
        event.content?.state === "completed"
      )
        completed.abort();
      return result;
    };
    expect(
      await call(
        "import_file_from_url",
        { url: `${origin}/file`, filename: "completed.txt" },
        completed.signal,
      ),
    ).toMatchObject({ ok: false, error: { effectUnknown: true } });
    runtime.logger.append = originalAppend;
    const cancelledJob = runtime.events.filter(
      (event) =>
        event.type === "browser.job.state" &&
        (event.content as any)?.state === "cancelled",
    ).at(-1)!;
    const cancelledJobId = (cancelledJob.content as any).jobId;
    // Completing a later import cannot settle the previous unknown job.
    expect(
      await call("import_file_from_url", {
        url: `${origin}/file`,
        filename: "later.txt",
      }),
    ).toMatchObject({ ok: true });
    expect(hits).toBe(5);
    const preserved = await call("get_job", { jobId: cancelledJobId });
    expect(preserved).toMatchObject({ terminal: true });
    expect(JSON.stringify(preserved)).toContain('"effectUnknown":true');

    const before = new AbortController();
    runtime.logger.append = async (...args) => {
      const event = args[0] as any;
      const result = await originalAppend(...args);
      if (
        event.type === "browser.job.progress" &&
        event.content?.operation === "artifacts.importLink" &&
        event.content?.state === "not-dispatched"
      )
        before.abort();
      return result;
    };
    expect(
      await call(
        "import_file_from_link",
        { target: link("Bound") },
        before.signal,
      ),
    ).toMatchObject({ ok: false, error: { effectUnknown: false } });
    expect(hits).toBe(5);
    runtime.logger.append = originalAppend;
    onFetch = undefined;
    setTimeout(() => {
      void page.evaluate(() => {
        const input = document.createElement("input");
        input.id = "later";
        document.body.append(input);
      });
    }, 150);
    expect(
      await call("verify_state", {
        target: { by: "css", value: "#later" },
        state: "visible",
        timeoutMs: 3_000,
      }),
    ).toMatchObject({ ok: true });
    for (const name of ["import_file_from_url", "import_file_from_link"]) {
      const after = new AbortController();
      onFetch = () => after.abort();
      const input =
        name === "import_file_from_link"
          ? { target: link("Slow") }
          : { url: `${origin}/slow`, filename: "slow.txt" };
      expect(await call(name, input, after.signal)).toMatchObject({
        ok: false,
        error: { effectUnknown: true },
      });
    }
    expect(hits).toBe(7);
    const terminals = runtime.events.filter(
      (event) =>
        event.type === "browser.job.state" &&
        (event.content as any)?.state === "cancelled",
    );
    expect(JSON.stringify(terminals)).toContain('"effectUnknown":false');
    expect(JSON.stringify(terminals)).toContain('"effectUnknown":true');
  } finally {
    runtime.logger.append = originalAppend;
    await runtime.close();
    await browser.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
