import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { crx } from "@crxjs/vite-plugin";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import manifest from "./manifests/store.json" with { type: "json" };
import packageMetadata from "./package.json" with { type: "json" };

const projectRoot = fileURLToPath(new URL(".", import.meta.url));
const devPort = Number(process.env.SURFWAX_DEV_PORT ?? 5173);
const outDir = process.env.SURFWAX_DEV_OUT_DIR ?? "dist";

const devManifest = {
  ...manifest,
  version: packageMetadata.version,
  background: { ...manifest.background, service_worker: "src/background.ts" },
};

export default defineConfig({
  define: {
    __SURF_WAX_DEV_SERVER__: JSON.stringify(`http://localhost:${devPort}`),
  },
  plugins: [
    {
      name: "surf-wax-development-sandbox",
      configureServer(server) {
        // Bypass CRXJS's extension-page HTML wrapper. This endpoint runs in a
        // separate localhost renderer and loads only the disposable sandbox.
        server.middlewares.use((request, response, next) => {
          if (new URL(request.url ?? "/", `http://localhost:${devPort}`).pathname !== "/@surf-wax/program-sandbox") return next();
          response.statusCode = 200;
          response.setHeader("Content-Type", "text/html; charset=utf-8");
          response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self' 'unsafe-eval' blob:; worker-src blob:; child-src blob:; connect-src 'none';");
          response.end('<!doctype html><html><head><meta charset="UTF-8"><title>Surf Wax development program host</title></head><body><script type="module" src="/src/chrome/program-sandbox.ts"></script></body></html>');
        });
      },
    },
    react(),
    tailwindcss(),
    crx({ manifest: devManifest as any,
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
    port: devPort,
    strictPort: true,
    watch: { ignored: ["**/.dev/check-dist/**"] },
    cors: {
      origin: [/chrome-extension:\/\//],
    },
    ws: {
      host: "localhost",
      clientPort: devPort,
    },
  },
  build: {
    outDir,
    emptyOutDir: true,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      input: {
        userscripts: resolve(projectRoot, "userscripts.html"),
        programSandbox: resolve(projectRoot, "program-sandbox.html"),
      },
    },
  },
});
