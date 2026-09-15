import { dynamicTool } from "ai";
import { z } from "zod";
import type { ChromeToolInput } from "../types";
import { ChromeExecutor } from "./executor";

export const chromeToolInputSchema = z.object({
  code: z.string().min(1),
}).strict();

export function parseChromeToolInput(input: unknown): ChromeToolInput {
  return chromeToolInputSchema.parse(input);
}

export function createChromeTool(executor: ChromeExecutor) {
  return dynamicTool({
    description: [
      "The only browser tool. Execute JavaScript as the body of an async function in the current Side Panel extension realm.",
      "The code can use Web APIs and every available chrome.* Extension API, including chrome.userScripts, chrome.scripting, and chrome.debugger/CDP.",
      "Return the desired value explicitly. Calls run sequentially with no application timeout, output limit, approval, sandbox, or capability layer.",
    ].join(" "),
    inputSchema: chromeToolInputSchema,
    needsApproval: false,
    execute: async (input, { abortSignal }) => executor.execute(parseChromeToolInput(input), abortSignal),
  });
}
