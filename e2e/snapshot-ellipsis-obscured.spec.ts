import { expect } from "@playwright/test";
import { test, commandResponse, configure, dispose, openExtension, startProvider, textResponse } from "./fixtures";

function lastTool(request: any): any {
  const message = request.messages.findLast((entry: any) => entry.role === "tool");
  const content = Array.isArray(message.content) ? message.content.find((part: any) => part.type === "text")?.text : message.content;
  return JSON.parse(content);
}

for (const kind of ["backdrop", "border-image", "marker"] as const) {
  test(`does not expose an unproven ellipsis prefix obscured by ${kind}`, async () => {
    test.setTimeout(90_000);
    const responses: any[] = [], provider = await startProvider(responses), opened = await openExtension();
    let snapshot: any;
    try {
      const target = await opened.context.newPage();
      await target.goto(`${provider.origin}/target`);
      await target.evaluate(() => {
        document.body.innerHTML = `<style>body { margin: 0; }
          #queue { position: absolute; left: 20px; top: 20px; display: block; width: 110px; height: 25px;
            overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font: 13.3333px Arial; }
        </style><button id="queue" aria-label="UNPAINTED_ACCESSIBLE_NAME">Next TASK-746F9DB6E6FB</button>`;
      });
      const button = target.locator("#queue"), unobscured = await button.screenshot();
      await button.evaluate((element) => { element.style.color = "transparent"; });
      const unobscuredWithoutText = await button.screenshot();
      await button.evaluate((element) => { element.style.color = ""; });
      await target.evaluate((effect) => {
        const style = document.createElement("style");
        const overlay = document.createElement(effect === "marker" ? "li" : "div");
        overlay.id = "occluder";
        if (effect === "backdrop") {
          style.textContent = `#occluder { position: fixed; inset: 200px auto auto 400px; margin: 0; width: 10px; height: 10px; }
            #occluder::backdrop { background: white; pointer-events: none; }`;
          overlay.setAttribute("popover", "manual");
        } else if (effect === "border-image") {
          style.textContent = `#occluder { position: absolute; left: 175px; top: 20px; width: 10px; height: 10px;
            border: 1px solid transparent; border-image-source: linear-gradient(white, white);
            border-image-slice: 1; border-image-width: 100px; border-image-outset: 100px; pointer-events: none; }`;
        } else {
          style.textContent = `#occluder { position: absolute; left: 175px; top: 20px; width: 10px; height: 20px;
            list-style-type: none; pointer-events: none; } #occluder::marker { content: 'XXXXXXXXXXXXXXXX'; font: 20px Arial; color: white; }`;
        }
        document.head.append(style);
        document.body.append(overlay);
        if (effect === "backdrop") overlay.showPopover();
      }, kind);
      // The occluder's own box is remote; only its out-of-box paint reaches the button.
      const buttonBox = (await button.boundingBox())!, overlayBox = (await target.locator("#occluder").boundingBox())!;
      expect(overlayBox.x).toBeGreaterThan(buttonBox.x + buttonBox.width);
      const obscured = await button.screenshot();
      await button.evaluate((element) => { element.style.color = "transparent"; });
      const obscuredWithoutText = await button.screenshot();
      await button.evaluate((element) => { element.style.color = ""; });
      // Compare actual text pixels, not just any screenshot difference such as a border.
      const coveredTextPixels = await target.evaluate(async (images) => {
        const canvas = document.createElement("canvas"), context = canvas.getContext("2d")!;
        const pixels = await Promise.all(images.map(async (src) => {
          const image = new Image(); image.src = `data:image/png;base64,${src}`; await image.decode();
          canvas.width = image.width; canvas.height = image.height; context.drawImage(image, 0, 0);
          return context.getImageData(0, 0, image.width, image.height).data;
        }));
        let covered = 0;
        for (let i = 0; i < pixels[0].length; i += 4) {
          const distance = (a: Uint8ClampedArray, b: Uint8ClampedArray) =>
            Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
          if (distance(pixels[0], pixels[1]) > 30 && distance(pixels[2], pixels[3]) < 3) covered++;
        }
        return covered;
      }, [unobscured, unobscuredWithoutText, obscured, obscuredWithoutText].map((image) => image.toString("base64")));
      expect(coveredTextPixels).toBeGreaterThan(0);
      responses.push(commandResponse("inspect_page", { budget: 12000 }, `obscured-${kind}`), (request: any) => {
        snapshot = lastTool(request);
        return textResponse("OBSCURED_DONE");
      }, textResponse("Inspect the page"));
      await (await configure(opened.context, opened.page, provider.baseURL)).close();
      await target.bringToFront();
      await opened.page.getByTestId("composer-input").fill("Inspect the page");
      await opened.page.getByTestId("composer-input").press("Enter");
      await expect(opened.page.locator(".markdown-body").last()).toContainText("OBSCURED_DONE", { timeout: 60_000 });
      expect(snapshot).toMatchObject({ mode: "full", items: expect.any(Array) });
      const buttonRow = snapshot.items.find((item: any) => /\bbutton(?:\s|$)/.test(item.line));
      expect(buttonRow?.line).toContain("[name=unknown]");
      expect(JSON.stringify(snapshot.items)).not.toContain("Next TASK-7");
      expect(JSON.stringify(snapshot.items)).not.toContain("UNPAINTED_ACCESSIBLE_NAME");
    } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
  });
}
