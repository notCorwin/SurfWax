import { expect, it } from "vitest";
import { automaticContexts, semanticContexts } from "./candidate-context";
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
    viewport: { x: 0, y: 0, width: 800, height: 600, scale: 1 }, mode: "full", items: [{ id: "automatic-target", actionable: true }],
    actionContexts: { targets: [{ targetId: "automatic-target", context: { status: "unknown", observationId: "observation", reason: "unproved" } }] },
    truncation: { truncated: false, total: 1, returned: 1, offset: 0, charOffset: 0, nextOffset: 1, nextCharOffset: 0, budget: 16000, used: 0, baselineComplete: true } };
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
  const inspection: any = await createProgramTools(executor as any).inspect_page.execute!({}, { toolCallId: "inspect", messages: [], context: {} });
  expect(inspection.items).toBeUndefined();
  expect(inspection.actionContexts).toBeUndefined();
});


it("indexes 500 candidates once, shares container work, and bounds delivered associations", () => {
  let reads = 0;
  const input = [row("root", 0, "RootWebArea"), row("group", 1, "group"), row("label", 2, "StaticText", { name: "Visible shared label", textWhitespaceProven: true }),
    ...Array.from({ length: 500 }, (_, i) => row(`button-${i}`, 2, "button", { ref: `ref-${i}` }))];
  const rows = input.map(entry => ({ ...entry, get node() { reads++; return entry.node; } }));
  const packed = packSnapshot(rows);
  const wire = packed.map((entry, i) => ({ ...projectSnapshotLine(entry), id: `wire-${i}`, ...(entry.node?.ref ? { actionable: true as const } : {}) }));
  reads = 0;
  const lookup = semanticContexts("observation", rows, packed, wire, true);
  const indexedReads = reads;
  for (let i = 0; i < 500; i++) expect(lookup(`button-${i}`)).toMatchObject({ status: "verified", partial: true, visibleLabels: [{ text: "Visible shared label" }] });
  expect(reads - indexedReads).toBeLessThan(10);
  expect(indexedReads).toBeLessThan(rows.length * 10);
  const byWire = new Map(wire.map((item, i) => [item.id, packed[i]!.id]));
  const output = automaticContexts(wire, id => lookup(byWire.get(id)!))!;
  expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThanOrEqual(3072);
  expect(output.omitted).toBeGreaterThan(0);
  expect(automaticContexts(wire, id => lookup(byWire.get(id)!), 0)).toBeUndefined();
  const minimal = automaticContexts(wire, id => lookup(byWire.get(id)!), 80)!;
  expect(minimal).toEqual({ targets: [], omitted: 500 });
  expect(Buffer.byteLength(JSON.stringify(minimal))).toBeLessThanOrEqual(80);
  for (const pair of output.targets) expect(wire.some(item => item.id === pair.targetId && item.actionable)).toBe(true);
  expect(automaticContexts([], lookup)).toBeUndefined();
  expect(automaticContexts([{ id: "removed", change: "removed" }], lookup)).toBeUndefined();
  console.log(JSON.stringify({ candidates: 500, indexedNodeReads: indexedReads, queryNodeReads: reads - indexedReads,
    associationBytes: Buffer.byteLength(JSON.stringify(output)), delivered: output.targets.length, omitted: output.omitted }));
});

it("does not associate across frame ancestry or invent hidden text", () => {
  const result = context([row("item", 0, "listitem"), row("hidden", 1, "StaticText", { name: "unproved secret" }),
    row("button", 1, "button", { ref: "ref", layoutScope: "other-frame" })]);
  expect(result).toMatchObject({ status: "unknown", reason: "missing-semantic-container" });
  expect(JSON.stringify(result)).not.toContain("unproved secret");
});


it("keeps packed partial associations inside wire budgets and paginates only actual targets", async () => {
  const { selectSnapshotWirePage } = await import("./snapshot-wire");
  const { diffSnapshot } = await import("./snapshot-pagination");
  const rows = [row("root", 0, "RootWebArea"), row("list", 1, "list"), row("item", 2, "listitem"),
    row("label", 3, "StaticText", { name: "Visible label", textWhitespaceProven: true }),
    ...Array.from({ length: 30 }, (_, i) => row(`button-${i}`, 3, "button", { ref: `ref-${i}`, name: "Process" }))];
  const packed = packSnapshot(rows);
  const wire = packed.map((entry, i) => ({ ...projectSnapshotLine(entry), id: `wire-${i}`, ...(entry.node?.ref ? { actionable: true as const } : {}) }));
  const original = JSON.stringify(wire);
  const lookup = semanticContexts("observation", rows, packed, wire, true);
  const byWire = new Map(wire.map((item, i) => [item.id, packed[i]!.id]));
  const contextFor = (id: string) => lookup(byWire.get(id)!);
  let position = { index: 0, charOffset: 0 }, pages = 0, delivered = 0;
  const envelope = (candidate: any) => ({ items: candidate.page.fragments, partial: true, actionContexts: automaticContexts(candidate.page.fragments, contextFor) });
  for (;;) {
    const page = selectSnapshotWirePage(wire, { budget: 12000, maxBytes: 1600, evidenceId: "tool:test", mode: "full", position }, envelope);
    const output = envelope(page);
    expect(Buffer.byteLength(JSON.stringify({ ...output, evidenceId: "tool:test" }))).toBeLessThanOrEqual(1600);
    for (const pair of output.actionContexts?.targets ?? []) {
      expect(page.page.fragments.some(item => item.id === pair.targetId && item.actionable)).toBe(true);
      expect(pair.context).toMatchObject({ partial: true, visibleLabels: [{ text: "Visible label" }] });
      delivered++;
    }
    pages++;
    if (!page.page.next) break;
    position = page.page.next;
    expect(pages).toBeLessThan(100);
  }
  expect(pages).toBeGreaterThan(1);
  expect(delivered).toBeGreaterThan(0);
  expect(JSON.stringify(wire)).toBe(original);
  expect(automaticContexts(diffSnapshot(wire, wire), contextFor)).toBeUndefined();
  const delta = diffSnapshot(wire, wire.map(item => item.actionable ? { ...item, name: "Changed" } : item));
  expect(delta.every(item => item.change === "updated")).toBe(true);
  expect(automaticContexts(delta, contextFor)!.targets[0]!.context).toMatchObject({ observationId: "observation", visibleLabels: [{ text: "Visible label" }] });
});

it("preserves uncertain effects when reporting a restricted browser page", async () => {
  const { createProgramTools } = await import("./tool");
  const failure = Object.assign(new Error("Cannot access a chrome:// URL"), { effectUnknown: true, artifact: { id: "evidence" } });
  const executor = { inspect: async () => { throw failure; } };
  const result: any = await createProgramTools(executor as any).inspect_page.execute!({}, { toolCallId: "restricted", messages: [], context: {} });
  expect(result.error).toMatchObject({ code: "restricted-page", effectUnknown: true, retryable: false });
  expect(result.error.recovery).toContain("Effect unknown");
  expect(result.artifact).toEqual({ id: "evidence" });
});
