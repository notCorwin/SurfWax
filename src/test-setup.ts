import { afterEach, beforeEach, vi } from "vitest";
// Unit tests never depend on live catalog timing or another test's provider requests.
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === "https://models.dev/api.json") return new Response("{}", { headers: { "Content-Type": "application/json" } });
    throw new Error(`Unexpected unit-test network request: ${url}`);
  }));
});
afterEach(() => { vi.unstubAllGlobals(); });
