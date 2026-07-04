import * as Cesium from "cesium";

let _ionTerrain: Cesium.CesiumTerrainProvider | null = null;
let _localTerrain: Cesium.CustomHeightmapTerrainProvider | null = null;

function getLocalTerrain(): Cesium.CustomHeightmapTerrainProvider {
  if (_localTerrain) return _localTerrain;
  _localTerrain = new Cesium.CustomHeightmapTerrainProvider({
    width: 65,
    height: 65,
    tilingScheme: new Cesium.GeographicTilingScheme(),
    callback: (x: number, y: number, level: number) => {
      return fetch(`/api/terrain/${level}/${x}/${y}`)
        .then((r) => (r.ok ? r.arrayBuffer() : null))
        .then((b) => (b ? new Float32Array(b) : new Float32Array(65 * 65)))
        .catch(() => new Float32Array(65 * 65));
    },
  });
  return _localTerrain;
}

export async function setTerrainEnabled(viewer: Cesium.Viewer, enabled: boolean) {
  if (enabled) {
    if (!_ionTerrain) {
      try {
        _ionTerrain = await Cesium.CesiumTerrainProvider.fromIonAssetId(1);
      } catch {
        _ionTerrain = null;
      }
    }
    viewer.terrainProvider = _ionTerrain || getLocalTerrain();
    viewer.scene.verticalExaggeration = 5;
    const scc = viewer.scene.screenSpaceCameraController;
    scc.enableTilt = true;
    scc.enableLook = true;
    const pos = viewer.camera.positionCartographic;
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(
        Cesium.Math.toDegrees(pos.longitude),
        Cesium.Math.toDegrees(pos.latitude),
        pos.height,
      ),
      orientation: {
        heading: viewer.camera.heading,
        pitch: Cesium.Math.toRadians(-45),
        roll: 0,
      },
      duration: 1,
    });
  } else {
    viewer.terrainProvider = new Cesium.EllipsoidTerrainProvider();
    viewer.scene.verticalExaggeration = 1;
    const scc = viewer.scene.screenSpaceCameraController;
    scc.enableTilt = false;
    scc.enableLook = false;
    const pos = viewer.camera.positionCartographic;
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(
        Cesium.Math.toDegrees(pos.longitude),
        Cesium.Math.toDegrees(pos.latitude),
        pos.height,
      ),
      orientation: {
        heading: viewer.camera.heading,
        pitch: Cesium.Math.toRadians(-90),
        roll: 0,
      },
      duration: 0.8,
    });
  }
  viewer.scene.requestRender();
}
