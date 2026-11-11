import type { ModelMessage } from "ai";
import { stringifyLogSafe } from "../logging";
import { inputBudget, type ModelLimit } from "./model-limits";

function estimateValue(value: unknown): number {
  return 1024 + Math.ceil(new TextEncoder().encode(stringifyLogSafe(value)).length / 3);
}

export function estimateInput(messages: readonly ModelMessage[]): number {
  return estimateValue(messages);
}

/** Fixed instructions and schemas cannot be reduced by summarizing a tiny task. */
export function hasSummarizableHistory(messages: readonly ModelMessage[], limit: ModelLimit): boolean {
  return estimateInput(messages) - estimateInput([]) >= Math.min(1024, inputBudget(limit) * 0.1);
}

export function estimatePromptInput(prompt: {
  instructions?: unknown; messages: readonly ModelMessage[]; tools?: readonly Record<string, unknown>[];
}): number {
  return estimateValue(prompt);
}

/** Request admission owns capacity policy; its caller owns history, I/O and persistence. */
export async function fitContextRequest(options: {
  prepared: ModelMessage[];
  outgoing: ModelMessage[];
  limit?: ModelLimit;
  prompt: { instructions?: unknown; tools?: readonly Record<string, unknown>[] };
  compaction?: {
    estimate(messages: ModelMessage[]): number;
    canCompact(messages: ModelMessage[], limit: ModelLimit): boolean;
    compact(messages: ModelMessage[], limit: ModelLimit, force: boolean): Promise<ModelMessage[]>;
  };
  finalize(messages: ModelMessage[]): Promise<ModelMessage[]>;
}): Promise<ModelMessage[]> {
  const { limit, prompt, compaction, finalize } = options;
  let { prepared, outgoing } = options;
  const estimate = (messages: ModelMessage[]) => compaction?.estimate(messages)
    ?? estimatePromptInput({ ...prompt, messages });
  let estimatedInput = estimate(outgoing);
  const capacity = limit && inputBudget(limit);
  // Fixed instructions and schemas cannot shrink by summarizing history.
  if (capacity && estimatePromptInput({ ...prompt, messages: [] }) >= capacity) {
    throw new Error("模型输入窗口无法容纳系统提示与工具定义；请增大上下文窗口或减少固定提示与工具开销。");
  }
  if (limit && estimatedInput > inputBudget(limit) * 0.8
    && (!compaction || compaction.canCompact(prepared, limit))) {
    if (!compaction) throw new Error("上下文容量不足，无法在当前运行中压缩历史消息。");
    prepared = await compaction.compact(prepared, limit, false);
    outgoing = await finalize(prepared);
    estimatedInput = estimate(outgoing);
  }
  // The growth guard can skip normal compaction, but must never admit overflow.
  if (limit && estimatedInput > inputBudget(limit)) {
    if (!compaction || !hasSummarizableHistory(prepared, limit)) {
      throw new Error("模型输入窗口无法容纳当前请求；原始历史已保留，请增大上下文窗口或减少固定提示与工具开销。");
    }
    prepared = await compaction.compact(prepared, limit, true);
    outgoing = await finalize(prepared);
    if (estimate(outgoing) > inputBudget(limit)) {
      throw new Error("压缩后请求仍超出模型输入窗口；原始历史已保留，请增大上下文窗口或减少固定提示与工具开销。");
    }
  }
  return outgoing;
}
