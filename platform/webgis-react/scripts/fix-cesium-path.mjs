// Post-build fix: vite-plugin-cesium 在 base="/app/" 下会把 Cesium 静态资源
// 复制到 dist/app/cesium/,但 index.html 引用的是 /app/cesium/...,而我们把
// dist/ 整个挂载到 /app/,因此真实查找路径是 dist/cesium/...
//
// 这里把 dist/app/cesium/ 移动到 dist/cesium/ 让 URL 与磁盘对齐。
import { cpSync, existsSync, renameSync, rmSync, readdirSync } from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/+([A-Za-z]:)/, "$1")), "..");
const distDir = path.join(root, "dist");
const wrongDir = path.join(distDir, "app", "cesium");
const rightDir = path.join(distDir, "cesium");

if (!existsSync(wrongDir)) {
  console.log("[fix-cesium-path] no dist/app/cesium found, nothing to do");
  process.exit(0);
}

if (existsSync(rightDir)) {
  rmSync(rightDir, { recursive: true, force: true });
}

try {
  renameSync(wrongDir, rightDir);
  console.log(`[fix-cesium-path] moved ${wrongDir} -> ${rightDir}`);
} catch (error) {
  console.warn(`[fix-cesium-path] rename failed (${error.code}); copying instead`);
  cpSync(wrongDir, rightDir, { recursive: true });
  rmSync(wrongDir, { recursive: true, force: true });
  console.log(`[fix-cesium-path] copied ${wrongDir} -> ${rightDir}`);
}

// Clean up empty dist/app folder if it's now empty.
const appDir = path.join(distDir, "app");
try {
  if (existsSync(appDir) && readdirSync(appDir).length === 0) {
    rmSync(appDir, { recursive: true, force: true });
    console.log(`[fix-cesium-path] removed empty ${appDir}`);
  }
} catch {
  /* ignore */
}
