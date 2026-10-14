import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { crx } from "@crxjs/vite-plugin";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import manifest from "./manifests/store.json" with { type: "json" };
import packageMetadata from "./package.json" with { type: "json" };

const projectRoot = fileURLToPath(new URL(".", import.meta.url));

const buildManifest = {
  ...manifest,
  version: packageMetadata.version,
  background: { ...manifest.background, service_worker: "src/background.ts" },
};

const devManifest = {
  ...buildManifest,
  // CRXJS serves extension pages through localhost in development. A manifest
  // sandbox has an opaque `null` origin, so its loader needs explicit access
  // to the Vite HTTP and HMR endpoints. The store manifest remains locked down.
  content_security_policy: {
    ...manifest.content_security_policy,
    sandbox: "sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-eval' blob:; worker-src blob:; child-src blob:; connect-src http://localhost:5173 ws://localhost:5173;",
  },
};

export default defineConfig(({ command }) => ({
  plugins: [
    react(),
    tailwindcss(),
    crx({ manifest: (command === "serve" ? devManifest : buildManifest) as any,
      // document_start must install capture listeners synchronously, before
      // website scripts. A module loader's dynamic import loses that order.
      contentScripts: { standaloneFiles: ["src/chrome/guard-content.ts"] },
    }),
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
    watch: { ignored: ["**/.dev/check-dist/**"] },
    cors: {
      // Sandboxed extension pages use an opaque origin serialized as `null`.
      origin: [/chrome-extension:\/\//, /^null$/],
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
      programSandbox: resolve(projectRoot, "program-sandbox.html"),
    } },
  },
}));
