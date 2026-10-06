import { afterEach, describe, expect, it, vi } from "vitest";
import { callUserScript } from "./script-client";
afterEach(() => vi.unstubAllGlobals());
describe("program persistent-script capabilities", () => {
  it("validates native definitions and edits without changing IDs or silently passing enabled fields", async () => {
    const sendMessage = vi.fn(async () => ({ ok: true, result: "saved" }));
    vi.stubGlobal("chrome", { runtime: { sendMessage } });
    const script = { id: "sample", matches: ["https://example.com/*"], js: [{ code: "1" }] };
    await expect(callUserScript("create", [script])).resolves.toBe("saved");
    await expect(callUserScript("create", [{ ...script, enabled: false }])).rejects.toThrow();
    await expect(callUserScript("edit", [{ id: "sample", changes: { js: [{ code: "2" }], runAt: null } }])).resolves.toBe("saved");
    await expect(callUserScript("edit", [{ id: "sample", changes: { id: "changed" } }])).rejects.toThrow();
    await expect(callUserScript("userscript-create", [script])).rejects.toThrow("Unsupported");
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });
  it("routes all five script methods through the persistent background manager", async () => {
    const sendMessage = vi.fn(async (message) => ({ ok: true, result: message.method }));
    vi.stubGlobal("chrome", { runtime: { sendMessage } });
    const script = { id: "sample", matches: ["https://example.com/*"], js: [{ code: "1" }] };
    const args = [[], ["sample"], [script], [{ id: "sample", changes: { js: [{ code: "2" }] } }], [{ id: "sample", enabled: false }]];
    for (const [index, method] of ["list", "read", "create", "edit", "setEnabled"].entries()) await expect(callUserScript(method, args[index]!)).resolves.toBe(method);
    expect(sendMessage.mock.calls.map(([{ operationId, ...message }]) => { expect(operationId).toEqual(expect.any(String)); return message; })).toEqual([
      { type: "surf-wax:user-scripts", method: "list", args: args[0] },
      { type: "surf-wax:user-scripts", method: "read", args: args[1] },
      { type: "surf-wax:user-scripts", method: "create", args: args[2] },
      { type: "surf-wax:user-scripts", method: "edit", args: args[3] },
      { type: "surf-wax:user-scripts", method: "setEnabled", args: args[4] },
    ]);
  });
  it("ends a pending mutation on abort and reports unknown effects", async () => {
    vi.stubGlobal("chrome", { runtime: { sendMessage: () => new Promise(() => undefined) } });
    const controller = new AbortController();
    const pending = callUserScript("setEnabled", [{ id: "sample", enabled: false }], controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError", effectUnknown: true });
  });
});
