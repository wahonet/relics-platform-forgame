/**
 * 行政区逐级下钻手势控制器。
 *
 * 双击地图空白处:县 → 镇街 → 村逐级进入(每级联动 drillStore,
 * 文物点/列表/统计同步只看该区域);右键单击逐级返回。
 * 跨区域双击 = 切换到点击处对应的同级区域。
 *
 * 命中判定基于标准四级边界(adminRegionIndex),与底图类型无关;
 * 由「系统管理 → 设置」的开关和当前是否在地图页共同决定启用。
 */
import * as Cesium from "cesium";
import { useUIStore } from "../stores/uiStore";
import { useDrillStore } from "../stores/drillStore";
import {
  ensureBaseRegions,
  ensureVillageRegions,
  locateRegion,
  getCounty,
  getTownship,
  getVillage,
  useRegionIndexStore,
  type Region,
} from "./adminRegionIndex";

interface PickedRelic {
  id?: { _type?: string };
}

type PositionedAction = (event: { position: Cesium.Cartesian2 }) => void;

const HIGHLIGHT_COLOR = "#f0cc65";

export class AdminDrillController {
  private viewer: Cesium.Viewer;
  private handler: Cesium.ScreenSpaceEventHandler;
  private readonly canvas: HTMLCanvasElement;
  private readonly defaultLeftDoubleClick: PositionedAction | undefined;
  private canNavigateExtra: () => boolean;
  private enabled = false;
  private suppressDoubleClickUntil = 0;
  /** 最近一次下钻时间:飞行落定(0.8s)前忽略连击,防止一次手势连跳多级。 */
  private lastDrillAt = 0;
  private rightPointerStart: { pointerId: number; x: number; y: number } | null = null;
  private highlightEntities: Cesium.Entity[] = [];
  private unsubscribeDrill: (() => void) | null = null;
  private readonly preventContextMenu: (event: MouseEvent) => void;
  private readonly handleRightPointerDown: (event: PointerEvent) => void;
  private readonly handleRightPointerUp: (event: PointerEvent) => void;
  private readonly cancelRightPointer: () => void;

  constructor(viewer: Cesium.Viewer, options: { canNavigate?: () => boolean } = {}) {
    this.viewer = viewer;
    this.canvas = viewer.canvas;
    this.canNavigateExtra = options.canNavigate || (() => true);
    this.defaultLeftDoubleClick = viewer.screenSpaceEventHandler.getInputAction(
      Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK,
    ) as PositionedAction | undefined;

    this.preventContextMenu = (event) => {
      if (this.enabled) event.preventDefault();
    };
    this.handleRightPointerDown = (event) => {
      if (event.button !== 2 || event.pointerType !== "mouse" || !this.canNavigate()) return;
      this.rightPointerStart = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
      };
    };
    this.handleRightPointerUp = (event) => {
      if (event.button !== 2 || !this.rightPointerStart) return;
      const start = this.rightPointerStart;
      if (event.pointerId !== start.pointerId) return;
      this.rightPointerStart = null;
      if (!this.canNavigate()) return;
      const moved = Math.hypot(event.clientX - start.x, event.clientY - start.y);
      if (moved < 5) this.goBack();
    };
    this.cancelRightPointer = () => {
      this.rightPointerStart = null;
    };
    this.canvas.addEventListener("contextmenu", this.preventContextMenu);
    this.canvas.addEventListener("pointerdown", this.handleRightPointerDown);
    this.canvas.addEventListener("pointerup", this.handleRightPointerUp);
    this.canvas.addEventListener("pointercancel", this.cancelRightPointer);
    this.canvas.addEventListener("lostpointercapture", this.cancelRightPointer);
    window.addEventListener("blur", this.cancelRightPointer);

    this.handler = new Cesium.ScreenSpaceEventHandler(this.canvas);
    this.handler.setInputAction(
      (click: { position: Cesium.Cartesian2 }) => this.onDoubleClick(click.position),
      Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK,
    );

    // drill 状态变化 → 更新当前区域高亮描边(图表下钻时也会走到这里)
    this.unsubscribeDrill = useDrillStore.subscribe((state) => {
      this.updateHighlight(state.county, state.township, state.village);
    });
  }

  private canNavigate(): boolean {
    return this.enabled && this.canNavigateExtra();
  }

  private toast(text: string): void {
    useUIStore.getState().showToast(text);
  }

  private onDoubleClick(position: Cesium.Cartesian2): void {
    if (!this.enabled) return;
    if (performance.now() < this.suppressDoubleClickUntil) {
      this.suppressDoubleClickUntil = 0;
      return;
    }
    if (!this.canNavigate()) return;
    // 连击保护:三连击/快速双击会被 Cesium 判成多次双击,
    // 若不拦截会在飞行途中用已更新的层级再下钻一级(县一步跳到村)。
    if (performance.now() - this.lastDrillAt < 900) return;

    // 双击文物点保留详情行为,不误判成行政区下钻。
    const picked = this.viewer.scene.drillPick(position, 12) as PickedRelic[];
    if (picked.some((item) => item?.id?._type === "relic")) return;

    const cartesian = this.viewer.camera.pickEllipsoid(
      position,
      this.viewer.scene.globe.ellipsoid,
    );
    if (!cartesian) return;
    const carto = Cesium.Cartographic.fromCartesian(cartesian);
    const lng = Cesium.Math.toDegrees(carto.longitude);
    const lat = Cesium.Math.toDegrees(carto.latitude);

    if (!useRegionIndexStore.getState().baseReady) {
      void ensureBaseRegions();
      return;
    }

    const chain = locateRegion(lng, lat);
    if (!chain.county) return;

    const drill = useDrillStore.getState();
    if (!drill.county || chain.county.name !== drill.county) {
      this.lastDrillAt = performance.now();
      drill.drillTo({ county: chain.county.name });
      this.toast(`已进入 ${chain.county.name} · 双击镇街继续,右键返回`);
      return;
    }
    if (!chain.township) return;
    if (!drill.township || chain.township.name !== drill.township) {
      this.lastDrillAt = performance.now();
      drill.drillTo({ county: chain.county.name, township: chain.township.name });
      this.toast(`已进入 ${chain.township.name} · 双击村继续,右键返回`);
      return;
    }
    if (!chain.village) {
      const idx = useRegionIndexStore.getState();
      if (idx.villagesLoading) this.toast("村界数据加载中,请稍候再试");
      else if (idx.villagesReady) this.toast("该位置不在任何村界内");
      else void ensureVillageRegions();
      return;
    }
    if (chain.village.name !== drill.village) {
      this.lastDrillAt = performance.now();
      drill.drillTo({
        county: chain.county.name,
        township: chain.township.name,
        village: chain.village.name,
      });
      this.toast(`已进入 ${chain.village.name} · 右键返回`);
    }
  }

  private goBack(): void {
    const drill = useDrillStore.getState();
    if (!drill.county) return;
    const from = drill.village || drill.township || drill.county;
    drill.back();
    const after = useDrillStore.getState();
    const target = after.village || after.township || after.county || "全市";
    this.toast(`已从 ${from} 返回 ${target}`);
  }

  /** 当前下钻区域的金色描边(区域为空则清除)。 */
  private updateHighlight(county: string, township: string, village: string): void {
    if (this.viewer.isDestroyed()) return;
    this.highlightEntities.forEach((entity) => {
      try {
        this.viewer.entities.remove(entity);
      } catch {
        /* ignore */
      }
    });
    this.highlightEntities = [];

    let region: Region | null = null;
    if (village) region = getVillage(county, township, village);
    else if (township) region = getTownship(county, township);
    else if (county) region = getCounty(county);
    if (region) {
      region.polygons.forEach((polygon) => {
        const outer = polygon[0];
        if (!outer || outer.length < 3) return;
        const positions = outer.map(([plng, plat]) => Cesium.Cartesian3.fromDegrees(plng, plat));
        positions.push(positions[0]);
        this.highlightEntities.push(this.viewer.entities.add({
          polyline: {
            positions,
            width: 4,
            material: new Cesium.PolylineGlowMaterialProperty({
              glowPower: 0.18,
              color: Cesium.Color.fromCssColorString(HIGHLIGHT_COLOR).withAlpha(0.85),
            }),
            clampToGround: true,
          },
        }));
      });
    }
    this.viewer.scene.requestRender();
  }

  /** 启用时接管双击(移除 Cesium 默认的实体追踪),关闭时恢复。 */
  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.rightPointerStart = null;
    if (enabled) void ensureBaseRegions();
    if (this.viewer.isDestroyed()) return;
    if (enabled) {
      this.viewer.screenSpaceEventHandler.removeInputAction(
        Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK,
      );
    } else if (this.defaultLeftDoubleClick) {
      this.viewer.screenSpaceEventHandler.setInputAction(
        this.defaultLeftDoubleClick,
        Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK,
      );
    }
  }

  /** 起点选择等 LEFT_CLICK 手势完成后,拦住同一手势随后的 dblclick。 */
  suppressNextDoubleClick(durationMs = 350): void {
    this.suppressDoubleClickUntil = performance.now() + durationMs;
  }

  destroy(): void {
    this.setEnabled(false);
    this.unsubscribeDrill?.();
    this.unsubscribeDrill = null;
    this.updateHighlight("", "", "");
    try {
      this.canvas.removeEventListener("contextmenu", this.preventContextMenu);
      this.canvas.removeEventListener("pointerdown", this.handleRightPointerDown);
      this.canvas.removeEventListener("pointerup", this.handleRightPointerUp);
      this.canvas.removeEventListener("pointercancel", this.cancelRightPointer);
      this.canvas.removeEventListener("lostpointercapture", this.cancelRightPointer);
      window.removeEventListener("blur", this.cancelRightPointer);
    } catch {
      /* ignore */
    }
    try {
      this.handler.destroy();
    } catch {
      /* viewer 可能已先销毁 */
    }
  }
}
