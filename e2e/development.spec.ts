import { expect } from "@playwright/test";
import {
  mkdtemp,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createServer as createViteServer } from "vite";
import { test,
  closeServer,
  configure,
  openExtension,
  startProvider,
  textResponse,
  toolResponse,
} from "./fixtures";

test("executes a sandbox program without crashing the live development extension", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "surf-wax-live-dev-"));
  const extension = resolve(directory, "extension");
  const previousPort = process.env.SURFWAX_DEV_PORT;
  const previousOutput = process.env.SURFWAX_DEV_OUT_DIR;
  process.env.SURFWAX_DEV_PORT = "5273";
  process.env.SURFWAX_DEV_OUT_DIR = extension;
  const responses: Parameters<typeof startProvider>[0] = [];
  const provider = await startProvider(responses);
  const targetUrl = `${provider.origin}/target`;
  responses.push(toolResponse(`let blocked=false; try { await fetch(${JSON.stringify(targetUrl)}); } catch { blocked=true; }
await check(blocked, "development program worker must not bypass mediated network capabilities");
await page.goto(${JSON.stringify(targetUrl)}); return await page.title();`), textResponse("DEV_SANDBOX_OK"));
  const vite = await createViteServer();
  let opened: Awaited<ReturnType<typeof openExtension>> | undefined;
  try {
    await vite.listen();
    await expect.poll(async () => readFile(resolve(extension, "manifest.json"), "utf8").then(() => true, () => false)).toBe(true);
    opened = await openExtension(undefined, { extensionPath: extension });
    const target = await opened.context.newPage();
    await target.goto(targetUrl);
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    await opened.page.getByTestId("composer-input").fill("run through the development sandbox");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("DEV_SANDBOX_OK");
    await expect.poll(() => opened!.context.serviceWorkers().length).toBe(1);
  } finally {
    await opened?.context.close().catch(() => undefined);
    if (opened) await rm(opened.userDataDirectory, { recursive: true, force: true });
    await vite.close().catch(() => undefined);
    await closeServer(provider.server);
    await rm(directory, { recursive: true, force: true });
    if (previousPort === undefined) delete process.env.SURFWAX_DEV_PORT; else process.env.SURFWAX_DEV_PORT = previousPort;
    if (previousOutput === undefined) delete process.env.SURFWAX_DEV_OUT_DIR; else process.env.SURFWAX_DEV_OUT_DIR = previousOutput;
  }
});
