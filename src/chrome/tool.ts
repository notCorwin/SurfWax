import { dynamicTool } from "ai";
import { z } from "zod";
import type { EventLogger } from "../logging";
import type { BrowserInput } from "../types";
import { ChromeExecutor } from "./executor";

const timeout = z.number().int().positive().optional();
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
  z.object({ mode: z.literal("run"), code: z.string().min(1), timeoutMs: timeout }).strict(),
]);

export function parseBrowserToolInput(input: unknown): BrowserInput { return browserToolInputSchema.parse(input) as BrowserInput; }

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

export async function compactToolResult(value: unknown, options: { logger?: EventLogger; conversationId?: string; toolCallId?: string }): Promise<unknown> {
  if (value && typeof value === "object" && "$ref" in value && "access" in value && "scope" in value) return value;
  let serialized: string | undefined;
  try { serialized = JSON.stringify(value); } catch { return value; }
  if (!serialized || !options.logger || hasScreenshot(value)) return value;
  const bytes = new TextEncoder().encode(serialized).byteLength;
  if (bytes <= LARGE_RESULT_BYTES) return value;
  const event = await options.logger.append({ type: "tool.result.data", conversationId: options.conversationId, toolCallId: options.toolCallId, content: { bytes }, output: value });
  if (!event) throw new Error("Could not save large tool result");
  return { $ref: event.id, ref: event.id, type: Array.isArray(value) ? "array" : value === null ? "null" : typeof value, bytes, preview: previewOf(value), access: `await browser.result(${event.id}, {path?, offset?, limit?})`, host: "log", contextId: options.conversationId ?? "global", expiresAt: null, scope: "extension" };
}

export function createBrowserTool(executor: ChromeExecutor, options: { logger?: EventLogger; conversationId?: string; visualEnabled?: () => Promise<boolean> } = {}) {
  return dynamicTool({
    description: "Control Chrome. Prefer observe then act for semantic refs, strict locators, real input, waits, and structured recovery. Use run only when the DSL cannot express the task; run exposes browser.page(tabId?), browser.runIn(target, code), browser.cdp(debuggee), browser.result(id), and the complete proxied chrome API. An action only confirms input was sent, so use expect for the intended outcome.",
    inputSchema: browserToolInputSchema, needsApproval: false,
    execute: async (input, { abortSignal, toolCallId }) => {
      const parsed = parseBrowserToolInput(input);
      return compactToolResult(await executor.executeBrowser(parsed, abortSignal, { conversationId: options.conversationId, toolCallId, visualEnabled: parsed.mode === "run" ? false : await options.visualEnabled?.() ?? false }), { ...options, toolCallId });
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
