import { expect, test, type Page } from "@playwright/test";
import {
  cp,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { reloadDevelopmentExtension } from "../scripts/reload-dev-extension";
import {
  closeServer,
  configure,
  openExtension,
  startProvider,
  toolResponse,
} from "./fixtures";

async function pixelRange(page: Page): Promise<number> {
  const pixels: number[] = [];
  for (let index = 0; index < 12; index++) {
    const screenshot = await page.screenshot({
      clip: { x: 300, y: 300, width: 1, height: 1 },
    });
    pixels.push(
      await page.evaluate(async (data) => {
        const image = new Image();
        image.src = `data:image/png;base64,${data}`;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        const context = canvas.getContext("2d")!;
        context.drawImage(image, 0, 0);
        return context.getImageData(0, 0, 1, 1).data[0]!;
      }, screenshot.toString("base64")),
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return Math.max(...pixels) - Math.min(...pixels);
}

test("reloads updated development code instead of restoring the profile's stale page guard", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "surf-wax-dev-reload-"));
  const extension = resolve(directory, "extension");
  const profile = resolve(directory, "profile");
  await cp(resolve(process.env.SURFWAX_EXTENSION_PATH ?? "dist"), extension, {
    recursive: true,
  });
  // Install an earlier guard with a static tint, then update the files while
  // Chrome is closed. Both versions keep the same extension ID and version.
  const originals = await Promise.all(
    (await readdir(resolve(extension, "assets")))
      .filter((name) => name.endsWith(".js"))
      .map(async (name) => {
        const path = resolve(extension, "assets", name);
        const source = await readFile(path, "utf8");
        if (!source.includes("--guard-opacity-max:")) return null;
        await writeFile(
          path,
          source.replace(
            /--guard-opacity-(?:min|max|rest):\s*[\d.]+/g,
            (token) => token.replace(/[\d.]+$/, "0.04"),
          ),
        );
        return { path, source };
      }),
  );
  expect(originals.some(Boolean)).toBe(true);
  const provider = await startProvider(
    Array.from({ length: 3 }, () =>
      toolResponse("await new Promise(() => undefined);"),
    ),
  );
  let opened = await openExtension(profile, { extensionPath: extension });
  const begin = async (target: Page) => {
    await target.bringToFront();
    await opened.page
      .getByTestId("composer-input")
      .fill("keep the page guarded");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(target.locator("#__surf-wax-page-guard")).toBeAttached();
  };
  try {
    let target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    await target.emulateMedia({ reducedMotion: "no-preference" });
    await (
      await configure(opened.context, opened.page, provider.baseURL)
    ).close();
    await begin(target);
    expect(await pixelRange(target)).toBeLessThanOrEqual(1);
    await opened.context.close();

    await Promise.all(
      originals.map((file) => file && writeFile(file.path, file.source)),
    );
    opened = await openExtension(profile, { extensionPath: extension });
    target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    await target.emulateMedia({ reducedMotion: "no-preference" });
    await begin(target);
    // Restarting Chrome alone can preserve the old worker's static guard.
    expect(await pixelRange(target)).toBeLessThanOrEqual(1);

    await reloadDevelopmentExtension(
      opened.context,
      opened.context.serviceWorkers()[0]!,
    );
    await opened.page.close().catch(() => undefined);
    opened.page = await opened.context.newPage();
    await opened.page.goto(
      `chrome-extension://${opened.extensionId}/sidepanel.html`,
    );
    await begin(target);
    expect(await pixelRange(target)).toBeGreaterThan(20);
  } finally {
    await opened.context.close();
    await closeServer(provider.server);
    await rm(directory, { recursive: true, force: true });
  }
});
