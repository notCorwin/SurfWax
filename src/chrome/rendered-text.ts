import { sampleReadableSnapshot } from "./snapshot-readable-source.js";
import { snapshotObservationPrimitives } from "./snapshot-observation-primitives.js";

/** All evidence lives only for this synchronous call: no DOM, CSS, frame or
 * animation evidence survives a task boundary. Chrome owns serialization. */
export function createRenderedTextReader(
  sample: typeof sampleReadableSnapshot,
  install: typeof snapshotObservationPrimitives,
) {
  const results = new WeakMap<Element, string | null>();
  const styles = new WeakMap<Element, CSSStyleDeclaration>();
  const excluded = new WeakMap<Element, boolean>();
  const proven = new WeakMap<Element, boolean>();
  // One page-wide topology/paint pass serves every candidate in this query.
  // Do not retain this closure across an await, mutation, frame or epoch change.
  let sampled = false;
  let accepted = new Set<Text>();
  let unknown = new Set<Element>();
  const ensureProof = () => {
    if (sampled) return;
    sampled = true;
    install(true);
    sample(NaN, [], { shadowRoots: [], placeholder: () => null, controls: () => null },
      { scope: document.documentElement, accept: (nodes, unsafe) => { accepted = nodes; unknown = unsafe; } });
  };
  const composedUnknown = (el: Element) => {
    if (el.localName === "slot" || el.shadowRoot) return true;
    if (!el.localName.includes("-")) return false;
    // Only the extension API can prove absence of closed author roots.
    const dom = (globalThis as any).chrome?.dom;
    return typeof dom?.openOrClosedShadowRoot !== "function" || !!dom.openOrClosedShadowRoot(el) || unknown.has(el);
  };
  const style = (el: Element) => {
    let value = styles.get(el);
    if (!value) { value = el.ownerDocument.defaultView!.getComputedStyle(el); styles.set(el, value); }
    return value;
  };
  // Only exclusions already honored by innerText can be skipped. Opacity,
  // masks and foreground coverage need the shared paint proof instead.
  const omitted = (el: Element): boolean => {
    if (excluded.has(el)) return excluded.get(el)!;
    const value = style(el).display === "none" || !!el.parentElement && omitted(el.parentElement);
    excluded.set(el, value); return value;
  };
  return function read(this: Element): string | null {
    const root = this, view = root.ownerDocument.defaultView;
    if (results.has(root)) return results.get(root)!;
    if (!view || !root.isConnected || !(root instanceof view.HTMLElement) || omitted(root)
      || !root.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return null;
    ensureProof();
    const summarize = (el: Element): boolean => {
      if (omitted(el)) return true;
      if (proven.has(el)) return proven.get(el)!;
      let complete = !composedUnknown(el) && !unknown.has(el);
      for (const node of el.childNodes) {
        if (node.nodeType === 1) complete = summarize(node as Element) && complete;
        else if (node.nodeType === 3 && node.nodeValue?.trim() && style(el).visibility === "visible")
          complete = accepted.has(node as Text) && complete;
      }
      proven.set(el, complete); return complete;
    };
    const valid = summarize(root);
    const value = valid && root.isConnected ? root.innerText : null;
    results.set(root, value); return value;
  };
}
export const RENDERED_TEXT_READER_SOURCE = `(${createRenderedTextReader.toString()})(${sampleReadableSnapshot.toString()}, ${snapshotObservationPrimitives.toString()})`;
export const RENDERED_TEXT_SOURCE = `function(){return (${RENDERED_TEXT_READER_SOURCE}).call(this)}`;
