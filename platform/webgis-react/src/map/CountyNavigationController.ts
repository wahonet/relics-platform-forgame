import * as Cesium from "cesium";
import type { OfflineVectorBasemapLayer } from "./OfflineVectorBasemapLayer";

interface ViewSnapshot {
  rectangle: Cesium.Rectangle;
  county: string | null;
}

interface CountyNavigationOptions {
  canNavigate?: () => boolean;
  onEnter?: (county: string) => void;
  onBack?: (county: string | null) => void;
}

interface PickedRelic {
  id?: {
    _type?: string;
  };
}

type PositionedAction = (event: { position: Cesium.Cartesian2 }) => void;

/** 双击县区下钻、右键单击返回上一视角。 */
export class CountyNavigationController {
  private viewer: Cesium.Viewer;
  private basemap: OfflineVectorBasemapLayer;
  private options: CountyNavigationOptions;
  private handler: Cesium.ScreenSpaceEventHandler;
  private readonly canvas: HTMLCanvasElement;
  private readonly defaultLeftDoubleClick: PositionedAction | undefined;
  private history: ViewSnapshot[] = [];
  private activeCounty: string | null = null;
  private enabled = false;
  private suppressDoubleClickUntil = 0;
  private rightPointerStart: { pointerId: number; x: number; y: number } | null = null;
  private readonly preventContextMenu: (event: MouseEvent) => void;
  private readonly handleRightPointerDown: (event: PointerEvent) => void;
  private readonly handleRightPointerUp: (event: PointerEvent) => void;
  private readonly cancelRightPointer: () => void;

  constructor(
    viewer: Cesium.Viewer,
    basemap: OfflineVectorBasemapLayer,
    options: CountyNavigationOptions = {},
  ) {
    this.viewer = viewer;
    this.basemap = basemap;
    this.options = options;
    this.canvas = viewer.canvas;
    this.defaultLeftDoubleClick = viewer.screenSpaceEventHandler.getInputAction(
      Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK,
    ) as PositionedAction | undefined;

    this.preventContextMenu = (event) => {
      if (this.enabled) event.preventDefault();
    };
    this.handleRightPointerDown = (event) => {
      if (
        event.button !== 2 ||
        event.pointerType !== "mouse" ||
        !this.canNavigate()
      ) return;
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
      (click: { position: Cesium.Cartesian2 }) => this.enterCounty(click.position),
      Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK,
    );
  }

  private canNavigate(): boolean {
    return this.enabled && (!this.options.canNavigate || this.options.canNavigate());
  }

  private enterCounty(position: Cesium.Cartesian2): void {
    if (!this.enabled) return;
    if (performance.now() < this.suppressDoubleClickUntil) {
      this.suppressDoubleClickUntil = 0;
      return;
    }
    if (!this.canNavigate()) return;

    // 双击文物点时保留文物详情行为，不把它误判成行政区下钻。
    const picked = this.viewer.scene.drillPick(position, 12) as PickedRelic[];
    if (picked.some((item) => item?.id?._type === "relic")) return;

    const cartesian = this.viewer.camera.pickEllipsoid(
      position,
      this.viewer.scene.globe.ellipsoid,
    );
    if (!cartesian) return;
    const positionWgs84 = Cesium.Cartographic.fromCartesian(cartesian);
    const county = this.basemap.findCountyAt(
      Cesium.Math.toDegrees(positionWgs84.longitude),
      Cesium.Math.toDegrees(positionWgs84.latitude),
    );
    if (!county || county.name === this.activeCounty) return;

    const current = this.viewer.camera.computeViewRectangle(
      this.viewer.scene.globe.ellipsoid,
    );
    if (current) {
      this.history.push({
        rectangle: Cesium.Rectangle.clone(current),
        county: this.activeCounty,
      });
      if (this.history.length > 12) this.history.shift();
    }

    this.activeCounty = county.name;
    this.viewer.camera.cancelFlight();
    this.viewer.camera.flyTo({
      destination: this.withPadding(county.rectangle),
      orientation: {
        heading: 0,
        pitch: Cesium.Math.toRadians(-90),
        roll: 0,
      },
      duration: 0.8,
    });
    this.options.onEnter?.(county.name);
  }

  private withPadding(rectangle: Cesium.Rectangle): Cesium.Rectangle {
    const padLng = Math.max(rectangle.width * 0.1, Cesium.Math.toRadians(0.012));
    const padLat = Math.max(rectangle.height * 0.1, Cesium.Math.toRadians(0.012));
    return new Cesium.Rectangle(
      rectangle.west - padLng,
      rectangle.south - padLat,
      rectangle.east + padLng,
      rectangle.north + padLat,
    );
  }

  goBack(): void {
    const previous = this.history.pop();
    if (!previous) return;
    this.activeCounty = previous.county;
    this.viewer.camera.cancelFlight();
    this.viewer.camera.flyTo({
      destination: previous.rectangle,
      orientation: {
        heading: 0,
        pitch: Cesium.Math.toRadians(-90),
        roll: 0,
      },
      duration: 0.7,
    });
    this.options.onBack?.(previous.county);
  }

  /** 仅在真正的离线专题矢量底图启用县区手势，并恢复其它底图的 Cesium 默认双击。 */
  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.rightPointerStart = null;
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

  /** 起点选择由 LEFT_CLICK 完成后，拦住同一手势随后产生的 dblclick。 */
  suppressNextDoubleClick(durationMs = 350): void {
    this.suppressDoubleClickUntil = performance.now() + durationMs;
  }

  clearHistory(): void {
    this.history = [];
    this.activeCounty = null;
  }

  destroy(): void {
    this.setEnabled(false);
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
    this.clearHistory();
  }
}
