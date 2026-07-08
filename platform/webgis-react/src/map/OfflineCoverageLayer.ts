import * as Cesium from "cesium";
import { fetchHistory, type TileHistoryItem } from "../api/tiles";

/**
 * 离线瓦片覆盖区域可视化:把 `/api/tiles/history` 里每条 `done` 状态的下载记录的
 * bbox 在 Cesium 上画一个红色矩形 outline,便于在"离线影像"模式下直观看到
 * 哪些区域已经下载、可以滑过去查看。
 *
 * 切走离线底图时调用 `clear()` 移除全部 entities。
 */
export class OfflineCoverageLayer {
  private viewer: Cesium.Viewer;
  private entities: Cesium.Entity[] = [];

  constructor(viewer: Cesium.Viewer) {
    this.viewer = viewer;
  }

  async refresh(limit = 50): Promise<number> {
    if (this.viewer.isDestroyed()) return 0;
    this.clear();
    let items: TileHistoryItem[] = [];
    try {
      const r = await fetchHistory(limit);
      items = r.items || [];
    } catch {
      return 0;
    }
    // await 期间 viewer 可能已被销毁
    if (this.viewer.isDestroyed()) return 0;

    // 按 bbox 去重(同区域多次下载只画一个),保留最近一次的 label。
    const seen = new Map<string, TileHistoryItem>();
    for (const it of items) {
      if (it.status !== "done" || !it.bbox || it.bbox.length !== 4) continue;
      const key = it.bbox.map((n) => Number(n).toFixed(3)).join(",");
      if (!seen.has(key)) seen.set(key, it);
    }

    for (const it of seen.values()) {
      const [w, s, e, n] = it.bbox as [number, number, number, number];
      // 矩形红框 entity
      const rectEnt = this.viewer.entities.add({
        rectangle: {
          coordinates: Cesium.Rectangle.fromDegrees(w, s, e, n),
          material: Cesium.Color.fromCssColorString("rgba(248,81,73,0.06)"),
          outline: true,
          outlineColor: Cesium.Color.fromCssColorString("rgba(248,81,73,0.85)"),
          outlineWidth: 2,
          height: 0,
        },
      });
      this.entities.push(rectEnt);
      // 顶部红色 label entity (单独 entity,保证 position 与 label 正确绑定)
      if (it.label) {
        const labelEnt = this.viewer.entities.add({
          position: Cesium.Cartesian3.fromDegrees((w + e) / 2, n),
          label: {
            text: it.label,
            font: 'bold 12px "Microsoft YaHei", sans-serif',
            fillColor: Cesium.Color.fromCssColorString("#f85149"),
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 3,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            pixelOffset: new Cesium.Cartesian2(0, -8),
            scale: 0.85,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        });
        this.entities.push(labelEnt);
      }
    }
    this.viewer.scene.requestRender();
    return seen.size;
  }

  clear(): void {
    if (this.viewer.isDestroyed()) {
      this.entities = [];
      return;
    }
    this.entities.forEach((e) => {
      try {
        this.viewer.entities.remove(e);
      } catch {
        /* ignore */
      }
    });
    this.entities = [];
    this.viewer.scene.requestRender();
  }
}
