import { execFileSync, spawnSync } from "node:child_process";

const node = process.execPath;
const executablePath = execFileSync(node, ["scripts/install-test-browser.mjs", "current"], { encoding: "utf8" }).trim();
if (!executablePath) throw new Error("Current Chrome for Testing path was not returned");
const result = spawnSync(node, ["node_modules/@playwright/test/cli.js", "test", ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { ...process.env, SURFWAX_CHROME_PATH: executablePath },
});
if (result.error || result.status !== 0) throw result.error ?? new Error(`Playwright failed (${result.status})`);
