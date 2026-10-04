/** These functions are self-contained because Chrome serializes them into each frame. */
export function primePageGuard(): void {
  const scope = globalThis as any;
  if (scope.__surfWaxEarlyGuard) return;
  const capture = (event: Event) => scope.__surfWaxBlocker?.block?.(event);
  for (const type of ["pointerdown", "pointerup", "pointermove", "pointercancel", "mousedown", "mouseup", "mousemove", "click", "dblclick", "auxclick", "contextmenu", "touchstart", "touchmove", "touchend", "touchcancel", "wheel", "keydown", "keyup", "keypress", "beforeinput", "input", "paste", "cut", "drop", "dragstart", "dragover", "dragenter", "dragleave", "dragend", "compositionstart", "compositionupdate", "compositionend"]) {
    globalThis.addEventListener(type, capture, { capture: true, passive: false });
  }
  scope.__surfWaxEarlyGuard = capture;
}

export function installPageGuard(runId: string, css = "", passThrough = false): void {
  const scope = globalThis as any;
  const previous = scope.__surfWaxBlocker;
  if (previous?.runId === runId && previous.overlay.isConnected) {
    previous.overlay.style.setProperty("pointer-events", passThrough ? "none" : "auto", "important");
    return;
  }
  if (typeof previous === "function") previous(); else previous?.cleanup();
  const overlay = document.createElement("div");
  overlay.id = "__surf-wax-page-guard";
  overlay.setAttribute("aria-hidden", "true");
  overlay.style.cssText = `all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;background:transparent!important;pointer-events:${passThrough ? "none" : "auto"}!important;cursor:wait!important`;
  const shadow = overlay.attachShadow({ mode: "closed" });
  const style = document.createElement("style"); style.textContent = css; shadow.append(style);
  const types = ["pointerdown", "pointerup", "pointermove", "pointercancel", "mousedown", "mouseup", "mousemove", "click", "dblclick", "auxclick", "contextmenu", "touchstart", "touchmove", "touchend", "touchcancel", "wheel", "keydown", "keyup", "keypress", "beforeinput", "input", "paste", "cut", "drop", "dragstart", "dragover", "dragenter", "dragleave", "dragend", "compositionstart", "compositionupdate", "compositionend"];
  let ticket: { stamp: number; expires: number; text?: string } | undefined;
  let derived: { target: EventTarget | null; text?: string; clipboard?: boolean } | undefined;
  let atomic = false;
  const seen = new WeakSet<Event>();
  const block = (event: Event) => {
    if (seen.has(event)) return;
    seen.add(event);
    if (!event.isTrusted || atomic) return;
    if (ticket && performance.now() < ticket.expires && Math.abs(event.timeStamp - ticket.stamp) < 1) {
      if (event.type === "keypress") derived = { target: event.target, text: ticket.text };
      if (event.type === "keydown" && ((event as KeyboardEvent).ctrlKey || (event as KeyboardEvent).metaKey)
        && /^[vx]$/i.test((event as KeyboardEvent).key)) derived = { target: event.target, clipboard: true };
      return;
    }
    if (ticket && performance.now() < ticket.expires && derived?.target === event.target) {
      if (derived.clipboard && ["paste", "cut", "beforeinput", "input"].includes(event.type)
        || ["beforeinput", "input"].includes(event.type) && (event as InputEvent).data === derived.text) {
        if (event.type === "input") derived = undefined;
        return;
      }
    }
    derived = undefined;
    event.preventDefault(); event.stopImmediatePropagation();
  };
  for (const type of types) globalThis.addEventListener(type, block, { capture: true, passive: false });
  const cleanup = () => {
    ticket = undefined; derived = undefined; atomic = false;
    for (const type of types) globalThis.removeEventListener(type, block, true);
    overlay.remove(); delete scope.__surfWaxBlocker;
  };
  scope.__surfWaxBlocker = { runId, overlay, cleanup, block,
    authorize(timestamp: number, text?: string) {
      ticket = { stamp: timestamp * 1000 - performance.timeOrigin, expires: performance.now() + 1000, text };
      derived = undefined;
    },
    revoke() { ticket = undefined; derived = undefined; },
    insert(text: string) {
      const active = document.activeElement;
      if (!active || !document.hasFocus() || !(active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
        || active instanceof HTMLElement && active.isContentEditable)) return false;
      // The atomic DOM edit keeps the listeners installed. Hardware events cannot
      // interleave this JS task; beforeinput/input still reach the site's handlers.
      atomic = true;
      try { return document.execCommand("insertText", false, text); } finally { atomic = false; }
    },
  };
  document.documentElement.appendChild(overlay);
}

export function removePageGuard(): void {
  const blocker = (globalThis as any).__surfWaxBlocker;
  if (typeof blocker === "function") blocker(); else blocker?.cleanup();
  document.getElementById("__surf-wax-page-guard")?.remove();
}

export function authorizeGuardInput(runId: string, timestamp?: number, text?: string): void {
  const blocker = (globalThis as any).__surfWaxBlocker;
  if (blocker?.runId !== runId) return;
  if (timestamp == null) blocker.revoke(); else blocker.authorize(timestamp, text);
}

export function insertGuardedText(runId: string, text: string): boolean {
  const blocker = (globalThis as any).__surfWaxBlocker;
  return blocker?.runId === runId ? blocker.insert(text) : false;
}
