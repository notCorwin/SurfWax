// @vitest-environment node
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { describe, expect, it, vi } from "vitest";
import { connectToolRuntime } from "./runtime";
import { resolveSampledElement } from "../chrome/sampled-element";
import { executeNodeProgram } from "./program-host";
import { formatSnapshotItem, type ProjectedSnapshotNode } from "../chrome/snapshot-render";

const itemLine = (item: ProjectedSnapshotNode & { change?: string }) =>
  item.role === undefined && item.change === "removed" ? "" : formatSnapshotItem(item);
const inspectText = (value: { items?: readonly any[] }) => (value.items ?? []).map((item: any) => itemLine(item)).join("\n");

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
      expect(snapshot, JSON.stringify(snapshot)).not.toHaveProperty("ok", false);
      expect(snapshot, JSON.stringify(snapshot)).not.toHaveProperty("partial", true);
      expect(JSON.stringify((snapshot as any).items)).toContain("Save");
      expect(JSON.stringify((snapshot as any).items)).not.toContain("Invisible sentinel");
      const saveItem = (snapshot as any).items.find((item: any) => item.role === "button" && item.name === "Save");
      const inputItem = (snapshot as any).items.find((item: any) => item.role === "textbox");
      expect(saveItem).toHaveProperty("actionable", true);
      expect(saveItem).not.toHaveProperty("ref");
      const found = await runtime.call("find_elements", { target: { by: "role", value: "button", name: "Save", exact: true } }) as any;
      expect(found.elements[0]).toMatchObject({ id: saveItem.id, actionable: true });
      expect(found.elements[0]).not.toHaveProperty("ref");
      const fill = await runtime.call("fill", { target: { id: inputItem.id }, value: "Standalone" });
      expect(fill, JSON.stringify(fill)).not.toHaveProperty("ok", false);
      const click = await runtime.call("click", { target: { id: saveItem.id } });
      expect(click, JSON.stringify(click)).not.toHaveProperty("ok", false);
      expect(click).toHaveProperty("pageSnapshot");
      expect(await page.locator("output").textContent()).toBe("Standalone");
      await page.locator("button").evaluate(button => { button.textContent = "Renamed"; });
      const stale = await runtime.call("click", { target: { id: saveItem.id } });
      expect(stale).toMatchObject({ ok: false, error: { code: "stale-id" } });
      const nonActionable = await runtime.call("click", { target: { id: (snapshot as any).items[0].id } });
      expect(nonActionable, JSON.stringify(nonActionable)).toMatchObject({ ok: false, error: { code: "not-actionable-id" } });
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
      const wrongTab = await runtime.call("click", { target: { id: inputItem.id }, tabId: opened.result.tabId });
      expect(wrongTab).toMatchObject({ ok: false, error: { code: "stale-id" } });
      await runtime.call("switch_tab", { tabId: 1 });
      const invalid = await runtime.call("fill", { target: { by: "css", value: "#absent" }, value: "x", timeoutMs: 100 });
      expect(invalid).toHaveProperty("ok", false);
      expect(invalid).toHaveProperty("evidenceId");
      expect(runtime.events.some(event => event.type === "tool.failed")).toBe(true);
      await page.setContent(`<!doctype html><style>body{font:16px Arial;margin:20px}p{margin:0;height:28px}</style>
        <p>Fallback visible sentinel</p><button onclick="document.body.dataset.idClicks=String(Number(document.body.dataset.idClicks||0)+1);document.querySelector('output').textContent='ID clicked'">Sample action</button><output></output><div id="closed">CLOSED_LIGHT_SECRET</div><div id="open">OPEN_LIGHT_SECRET</div>
        <div id="race">RACE_LIGHT_SECRET</div><div id="new-root-button" role="button" tabindex="0">Rootless action</div><div id="shadow-button" role="button" tabindex="0" onclick="document.body.dataset.shadowClicks=String(Number(document.body.dataset.shadowClicks||0)+1)">SHADOW_LIGHT_SECRET</div><p hidden>HIDDEN_SECRET</p><p style="position:absolute;top:4000px">OFFSCREEN_SECRET</p><input value="field">`);
      await page.evaluate(async () => {
        for (const mode of ["open", "closed"] as const) {
          document.getElementById(mode)!.attachShadow({ mode }).innerHTML = `<p>${mode} shadow visible</p>`;
        }
        const actionShadow = document.getElementById("shadow-button")!.attachShadow({ mode: "closed" });
        actionShadow.innerHTML = "<span>Shadow action original</span>";
        (window as any).__testActionShadow = actionShadow;
        getSelection()?.removeAllRanges();
        await document.fonts.ready;
      });
      // Keep the bulk capture unstable while preserving the real browser's
      // synchronous read, closed shadow roots, geometry and visibility proofs.
      const automation = (runtime.executor as any).automation;
      const originalCommand = automation.options.command;
      let mutateSampleIdentity = false;
      let captures = 0, mutateShadow: "attach" | "insert" | undefined, censusStarted = false;
      const command = vi.spyOn(automation.options, "command").mockImplementation(async (...args: unknown[]) => {
        const result = await originalCommand(...args);
        if (mutateSampleIdentity && args[1] === "Runtime.callFunctionOn" && (args[2] as any)?.functionDeclaration === resolveSampledElement.toString()) {
          mutateSampleIdentity = false;
          await page.getByRole("button", { name: "Sample action" }).evaluate(button => { button.textContent = "Different action"; });
        }
        if (args[1] === "DOM.getDocument" && (args[2] as any)?.depth === -1) censusStarted = true;
        if (mutateShadow && censusStarted && args[1] === "DOM.resolveNode") {
          const mutation = mutateShadow; mutateShadow = undefined;
          await page.evaluate(mutation => {
            if (mutation === "attach") document.getElementById("race")!.attachShadow({ mode: "closed" }).innerHTML = "<p>New shadow visible</p>";
            else {
              const container = document.createElement("section"), host = document.createElement("div");
              host.innerHTML = "<p>INSERTED_LIGHT_SECRET</p>";
              host.attachShadow({ mode: "closed" }).innerHTML = '<div style="opacity:0"><slot></slot></div><p>Inserted shadow visible</p>';
              container.append(host); document.body.append(container);
            }
          }, mutation);
        }
        if (args[1] === "DOMSnapshot.captureSnapshot") {
          const doc = result.documents[0], strings = result.strings;
          doc.nodes.attributes[0] = [...doc.nodes.attributes[0], strings.push("data-test-revision") - 1, strings.push(String(++captures)) - 1];
        }
        return result;
      });
      try {
        const recovered = await runtime.call("inspect_page", { full: true }) as any;
        expect(recovered, JSON.stringify(recovered)).not.toHaveProperty("ok", false);
        expect(recovered.partial).toBe(true);
        expect(recovered.limitations).toContain("Read-only root viewport");
        const text = inspectText(recovered);
        expect(text).toContain("Fallback visible sentinel");
        expect(text).toContain("open shadow visible");
        expect(text).toContain("closed shadow visible");
        expect(text).not.toMatch(/CLOSED_LIGHT_SECRET|OPEN_LIGHT_SECRET|HIDDEN_SECRET|OFFSCREEN_SECRET/);
        const shadowButton = recovered.items.find((item: any) => item.role === "button" && item.name === "Shadow action original");
        expect(shadowButton, JSON.stringify(recovered)).toHaveProperty("actionable", true);
        expect(await runtime.call("click", { target: { id: shadowButton.id } })).not.toHaveProperty("ok", false);
        await page.evaluate(() => { (window as any).__testActionShadow.querySelector("span").textContent = "Shadow action replacement"; });
        expect(await runtime.call("click", { target: { id: shadowButton.id } })).toMatchObject({ ok: false, error: { code: "stale-id" } });
        expect(await page.locator("body").getAttribute("data-shadow-clicks")).toBe("1");
        const rootless = recovered.items.find((item: any) => item.role === "button" && item.name === "Rootless action");
        await page.evaluate(() => { document.getElementById("new-root-button")!.attachShadow({ mode: "closed" }).innerHTML = "<span>Replacement root action</span>"; });
        expect(await runtime.call("click", { target: { id: rootless.id } })).toMatchObject({ ok: false, error: { code: "stale-id" } });
        const sampledButton = recovered.items.find((item: any) => item.role === "button" && item.name === "Sample action");
        expect(sampledButton, JSON.stringify(recovered)).toHaveProperty("actionable", true);
        const bySampleId = await runtime.call("click", { target: { id: sampledButton.id } });
        expect(bySampleId, JSON.stringify(bySampleId)).not.toHaveProperty("ok", false);
        expect(await page.locator("output").textContent()).toBe("ID clicked");
        const foundSample = await runtime.call("find_elements", { target: { id: sampledButton.id } }) as any;
        expect(foundSample.elements[0]).toMatchObject({ id: sampledButton.id, actionable: true });
        mutateSampleIdentity = true;
        expect(await runtime.call("click", { target: { id: sampledButton.id } })).toMatchObject({ ok: false, error: { code: "stale-id" } });
        expect(await page.locator("body").getAttribute("data-id-clicks")).toBe("1");
        await page.getByRole("button", { name: "Different action" }).evaluate(button => { button.textContent = "Sample action"; });
        expect(await runtime.call("click", { target: { id: sampledButton.id } })).toMatchObject({ ok: false, error: { code: "stale-id" } });
        mutateShadow = "attach"; censusStarted = false;
        const changed = await runtime.call("inspect_page", { full: true }) as any;
        expect(changed).toMatchObject({ ok: false, error: { code: "stale-observation" } });
        const fresh = await runtime.call("inspect_page", { full: true }) as any;
        expect(fresh, JSON.stringify(fresh)).not.toHaveProperty("ok", false);
        const freshText = inspectText(fresh);
        expect(freshText).toContain("New shadow visible");
        expect(freshText).not.toContain("RACE_LIGHT_SECRET");
        mutateShadow = "insert"; censusStarted = false;
        const inserted = await runtime.call("inspect_page", { full: true }) as any;
        expect(inserted).toMatchObject({ ok: false, error: { code: "stale-observation" } });
        const afterInsert = await runtime.call("inspect_page", { full: true }) as any;
        expect(afterInsert, JSON.stringify(afterInsert)).not.toHaveProperty("ok", false);
        const insertedText = inspectText(afterInsert);
        expect(insertedText).toContain("Inserted shadow visible");
        expect(insertedText).not.toContain("INSERTED_LIGHT_SECRET");
        const originalRunItem = afterInsert.items.find((item: any) => item.role === "button" && item.name === "Sample action");
        automation.setContext({ conversationId: "other-conversation", runId: "other-run" });
        const samePage = await automation.createPage(1);
        const otherRun = await samePage.inspect({ full: true });
        const otherRunItem = otherRun.items.find((item: any) => item.role === "button" && item.name === "Sample action");
        expect(otherRunItem.id).not.toBe(originalRunItem.id);
        expect(() => samePage.elementById(originalRunItem.id)).toThrow("stale-id");
        await expect(samePage.elementById(otherRunItem.id).count()).resolves.toBe(1);
      } finally { command.mockRestore(); }
      await runtime.close();
      await expect(runtime.call("list_tabs")).rejects.toThrow("closed");
    } finally {
      await runtime?.close(); await context.close(); await rm(profile, { recursive: true, force: true });
    }
  }, 60_000);
});

it("keeps short IDs bound to the correct node past alphabetic IDs resembling private references", async () => {
  vi.unstubAllGlobals();
  const profile = await mkdtemp(join(tmpdir(), "surf-wax-short-ids-"));
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chrome", headless: true, viewport: { width: 1280, height: 800 }, args: ["--remote-debugging-port=0"],
  });
  let runtime: Awaited<ReturnType<typeof connectToolRuntime>> | undefined;
  try {
    const page = context.pages()[0]!;
    await page.goto("about:blank");
    await page.setContent(`<!doctype html><style>
      body{margin:0;display:grid;grid-template-columns:repeat(30,32px)}button{width:32px;height:20px;padding:0;font:10px Arial}
      </style>${Array.from({ length: 600 }, (_, index) => `<button onclick="document.body.dataset.clicked='${index}'">Same</button>`).join("")}`);
    const [port] = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n");
    runtime = await connectToolRuntime(`http://127.0.0.1:${port}`);
    const first = await runtime.call("inspect_page", { full: true, timeoutMs: 60_000 }) as any;
    expect(first, JSON.stringify(first)).not.toHaveProperty("ok", false);
    const button = first.items.find((item: any) => item.role === "button");
    expect(first.truncation.total).toBeGreaterThanOrEqual(600);
    expect(button).toHaveProperty("actionable", true);
    const refreshed = await runtime.call("inspect_page", { full: true, timeoutMs: 60_000 }) as any;
    expect(refreshed, JSON.stringify(refreshed)).not.toHaveProperty("ok", false);
    expect(refreshed.items.find((item: any) => item.role === "button").id).toBe(button.id);
    expect(await runtime.call("click", { target: { id: button.id } })).not.toHaveProperty("ok", false);
    expect(await page.locator("body").getAttribute("data-clicked")).toBe("0");
  } finally { await runtime?.close(); await context.close(); await rm(profile, { recursive: true, force: true }); }
}, 120_000);

it("captures and reads partitioned screenshots through standalone production tools", async () => {
  vi.unstubAllGlobals();
  const profile = await mkdtemp(join(tmpdir(), "surf-wax-visual-"));
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chrome", headless: true, viewport: null, args: ["--remote-debugging-port=0", "--window-size=1280,900"],
  });
  let runtime: Awaited<ReturnType<typeof connectToolRuntime>> | undefined;
  try {
    const page = context.pages()[0]!;
    const [port] = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n");
    runtime = await connectToolRuntime(`http://127.0.0.1:${port}`);
    await page.setContent('<canvas width="400" height="300"></canvas>');
    await page.evaluate(() => {
      const canvas = document.querySelector("canvas")!;
      const ctx = canvas.getContext("2d")!, image = ctx.createImageData(canvas.width, canvas.height);
      let seed = 17;
      for (let index = 0; index < image.data.length; index++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        image.data[index] = index % 4 === 3 ? 255 : seed >>> 24;
      }
      ctx.putImageData(image, 0, 0);
    });
    const screenshot = await runtime.call("take_screenshot", { target: { by: "css", value: "canvas" } }) as any;
    expect(screenshot, JSON.stringify(screenshot)).toMatchObject({ ok: true, state: "succeeded" });
    const artifactId = screenshot.result.screenshot.artifactId;
    expect(runtime.events.find(event => event.id === artifactId)?.artifactGraph).toBeDefined();
    const bytes = await runtime.call("read_artifact", { artifactId, path: ["base64"], offset: 0, limit: 32 }) as any;
    expect(bytes).toMatchObject({ ok: true, result: expect.stringMatching(/^iVBORw0KGgo/) });
    const length = Math.ceil(screenshot.result.artifact.byteLength / 3) * 4;
    const tail = await runtime.call("read_artifact", { artifactId, path: ["base64"], offset: length - 32, limit: 32 }) as any;
    expect(tail.ok).toBe(true);
    expect(Buffer.from(tail.result, "base64").subarray(-12)).toEqual(Buffer.from([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]));
    const job = await runtime.call("get_job", { jobId: screenshot.jobId }) as any;
    expect(job).toMatchObject({ state: "succeeded", result: { screenshot: { artifactId } } });
  } finally { await runtime?.close(); await context.close(); await rm(profile, { recursive: true, force: true }); }
}, 60_000);
