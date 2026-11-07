import { expect } from "@playwright/test";
import { test, openExtension, dispose } from "./fixtures";

test.use({ screenshot: "off", trace: "off" });

test("the extension runtime reads current native fields after strict capture fails", async () => {
  const opened = await openExtension(), url = "http://snapshot-native-runtime.test/";
  try {
    const origin = process.env.SURFWAX_DEV_SERVER_URL;
    if (!origin) throw new Error("Native runtime regression requires the development extension server");
    await opened.context.route(url, route => route.fulfill({ contentType: "text/html", body: `<!doctype html><style>
      html,body{margin:0;color:black;background:white;font:16px monospace}
      input,textarea{display:block;width:340px;font:16px monospace;margin:8px;border-radius:0}
      label{display:block;width:360px;height:22px;overflow:hidden}
    </style><label for="value">Author label</label><input id="value" value="INITIAL_VALUE">
      <input type="search" placeholder="SEARCH_HINT"><textarea style="height:60px">FIRST_LINE\nSECOND_LINE</textarea>` }));
    const target = await opened.context.newPage(); await target.goto(url);
    await target.evaluate(() => document.fonts.ready);
    await expect(opened.page.getByTestId("open-settings")).toBeVisible();
    await opened.page.waitForLoadState("networkidle");
    await opened.page.evaluate(async ({ origin, url }) => {
      const { AutomationRuntime } = await import(`${origin}/src/chrome/automation.ts`);
      const tabId = (await chrome.tabs.query({ url }))[0]?.id;
      if (tabId === undefined) throw new Error("Target missing");
      await chrome.debugger.attach({ tabId }, "1.3");
      const state: any = { tabId, churn: 0, samples: 0, queries: 0, installs: 0, events: [] };
      const api = { ...chrome, scripting: { ...chrome.scripting, executeScript: async (options: any) => {
        if (options.func?.name === "snapshotObservationPrimitives") state.installs++;
        return chrome.scripting.executeScript(options);
      } } };
      state.runtime = new AutomationRuntime({ chromeApi: api,
        command: async (source: chrome.debugger.Debuggee, method: string, params: any) => {
          const result = await chrome.debugger.sendCommand(source, method, params);
          if (method === "DOMSnapshot.captureSnapshot") await chrome.debugger.sendCommand(source, "Runtime.evaluate", {
            expression: `document.body.setAttribute('data-churn',${JSON.stringify(String(++state.churn))})`,
          });
          if (method === "DOM.querySelectorAll" && params.selector === "input,textarea,select") state.queries++;
          if (method === "Runtime.callFunctionOn" && params.functionDeclaration?.includes("surf-wax:semantic-native-observation")) {
            state.samples++;
            const after = state.afterSample; state.afterSample = undefined;
            if (after) await chrome.debugger.sendCommand(source, "Runtime.evaluate", { expression: after });
          }
          return result;
        }, pressChord: async () => { throw new Error("Read cannot send input"); },
        detach: (source: chrome.debugger.Debuggee) => chrome.debugger.detach(source),
      });
      state.event = (source: chrome.debugger.Debuggee, method: string, params: any) => {
        if (/frameAttached|frameNavigated|documentUpdated|executionContextsCleared|executionContextDestroyed|lifecycleEvent/.test(method)) state.events.push({ source, method, params });
        state.runtime.handleEvent(source, method, params);
      };
      chrome.debugger.onEvent.addListener(state.event);
      state.runtime.setContext({ signal: AbortSignal.timeout(30_000) });
      (globalThis as any).__nativeObservation = state;
    }, { origin, url });
    const inspect = () => opened.page.evaluate(async () => {
      const state = (globalThis as any).__nativeObservation;
      const result = await state.runtime.inspect(state.tabId, { full: true, budget: 100_000 });
      return { result, samples: state.samples, queries: state.queries, installs: state.installs };
    });
    const first: any = await inspect(), text = first.result.items.map((item: any) => item.line).join("\n");
    expect(first.result.partial).toBe(true);
    expect(text).toContain('textbox "Author label"'); expect(text).toContain("INITIAL_VALUE");
    expect(text).toContain('[placeholder="SEARCH_HINT"]'); expect(text).toContain(JSON.stringify("FIRST_LINE\nSECOND_LINE"));
    expect(first.samples).toBe(1); expect(first.queries).toBe(0); expect(first.installs).toBe(1);
    expect(text).not.toContain("[ref=");
    await target.evaluate(() => { (document.querySelector("#value") as HTMLInputElement).value = "CURRENT_VALUE"; });
    const next: any = await inspect(), current = next.result.items.map((item: any) => item.line).join("\n");
    expect(current).toContain("CURRENT_VALUE"); expect(current).not.toContain("INITIAL_VALUE");
    expect(next.samples).toBe(2); expect(next.installs).toBe(1); expect(next.queries).toBe(0);
    await opened.page.evaluate(() => {
      const state = (globalThis as any).__nativeObservation; state.events = [];
      state.afterSample = "{const frame=document.createElement('iframe');frame.src='about:blank';frame.style.display='none';document.body.append(frame)}";
    });
    const observed: any = await opened.page.evaluate(async () => {
      const state = (globalThis as any).__nativeObservation;
      const result = await state.runtime.observe(state.tabId, "semantic");
      return { result, events: state.events };
    });
    expect(observed.result.partial).toBe(true);
    expect(observed.result.snapshot).toContain("CURRENT_VALUE");
    expect(observed.events.some((event: any) => event.method === "Page.frameAttached")).toBe(true);
    await target.waitForFunction(() => document.querySelector("iframe")?.contentDocument?.readyState === "complete");
    await opened.page.evaluate(() => {
      const state = (globalThis as any).__nativeObservation;
      state.afterSample = "document.open();document.write('<!doctype html><p>REPLACED_DOCUMENT</p>');document.close()";
    });
    const replaced: any = await opened.page.evaluate(async () => {
      const state = (globalThis as any).__nativeObservation;
      try { await state.runtime.inspect(state.tabId, { full: true }); return { accepted: true }; }
      catch (error) { return { code: (error as any).code, detail: (error as any).detail }; }
    });
    expect(replaced.code).toBe("stale-observation");
  } finally {
    await opened.page.evaluate(async () => {
      const state = (globalThis as any).__nativeObservation;
      if (!state) return;
      await state.runtime.abortSessions(); chrome.debugger.onEvent.removeListener(state.event);
      delete (globalThis as any).__nativeObservation;
    }).catch(() => undefined);
    await dispose(opened.context, opened.userDataDirectory);
  }
});
