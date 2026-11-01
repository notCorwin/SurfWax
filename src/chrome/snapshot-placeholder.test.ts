import { describe, expect, it } from "vitest";
import { PLACEHOLDER_EVIDENCE_SOURCE, samePlaceholderEvidence, type PlaceholderEvidence } from "./snapshot-placeholder";

const analyze = Function(`return (${PLACEHOLDER_EVIDENCE_SOURCE})`)() as (this: any, text: any, expected: string) => PlaceholderEvidence;

function fixture() {
  const defaults: Record<string, string> = {
    transform: "none", translate: "none", rotate: "none", scale: "none", filter: "none", "backdrop-filter": "none",
    "clip-path": "none", clip: "auto", "mask-image": "none", "-webkit-mask-box-image-source": "none", perspective: "none",
    "text-transform": "none", "-webkit-text-security": "none", "text-shadow": "none", "-webkit-text-stroke-width": "0px",
    "background-clip": "border-box", "text-overflow": "clip", "-webkit-line-clamp": "none", "font-family": "monospace",
    "-webkit-text-fill-color": "rgb(117, 117, 117)", "overflow-x": "visible", "overflow-y": "visible",
    "border-top-left-radius": "0px", "border-top-right-radius": "0px", "border-bottom-left-radius": "0px", "border-bottom-right-radius": "0px",
  };
  const makeStyle = () => ({ display: "block", visibility: "visible", opacity: "1", fontSize: "16px", properties: { ...defaults },
    getPropertyValue(name: string) { return this.properties[name] ?? ""; } });
  const geometry = { left: 10, right: 90, top: 10, bottom: 30 };
  const view: any = { innerWidth: 400, innerHeight: 300, CSS: { highlights: new Map() }, getComputedStyle: (element: any) => element.style };
  const doc: any = { defaultView: view, fonts: { status: "loaded" }, getSelection: () => ({ isCollapsed: true }),
    createRange: () => ({ selectNodeContents() {}, getClientRects: () => [geometry] }) };
  const element = () => ({ style: makeStyle(), clientLeft: 0, clientTop: 0, clientWidth: 200, clientHeight: 40,
    getBoundingClientRect: () => ({ left: 5, top: 5 }), getRootNode: () => ({ host: undefined }), parentElement: null as any });
  const host: any = { ...element(), ownerDocument: doc, isConnected: true, nodeName: "INPUT", value: "", placeholder: "Placeholder" };
  const parent: any = { ...element(), getRootNode: () => ({ host }), getAttribute: (name: string) => name === "pseudo" ? "-webkit-input-placeholder" : null };
  const text: any = { nodeType: 3, isConnected: true, ownerDocument: doc, parentElement: parent, data: "Placeholder", getRootNode: () => ({ host }) };
  parent.childNodes = [text]; parent.firstChild = text;
  return { doc, view, geometry, host, parent, text, run: () => analyze.call(host, text, "Placeholder") };
}

describe("placeholder paint evidence", () => {
  it("returns text only when the UA shadow node is fully visible and belongs to the host", () => {
    const f = fixture();
    expect(f.run()).toEqual({ status: "visible", text: "Placeholder" });
    f.text.getRootNode = () => ({ host: {} });
    expect(f.run()).toEqual({ status: "unknown" });
    f.text.getRootNode = () => ({ host: f.host });
    f.text.data = "changed";
    expect(f.run()).toEqual({ status: "unknown" });
  });

  it("does not return retained placeholder text for a filled or transparent control", () => {
    const f = fixture();
    f.host.value = "typed";
    expect(f.run()).toEqual({ status: "hidden" });
    f.host.value = "";
    f.parent.style.opacity = "0";
    expect(f.run()).toEqual({ status: "hidden" });
    f.parent.style.opacity = "1";
    f.parent.style.properties["-webkit-text-fill-color"] = "rgba(0, 0, 0, 0)";
    expect(f.run()).toEqual({ status: "hidden" });
  });

  it("does not return text clipped by the UA box, viewport, or a scrolled ancestor", () => {
    const f = fixture();
    f.parent.clientWidth = 20;
    expect(f.run()).toEqual({ status: "unknown" });
    f.parent.clientWidth = 200;
    f.geometry.left = -1;
    expect(f.run()).toEqual({ status: "unknown" });
    f.geometry.left = 10;
    f.host.style.properties["overflow-x"] = "hidden";
    f.host.clientWidth = 30;
    expect(f.run()).toEqual({ status: "unknown" });
  });

  it.each([
    ["text-transform", "uppercase"], ["-webkit-text-security", "disc"], ["text-shadow", "red 1px 1px"],
    ["mask-image", "linear-gradient(black, transparent)"], ["filter", "blur(1px)"],
    ["font-family", '"Unknown web font"'], ["text-overflow", "ellipsis"],
  ])("does not guess when %s is %s", (name, value) => {
    const f = fixture(); f.parent.style.properties[name] = value;
    expect(f.run()).toEqual({ status: "unknown" });
  });

  it("requires a collapsed selection and settled fonts", () => {
    const f = fixture(); f.doc.getSelection = () => ({ isCollapsed: false });
    expect(f.run()).toEqual({ status: "unknown" });
    f.doc.getSelection = () => ({ isCollapsed: true }); f.doc.fonts.status = "loading";
    expect(f.run()).toEqual({ status: "unknown" });
  });

  it("compares only normalized evidence, including visible text", () => {
    expect(samePlaceholderEvidence({ status: "visible", text: "A" }, { status: "visible", text: "A" })).toBe(true);
    expect(samePlaceholderEvidence({ status: "visible", text: "A" }, { status: "visible", text: "B" })).toBe(false);
    expect(samePlaceholderEvidence({ status: "visible", text: "A" }, { status: "hidden" })).toBe(false);
    expect(samePlaceholderEvidence({ status: "unknown" }, { status: "unknown" })).toBe(true);
  });
});
