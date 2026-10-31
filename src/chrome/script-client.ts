import { z } from "zod";
import { getRunIdentity } from "../agent/coordinator";
import { scriptChanges, scriptDefinition, scriptId } from "../userscripts/schema";

const scriptSchemas: Record<string, z.ZodTypeAny> = {
  list: z.object({}).strict(),
  read: z.object({ id: scriptId }).strict(),
  create: z.object({ script: scriptDefinition }).strict(),
  edit: z.object({ id: scriptId, changes: scriptChanges }).strict(),
  setEnabled: z.object({ id: scriptId, enabled: z.boolean() }).strict(),
  delete: z.object({ id: scriptId }).strict(),
};

export async function callUserScript(method: string, args: unknown[], signal?: AbortSignal, onDispatch?: () => Promise<void>): Promise<unknown> {
  const schema = scriptSchemas[method];
  if (!schema) throw new Error("Unsupported user script method");
  schema.parse(method === "list" ? {} : method === "read" ? { id: args[0] } : method === "create" ? { script: args[0] } : args[0]);
  if (signal?.aborted) throw new DOMException("Operation aborted", "AbortError");
  if (onDispatch) await onDispatch();
  if (signal?.aborted) throw new DOMException("Operation aborted", "AbortError");
  const pending = chrome.runtime.sendMessage({ type: "surf-wax:user-scripts", method, args, ...getRunIdentity(), operationId: crypto.randomUUID() });
  let onAbort: (() => void) | undefined;
  const interrupted = signal && new Promise<never>((_, reject) => {
    onAbort = () => reject(Object.assign(new DOMException("Operation aborted", "AbortError"), { effectUnknown: !["list", "read"].includes(method) }));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const response = await (interrupted ? Promise.race([pending, interrupted]) : pending);
    if (!response?.ok) throw new Error(response?.error ?? "用户脚本操作失败");
    return response.result;
  } finally {
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }
}
