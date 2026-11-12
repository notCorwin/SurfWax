import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import { EventLogger } from "../logging";
import { createMemoryEventStore } from "../memory-event-store";
import { transformTextArtifact } from "./text-artifact-transform";
import { ATOMIC_TOOL_REGISTRY } from "./atomic-tools";

it("validates all text sources before writing, preserves exact strings, and confines terminal evidence", async () => {
  const store = createMemoryEventStore();
  const logger = new EventLogger({ store });
  logger.beginRun("c", "r");
  const identity = { conversationId: "c", runId: "r", toolCallId: "http" };
  await logger.append({ type: "tool.started", ...identity });
  const raw = await logger.append({ type: "tool.result.data", ...identity, output: { ok: true, result: { body: JSON.stringify({ "": [{ value: "雪" }, { value: "" }, { value: "雪" }] }) } } });
  await logger.append({ type: "tool.finished", ...identity, output: { $ref: raw!.id, preview: "WRONG" } });
  const writes: string[] = [];
  const file = (text: string, mimeType = "text/plain") => ({ filename: "in.txt", mimeType, base64: Buffer.from(text).toString("base64") });
  const values: any[] = [file(' {"": ["尾\\n", ""]}'), file("\uFEFF尾\n"), { filename: "bad", mimeType: "text/plain", base64: "/w==" }, JSON.parse('{"__proto__":{"constructor":["key", ""]}}')];
  const artifacts = {
    evidence: (id: string) => logger.evidenceResult(id, "c", "r"),
    read: async (id: number) => values[id - 1],
    text: async (_name: string, text: string) => { writes.push(text); return { id: 99 }; },
  };
  const base = { sources: [{ evidenceId: "http", path: ["result", "body"], decode: "json-string" }], selectPath: [""], itemPath: ["value"], separator: "|", filename: "out.txt" };
  const result = await transformTextArtifact("extract", base, artifacts);
  expect(writes).toEqual(["雪||雪"]);
  expect(result).toMatchObject({ totalItems: 3, byteLength: 8, sha256: createHash("sha256").update("雪||雪").digest("hex"), access: { artifactId: 99, path: [] } });
  await transformTextArtifact("extract", { ...base, sources: [{ artifactId: 1, path: [], decode: "utf8-json-file" }], itemPath: undefined }, artifacts);
  expect(writes.at(-1)).toBe("尾\n|");
  await transformTextArtifact("join", { artifactIds: [2, 2], separator: "", filename: "join.txt" }, artifacts);
  expect(writes.at(-1)).toBe("\uFEFF尾\n\uFEFF尾\n");
  await transformTextArtifact("extract", { ...base, sources: [{ artifactId: 4, path: ["__proto__"], decode: "stored-value" }], selectPath: ["constructor"], itemPath: undefined }, artifacts);
  expect(writes.at(-1)).toBe("key|");
  const prefixed = { artifactId: 5, prefix: "ENTRY[.*] ", separator: "|", filename: "lines.txt" };
  values.push(file("\uFEFFENTRY[.*] excluded\nENTRY[.*]  \uFEFF雪🌊 \r\nHEARTBEAT\nENTRY[.*] \nENTRY[.*]  \uFEFF雪🌊 \r\nentry[.*] wrong-case\nENTRYz any-regex\n"));
  const lines = await transformTextArtifact("prefixed-lines", prefixed, artifacts);
  const exact = " \uFEFF雪🌊 \r|| \uFEFF雪🌊 \r";
  expect(writes.at(-1)).toBe(exact);
  expect(lines).toMatchObject({ matched: 3, skipped: 5, inputLineCount: 8, totalItems: 3, byteLength: Buffer.byteLength(exact), sha256: createHash("sha256").update(exact).digest("hex"), access: { artifactId: 99, path: [] } });
  const noMatches = await transformTextArtifact("prefixed-lines", { ...prefixed, artifactId: 2 }, artifacts);
  expect(noMatches).toMatchObject({ matched: 0, skipped: 2, inputLineCount: 2, byteLength: 0, sha256: createHash("sha256").update("").digest("hex") });
  expect(writes.at(-1)).toBe("");
  values.push(file(""));
  expect(await transformTextArtifact("prefixed-lines", { ...prefixed, artifactId: 6 }, artifacts)).toMatchObject({ matched: 0, skipped: 1, inputLineCount: 1 });
  const schema = ATOMIC_TOOL_REGISTRY.find(tool => tool.name === "extract_prefixed_lines")!.inputSchema;
  expect(schema.safeParse(prefixed).success).toBe(true);
  for (const change of [{ prefix: "" }, { prefix: "x\n" }, { prefix: "x\ny" }, { filename: "" }, { text: "copy" }, { artifactId: undefined, evidenceId: "http" }])
    expect(schema.safeParse({ ...prefixed, ...change }).success).toBe(false);
  const before = writes.length;
  for (const change of [
    { selectPath: ["missing"] }, { itemPath: ["toString"] }, { itemPath: [] },
    { sources: [{ artifactId: 2, path: [], decode: "json-string" }] },
    { sources: [{ artifactId: 1, path: ["base64"], decode: "json-string" }] },
    { sources: [...base.sources, { evidenceId: "foreign", path: [], decode: "stored-value" }] },
  ]) await expect(transformTextArtifact("extract", { ...base, ...change }, artifacts)).rejects.toThrow(/source\[/);
  await expect(transformTextArtifact("join", { artifactIds: [2, 3], separator: "", filename: "bad" }, artifacts)).rejects.toThrow("source[1]");
  await expect(transformTextArtifact("prefixed-lines", { ...prefixed, artifactId: 3 }, artifacts)).rejects.toThrow("invalid base64 or UTF-8");
  for (const prefix of ["", "x\n"])
    await expect(transformTextArtifact("prefixed-lines", { ...prefixed, prefix }, artifacts)).rejects.toThrow("prefix");
  await expect(logger.evidenceResult("http", "foreign", "r")).rejects.toThrow();
  await expect(logger.evidenceResult("http", "c", "other")).rejects.toThrow();
  const failed = { ...identity, toolCallId: "failed" };
  await logger.append({ type: "tool.started", ...failed });
  await logger.append({ type: "tool.failed", ...failed, output: { ok: false } });
  await expect(logger.evidenceResult("failed", "c", "r")).rejects.toThrow();
  const spoof = { ...identity, toolCallId: "spoof" };
  await logger.append({ type: "tool.started", ...spoof });
  await logger.append({ type: "tool.finished", ...spoof, output: { $ref: raw!.id } });
  await expect(logger.evidenceResult("spoof", "c", "r")).rejects.toThrow();
  const pending = { ...identity, toolCallId: "pending" };
  await logger.append({ type: "tool.started", ...pending });
  await expect(logger.evidenceResult("pending", "c", "r")).rejects.toThrow();
  const incomplete = { ...identity, toolCallId: "incomplete" };
  await logger.append({ type: "tool.started", ...incomplete });
  await logger.append({ type: "tool.finished", ...incomplete, output: { ok: true, complete: false } });
  await expect(logger.evidenceResult("incomplete", "c", "r")).rejects.toThrow();
  // Corrupt stored history must remain ambiguous, even when all rows share scope.
  for (const duplicate of ["tool.started", "tool.finished"]) {
    const scoped = { ...identity, toolCallId: duplicate, timestamp: new Date().toISOString(), content: null };
    await store.append({ type: "tool.started", ...scoped });
    await store.append({ type: duplicate, ...scoped, output: { ok: true } });
    await store.append({ type: "tool.finished", ...scoped, output: { ok: true } });
    await expect(logger.evidenceResult(duplicate, "c", "r")).rejects.toThrow();
  }
  expect(writes).toHaveLength(before);
  await new EventLogger({ store }).clear();
  await expect(logger.evidenceResult("http", "c", "r")).rejects.toThrow();
  await logger.append({ type: "tool.started", ...identity });
  await logger.append({ type: "tool.finished", ...identity, output: { $ref: raw!.id } });
  await expect(logger.evidenceResult("http", "c", "r")).rejects.toThrow();
  logger.dispose();
});
