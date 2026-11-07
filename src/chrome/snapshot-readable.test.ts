import { expect, it } from "vitest";
import { readableSnapshot, type ReadableSnapshot } from "./snapshot-readable";
import { expandSnapshot } from "./snapshot-repeat";

const sample = (): ReadableSnapshot => ({ url: "https://example.test/", title: "Sample", viewport: { x: 0, y: 0, width: 100, height: 80, scale: 1 }, gaps: [],
  rows: [{ key: 1, role: "RootWebArea", depth: 0, bounds: [0, 0, 100, 80] },
    { key: 2, parentKey: 1, role: "button", text: "Same", depth: 1, bounds: [2, 3, 20, 10], state: { expanded: false } },
    { key: 3, parentKey: 1, role: "button", text: "Same", depth: 1, bounds: [2, 30, 20, 10], state: { disabled: true } }] });

it("retains independently observed controls, geometry and false states without inventing action refs", () => {
  const lines = expandSnapshot(readableSnapshot(sample()));
  expect(lines.map(({ node }) => [node?.role, node?.name, node?.bounds, node?.state])).toEqual([
    ["RootWebArea", undefined, [0, 0, 100, 80], undefined],
    ["button", "Same", [2, 3, 20, 10], { expanded: false }],
    ["button", "Same", [2, 30, 20, 10], { disabled: true }],
  ]);
  expect(lines.every(({ ref, node }) => !ref && !node?.ref && !node?.actions)).toBe(true);
});

it("keeps unknown names and values, while rejecting corrupt identity, ancestry and geometry", () => {
  const value = sample();
  value.rows[1] = { key: 2, parentKey: 1, role: "textbox", depth: 1, bounds: [2, 3, 20, 10], nameUnknown: true, valueUnknown: true };
  const text = readableSnapshot(value).map(({ line }) => line).join("\n");
  expect(text).toContain("textbox [name=unknown]"); expect(text).toContain("[value=unknown]");
  for (const patch of [{ key: 1 }, { parentKey: 2 }, { depth: 8 }, { bounds: [2, 3, 0, 10] }, { bounds: [2, 3, NaN, 10] }])
    expect(() => readableSnapshot({ ...value, rows: [value.rows[0]!, { ...value.rows[1]!, ...patch } as any] })).toThrow("Invalid semantic node");
});

it("retains unknown text regions beside known prefixes without turning landmark text into a name", () => {
  const value: ReadableSnapshot = { ...sample(), gaps: [{ reason: "text-paint", bounds: [2, 20, 30, 10], count: 2 }], rows: [
    { key: 1, role: "RootWebArea", depth: 0, bounds: [0, 0, 100, 80] },
    { key: 2, parentKey: 1, role: "main", depth: 1, bounds: [0, 0, 100, 80] },
    { key: 3, parentKey: 2, role: "text", depth: 2, nameUnknown: true, bounds: [2, 3, 20, 10] },
    { key: 4, parentKey: 2, role: "button", depth: 2, text: "Known ", nameUnknown: true, bounds: [2, 20, 70, 20], textFragments: [{ text: "Known ", bounds: [2, 20, 30, 10] }] },
    { key: 5, parentKey: 2, role: "paragraph", depth: 2, nameUnknown: true, bounds: [2, 50, 70, 10] },
  ] };
  const lines = expandSnapshot(readableSnapshot(value));
  expect(lines.find(({ node }) => node?.role === "main")?.node?.name).toBeUndefined();
  expect(lines.find(({ node }) => node?.role === "text")?.node).toMatchObject({ nameUnknown: true, bounds: [2, 3, 20, 10] });
  expect(lines.find(({ node }) => node?.role === "button")?.node).toMatchObject({ name: "Known ", nameUnknown: true, textFragments: [{ text: "Known ", bounds: [2, 20, 30, 10] }] });
  expect(lines.find(({ node }) => node?.role === "paragraph")?.line).toContain("[name=unknown]");
});

it("keeps native values and placeholders separate from author labels and rejects unproven field payloads", () => {
  const value: ReadableSnapshot = { ...sample(), rows: [
    { key: 1, role: "RootWebArea", depth: 0, bounds: [0, 0, 100, 80] },
    { key: 2, parentKey: 1, role: "textbox", depth: 1, text: "Author label", value: "CURRENT_VALUE", bounds: [2, 3, 70, 12] },
    { key: 3, parentKey: 1, role: "searchbox", depth: 1, nameUnknown: true, placeholder: { status: "visible", text: "Visible hint" }, bounds: [2, 20, 70, 12] },
    { key: 4, parentKey: 1, role: "combobox", depth: 1, selectedLabels: ["Visible option"], bounds: [2, 40, 70, 12] },
    { key: 5, parentKey: 1, role: "textbox", depth: 1, placeholder: { status: "unknown" }, valueUnknown: true, bounds: [2, 60, 70, 12] },
  ] };
  const lines = expandSnapshot(readableSnapshot(value));
  expect(lines.find(({ node }) => node?.value === "CURRENT_VALUE")?.node?.name).toBe("Author label");
  expect(lines.find(({ node }) => node?.role === "searchbox")?.node).toMatchObject({ nameUnknown: true, placeholder: { status: "visible", text: "Visible hint" } });
  expect(lines.find(({ node }) => node?.role === "searchbox")?.node?.name).toBeUndefined();
  expect(lines.find(({ node }) => node?.role === "combobox")?.node?.selectedLabels).toEqual(["Visible option"]);
  expect(lines.find(({ node }) => node?.placeholder?.status === "unknown")?.line).toContain("[value=unknown] [placeholder=unknown]");
  for (const patch of [{ value: 7 }, { value: "UNPROVEN", valueUnknown: true }, { selectedLabels: [7] }, { placeholder: { status: "unknown", text: "UNPROVEN" } }])
    expect(() => readableSnapshot({ ...value, rows: [value.rows[0]!, { ...value.rows[1]!, ...patch } as any] })).toThrow("Invalid semantic node");
});
