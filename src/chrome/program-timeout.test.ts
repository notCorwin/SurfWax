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
});
