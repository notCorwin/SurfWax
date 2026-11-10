// @vitest-environment node
import { expect, it } from "vitest";
import { ElementIds, type ElementIdBinding } from "./element-ids";

it("reuses live identities across concurrent requests without reusing IDs after retirement or across runtimes", async () => {
  const session = {}, entry: ElementIdBinding = { session, generation: 0, owner: "run", sourceId: "private-document-key", actionable: true };
  const retired: string[] = [], registry = new ElementIds(id => retired.push(id));
  const [first, same] = await Promise.all([registry.assign([entry, entry]), registry.assign([entry])]);
  expect(first[0]).toMatch(/^[0-9a-z]+$/);
  expect(first[1]).toBe(first[0]); expect(same[0]).toBe(first[0]);
  const otherTab = await registry.assign([{ ...entry, session: {} }]);
  const otherRun = await registry.assign([{ ...entry, owner: "next-run" }]);
  const otherDocument = await registry.assign([{ ...entry, generation: 1 }]);
  registry.clear(session);
  const replacement = await registry.assign([entry]);
  const restarted = await new ElementIds(() => {}).assign([entry]);
  const ids = [first[0], otherTab[0], otherRun[0], otherDocument[0], replacement[0], restarted[0]];
  expect(new Set(ids).size).toBe(ids.length);
  expect(retired).toContain(first[0]); expect(registry.get(first[0]!)).toBeUndefined();
});

it("does not publish bindings after their document is invalidated while allocation is queued", async () => {
  const registry = new ElementIds(() => {}), session = {};
  const pending = registry.assign([{ session, generation: 0, owner: "run", sourceId: "node", actionable: true }]);
  await Promise.resolve();
  registry.clear(session);
  await expect(pending).rejects.toMatchObject({ code: "stale-observation" });
});

it("does not evict another tab or bindings in a pending allocation", async () => {
  const registry = new ElementIds(() => {}), session = {}, otherSession = {};
  const entries = Array.from({ length: 32_769 }, (_, index) => ({ session, generation: 0, owner: "run", sourceId: `node-${index}`, actionable: true }));
  const original = await registry.assign(entries);
  const [other] = await registry.assign([{ ...entries[0]!, session: otherSession }]);
  const pending = registry.assign([entries[0]!, { ...entries[0]!, sourceId: "new-node" }]);
  await Promise.resolve();
  registry.prune(session);
  expect((await pending)[0]).toBe(original[0]);
  registry.prune(session);
  expect(registry.get(other!)).toHaveProperty("session", otherSession);
  expect(registry.get(original[0]!)).toBeDefined();
  expect(registry.get(original[1]!)).toBeUndefined();
});
