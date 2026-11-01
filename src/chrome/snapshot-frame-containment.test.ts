import { describe, expect, it } from "vitest";
import { FRAME_OWNER_FULLY_VISIBLE_SOURCE, type FrameContainmentEvidence } from "./snapshot-frame-containment";

const analyze = Function(`return (${FRAME_OWNER_FULLY_VISIBLE_SOURCE})`)() as (this: any) => FrameContainmentEvidence;
const html = "http://www.w3.org/1999/xhtml";

function fixture() {
  const defaults: Record<string, string> = {
    transform: "none", translate: "none", rotate: "none", scale: "none", zoom: "1", filter: "none", "backdrop-filter": "none",
    "clip-path": "none", clip: "auto", "mask-image": "none", "-webkit-mask-box-image-source": "none", perspective: "none",
    contain: "none", "content-visibility": "visible", "mix-blend-mode": "normal", "overflow-x": "visible", "overflow-y": "visible",
    "border-top-left-radius": "0px", "border-top-right-radius": "0px", "border-bottom-left-radius": "0px", "border-bottom-right-radius": "0px",
  };
  const makeStyle = () => ({ display: "block", visibility: "visible", opacity: "1", properties: { ...defaults },
    getPropertyValue(name: string) { return this.properties[name] ?? ""; } });
  const view: any = { innerWidth: 800, innerHeight: 600,
    visualViewport: { offsetLeft: 0, offsetTop: 0, width: 800, height: 600, scale: 1 },
    getComputedStyle: (element: any) => element.style };
  const doc: any = { defaultView: view };
  const element = () => ({ style: makeStyle(), namespaceURI: html, ownerDocument: doc, isConnected: true, parentElement: null as any,
    clientLeft: 0, clientTop: 0, clientWidth: 600, clientHeight: 400,
    rect: { left: 20, top: 20, right: 620, bottom: 420 },
    getBoundingClientRect() { return this.rect; }, getRootNode: () => ({ host: undefined }) });
  const parent: any = element();
  const owner: any = { ...element(), localName: "iframe", parentElement: parent, rect: { left: 40, top: 40, right: 340, bottom: 240 } };
  return { view, doc, parent, owner, run: () => analyze.call(owner) };
}

describe("parent frame owner containment proof", () => {
  it("accepts a connected HTML iframe or frame fully contained by its parent viewport", () => {
    const f = fixture();
    expect(f.run()).toEqual({ status: "visible" });
    f.owner.localName = "frame";
    expect(f.run()).toEqual({ status: "visible" });
    f.owner.localName = "object";
    expect(f.run()).toEqual({ status: "unknown" });
  });

  it("rejects empty, partly offscreen, detached and non-HTML owners", () => {
    const f = fixture(); f.owner.rect.right = 900;
    expect(f.run()).toEqual({ status: "unknown" });
    f.owner.rect.right = 340; f.owner.rect.top = -1;
    expect(f.run()).toEqual({ status: "unknown" });
    f.owner.rect.top = 40; f.owner.rect.bottom = 40;
    expect(f.run()).toEqual({ status: "unknown" });
    f.owner.rect.bottom = 240; f.owner.isConnected = false;
    expect(f.run()).toEqual({ status: "unknown" });
    f.owner.isConnected = true; f.owner.namespaceURI = "http://www.w3.org/2000/svg";
    expect(f.run()).toEqual({ status: "unknown" });
  });

  it("requires full containment in each clipping ancestor's client box", () => {
    const f = fixture(); f.parent.style.properties["overflow-x"] = "hidden";
    expect(f.run()).toEqual({ status: "visible" });
    f.parent.clientLeft = 30;
    expect(f.run()).toEqual({ status: "unknown" });
    f.parent.clientLeft = 0; f.parent.clientWidth = 100;
    expect(f.run()).toEqual({ status: "unknown" });
    f.parent.style.properties["overflow-x"] = "visible"; f.parent.style.properties["overflow-y"] = "clip"; f.parent.clientHeight = 100;
    expect(f.run()).toEqual({ status: "unknown" });
  });

  it("requires containment in the visual viewport after pinch zoom or pan", () => {
    const f = fixture();
    f.view.visualViewport = { offsetLeft: 0, offsetTop: 0, width: 200, height: 300, scale: 2 };
    expect(f.run()).toEqual({ status: "unknown" });
    f.view.visualViewport.offsetLeft = 30; f.view.visualViewport.width = 400;
    expect(f.run()).toEqual({ status: "visible" });
    f.view.visualViewport.offsetLeft = 50;
    expect(f.run()).toEqual({ status: "unknown" });
    f.view.visualViewport = null;
    expect(f.run()).toEqual({ status: "unknown" });
  });

  it("follows shadow-host ancestry and rejects SVG coordinate systems", () => {
    const f = fixture(); f.owner.parentElement = null; f.owner.getRootNode = () => ({ host: f.parent });
    f.parent.style.properties["overflow-x"] = "hidden"; f.parent.clientWidth = 100;
    expect(f.run()).toEqual({ status: "unknown" });
    f.parent.clientWidth = 600;
    expect(f.run()).toEqual({ status: "visible" });
    f.parent.namespaceURI = "http://www.w3.org/2000/svg";
    expect(f.run()).toEqual({ status: "unknown" });
  });

  it("follows assigned slots through shadow-tree clips and rejects cycles", () => {
    const f = fixture();
    const slot: any = { ...f.parent, parentElement: f.parent };
    f.owner.parentElement = null; f.owner.assignedSlot = slot;
    f.parent.style.properties["overflow-x"] = "hidden"; f.parent.clientWidth = 100;
    expect(f.run()).toEqual({ status: "unknown" });
    f.parent.clientWidth = 600;
    expect(f.run()).toEqual({ status: "visible" });
    slot.assignedSlot = slot;
    expect(f.run()).toEqual({ status: "unknown" });
  });

  it.each([
    ["transform", "matrix(1, 0, 0, 1, 2, 0)"], ["translate", "1px"], ["rotate", "1deg"], ["scale", "2"], ["zoom", "2"],
    ["filter", "blur(1px)"], ["backdrop-filter", "blur(1px)"], ["clip-path", "inset(0px)"], ["clip", "rect(0px, 10px, 10px, 0px)"],
    ["mask-image", "linear-gradient(black, transparent)"], ["-webkit-mask-box-image-source", "url(x)"], ["perspective", "100px"],
    ["contain", "paint"], ["content-visibility", "auto"], ["mix-blend-mode", "multiply"], ["overflow-x", "unknown"],
  ])("refuses effects or unknown styles on an ancestor: %s=%s", (property, value) => {
    const f = fixture(); f.parent.style.properties[property] = value;
    expect(f.run()).toEqual({ status: "unknown" });
  });

  it("refuses rounded owner and rounded clipping ancestors but permits unrelated rounded containers", () => {
    const f = fixture(); f.owner.style.properties["border-top-left-radius"] = "4px";
    expect(f.run()).toEqual({ status: "unknown" });
    f.owner.style.properties["border-top-left-radius"] = "0px"; f.parent.style.properties["border-top-left-radius"] = "4px";
    expect(f.run()).toEqual({ status: "visible" });
    f.parent.style.properties["overflow-y"] = "hidden";
    expect(f.run()).toEqual({ status: "unknown" });
  });

  it("does not prove visibility of invisible or detached ancestry", () => {
    const f = fixture(); f.parent.style.opacity = "0";
    expect(f.run()).toEqual({ status: "unknown" });
    f.parent.style.opacity = "0.5";
    expect(f.run()).toEqual({ status: "unknown" });
    f.parent.style.opacity = "1"; f.parent.style.visibility = "hidden";
    expect(f.run()).toEqual({ status: "unknown" });
    f.parent.style.visibility = "visible"; f.parent.isConnected = false;
    expect(f.run()).toEqual({ status: "unknown" });
  });
});
