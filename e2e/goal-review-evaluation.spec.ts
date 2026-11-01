import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { ModelMessage } from "ai";
import { expect, test } from "@playwright/test";
import { EventLogger, fromLogValue, type LogEvent } from "../src/logging";
import { actionHistory, GOAL_SCHEMA, runEvidence } from "../src/agent/goal-completion";
import { goalReviewContext, reviewGoal } from "../src/agent/goal-review";
import { modelProxy } from "./evaluation/model-proxy";
import { closeServer } from "./fixtures";

// A read-only model replay of actual canonical evidence; it does not rerun the
// browser task or constitute a new business-task success measurement.
test("@real-model reviews recorded completion against all earlier action receipts", async () => {
  test.skip(process.env.SURFWAX_REAL_MODEL_EVAL !== "1" || !process.env.SURFWAX_GOAL_REVIEW_EVENTS_FILE, "Explicit real-model replay opt-in required");
  test.setTimeout(120_000);
  const file = resolve(process.env.SURFWAX_GOAL_REVIEW_EVENTS_FILE!);
  const expected = process.env.SURFWAX_GOAL_REVIEW_EXPECT_ACCEPT;
  if (expected !== "true" && expected !== "false") throw new Error("Set SURFWAX_GOAL_REVIEW_EXPECT_ACCEPT=true|false");
  const upstream = process.env.SURFWAX_EVAL_BASE_URL, key = process.env.SURFWAX_EVAL_API_KEY, model = process.env.SURFWAX_EVAL_MODEL;
  if (!upstream || !key || !model) throw new Error("Set real model endpoint, key and model");
  const source = JSON.parse(await readFile(file, "utf8")) as LogEvent[];
  const proposal = [...source].reverse().find((event) => event.type === "tool.started" && (fromLogValue(event.content, event.valueEncoding) as { toolName?: string })?.toolName === "complete_goal");
  if (!proposal?.runId || !proposal.conversationId) throw new Error("A canonical goal proposal and run identity are required");
  const goal = GOAL_SCHEMA.parse(fromLogValue(proposal.input, proposal.valueEncoding));
  const events = source.filter((event) => event.id < proposal.id);
  const logger = new EventLogger({ store: { async append(record) { const event = { ...record, id: (events.at(-1)?.id ?? 0) + 1 }; events.push(event); return event; }, async all() { return [...events]; }, async clear() {} } });
  const messages: ModelMessage[] = [];
  const userIds = new Set<string>();
  for (const event of events) {
    if (event.type === "conversation.message") {
      const message = fromLogValue(event.content, event.valueEncoding) as { id?: string; role?: string; parts?: Array<{ type: string; text?: string }> };
      if (message.role === "user" && message.id && !userIds.has(message.id)) {
        userIds.add(message.id);
        messages.push({ role: "user", content: message.parts?.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n") ?? "" });
      }
    }
    if (["tool.finished", "tool.failed"].includes(event.type) && event.toolCallId) {
      const name = (fromLogValue(event.content, event.valueEncoding) as { toolName?: string })?.toolName;
      if (name && name !== "complete_goal") messages.push({ role: "tool", content: [{ type: "tool-result", toolCallId: event.toolCallId, toolName: name,
        output: { type: "json", value: fromLogValue(event.output, event.valueEncoding) as any } }] });
    }
  }
  const history = actionHistory(await runEvidence(logger, proposal.conversationId, proposal.runId));
  const context = goalReviewContext(messages, 96_000, undefined, goal.taskType === "browser" ? goal.evidence.map((entry) => entry.toolCallId) : []);
  const proxy = await modelProxy(upstream, key);
  try {
    const languageModel = createOpenAICompatible({ name: "replay", apiKey: proxy.token, baseURL: proxy.baseURL }).chatModel(model);
    const verdict = await reviewGoal({ goal, context, history, model: languageModel, signal: AbortSignal.timeout(90_000), logger,
      conversationId: proposal.conversationId, budget: { input: 128_000, output: 2048 } });
    const directory = resolve(process.env.SURFWAX_GOAL_REVIEW_REPORT_DIR ?? ".dev/verification/goal-review-replays");
    await mkdir(directory, { recursive: true });
    await writeFile(resolve(directory, `${Date.now()}-${randomUUID()}.json`), JSON.stringify({ source: file, model, expected: expected === "true", verdict, actionHistory: history, requests: proxy.requests }, null, 2), { flag: "wx", mode: 0o600 });
    expect(verdict.accept).toBe(expected === "true");
  } finally { await closeServer(proxy.server); }
});
