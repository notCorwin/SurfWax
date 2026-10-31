/** These functions are self-contained because Chrome serializes them into each frame. */
type GuardInputReceipt = { blockedBeforeInput: boolean; keydown: boolean; keyup: boolean; keypress: boolean };
export function targetEditor(target?: Element, text = "", replace = false): { ok: boolean; reason?: string } | undefined {
  if (!target) { (globalThis as any).__surfWaxTargetEditor = targetEditor; return; }
  if (!target.isConnected || target.ownerDocument !== document) return { ok: false, reason: "target-detached" };
  const element = target as HTMLElement & { type?: string; disabled?: boolean; readOnly?: boolean; assignedSlot?: HTMLSlotElement | null };
  const kind = element.localName === "input" ? ["text", "search", "email", "tel", "url", "password", "number"].includes(element.type ?? "")
    : element.localName === "textarea" ? true : !["select", "button", "option"].includes(element.localName) && element.isContentEditable;
  if (!kind || element.disabled || element.matches(":disabled") || element.readOnly || element.getAttribute("aria-readonly") === "true")
    return { ok: false, reason: "not-editable" };
  let ancestor: Element | null = element;
  while (ancestor) {
    const disabled = ancestor.getAttribute("aria-disabled")?.toLowerCase();
    if (disabled === "true") return { ok: false, reason: "not-editable" };
    if (disabled === "false") break;
    const root = ancestor.getRootNode();
    ancestor = (ancestor as HTMLElement).assignedSlot || ancestor.parentElement || (root.nodeType === Node.DOCUMENT_FRAGMENT_NODE ? (root as ShadowRoot).host : null);
  }
  const focusError = (): string | undefined => {
    let node: Element = target, root: Node = node.getRootNode();
    while (root.nodeType === Node.DOCUMENT_FRAGMENT_NODE && (root as ShadowRoot).host) {
      const shadow = root as ShadowRoot;
      if (shadow.activeElement !== node) return "focus-changed";
      node = shadow.host; root = node.getRootNode();
    }
    if (root !== document) return "wrong-root";
    if (document.activeElement !== node) return "wrong-active-element";
    if (!document.hasFocus()) return "document-not-focused";
  };
  const initialFocusError = focusError();
  if (initialFocusError) return { ok: false, reason: initialFocusError };
  if (!document.queryCommandEnabled("insertText")) return { ok: false, reason: "insert-disabled" };
  if (replace) {
    // Chromium disables selectAll for an empty text control or a contenteditable
    // containing only its placeholder <br>; inserting directly is sufficient.
    const emptyControl = (element.localName === "input" || element.localName === "textarea") && (element as HTMLInputElement).value === "" && !(element as HTMLInputElement).validity.badInput;
    const children = [...target.childNodes].filter((child) => child.nodeType !== Node.TEXT_NODE || child.nodeValue !== "");
    const emptyEditable = element.isContentEditable && (children.length === 0 || children.length === 1 && children[0]?.nodeName === "BR");
    if (document.queryCommandEnabled("selectAll")) {
      if (!document.execCommand("selectAll")) return { ok: false, reason: "select-failed" };
    } else if (!emptyControl && !emptyEditable) return { ok: false, reason: "select-failed" };
    const currentFocusError = focusError();
    if (currentFocusError) return { ok: false, reason: currentFocusError };
  }
  return document.execCommand("insertText", false, text) ? { ok: true } : { ok: false, reason: "edit-rejected" };
}

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
  const style = document.createElement("style"); style.textContent = css;
  const visual = document.createElement("div"); visual.className = "guard-visual";
  shadow.append(style, visual);
  const types = ["pointerdown", "pointerup", "pointermove", "pointercancel", "mousedown", "mouseup", "mousemove", "click", "dblclick", "auxclick", "contextmenu", "touchstart", "touchmove", "touchend", "touchcancel", "wheel", "keydown", "keyup", "keypress", "beforeinput", "input", "paste", "cut", "drop", "dragstart", "dragover", "dragenter", "dragleave", "dragend", "compositionstart", "compositionupdate", "compositionend"];
  let ticket: { stamp: number; expires: number; text?: string; observeBeforeInput?: boolean; receipt: GuardInputReceipt } | undefined;
  let derived: { target: EventTarget | null; expires: number; text?: string; clipboard?: boolean } | undefined;
  let atomic = false;
  const seen = new WeakSet<Event>();
  const block = (event: Event) => {
    if (seen.has(event)) return;
    seen.add(event);
    if (!event.isTrusted || atomic) return;
    if (ticket && performance.now() < ticket.expires && Math.abs(event.timeStamp - ticket.stamp) < 1) {
      if (event.type === "keydown" || event.type === "keyup" || event.type === "keypress") ticket.receipt[event.type] = true;
      if (event.type === "keypress") derived = { target: event.target, text: ticket.text, expires: Math.min(ticket.expires, performance.now() + 1000) };
      if (event.type === "keydown" && ((event as KeyboardEvent).ctrlKey || (event as KeyboardEvent).metaKey)
        && /^[vx]$/i.test((event as KeyboardEvent).key)) derived = { target: event.target, clipboard: true, expires: Math.min(ticket.expires, performance.now() + 1000) };
      return;
    }
    if (ticket && performance.now() < ticket.expires && derived && performance.now() < derived.expires && derived.target === event.target) {
      if (derived.clipboard && ["paste", "cut", "beforeinput", "input"].includes(event.type)
        || ["beforeinput", "input"].includes(event.type) && (event as InputEvent).data === derived.text) {
        if (event.type === "input") derived = undefined;
        return;
      }
    }
    if (event.type === "beforeinput" && ticket?.observeBeforeInput) ticket.receipt.blockedBeforeInput = true;
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
    authorize(timestamp: number, text?: string, observeBeforeInput = false) {
      const stamp = timestamp * 1000 - performance.timeOrigin;
      // A stalled worker must never leave a ticket usable when real hardware
      // timestamps approach the deliberately future-dated CDP timestamp.
      ticket = { stamp, expires: stamp - 60_000, text, observeBeforeInput,
        receipt: { blockedBeforeInput: false, keydown: false, keyup: false, keypress: false } };
      derived = undefined;
    },
    revoke() { const receipt = ticket?.receipt; ticket = undefined; derived = undefined; return receipt; },
    insertTarget(target: Element, text: string, replace = false) {
      if (typeof scope.__surfWaxTargetEditor !== "function") return { ok: false, reason: "editor-unavailable" };
      // No hardware events can interleave this synchronous editing task.
      atomic = true;
      try { return scope.__surfWaxTargetEditor(target, text, replace); }
      finally { atomic = false; }
    },
  };
  document.documentElement.appendChild(overlay);
}

export function removePageGuard(): void {
  const blocker = (globalThis as any).__surfWaxBlocker;
  if (typeof blocker === "function") blocker(); else blocker?.cleanup();
  document.getElementById("__surf-wax-page-guard")?.remove();
}

export function authorizeGuardInput(runId: string, timestamp?: number, text?: string, observeBeforeInput = false): true | GuardInputReceipt | undefined {
  const blocker = (globalThis as any).__surfWaxBlocker;
  if (blocker?.runId !== runId) return;
  if (timestamp == null) return blocker.revoke();
  blocker.authorize(timestamp, text, observeBeforeInput);
  return true;
}
