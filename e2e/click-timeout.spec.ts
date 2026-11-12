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
test("atomic targets fail promptly and file operations preserve dispatch certainty", async () => {
  const { chromium } = await import("@playwright/test");
  const { createServer } = await import("node:http");
  const { connectToolRuntime } = await import("../src/standalone/runtime");
  const { CdpConnection } = await import("../src/standalone/cdp");
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
        `<title>Native tab title</title><a href="/file" download>Duplicate</a><a href="/file" download>Duplicate</a><a href="/file" download="bound.txt">Bound</a><a href="/slow" download="slow.txt">Slow</a><label>Repeated<input></label><label>Repeated<input></label><input aria-label="Disabled" disabled><iframe src="http://localhost:${(server.address() as { port: number }).port}/frame"></iframe>`,
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
    // A plain, unclipped line isolates native focus-outline evidence. The
    // original underlined link is not assumed readable by this regression.
    await page.frameLocator("iframe").locator("body").evaluate((body) => {
      const text = document.createElement("p");
      text.id = "outline-distant";
      text.textContent = "Outline clear";
      text.style.cssText = "position:absolute;left:180px;top:90px;width:110px;margin:0;white-space:nowrap";
      body.append(text);
    });
    const plainText = { by: "css", value: "#outline-distant", frame: { by: "css", value: "iframe" } };
    const geometry = await page.frameLocator("iframe").locator("#outline-distant").evaluate((element) => {
      const range = document.createRange(); range.selectNodeContents(element);
      const rect = range.getBoundingClientRect();
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: innerWidth, height: innerHeight };
    });
    expect(geometry.left).toBeGreaterThanOrEqual(0); expect(geometry.top).toBeGreaterThanOrEqual(0);
    expect(geometry.right).toBeLessThanOrEqual(geometry.width); expect(geometry.bottom).toBeLessThanOrEqual(geometry.height);
    expect(await page.frameLocator("iframe").locator("input").evaluate((input) => input === document.activeElement)).toBe(true);
    expect(await call("read_text", { target: plainText })).toMatchObject({ ok: true, result: "Outline clear" });
    // The extension-free host must supply real closed roots, not an empty
    // compatibility array that would miss parent-document foreground paint.
    await page.evaluate(() => {
      const host = document.createElement("div"); host.id = "native-shadow-cover";
      const root = host.attachShadow({ mode: "closed" }), cover = document.createElement("div"), rect = document.querySelector("iframe")!.getBoundingClientRect();
      cover.style.cssText = `position:fixed;background:white;z-index:2147483647;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px`;
      root.append(cover); document.body.append(host);
    });
    expect(await call("read_text", { target: plainText })).toMatchObject({ ok: false, error: { code: "text-unavailable" } });
    await page.locator("#native-shadow-cover").evaluate((element) => element.remove());
    expect(await call("read_text", { target: plainText })).toMatchObject({ ok: true, result: "Outline clear" });
    expect(await page.frameLocator("iframe").locator("input").evaluate((input) => input === document.activeElement)).toBe(true);
    const identity = runtime.events.find((event) => event.type === "tool.started")!;
    const runProgram = (code: string, toolCallId: string, signal?: AbortSignal, timeoutMs?: number) => runtime.executor.runProgram({ code, ...(timeoutMs === undefined ? {} : { timeoutMs }) }, signal, {
      conversationId: identity.conversationId!, toolCallId,
      logIdentity: runtime.logger.toolIdentity(identity.conversationId!, toolCallId),
    });
    // The same reference is rebound under a native semantic parent, then read
    // through hasText in the API-less isolated world (real census required).
    await page.frameLocator("iframe").locator("body").evaluate((body) => {
      const list = document.createElement("div"); list.id = "nested-proof"; list.setAttribute("role", "list");
      list.style.cssText = "position:absolute;left:180px;top:60px;width:110px";
      const item = document.createElement("div"); item.id = "nested-proof-item"; item.setAttribute("role", "listitem"); item.textContent = "Proof row";
      list.append(item); body.append(list);
    });
    const nested = await call("find_elements", { target: { by: "css", value: "#nested-proof-item", frame: { by: "css", value: "iframe" } } });
    const nestedId = nested.elements[0].id;
    expect(await runProgram(`return await page.frameLocator('iframe').getByRole('list').filter({has:page.ref(${JSON.stringify(nestedId)}).filter({hasText:'Proof row'})}).count();`, "nested-native-ref-text")).toMatchObject({ ok: true, result: 1 });
    await page.frameLocator("iframe").locator("#nested-proof").evaluate((element) => element.remove());

    // A real marker dependency cannot certify an animated font. Its ordinary
    // fallback returns an unproved empty set, not evidence of absent text.
    // Even that terminal number still needs the original world/deadline guard.
    await page.evaluate(() => {
      const host = document.createElement("section"); host.id = "fallback-proof";
      host.style.cssText = "position:absolute;left:500px;top:300px";
      host.innerHTML = '<ol><li>Animated marker</li></ol>'; document.body.append(host);
      host.querySelector("li")!.animate([{ fontSize: "16px" }, { fontSize: "17px" }], { duration: 1000, iterations: Infinity });
    });
    const proofCode = "return await page.locator('#fallback-proof li').filter({hasText:'Animated marker'}).count();";
    const proofSend = CdpConnection.prototype.send, proofChecks: any[] = [], proofOriginalUrl = page.url();
    let proofPhase: "fresh" | "navigate" | "deadline" | undefined;
    let capturedDeadline = 0, fallbackSeen = false, gateFinished = false, lateReads = 0, timerFired = false;
    let proofTimer: ReturnType<typeof setTimeout> | undefined;
    CdpConnection.prototype.send = async function (method, params: any = {}, sessionId) {
      const source = String(params.functionDeclaration ?? "");
      if (gateFinished && (method.startsWith("DOM.") || method === "Runtime.callFunctionOn" && (source.includes("createRenderedTextReader") || source.includes("{frameOwner:this,acceptFrame:")))) lateReads++;
      const result = await proofSend.call(this, method, params, sessionId);
      if (source.includes("prepareMarkerQuery")) capturedDeadline = params.arguments[1].value;
      const fallback = method === "Runtime.callFunctionOn" && source.includes("createRenderedTextReader") && source.includes("globalThis[key]=undefined");
      if (fallback) fallbackSeen = true;
      if (!proofPhase || !fallback) return result;
      const phase = proofPhase; proofPhase = undefined;
      const check: any = { phase, fallbackSeen, nativeValue: result.result?.value, capturedDeadline };
      if (phase === "navigate") {
        let resolve!: () => void, resolveRestored!: () => void, navigationTimer: ReturnType<typeof setTimeout> | undefined;
        const navigated = new Promise<void>((done) => { resolve = done; }), restored = new Promise<void>((done) => { resolveRestored = done; });
        const expired = new Promise((_, reject) => { navigationTimer = setTimeout(() => reject(new Error("Expected native same-document events")), 2000); });
        const listener = (message: any) => {
          if (message.sessionId !== sessionId || message.method !== "Page.navigatedWithinDocument") return;
          if (message.params.url === proofOriginalUrl) { check.nativeRestoration = true; resolveRestored(); }
          else { check.nativeNavigation = true; resolve(); }
        };
        this.listeners.add(listener);
        try {
          await proofSend.call(this, "Runtime.evaluate", { expression: "history.pushState(null,'','#fallback-guard')", returnByValue: true }, sessionId);
          await Promise.race([navigated, expired]);
          // URL equality does not undo the original world's invalidation.
          await proofSend.call(this, "Runtime.evaluate", { expression: `history.replaceState(null,'',${JSON.stringify(proofOriginalUrl)})`, returnByValue: true }, sessionId);
          await Promise.race([restored, expired]);
        } finally { clearTimeout(navigationTimer); this.listeners.delete(listener); }
      }
      if (phase === "deadline") {
        if (!Number.isSafeInteger(capturedDeadline) || capturedDeadline < Date.now() || capturedDeadline - Date.now() > 2000) throw new Error("Native deadline gate was not reached in time");
        // Delay this process's timer phase, not Chrome or the operation clock.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, capturedDeadline - Date.now() + 25);
        check.deliveredAt = Date.now(); check.timerFiredAtDelivery = timerFired;
      }
      proofChecks.push(check); gateFinished = phase !== "fresh"; return result;
    };
    try {
      for (const phase of ["fresh", "navigate", "deadline"] as const) {
        proofPhase = phase; capturedDeadline = 0; fallbackSeen = false; gateFinished = false; lateReads = 0; timerFired = false;
        if (phase === "deadline") proofTimer = setTimeout(() => { timerFired = true; }, 1500);
        const eventsBefore = runtime.events.length;
        let result: any;
        try { result = await runProgram(proofCode, `native-proof-${phase}`, undefined, 1500); }
        catch (error) { result = { thrown: { name: (error as Error).name } }; }
        finally { clearTimeout(proofTimer); }
        const check = proofChecks.at(-1);
        const actions = runtime.events.slice(eventsBefore).filter(event => event.type.startsWith("automation.action.") && (event.content as any)?.operation === "count");
        if (check) { check.output = result; check.lateReads = lateReads; check.actions = actions; }
        await test.info().attach(`native-proof-${phase}`, { contentType: "application/json", body: Buffer.from(JSON.stringify({ check, result })) });
        expect(check?.phase).toBe(phase);
        expect(check.fallbackSeen).toBe(true); expect(check.nativeValue).toEqual([]);
        if (phase === "fresh") expect(result).toMatchObject({ ok: true, result: 0 });
        else {
          if (phase === "deadline" && result.thrown) expect(result.thrown).toEqual({ name: "TimeoutError" });
          else expect(result).toMatchObject({ ok: false });
          expect(actions.some(event => event.type === "automation.action.finished")).toBe(false);
          expect(lateReads).toBe(0);
        }
        if (phase === "navigate") { expect(check.nativeNavigation).toBe(true); expect(check.nativeRestoration).toBe(true); }
        if (phase === "deadline") { expect(check.deliveredAt).toBeGreaterThanOrEqual(check.capturedDeadline); expect(check.timerFiredAtDelivery).toBe(false); }
      }
    } finally {
      clearTimeout(proofTimer); CdpConnection.prototype.send = proofSend;
      await page.locator("#fallback-proof").evaluate((element) => element.remove());
      expect(await page.evaluate(() => location.href)).toBe(proofOriginalUrl);
    }
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

    // Chrome acknowledges the click before its separate page-info read. A
    // script-opened page may close itself in between; that is not an unknown
    // input effect. Faults below are injected only at the CDP transport boundary.
    const popupEvent = page.waitForEvent("popup");
    await page.evaluate((url) => window.open(url), `${origin}/self-closing`);
    const popup = await popupEvent;
    await popup.waitForLoadState();
    await popup.setContent('<button id="close" onclick="setTimeout(()=>window.close(),100)">Close this page</button>');
    const popupTab = (await call("list_tabs", {})).result.find((tab: any) => tab.url === `${origin}/self-closing`);
    expect(popupTab).toBeTruthy();
    const closed = popup.waitForEvent("close");
    await page.evaluate(() => {
      document.body.insertAdjacentHTML("beforeend", '<button id="ack">Record input</button>');
      document.body.dataset.nativeEffects = "0";
      document.querySelector("#ack")!.addEventListener("click", () => {
        document.body.dataset.nativeEffects = String(Number(document.body.dataset.nativeEffects) + 1);
      });
    });
    // Replace only the existing external Chrome API method; no test-only
    // production hook or second adapter/runtime is needed.
    const tabs = (runtime.executor as any).chromeApi.tabs as { get(id: number): Promise<{ url?: string; title?: string }> };
    const getTab = tabs.get;
    const popupTargetId = (await getTab(popupTab.id) as any).targetId;
    const send = CdpConnection.prototype.send;
    let phase: "close" | "lost-ack" | "cancel" | "timeout" | "getter" | undefined = "close";
    let releaseAcknowledged = 0;
    let metadataUnavailable = 0;
    let metadataReady = false;
    let getterCallsAtNativeRead: number | undefined;
    let targetDestroyed: Promise<void> | undefined;
    let stopWaitingForTarget: (() => void) | undefined;
    const postReadCancellation = new AbortController();
    CdpConnection.prototype.send = async function (method, params = {}, sessionId) {
      if (method === "Input.dispatchMouseEvent" && (params as any).type === "mouseReleased") {
        if (phase === "close") targetDestroyed = new Promise<void>((resolve) => {
          const listener = (message: any) => {
            if (message.method === "Target.targetDestroyed" && message.params.targetId === popupTargetId) {
              this.listeners.delete(listener); resolve();
            }
          };
          this.listeners.add(listener);
          stopWaitingForTarget = () => this.listeners.delete(listener);
        });
        const result = await send.call(this, method, params, sessionId);
        if (phase) releaseAcknowledged++;
        metadataReady = true;
        if (phase === "lost-ack") {
          phase = undefined;
          throw new Error("Synthetic input acknowledgement lost");
        }
        return result;
      }
      return send.call(this, method, params, sessionId);
    };
    tabs.get = async function (id) {
      if (metadataReady) {
        if (phase === "close") {
          phase = undefined;
          await closed;
          await targetDestroyed; // The same adapter must have consumed native removal.
          try { return await getTab.call(this, id); }
          catch (error) { metadataUnavailable++; throw error; }
        }
        if (phase === "cancel") {
          phase = undefined;
          postReadCancellation.abort();
          throw new Error("Synthetic post-action read failure");
        }
        if (phase === "timeout") {
          phase = undefined;
          throw Object.assign(new Error("Synthetic post-action deadline"), { code: "timeout" });
        }
        if (phase === "getter") {
          phase = undefined;
          const info = await getTab.call(this, id);
          getterCallsAtNativeRead = await page.evaluate(() => Number(document.body.dataset.titleGetterCalls));
          return info;
        }
      }
      return getTab.call(this, id);
    };
    try {
      const start = runtime.events.length;
      const selfClosed = await call("click", { tabId: popupTab.id, target: { by: "css", value: "#close" } });
      expect(selfClosed, JSON.stringify(selfClosed)).toMatchObject({ ok: true, result: { performed: true, pageInfoStatus: { state: "unavailable" } }, pageSnapshotStatus: { state: "unavailable" } });
      expect(selfClosed.result).not.toHaveProperty("url");
      expect(selfClosed.result).not.toHaveProperty("title");
      expect(metadataUnavailable).toBe(1);
      expect(releaseAcknowledged).toBe(1);
      expect(runtime.events.slice(start).some((event) => event.type === "browser.job.state" && (event.content as any)?.state === "succeeded")).toBe(true);
      expect(runtime.events.slice(start).some((event) => event.type === "tool.finished")).toBe(true);

      const uncertainStart = runtime.events.length;
      const faultReceipts: unknown[] = [];
      for (const fault of ["lost-ack", "cancel", "timeout"] as const) {
        metadataReady = false;
        phase = fault;
        const result = await call("click", { target: { by: "css", value: "#ack" } }, fault === "cancel" ? postReadCancellation.signal : undefined);
        expect(result, JSON.stringify(result)).toMatchObject({ ok: false, error: { effectUnknown: true } });
        faultReceipts.push({ fault, evidenceId: result.evidenceId, error: result.error });
      }
      await expect(page.locator("body")).toHaveAttribute("data-native-effects", "3");
      expect(releaseAcknowledged).toBe(4);
      const uncertainJob = runtime.events.slice(uncertainStart).find((event) => event.type === "browser.job.state" && (event.content as any)?.state === "failed")!;
      expect(await call("click", { target: { by: "css", value: "#ack" } })).toMatchObject({ ok: true, result: { performed: true } });
      const preservedJob = await call("get_job", { jobId: (uncertainJob.content as any).jobId });
      expect(JSON.stringify(preservedJob)).toContain('"effectUnknown":true');
      const mainTab = (await call("list_tabs", {})).result.find((tab: any) => tab.url === `${origin}/`);
      expect((await getTab(mainTab.id)).title).toBe("Native tab title");
      await page.evaluate(() => {
        document.body.dataset.titleGetterCalls = "0";
        // The page installs its getter in response to the real native click,
        // after pre-dispatch visibility proof and before the post-action read.
        document.querySelector("#ack")!.addEventListener("click", () => {
          Object.defineProperty(document, "title", { configurable: true, get() {
            document.body.dataset.titleGetterCalls = String(Number(document.body.dataset.titleGetterCalls) + 1);
            throw new Error("Synthetic authored title getter");
          } });
        }, { once: true });
      });
      phase = "getter";
      metadataReady = false;
      let getterResult: any;
      let totalGetterCalls: number;
      try {
        getterResult = await call("click", { target: { by: "css", value: "#ack" } });
        expect(getterResult, JSON.stringify(getterResult)).toMatchObject({ ok: true, result: { performed: true, title: "Native tab title" } });
        expect(getterResult.result).not.toHaveProperty("documentId");
        expect(getterCallsAtNativeRead).toBe(0);
        totalGetterCalls = await page.evaluate(() => Number(document.body.dataset.titleGetterCalls));
      } finally {
        await page.evaluate(() => { delete (document as any).title; });
      }
      await test.info().attach("native-action-confirmation", { contentType: "application/json", body: JSON.stringify({
        selfClosed, releaseAcknowledged, metadataUnavailable, faultReceipts,
        getter: { getterCallsAtNativeRead, totalGetterCalls, result: getterResult },
        priorUnknownJob: { jobId: (uncertainJob.content as any).jobId, status: preservedJob },
        events: runtime.events.slice(start).filter((event) => ["automation.action.finished", "automation.action.failed", "browser.job.state", "tool.finished", "tool.failed"].includes(event.type))
          .map(({ id, type, toolCallId, content }) => ({ id, type, toolCallId, content })),
      }, null, 2) });
    } finally {
      CdpConnection.prototype.send = send;
      tabs.get = getTab;
      stopWaitingForTarget?.();
    }

    const artifactId = runtime.events.find(
      (event) => event.type === "tool.result.data" && (event.content as any)?.filename === "manifest.txt",
    )!.id;
    await page.evaluate(() => {
      document.body.insertAdjacentHTML("beforeend", '<input id="upload" type="FILE" multiple="false"><input id="single" type="file"><input id="not-file" type=" file "><input id="chooser-single" type="file">');
      document.body.dataset.uploadEvents = "";
      document.body.dataset.chooserEvents = "";
      for (const type of ["input", "change"])
        document.addEventListener(type, (event) => {
          if ((event.target as HTMLElement).id === "upload" || (event.target as HTMLElement).id === "single")
            document.body.dataset.uploadEvents += `${(event.target as HTMLElement).id}:${type};`;
          if ((event.target as HTMLElement).id === "chooser-single") document.body.dataset.chooserEvents += `${type};`;
        });
    });
    const upload = (target: string, artifactIds: number | number[] = artifactId, signal?: AbortSignal) =>
      call("upload_file", { target: { by: "css", value: target }, artifactId: artifactIds }, signal);
    const invalidUploads: [string, number | number[], string][] = [
      ["iframe", artifactId, "invalid-upload-target"],
      ["#not-file", artifactId, "invalid-upload-target"],
      ["#single", [artifactId, artifactId], "invalid-file-count"],
    ];
    for (const [target, ids, code] of invalidUploads) {
      const start = runtime.events.length;
      const result = await upload(target, ids);
      expect(result).toMatchObject({ ok: false, error: { code, effectUnknown: false } });
      const evidence = runtime.events.slice(start);
      expect(evidence.some((event) => event.type === "browser.job.progress" && (event.content as any)?.state === "dispatched-unknown")).toBe(false);
      expect(evidence.find((event) => event.type === "browser.job.state" && (event.content as any)?.state === "failed")?.output).toMatchObject({ ok: false, error: { code, effectUnknown: false } });
      expect(evidence.find((event) => event.type === "tool.failed")?.output).toMatchObject({ ok: false, error: { code, effectUnknown: false } });
      await expect(page.locator("body")).toHaveAttribute("data-upload-events", "");
      expect(await page.locator("#single").evaluate((element: HTMLInputElement) => element.files!.length)).toBe(0);
    }
    expect(await upload("#upload", [artifactId, artifactId])).toMatchObject({ ok: true });
    expect(await page.locator("#upload").evaluate(async (element: HTMLInputElement) => Promise.all([...element.files!].map((file) => file.text())))).toEqual(["original bytes", "original bytes"]);
    await expect(page.locator("body")).toHaveAttribute("data-upload-events", "upload:input;upload:change;");

    // Intercept a real native chooser in headless Chrome; reject extra files
    // before dispatch, then reuse that same handle through the production bridge.
    expect(await call("subscribe_event", { kind: "filechooser" })).not.toMatchObject({ ok: false });
    expect(await call("click", { target: { by: "css", value: "#chooser-single" } })).not.toMatchObject({ ok: false });
    const chooser = (await call("list_file_choosers", {})).fileChoosers.find((entry: any) => entry.mode === "selectSingle");
    expect(chooser?.chooserId).toBeTruthy();
    expect(await call("upload_file_chooser", { chooserId: chooser.chooserId, artifactId: [artifactId, artifactId] }))
      .toMatchObject({ ok: false, error: { code: "invalid-file-count", effectUnknown: false } });
    await expect(page.locator("body")).toHaveAttribute("data-chooser-events", "");
    expect(await page.locator("#chooser-single").evaluate((element: HTMLInputElement) => element.files!.length)).toBe(0);
    expect(await call("upload_file_chooser", { chooserId: chooser.chooserId, artifactId }))
      .not.toMatchObject({ ok: false });
    expect(await page.locator("#chooser-single").evaluate((element: HTMLInputElement) => element.files![0].text())).toBe("original bytes");
    await expect(page.locator("body")).toHaveAttribute("data-chooser-events", "input;change;");
    expect((await call("list_file_choosers", {})).fileChoosers.some((entry: any) => entry.chooserId === chooser.chooserId)).toBe(false);

    const beforeUpload = new AbortController();
    runtime.logger.append = async (...args) => {
      const event = args[0] as any;
      const result = await originalAppend(...args);
      if (event.type === "browser.job.progress" && event.content?.operation === "page.locator.setInputFiles" && event.content?.state === "not-dispatched") beforeUpload.abort();
      return result;
    };
    expect(await upload("#single", artifactId, beforeUpload.signal)).toMatchObject({ ok: false, error: { effectUnknown: false } });
    runtime.logger.append = originalAppend;
    expect(await page.locator("#single").evaluate((element: HTMLInputElement) => element.files!.length)).toBe(0);
    await expect(page.locator("body")).toHaveAttribute("data-upload-events", "upload:input;upload:change;");

    // Internal file URLs must not be fetched for a known invalid target/count.
    const beforeRequests = hits;
    expect(await runProgram(`return await page.locator('iframe').setInputFiles({name:'unused.txt',url:${JSON.stringify(`${origin}/file`)}});`, "upload-url-invalid-target")).toMatchObject({ ok: false, result: { error: { effectUnknown: false } } });
    expect(await runProgram(`return await page.locator('#single').setInputFiles([{name:'unused.txt',url:${JSON.stringify(`${origin}/file`)}},{name:'other.txt',text:'other'}]);`, "upload-url-invalid-count")).toMatchObject({ ok: false, result: { error: { effectUnknown: false } } });
    expect(hits).toBe(beforeRequests);

    // A replacement during the write-ahead receipt must reject the original
    // node, never heal the selector to a replacement or claim no dispatch.
    runtime.logger.append = async (...args) => {
      const event = args[0] as any;
      if (event.type === "browser.job.progress" && event.content?.operation === "page.locator.setInputFiles" && event.content?.state === "dispatched-unknown")
        await page.locator("#single").evaluate((element) => element.replaceWith(element.cloneNode(true)));
      return originalAppend(...args);
    };
    expect(await upload("#single")).toMatchObject({ ok: false, error: { effectUnknown: true } });
    runtime.logger.append = originalAppend;
    expect(await page.locator("#single").evaluate((element: HTMLInputElement) => element.files!.length)).toBe(0);

    // Once files and events have been applied, even a failure claiming to be a
    // validation error cannot reset certainty. Later operations settle only
    // their own sequence, including when the program catches every failure.
    let failAppliedUpload = true;
    runtime.logger.append = async (...args) => {
      const event = args[0] as any;
      if (failAppliedUpload && event.type === "browser.job.progress" && event.content?.operation === "page.locator.setInputFiles" && event.content?.state === "completed") {
        failAppliedUpload = false;
        throw Object.assign(new Error("AutomationError[invalid-upload-target]: synthetic page-like failure"), { effectUnknown: false });
      }
      return originalAppend(...args);
    };
    const sequenceStart = runtime.events.length;
    expect(await runProgram(`
      try { await page.locator('#single').setInputFiles({name:'first.txt',text:'first'}); } catch {}
      await page.locator('#upload').setInputFiles({name:'later.txt',text:'later'});
      try { await page.locator('iframe').setInputFiles({name:'unused.txt',text:'unused'}); } catch {}
      return 'caught';
    `, "upload-keeps-earlier-unknown")).toMatchObject({ ok: false, result: { error: { effectUnknown: true } } });
    runtime.logger.append = originalAppend;
    expect(await page.locator("#single").evaluate((element: HTMLInputElement) => element.files![0].text())).toBe("first");
    expect(await page.locator("#upload").evaluate((element: HTMLInputElement) => element.files![0].text())).toBe("later");
    const progress = runtime.events.slice(sequenceStart).filter((event) => event.type === "browser.job.progress" && (event.content as any)?.operation === "page.locator.setInputFiles");
    expect(progress.some((event) => (event.content as any)?.state === "completed")).toBe(true);
    expect(progress.some((event) => (event.content as any)?.state === "not-dispatched" && (event.error as any)?.effectUnknown === false)).toBe(true);
    expect(progress.some((event) => (event.content as any)?.state === "dispatched-unknown" && (event.error as any)?.effectUnknown === true)).toBe(true);

    const applied = new AbortController();
    const appliedStart = runtime.events.length;
    runtime.logger.append = async (...args) => {
      const event = args[0] as any;
      const result = await originalAppend(...args);
      if (event.type === "browser.job.progress" && event.content?.operation === "page.locator.setInputFiles" && event.content?.state === "completed") applied.abort();
      return result;
    };
    expect(await upload("#single", artifactId, applied.signal)).toMatchObject({ ok: false, error: { effectUnknown: true } });
    runtime.logger.append = originalAppend;
    expect(await page.locator("#single").evaluate((element: HTMLInputElement) => element.files![0].text())).toBe("original bytes");
    expect(await upload("iframe")).toMatchObject({ ok: false, error: { effectUnknown: false } });
    expect(await upload("#single")).toMatchObject({ ok: true });
    const unknownUploadJob = runtime.events.slice(appliedStart).find((event) => event.type === "browser.job.state" && (event.content as any)?.state === "cancelled")!;
    expect(JSON.stringify(await call("get_job", { jobId: (unknownUploadJob.content as any).jobId }))).toContain('"effectUnknown":true');

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
