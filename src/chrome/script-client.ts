import { z } from "zod";
import { getRunIdentity } from "../agent/coordinator";

const scriptId = z.string().min(1).refine((id) => !id.startsWith("_"), "Script IDs cannot start with _");
const scriptSource = z.union([z.object({ code: z.string().min(1) }).strict(), z.object({ file: z.string().min(1) }).strict()]);
const scriptFields = {
  matches: z.array(z.string().min(1)).min(1),
  js: z.array(scriptSource).min(1),
  allFrames: z.boolean(),
  excludeGlobs: z.array(z.string()),
  excludeMatches: z.array(z.string()),
  includeGlobs: z.array(z.string()),
  runAt: z.enum(["document_start", "document_end", "document_idle"]),
  world: z.enum(["USER_SCRIPT", "MAIN"]),
  worldId: z.string().min(1),
};
const scriptDefinition = z.object({ id: scriptId, matches: scriptFields.matches, js: scriptFields.js,
  allFrames: scriptFields.allFrames.optional(), excludeGlobs: scriptFields.excludeGlobs.optional(), excludeMatches: scriptFields.excludeMatches.optional(),
  includeGlobs: scriptFields.includeGlobs.optional(), runAt: scriptFields.runAt.optional(), world: scriptFields.world.optional(), worldId: scriptFields.worldId.optional(),
}).strict();
const scriptChanges = z.object({
  matches: scriptFields.matches.optional(), js: scriptFields.js.optional(),
  allFrames: scriptFields.allFrames.nullable().optional(), excludeGlobs: scriptFields.excludeGlobs.nullable().optional(),
  excludeMatches: scriptFields.excludeMatches.nullable().optional(), includeGlobs: scriptFields.includeGlobs.nullable().optional(),
  runAt: scriptFields.runAt.nullable().optional(), world: scriptFields.world.nullable().optional(), worldId: scriptFields.worldId.nullable().optional(),
}).strict().refine((changes) => Object.keys(changes).length > 0, "At least one field is required");
const scriptSchemas: Record<string, z.ZodTypeAny> = {
  list: z.object({}).strict(),
  read: z.object({ id: scriptId }).strict(),
  create: z.object({ script: scriptDefinition }).strict(),
  edit: z.object({ id: scriptId, changes: scriptChanges }).strict(),
  setEnabled: z.object({ id: scriptId, enabled: z.boolean() }).strict(),
};

export async function callUserScript(method: string, args: unknown[], signal?: AbortSignal, onDispatch?: () => Promise<void>): Promise<unknown> {
  const schema = scriptSchemas[method];
  if (!schema) throw new Error("Unsupported user script method");
  schema.parse(method === "list" ? {} : method === "read" ? { id: args[0] } : method === "create" ? { script: args[0] } : args[0]);
  if (signal?.aborted) throw new DOMException("Operation aborted", "AbortError");
  if (onDispatch) await onDispatch();
  if (signal?.aborted) throw new DOMException("Operation aborted", "AbortError");
  const pending = chrome.runtime.sendMessage({ type: "surf-wax:user-scripts", method, args, ...getRunIdentity(), operationId: crypto.randomUUID() });
  let onAbort: (() => void) | undefined;
  const interrupted = signal && new Promise<never>((_, reject) => {
    onAbort = () => reject(Object.assign(new DOMException("Operation aborted", "AbortError"), { effectUnknown: !["list", "read"].includes(method) }));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const response = await (interrupted ? Promise.race([pending, interrupted]) : pending);
    if (!response?.ok) throw new Error(response?.error ?? "用户脚本操作失败");
    return response.result;
  } finally {
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }
}
