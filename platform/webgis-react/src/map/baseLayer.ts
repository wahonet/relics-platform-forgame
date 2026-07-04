import * as Cesium from "cesium";
import type { BaseLayerType } from "../types";

const OFFLINE_ONLY_BASES = new Set<BaseLayerType>(["arcgis_sat", "osm"]);

const ONLINE_BASE_LAYOUT: Partial<
  Record<BaseLayerType, { base: BaseLayerType; overlay: BaseLayerType | null }>
> = {
  gaode_sat: { base: "gaode_sat", overlay: "gaode_anno" },
  gaode_vec: { base: "gaode_vec", overlay: null },
};

function buildTileUrl(type: BaseLayerType, opts?: { bust?: boolean }) {
  const params: string[] = [];
  if (OFFLINE_ONLY_BASES.has(type)) params.push("offline=1");
  if (opts?.bust) params.push("t=" + Date.now());
  const suffix = params.length ? "?" + params.join("&") : "";
  return `/tiles/${type}/{z}/{x}/{y}` + suffix;
}

function makeImageryLayer(url: string) {
  return new Cesium.ImageryLayer(
    new Cesium.UrlTemplateImageryProvider({ url, maximumLevel: 18 }),
  );
}

export function applyBaseLayer(
  viewer: Cesium.Viewer,
  type: BaseLayerType,
  alpha: number,
) {
  try {
    viewer.imageryLayers.removeAll();
  } catch {
    /* ignore */
  }
  if (type === "none") {
    viewer.scene.requestRender();
    return;
  }
  const layout = ONLINE_BASE_LAYOUT[type] || { base: type, overlay: null };
  const base = viewer.imageryLayers.add(
    makeImageryLayer(buildTileUrl(layout.base, { bust: true })),
  ) as unknown as Cesium.ImageryLayer | undefined;
  if (base) base.alpha = alpha / 100;

  if (layout.overlay && !OFFLINE_ONLY_BASES.has(layout.overlay)) {
    const over = viewer.imageryLayers.add(
      makeImageryLayer(buildTileUrl(layout.overlay, { bust: true })),
    ) as unknown as Cesium.ImageryLayer | undefined;
    if (over) over.alpha = 1;
  }
  viewer.scene.requestRender();
}

export function setBaseLayerAlpha(viewer: Cesium.Viewer, alpha: number) {
  for (let i = 0; i < viewer.imageryLayers.length; i++) {
    viewer.imageryLayers.get(i).alpha = alpha / 100;
  }
  viewer.scene.requestRender();
}
