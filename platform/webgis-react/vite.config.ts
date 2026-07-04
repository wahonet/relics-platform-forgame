import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import cesium from "vite-plugin-cesium";
import path from "node:path";

const BACKEND = "http://127.0.0.1:8000";

export default defineConfig(({ command }) => ({
  base: command === "build" ? "/app/" : "/",
  plugins: [react(), cesium({ rebuildCesium: false })],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5174,
    proxy: {
      "/api": { target: BACKEND, changeOrigin: true },
      "/tiles": { target: BACKEND, changeOrigin: true },
      "/photos": { target: BACKEND, changeOrigin: true },
      "/drawings": { target: BACKEND, changeOrigin: true },
      "/boundaries": { target: BACKEND, changeOrigin: true },
      "/3d": { target: BACKEND, changeOrigin: true },
      "/archive-docs": { target: BACKEND, changeOrigin: true },
      "/patrol-photos": { target: BACKEND, changeOrigin: true },
      "/m": { target: BACKEND, changeOrigin: true },
      "/static": { target: BACKEND, changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ["react", "react-dom", "react-router-dom"],
          three: ["three", "@react-three/fiber", "@react-three/drei", "3d-tiles-renderer"],
          echarts: ["echarts", "echarts-for-react"],
          pdf: ["pdfjs-dist"],
        },
      },
    },
  },
}));
