import { expect, test } from "@playwright/test";
import { userscriptFixture } from "./userscript-level-fixture";
import { verifyUserScript } from "./userscript-verification";

test("the independent cross-origin verification distinguishes execution from a no-op", async ({ browser }) => {
  const fixture = await userscriptFixture(17);
  const noScript = await browser.newContext(), working = await browser.newContext();
  try {
    const before = fixture.evidence();
    const missing = fixture.createVerification();
    expect(await verifyUserScript(noScript, missing)).toBe(false);
    await working.addInitScript(() => {
      if (!location.pathname.startsWith("/record/__verify/")) return;
      addEventListener("DOMContentLoaded", () => { document.documentElement.dataset.stamp = document.body.dataset.expectedStamp; });
    });
    const valid = fixture.createVerification();
    expect(valid.frameUrl).not.toBe(missing.frameUrl);
    expect(valid.expectedStamp).not.toBe(missing.expectedStamp);
    expect(await verifyUserScript(working, valid)).toBe(true);
    expect(await verifyUserScript(working, { ...fixture.createVerification(), frameUrl: "http://localhost:1/missing" })).toBeNull();
    expect(fixture.evidence()).toEqual(before);
  } finally {
    await Promise.all([noScript.close(), working.close()]);
    fixture.server.closeAllConnections();
    await new Promise<void>((resolve, reject) => fixture.server.close((error) => error ? reject(error) : resolve()));
  }
});
