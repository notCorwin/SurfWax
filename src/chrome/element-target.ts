import { z } from "zod";

const matching = z.boolean().optional();
const roleName = z.string().optional();
const scope = z.union([
  z.object({ by: z.literal("css"), value: z.string().min(1) }).strict(),
  z.object({ by: z.literal("role"), value: z.string().min(1), name: roleName, exact: matching }).strict(),
]).describe("Search inside exactly one ancestor. Scoped actions resolve once; verify_state resolves the scope again on each poll.");
const selectorFields = {
  index: z.number().int().optional().describe("Select one match by zero-based index; negative indexes count from the end, so -1 is the last match."),
  scope: scope.optional(),
  frame: z.union([z.object({ by: z.literal("css"), value: z.string().min(1) }).strict(), z.object({ ref: z.string().min(1) }).strict()]).optional()
    .describe("Frame CSS selector or list_frames ref; omit for the main frame."),
};

export const elementTargetSchema = z.union([
  z.object({ ref: z.string().min(1).describe("Element ref returned by inspect_page or find_elements.") }).strict(),
  z.object({ by: z.enum(["css", "role", "text", "label", "placeholder", "alt", "title", "testId"]), value: z.string(), name: roleName, exact: matching, ...selectorFields }).strict()
    .refine(({ by, value, name, exact }) => (by !== "css" || value.length > 0)
      && (by === "role" || name === undefined) && (by !== "css" && by !== "testId" || exact === undefined),
    "name is only valid for role; exact is invalid for css and testId; css value cannot be empty")
    // Zod refinements are runtime-only; expose the same constraints to models.
    .meta({ allOf: [{ anyOf: [
      { properties: { by: { const: "role" } } },
      { properties: { by: { enum: ["text", "label", "placeholder", "alt", "title"] } }, not: { required: ["name"] } },
      { properties: { by: { const: "css" }, value: { minLength: 1 } }, not: { anyOf: [{ required: ["name"] }, { required: ["exact"] }] } },
      { properties: { by: { const: "testId" } }, not: { anyOf: [{ required: ["name"] }, { required: ["exact"] }] } },
    ] }] }),
]).describe("Identify an element by ref or locator; actions require one match unless index selects one. For role, value is the accessible role and name filters its accessible name, e.g. {by:'role',value:'button',name:'Save'}. For role name and text locators, exact=true matches normalized text case-sensitively; default false matches case-insensitive substrings. testId always matches exactly.");
