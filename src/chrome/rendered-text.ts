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
  const textProofs = new WeakMap<Text, boolean>();
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
    let valid = true;
    const nodes: Text[] = [];
    const visit = (el: Element) => {
      if (omitted(el)) return;
      if (proven.has(el)) { valid = valid && proven.get(el)!; return; }
      // This local reader does not claim composed-tree serialization.
      if (el.shadowRoot || el.localName.includes("-") || el.localName === "slot") valid = false;
      for (const node of el.childNodes) {
        if (node.nodeType === 1) visit(node as Element);
        else if (node.nodeType === 3 && node.nodeValue?.trim() && style(el).visibility === "visible") nodes.push(node as Text);
      }
    };
    visit(root);
    let accepted = new Set<Text>();
    if (valid && nodes.some(node => !textProofs.has(node))) {
      install(true);
      sample(NaN, [], { shadowRoots: [], placeholder: () => null, controls: () => null },
        { scope: root, accept: value => { accepted = value; } });
      for (const node of nodes) textProofs.set(node, accepted.has(node));
    }
    const summarize = (el: Element): boolean => {
      if (omitted(el)) return true;
      if (proven.has(el)) return proven.get(el)!;
      let complete = !el.shadowRoot && !el.localName.includes("-") && el.localName !== "slot";
      for (const node of el.childNodes) {
        if (node.nodeType === 1) complete = summarize(node as Element) && complete;
        else if (node.nodeType === 3 && node.nodeValue?.trim() && style(el).visibility === "visible")
          complete = textProofs.get(node as Text) === true && complete;
      }
      proven.set(el, complete); return complete;
    };
    valid = summarize(root) && valid;
    const value = valid && root.isConnected ? root.innerText : null;
    results.set(root, value); return value;
  };
}
export const RENDERED_TEXT_READER_SOURCE = `(${createRenderedTextReader.toString()})(${sampleReadableSnapshot.toString()}, ${snapshotObservationPrimitives.toString()})`;
export const RENDERED_TEXT_SOURCE = `function(){return (${RENDERED_TEXT_READER_SOURCE}).call(this)}`;
