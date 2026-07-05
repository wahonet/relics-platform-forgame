import { useEffect, useRef } from "react";
import * as Cesium from "cesium";
import { setViewer } from "./viewerRegistry";
import { useUIStore } from "../stores/uiStore";
import { applyRenderQuality, watchDevicePixelRatio } from "./renderQuality";

let _initedToken = false;

export function useCesiumViewer(containerRef: React.RefObject<HTMLDivElement>) {
  const viewerRef = useRef<Cesium.Viewer | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const cfg = window.__PLATFORM_CONFIG;
    if (!_initedToken && cfg?.cesium_ion_token) {
      Cesium.Ion.defaultAccessToken = cfg.cesium_ion_token;
      _initedToken = true;
    }

    const viewer = new Cesium.Viewer(containerRef.current, {
      baseLayerPicker: false,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      animation: false,
      timeline: false,
      fullscreenButton: false,
      selectionIndicator: false,
      infoBox: false,
      baseLayer: false as unknown as Cesium.ImageryLayer,
      terrainProvider: new Cesium.EllipsoidTerrainProvider(),
      // 平台按二维地图使用,固定 2D 场景(北朝上,不可旋转/倾斜)
      sceneMode: Cesium.SceneMode.SCENE2D,
      mapMode2D: Cesium.MapMode2D.INFINITE_SCROLL,
      // 2D 场景默认是等经纬度投影,Web Mercator 瓦片(天地图/高德)会被纵向压扁,
      // 文字变形。显式指定 Web Mercator 让瓦片 1:1 呈现。
      mapProjection: new Cesium.WebMercatorProjection(),
    });

    viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString("#0d1117");
    viewer.scene.backgroundColor = Cesium.Color.fromCssColorString("#0d1117");
    viewer.scene.requestRenderMode = true;
    viewer.scene.maximumRenderTimeChange = 0.5;
    // 按已持久化的渲染质量初始化(MSAA / FXAA / resolutionScale / SSE 一并设置)
    try {
      applyRenderQuality(viewer, useUIStore.getState().renderQuality);
    } catch {
      // 兜底:即使应用失败也至少打开 FXAA,避免锯齿
      viewer.scene.postProcessStages.fxaa.enabled = true;
    }
    viewer.scene.fog.enabled = false;
    viewer.scene.globe.showGroundAtmosphere = false;
    if (viewer.scene.skyAtmosphere) {
      viewer.scene.skyAtmosphere.show = false;
    }

    const scc = viewer.scene.screenSpaceCameraController;
    // 2D 模式下滚轮缩放由 Cesium 默认处理(调整正交视锥),仅做范围钳制
    scc.minimumZoomDistance = 80;
    scc.maximumZoomDistance = 500_000;
    scc.enableTilt = false;
    scc.enableLook = false;

    // 注意:此时平台配置通常尚未拉取完成(cfg 为空),这里的兜底值只是首帧
    // 占位;MapView 会在配置加载完成后把相机校正到 config.geo.center。
    const center = cfg?.geo?.center;
    const startLng = center?.lng ?? 116.587;
    const startLat = center?.lat ?? 35.415;
    const startAlt = center?.alt ?? 220_000;
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(startLng, startLat, startAlt),
      duration: 0,
    });

    viewerRef.current = viewer;
    setViewer(viewer);

    // 窗口拖到不同 DPR 的屏幕(1K/2K/4K)或浏览器缩放时,按新 DPR 重设渲染分辨率
    const unwatchDpr = watchDevicePixelRatio(() => {
      try {
        applyRenderQuality(viewer, useUIStore.getState().renderQuality);
      } catch {
        /* ignore */
      }
    });

    return () => {
      unwatchDpr();
      try {
        setViewer(null);
        viewer.destroy();
      } catch {
        /* ignore */
      }
      viewerRef.current = null;
    };
  }, [containerRef]);

  return viewerRef;
}
