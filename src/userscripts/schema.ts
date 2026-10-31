import { z } from "zod";

export const scriptId = z.string().min(1).refine((id) => !id.startsWith("_"), "Script IDs cannot start with _");
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
export const scriptDefinition = z.object({ id: scriptId, matches: scriptFields.matches, js: scriptFields.js,
  allFrames: scriptFields.allFrames.optional(), excludeGlobs: scriptFields.excludeGlobs.optional(), excludeMatches: scriptFields.excludeMatches.optional(),
  includeGlobs: scriptFields.includeGlobs.optional(), runAt: scriptFields.runAt.optional(), world: scriptFields.world.optional(), worldId: scriptFields.worldId.optional(),
}).strict();
export const scriptChanges = z.object({
  matches: scriptFields.matches.optional(), js: scriptFields.js.optional(),
  allFrames: scriptFields.allFrames.nullable().optional(), excludeGlobs: scriptFields.excludeGlobs.nullable().optional(),
  excludeMatches: scriptFields.excludeMatches.nullable().optional(), includeGlobs: scriptFields.includeGlobs.nullable().optional(),
  runAt: scriptFields.runAt.nullable().optional(), world: scriptFields.world.nullable().optional(), worldId: scriptFields.worldId.nullable().optional(),
}).strict().refine((changes) => Object.keys(changes).length > 0, "At least one field is required");
