import { describe, expect, it } from "vitest";
import { estimateProgramTimeoutMs } from "./program-timeout";

describe("program timeout estimation", () => {
  it("always gives arbitrary computation a finite baseline", () => {
    expect(estimateProgramTimeoutMs("while (true) {}")).toBe(30_000);
  });

  it("adds headroom for each browser operation and literal sleep", () => {
    expect(
      estimateProgramTimeoutMs(`
      await page.goto("https://example.com");
      await page.getByLabel("Email").fill("a@example.com");
      await sleep(12_500);
      return await page.inspect();
    `),
    ).toBe(64_500);
  });

  it("caps only automatically derived deadlines", () => {
    expect(estimateProgramTimeoutMs("await sleep(999999999)")).toBe(600_000);
  });

  it("budgets locator waits like the other supported waits", () => {
    expect(
      estimateProgramTimeoutMs(
        `await page.getByText("Ready").waitFor({ state: "visible" })`,
      ),
    ).toBe(45_000);
  });

  it("multiplies known work in statically bounded loops", () => {
    expect(
      estimateProgramTimeoutMs(
        `for (let i = 0; i < 60; i++) await sleep(1_000);`,
      ),
    ).toBe(90_000);
    expect(
      estimateProgramTimeoutMs(
        `for (let i = 2; i < 8; i += 2) { await page.click(); }`,
      ),
    ).toBe(45_000);
    expect(
      estimateProgramTimeoutMs(
        `for (let i = 0; i < 2; i++) { for (let j = 0; j < 3; j++) await page.click(); }`,
      ),
    ).toBe(60_000);
  });

  it("ignores method-like text in comments, strings, and embedded scripts", () => {
    expect(
      estimateProgramTimeoutMs(`
        // await page.waitFor(); await sleep(500000);
        const example = "page.goto(); page.click();";
        await page.evaluate("page.hover(); sleep(500000)");
      `),
    ).toBe(40_000);
  });

  it("budgets every actionable locator operation including hover", () => {
    expect(
      estimateProgramTimeoutMs(`
        await page.getByText("First").hover();
        await page.getByText("Second").point();
        await page.getByText("Third").drop();
      `),
    ).toBe(45_000);
  });
});
