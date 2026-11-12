import { sampleReadableSnapshot } from "./snapshot-readable-source.js";
import { snapshotObservationPrimitives } from "./snapshot-observation-primitives.js";
import { markerInkRects } from "./rendered-marker";

/** All evidence lives only for this synchronous call: no DOM, CSS, frame or
 * animation evidence survives a task boundary. Chrome owns serialization. */
export function createRenderedTextReader(
  sample: typeof sampleReadableSnapshot,
  install: typeof snapshotObservationPrimitives,
  nativeMarkers: typeof markerInkRects,
  nativeEvidence?: { roots: readonly ShadowRoot[]; complete: boolean },
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
  let unprovenMarkers = new Set<Element>(), unprovenNativeFields = new Map<Text, Set<Element>>();
  const queryToken = (globalThis as any)[Symbol.for("surf-wax.rendered-text-active-query.v1")];
  const nativeState = (globalThis as any)[Symbol.for("surf-wax.rendered-marker-query.v1")];
  const attemptedNativeProof = typeof queryToken === "string" && nativeState?.token === queryToken;
  const ensureProof = () => {
    if (sampled) return;
    if (document.readyState !== "complete" || document.fonts.status !== "loaded") { sampled = true; return; }
    const dom = (globalThis as any).chrome?.dom;
    if (typeof dom?.openOrClosedShadowRoot !== "function" && nativeEvidence?.complete !== true) {
      if (queryToken) throw Object.assign(new Error("Native shadow topology is required"), {
        name: "NativeRootsRequired", nativeTextQuery: queryToken, completeShadowCensus: true, nativeHosts: [],
      });
      sampled = true; return; // No complete topology means no accepted text.
    }
    sampled = true;
    install(true);
    sample(NaN, nativeEvidence?.roots ?? [], { ...(nativeEvidence?.complete ? { shadowRoots: nativeEvidence.roots } : {}), placeholder: () => null, controls: () => null,
      ...(attemptedNativeProof ? { markerRects: nativeMarkers(nativeState) } : {}) },
      { scope: document.documentElement, accept: (nodes, unsafe, _painted, markers, fields) => { accepted = nodes; unknown = unsafe; unprovenMarkers = markers; unprovenNativeFields = fields; } });
  };
  const composedUnknown = (el: Element) => {
    if (el.localName === "slot" || el.shadowRoot) return true;
    if (!el.localName.includes("-")) return false;
    // Absence needs either the extension API or the complete native census.
    const dom = (globalThis as any).chrome?.dom;
    return typeof dom?.openOrClosedShadowRoot === "function" ? !!dom.openOrClosedShadowRoot(el) || unknown.has(el)
      : nativeEvidence?.complete !== true || nativeEvidence.roots.some(root => root.host === el) || unknown.has(el);
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
    if (root.ownerDocument !== document || !view || !root.isConnected || !(root instanceof view.HTMLElement) || omitted(root)
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
    if (!valid && queryToken && !nativeEvidence && [...unprovenNativeFields.keys()].some(node => root.contains(node))) {
      // One needed dependency prepares the same sample's deduplicated field
      // identities for all candidates; unrelated failure alone triggers none.
      const hosts = new Set([...unprovenNativeFields.values()].flatMap(fields => [...fields]));
      throw Object.assign(new Error("Native field roots are required"), {
        name: "NativeRootsRequired", nativeTextQuery: queryToken, completeShadowCensus: false, nativeHosts: [...hosts],
      });
    }
    if (!valid && queryToken && !attemptedNativeProof && unprovenMarkers.size) {
      const error = Object.assign(new Error("Native marker paint evidence is required"), {
        name: "NativeTextProofRequired", nativeMarkerQuery: queryToken, markerOwners: [...unprovenMarkers],
      });
      throw error;
    }
    const value = valid && root.isConnected ? root.innerText : null;
    results.set(root, value); return value;
  };
}
export const RENDERED_TEXT_READER_SOURCE = `(${createRenderedTextReader.toString()})(${sampleReadableSnapshot.toString()}, ${snapshotObservationPrimitives.toString()}, ${markerInkRects.toString()}, typeof surfWaxNativeRoots === "undefined" ? undefined : surfWaxNativeRoots)`;
export const RENDERED_TEXT_SOURCE = `function(){return (${RENDERED_TEXT_READER_SOURCE}).call(this)}`;
