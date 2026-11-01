import { z } from "zod";

const scope = z.union([
  z.object({ by: z.literal("css"), value: z.string().min(1) }).strict(),
  z.object({ by: z.literal("role"), value: z.string().min(1), name: z.string().optional(), exact: z.boolean().optional() }).strict(),
]).describe("Exactly one ancestor matched within the selected frame; the target is searched inside it. Scoped actions resolve once and fail immediately if the target is missing or not actionable. Use verify_state to wait or find_elements to obtain a ref before acting. Each verify_state poll resolves the scope again and does not preserve its identity between polls.");
const selectorFields = {
  name: z.string().optional(), exact: z.boolean().optional(), index: z.number().int().optional(), scope: scope.optional(),
  frame: z.union([z.object({ by: z.literal("css"), value: z.string().min(1) }).strict(), z.object({ ref: z.string().min(1) }).strict()]).optional(),
};

export const elementTargetSchema = z.union([
  z.object({ ref: z.string().min(1) }).strict(),
  z.object({ by: z.literal("css"), value: z.string().min(1), ...selectorFields }).strict(),
  z.object({ by: z.enum(["role", "text", "label", "placeholder", "alt", "title", "testId"]), value: z.string(), ...selectorFields }).strict(),
]);
