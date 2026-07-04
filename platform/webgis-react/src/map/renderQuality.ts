import * as Cesium from "cesium";
import type { RenderQuality } from "../stores/uiStore";

/**
 * 把 RenderQuality 应用到 Cesium Viewer。三档差异:
 *
 *   standard (标清)  -- 浏览器推荐 DPR,resolutionScale ≤ 1.0,默认 SSE,无 MSAA
 *   hd       (高清)  -- DPR 全量(最高 2.0),FXAA,SSE 略降到 1.5
 *   ultra    (超清)  -- DPR ×1.5(最高 3.0),MSAA 4×,FXAA,SSE 降到 1.0,
 *                      影像 mag/min Filter 改 LINEAR(更柔和的放大),
 *                      最大瓦片缓存数提高,关键: 减小 maximumScreenSpaceError
 *                      让 Cesium 主动加载更高 zoom 的瓦片。
 */
export function applyRenderQuality(viewer: Cesium.Viewer, q: RenderQuality): void {
  const dpr = window.devicePixelRatio || 1;

  switch (q) {
    case "standard":
      viewer.useBrowserRecommendedResolution = true;
      viewer.resolutionScale = 1.0;
      viewer.scene.postProcessStages.fxaa.enabled = false;
      viewer.scene.msaaSamples = 1;
      viewer.scene.globe.maximumScreenSpaceError = 2;
      break;

    case "hd":
      viewer.useBrowserRecommendedResolution = false;
      viewer.resolutionScale = Math.min(dpr, 2.0);
      viewer.scene.postProcessStages.fxaa.enabled = true;
      viewer.scene.msaaSamples = 1;
      viewer.scene.globe.maximumScreenSpaceError = 1.5;
      break;

    case "ultra":
      viewer.useBrowserRecommendedResolution = false;
      // 即使 DPR=1 也强制提到 1.5 倍超采样
      viewer.resolutionScale = Math.min(Math.max(dpr * 1.5, 1.5), 3.0);
      viewer.scene.postProcessStages.fxaa.enabled = true;
      // MSAA 对底图条带 / 边界线 / 文字描边都有显著提升
      viewer.scene.msaaSamples = 4;
      // 让 Cesium 主动请求更高 zoom 级的影像瓦片(2 -> 1 让画面更细)
      viewer.scene.globe.maximumScreenSpaceError = 1.0;
      // 影像层 magnification 用 LINEAR,放大时不锐化锯齿
      try {
        const Mag = (Cesium as unknown as { TextureMagnificationFilter?: { LINEAR: number } })
          .TextureMagnificationFilter;
        const Min = (Cesium as unknown as { TextureMinificationFilter?: { LINEAR: number } })
          .TextureMinificationFilter;
        for (let i = 0; i < viewer.imageryLayers.length; i++) {
          const layer = viewer.imageryLayers.get(i) as unknown as {
            magnificationFilter?: number;
            minificationFilter?: number;
          };
          if (!layer) continue;
          if (Mag) layer.magnificationFilter = Mag.LINEAR;
          if (Min) layer.minificationFilter = Min.LINEAR;
        }
      } catch {
        /* ignore */
      }
      break;
  }
  viewer.scene.requestRender();
}
