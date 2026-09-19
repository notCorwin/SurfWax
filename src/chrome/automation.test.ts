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

function harness(metadata: object[] = [{ role: "button", name: "Sign in", tag: "button", text: "Sign in" }]) {
  const calls: Array<{ method: string; params?: any }> = [];
  const tabsCreated = event<(tab: chrome.tabs.Tab) => void>();
  const downloadsCreated = event<(item: chrome.downloads.DownloadItem) => void>();
  const command = vi.fn(async (_debuggee: chrome.debugger.Debuggee, method: string, params?: any) => {
    calls.push({ method, params });
    if (method === "Accessibility.getFullAXTree") return { nodes: [
      { nodeId: "root", role: { value: "RootWebArea" }, name: { value: "Test" }, childIds: ["button"] },
      { nodeId: "button", parentId: "root", backendDOMNodeId: 7, role: { value: "button" }, name: { value: "Sign in" }, properties: [{ name: "focusable", value: { value: true } }] },
    ] };
    if (method === "Runtime.evaluate") {
      if (params.returnByValue === false) return { result: { objectId: "node-1" } };
      if (params.expression.includes("metadata")) return { result: { value: metadata } };
      if (params.expression.includes("({url:")) return { result: { value: { url: "https://example.test/", title: "Test" } } };
      return { result: { value: true } };
    }
    if (method === "Runtime.callFunctionOn") return { result: { value: { x: 10, y: 12, visible: true, stable: true, enabled: true, editable: true, receivesEvents: true, checked: false } } };
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

  it("invalidates snapshot refs after main-document navigation", async () => {
    const { runtime } = harness();
    const page = await runtime.createPage(3);
    await page.snapshot();
    runtime.handleEvent({ tabId: 3 }, "Page.frameNavigated", { frame: { id: "new-root" } });
    await expect(page.ref("e1").click()).rejects.toThrow("stale-ref");
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

  it("rejects local file paths at the page tool boundary", async () => {
    const { runtime } = harness();
    const page = await runtime.createPage(3);
    await expect(page.locator("input[type=file]").setInputFiles({ name: "secret.txt", path: "/tmp/secret.txt" })).rejects.toThrow("local paths");
  });
});
