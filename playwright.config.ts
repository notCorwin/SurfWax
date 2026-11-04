import { defineConfig } from "@playwright/test";
import { systemChromePath } from "./scripts/development-extension.mjs";

// Validate at launch so evaluation can record a setup_failed receipt.
const executablePath = systemChromePath(process.env, process.platform, false);
// A few paint/geometry tests launch Chrome directly instead of using a fixture.
process.env.SURFWAX_CHROME_PATH = executablePath;
export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/development-setup.ts",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]],
  expect: { timeout: 15_000 },
  projects: [{ name: "current", use: { launchOptions: { executablePath } } }],
  use: { channel: "chrome", headless: true, trace: "retain-on-failure", screenshot: "only-on-failure" },
});
