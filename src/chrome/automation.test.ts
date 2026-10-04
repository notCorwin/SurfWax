import { describe, expect, it, vi } from "vitest";
import { AutomationRuntime } from "./automation";

function event<T extends (...args: any[]) => void>() {
  const listeners = new Set<T>();
  return {
    addListener: (listener: T) => listeners.add(listener),
    removeListener: (listener: T) => listeners.delete(listener),
    emit: (...args: Parameters<T>) => { for (const listener of listeners) listener(...args); },
  };
}

function harness(
  metadata: object[] | undefined = [{ role: "button", name: "Sign in", tag: "button", text: "Sign in" }],
  states: object[] = [{ connected: true, x: 10, y: 12, visible: true, stable: true, enabled: true, editable: true, receivesEvents: true, checked: false }],
  logger?: { record: ReturnType<typeof vi.fn> },
) {
  metadata ??= [{ role: "button", name: "Sign in", tag: "button", text: "Sign in" }];
  const calls: Array<{ method: string; params?: any }> = [];
  const tabsCreated = event<(tab: chrome.tabs.Tab) => void>();
  const downloadsCreated = event<(item: chrome.downloads.DownloadItem) => void>();
  const command = vi.fn(async (_debuggee: chrome.debugger.Debuggee, method: string, params?: any) => {
    calls.push({ method, params });
    if (method === "Accessibility.getFullAXTree") return { nodes: [
      { nodeId: "root", role: { value: "RootWebArea" }, name: { value: "Test" }, childIds: metadata.map((_, index) => `node-${index}`) },
      ...metadata.map((item: any, index) => ({
        nodeId: `node-${index}`,
        parentId: "root",
        backendDOMNodeId: 7 + index,
        role: { value: item.role },
        name: { value: item.name },
        properties: [{ name: "focusable", value: { value: true } }],
      })),
    ] };
    if (method === "Accessibility.queryAXTree") return { nodes: metadata.map((item: any, index) => ({
      nodeId: `node-${index}`, backendDOMNodeId: 7 + index, role: { value: item.role }, name: { value: item.name },
    })) };
    if (method === "Runtime.evaluate") {
      if (params.returnByValue === false) return { result: { objectId: "node-1" } };
      if (params.expression.includes("metadata")) return { result: { value: metadata } };
      if (params.expression.includes("({url:")) return { result: { value: { url: "https://example.test/", title: "Test" } } };
      if (params.expression.includes("({x:scrollX")) return { result: { value: { x: 0, y: 0, width: 100, height: 50, scale: 2 } } };
      return { result: { value: true } };
    }
    if (method === "Runtime.callFunctionOn") return { result: { value: states.length > 1 ? states.shift() : states[0] } };
    if (method === "DOM.resolveNode") return { object: { objectId: "node-1" } };
    if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
    if (method === "Page.captureScreenshot") return { data: btoa(String.fromCharCode(0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0, 100, 0, 200, 3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0)) };
    return {};
  });
  const detach = vi.fn(async () => undefined);
  const runtime = new AutomationRuntime({
    chromeApi: { tabs: { query: async () => [{ id: 3 }], onCreated: tabsCreated }, downloads: { onCreated: downloadsCreated } } as never,
    command,
    detach,
    mark: vi.fn(async () => undefined),
    logger: logger as never,
  });
  return { runtime, calls, command, detach, tabsCreated };
}

describe("AutomationRuntime", () => {
  it("waits for equal geometry across samples before dispatching native input", async () => {
    const base = { connected: true, y: 12, height: 20, visible: true, stable: true, enabled: true,
      editable: true, receivesEvents: true, checked: false };
    const { runtime, calls } = harness(undefined, [
      { ...base, x: 10, width: 20 }, { ...base, x: 30, width: 40 },
      { ...base, x: 30, width: 40 }, { ...base, x: 30, width: 40 },
    ]);
    const page = await runtime.createPage(3);
    await page.getByRole("button", { name: "Sign in" }).click();
    const pressed = calls.findIndex(({ method, params }) => method === "Input.dispatchMouseEvent" && params.type === "mousePressed");
    expect(calls.slice(0, pressed).filter(({ method }) => method === "Runtime.callFunctionOn")).toHaveLength(4);
    expect(calls[pressed]?.params).toMatchObject({ x: 30, y: 12 });
    await runtime.dispose();
  });

  it("keeps the starting action identity when the surrounding request phase changes while it waits", async () => {
    const logger = { record: vi.fn() };
    const { runtime } = harness([], undefined, logger);
    let finish!: () => void;
    const identity = { runId: "run", toolCallId: "1:call", toolCallIdCanonical: true as const };
    runtime.setContext({ conversationId: "conversation", toolCallId: "call", logIdentity: identity });
    const pending = (runtime as any).action(3, "waiting", null, () => new Promise<void>((resolve) => { finish = resolve; }));
    runtime.setContext({ conversationId: "other", toolCallId: "later" });
    finish(); await pending;
    expect(logger.record.mock.calls.map(([event]) => ({ conversationId: event.conversationId, runId: event.runId, toolCallId: event.toolCallId, toolCallIdCanonical: event.toolCallIdCanonical }))).toEqual([
      { conversationId: "conversation", ...identity }, { conversationId: "conversation", ...identity },
    ]);
  });

  it("builds compact AX snapshots with stable refs and reuses one tab session", async () => {
    const { runtime, calls } = harness();
    const page = await runtime.createPage(3);
    const first = await page.snapshot();
    const second = await page.snapshot();

    expect(first.snapshot).toContain('button "Sign in" [ref=e1]');
    expect(second.snapshot).toContain("[ref=e1]");
    expect(calls.filter(({ method }) => method === "Page.enable")).toHaveLength(1);
    expect(calls.filter(({ method }) => method === "Target.setAutoAttach")).toHaveLength(1);
  });

  it("rejects ambiguous semantic locators immediately", async () => {
    const { runtime } = harness([
      { role: "button", name: "Save", tag: "button", text: "Save" },
      { role: "button", name: "Save", tag: "button", text: "Save" },
    ]);
    const page = await runtime.createPage(3);
    await expect(page.getByRole("button", { name: "Save" }).click()).rejects.toThrow("strict-mode");
  });

  it("runs actionability checks and dispatches trusted input", async () => {
    const { runtime, calls } = harness();
    const page = await runtime.createPage(3);
    await page.snapshot();
    await expect(page.getByRole("button", { name: "Sign in" }).click()).resolves.toMatchObject({ performed: true });
    expect(calls.filter(({ method }) => method === "Input.dispatchMouseEvent").map(({ params }) => params.type)).toEqual(["mousePressed", "mouseReleased"]);
  });

  it("re-resolves a locator when a framework replaces the node during actionability", async () => {
    const blocked = { connected: false, x: 0, y: 0, visible: false, stable: false, enabled: false, editable: false, receivesEvents: false, checked: false };
    const ready = { connected: true, x: 10, y: 12, visible: true, stable: true, enabled: true, editable: true, receivesEvents: true, checked: false };
    const { runtime, calls } = harness(undefined, [blocked, ready]);
    const page = await runtime.createPage(3);

    await page.getByRole("button", { name: "Sign in" }).click();

    expect(calls.filter(({ method }) => method === "DOM.resolveNode").length).toBeGreaterThanOrEqual(2);
    expect(calls.filter(({ method }) => method === "Input.dispatchMouseEvent").map(({ params }) => params.type)).toEqual(["mousePressed", "mouseReleased"]);
  });

  it("waits for explicit locator states", async () => {
    const disabled = { connected: true, x: 10, y: 12, visible: true, stable: true, enabled: false, editable: false, receivesEvents: true, checked: false };
    const enabled = { ...disabled, enabled: true };
    const { runtime, calls } = harness(undefined, [disabled, enabled]);
    const page = await runtime.createPage(3);

    await page.getByRole("button", { name: "Sign in" }).waitFor({ state: "enabled" });

    expect(calls.filter(({ method }) => method === "Runtime.callFunctionOn")).toHaveLength(2);
  });

  it("reports semantic updates by node identity instead of collapsing line sets", async () => {
    const metadata = [{ role: "button", name: "Save", tag: "button", text: "Save" }];
    const { runtime } = harness(metadata);
    const page = await runtime.createPage(3);
    const first = await page.observe("semantic");
    metadata[0] = { role: "button", name: "Continue", tag: "button", text: "Continue" };

    await expect(page.observe("semantic", first.observationId as string)).resolves.toMatchObject({
      changes: { updated: [{ before: expect.stringContaining('button "Save"'), after: expect.stringContaining('button "Continue"') }] },
    });
  });

  it("invalidates snapshot refs after main-document navigation", async () => {
    const { runtime } = harness();
    const page = await runtime.createPage(3);
    await page.snapshot();
    runtime.handleEvent({ tabId: 3 }, "Page.frameNavigated", { frame: { id: "new-root" } });
    await expect(page.ref("e1").click()).rejects.toThrow("stale-ref");
  });

  it("refuses to heal a detached snapshot ref to a similar element", async () => {
    const detached = { connected: false, x: 0, y: 0, visible: false, stable: false, enabled: false, editable: false, receivesEvents: false, checked: false };
    const { runtime } = harness(undefined, [detached]);
    const page = await runtime.createPage(3);
    await page.snapshot();

    await expect(page.ref("e1").click()).rejects.toThrow("AutomationError[detached]");
  });

  it("aborts pending locators and detaches the automation session", async () => {
    const { runtime, detach } = harness([]);
    const controller = new AbortController();
    runtime.setContext({ signal: controller.signal });
    const page = await runtime.createPage(3);
    const pending = page.getByText("later").click();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await runtime.abortSessions();
    expect(detach).toHaveBeenCalledWith({ tabId: 3 });
  });

  it("returns timeout diagnostics while throttling repeated locator attempts", async () => {
    vi.useFakeTimers();
    try {
      const logger = { record: vi.fn() };
      const { runtime } = harness([], undefined, logger);
      const controller = new AbortController();
      runtime.setContext({ signal: controller.signal });
      const page = await runtime.createPage(3);
      const pending = page.getByText("missing").click();
      const rejected = expect(pending).rejects.toThrow(/AutomationError\[timeout\].*lastObservation/);
      setTimeout(() => controller.abort(new DOMException("timed out", "TimeoutError")), 2_200);
      await vi.advanceTimersByTimeAsync(2_200);

      await rejected;
      const attempts = logger.record.mock.calls.map(([event]) => event).filter((event) => event.type === "automation.action.attempt");
      expect(attempts).toHaveLength(3);
      expect(attempts.map((event) => event.content.attempt)).toEqual([1, 21, 41]);
      expect(logger.record.mock.calls.map(([event]) => event).find((event) => event.type === "automation.action.failed")?.content.diagnostic)
        .toMatchObject({ code: "timeout", lastObservation: { reason: "no-candidate", attempt: 44 } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns a Page handle for popups opened by the current tab", async () => {
    const { runtime, tabsCreated } = harness();
    const page = await runtime.createPage(3);
    const popup = page.waitForEvent("popup");
    tabsCreated.emit({ id: 4, openerTabId: 3 } as chrome.tabs.Tab);
    await expect(popup).resolves.toMatchObject({ tabId: 4 });
  });

  it("returns actionable dialog handles", async () => {
    const { runtime, command } = harness();
    const page = await runtime.createPage(3);
    const pending = page.waitForEvent("dialog");
    runtime.handleEvent({ tabId: 3 }, "Page.javascriptDialogOpening", { type: "prompt", message: "Name?", defaultPrompt: "Ada" });
    const dialog = await pending;
    expect(dialog.message()).toBe("Name?");
    await dialog.accept("Grace");
    expect(command).toHaveBeenCalledWith({ tabId: 3 }, "Page.handleJavaScriptDialog", { accept: true, promptText: "Grace" });
  });

  it("correlates downloads from the active CDP tab instead of global download events", async () => {
    const { runtime } = harness();
    const page = await runtime.createPage(3);
    const pending = page.waitForEvent("download");
    runtime.handleEvent({ tabId: 3 }, "Page.downloadWillBegin", { guid: "download-1", url: "https://example.test/file", suggestedFilename: "file.txt" });

    await expect(pending).resolves.toMatchObject({ guid: "download-1", suggestedFilename: "file.txt" });
  });

  it("rejects local file paths at the page tool boundary", async () => {
    const { runtime } = harness();
    const page = await runtime.createPage(3);
    await expect(page.locator("input[type=file]").setInputFiles({ name: "secret.txt", path: "/tmp/secret.txt" })).rejects.toThrow("local paths");
  });

  it("upgrades pages without actionable semantics to a screenshot", async () => {
    const { runtime, calls } = harness([]);
    const page = await runtime.createPage(3);

    await expect(page.observe()).resolves.toHaveProperty("screenshot");
    expect(calls.some(({ method }) => method === "Page.captureScreenshot")).toBe(true);
  });

  it("maps screenshot pixels back to CSS viewport coordinates", async () => {
    const { runtime, calls } = harness([]);
    const page = await runtime.createPage(3);
    const observation = await page.observe("visual");
    await page.point(observation.observationId as string, 100, 50, "click");
    expect(calls.filter(({ method }) => method === "Input.dispatchMouseEvent").at(-2)?.params).toMatchObject({ type: "mousePressed", x: 50, y: 25 });
  });

  it("uses captured image dimensions when the screenshot pixel ratio differs from devicePixelRatio", async () => {
    const { runtime, calls, command } = harness();
    const original = command.getMockImplementation()!;
    command.mockImplementation(async (debuggee, method, params) => method === "Page.captureScreenshot"
      ? { data: btoa(String.fromCharCode(0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0, 50, 0, 100, 3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0)) }
      : original(debuggee, method, params));
    const page = await runtime.createPage(3);
    const observation = await page.observe("visual");
    expect(observation.viewport).toMatchObject({ scale: 2 });
    expect(observation.screenshot).toMatchObject({ width: 100, height: 50, scale: 1 });
    await page.point(observation.observationId as string, 50, 25, "click");
    expect(calls.filter(({ method }) => method === "Input.dispatchMouseEvent").at(-2)?.params).toMatchObject({ type: "mousePressed", x: 50, y: 25 });
  });

  it("passes mouse button and modifiers through screenshot coordinate actions", async () => {
    const { runtime, calls } = harness([]);
    const page = await runtime.createPage(3);
    const observation = await page.observe("visual");
    await page.point(observation.observationId as string, 100, 50, "dblclick", { button: "right", modifiers: ["Shift", "Alt"] });
    const presses = calls.filter(({ method, params }) => method === "Input.dispatchMouseEvent" && params.type === "mousePressed");
    expect(presses.map(({ params }) => ({ button: params.button, modifiers: params.modifiers, count: params.clickCount }))).toEqual([{ button: "right", modifiers: 9, count: 1 }, { button: "right", modifiers: 9, count: 2 }]);
  });

  it("returns an actionable file chooser handle using the originating frame session", async () => {
    const { runtime, command } = harness();
    const page = await runtime.createPage(3);
    const pending = page.waitForEvent("filechooser");
    runtime.handleEvent({ tabId: 3, sessionId: "upload-frame" }, "Page.fileChooserOpened", { backendNodeId: 55, mode: "selectMultiple" });
    const chooser = await pending;
    expect(chooser.isMultiple()).toBe(true);
    await chooser.setFiles([{ name: "hello.txt", text: "hello" }]);
    expect(command).toHaveBeenCalledWith({ tabId: 3, sessionId: "upload-frame" }, "DOM.resolveNode", expect.objectContaining({ backendNodeId: 55 }));
    expect(command).toHaveBeenCalledWith({ tabId: 3, sessionId: "upload-frame" }, "Runtime.callFunctionOn", expect.objectContaining({ functionDeclaration: expect.stringContaining("this.files = transfer.files") }));
  });

  it("does not substitute a same-named node when snapshot DOM resolution fails", async () => {
    const { runtime, command } = harness();
    const page = await runtime.createPage(3);
    await page.snapshot();
    const original = command.getMockImplementation()!;
    command.mockImplementation(async (source, method, params) => {
      if (method === "DOM.resolveNode") throw new Error("node removed");
      return original(source, method, params);
    });
    await expect(page.ref("e1").click()).rejects.toThrow("detached");
    expect(command.mock.calls.filter(([, method]) => method === "Accessibility.queryAXTree")).toHaveLength(0);
  });

  it("treats negative CSS and text indices below the beginning as empty", async () => {
    const { runtime, command } = harness();
    const original = command.getMockImplementation()!;
    const fixture = document.createElement("div");
    fixture.innerHTML = '<button>One</button><button>Two</button>';
    document.body.append(fixture);
    command.mockImplementation(async (source, method, params) => {
      if (method === "Runtime.evaluate" && params.expression.includes("metadata")) return { result: { value: new Function("document", `return ${params.expression}`)(fixture) } };
      return original(source, method, params);
    });
    try {
      const page = await runtime.createPage(3);
      expect(await page.locator("button").nth(-3).count()).toBe(0);
      expect(await page.locator("button").nth(-1).count()).toBe(1);
      expect(await page.getByText("o").nth(-3).count()).toBe(0);
    } finally { fixture.remove(); }
  });

  it("rejects an act batch tied to an observation from an old document", async () => {
    const { runtime } = harness();
    const page = await runtime.createPage(3);
    const observation = await page.observe("semantic");
    runtime.handleEvent({ tabId: 3 }, "Page.frameNavigated", { frame: { id: "new-root" } });
    await expect(page.ensureObservation(observation.observationId as string)).rejects.toThrow("stale-observation");
  });
});
