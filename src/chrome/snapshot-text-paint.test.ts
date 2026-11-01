import { afterEach, describe, expect, it } from "vitest";
import { projectTextPaint, sameTextPaintCandidates, TEXT_PAINT_CACHE_LOOKUP_SOURCE, TEXT_PAINT_CACHE_REGISTER_SOURCE, type TextPaintEvidence } from "./snapshot-text-paint";
import type { SnapshotTextPaintCandidate } from "./snapshot-visibility";

describe("painted text projection", () => {
  const candidate: SnapshotTextPaintCandidate = { backendNodeId: 7, frameId: "frame", sourceText: "ABCDEF", layoutText: "ABCDEF", fullyWithinClip: true };
  const evidence: TextPaintEvidence = { ranges: [], sourceText: "ABCDEF", firstLineRisk: false, firstLetterRisk: false, unknown: false };

  it("compares the semantic inputs that validate text paint decisions", () => {
    expect(sameTextPaintCandidates([candidate], [{ ...candidate }])).toBe(true);
    expect(sameTextPaintCandidates([candidate], [])).toBe(false);
    for (const change of [{ sourceText: "changed" }, { frameId: "other" }, { fullyWithinClip: false }, { firstLetter: "A" }, { zeroFont: true }, { basePainted: true }])
      expect(sameTextPaintCandidates([candidate], [{ ...candidate, ...change }])).toBe(false);
  });

  it("removes invisible text and preserves only selected or highlighted intervals", () => {
    expect(projectTextPaint(candidate, evidence)).toEqual({ hidden: true });
    expect(projectTextPaint(candidate, { ...evidence, ranges: [[1, 3], [2, 4], [5, 6]] })).toEqual({ hidden: false, text: "BCD … F" });
  });

  it("does not mistake ordinary opaque text for unpainted selection-only text", () => {
    expect(projectTextPaint({ ...candidate, basePainted: true }, evidence)).toEqual({ hidden: false, text: "ABCDEF" });
    expect(projectTextPaint({ ...candidate, basePainted: true, fullyWithinClip: false }, evidence)).toBeUndefined();
    expect(projectTextPaint({ ...candidate, basePainted: true }, { ...evidence, sourceText: "changed" })).toBeUndefined();
  });

  it("projects a large number of first-line ranges without exceeding the call stack", () => {
    const firstLineRanges: Array<[number, number]> = Array.from({ length: 160_000 }, () => [1, 2]);
    expect(projectTextPaint({ ...candidate, documentFloatRisk: false }, { ...evidence, firstLineRanges }))
      .toEqual({ hidden: false, text: "B" });
  });

  it("retains an identified first-letter prefix without exposing its invisible suffix", () => {
    expect(projectTextPaint({ ...candidate, layoutText: "BCDEF", firstLetter: "A" }, { ...evidence, firstLetterRisk: true }))
      .toEqual({ hidden: false, text: "A" });
    expect(projectTextPaint({ ...candidate, layoutText: "BCDEF", firstLetter: "A" }, { ...evidence, ranges: [[2, 4]], firstLetterRisk: true }))
      .toEqual({ hidden: false, text: "A … CD" });
  });

  it("does not infer visible glyphs from highlighting of zero-size text", () => {
    expect(projectTextPaint({ ...candidate, zeroFont: true }, { ...evidence, ranges: [[0, 3]] })).toEqual({ hidden: true });
  });

  it("does not guess when source mapping, pseudo paint or grapheme boundaries are uncertain", () => {
    expect(projectTextPaint({ ...candidate, layoutText: "ABC…" }, { ...evidence, ranges: [[0, 3]] })).toBeUndefined();
    expect(projectTextPaint(candidate, { ...evidence, firstLineRisk: true })).toBeUndefined();
    expect(projectTextPaint(candidate, { ...evidence, firstLetterRisk: true })).toBeUndefined();
    expect(projectTextPaint({ ...candidate, firstLetterUnknown: true }, evidence)).toBeUndefined();
    expect(projectTextPaint(candidate, { ...evidence, unknown: true })).toBeUndefined();
    expect(projectTextPaint({ ...candidate, sourceText: "a😀b", layoutText: "a😀b" }, { ...evidence, sourceText: "a😀b", ranges: [[1, 2]] })).toBeUndefined();
    expect(projectTextPaint({ ...candidate, sourceText: "e\u0301x", layoutText: "e\u0301x" }, { ...evidence, sourceText: "e\u0301x", ranges: [[0, 1]] })).toBeUndefined();
    expect(projectTextPaint({ ...candidate, fullyWithinClip: false }, { ...evidence, ranges: [[1, 3]] })).toBeUndefined();
    expect(projectTextPaint(candidate, { ...evidence, sourceText: "Changed" })).toBeUndefined();
  });

  it("uses Chrome's selected text for transformed and security-masked glyphs", () => {
    expect(projectTextPaint({ ...candidate, sourceText: "before maß after", layoutText: "BEFORE MASS AFTER", textTransform: "uppercase" },
      { ...evidence, sourceText: "before maß after", selection: { start: 7, end: 10, text: "MASS" } }))
      .toEqual({ hidden: false, text: "MASS" });
    expect(projectTextPaint({ ...candidate, sourceText: "x A😀B y", layoutText: "•••••••", textSecurity: "disc" },
      { ...evidence, sourceText: "x A😀B y", selection: { start: 2, end: 6, text: "•••" } }))
      .toEqual({ hidden: false, text: "•••" });
  });

  it("only projects custom highlights when transformed pieces reconstruct the full layout text", () => {
    expect(projectTextPaint({ ...candidate, sourceText: "before maß after", layoutText: "BEFORE MASS AFTER", textTransform: "uppercase" },
      { ...evidence, sourceText: "before maß after", ranges: [[7, 10]] })).toEqual({ hidden: false, text: "MASS" });
    expect(projectTextPaint({ ...candidate, sourceText: "before maß after", layoutText: "something else", textTransform: "uppercase" },
      { ...evidence, sourceText: "before maß after", ranges: [[7, 10]] })).toBeUndefined();
  });
});

describe("frame-local weak text cache", () => {
  const key = Symbol.for("surf-wax.text-paint-cache.v1");
  const register = Function(`return (${TEXT_PAINT_CACHE_REGISTER_SOURCE})`)();
  const lookup = Function(`return (${TEXT_PAINT_CACHE_LOOKUP_SOURCE})`)();
  afterEach(() => { delete (globalThis as any)[key]; });

  it("bounds retained keys, drops weak misses and rejects nodes from another document", () => {
    const document: any = { defaultView: {} };
    document.defaultView.document = document;
    const nodes = Array.from({ length: 8200 }, () => ({ nodeType: 3, isConnected: true, ownerDocument: document, parentElement: null }));
    const ids = nodes.map((_, index) => index + 1);
    register.call(document, "first", ids, ...nodes);
    const cache = (globalThis as any)[key];
    expect(cache.nodes.size).toBe(8192);
    expect(cache.nodes.has(1)).toBe(false);
    expect(cache.nodes.has(9)).toBe(true);
    cache.nodes.set(9, { deref: () => undefined });
    expect(lookup.call(document, "first", [9])).toEqual([null]);
    expect(cache.nodes.has(9)).toBe(false);
    expect(() => register.call(document, "first", [9000], { nodeType: 3, isConnected: true, ownerDocument: {}, parentElement: null })).toThrow("frame mismatch");
    expect(() => register.call(document, "first", [9001], { nodeType: 3, isConnected: false, ownerDocument: document, parentElement: null })).toThrow("detached");
  });

  it("does not reuse nodes moved to another document and resets when the frame token changes", () => {
    const document: any = { defaultView: {} }, other = {};
    document.defaultView.document = document;
    const node = { nodeType: 3, isConnected: true, ownerDocument: document, parentElement: null };
    register.call(document, "first", [1], node);
    expect(lookup.call(document, "first", [1])[0]).not.toBeNull();
    node.ownerDocument = other;
    expect(lookup.call(document, "first", [1])).toEqual([null]);
    node.ownerDocument = document;
    register.call(document, "first", [1], node);
    expect(lookup.call(document, "second", [1])).toEqual([null]);
  });

  it("rejects a detached or replaced frame even when cached nodes still report connected", () => {
    const document: any = { defaultView: {} };
    document.defaultView.document = document;
    const node = { nodeType: 3, isConnected: true, ownerDocument: document, parentElement: null };
    register.call(document, "first", [1], node);
    document.defaultView = null;
    expect(() => lookup.call(document, "first", [1])).toThrow("frame document no longer active");
    document.defaultView = { document: {} };
    expect(() => register.call(document, "first", [1], node)).toThrow("frame document no longer active");
  });
});
