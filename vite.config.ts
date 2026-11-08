import { defineConfig } from "vite";
import { wgslVitePlugin } from "@vgpu/wgsl/loader-vite";

export default defineConfig({
  plugins: [wgslVitePlugin()],
  build: { outDir: "dist", target: "es2022", chunkSizeWarningLimit: 1200 },
  server: {
    // `npm run dev` serves the client only; the API lives in `wrangler dev`.
    proxy: { "/api": "http://localhost:8787", "/auth": "http://localhost:8787" },
  },
});
