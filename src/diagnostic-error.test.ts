import { describe, expect, it } from "vitest";
import { safeDiagnosticError, safeDiagnosticText } from "./diagnostic-error";

describe("diagnostic error sanitization", () => {
  it("preserves location and causes while excluding credentials from messages and stacks", () => {
    const cause = new Error('request https://user:pass@example.test/path?api_key=topsecret failed');
    const outer = new Error('Authorization: Bearer abc123 at browser.send', { cause });
    outer.stack = 'at browser.send (https://user:pass@example.test/path?token=topsecret) Authorization: Bearer abc123';
    const safe = safeDiagnosticError(new AggregateError([outer], "cleanup failed", { cause: outer }));
    const encoded = JSON.stringify(safe, Object.getOwnPropertyNames(safe).concat(["name", "message", "stack", "cause", "errors"]));
    expect(encoded).not.toMatch(/abc123|topsecret|user:pass/);
    expect(encoded).toContain("browser.send");
    expect(encoded).toContain("cleanup failed");
    expect((safe as Error & { errors: Error[] }).errors[0]?.cause).toMatchObject({ message: expect.stringContaining("example.test/path") });
  });

  it("bounds text and omits cyclic or overly deep causes", () => {
    const cyclic = new Error("password=hidden " + "x".repeat(10000));
    cyclic.cause = cyclic;
    const safe = safeDiagnosticError(cyclic);
    expect(safe.message).not.toContain("hidden");
    expect(safe.message.length).toBeLessThanOrEqual(8192);
    expect((safe.cause as Error).message).toBe("[error cause omitted]");
    expect(safeDiagnosticText('{"apiKey":"secret-value"}')).not.toContain("secret-value");
  });
});
