import { defineConfig } from "@playwright/test";

const chrome138 = process.env.SURFWAX_CHROME_138_PATH;
const current = process.env.SURFWAX_CHROME_PATH;
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]],
  expect: { timeout: 15_000 },
  ...(chrome138 ? { projects: [
    { name: "chrome138", use: { launchOptions: { executablePath: chrome138 } } },
    { name: "current", use: { launchOptions: { executablePath: current } } },
  ] } : {}),
  use: { headless: true, trace: "retain-on-failure", screenshot: "only-on-failure" },
});
