import { afterEach, describe, expect, it } from "vitest";
import { AX_ELLIPSIS_GEOMETRY_SOURCE } from "./snapshot-ellipsis-geometry";

const key = Symbol.for("surf-wax.text-paint-cache.v1");
afterEach(() => { Reflect.deleteProperty(globalThis, key); });

function fixture() {
  const rect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height, right: x + width, bottom: y + height });
  const normal = { display: "block", visibility: "visible", opacity: "1", transform: "none", perspective: "none",
    filter: "none", backdropFilter: "none", clipPath: "none", clip: "auto", maskImage: "none", webkitMaskImage: "none", borderImageSource: "none", borderImageOutset: "0",
    mixBlendMode: "normal", animationName: "none", transitionDuration: "0s", boxShadow: "none", textShadow: "none", outlineStyle: "none",
    direction: "ltr", writingMode: "horizontal-tb", whiteSpace: "nowrap", textOverflow: "ellipsis", overflowX: "hidden", overflowY: "hidden",
    webkitLineClamp: "none", textTransform: "none", webkitTextSecurity: "none", letterSpacing: "normal", wordSpacing: "0px",
    webkitTextStrokeWidth: "0px", backgroundClip: "border-box", webkitBackgroundClip: "border-box", fontFeatureSettings: "normal",
    fontVariationSettings: "normal", borderTopLeftRadius: "0px", borderTopRightRadius: "0px", borderBottomLeftRadius: "0px", borderBottomRightRadius: "0px", font: "16px Arial", fontSize: "16px", fontKerning: "auto", backgroundColor: "rgb(255, 255, 255)", backgroundImage: "none", color: "rgb(0, 0, 0)",
    webkitTextFillColor: "rgb(0, 0, 0)", paddingLeft: "0px", paddingRight: "0px", paddingTop: "0px", paddingBottom: "0px" };
  const host = { childNodes: [] as unknown[], firstChild: null as unknown, parentElement: null, clientLeft: 0, clientTop: 0,
    clientWidth: 100, clientHeight: 20, scrollLeft: 0, scrollTop: 0, localName: "button", namespaceURI: "http://www.w3.org/1999/xhtml", shadowRoot: null,
    hasAttribute: () => false, getBoundingClientRect: () => rect(0, 0, 100, 20), style: { ...normal } };
  const text = { nodeType: 3, isConnected: true, data: "Next TASK-123456", parentElement: host, ownerDocument: null as unknown,
    getRootNode: () => doc };
  host.childNodes.push(text); host.firstChild = text;
  const elements: unknown[] = [host], texts: unknown[] = [text], overflowPosition = { x: 500, y: 500 };
  const state = { topLayer: false, animations: [] as Array<{ playState: string }> };
  const doc = { defaultView: null as unknown, fonts: { status: "loaded", check: () => true }, fullscreenElement: null,
    querySelector: () => state.topLayer ? {} : null, getAnimations: () => state.animations,
    querySelectorAll: () => elements, createTreeWalker: () => { let index = 0; return { nextNode: () => texts[index++] ?? null }; }, createElement: () => ({ getContext: () => ({ font: "", fontKerning: "auto",
      measureText: (value: string) => ({ width: value === "…" || value === "overflow" ? 10 : 150, actualBoundingBoxLeft: 0, actualBoundingBoxRight: value === "overflow" ? 10 : 150, actualBoundingBoxAscent: 12, actualBoundingBoxDescent: 3 }) }) }),
    createRange: () => { let end = 0, selected: unknown = text; return { selectNodeContents: (node: unknown) => { selected = node; end = text.data.length; }, setStart: () => {}, setEnd: (_: unknown, value: number) => { end = value; },
      getClientRects: () => selected !== text ? [rect(overflowPosition.x, overflowPosition.y, 10, 14)] : end === 4 ? [rect(0, 1, 40, 15), rect(0, 1, 40, 15)] : [rect(0, 1, 150, 15), rect(0, 1, 40, 15)] }; } };
  const view = { document: doc, innerWidth: 1000, innerHeight: 1000, getSelection: () => ({ isCollapsed: true }),
    getComputedStyle: (el: typeof host, pseudo?: string) => pseudo ? { content: "none" } : el.style };
  doc.defaultView = view; text.ownerDocument = doc;
  Reflect.set(globalThis, key, { token: "session", nodes: new Map([[1, { deref: () => text }]]) });
  const call = new Function(`return (${AX_ELLIPSIS_GEOMETRY_SOURCE})`)() as (this: typeof doc, token: string, requests: unknown[]) => unknown[];
  const request = { backendNodeId: 1, prefix: "Next", sourceText: text.data, frameUnobscured: true, noShadowRoots: true, basePainted: true };
  return { doc, call, request, text, host, elements, texts, rect, normal, overflowPosition, state };
}

describe("AX ellipsis geometry", () => {
  it("batches stable, independently proven candidates and rejects stale text/cache", () => {
    const f = fixture();
    const [proof, again, missing] = f.call.call(f.doc, "session", [f.request, f.request, { ...f.request, backendNodeId: 2 }]);
    expect(proof).toMatchObject({ prefixBounds: { x: 0, width: 40 }, ellipsisWidth: 12, singleLine: true, paintProven: true });
    expect(again).toEqual(proof); expect(missing).toBeNull();
    expect(f.call.call(f.doc, "other", [f.request])).toEqual([null]);
    f.text.data += "x";
    expect(f.call.call(f.doc, "session", [f.request])).toEqual([null]);
  });
  it("requires independently established frame, shadow and paint evidence", () => {
    const f = fixture();
    for (const key of ["frameUnobscured", "noShadowRoots", "basePainted"]) {
      expect(f.call.call(f.doc, "session", [{ ...f.request, [key]: false }])).toEqual([null]);
    }
  });
  it("rejects a possible overlay even when it would ignore pointer events", () => {
    const f = fixture();
    f.elements.push({ ...f.host, style: { ...f.normal, pointerEvents: "none" }, getBoundingClientRect: () => f.rect(5, 1, 10, 15) });
    expect(f.call.call(f.doc, "session", [f.request])).toEqual([null]);
  });
  it("indexes text that overflows an otherwise nonintersecting element", () => {
    const f = fixture();
    const parent = { ...f.host, style: { ...f.normal, overflowX: "visible", overflowY: "visible" }, getBoundingClientRect: () => f.rect(500, 500, 10, 10) };
    f.elements.push(parent);
    f.texts.push({ data: "overflow", parentElement: parent });
    expect(f.call.call(f.doc, "session", [f.request])[0]).not.toBeNull();
    f.overflowPosition.x = 8; f.overflowPosition.y = 2;
    expect(f.call.call(f.doc, "session", [f.request])).toEqual([null]);
  });
  it("rejects insufficient contrast", () => {
    const f = fixture(); f.host.style.backgroundColor = "rgb(0, 0, 0)";
    expect(f.call.call(f.doc, "session", [f.request])).toEqual([null]);
  });
  it("rejects top-layer backdrops, active script animations and outsetting border images", () => {
    const f = fixture();
    f.state.topLayer = true;
    expect(f.call.call(f.doc, "session", [f.request])).toEqual([null]);
    f.state.topLayer = false; f.state.animations.push({ playState: "running" });
    expect(f.call.call(f.doc, "session", [f.request])).toEqual([null]);
    f.state.animations.length = 0;
    f.elements.push({ ...f.host, style: { ...f.normal, borderImageSource: 'url("/x")', borderImageOutset: "200px" }, getBoundingClientRect: () => f.rect(500, 500, 10, 10) });
    expect(f.call.call(f.doc, "session", [f.request])).toEqual([null]);
  });
  it("rejects custom markers even when list-style is none", () => {
    const f = fixture();
    f.elements.push({ ...f.host, style: { ...f.normal, display: "list-item", listStyleType: "none", listStyleImage: "none" }, getBoundingClientRect: () => f.rect(500, 500, 10, 10) });
    expect(f.call.call(f.doc, "session", [f.request])).toEqual([null]);
  });
  it("fails closed on a tiny clip or a possible out-of-box effect", () => {
    const f = fixture(); f.host.clientWidth = 45;
    expect(f.call.call(f.doc, "session", [f.request])).toEqual([null]);
    f.host.clientWidth = 100;
    f.elements.push({ ...f.host, style: { ...f.normal, boxShadow: "0 0 40px black" }, getBoundingClientRect: () => f.rect(500, 500, 10, 10) });
    expect(f.call.call(f.doc, "session", [f.request])).toEqual([null]);
  });
});
