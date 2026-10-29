import { fromLogValue, toLogValue, type LogEvent } from "./logging";

/** In-memory canonical log for tests, including atomic artifact transactions. */
export function testEventStore(events: LogEvent[] = []) {
  let nextId = (events.at(-1)?.id ?? 0) + 1;
  const save = (event: Omit<LogEvent, "id">) => {
    const saved = { ...event, id: nextId++ };
    events.push(saved);
    return saved;
  };
  const append = async (event: Omit<LogEvent, "id">) => save(event);
  const saveParts = (parts: readonly Omit<LogEvent, "id">[]) => {
    for (const part of parts) events.push({ ...part, id: nextId++ });
  };
  return {
    supportsArtifactParts: true,
    append,
    async appendMany(batch: readonly Omit<LogEvent, "id">[]) { return Promise.all(batch.map(append)); },
    async appendPartitioned(artifact: Omit<LogEvent, "id">, parts: readonly Omit<LogEvent, "id">[]) {
      saveParts(parts);
      return append(artifact);
    },
    async appendArtifactAnd(artifact: Omit<LogEvent, "id">, terminal: Omit<LogEvent, "id">, link: "resultArtifactId", parts: readonly Omit<LogEvent, "id">[] = []) {
      const content = fromLogValue(terminal.content, terminal.valueEncoding);
      if (!content || typeof content !== "object" || Array.isArray(content)) throw new Error("Job terminal content must be an object");
      saveParts(parts);
      const savedArtifact = save(artifact);
      const savedTerminal = save({ ...terminal, content: toLogValue({ ...content, [link]: savedArtifact.id }, undefined, 5) });
      return { artifact: savedArtifact, terminal: savedTerminal };
    },
    async artifactParts(key: string, node: number, section?: string, first?: number, last?: number) {
      return events.filter((event) => event.artifactPart?.key === key && event.artifactPart.node === node
        && (section === undefined || event.artifactPart.section === section)
        && (first === undefined || event.artifactPart.part >= first) && (last === undefined || event.artifactPart.part <= last));
    },
    async all() { return [...events]; },
    async clear() { events.length = 0; },
  };
}
