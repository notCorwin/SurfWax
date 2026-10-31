import { errors, type BrowserContext } from "@playwright/test";

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
