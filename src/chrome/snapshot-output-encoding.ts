import { z } from "zod";
import { encodeSnapshotLines } from "./snapshot-line-dictionary";

// Only these framework-owned envelopes may be projected. In particular,
// `result`, arrays, and deeper objects can be arbitrary page-supplied JSON.
// Do not recursively search them for properties named pageSnapshot.
const integer = z.number().int().nonnegative();
const pageSchema = z.object({
  observationId: z.string(), tabId: integer, documentId: integer,
  url: z.string().optional(), title: z.string().optional(), continuation: z.literal(true).optional(),
  viewport: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number(), scale: z.number() }).strict(),
  mode: z.enum(["full", "delta"]), reset: z.literal("previous-output-truncated").optional(),
  items: z.array(z.object({ id: z.string(), line: z.string(), ref: z.string().optional(),
    change: z.enum(["added", "updated", "removed", "moved"]).optional(), after: z.string().nullable().optional(),
    fragment: z.object({ index: integer, start: integer, end: integer, total: integer }).strict().optional(),
  }).strict()),
  lookahead: z.object({ nonAuthoritative: z.literal(true), items: z.array(z.object({ index: integer, id: z.string(), line: z.string() }).strict()) }).strict().optional(),
  nextCursor: z.string().optional(),
  truncation: z.object({ truncated: z.boolean(), total: integer, returned: integer, offset: integer, charOffset: integer,
    nextOffset: integer, nextCharOffset: integer, budget: integer, used: integer, withLookahead: integer.optional(),
    reason: z.enum(["budget", "slice"]).optional(), baselineComplete: z.boolean(), requiredBudget: integer.optional() }).strict(),
  evidenceId: z.string().optional(),
}).strict().refine((page) => page.continuation === true
  ? page.url === undefined && page.title === undefined : typeof page.url === "string" && typeof page.title === "string")
  .refine((page) => page.truncation.returned === page.items.length);

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

/** Encode only the native inspect_page result or an explicitly verified direct
 * pageSnapshot owned by the tool envelope. Never mutate the input. Dictionary
 * and row indices are page-local; decode before applying deltas/fragments.
 * Existing truncation and byte counters describe the pre-encoding page; they
 * must remain unchanged so the canonical observation is losslessly recoverable.
 * Call only after the raw page's wire-size and delivery-lease validation. */
export function encodeSnapshotToolOutput(toolName: string, output: unknown, options: { ownedPageSnapshot?: boolean } = {}): unknown {
  if (!record(output)) return output;
  const project = (value: unknown): unknown => {
    if (!record(value) || !pageSchema.safeParse(value).success) return value;
    const items = value.items as Array<{ id: string; line: string }>;
    const encoded = encodeSnapshotLines(items);
    return encoded.lineDictionary ? { ...value, items: encoded.items, lineDictionary: encoded.lineDictionary } : value;
  };
  if (toolName === "inspect_page") return project(output);
  // Callers may set this flag only when the framework actually injected and
  // validated the pageSnapshot. E.g. read_artifact returns user data and can
  // legitimately contain an arbitrary property of the same name and shape.
  if (!options.ownedPageSnapshot || !Object.hasOwn(output, "pageSnapshot")) return output;
  const pageSnapshot = project(output.pageSnapshot);
  return pageSnapshot === output.pageSnapshot ? output : { ...output, pageSnapshot };
}
