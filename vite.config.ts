import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { crx } from "@crxjs/vite-plugin";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import manifest from "./public/manifest.json" with { type: "json" };

const projectRoot = fileURLToPath(new URL(".", import.meta.url));

const devManifest = {
  ...manifest,
  background: {
    ...manifest.background,
    service_worker: "src/background.ts",
  },
};

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    crx({ manifest: devManifest }),
  ],
  resolve: {
    alias: {
      "@": resolve(projectRoot, "src"),
    },
  },
  server: {
    host: "localhost",
    port: 5173,
    strictPort: true,
    cors: {
      origin: [/chrome-extension:\/\//],
    },
    ws: {
      host: "localhost",
      clientPort: 5173,
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
