import { afterEach, describe, expect, it, vi } from "vitest";
import { DeferredProgramPage } from "./program-handles";
import { executeSandboxProgram, type ProgramHostState } from "./program-host";

class TestPort {
  onmessage?: (event: { data: any }) => void;
  sent: any[] = [];
  postMessage(message: unknown) { this.sent.push(message); }
  start() {}
  close() {}
  receive(data: unknown) { this.onmessage?.({ data }); }
}
class TestChannel {
  static latest: TestChannel;
  port1 = new TestPort();
  port2 = new TestPort();
  constructor() { TestChannel.latest = this; }
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function hostFixture() {
  const frame = { hidden: false, src: "", onload: undefined as undefined | (() => void), onerror: undefined as undefined | (() => void),
    contentWindow: { postMessage: vi.fn() }, remove: vi.fn() };
  vi.spyOn(document, "createElement").mockReturnValue(frame as unknown as HTMLIFrameElement);
  vi.spyOn(document.body, "append").mockImplementation(() => {});
  vi.stubGlobal("MessageChannel", TestChannel);
  vi.stubGlobal("__SURF_WAX_DEV_SERVER__", "http://127.0.0.1:5173");
  vi.stubGlobal("chrome", { runtime: { getURL: (path: string) => `chrome-extension://id/${path}` },
    tabs: { onRemoved: { addListener: vi.fn(), removeListener: vi.fn() } } });
  return { frame, controller: new AbortController(), states: [] as ProgramHostState[] };
}

describe("program host diagnostics", () => {
  it("distinguishes frame load, sandbox readiness and the first worker RPC", async () => {
    const { frame, controller, states } = hostFixture();
    const pending = executeSandboxProgram("sensitive source", {}, controller.signal, (state) => states.push(state));
    const rejected = expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
    expect(states.at(-1)).toEqual({ stage: "iframe-loading", receivedRpc: false, pendingBindings: 0, pendingOperations: 0 });
    frame.onload!();
    expect(states.at(-1)?.stage).toBe("sandbox-initializing");
    TestChannel.latest.port1.receive({ type: "ready" });
    expect(states.at(-1)).toEqual({ stage: "worker-running", receivedRpc: false, pendingBindings: 0, pendingOperations: 0 });
    controller.abort(Object.assign(new Error("deadline"), { name: "TimeoutError" }));
    await rejected;
    expect(frame.remove).toHaveBeenCalledOnce();
    expect(JSON.stringify(states)).not.toContain("sensitive source");
  });

  it("reports a pending page binding separately from a pending capability", async () => {
    const { frame, controller, states } = hostFixture();
    const page = new DeferredProgramPage(3, () => new Promise(() => {}));
    const pending = executeSandboxProgram("ignored", { page }, controller.signal, (state) => states.push(state));
    const rejected = expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
    frame.onload!();
    const port = TestChannel.latest.port1;
    port.receive({ type: "ready" });
    const run = port.sent.find((message) => message.type === "run");
    const pageId = run.capabilities.$plainObject.entries.find(([key]: [string]) => key === "page")[1].$remoteObject.id;
    port.receive({ type: "rpc", id: "1", reference: { id: pageId, steps: [] }, args: [] });
    await vi.waitFor(() => expect(states.at(-1)).toEqual({ stage: "worker-running", receivedRpc: true, pendingBindings: 1, pendingOperations: 0 }));
    controller.abort(Object.assign(new Error("deadline"), { name: "TimeoutError" }));
    await rejected;
  });

  it("reports a capability that has started but not returned", async () => {
    const { frame, controller, states } = hostFixture();
    const pending = executeSandboxProgram("ignored", { wait: () => new Promise(() => {}) }, controller.signal, (state) => states.push(state));
    const rejected = expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
    frame.onload!();
    const port = TestChannel.latest.port1;
    port.receive({ type: "ready" });
    const run = port.sent.find((message) => message.type === "run");
    const id = run.capabilities.$plainObject.entries.find(([key]: [string]) => key === "wait")[1].$remoteFunction;
    port.receive({ type: "rpc", id: "1", reference: { id, steps: [] }, args: [] });
    await vi.waitFor(() => expect(states.at(-1)).toEqual({ stage: "worker-running", receivedRpc: true, pendingBindings: 0, pendingOperations: 1 }));
    controller.abort(Object.assign(new Error("deadline"), { name: "TimeoutError" }));
    await rejected;
  });
});
