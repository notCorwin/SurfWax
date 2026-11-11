import { defineConfig } from "vite";
import { thirdPartyLicenses } from "./scripts/third-party-licenses.mjs";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { crx } from "@crxjs/vite-plugin";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
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
  cacheDir: resolve(projectRoot, ".dev/vite-cache"),
  define: {
    __SURF_WAX_DEV_SERVER__: JSON.stringify(`http://localhost:${devPort}`),
    // AI SDK's gateway error handler probes process without a typeof guard.
    // Preserve browser runtime detection while making that probe safe.
    process: "globalThis.process",
  },
  plugins: [
    {
      name: "surf-wax-katex-woff2",
      enforce: "pre",
      load(id) {
        if (!/\/katex\/dist\/katex(?:\.min)?\.css$/.test(id)) return;
        // W3C WOFF2 implementation report lists Chrome 36+ support.
        // https://www.w3.org/Fonts/WG/WOFF2/Implementation.html
        // Chrome 138+ supports WOFF2. Prune fallback URLs before Vite discovers
        // assets, retaining every upstream face and all other KaTeX styles.
        return readFileSync(id, "utf8").replace(/src:([^;}]+)/g, (_declaration, sources: string) => {
          const woff2 = sources.split(",").filter(source => /format\(["']?woff2["']?\)/.test(source));
          if (woff2.length !== 1) throw new Error("Expected one WOFF2 source per KaTeX font face; review the updated stylesheet");
          return `src:${woff2[0]}`;
        });
      },
    },
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
    crx({ manifest: devManifest as any }),
    {
      name: "surf-wax-project-license",
      apply: "build",
      generateBundle() {
        this.emitFile({ type: "asset", fileName: "LICENSE", source: readFileSync(resolve(projectRoot, "LICENSE")) });
      },
    },
    thirdPartyLicenses(),
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
    watch: { ignored: ["**/.dev/**", "**/playwright-report/**", "**/test-results/**"] },
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
    rollupOptions: { input: {
      userscripts: resolve(projectRoot, "userscripts.html"),
      programSandbox: resolve(projectRoot, "program-sandbox.html"),
    } },
  },
});
