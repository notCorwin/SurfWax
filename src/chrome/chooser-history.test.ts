import { expect, it, vi } from "vitest";
import { AutomationRuntime } from "./automation";

it("keeps the captured chooser across same-document navigation but invalidates it on a new document", async () => {
  const runtime = new AutomationRuntime({
    chromeApi: {} as never,
    command: vi.fn(async () => ({})),
    pressChord: vi.fn(async () => undefined),
    detach: vi.fn(async () => undefined),
    mark: vi.fn(async () => undefined),
  });
  await runtime.createPage(3);
  const source = { tabId: 3, sessionId: "frame" };
  runtime.handleEvent(source, "Page.fileChooserOpened", { backendNodeId: 7, mode: "selectSingle" });
  const chooser = runtime.currentChooser(source, 7);
  expect(chooser).toBeDefined();
  runtime.handleEvent(source, "Page.navigatedWithinDocument", { frameId: "frame", url: "https://example.test/#hash" });
  expect(runtime.currentChooser(source, 7)).toBe(chooser);
  runtime.handleEvent(source, "Page.frameNavigated", { frame: { id: "frame" } });
  expect(runtime.currentChooser(source, 7)).toBeUndefined();
  runtime.dispose();
});
