import { defineConfig } from "vite";

/**
 * Vite config tuned for Tauri (fixed dev port, no auto-clearing of the screen
 * so Tauri's logs stay visible). The build output in `dist/` is what Tauri
 * bundles as the webview frontend, and is also what the engine server can serve
 * directly (LOOPWRIGHT_STATIC_DIR) for a browser-only, no-toolchain experience.
 */
export default defineConfig({
  // Relative base so the bundle works both from Tauri (asset protocol) and when
  // served at the root by the engine server.
  base: "./",
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    target: "es2022",
    emptyOutDir: true,
  },
});
