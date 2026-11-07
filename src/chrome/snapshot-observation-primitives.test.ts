import { afterEach, describe, expect, it } from "vitest";
import { snapshotObservationPrimitives } from "./snapshot-observation-primitives.js";

const box = { left: 24, top: 64, right: 1194.171875, bottom: 112 };
const label = { left: 24, top: 79, right: 51.828125, bottom: 96 };
const defaults = {
  "mask-image": "none", "clip-path": "none", "mask-mode": "match-source", "mask-origin": "border-box", "mask-clip": "border-box",
  "mask-size": "auto", "mask-position": "0% 0%", "mask-repeat": "repeat", "mask-composite": "add", "border-radius": "0px",
};
const navigationMask = "linear-gradient(to right, rgba(0, 0, 0, 0) 0px, rgba(0, 0, 0, 0) 0px, rgb(0, 0, 0) 0px, rgb(0, 0, 0) 100%, rgba(0, 0, 0, 0) 100%, rgba(0, 0, 0, 0) 100%)";
const api = snapshotObservationPrimitives();

describe("local CSS effect coverage", () => {
  it("proves a real navigation mask's opaque interior, including the layout box edge", () => {
    expect(api.effectCoverage({ ...defaults, "mask-image": navigationMask }, box, [label])).toBe("complete");
    expect(api.maskStatus({ ...defaults, "mask-image": navigationMask }, box, [{ ...label, left: 23.99 }])).toBe("unknown");
  });

  it("separates opaque plateaus, transparent intervals and partially masked text", () => {
    const mask = { ...defaults, "mask-image": "linear-gradient(to right, transparent 0px 20px, black 40px calc(100% - 40px), transparent 100%)" };
    expect(api.maskStatus(mask, box, [{ ...label, left: 30, right: 40 }])).toBe("transparent");
    expect(api.maskStatus(mask, box, [{ ...label, left: 50, right: 60 }])).toBe("unknown");
    expect(api.maskStatus(mask, box, [{ ...label, left: 70, right: 120 }])).toBe("opaque");
    expect(api.maskStatus(mask, box, [{ ...label, left: 70, right: 120 }, { ...label, left: 30, right: 40 }])).toBe("unknown");
  });

  it("does not round a nonzero or nearly opaque alpha into a proof", () => {
    for (const opacity of ["0.000001", "0.999999", "99.9999%"])
      expect(api.maskStatus({ ...defaults, "mask-image": `linear-gradient(to right, rgb(0 0 0 / ${opacity}), rgb(0 0 0 / ${opacity}))` }, box, [label])).toBe("unknown");
  });

  it("handles reversed and vertical axes, omitted positions and CSS stop fixup", () => {
    const local = { left: 0, top: 0, right: 100, bottom: 100 }, top = { left: 20, top: 10, right: 30, bottom: 20 };
    expect(api.maskStatus({ ...defaults, "mask-image": "linear-gradient(to top, transparent 20%, black 50%)" }, local, [top])).toBe("opaque");
    expect(api.maskStatus({ ...defaults, "mask-image": "linear-gradient(black, black, transparent 80%)" }, local, [top])).toBe("opaque");
    expect(api.maskStatus({ ...defaults, "mask-image": "linear-gradient(to left, black 80%, transparent 20%)" }, local, [top])).toBe("opaque");
    expect(api.maskStatus({ ...defaults, "mask-image": "linear-gradient(black, transparent)" }, local, [top])).toBe("unknown");
  });

  it("requires the complete mask positioning/compositing model and known geometry", () => {
    const style = { ...defaults, "mask-image": navigationMask };
    for (const change of [
      { "mask-mode": "luminance" }, { "mask-origin": "content-box" }, { "mask-clip": "no-clip" }, { "mask-position": "10px 0px" },
      { "mask-size": "50% 100%" }, { "mask-composite": "subtract" }, { "mask-image": `${navigationMask}, ${navigationMask}` },
      { "mask-image": "linear-gradient(45deg, black, black)" }, { "mask-image": "repeating-linear-gradient(black, black)" },
      { "mask-image": "url(#resource)" }, { "transform": "matrix(2, 0, 0, 2, 0, 0)" }, { "mask-border-source": "url(#border)" },
    ]) expect(api.maskStatus({ ...style, ...change }, box, [label]), JSON.stringify(change)).toBe("unknown");
  });

  it("proves rounded inset interiors without exposing cropped corners or partial text", () => {
    const style = { ...defaults, "clip-path": "inset(0px round 24px)" };
    expect(api.effectCoverage(style, box, [{ ...label, left: 50, right: 100 }])).toBe("complete");
    expect(api.effectCoverage(style, box, [{ left: 24, top: 64, right: 34, bottom: 74 }])).toBe("unknown");
    expect(api.clipStatus({ ...style, "clip-path": "inset(20px)" }, box, [label])).toBe("unknown");
    expect(api.clipStatus({ ...style, "clip-path": "inset(50%)" }, box, [label])).toBe("transparent");
    expect(api.clipStatus({ ...style, "clip-path": "circle(50%)" }, box, [label])).toBe("unknown");
    expect(api.clipStatus({ ...style, "clip-path": "inset(2px round 50%)" }, box, [label])).toBe("unknown");
  });

  it("normalizes oversized elliptical radii and preserves independent axis offsets", () => {
    const local = { left: 0, top: 0, right: 200, bottom: 60 }, center = { left: 80, top: 20, right: 120, bottom: 40 };
    expect(api.clipStatus({ ...defaults, "clip-path": "inset(0px round 9999px)" }, local, [center])).toBe("opaque");
    expect(api.clipStatus({ ...defaults, "clip-path": "inset(0px round 3.35544e+07px)" }, local, [center])).toBe("opaque");
    expect(api.clipStatus({ ...defaults, "clip-path": "inset(0px round 40px / 20px)" }, local, [center])).toBe("opaque");
    expect(api.clipStatus({ ...defaults, "clip-path": "inset(10% calc(10% + 5px))" }, local, [center])).toBe("opaque");
  });

  it("distinguishes an empty clip from a nonempty clip shifted beyond its owner's box", () => {
    const local = { left: 0, top: 0, right: 100, bottom: 100 };
    expect(api.clipIsEmpty({ ...defaults, "clip-path": "inset(100%)" }, local)).toBe(true);
    const shifted = { ...defaults, "clip-path": "inset(0px -200px 0px 200px)" };
    expect(api.clipStatus(shifted, local, [local])).toBe("transparent");
    // Absolutely positioned descendants can paint in this nonempty region.
    expect(api.clipIsEmpty(shifted, local)).toBe(false);
    expect(api.clipIsEmpty({ ...defaults, "clip-path": "url(#unknown)" }, local)).toBe(false);
  });
});

describe("isolated-world installation", () => {
  const key = Symbol.for("surf-wax.snapshot-observation-primitives.v2");
  afterEach(() => { delete (globalThis as any)[key]; });
  it("installs a serializable entry point without module closures or shipping functions as results", () => {
    const transported = Function(`return (${snapshotObservationPrimitives.toString()})`)();
    expect(transported(true)).toBe(2);
    expect((globalThis as any)[key].effectCoverage({ ...defaults, "mask-image": navigationMask }, box, [label])).toBe("complete");
  });
});
