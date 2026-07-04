import { useEffect, useRef } from "react";
import * as Cesium from "cesium";
import { setViewer } from "./viewerRegistry";
import { useUIStore } from "../stores/uiStore";
import { applyRenderQuality } from "./renderQuality";

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
    scc.minimumZoomDistance = 10;
    scc.maximumZoomDistance = 500_000;
    scc.enableTilt = false;
    scc.enableLook = false;
    scc.zoomEventTypes = [];

    const center = cfg?.geo?.center;
    const startLng = center?.lng ?? 116.34;
    const startLat = center?.lat ?? 35.41;
    const startAlt = center?.alt ?? 75_000;
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(startLng, startLat, startAlt),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-90), roll: 0 },
      duration: 0,
    });

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const cam = viewer.camera;
      const h = cam.positionCartographic.height;
      const factor = e.deltaY > 0 ? 1.08 : 0.93;
      const newH = Math.max(80, Math.min(500_000, h * factor));
      cam.moveForward(h - newH);
    };
    viewer.scene.canvas.addEventListener("wheel", onWheel, { passive: false });

    viewerRef.current = viewer;
    setViewer(viewer);

    return () => {
      try {
        viewer.scene.canvas.removeEventListener("wheel", onWheel);
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
