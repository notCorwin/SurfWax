import { access } from "node:fs/promises";
import { join } from "node:path";
import { startDevelopmentExtension } from "../scripts/development-extension.mjs";

/** Direct Playwright/evaluation commands use the same dev flow as npm test:e2e. */
export default async function setup() {
  const existing = process.env.SURFWAX_DEV_SERVER_URL;
  if (existing) {
    const extensionPath = process.env.SURFWAX_EXTENSION_PATH;
    if (!extensionPath) throw new Error("SURFWAX_DEV_SERVER_URL requires the matching SURFWAX_EXTENSION_PATH.");
    await access(join(extensionPath, "manifest.json"));
    const response = await fetch(`${existing}/@vite/client`, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error("The shared development extension server is unavailable; restart the browser test command.");
    return;
  }
  const development = await startDevelopmentExtension();
  process.env.SURFWAX_EXTENSION_PATH = development.extensionPath;
  process.env.SURFWAX_DEV_SERVER_URL = development.url;
  return () => development.close();
}
