import type { Page } from "@playwright/test";

/** Controlled fixtures only: a paint contribution is not proof of a readable
 * name. This deliberately never runs against a user's live document. */
export async function probeTextPaint(page: Page, decoder: Page, selector: string) {
  const target = page.locator(selector);
  if (await target.count() !== 1) throw new Error("Paint probe requires one fixture target");
  const original = await target.evaluate((element) => {
    if (element.childElementCount || !element.textContent?.trim())
      throw new Error("Paint probe requires a leaf containing fixture text");
    return element.getAttribute("style");
  });
  const geometry = () => page.evaluate(() => JSON.stringify({
    viewport: [innerWidth, innerHeight, scrollX, scrollY, devicePixelRatio],
    boxes: Array.from(document.querySelectorAll("*"), (element) =>
      Array.from(element.getClientRects(), (r) => [r.x, r.y, r.width, r.height])),
  }));
  const fingerprint = async () => {
    const png = await page.screenshot({ type: "png", animations: "allow", caret: "initial", scale: "css" });
    return decoder.evaluate(async (data) => {
      const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      try {
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), context = canvas.getContext("2d")!;
        context.drawImage(bitmap, 0, 0);
        const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
        const digest = await crypto.subtle.digest("SHA-256", pixels);
        return { width: bitmap.width, height: bitmap.height,
          hash: Array.from(new Uint8Array(digest), (v) => v.toString(16).padStart(2, "0")).join("") };
      } finally { bitmap.close(); }
    }, png.toString("base64"));
  };
  const beforeGeometry = await geometry(), before = await fingerprint(), repeated = await fingerprint();
  if (JSON.stringify(before) !== JSON.stringify(repeated)) return { status: "unstable" as const, before, repeated };
  let suppressed: Awaited<ReturnType<typeof fingerprint>>, suppressedGeometry: string;
  try {
    // Preserve DOM structure and layout. The fixture deliberately has no
    // author script; even this reversible style change is unsafe as a
    // general read-only observation technique on a live website.
    await target.evaluate((element) => (element as HTMLElement).style.setProperty("visibility", "hidden", "important"));
    suppressedGeometry = await geometry();
    suppressed = await fingerprint();
  } finally {
    await target.evaluate((element, original) => {
      if (original === null) element.removeAttribute("style");
      else element.setAttribute("style", original);
    }, original);
  }
  const restored = await fingerprint(), restoredGeometry = await geometry();
  if (beforeGeometry !== restoredGeometry || JSON.stringify(before) !== JSON.stringify(restored))
    return { status: "restore-mismatch" as const, before, suppressed, restored };
  if (beforeGeometry !== suppressedGeometry) return { status: "layout-changed" as const, before, suppressed, restored };
  return { status: "stable" as const, changed: JSON.stringify(before) !== JSON.stringify(suppressed), before, suppressed, restored };
}
