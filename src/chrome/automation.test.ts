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
    if (method === "Runtime.evaluate") {
      if (params.returnByValue === false) return { result: { objectId: "node-1" } };
      if (params.expression.includes("metadata")) return { result: { value: metadata } };
      if (params.expression.includes("({url:")) return { result: { value: { url: "https://example.test/", title: "Test" } } };
      return { result: { value: true } };
    }
    if (method === "Runtime.callFunctionOn") return { result: { value: states.length > 1 ? states.shift() : states[0] } };
    if (method === "DOM.resolveNode") return { object: { objectId: "node-1" } };
    return {};
  });
  const detach = vi.fn(async () => undefined);
  const runtime = new AutomationRuntime({
    chromeApi: { tabs: { query: async () => [{ id: 3 }], onCreated: tabsCreated }, downloads: { onCreated: downloadsCreated } } as never,
    command,
    detach,
    mark: vi.fn(async () => undefined),
  });
  return { runtime, calls, command, detach, tabsCreated };
}

describe("AutomationRuntime", () => {
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

  it("runs actionability checks, dispatches trusted input and returns a compact diff", async () => {
    const { runtime, calls } = harness();
    const page = await runtime.createPage(3);
    await page.snapshot();
    await expect(page.getByRole("button", { name: "Sign in" }).click()).resolves.toMatchObject({ changes: { added: [], removed: [] } });
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
    await page.snapshot();
    metadata[0] = { role: "button", name: "Continue", tag: "button", text: "Continue" };

    await expect(page.locator("button").click()).resolves.toMatchObject({
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

  it("routes canvas-only pages to the raw browser fallback", async () => {
    const { runtime } = harness([]);
    const page = await runtime.createPage(3);

    await expect(page.snapshot()).rejects.toThrow("AutomationError[unsupported]");
  });
});
