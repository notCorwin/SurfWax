import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { crx } from "@crxjs/vite-plugin";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import storeManifest from "./manifests/store.json" with { type: "json" };
import enhancedManifest from "./manifests/enhanced.json" with { type: "json" };

const projectRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig(({ mode }) => {
  const manifest = mode === "enhanced" ? enhancedManifest : storeManifest;
  const devManifest = {
    ...manifest,
    background: { ...manifest.background, service_worker: "src/background.ts" },
  };
  return ({
  plugins: [
    react(),
    tailwindcss(),
    crx({ manifest: devManifest as any }),
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
    rollupOptions: { input: {
      userscripts: resolve(projectRoot, "userscripts.html"),
      offscreen: resolve(projectRoot, "offscreen.html"),
      devtools: resolve(projectRoot, "devtools.html"),
    } },
  },
  });
});
