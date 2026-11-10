import { defineConfig } from "vitest/config";

// Real Chrome tests are opt-in; ordinary unit checks never launch a browser.
export default defineConfig({
  test: { environment: "node", include: ["src/standalone/**/*.test.ts"] },
});
