import { expect, it } from "vitest";
import { EventLogger } from "@/logging";
import { createMemoryEventStore } from "@/memory-event-store";
import { updateWaitingPhase } from "./waiting-status";
import { errorDetails } from "@/components/ui/error-notice";
import { classifyModelFailure } from "@/model-error";

it("isolates backoff by run and clears it at the actual request boundary and terminal", async () => {
  const logger = new EventLogger({ store: createMemoryEventStore() });
  const append = async (runId: string, type: string, fields = {}) => (await logger.append({ conversationId: "c", runId, type, ...fields }))!;
  let phase = updateWaitingPhase(undefined, await append("old", "conversation.submitted"));
  phase = updateWaitingPhase(phase, await append("old", "request.retry", {
    content: { status: 429, reason: "SECRET https://secret.test/?api_key=secret" }, retry: { attempt: 1, delayMs: 3000 },
  }));
  expect(phase?.retry?.reason).toBe("请求受到限制，请稍后重试并检查服务额度。");
  expect(phase?.retry?.until).toBeGreaterThan(Date.now());
  phase = updateWaitingPhase(phase, await append("old", "request.started"));
  expect(phase?.retry).toBeUndefined();
  phase = updateWaitingPhase(phase, await append("old", "conversation.aborted"));
  const terminal = phase;
  expect(updateWaitingPhase(phase, await append("old", "request.retry", { retry: { delayMs: 3000 } }))).toBe(terminal);
  phase = updateWaitingPhase(phase, await append("new", "conversation.submitted"));
  expect(updateWaitingPhase(phase, await append("old", "request.retry", { retry: { delayMs: 3000 } }))).toBe(phase);
  phase = updateWaitingPhase(phase, await append("new", "request.retry", { retry: { delayMs: 3000, reason: "timeout" } }));
  expect(phase?.retry?.reason).toContain("请求超时");
  phase = updateWaitingPhase(phase, await append("new", "request.retry", { retry: { delayMs: 0 } }));
  expect(phase?.retry).toBeUndefined();
  expect(errorDetails({ statusCode: 401, message: "SECRET" })).toBe("认证失败，请检查 API 密钥和访问权限。");
  expect(errorDetails({ statusCode: 503, message: "SECRET" })).toBe("服务暂时不可用，请稍后重试。");
  expect(errorDetails(new Error("SECRET https://secret.test/?api_key=secret"))).not.toMatch(/SECRET|secret.test/);
  const uiError = new TypeError("SECRET https://secret.test/?api_key=secret");
  expect(errorDetails(uiError)).toBe("操作未完成，请检查设置后重试。");
  expect(errorDetails(new Error("SECRET", { cause: uiError }))).toBe("操作未完成，请检查设置后重试。");
  expect(classifyModelFailure(uiError, "model-request")).toBe("network");
  expect(errorDetails(new Error("SECRET", { cause: { statusCode: 401 } }))).toBe("认证失败，请检查 API 密钥和访问权限。");
  expect(errorDetails(new Error("SECRET", { cause: { code: "ECONNRESET" } }))).toContain("网络连接中断");
  expect(errorDetails(new Error("SECRET", { cause: { code: "ETIMEDOUT" } }))).toContain("请求超时");
});
