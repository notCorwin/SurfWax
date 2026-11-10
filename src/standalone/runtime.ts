import { ChromeExecutor } from "../chrome/executor";
import { createProgramTools, PROGRAM_TOOL_CONTEXT, PROGRAM_TOOL_REGISTRY } from "../chrome/tool";
import { EventLogger, type LogEvent } from "../logging";
import { CdpConnection } from "./cdp";
import { createChromeAdapter, OBSERVATION_WORLD } from "./chrome-adapter";
import { executeNodeProgram } from "./program-host";

export { PROGRAM_TOOL_CONTEXT, PROGRAM_TOOL_REGISTRY };

/** One isolated tool run on an extension-free Chrome CDP connection. */
export async function connectToolRuntime(endpoint: string) {
  const cdp = await CdpConnection.connect(endpoint);
  const controller = new AbortController();
  const events: LogEvent[] = [];
  const logger = new EventLogger({ store: {
    async append(event) { const stored = { ...event, id: events.length + 1 }; events.push(stored); return stored; },
    async all() { return [...events]; }, async clear() { events.length = 0; },
  } });
  let executor: ChromeExecutor | undefined;
  try {
    const chromeApi = await createChromeAdapter(cdp);
    const identity = { runId: crypto.randomUUID(), generation: 1, ownerId: crypto.randomUUID() };
    logger.beginRun(identity.runId, identity.runId);
    executor = new ChromeExecutor({ chromeApi, observationWorldName: OBSERVATION_WORLD, logger,
      programHost: executeNodeProgram, runIdentity: () => identity });
    await executor.beginRun();
    const tools = createProgramTools(executor, { logger, conversationId: identity.runId, runSignal: controller.signal });
    let closed = false;
    return {
      tools, executor, logger, events,
      async call(name: string, input: unknown = {}, signal?: AbortSignal): Promise<unknown> {
        if (closed) throw new Error("Standalone tool runtime is closed; connect a new runtime.");
        const tool = tools[name];
        if (!tool?.execute) throw new Error(`Unknown tool ${JSON.stringify(name)}; use the tools command to list available names.`);
        return tool.execute(input, { toolCallId: crypto.randomUUID(), messages: [], context: {}, abortSignal: signal });
      },
      async close() {
        if (closed) return;
        closed = true; controller.abort(new DOMException("Standalone runtime closed", "AbortError"));
        try { await executor!.endRun(); await logger.flush(); }
        finally { executor!.dispose(); logger.dispose(); cdp.close(); }
      },
    };
  } catch (error) { executor?.dispose(); logger.dispose(); cdp.close(); throw error; }
}
