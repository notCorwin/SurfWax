import { existsSync } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

const root = process.cwd();
const extensionPath = resolve(root, "dist");
const profilePath = resolve(root, ".dev/chromium-profile");
const targetUrl = process.argv[2] ?? "https://example.com";
const port = 5173;
let context;
let vite;

function waitForPort() {
  return new Promise((resolveFree, reject) => {
    const probe = createNetServer();
    probe.once("error", (error) =>
      reject(
        error.code === "EADDRINUSE"
          ? new Error(
              `localhost:${port} 已被占用；请关闭已有的 Surf Wax 开发进程。`,
            )
          : error,
      ),
    );
    probe.listen(port, "localhost", () => probe.close(resolveFree));
  });
}

async function waitForFile(path, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
  }
  throw new Error(`等待开发构建超时：${path}`);
}

async function waitForWorker(timeoutMs = 30_000) {
  const existing = context.serviceWorkers()[0];
  if (existing) return existing;
  try {
    return await context.waitForEvent("serviceworker", { timeout: timeoutMs });
  } catch {
    throw new Error("等待扩展 Service Worker 超时。");
  }
}

async function enableUserScripts(extensionId) {
  const probe = await context.newPage();
  await probe.goto(`chrome-extension://${extensionId}/options.html`);
  if (await probe.evaluate(() => typeof chrome.userScripts === "object")) {
    await probe.close();
    return;
  }
  const settings = await context.newPage();
  await settings.goto(`chrome://extensions/?id=${extensionId}`);
  await settings
    .locator("extensions-toggle-row#allow-user-scripts cr-toggle#crToggle")
    .click();
  await probe.waitForFunction(() => typeof chrome.userScripts === "object");
  await Promise.all([settings.close(), probe.close()]);
}

async function main() {
  if (!URL.canParse(targetUrl)) throw new Error(`无效的目标 URL：${targetUrl}`);
  const executablePath = chromium.executablePath();
  if (!existsSync(executablePath))
    throw new Error(
      "缺少 Playwright Chromium；请运行：npx playwright install chromium",
    );

  await waitForPort();
  vite = await createServer();
  await vite.listen();
  vite.printUrls();
  await waitForFile(resolve(extensionPath, "manifest.json"));

  await mkdir(profilePath, { recursive: true });
  context = await chromium.launchPersistentContext(profilePath, {
    executablePath,
    headless: false,
    viewport: null,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });

  const worker = await waitForWorker();
  const extensionId = new URL(worker.url()).hostname;
  await enableUserScripts(extensionId);

  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(targetUrl);
  const browserSession = await context.browser().newBrowserCDPSession();
  const { targetInfos } = await browserSession.send("Target.getTargets", {
    filter: [{ type: "tab", exclude: false }, { exclude: true }],
  });
  const tab = targetInfos.find(
    (target) => target.type === "tab" && target.url === page.url(),
  );
  if (!tab) throw new Error(`无法找到目标标签页：${page.url()}`);
  const panelUrl = `chrome-extension://${extensionId}/sidepanel.html`;
  let reopening;

  const ensurePanel = async () => {
    if (reopening) return reopening;
    reopening = (async () => {
      const { targetInfos } = await browserSession.send("Target.getTargets");
      if (!targetInfos.some((target) => target.url.startsWith(panelUrl))) {
        await browserSession.send("Extensions.triggerAction", {
          id: extensionId,
          targetId: tab.targetId,
        });
      }
    })().finally(() => {
      reopening = undefined;
    });
    return reopening;
  };

  await ensurePanel();
  context.on("serviceworker", (nextWorker) => {
    if (new URL(nextWorker.url()).hostname === extensionId) {
      setTimeout(() => void ensurePanel().catch(console.error), 300);
    }
  });
  console.log(`\nSurf Wax 开发环境已就绪：${targetUrl}\n按 Ctrl+C 退出。`);

  await new Promise((resolveStop) => {
    process.once("SIGINT", resolveStop);
    process.once("SIGTERM", resolveStop);
    context.once("close", resolveStop);
  });
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await context?.close().catch(() => undefined);
  await vite?.close().catch(() => undefined);
}
