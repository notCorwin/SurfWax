import type { BrowserContext, Worker } from "@playwright/test";

/** A persistent Chrome profile can restore an unpacked extension's old worker. */
export async function reloadDevelopmentExtension(
  context: BrowserContext,
  worker: Worker,
): Promise<Worker> {
  const extensionId = new URL(worker.url()).hostname;
  const wake = await context.newPage();
  try {
    await wake.goto(`chrome://extensions/?id=${extensionId}`);
    const developerMode = wake.locator("extensions-toolbar #devMode");
    await developerMode.waitFor({ state: "visible" });
    if (
      (await developerMode.evaluate(
        (element) =>
          element.getAttribute("aria-checked") ??
          element.getAttribute("aria-pressed"),
      )) !== "true"
    )
      await developerMode.click();
    const refreshed = context
      .waitForEvent("serviceworker", {
        predicate: (next) => new URL(next.url()).hostname === extensionId,
        timeout: 30_000,
      })
      .then(
        (worker) => ({ worker }),
        (error: unknown) => ({ error }),
      );
    let reloadError: unknown;
    try {
      await worker.evaluate(() => chrome.runtime.reload());
    } catch (error) {
      reloadError = error; /* Reload can destroy the old evaluation context. */
    }
    // Reload unregisters the extension briefly. An extension page can then wake
    // its lazy MV3 worker even when Chrome does not start it automatically.
    const deadline = Date.now() + 30_000;
    while (true) {
      try {
        await wake.goto(`chrome-extension://${extensionId}/options.html`, {
          waitUntil: "domcontentloaded",
        });
        break;
      } catch (error) {
        if (
          Date.now() >= deadline ||
          !/net::ERR_(?:BLOCKED_BY_CLIENT|ABORTED|FAILED)/.test(String(error))
        )
          throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    await wake.evaluate(() =>
      chrome.runtime.sendMessage({ type: "surf-wax:guard-status" }),
    );
    const result = await refreshed;
    if ("error" in result)
      throw new Error(
        "重新加载开发扩展失败，未能启动当前源码的 Service Worker。",
        { cause: reloadError ?? result.error },
      );
    return result.worker;
  } finally {
    await wake.close().catch(() => undefined);
  }
}
