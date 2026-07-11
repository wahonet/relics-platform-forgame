import * as Cesium from "cesium";
import { rankSize, rankLabelMaxDistance } from "../utils/dict";
import {
  ensureIconsLoaded,
  getRelicBadge,
  rankBadgeSize,
  RANK_COLOR,
  ICON_MODE_MAX_HEIGHT,
} from "./relicIcons";
import type { BboxRelic } from "../types";

interface PointMeta {
  dot?: Cesium.PointPrimitive;
  badge?: Cesium.Billboard;
  label: Cesium.Label;
  rank: string;
  category: string;
}

type RenderMode = "dot" | "badge";

// 视口内最多同时挂标签的点数(按级别优先)。距离条件会再按缩放过滤,
// 实际同屏可见的名字远少于预算,450 在县域视野下足够覆盖省/市/县保。
const LABEL_BUDGET = 450;
// 模式切换加一点滞回,避免在阈值附近来回抖动
const BADGE_ENTER_HEIGHT = ICON_MODE_MAX_HEIGHT;          // 低于此高度 → 图标
const BADGE_EXIT_HEIGHT = ICON_MODE_MAX_HEIGHT * 1.25;    // 高于此高度 → 圆点

export class PointRenderer {
  private viewer: Cesium.Viewer;
  private dots: Cesium.PointPrimitiveCollection;
  private badges: Cesium.BillboardCollection;
  private labels: Cesium.LabelCollection;
  private map = new Map<string, PointMeta>();
  private items: BboxRelic[] = [];
  private mode: RenderMode = "dot";
  private clickHandler: Cesium.ScreenSpaceEventHandler;
  private onPick: ((code: string) => void) | null = null;
  private iconsReady = false;
  private destroyed = false;
  private cameraCallback: () => void;
  /** 健康度着色模式:点位按健康色(绿/黄/红)渲染,并停用近景图标。 */
  private healthMode = false;
  private healthColors = new Map<string, string>();

  constructor(viewer: Cesium.Viewer) {
    this.viewer = viewer;
    this.dots = viewer.scene.primitives.add(new Cesium.PointPrimitiveCollection());
    this.badges = viewer.scene.primitives.add(new Cesium.BillboardCollection());
    this.labels = viewer.scene.primitives.add(new Cesium.LabelCollection());
    this.mode = this.desiredMode();

    // 徽章素材异步加载;完成后若已处于图标模式则整体重画
    ensureIconsLoaded()
      .then(() => {
        this.iconsReady = true;
        if (!this.destroyed && this.mode === "badge") this.rebuild();
      })
      .catch((e) => console.warn("[PointRenderer] 图标加载失败:", e));

    // 相机缩放跨过阈值时切换 圆点↔图标
    this.cameraCallback = () => {
      const next = this.desiredMode();
      if (next !== this.mode) {
        this.mode = next;
        this.rebuild();
      }
    };
    viewer.camera.changed.addEventListener(this.cameraCallback);

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

  private desiredMode(): RenderMode {
    // 健康度模式统一用色点表达,不切近景图标(图标无法承载健康色)
    if (this.healthMode) return "dot";
    let h = Infinity;
    try {
      h = this.viewer.camera.positionCartographic.height;
    } catch {
      return this.mode;
    }
    if (this.mode === "badge") {
      return h > BADGE_EXIT_HEIGHT ? "dot" : "badge";
    }
    return h < BADGE_ENTER_HEIGHT ? "badge" : "dot";
  }

  /** 切换健康度着色(colors: code → css 颜色)。 */
  setHealthMode(enabled: boolean, colors: Map<string, string>) {
    this.healthMode = enabled;
    this.healthColors = colors;
    this.mode = this.desiredMode();
    this.rebuild();
  }

  private dotColor(r: BboxRelic): string {
    if (this.healthMode) {
      return this.healthColors.get(r.code) || "#8b99ad";
    }
    return RANK_COLOR[r.rank] || RANK_COLOR["5"];
  }

  destroy() {
    this.destroyed = true;
    try {
      this.viewer.camera.changed.removeEventListener(this.cameraCallback);
    } catch {
      /* ignore */
    }
    try {
      this.clickHandler.destroy();
    } catch {
      /* viewer 可能已销毁,handler 也跟着失效 */
    }
    try {
      if (!this.viewer.isDestroyed()) {
        this.viewer.scene.primitives.remove(this.dots);
        this.viewer.scene.primitives.remove(this.badges);
        this.viewer.scene.primitives.remove(this.labels);
      }
    } catch {
      /* viewer 已销毁,忽略 */
    }
  }

  setOnPick(cb: ((code: string) => void) | null) {
    this.onPick = cb;
  }

  /** 清空全部并按当前模式重画(模式切换/图标就绪时用)。 */
  private rebuild() {
    if (this.destroyed) return;
    this.dots.removeAll();
    this.badges.removeAll();
    this.labels.removeAll();
    this.map.clear();
    const items = this.items;
    this.items = [];
    this.diffUpdate(items);
  }

  diffUpdate(items: BboxRelic[]) {
    this.items = items;
    const useBadge = this.mode === "badge" && this.iconsReady;

    const incoming = new Set(items.map((it) => it.code));
    for (const [code, meta] of this.map.entries()) {
      if (!incoming.has(code)) {
        if (meta.dot) this.dots.remove(meta.dot);
        if (meta.badge) this.badges.remove(meta.badge);
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
      const showLabel = labelAllowed.has(r.code);
      const labelOffset = useBadge ? rankBadgeSize(r.rank) / 2 + 4 : 8;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pickId = { _type: "relic", code: r.code, name: r.name } as any;

      let meta = this.map.get(r.code);
      if (!meta) {
        let dot: Cesium.PointPrimitive | undefined;
        let badge: Cesium.Billboard | undefined;
        if (useBadge) {
          const icon = getRelicBadge(r.category, r.rank);
          if (!icon) continue;
          const size = rankBadgeSize(r.rank);
          badge = this.badges.add({
            position: pos,
            image: icon,
            width: size,
            height: size,
            verticalOrigin: Cesium.VerticalOrigin.CENTER,
            horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
            // 文物点永远压在热力面/高亮体块等半透明图层之上
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            id: pickId,
          });
        } else {
          dot = this.dots.add({
            position: pos,
            color: Cesium.Color.fromCssColorString(this.dotColor(r)),
            pixelSize: (rankSize(r.rank) || 3) + (this.healthMode ? 1 : 0),
            outlineColor: Cesium.Color.fromCssColorString("rgba(13,17,23,0.85)"),
            outlineWidth: 1,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            id: pickId,
          });
        }
        const label = this.labels.add({
          position: pos,
          text: r.name,
          font: 'bold 12px "Microsoft YaHei", sans-serif',
          fillColor: Cesium.Color.WHITE,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 4,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
          pixelOffset: new Cesium.Cartesian2(labelOffset, 0),
          show: showLabel,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(
            0,
            rankLabelMaxDistance(r.rank),
          ),
          scale: 0.85,
        });
        meta = { dot, badge, label, rank: r.rank, category: r.category };
        this.map.set(r.code, meta);
      } else {
        if (meta.dot) {
          meta.dot.position = pos;
          if (meta.rank !== r.rank) {
            meta.dot.color = Cesium.Color.fromCssColorString(this.dotColor(r));
            meta.dot.pixelSize = (rankSize(r.rank) || 3) + (this.healthMode ? 1 : 0);
          }
        }
        if (meta.badge) {
          meta.badge.position = pos;
          if (meta.rank !== r.rank || meta.category !== r.category) {
            const icon = getRelicBadge(r.category, r.rank);
            if (icon) meta.badge.image = icon as unknown as string;
            const size = rankBadgeSize(r.rank);
            meta.badge.width = size;
            meta.badge.height = size;
            meta.label.pixelOffset = new Cesium.Cartesian2(size / 2 + 4, 0);
          }
        }
        meta.label.position = pos;
        meta.label.text = r.name;
        meta.label.show = showLabel;
        meta.rank = r.rank;
        meta.category = r.category;
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
