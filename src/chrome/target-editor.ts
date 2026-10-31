export function targetEditor(target: Element, text = "", replace = false): { ok: boolean; reason?: string } {
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
