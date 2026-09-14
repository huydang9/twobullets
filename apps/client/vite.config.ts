import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5173,
  },
  optimizeDeps: {
    // Havok ships a .wasm file next to its JS; pre-bundling breaks the relative URL.
    exclude: ["@babylonjs/havok"],
  },
});
