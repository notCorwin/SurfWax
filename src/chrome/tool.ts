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
      "The browser automation tool for the browser controlled by the user. Execute JavaScript as the body of an async function in the current Side Panel extension realm.",
      "Use Web APIs and the available chrome.* Extension APIs needed for the user's request, including chrome.userScripts, chrome.scripting, and chrome.debugger/CDP.",
      "Return the desired value explicitly. Calls run sequentially. Non-JSON results return a reference; inspect it in later calls with globalThis.__surfWaxResults.get(id), and delete it when done.",
    ].join(" "),
    inputSchema: chromeToolInputSchema,
    needsApproval: false,
    execute: async (input, { abortSignal }) => executor.execute(parseChromeToolInput(input), abortSignal),
  });
}
