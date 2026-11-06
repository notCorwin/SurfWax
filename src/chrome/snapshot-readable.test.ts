import { expect, it } from "vitest";
import { readableSnapshot, type ReadableSnapshot } from "./snapshot-readable";

it("delivers root viewport bounds and rejects malformed geometry", () => {
  const sample: ReadableSnapshot = { url: "https://example.test/", title: "Sample", viewport: { x: 0, y: 0, width: 100, height: 80, scale: 1 },
    rows: [{ text: "Same", depth: 2, bounds: [2, 3, 20, 10] }, { text: "Same", depth: 2, bounds: [2, 30, 20, 10] }] };
  const lines = readableSnapshot(sample);
  expect(lines.map(({ line }) => line)).toEqual(['    - text "Same" [box=2,3,20,10]', '    - text "Same" [box=2,30,20,10]']);
  expect(lines.every(({ ref }) => !ref)).toBe(true);
  for (const bounds of [[2, 3, 0, 10], [90, 3, 20, 10], [2, -1, 20, 10], [2, 3, NaN, 10]])
    expect(() => readableSnapshot({ ...sample, rows: [{ ...sample.rows[0]!, bounds: bounds as [number, number, number, number] }] })).toThrow("Invalid read-only text");
});
