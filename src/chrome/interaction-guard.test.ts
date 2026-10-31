import { afterEach, describe, expect, it, vi } from "vitest";
import { authorizeGuardInput, installPageGuard, removePageGuard, targetEditor } from "./interaction-guard";

const guard = () => (globalThis as any).__surfWaxBlocker;
function hardware(type: string, target: EventTarget, values: Record<string, unknown> = {}) {
  return { type, target, isTrusted: true, timeStamp: performance.now(),
    preventDefault: vi.fn(), stopImmediatePropagation: vi.fn(), ...values } as unknown as Event;
}
targetEditor();
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

  it("inserts an empty value only into an enabled focused editing context", () => {
    const input = document.createElement("input"); document.body.append(input); input.focus();
    installPageGuard("owner");
    const focus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const oldEnabled = Object.getOwnPropertyDescriptor(document, "queryCommandEnabled");
    const oldCommand = Object.getOwnPropertyDescriptor(document, "execCommand");
    const enabled = vi.fn(() => true);
    const execute = vi.fn(() => {
      const inserted = hardware("input", input);
      guard().block(inserted);
      expect(inserted.preventDefault).not.toHaveBeenCalled();
      return true;
    });
    Object.defineProperty(document, "queryCommandEnabled", { configurable: true, value: enabled });
    Object.defineProperty(document, "execCommand", { configurable: true, value: execute });
    try {
      expect(guard().insertTarget(input, "")).toEqual({ ok: true });
      expect(execute).toHaveBeenCalledExactlyOnceWith("insertText", false, "");
      const later = hardware("input", input); guard().block(later);
      expect(later.preventDefault).toHaveBeenCalledOnce();
      enabled.mockReturnValue(false);
      expect(guard().insertTarget(input, "")).toEqual({ ok: false, reason: "insert-disabled" });
      focus.mockReturnValue(false); enabled.mockReturnValue(true);
      expect(guard().insertTarget(input, "")).toEqual({ ok: false, reason: "document-not-focused" });
      expect(execute).toHaveBeenCalledOnce();
    } finally {
      if (oldEnabled) Object.defineProperty(document, "queryCommandEnabled", oldEnabled); else delete (document as any).queryCommandEnabled;
      if (oldCommand) Object.defineProperty(document, "execCommand", oldCommand); else delete (document as any).execCommand;
    }
  });

  it("rejects a different focused target, including within a closed shadow root", () => {
    const host = document.createElement("div"), shadow = host.attachShadow({ mode: "closed" });
    const intended = document.createElement("input"), other = document.createElement("input");
    shadow.append(intended, other); document.body.append(host); other.focus();
    installPageGuard("owner");
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const oldEnabled = Object.getOwnPropertyDescriptor(document, "queryCommandEnabled");
    const oldCommand = Object.getOwnPropertyDescriptor(document, "execCommand");
    const execute = vi.fn(() => true);
    Object.defineProperty(document, "queryCommandEnabled", { configurable: true, value: () => true });
    Object.defineProperty(document, "execCommand", { configurable: true, value: execute });
    try {
      expect(guard().insertTarget(intended, "wrong")).toEqual({ ok: false, reason: "focus-changed" });
      expect(execute).not.toHaveBeenCalled();
      expect(guard().insertTarget(other, "right")).toEqual({ ok: true });
      expect(execute).toHaveBeenCalledExactlyOnceWith("insertText", false, "right");
    } finally {
      if (oldEnabled) Object.defineProperty(document, "queryCommandEnabled", oldEnabled); else delete (document as any).queryCommandEnabled;
      if (oldCommand) Object.defineProperty(document, "execCommand", oldCommand); else delete (document as any).execCommand;
    }
  });

  it("rechecks the current type and native and ARIA editability before insertion", () => {
    const parent = document.createElement("div"), input = document.createElement("input");
    parent.append(input); document.body.append(parent); input.focus();
    installPageGuard("owner");
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const oldEnabled = Object.getOwnPropertyDescriptor(document, "queryCommandEnabled");
    const oldCommand = Object.getOwnPropertyDescriptor(document, "execCommand");
    const execute = vi.fn(() => true);
    Object.defineProperty(document, "queryCommandEnabled", { configurable: true, value: () => true });
    Object.defineProperty(document, "execCommand", { configurable: true, value: execute });
    try {
      input.type = "checkbox";
      expect(guard().insertTarget(input, "x")).toEqual({ ok: false, reason: "not-editable" });
      input.type = "text"; input.readOnly = true;
      expect(guard().insertTarget(input, "x")).toEqual({ ok: false, reason: "not-editable" });
      input.readOnly = false; input.disabled = true;
      expect(guard().insertTarget(input, "x")).toEqual({ ok: false, reason: "not-editable" });
      input.disabled = false; input.setAttribute("aria-readonly", "true");
      expect(guard().insertTarget(input, "x")).toEqual({ ok: false, reason: "not-editable" });
      input.removeAttribute("aria-readonly"); parent.setAttribute("aria-disabled", "true");
      expect(guard().insertTarget(input, "x")).toEqual({ ok: false, reason: "not-editable" });
      expect(execute).not.toHaveBeenCalled();
    } finally {
      if (oldEnabled) Object.defineProperty(document, "queryCommandEnabled", oldEnabled); else delete (document as any).queryCommandEnabled;
      if (oldCommand) Object.defineProperty(document, "execCommand", oldCommand); else delete (document as any).execCommand;
    }
  });
});
