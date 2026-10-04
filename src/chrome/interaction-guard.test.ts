import { afterEach, describe, expect, it, vi } from "vitest";
import { authorizeGuardInput, installPageGuard, removePageGuard } from "./interaction-guard";

const guard = () => (globalThis as any).__surfWaxBlocker;
function hardware(type: string, target: EventTarget, values: Record<string, unknown> = {}) {
  return { type, target, isTrusted: true, timeStamp: performance.now(),
    preventDefault: vi.fn(), stopImmediatePropagation: vi.fn(), ...values } as unknown as Event;
}
afterEach(() => { removePageGuard(); document.body.replaceChildren(); vi.restoreAllMocks(); });

describe("run-bound interaction tickets", () => {
  it("blocks hardware events even while the overlay permits agent hit testing", () => {
    installPageGuard("owner", "", true);
    const event = hardware("keydown", document.body);
    guard().block(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopImmediatePropagation).toHaveBeenCalledOnce();
    expect(guard().overlay.style.getPropertyValue("pointer-events")).toBe("none");
  });

  it("authorizes native text once across early and late capture listeners and blocks interleaved user input", () => {
    const input = document.createElement("input"); document.body.append(input);
    installPageGuard("owner");
    const timestamp = Date.now() / 1000 + 86400;
    authorizeGuardInput("other-run", timestamp, "海");
    const rejected = hardware("keypress", input, { timeStamp: timestamp * 1000 - performance.timeOrigin });
    guard().block(rejected); expect(rejected.preventDefault).toHaveBeenCalledOnce();
    authorizeGuardInput("owner", timestamp, "海");
    const key = hardware("keypress", input, { timeStamp: timestamp * 1000 - performance.timeOrigin });
    guard().block(key); guard().block(key);
    const before = hardware("beforeinput", input, { data: "海" });
    guard().block(before); guard().block(before);
    const inserted = hardware("input", input, { data: "海" });
    guard().block(inserted); guard().block(inserted);
    expect(key.preventDefault).not.toHaveBeenCalled();
    expect(before.preventDefault).not.toHaveBeenCalled();
    expect(inserted.preventDefault).not.toHaveBeenCalled();
    const user = hardware("beforeinput", input, { data: "海" });
    guard().block(user); expect(user.preventDefault).toHaveBeenCalledOnce();
  });

  it("revokes a ticket on cancellation, replacement and cleanup", () => {
    const timestamp = Date.now() / 1000 + 86400;
    installPageGuard("first"); authorizeGuardInput("first", timestamp);
    authorizeGuardInput("first");
    const cancelled = hardware("click", document.body, { timeStamp: timestamp * 1000 - performance.timeOrigin });
    guard().block(cancelled); expect(cancelled.preventDefault).toHaveBeenCalledOnce();
    authorizeGuardInput("first", timestamp);
    const oldOverlay = guard().overlay;
    installPageGuard("second");
    const oldRun = hardware("click", document.body, { timeStamp: timestamp * 1000 - performance.timeOrigin });
    guard().block(oldRun); expect(oldRun.preventDefault).toHaveBeenCalledOnce();
    expect(oldOverlay.isConnected).toBe(false);
    removePageGuard();
    expect(guard()).toBeUndefined();
    expect(document.getElementById("__surf-wax-page-guard")).toBeNull();
  });
});
