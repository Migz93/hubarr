import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import packageJson from "./package.json";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __APP_VERSION__: JSON.stringify(packageJson.version)
  },
  root: ".",
  build: {
    outDir: "dist/client",
    emptyOutDir: true
  },
  resolve: {
    alias: {
      "@client": path.resolve(__dirname, "src/client"),
      "@shared": path.resolve(__dirname, "src/shared")
    }
  },
  server: {
    port: 4173,
    host: "0.0.0.0"
  }
});
