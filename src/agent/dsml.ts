import type { LanguageModelMiddleware } from "ai";
import type { LanguageModelV4StreamPart, LanguageModelV4ToolCall } from "@ai-sdk/provider";
import { actInputSchema, COMMAND_NAMES, normalizeCommandInput, parseCommandInput, resultInputSchema, type CommandName } from "../chrome/tool";
import type { EventLogger } from "../logging";

type Parsed = { calls: LanguageModelV4ToolCall[] } | { error: string };

const DIALECTS = [
  { calls: "<｜DSML｜ calls>", endCalls: "</｜DSML｜ calls>", invoke: "<｜DSML｜ invoke name=\"", endInvoke: "</｜DSML｜ invoke>", parameter: "<｜DSML｜ parameter name=\"", endParameter: "</｜DSML｜ parameter>" },
  { calls: "<｜DSML｜tool_calls>", endCalls: "</｜DSML｜tool_calls>", invoke: "<｜DSML｜invoke name=\"", endInvoke: "</｜DSML｜invoke>", parameter: "<｜DSML｜parameter name=\"", endParameter: "</｜DSML｜parameter>" },
] as const;
const END_SENTENCE = "<｜end▁of▁sentence｜>";
const DSML_MARKER = "<｜DSML｜";

function parseDsml(text: string, activeTools: Set<string>): Parsed | undefined {
  let source = text.trim();
  if (source.endsWith(END_SENTENCE)) source = source.slice(0, -END_SENTENCE.length).trimEnd();
  const dialect = DIALECTS.find(({ calls }) => source.startsWith(calls));
  if (!dialect) return source.startsWith(DSML_MARKER) ? { error: "invalid-opening-tag" } : undefined;
  const calls: LanguageModelV4ToolCall[] = [];
  let index = dialect.calls.length;
  const skipSpace = () => { while (/\s/.test(source[index] ?? "")) index++; };
  const fail = (error: string): Parsed => ({ error });

  while (true) {
    skipSpace();
    if (source.startsWith(dialect.endCalls, index)) {
      index += dialect.endCalls.length;
      return calls.length && !source.slice(index).trim() ? { calls } : fail("incomplete-or-trailing-content");
    }
    if (!source.startsWith(dialect.invoke, index)) return fail("invalid-invoke");
    index += dialect.invoke.length;
    const nameEnd = source.indexOf('\">', index);
    if (nameEnd < 0) return fail("invalid-tool-name");
    const toolName = source.slice(index, nameEnd);
    if (!activeTools.has(toolName)) return fail("unknown-or-inactive-tool");
    index = nameEnd + 2;
    const input: Record<string, unknown> = {};
    while (true) {
      skipSpace();
      if (source.startsWith(dialect.endInvoke, index)) { index += dialect.endInvoke.length; break; }
      if (!source.startsWith(dialect.parameter, index)) return fail("invalid-parameter");
      index += dialect.parameter.length;
      const header = /^(.*?)" string="(true|false)">/.exec(source.slice(index));
      if (!header || !header[1] || Object.hasOwn(input, header[1])) return fail("invalid-parameter-name");
      index += header[0].length;
      const valueEnd = source.indexOf(dialect.endParameter, index);
      if (valueEnd < 0) return fail("incomplete-parameter");
      const raw = source.slice(index, valueEnd);
      try { input[header[1]] = header[2] === "true" ? raw : JSON.parse(raw); }
      catch { return fail("invalid-json-parameter"); }
      index = valueEnd + dialect.endParameter.length;
    }
    const normalized = normalizeCommandInput(toolName, input);
    if (normalized === undefined) return fail("ambiguous-arguments");
    let validated: unknown;
    try {
      validated = toolName === "act" ? actInputSchema.parse(normalized)
        : toolName === "result" ? resultInputSchema.parse(normalized)
          : COMMAND_NAMES.includes(toolName as CommandName) ? parseCommandInput(toolName as CommandName, normalized)
            : undefined;
    } catch { return fail("invalid-tool-arguments"); }
    if (validated === undefined) return fail("unknown-tool");
    calls.push({ type: "tool-call", toolCallId: crypto.randomUUID(), toolName, input: JSON.stringify(validated), dynamic: true });
  }
}

export function dsmlMiddleware(logger?: EventLogger, conversationId?: string): LanguageModelMiddleware {
  const log = (result: Parsed) => logger?.record({
    type: "model.dsml.recovery",
    conversationId,
    content: "calls" in result ? { recovered: true, toolNames: result.calls.map(({ toolName }) => toolName) } : { recovered: false, reason: result.error },
  });
  return {
    specificationVersion: "v4",
    wrapGenerate: async ({ doGenerate, params }) => {
      const result = await doGenerate();
      if (!params.tools?.some((tool) => tool.type === "function") || params.toolChoice?.type === "none") return result;
      const textParts = result.content.filter((part) => part.type === "text");
      if (!textParts.length) return result;
      const activeTools = params.tools.filter((tool) => tool.type === "function" && (params.toolChoice?.type !== "tool" || tool.name === params.toolChoice.toolName)).map((tool) => tool.name);
      const parsed = parseDsml(textParts.map((part) => part.text).join(""), new Set(activeTools));
      if (!parsed) return result;
      const nativeCall = result.content.some((part) => part.type === "tool-call");
      if (!nativeCall) log(parsed);
      if (!("calls" in parsed)) return result;
      const firstText = result.content.findIndex((part) => part.type === "text");
      return { ...result,
        content: result.content.flatMap((part, index) => part.type !== "text" ? [part] : !nativeCall && index === firstText ? parsed.calls : []),
        finishReason: nativeCall ? result.finishReason : { ...result.finishReason, unified: "tool-calls" as const },
      };
    },
    wrapStream: async ({ doStream, params }) => {
      const result = await doStream();
      if (!params.tools?.some((tool) => tool.type === "function") || params.toolChoice?.type === "none") return result;
      const activeTools = new Set(params.tools.filter((tool) => tool.type === "function" && (params.toolChoice?.type !== "tool" || tool.name === params.toolChoice.toolName)).map((tool) => tool.name));
      let mode: "probe" | "buffer" | "pass" = "probe";
      let buffered: LanguageModelV4StreamPart[] = [];
      let text = "";
      let nativeCall = false;
      const flush = (controller: TransformStreamDefaultController<LanguageModelV4StreamPart>) => {
        for (const part of buffered) controller.enqueue(part);
        buffered = [];
      };
      return { ...result, stream: result.stream.pipeThrough(new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
        transform(part, controller) {
          if (part.type === "tool-call" || part.type === "tool-input-start") {
            nativeCall = true;
            if (mode !== "pass") {
              if (text && !text.trimStart().startsWith(DSML_MARKER)) {
                flush(controller);
                mode = "pass";
              }
            }
            controller.enqueue(part);
            return;
          }
          if (mode !== "pass" && (part.type === "text-start" || part.type === "text-delta" || part.type === "text-end")) {
            buffered.push(part);
            if (part.type === "text-delta") text += part.delta;
            if (mode === "probe") {
              const candidate = text.trimStart();
              if (candidate.startsWith(DSML_MARKER)) mode = "buffer";
              else if (!DIALECTS.some(({ calls }) => calls.startsWith(candidate))) { flush(controller); mode = "pass"; }
            }
            return;
          }
          if (part.type === "finish" && mode !== "pass") {
            const parsed = parseDsml(text, activeTools);
            if (parsed && !nativeCall) log(parsed);
            if (parsed && "calls" in parsed && !nativeCall) {
              buffered = [];
              for (const call of parsed.calls) controller.enqueue(call);
              controller.enqueue({ ...part, finishReason: { ...part.finishReason, unified: "tool-calls" } });
            } else {
              if (nativeCall && parsed && "calls" in parsed) buffered = [];
              else flush(controller);
              controller.enqueue(part);
            }
            mode = "pass";
            return;
          }
          controller.enqueue(part);
        },
        flush(controller) { flush(controller); },
      })) };
    },
  };
}
