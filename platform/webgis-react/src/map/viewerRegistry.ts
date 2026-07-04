import * as Cesium from "cesium";

let _viewer: Cesium.Viewer | null = null;

export function setViewer(viewer: Cesium.Viewer | null) {
  _viewer = viewer;
}

export function getViewer(): Cesium.Viewer | null {
  return _viewer;
}

export function flyTo(lng: number, lat: number, height: number, duration = 1.2) {
  if (!_viewer) return;
  _viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(lng, lat, height),
    orientation: { heading: 0, pitch: Cesium.Math.toRadians(-90), roll: 0 },
    duration,
  });
}
