import * as Cesium from "cesium";
import { fetchParcelGeojson, type ParcelFeature } from "../api/parcels";

/**
 * 对比图斑渲染层:每个已导入 SHP 图层一个 CustomDataSource。
 * 颜色按图层序号轮换;冲突高亮时定位并闪烁目标图斑。
 */

const PALETTE = [
  "#ffb020", // 琥珀
  "#22c8b7", // 青
  "#a06bff", // 紫
  "#ff7d59", // 橙红
  "#3fa9f5", // 天蓝
  "#8bc34a", // 草绿
];

interface LayerEntry {
  ds: Cesium.CustomDataSource;
  /** feature_index → 该要素的实体(高亮用) */
  byIndex: Map<number, Cesium.Entity[]>;
  color: string;
}

export class ParcelLayer {
  private viewer: Cesium.Viewer;
  private entries = new Map<string, LayerEntry>();
  private flashTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  constructor(viewer: Cesium.Viewer) {
    this.viewer = viewer;
  }

  destroy() {
    this.destroyed = true;
    if (this.flashTimer) {
      clearTimeout(this.flashTimer);
      this.flashTimer = null;
    }
    try {
      if (!this.viewer.isDestroyed()) {
        for (const e of this.entries.values()) {
          this.viewer.dataSources.remove(e.ds, true);
        }
      }
    } catch {
      /* viewer 已销毁 */
    }
    this.entries.clear();
  }

  /** 与 store 中的图层列表增量同步:新增拉数据,移除删数据源。 */
  async sync(layerIds: string[]): Promise<void> {
    if (this.destroyed || this.viewer.isDestroyed()) return;
    const want = new Set(layerIds);
    for (const [id, entry] of this.entries) {
      if (!want.has(id)) {
        try {
          this.viewer.dataSources.remove(entry.ds, true);
        } catch {
          /* ignore */
        }
        this.entries.delete(id);
      }
    }
    const jobs: Promise<void>[] = [];
    layerIds.forEach((id, i) => {
      if (!this.entries.has(id)) jobs.push(this.addLayer(id, PALETTE[i % PALETTE.length]));
    });
    await Promise.all(jobs);
    this.requestRender();
  }

  setVisible(id: string, visible: boolean) {
    const entry = this.entries.get(id);
    if (entry) {
      entry.ds.show = visible;
      this.requestRender();
    }
  }

  applyVisibility(visible: Record<string, boolean>) {
    for (const [id, entry] of this.entries) {
      entry.ds.show = visible[id] !== false;
    }
    this.requestRender();
  }

  private async addLayer(id: string, colorCss: string): Promise<void> {
    let fc: { features?: ParcelFeature[] };
    try {
      fc = await fetchParcelGeojson(id);
    } catch {
      return;
    }
    if (this.destroyed || this.viewer.isDestroyed() || this.entries.has(id)) return;

    const ds = new Cesium.CustomDataSource(`parcels-${id}`);
    const color = Cesium.Color.fromCssColorString(colorCss);
    const byIndex = new Map<number, Cesium.Entity[]>();

    for (const f of fc.features || []) {
      const geom = f.geometry;
      if (!geom?.coordinates) continue;
      const fidx = Number((f.properties || {})._idx ?? -1);
      const label = String((f.properties || {})._label || "");
      const polys: number[][][][] =
        geom.type === "Polygon"
          ? [geom.coordinates as number[][][]]
          : (geom.coordinates as number[][][][]);
      const ents: Cesium.Entity[] = [];
      for (const rings of polys) {
        const outer = rings?.[0];
        if (!outer || outer.length < 3) continue;
        const flat: number[] = [];
        for (const pt of outer) {
          if (Array.isArray(pt) && pt.length >= 2) flat.push(pt[0], pt[1]);
        }
        if (flat.length < 6) continue;
        const holes = (rings.slice(1) || [])
          .filter((r) => r && r.length >= 3)
          .map(
            (r) =>
              new Cesium.PolygonHierarchy(
                Cesium.Cartesian3.fromDegreesArray(r.flatMap((p) => [p[0], p[1]])),
              ),
          );
        const ent = ds.entities.add({
          properties: { layerId: id, featureIndex: fidx, label },
          polygon: {
            hierarchy: new Cesium.PolygonHierarchy(
              Cesium.Cartesian3.fromDegreesArray(flat),
              holes,
            ),
            material: color.withAlpha(0.16),
            outline: false,
          },
          polyline: {
            positions: Cesium.Cartesian3.fromDegreesArray([...flat, flat[0], flat[1]]),
            width: 2,
            material: color.withAlpha(0.9),
            clampToGround: true,
          },
        });
        ents.push(ent);
      }
      if (fidx >= 0 && ents.length) byIndex.set(fidx, ents);
    }

    this.entries.set(id, { ds, byIndex, color: colorCss });
    try {
      await this.viewer.dataSources.add(ds);
    } catch {
      /* viewer 已销毁 */
    }
  }

  /** 定位冲突图斑:飞过去 + 边线闪红 2 秒。 */
  focusConflict(layerId: string, featureIndex: number, center: [number, number]) {
    if (this.destroyed || this.viewer.isDestroyed()) return;
    this.viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(center[0], center[1], 2600),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-90), roll: 0 },
      duration: 1.0,
    });

    const entry = this.entries.get(layerId);
    const ents = entry?.byIndex.get(featureIndex);
    if (!entry || !ents?.length) return;
    entry.ds.show = true;

    const flash = Cesium.Color.fromCssColorString("#ff3b30");
    const orig = Cesium.Color.fromCssColorString(entry.color);
    for (const e of ents) {
      if (e.polyline) {
        e.polyline.material = new Cesium.ColorMaterialProperty(flash);
        e.polyline.width = new Cesium.ConstantProperty(4);
      }
      if (e.polygon) e.polygon.material = new Cesium.ColorMaterialProperty(flash.withAlpha(0.3));
    }
    this.requestRender();
    if (this.flashTimer) clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => {
      if (this.destroyed || this.viewer.isDestroyed()) return;
      for (const e of ents) {
        if (e.polyline) {
          e.polyline.material = new Cesium.ColorMaterialProperty(orig.withAlpha(0.9));
          e.polyline.width = new Cesium.ConstantProperty(2);
        }
        if (e.polygon) e.polygon.material = new Cesium.ColorMaterialProperty(orig.withAlpha(0.16));
      }
      this.requestRender();
    }, 2200);
  }

  /** 图层色(面板图例用)。 */
  colorOf(layerId: string): string | undefined {
    return this.entries.get(layerId)?.color;
  }

  private requestRender() {
    try {
      this.viewer.scene.requestRender();
    } catch {
      /* ignore */
    }
  }
}

// 模块级注册表:面板组件跨层访问地图实例。
let _parcelLayer: ParcelLayer | null = null;
export function setParcelLayer(l: ParcelLayer | null) {
  _parcelLayer = l;
}
export function getParcelLayer(): ParcelLayer | null {
  return _parcelLayer;
}
