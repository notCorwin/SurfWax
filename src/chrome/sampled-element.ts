/** Runs in the same isolated world as the synchronous sample. */
export function resolveSampledElement(token: string, key: number): Element | null {
  const registry = (globalThis as any)[Symbol.for("surf-wax.snapshot-observation-identities.v1")];
  if (registry?.document !== document || registry.token !== token) return null;
  const entry = registry.elements?.get(key), node = entry?.node.deref();
  if (!(node instanceof Element) || !node.isConnected || node.ownerDocument !== document
    || registry.fingerprint(node) !== entry.identity) { registry.elements.delete(key); return null; }
  for (const label of entry.labels ?? []) {
    let child = label.node.deref();
    if (!child?.isConnected || child.nodeValue !== label.value) { registry.elements.delete(key); return null; }
    for (const reference of label.parents) {
      const parent = reference.deref();
      if (!parent?.isConnected) { registry.elements.delete(key); return null; }
      const assigned = parent instanceof HTMLSlotElement ? parent.assignedNodes() : [];
      const connected = assigned.length ? assigned.includes(child)
        : child.parentNode === parent || child.parentNode instanceof ShadowRoot && child.parentNode.host === parent;
      if (!connected) { registry.elements.delete(key); return null; }
      child = parent;
    }
  }
  return node;
}
