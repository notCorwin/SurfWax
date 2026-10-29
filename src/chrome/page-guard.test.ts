import { afterEach, expect, it, vi } from "vitest";
import { guardActivePage } from "./page-guard";

vi.mock("../agent/coordinator", () => ({ getRunIdentity: () => ({ runId: "run", ownerId: "owner", conversationId: "conversation" }) }));

afterEach(() => { vi.unstubAllGlobals(); delete (globalThis as any).__surfWaxGuard; });

it("coalesces concurrent repairs but repeats after a later document change", async () => {
  let receive!: (message: any) => void;
  const postMessage = vi.fn();
  const port = { postMessage, disconnect: vi.fn(), onMessage: { addListener: (listener: typeof receive) => { receive = listener; } }, onDisconnect: { addListener: vi.fn() } };
  vi.stubGlobal("chrome", { tabs: { query: async () => [{ id: 7 }] }, runtime: { connect: () => port } });
  const controller = new AbortController();
  const started = guardActivePage(controller.signal);
  await vi.waitFor(() => expect(postMessage).toHaveBeenCalledTimes(1));
  receive({ id: postMessage.mock.calls[0]![0].id, ready: true });
  const cleanup = await started;
  try {
    const bridge = (globalThis as any).__surfWaxGuard;
    const first = bridge.refresh(7);
    const second = bridge.refresh(7);
    const third = bridge.refresh(7);
    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(postMessage.mock.calls[1]![0]).toMatchObject({ tabId: 7, refresh: true, runId: "run" });
    receive({ id: postMessage.mock.calls[1]![0].id, ready: true });
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledTimes(3));
    receive({ id: postMessage.mock.calls[2]![0].id, ready: true });
    await Promise.all([first, second, third]);
    expect(postMessage).toHaveBeenCalledTimes(3);
  } finally { cleanup(); }
});
