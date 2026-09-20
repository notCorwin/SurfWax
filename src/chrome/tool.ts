import { dynamicTool } from "ai";
import { z } from "zod";
import type { EventLogger } from "../logging";
import type { BrowserInput } from "../types";
import { ChromeExecutor } from "./executor";

const timeout = z.number().int().positive().optional();
const chromeTarget = z.object({
  kind: z.enum(["auto", "extension", "service-worker", "page", "offscreen", "devtools"]),
  tabId: z.number().int().nonnegative().optional(), frameId: z.number().int().nonnegative().optional(), documentId: z.string().min(1).optional(),
  world: z.enum(["MAIN", "ISOLATED", "USER_SCRIPT"]).optional(), targetId: z.string().min(1).optional(), sessionId: z.string().min(1).optional(),
}).strict();
const selector = z.object({
  by: z.enum(["role", "text", "label", "placeholder", "alt", "title", "testId", "css"]), value: z.string().min(1),
  name: z.string().optional(), exact: z.boolean().optional(), index: z.number().int().optional(),
  frame: z.object({ by: z.literal("css"), value: z.string().min(1) }).strict().optional(),
}).strict();
const target = z.union([
  z.object({ ref: z.string().min(1) }).strict(), selector,
  z.object({ point: z.object({ observationId: z.string().min(1), x: z.number().finite(), y: z.number().finite() }).strict() }).strict(),
]);
const files = z.array(z.object({
  name: z.string().min(1), mimeType: z.string().min(1).optional(), text: z.string().optional(), base64: z.string().optional(), url: z.string().url().optional(),
}).strict().refine((file) => [file.text, file.base64, file.url].filter((value) => value !== undefined).length === 1, "Exactly one of text, base64, or url is required")).min(1);
const step = z.discriminatedUnion("type", [
  z.object({ type: z.literal("goto"), url: z.string().url() }).strict(),
  ...(["click", "doubleClick", "hover"] as const).map((kind) => z.object({ type: z.literal(kind), target }).strict()),
  z.object({ type: z.literal("fill"), target, value: z.string() }).strict(), z.object({ type: z.literal("clear"), target }).strict(),
  z.object({ type: z.literal("press"), target: target.optional(), key: z.string().min(1) }).strict(),
  z.object({ type: z.literal("insertText"), target: target.optional(), text: z.string() }).strict(),
  z.object({ type: z.literal("select"), target, values: z.array(z.string()).min(1) }).strict(),
  z.object({ type: z.literal("check"), target, checked: z.boolean().optional() }).strict(),
  z.object({ type: z.literal("drag"), from: target, to: target }).strict(), z.object({ type: z.literal("upload"), target, files }).strict(),
  z.object({ type: z.literal("expect"), target: target.optional(), state: z.enum(["attached", "detached", "visible", "hidden", "enabled", "editable", "checked"]).optional(), text: z.string().optional(), value: z.string().optional(), url: z.string().optional() }).strict()
    .refine((value) => Boolean(value.url || value.target && (value.state || value.text !== undefined || value.value !== undefined)), "expect requires url or a target condition"),
]);

export const browserToolInputSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("observe"), tabId: z.number().int().nonnegative().optional(), detail: z.enum(["auto", "semantic", "visual"]).optional(), since: z.string().min(1).optional(), timeoutMs: timeout }).strict(),
  z.object({ mode: z.literal("act"), tabId: z.number().int().nonnegative().optional(), observationId: z.string().min(1).optional(), steps: z.array(step).min(1), timeoutMs: timeout }).strict(),
  z.object({ mode: z.literal("run"), code: z.string().min(1), target: chromeTarget.optional(), timeoutMs: timeout }).strict(),
  z.object({ mode: z.literal("result"), id: z.number().int().positive(), path: z.union([z.string(), z.array(z.union([z.string(), z.number().int()]))]).optional(), offset: z.number().int().nonnegative().optional(), limit: z.number().int().nonnegative().optional() }).strict(),
]);

export function parseBrowserToolInput(input: unknown): BrowserInput { return browserToolInputSchema.parse(input) as BrowserInput; }

export function repairBrowserToolCall<T extends { toolName: string; input: string }>(toolCall: T): T | null {
  if (toolCall.toolName !== "browser") return null;
  try {
    const input = JSON.parse(toolCall.input);
    if (input?.mode !== "act" || typeof input.steps !== "string") return null;
    const steps = JSON.parse(input.steps);
    if (!Array.isArray(steps)) return null;
    return { ...toolCall, input: JSON.stringify({ ...input, steps }) };
  } catch { return null; }
}

const LARGE_RESULT_BYTES = 8 * 1024;
function previewOf(value: unknown): string {
  if (typeof value === "string") return value.slice(0, 160);
  if (Array.isArray(value)) return `Array(${value.length})`;
  if (value && typeof value === "object") return `Object keys: ${Object.keys(value).slice(0, 8).join(", ")}`.slice(0, 160);
  return String(value).slice(0, 160);
}
function hasScreenshot(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && ("screenshot" in value && (value as any).screenshot?.data || Object.values(value).some(hasScreenshot)));
}

function valueAt(value: unknown, path: readonly (string | number)[]): unknown {
  return path.reduce<unknown>((current, part) => current !== null && typeof current === "object" ? (current as any)[part] : undefined, value);
}

function readablePathOf(value: unknown): Array<string | number> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const preferred = [["snapshot"], ["observation", "snapshot"], ["text"], ["html"]] as const;
  for (const path of preferred) {
    const selected = valueAt(value, path);
    if (typeof selected === "string" || Array.isArray(selected)) return [...path];
  }
  const key = Object.keys(value).find((candidate) => typeof (value as Record<string, unknown>)[candidate] === "string" || Array.isArray((value as Record<string, unknown>)[candidate]));
  return key ? [key] : undefined;
}

export async function compactToolResult(value: unknown, options: { logger?: EventLogger; conversationId?: string; toolCallId?: string }): Promise<unknown> {
  if (value && typeof value === "object" && "$ref" in value && "access" in value && "scope" in value) return value;
  let serialized: string | undefined;
  try { serialized = JSON.stringify(value); } catch { return value; }
  if (!serialized || !options.logger || hasScreenshot(value)) return value;
  const bytes = new TextEncoder().encode(serialized).byteLength;
  if (bytes <= LARGE_RESULT_BYTES) return value;
  const event = await options.logger.append({ type: "tool.result.data", conversationId: options.conversationId, toolCallId: options.toolCallId, content: { bytes }, output: value });
  if (!event) throw new Error("Could not save large tool result");
  const keys = value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).slice(0, 16) : undefined;
  const path = readablePathOf(value);
  const selected = path ? valueAt(value, path) : value;
  const access = JSON.stringify({ mode: "result", id: event.id, ...(path ? { path } : {}),
    ...(typeof selected === "string" ? { offset: 0, limit: 4000 } : Array.isArray(selected) ? { offset: 0, limit: 50 } : {}) });
  return { $ref: event.id, ref: event.id, type: Array.isArray(value) ? "array" : value === null ? "null" : typeof value, bytes, preview: previewOf(value), ...(keys ? { keys } : {}), access, host: "log", contextId: options.conversationId ?? "global", expiresAt: null, scope: "extension" };
}

export function createBrowserTool(executor: ChromeExecutor, options: { logger?: EventLogger; conversationId?: string; visualEnabled?: () => Promise<boolean> } = {}) {
  return dynamicTool({
    description: "Control Chrome. Prefer observe then act with semantic refs or role/label/text locators. Read large $ref output with mode=result and its exact access input before acting; never guess locators without page content. act.steps must be a JSON array and defaults to a 10 second timeout. run executes code in the explicit target (extension by default) and must return a value. An action only confirms input was sent, so use expect for the intended outcome.",
    inputSchema: browserToolInputSchema, needsApproval: false,
    execute: async (input, { abortSignal, toolCallId }) => {
      const parsed = parseBrowserToolInput(input);
      const result = await executor.executeBrowser(parsed, abortSignal, { conversationId: options.conversationId, toolCallId, visualEnabled: parsed.mode === "observe" ? await options.visualEnabled?.() ?? false : false });
      return parsed.mode === "result" ? result : compactToolResult(result, { ...options, toolCallId });
    },
  });
}

function scrubScreenshots(value: unknown, found: Array<{ mediaType: string; data: string }>): unknown {
  if (Array.isArray(value)) return value.map((item) => scrubScreenshots(item, found));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (key === "screenshot" && item && typeof item === "object" && typeof (item as any).data === "string") {
      found.push({ mediaType: (item as any).mediaType ?? "image/jpeg", data: (item as any).data });
      return [key, { ...(item as any), data: "[stored in canonical event log]" }];
    }
    return [key, scrubScreenshots(item, found)];
  }));
}

export function prepareBrowserMessages(messages: any[], stepNumber: number): any[] {
  const inject = stepNumber > 0 && messages.at(-1)?.role === "tool";
  const current: Array<{ mediaType: string; data: string }> = [];
  const prepared = messages.map((message, index) => message.role !== "tool" ? message : { ...message, content: message.content.map((part: any) => {
    if (part.type !== "tool-result" || part.toolName !== "browser" || part.output?.type !== "json") return part;
    const found: Array<{ mediaType: string; data: string }> = [];
    const value = scrubScreenshots(part.output.value, found);
    if (inject && index === messages.length - 1) current.push(...found);
    return { ...part, output: { ...part.output, value } };
  }) });
  const screenshot = current.at(-1);
  return screenshot ? [...prepared, { role: "user", content: [{ type: "file", mediaType: screenshot.mediaType, data: { type: "data", data: screenshot.data } }] }] : prepared;
}
