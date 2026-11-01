import { z } from "zod";

export const scriptId = z.string().min(1).regex(/^[^_]/, "Script IDs cannot start with _")
  .describe("Persistent script ID. Must not start with an underscore.");
const scriptSource = z.union([
  z.object({ code: z.string().min(1).describe("JavaScript source code to inject.") }).strict(),
  z.object({ file: z.string().min(1).describe("JavaScript file path relative to the extension root, not a local path or URL.") }).strict(),
]).describe("One JavaScript source: either inline code or an extension file.");
const scriptFields = {
  matches: z.array(z.string().min(1)).min(1).describe("Chrome match patterns for pages to inject into, for example https://example.com/* or <all_urls>."),
  js: z.array(scriptSource).min(1).describe("JavaScript sources to inject, in order."),
  allFrames: z.boolean().describe("Inject into every matching frame if true; defaults to false (top frame only)."),
  excludeGlobs: z.array(z.string()).describe("URL wildcard patterns that exclude pages."),
  excludeMatches: z.array(z.string()).describe("Chrome match patterns that exclude pages."),
  includeGlobs: z.array(z.string()).describe("URL wildcard patterns that further restrict pages."),
  runAt: z.enum(["document_start", "document_end", "document_idle"]).describe("Injection time; defaults to document_idle."),
  world: z.enum(["USER_SCRIPT", "MAIN"]).describe("Execution environment; defaults to USER_SCRIPT. MAIN shares the page's JavaScript environment."),
  worldId: z.string().min(1).regex(/^[^_]/).describe("User-script world ID; omit for the default world. Only valid when world is omitted or USER_SCRIPT; cannot start with an underscore."),
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
}).strict().refine((changes) => Object.keys(changes).length > 0, "At least one field is required")
  .describe("Provide at least one changed field. Values replace entire fields, including arrays. For nullable fields, null removes the setting and restores Chrome's default; omitted fields stay unchanged.");
