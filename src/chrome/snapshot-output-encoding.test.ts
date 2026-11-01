import { describe, expect, it } from "vitest";
import { decodeSnapshotLines } from "./snapshot-line-dictionary";
import { encodeSnapshotToolOutput } from "./snapshot-output-encoding";
import { actionHistory, localEvidence } from "../agent/goal-completion";

function page(overrides: Record<string, unknown> = {}) {
  const repeated = '  - StaticText [name=unknown] with repeated text';
  const items = Array.from({ length: 30 }, (_, index) => ({ id: `1.${index}`, line: repeated,
    ...(index % 6 ? {} : { ref: `opaque-${index}` }) }));
  return { observationId: "observation", tabId: 1, documentId: 3, url: "https://example.test/", title: "Page",
    viewport: { x: 0, y: 0, width: 800, height: 600, scale: 1 }, mode: "full", items,
    truncation: { truncated: false, total: items.length, returned: items.length, offset: 0, charOffset: 0,
      nextOffset: items.length, nextCharOffset: 0, budget: 12000, used: 5000, baselineComplete: true }, ...overrides };
}

function restore(snapshot: any) {
  const result = { ...snapshot, items: decodeSnapshotLines(snapshot) };
  delete result.lineDictionary;
  return result;
}

describe("canonical snapshot tool output encoding", () => {
  it("losslessly encodes the inspect root while retaining ref lines and counters", () => {
    const value = page({ evidenceId: "evidence" }), before = structuredClone(value);
    value.items.forEach(Object.freeze);
    Object.freeze(value.items);
    Object.freeze(value.truncation);
    Object.freeze(value);
    const encoded = encodeSnapshotToolOutput("inspect_page", value) as any;
    expect(encoded).not.toBe(value);
    expect(encoded.lineDictionary).toBeDefined();
    expect(encoded.items.filter((item: any) => item.ref).every((item: any) => typeof item.line === "string")).toBe(true);
    expect(restore(encoded)).toEqual(before);
    expect(value).toEqual(before);
    expect(encoded.truncation).toEqual(value.truncation);
    expect(encodeSnapshotToolOutput("inspect_page", encoded)).toBe(encoded);
  });

  it("encodes only a verified direct pageSnapshot and preserves nested user data", () => {
    const spoof = page();
    const output = { ok: true, result: { pageSnapshot: spoof, records: [spoof, { value: "unchanged" }] },
      pageSnapshot: page(), evidenceId: "tool-result", artifact: { id: 7, nested: [1, null, "x"] } };
    const before = structuredClone(output);
    const encoded = encodeSnapshotToolOutput("read_elements", output, { ownedPageSnapshot: true }) as any;
    expect(encoded.pageSnapshot.lineDictionary).toBeDefined();
    expect(encoded.result).toBe(output.result);
    expect(encoded.artifact).toBe(output.artifact);
    expect(encoded.result).toEqual(before.result);
    expect({ ...encoded, pageSnapshot: restore(encoded.pageSnapshot) }).toEqual(before);
    expect(output).toEqual(before);
  });

  it("preserves the goal-completion action receipt and its target label", () => {
    const input = { target: { ref: "opaque-0" } };
    const raw = { ok: true, performed: true, pageSnapshot: page() };
    const encoded = encodeSnapshotToolOutput("click", raw, { ownedPageSnapshot: true }) as any;
    expect(encoded.pageSnapshot.lineDictionary).toBeDefined();
    expect(encoded.pageSnapshot.items.find((item: any) => item.ref === input.target.ref)?.line)
      .toBe(raw.pageSnapshot.items[0]!.line);
    const rawEvidence = localEvidence("e1", "click", raw, 1, input);
    const encodedEvidence = localEvidence("e1", "click", encoded, 1, input);
    expect(encodedEvidence).toEqual(rawEvidence);
    expect(actionHistory([encodedEvidence])).toEqual(actionHistory([rawEvidence]));
  });

  it("never guesses ownership for page-supplied JSON, including top-level spoofs", () => {
    const result = { pageSnapshot: page(), other: [null, { pageSnapshot: page() }] };
    expect(encodeSnapshotToolOutput("read_artifact", result)).toBe(result);
    expect(encodeSnapshotToolOutput("read_elements", result)).toBe(result);
    expect(encodeSnapshotToolOutput("read_artifact", [result, page()])).toEqual([result, page()]);
    for (const value of [null, false, 3, "text"]) expect(encodeSnapshotToolOutput("inspect_page", value)).toBe(value);
    expect(encodeSnapshotToolOutput("read_elements", { result })).toEqual({ result });
  });

  it("preserves delta, cursor and UTF-16 fragment metadata exactly", () => {
    const line = "😀 repeated fragment text";
    const items = Array.from({ length: 25 }, (_, index) => ({ id: `f${index}`, line, change: "updated" as const,
      after: index ? `f${index - 1}` : null, fragment: { index, start: 4, end: 4 + line.length, total: 100 } }));
    const original = page({ mode: "delta", continuation: true, url: undefined, title: undefined, items, nextCursor: "frozen:25:0",
      truncation: { truncated: true, total: 200, returned: items.length, offset: 0, charOffset: 0,
        nextOffset: 25, nextCharOffset: 0, budget: 12000, used: 5000, reason: "budget", baselineComplete: false } });
    const encoded = encodeSnapshotToolOutput("inspect_page", original) as any;
    expect(encoded.lineDictionary).toBeDefined();
    expect(restore(encoded)).toEqual(original);
  });

  it("leaves ambiguous, malformed, dictionary-bearing or low-benefit pages unchanged", () => {
    const base = page();
    for (const value of [
      { ...base, lineDictionary: ["already"] },
      { ...base, items: [{ id: "a", line: 0 }] },
      { ...base, unknownField: true },
      { ...base, truncation: { ...base.truncation, returned: 4 } },
      page({ items: [], truncation: { ...base.truncation, total: 0, returned: 0, nextOffset: 0 } }),
    ]) expect(encodeSnapshotToolOutput("inspect_page", value)).toBe(value);
  });
});
