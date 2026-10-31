import { errors, type BrowserContext } from "@playwright/test";
import { fromLogValue } from "../../src/logging";

/** Do not probe while a browser job could still manipulate the new document. */
export function browserJobsSettled(events: readonly { id?: unknown; type?: unknown; conversationId?: unknown; runId?: unknown; content?: unknown; valueEncoding?: unknown }[]): boolean | null {
  const states = new Map<string, { id: number; state: string }>();
  const ids = new Set<number>();
  const known = new Set(["queued", "running", "blocked", "succeeded", "failed", "cancelled", "interrupted"]);
  for (const event of events) {
    if (event.type !== "browser.job.state") continue;
    if (!Number.isSafeInteger(event.id) || Number(event.id) < 1 || ids.has(event.id as number)
      || typeof event.conversationId !== "string" || !event.conversationId || typeof event.runId !== "string" || !event.runId
      || event.valueEncoding !== undefined && ![2, 3, 4, 5].includes(event.valueEncoding as number)) return null;
    ids.add(event.id as number);
    let content: unknown;
    try { content = fromLogValue(event.content, event.valueEncoding as 2 | 3 | 4 | 5 | undefined); } catch { return null; }
    if (!content || typeof content !== "object" || Array.isArray(content)) return null;
    const { jobId, state } = content as Record<string, unknown>;
    if (typeof jobId !== "string" || !jobId || typeof state !== "string" || !known.has(state)) return null;
    const key = JSON.stringify([event.conversationId, event.runId, jobId]);
    const prior = states.get(key);
    if (!prior || Number(event.id) > prior.id) states.set(key, { id: Number(event.id), state });
  }
  return [...states.values()].every(({ state }) => ["succeeded", "failed", "cancelled", "interrupted"].includes(state));
}

/** Observe an unseen cross-origin document after the agent has stopped.
 * Failure to reach the intended document is unknown, not a script failure. */
export async function verifyUserScript(context: BrowserContext, verification: { url: string; frameUrl: string; expectedStamp: string }): Promise<boolean | null> {
  let page;
  try {
    page = await context.newPage();
    const response = await page.goto(verification.url, { waitUntil: "load", timeout: 5_000 });
    if (!response?.ok()) return null;
    const element = await page.locator('iframe[title="Verification"]').elementHandle({ timeout: 5_000 });
    const frame = await element?.contentFrame();
    if (!frame || frame.url() !== verification.frameUrl) return null;
    const ready = async () => !frame.isDetached() && frame.url() === verification.frameUrl
      && await frame.locator("body").getAttribute("data-verification-ready", { timeout: 1_000 }) === "true"
      && await frame.locator("body").getAttribute("data-expected-stamp", { timeout: 1_000 }) === verification.expectedStamp;
    if (!await ready()) return null;
    try {
      await frame.waitForFunction((expected) => document.documentElement.dataset.stamp === expected, verification.expectedStamp, { timeout: 3_000 });
      return await ready() ? true : null;
    } catch (error) {
      return error instanceof errors.TimeoutError && await ready() ? false : null;
    }
  } catch {
    return null;
  } finally {
    await page?.close().catch(() => undefined);
  }
}
