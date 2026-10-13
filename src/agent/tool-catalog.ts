/** Read historical catalogue text without mutating saved messages or registering executable tools. */
export function materializeToolCatalog<T>(message: T): T {
  if (!message || typeof message !== "object" || Array.isArray(message)) return message;
  const record = message as Record<string, unknown>;
  if (record.role !== "user" || !Array.isArray(record.parts)) return message;
  const metadata = record.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return message;
  const custom = (metadata as Record<string, unknown>).custom;
  if (!custom || typeof custom !== "object" || Array.isArray(custom)) return message;
  const catalog = (custom as Record<string, unknown>).toolCatalog;
  if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) return message;
  const { version, context } = catalog as Record<string, unknown>;
  if (typeof version !== "string" || !version.trim() || typeof context !== "string" || !context.trim()) return message;
  if (record.parts.some((part) => part && typeof part === "object" && (part as Record<string, unknown>).type === "text"
    && (part as Record<string, unknown>).text === context)) return message;
  return { ...record, parts: [...record.parts, { type: "text", text: context }] } as T;
}
