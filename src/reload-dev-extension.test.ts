import type { BrowserContext, Worker } from "@playwright/test";
import { describe, expect, it, vi } from "vitest";
import { reloadDevelopmentExtension } from "../scripts/reload-dev-extension";

function setup() {
  const worker = {
    url: () => "chrome-extension://extension-id/background.js",
    evaluate: vi.fn().mockResolvedValue(undefined),
  };
  const replacement = { url: worker.url };
  const wake = {
    goto: vi.fn().mockResolvedValue(undefined),
    locator: () => ({
      waitFor: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn().mockResolvedValue("true"),
    }),
    evaluate: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const context = {
    newPage: vi.fn().mockResolvedValue(wake),
    waitForEvent: vi.fn().mockResolvedValue(replacement),
  };
  return { worker, replacement, wake, context };
}

describe("development extension reload", () => {
  it("retries the handshake when the loading page navigates", async () => {
    const { context, worker, replacement, wake } = setup();
    wake.evaluate.mockRejectedValueOnce(
      new Error("page.evaluate: Execution context was destroyed, most likely because of a navigation."),
    );

    await expect(reloadDevelopmentExtension(
      context as unknown as BrowserContext,
      worker as unknown as Worker,
    )).resolves.toBe(replacement);
    expect(wake.goto).toHaveBeenCalledTimes(3);
    expect(wake.evaluate).toHaveBeenCalledTimes(2);
    expect(wake.close).toHaveBeenCalledOnce();
  });

  it("reports unrelated handshake failures", async () => {
    const { context, worker, wake } = setup();
    wake.evaluate.mockRejectedValueOnce(new Error("message failed"));

    await expect(reloadDevelopmentExtension(
      context as unknown as BrowserContext,
      worker as unknown as Worker,
    )).rejects.toThrow("message failed");
    expect(wake.evaluate).toHaveBeenCalledOnce();
    expect(wake.close).toHaveBeenCalledOnce();
  });
});
