/** Fixed presentation vocabulary, derived only from structured provider/transport fields. */
export type ModelFailure = "auth" | "rate-limit" | "service" | "timeout" | "network" | "unknown";
export function classifyModelFailure(error: unknown, boundary?: "model-request"): ModelFailure {
  const seen = new Set<unknown>();
  let current = error;
  let fallback: ModelFailure = "unknown";
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const value = current as { statusCode?: unknown; status?: unknown; name?: unknown; code?: unknown; cause?: unknown };
    const status = value.statusCode ?? value.status;
    if (status === 401 || status === 403) return "auth";
    if (status === 429) return "rate-limit";
    if (status === 408 || status === 504) return "timeout";
    if (typeof status === "number" && status >= 500) return "service";
    if (value.name === "TimeoutError" || ["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"].includes(String(value.code))) return "timeout";
    // Fetch uses TypeError, but the same type also describes ordinary UI bugs.
    if ((boundary === "model-request" && value.name === "TypeError") || value.name === "NetworkError" || ["ECONNRESET", "ECONNREFUSED", "EPIPE", "UND_ERR_SOCKET"].includes(String(value.code))) fallback = "network";
    current = value.cause;
  }
  return fallback;
}
export const modelFailureMessages: Record<ModelFailure, string> = {
  auth: "认证失败，请检查 API 密钥和访问权限。",
  "rate-limit": "请求受到限制，请稍后重试并检查服务额度。",
  service: "服务暂时不可用，请稍后重试。",
  timeout: "请求超时，请检查网络连接或稍后重试。",
  network: "网络连接中断，请检查网络连接和服务地址。",
  unknown: "操作未完成，请检查设置后重试。",
};
