// @vitest-environment node
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { describe, expect, it, vi } from "vitest";
import { connectToolRuntime } from "./runtime";
import { executeNodeProgram } from "./program-host";

describe("standalone tools", () => {
  it("terminates non-yielding programs and preserves the shared value codec", async () => {
    const controller = new AbortController();
    const loop = executeNodeProgram("while (true) {}", {}, controller.signal);
    setTimeout(() => controller.abort(new DOMException("Stopped", "AbortError")), 100);
    await expect(loop).rejects.toThrow("Stopped");
    const result = await executeNodeProgram("return { value: 42n, bytes: new Uint8Array([1,2]), missing: undefined };", {}, new AbortController().signal);
    expect(result).toEqual({ value: 42n, bytes: new Uint8Array([1, 2]), missing: undefined });
  });

  it("executes the production tools on real Chrome without an extension or chrome global", async () => {
    vi.unstubAllGlobals();
    expect(typeof globalThis.chrome).toBe("undefined");
    const profile = await mkdtemp(join(tmpdir(), "surf-wax-tools-"));
    const context = await chromium.launchPersistentContext(profile, {
      channel: "chrome", headless: true, viewport: { width: 1280, height: 800 }, args: ["--remote-debugging-port=0"],
    });
    let runtime: Awaited<ReturnType<typeof connectToolRuntime>> | undefined;
    try {
      const page = context.pages()[0]!;
      await page.goto(`data:text/html,${encodeURIComponent('<label>Name<input id="name"></label><button onclick="document.querySelector(\'output\').textContent=document.querySelector(\'input\').value">Save</button><output></output><div hidden>Invisible sentinel</div>')}`);
      const [port] = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n");
      runtime = await connectToolRuntime(`http://127.0.0.1:${port}`);
      const snapshot = await runtime.call("inspect_page");
      expect(snapshot).not.toHaveProperty("ok", false);
      expect(snapshot).not.toHaveProperty("partial", true);
      expect(JSON.stringify((snapshot as any).items)).toContain("Save");
      expect(JSON.stringify((snapshot as any).items)).not.toContain("Invisible sentinel");
      const fill = await runtime.call("fill", { target: { by: "label", value: "Name" }, value: "Standalone" });
      expect(fill, JSON.stringify(fill)).not.toHaveProperty("ok", false);
      const click = await runtime.call("click", { target: { by: "role", value: "button", name: "Save" } });
      expect(click, JSON.stringify(click)).not.toHaveProperty("ok", false);
      expect(click).toHaveProperty("pageSnapshot");
      expect(await page.locator("output").textContent()).toBe("Standalone");
      const popupSubscription = await runtime.call("subscribe_event", { kind: "popup" }) as any;
      const popupReady = context.waitForEvent("page");
      await page.evaluate(() => { window.open("about:blank"); });
      const popup = await popupReady;
      const popupEvent = await runtime.call("wait_event", { subscriptionId: popupSubscription.subscriptionId, waitMs: 1000 }) as any;
      expect(popupEvent.events).toHaveLength(1);
      expect(popupEvent.events[0].kind).toBe("popup");
      await popup.close();
      const dialogSubscription = await runtime.call("subscribe_event", { kind: "dialog" }) as any;
      page.on("dialog", () => {});
      const alertFinished = page.evaluate(() => { alert("Standalone dialog"); });
      const dialogEvent = await runtime.call("wait_event", { subscriptionId: dialogSubscription.subscriptionId, waitMs: 1000 }) as any;
      expect(dialogEvent.events).toHaveLength(1);
      const handled = await runtime.call("handle_dialog", { dialogId: dialogEvent.events[0].payload.dialogId, accept: true });
      expect(handled, JSON.stringify({handled, dialogEvent})).not.toHaveProperty("ok", false);
      await alertFinished;
      const tabs = await runtime.call("list_tabs") as any;
      expect(JSON.stringify(tabs)).toContain("tabId");
      const opened = await runtime.call("open_tab", { url: "about:blank" }) as any;
      expect(opened).not.toHaveProperty("ok", false);
      expect(context.pages()).toHaveLength(2);
      await runtime.call("switch_tab", { tabId: 1 });
      const invalid = await runtime.call("fill", { target: { by: "css", value: "#absent" }, value: "x", timeoutMs: 100 });
      expect(invalid).toHaveProperty("ok", false);
      expect(invalid).toHaveProperty("evidenceId");
      expect(runtime.events.some(event => event.type === "tool.failed")).toBe(true);
      await runtime.close();
      await expect(runtime.call("list_tabs")).rejects.toThrow("closed");
    } finally {
      await runtime?.close(); await context.close(); await rm(profile, { recursive: true, force: true });
    }
  }, 60_000);
});
