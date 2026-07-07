import * as Cesium from "cesium";

/**
 * 两线范围常驻图层:启动时全量加载 /api/geojson/polygons,
 * 保护范围(红) / 建设控制地带(蓝) 常驻在地图上。
 * 相机高于 90km(整市视角)自动隐藏,低于 90km 自动显示——
 * 高镜头下两线只剩几个像素,只会糊成杂点,不如收起。
 */

const VISIBLE_MAX_DISTANCE = 90_000;

const KIND_STYLE: Record<string, { color: string; width: number; fill: number }> = {
  protection: { color: "#ff3b30", width: 3, fill: 0.10 },
  control: { color: "#2f81f7", width: 2.5, fill: 0.06 },
};

export class TwoLineLayer {
  private viewer: Cesium.Viewer;
  private ds: Cesium.CustomDataSource;
  private loaded = false;

  constructor(viewer: Cesium.Viewer) {
    this.viewer = viewer;
    this.ds = new Cesium.CustomDataSource("two-lines");
    viewer.dataSources.add(this.ds);
  }

  destroy() {
    try {
      if (!this.viewer.isDestroyed()) {
        this.viewer.dataSources.remove(this.ds, true);
      }
    } catch {
      /* viewer 已销毁 */
    }
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    let fc: { features?: { properties?: { kind?: string }; geometry?: { type?: string; coordinates?: unknown } }[] };
    try {
      const resp = await fetch("/api/geojson/polygons", { credentials: "same-origin" });
      if (!resp.ok) return;
      fc = await resp.json();
    } catch {
      return;
    }
    this.loaded = true;

    const ddc = new Cesium.DistanceDisplayCondition(0, VISIBLE_MAX_DISTANCE);
    for (const f of fc?.features || []) {
      const kind = f.properties?.kind || "";
      const style = KIND_STYLE[kind];
      if (!style) continue; // body 或未知类型不显示
      const geom = f.geometry;
      if (!geom?.type || !geom.coordinates) continue;
      const polys: number[][][][] =
        geom.type === "Polygon"
          ? [geom.coordinates as number[][][]]
          : geom.type === "MultiPolygon"
            ? (geom.coordinates as number[][][][])
            : [];
      const color = Cesium.Color.fromCssColorString(style.color);
      for (const rings of polys) {
        const outer = rings[0];
        if (!outer || outer.length < 3) continue;
        const flat: number[] = [];
        outer.forEach((pt) => {
          if (Array.isArray(pt) && pt.length >= 2) flat.push(pt[0], pt[1]);
        });
        if (flat.length < 6) continue;
        this.ds.entities.add({
          polygon: {
            hierarchy: Cesium.Cartesian3.fromDegreesArray(flat),
            material: color.withAlpha(style.fill),
            outline: false,
            distanceDisplayCondition: ddc,
          },
          polyline: {
            positions: Cesium.Cartesian3.fromDegreesArray([...flat, flat[0], flat[1]]),
            width: style.width,
            material: color.withAlpha(0.9),
            clampToGround: true,
            distanceDisplayCondition: ddc,
          },
        });
      }
    }
    try {
      this.viewer.scene.requestRender();
    } catch {
      /* ignore */
    }
  }

  /** 数据管线重跑后重新加载。 */
  async reload(): Promise<void> {
    this.ds.entities.removeAll();
    this.loaded = false;
    await this.load();
  }
}
