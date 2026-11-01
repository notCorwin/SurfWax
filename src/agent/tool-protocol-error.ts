/** Only mark rejected model output here: decoding has completed before any
 * tool dispatch. Unsupported input and transport failures remain terminal. */
export function repairableToolProtocolError(error: unknown, responseText: string): Error {
  const failure = error instanceof Error ? error : new Error(String(error));
  return Object.assign(failure, { toolProtocolRepair: { responseText: responseText.slice(0, 4096) } });
}

export function toolProtocolRepair(error: unknown): { message: string; responseText: string } | undefined {
  const visited = new Set<unknown>();
  let current = error;
  while (current && typeof current === "object" && !visited.has(current)) {
    visited.add(current);
    const value = current as { message?: unknown; toolProtocolRepair?: { responseText?: unknown }; cause?: unknown };
    if (typeof value.toolProtocolRepair?.responseText === "string") return {
      message: typeof value.message === "string" ? value.message.slice(0, 1024) : "Invalid tool-call response.",
      responseText: value.toolProtocolRepair.responseText,
    };
    current = value.cause;
  }
  return undefined;
}
