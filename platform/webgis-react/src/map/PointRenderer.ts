import * as Cesium from "cesium";
import {
  CATEGORY_MAP,
  categoryColor,
  rankSize,
  rankLabelMaxDistance,
} from "../utils/dict";
import type { BboxRelic } from "../types";

interface PointMeta {
  point: Cesium.PointPrimitive;
  label: Cesium.Label;
  rank: string;
}

const LABEL_BUDGET = 300;

export class PointRenderer {
  private viewer: Cesium.Viewer;
  private points: Cesium.PointPrimitiveCollection;
  private labels: Cesium.LabelCollection;
  private map = new Map<string, PointMeta>();
  private clickHandler: Cesium.ScreenSpaceEventHandler;
  private onPick: ((code: string) => void) | null = null;

  constructor(viewer: Cesium.Viewer) {
    this.viewer = viewer;
    this.points = viewer.scene.primitives.add(new Cesium.PointPrimitiveCollection());
    this.labels = viewer.scene.primitives.add(new Cesium.LabelCollection());
    this.clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    this.clickHandler.setInputAction((click: { position: Cesium.Cartesian2 }) => {
      const picked = viewer.scene.pick(click.position);
      if (
        picked &&
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (picked as any).id?._type === "relic" &&
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (picked as any).id?.code &&
        this.onPick
      ) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.onPick((picked as any).id.code);
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  destroy() {
    try {
      this.clickHandler.destroy();
    } catch {
      /* viewer 可能已销毁,handler 也跟着失效 */
    }
    try {
      if (!this.viewer.isDestroyed()) {
        this.viewer.scene.primitives.remove(this.points);
        this.viewer.scene.primitives.remove(this.labels);
      }
    } catch {
      /* viewer 已销毁,忽略 */
    }
  }

  setOnPick(cb: ((code: string) => void) | null) {
    this.onPick = cb;
  }

  diffUpdate(items: BboxRelic[]) {
    const incoming = new Set(items.map((it) => it.code));
    for (const [code, meta] of this.map.entries()) {
      if (!incoming.has(code)) {
        this.points.remove(meta.point);
        this.labels.remove(meta.label);
        this.map.delete(code);
      }
    }
    const sorted = [...items].sort(
      (a, b) => Number(a.rank || "5") - Number(b.rank || "5"),
    );
    const labelAllowed = new Set(sorted.slice(0, LABEL_BUDGET).map((r) => r.code));

    for (const r of items) {
      const lng = r.lng;
      const lat = r.lat;
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
      const pos = Cesium.Cartesian3.fromDegrees(lng, lat, 0);
      const color = Cesium.Color.fromCssColorString(
        CATEGORY_MAP[r.category]?.color || categoryColor(r.category) || "#8b949e",
      );
      const px = rankSize(r.rank) || 8;
      const showLabel = labelAllowed.has(r.code);

      let meta = this.map.get(r.code);
      if (!meta) {
        const point = this.points.add({
          position: pos,
          color,
          pixelSize: px,
          outlineColor: Cesium.Color.fromCssColorString("rgba(13,17,23,0.85)"),
          outlineWidth: 2,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          id: { _type: "relic", code: r.code, name: r.name } as any,
        });
        const label = this.labels.add({
          position: pos,
          text: r.name,
          font: 'bold 12px "Microsoft YaHei", sans-serif',
          fillColor: Cesium.Color.WHITE,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 4,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
          pixelOffset: new Cesium.Cartesian2(8, 0),
          show: showLabel,
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(
            0,
            rankLabelMaxDistance(r.rank),
          ),
          scale: 0.85,
        });
        meta = { point, label, rank: r.rank };
        this.map.set(r.code, meta);
      } else {
        meta.point.position = pos;
        meta.point.color = color;
        meta.point.pixelSize = px;
        meta.label.position = pos;
        meta.label.text = r.name;
        meta.label.show = showLabel;
        meta.rank = r.rank;
      }
    }

    this.viewer.scene.requestRender();
  }

  flyTo(lng: number, lat: number, height = 600) {
    this.viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(lng, lat, height),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-90), roll: 0 },
      duration: 1.2,
    });
  }
}
