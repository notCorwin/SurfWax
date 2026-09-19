import { dynamicTool } from "ai";
import { z } from "zod";
import type { EventLogger } from "../logging";
import type { ChromeToolInput } from "../types";
import { ChromeExecutor } from "./executor";

export const chromeToolInputSchema = z.object({
  code: z.string().min(1),
  target: z.object({
    kind: z.enum(["auto", "extension", "service-worker", "page", "offscreen", "devtools", "native"]),
    tabId: z.number().int().nonnegative().optional(),
    frameId: z.number().int().nonnegative().optional(),
    documentId: z.string().min(1).optional(),
    world: z.enum(["MAIN", "ISOLATED", "USER_SCRIPT"]).optional(),
    targetId: z.string().min(1).optional(),
    sessionId: z.string().min(1).optional(),
  }).strict().optional(),
  timeoutMs: z.number().int().positive().max(300_000).optional(),
  tabId: z.number().int().nonnegative().optional(),
  world: z.enum(["MAIN", "USER_SCRIPT"]).optional(),
}).strict().refine((input) => input.tabId !== undefined || input.world === undefined, {
  message: "world requires tabId",
  path: ["world"],
}).refine((input) => !(input.target && input.tabId !== undefined), {
  message: "Use target or legacy tabId, not both",
  path: ["target"],
}).refine((input) => input.target?.kind === "page" || input.target?.kind === "auto" || !input.target?.world, {
  message: "world is only valid for page targets",
  path: ["target", "world"],
});

export function parseChromeToolInput(input: unknown): ChromeToolInput {
  return chromeToolInputSchema.parse(input);
}

const LARGE_RESULT_BYTES = 8 * 1024;

function previewOf(value: unknown): string {
  if (typeof value === "string") return value.slice(0, 160);
  if (Array.isArray(value)) return `Array(${value.length})`;
  if (value && typeof value === "object") return `Object keys: ${Object.keys(value).slice(0, 8).join(", ")}`.slice(0, 160);
  return String(value).slice(0, 160);
}

export async function compactChromeResult(
  value: unknown,
  options: { logger?: EventLogger; conversationId?: string; toolCallId?: string },
): Promise<unknown> {
  if (value && typeof value === "object" && "$ref" in value && "access" in value && "scope" in value) return value;
  let serialized: string | undefined;
  try { serialized = JSON.stringify(value); } catch { return value; }
  if (!serialized || !options.logger) return value;
  const bytes = new TextEncoder().encode(serialized).byteLength;
  if (bytes <= LARGE_RESULT_BYTES) return value;
  const event = await options.logger.append({
    type: "tool.result.data",
    conversationId: options.conversationId,
    toolCallId: options.toolCallId,
    content: { bytes },
    output: value,
  });
  if (!event) throw new Error("Could not save large tool result");
  return {
    $ref: event.id,
    ref: event.id,
    type: Array.isArray(value) ? "array" : value === null ? "null" : typeof value,
    bytes,
    preview: previewOf(value),
    access: `await globalThis.__surfWaxResult(${event.id}, {path?, offset?, limit?})`,
    host: "log",
    contextId: options.conversationId ?? "global",
    expiresAt: null,
  };
}

export function createChromeTool(executor: ChromeExecutor, options: { logger?: EventLogger; conversationId?: string } = {}) {
  return dynamicTool({
    description: [
      "Run an async JavaScript function body; explicitly return the result. Calls are globally sequential.",
      "Set target.kind to extension, page, service-worker, offscreen, devtools, or native; auto selects only when unambiguous.",
      "Page targets accept tabId, frameId/documentId and MAIN, ISOLATED, or USER_SCRIPT. In the extension target, await chrome.capabilities() to inspect live availability.",
      "Large JSON results return a durable event reference: inspect selected parts with await globalThis.__surfWaxResult(id) in a later extension-realm call.",
    ].join(" "),
    inputSchema: chromeToolInputSchema,
    needsApproval: false,
    execute: async (input, { abortSignal, toolCallId }) => compactChromeResult(
      await executor.execute(parseChromeToolInput(input), abortSignal, { conversationId: options.conversationId }),
      { ...options, toolCallId },
    ),
  });
}
