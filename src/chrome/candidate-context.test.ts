import { expect, it } from "vitest";
import { semanticContexts } from "./candidate-context";
import type { SnapshotLine } from "./snapshot-frame-tree";
import { packSnapshot, projectSnapshotLine } from "./snapshot-repeat";

const row = (id: string, depth: number, role: string, fields = {}): SnapshotLine => ({ id, line: "", node: { id, depth, role, layoutScope: "frame", ...fields } });
function context(rows: SnapshotLine[], partial = false) {
  const packed = packSnapshot(rows);
  const wire = packed.map((entry, index) => ({ ...projectSnapshotLine(entry), id: `wire-${index}` }));
  return semanticContexts("observation", rows, packed, wire, partial)("button");
}

it("addresses packed ancestry and visible fragments without promoting AX names", () => {
  const rows = [row("root", 0, "RootWebArea"), row("list", 1, "list"), row("item", 2, "listitem", { name: "ARIA-only secret" }),
    row("label", 3, "StaticText", { name: "JOB Next", textWhitespaceProven: true, bounds: [0, 0, 10, 10] }),
    row("button", 3, "button", { name: "Process", ref: "ref" })];
  const result = context(rows);
  expect(result).toMatchObject({ status: "verified", observationId: "observation", container: { itemId: "wire-1", pathIndex: 1, role: "listitem" }, visibleLabels: [{ text: "JOB Next", source: "StaticText", fragment: false }], partial: false });
  expect(JSON.stringify(result)).not.toContain("ARIA-only secret");
  expect(JSON.stringify(result)).not.toContain('"itemId":"item"');
});

it("bounds label copies and propagates unknown paint and document boundaries", () => {
  const rows = [row("root", 0, "RootWebArea"), row("item", 1, "listitem"),
    ...Array.from({ length: 20 }, (_, i) => row(`label-${i}`, 2, "StaticText", { name: `JOB ${i} ${"x".repeat(120)}`, textWhitespaceProven: true, bounds: [0, i * 20, 10, 10] })),
    row("unknown", 2, "StaticText", { nameUnknown: true }), row("button", 2, "button", { ref: "ref" })];
  expect(context(rows, true)).toMatchObject({ status: "verified", partial: true, labelsOmitted: true });
  expect((context(rows).visibleLabels as any[]).length).toBeLessThanOrEqual(12);
  expect(context([row("outer", 0, "listitem"), row("root", 1, "RootWebArea"), row("button", 2, "button", { ref: "ref" })])).toMatchObject({ status: "unknown", reason: "missing-semantic-container" });
  expect(context([row("item", 0, "listitem", { name: "unproven" }), row("button", 1, "button", { ref: "ref" })])).toMatchObject({ status: "unknown", reason: "unknown-visible-labels" });
});

it("keeps whole context pairs under the core budget with original artifact access", async () => {
  const { compactToolResult } = await import("./tool");
  const { EventLogger } = await import("../logging");
  const { createMemoryEventStore } = await import("../memory-event-store");
  const logger = new EventLogger({ store: createMemoryEventStore() });
  const original = { total: 50, elements: Array.from({ length: 50 }, (_, index) => ({ id: `candidate-${index}`, actionable: true, context: {
    status: "verified", observationId: "observation", snapshotItemId: `wire-${index}`, container: { itemId: "container", pathIndex: 1, role: "row" },
    visibleLabels: [{ itemId: "label", text: "LABEL".repeat(100), fragment: false, source: "StaticText" }], partial: false, unknownLabels: [],
  } })) };
  const output: any = await compactToolResult(original, { logger, conversationId: "c", toolCallId: "tool", preserveSearchStatus: true });
  expect(output.elementsTruncated).toBe(true);
  expect(output.elements.length).toBeGreaterThan(0);
  expect(output.elements[0]).toEqual(original.elements[0]);
  expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThanOrEqual(8192);
  expect(await logger.result(output.$ref, { path: ["elements", 49] }, "c")).toEqual(original.elements[49]);
});

it("withdraws candidate association and snapshot together if the delivery lease rejects", async () => {
  const { createProgramTools } = await import("./tool");
  const { SNAPSHOT_DELIVERY_COMMIT } = await import("./snapshot-wire");
  const { SNAPSHOT_CANDIDATE_CONTEXT } = await import("./candidate-context");
  const snapshot = { observationId: "observation", tabId: 1, documentId: 0, url: "https://example.test", title: "test",
    viewport: { x: 0, y: 0, width: 800, height: 600, scale: 1 }, mode: "full", items: [],
    truncation: { truncated: false, total: 0, returned: 0, offset: 0, charOffset: 0, nextOffset: 0, nextCharOffset: 0, budget: 16000, used: 0, baselineComplete: true } };
  let canceled = false;
  Object.defineProperty(snapshot, SNAPSHOT_DELIVERY_COMMIT, { value: { begin: () => false, finish: () => { throw new Error("must not finish"); }, cancel: () => { canceled = true; } } });
  Object.defineProperty(snapshot, SNAPSHOT_CANDIDATE_CONTEXT, { value: new Map([["candidate", { context: { status: "verified", observationId: "observation", visibleLabels: [{ text: "Current" }] } }]]) });
  // Only the browser boundary is substituted; the production delivery and
  // composition path must withdraw both sides of the association.
  const executor = { findElements: async () => ({ elements: [{ id: "candidate", actionable: true }] }), inspect: async () => snapshot };
  const tool = createProgramTools(executor as any).find_elements;
  const output: any = await tool.execute!({ target: { by: "css", value: "button" } }, { toolCallId: "find", messages: [], context: {} });
  expect(canceled).toBe(true);
  expect(output.pageSnapshot).toBeUndefined();
  expect(output.elements[0]).toEqual({ status: "identity-unknown", context: { status: "unknown", reason: "snapshot-unavailable" } });
});
