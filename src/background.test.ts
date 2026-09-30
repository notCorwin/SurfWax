import { afterEach, expect, it, vi } from "vitest";

const boot = vi.hoisted(() => ({ inputStateEvents: vi.fn() }));
vi.mock("./logging", () => ({
  EventLogger: class { inputStateEvents = boot.inputStateEvents; },
  fromLogValue: (value: unknown) => value,
}));

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("reports a failed bootstrap to both waiting writers and run claims", async () => {
  vi.resetModules();
  let rejectBoot!: (error: Error) => void;
  boot.inputStateEvents.mockReturnValue(new Promise((_, reject) => { rejectBoot = reject; }));
  const connects: ((port: chrome.runtime.Port) => void)[] = [];
  const event = () => ({ addListener: vi.fn(), removeListener: vi.fn() });
  vi.stubGlobal("chrome", {
    runtime: {
      id: "test", onConnect: { addListener: (listener: (port: chrome.runtime.Port) => void) => connects.push(listener) },
      onMessage: event(), onInstalled: event(), onStartup: event(), sendMessage: vi.fn(async () => undefined),
    },
    tabs: { query: vi.fn(async () => []), onUpdated: event() },
    sidePanel: { setPanelBehavior: vi.fn(async () => undefined) },
  });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  await import("./background");
  const writer = { name: "surf-wax-log-writer", onMessage: event(), onDisconnect: event(), postMessage: vi.fn() };
  let claim!: (message: unknown) => void;
  const owner = { name: "surf-wax-run-owner", onMessage: { addListener: (listener: (message: unknown) => void) => { claim = listener; } }, onDisconnect: event(), postMessage: vi.fn() };
  connects.forEach((listener) => listener(writer as unknown as chrome.runtime.Port));
  connects.forEach((listener) => listener(owner as unknown as chrome.runtime.Port));
  claim({ type: "claim", runId: "run", ownerId: "owner", conversationId: "conversation" });
  rejectBoot(new Error("IndexedDB unavailable"));
  await vi.waitFor(() => {
    expect(writer.postMessage).toHaveBeenCalledWith({ type: "writer-error", error: "后台初始化失败，请重新加载扩展后重试：IndexedDB unavailable" });
    expect(owner.postMessage).toHaveBeenCalledWith({ type: "claimed", error: "后台初始化失败：IndexedDB unavailable" });
  });
  expect(writer.postMessage.mock.calls.some(([message]) => message.type === "writer-ready")).toBe(false);
});
