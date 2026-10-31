import { describe, expect, it, vi } from "vitest";
import { GuardedInputContexts } from "./guarded-input";

const root = { tabId: 3 }, child = { tabId: 3, sessionId: "child" };
const origin = "chrome-extension://extension-id";
const created = (id: number, frameId: string) => ({ context: { id, origin, auxData: { type: "isolated", frameId } } });

function harness() {
  let matching = 2;
  const send = vi.fn(async (_source: any, method: string, params: any): Promise<any> => {
    if (method === "DOM.resolveNode") return { object: { objectId: `object-${params.executionContextId}` } };
    if (method === "Runtime.callFunctionOn") {
      if (params.functionDeclaration.includes("insertTarget(this, text, replace)")) return { result: { value: { ok: true } } };
      return { result: { value: params.objectId === `object-${matching}` } };
    }
    return {};
  });
  const contexts = new GuardedInputContexts(origin, send);
  return { contexts, send, matching: (id: number) => { matching = id; } };
}

describe("guarded target input", () => {
  it("matches the node's document once and reuses that world for later edits", async () => {
    const { contexts, send } = harness();
    contexts.event(root, "Runtime.executionContextCreated", created(1, "root"));
    contexts.event(root, "Runtime.executionContextCreated", created(2, "frame"));
    contexts.event(root, "Runtime.executionContextCreated", { context: { id: 3, origin: "https://page.test", auxData: { type: "isolated", frameId: "frame" } } });
    const validate = vi.fn();
    await contexts.insert(root, 17, "run", "", validate);
    await contexts.insert(root, 17, "run", "next", validate);
    const calls = send.mock.calls.filter(([, method]) => method === "Runtime.callFunctionOn");
    expect(calls.filter(([, , params]) => params.functionDeclaration.includes("ownerDocument === document"))).toHaveLength(2);
    expect(calls.filter(([, , params]) => params.functionDeclaration.includes("insertTarget(this, text, replace)")).map(([, , params]) => params.objectId)).toEqual(["object-2", "object-2"]);
    expect(send.mock.calls.some(([, method]) => method === "Input.insertText")).toBe(false);
    expect(validate).toHaveBeenCalledTimes(4);
  });

  it("deduplicates concurrent world discovery without merging the edits", async () => {
    const { contexts, send } = harness();
    contexts.event(root, "Runtime.executionContextCreated", created(2, "frame"));
    let release!: () => void, started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const waiting = new Promise<void>((resolve) => { started = resolve; });
    const original = send.getMockImplementation()!;
    send.mockImplementation(async (source, method, params) => {
      if (method === "Runtime.callFunctionOn" && params.functionDeclaration.includes("ownerDocument === document")) { started(); await gate; }
      return original(source, method, params);
    });
    const one = contexts.insert(root, 17, "run", "one", () => undefined);
    await waiting;
    const two = contexts.insert(root, 17, "run", "two", () => undefined);
    release(); await Promise.all([one, two]);
    expect(send.mock.calls.filter(([, method, params]) => method === "Runtime.callFunctionOn" && params.functionDeclaration.includes("ownerDocument === document"))).toHaveLength(1);
    expect(send.mock.calls.filter(([, method, params]) => method === "Runtime.callFunctionOn" && params.functionDeclaration.includes("insertTarget(this, text, replace)"))).toHaveLength(2);
  });

  it("expires a cached world on destruction, clearing, and target detach", async () => {
    const { contexts, send } = harness();
    contexts.event(root, "Runtime.executionContextCreated", created(2, "frame"));
    await contexts.insert(root, 17, "run", "one", () => undefined);
    contexts.event(root, "Runtime.executionContextDestroyed", { executionContextId: 2 });
    await expect(contexts.insert(root, 17, "run", "two", () => undefined)).rejects.toThrow("guard-context-unavailable");
    contexts.event(root, "Runtime.executionContextCreated", created(2, "new-document"));
    await contexts.insert(root, 17, "run", "three", () => undefined);
    contexts.event(root, "Runtime.executionContextsCleared", {});
    await expect(contexts.insert(root, 17, "run", "four", () => undefined)).rejects.toThrow("guard-context-unavailable");
    contexts.event(child, "Runtime.executionContextCreated", created(2, "child"));
    await contexts.insert(child, 17, "run", "child", () => undefined);
    contexts.event(root, "Target.detachedFromTarget", { sessionId: "child" });
    await expect(contexts.insert(child, 17, "run", "stale", () => undefined)).rejects.toThrow("guard-context-unavailable");
    expect(send.mock.calls.filter(([, method, params]) => method === "Runtime.callFunctionOn" && params.functionDeclaration.includes("insertTarget(this, text, replace)"))).toHaveLength(3);
  });

  it("does not write when the run expires after resolving the target", async () => {
    const { contexts, send } = harness();
    contexts.event(root, "Runtime.executionContextCreated", created(2, "frame"));
    let count = 0;
    await expect(contexts.insert(root, 17, "run", "value", () => { if (++count === 2) throw new Error("run expired"); })).rejects.toThrow("run expired");
    expect(send.mock.calls.some(([, method, params]) => method === "Runtime.callFunctionOn" && params.functionDeclaration.includes("insertTarget(this, text, replace)"))).toBe(false);
  });

  it("fails without fallback when the target loses focus", async () => {
    const { contexts, send } = harness();
    contexts.event(root, "Runtime.executionContextCreated", created(2, "frame"));
    const original = send.getMockImplementation()!;
    send.mockImplementation(async (source, method, params) => method === "Runtime.callFunctionOn" && params.functionDeclaration.includes("insertTarget(this, text, replace)")
      ? { result: { value: { ok: false, reason: "focus-changed" } } } : original(source, method, params));
    await expect(contexts.insert(root, 17, "run", "value", () => undefined)).rejects.toThrow("focus-changed");
    expect(send.mock.calls.some(([, method]) => method === "Input.insertText")).toBe(false);
  });

  it("edits the exact resolved node without a guard and rechecks authorization", async () => {
    const { contexts, send } = harness();
    send.mockImplementation(async (_source, method, params) => {
      if (method === "DOM.resolveNode") return { object: { objectId: "exact-target" } };
      if (method === "Runtime.callFunctionOn") return { result: { value: { ok: true } } };
      return {};
    });
    const validate = vi.fn();
    await contexts.insertUnguarded(child, 17, "", true, validate);
    expect(validate).toHaveBeenCalledTimes(2);
    const insertion = send.mock.calls.find(([, method]) => method === "Runtime.callFunctionOn");
    expect(insertion?.[0]).toEqual(child);
    expect(insertion?.[2]).toMatchObject({ objectId: "exact-target", arguments: [{ value: "" }, { value: true }] });
    expect(send.mock.calls.some(([, method]) => method === "Input.insertText")).toBe(false);
  });
});
