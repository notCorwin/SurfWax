import { z } from "zod";

export const elementTargetSchema = z.union([
  z.object({ ref: z.string().min(1) }).strict(),
  z.object({ by: z.enum(["role", "text", "label", "placeholder", "alt", "title", "testId", "css"]), value: z.string().min(1), name: z.string().optional(), exact: z.boolean().optional(), index: z.number().int().optional(), frame: z.union([z.object({ by: z.literal("css"), value: z.string().min(1) }).strict(), z.object({ ref: z.string().min(1) }).strict()]).optional() }).strict(),
]);
