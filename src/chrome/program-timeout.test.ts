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

  it("supports inclusive, descending, and unbraced nested loops", () => {
    expect(
      estimateProgramTimeoutMs(
        `for (let i = 0; i <= 60; i++) await sleep(1_000);`,
      ),
    ).toBe(91_000);
    expect(
      estimateProgramTimeoutMs(
        `for (let i = 10; i >= 0; i -= 2) await sleep(1_000);`,
      ),
    ).toBe(36_000);
    expect(
      estimateProgramTimeoutMs(
        `for (let i=0;i<10;i++) for (let j=0;j<10;j++) await sleep(1_000);`,
      ),
    ).toBe(130_000);
  });

  it("evaluates constant arithmetic in sleep durations", () => {
    expect(estimateProgramTimeoutMs(`await sleep(60 * 1_000);`)).toBe(90_000);
    expect(estimateProgramTimeoutMs(`await sleep((30 + 30) * 1_000);`)).toBe(
      90_000,
    );
  });

  it("preserves executable template interpolations", () => {
    expect(estimateProgramTimeoutMs("return `${await sleep(60_000)}`;")).toBe(
      90_000,
    );
  });

  it("handles deeply nested loops in linear traversal time", () => {
    const source = `${Array.from({ length: 30 }, (_, index) => `for (let i${index}=0;i${index}<1;i${index}++) `).join("")}await sleep(1_000);`;
    expect(estimateProgramTimeoutMs(source)).toBe(31_000);
  });

  it("charges local helpers at each statically identifiable invocation", () => {
    expect(
      estimateProgramTimeoutMs(`
        async function pause() { await sleep(25_000); }
        await pause(); await pause(); await pause();
      `),
    ).toBe(105_000);
    expect(
      estimateProgramTimeoutMs(`
        const act = async () => { await page.getByText("Ready").click(); };
        for (let i = 0; i < 3; i++) await act();
      `),
    ).toBe(45_000);
  });

  it("budgets member calls only when rooted in Surf Wax capabilities", () => {
    expect(
      estimateProgramTimeoutMs(`
        for (let i = 0; i < 100; i++) Array(10).fill(0);
        await new Promise(() => {});
      `),
    ).toBe(30_000);
    expect(
      estimateProgramTimeoutMs(`
        const button = page.getByRole("button");
        await button.fill("ready");
      `),
    ).toBe(35_000);
  });

  it("charges immediately invoked function bodies at the call site", () => {
    expect(
      estimateProgramTimeoutMs(
        `await (async () => { await sleep(60_000); })();`,
      ),
    ).toBe(90_000);
    expect(
      estimateProgramTimeoutMs(`(function () { return page.click(); })();`),
    ).toBe(35_000);
  });

  it("counts statically finite for-of literals", () => {
    expect(
      estimateProgramTimeoutMs(
        `for (const item of [1, 2, 3]) await sleep(20_000);`,
      ),
    ).toBe(90_000);
    expect(
      estimateProgramTimeoutMs(
        `for (const character of "abc") await sleep(1_000);`,
      ),
    ).toBe(33_000);
  });

  it("indexes every helper in a multi-declarator statement", () => {
    expect(
      estimateProgramTimeoutMs(`
        const noop = () => {}, pause = async () => { await sleep(60_000); };
        await pause();
      `),
    ).toBe(90_000);
  });

  it("resolves helpers in their nearest lexical scope", () => {
    expect(
      estimateProgramTimeoutMs(`
        function pause() { return sleep(60_000); }
        function unused() { function pause() {} }
        await pause();
      `),
    ).toBe(90_000);
    expect(
      estimateProgramTimeoutMs(`
        function pause() { return sleep(60_000); }
        function outer() { function pause() { return sleep(1_000); } return pause(); }
        await outer(); await pause();
      `),
    ).toBe(91_000);
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
