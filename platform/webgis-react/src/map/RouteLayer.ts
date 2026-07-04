import * as Cesium from "cesium";

/**
 * 巡查路线 + 两线范围的地图渲染层。
 *
 * - showRoute: 折线(高德路径或直线) + 有序编号圆标
 * - showBoundaries: 保护范围(红) / 建设控制地带(黄) 半透明面
 */
export class RouteLayer {
  private viewer: Cesium.Viewer;
  private routeEntities: Cesium.Entity[] = [];
  private boundaryDs: Cesium.CustomDataSource;

  constructor(viewer: Cesium.Viewer) {
    this.viewer = viewer;
    this.boundaryDs = new Cesium.CustomDataSource("relic-boundaries");
    viewer.dataSources.add(this.boundaryDs);
  }

  destroy() {
    try {
      if (!this.viewer.isDestroyed()) {
        this.clearRoute();
        this.viewer.dataSources.remove(this.boundaryDs, true);
      }
    } catch {
      /* viewer 已销毁 */
    }
  }

  // ── 巡查路线 ──────────────────────────────────────────────

  clearRoute() {
    for (const e of this.routeEntities) {
      try {
        this.viewer.entities.remove(e);
      } catch {
        /* ignore */
      }
    }
    this.routeEntities = [];
    this.requestRender();
  }

  /**
   * 渲染路线。stops 顺序即巡查顺序;polyline 为可选的实际路径
   * (高德驾车路径,比 stops 连线更贴合道路)。
   */
  showRoute(
    stops: { lng: number; lat: number; name: string; checked?: boolean; verified?: boolean }[],
    polyline?: [number, number][] | null,
  ) {
    this.clearRoute();
    if (!stops.length) return;

    const path = polyline && polyline.length >= 2
      ? polyline
      : stops.map((s) => [s.lng, s.lat] as [number, number]);

    if (path.length >= 2) {
      const positions = path.map(([lng, lat]) => Cesium.Cartesian3.fromDegrees(lng, lat, 2));
      this.routeEntities.push(
        this.viewer.entities.add({
          polyline: {
            positions,
            width: 5,
            material: new Cesium.PolylineGlowMaterialProperty({
              color: Cesium.Color.fromCssColorString("#58a6ff"),
              glowPower: 0.18,
            }),
            clampToGround: true,
          },
        }),
      );
    }

    stops.forEach((s, i) => {
      const bg = s.verified
        ? "#3fb950"
        : s.checked
          ? "#d29922"
          : "#1f6feb";
      this.routeEntities.push(
        this.viewer.entities.add({
          position: Cesium.Cartesian3.fromDegrees(s.lng, s.lat, 3),
          point: {
            pixelSize: 16,
            color: Cesium.Color.fromCssColorString(bg),
            outlineColor: Cesium.Color.WHITE,
            outlineWidth: 2,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
          label: {
            text: String(i + 1),
            font: "bold 12px sans-serif",
            fillColor: Cesium.Color.WHITE,
            style: Cesium.LabelStyle.FILL,
            verticalOrigin: Cesium.VerticalOrigin.CENTER,
            horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        }),
      );
    });
    this.requestRender();
  }

  /** 视角飞到整条路线。 */
  flyToRoute(stops: { lng: number; lat: number }[]) {
    if (!stops.length) return;
    const lngs = stops.map((s) => s.lng);
    const lats = stops.map((s) => s.lat);
    const pad = 0.02;
    this.viewer.camera.flyTo({
      destination: Cesium.Rectangle.fromDegrees(
        Math.min(...lngs) - pad,
        Math.min(...lats) - pad,
        Math.max(...lngs) + pad,
        Math.max(...lats) + pad,
      ),
      duration: 1.2,
    });
  }

  // ── 两线范围 ──────────────────────────────────────────────

  clearBoundaries() {
    this.boundaryDs.entities.removeAll();
    this.requestRender();
  }

  /** 渲染 FeatureCollection(properties.kind = protection|control)。 */
  showBoundaries(fc: {
    features?: { properties?: { kind?: string }; geometry?: { type?: string; coordinates?: unknown } }[];
  }) {
    this.clearBoundaries();
    const feats = fc?.features || [];
    for (const f of feats) {
      const kind = f.properties?.kind || "protection";
      const isProtection = kind === "protection";
      const color = isProtection ? "#f85149" : "#d29922";
      const geom = f.geometry;
      if (!geom?.type || !geom.coordinates) continue;
      const polys: number[][][][] =
        geom.type === "Polygon"
          ? [geom.coordinates as number[][][]]
          : geom.type === "MultiPolygon"
            ? (geom.coordinates as number[][][][])
            : [];
      for (const rings of polys) {
        const outer = rings[0];
        if (!outer || outer.length < 3) continue;
        const flat: number[] = [];
        outer.forEach(([lng, lat]) => flat.push(lng, lat));
        this.boundaryDs.entities.add({
          polygon: {
            hierarchy: Cesium.Cartesian3.fromDegreesArray(flat),
            material: Cesium.Color.fromCssColorString(color).withAlpha(isProtection ? 0.22 : 0.14),
            outline: false,
          },
          polyline: {
            positions: Cesium.Cartesian3.fromDegreesArray([...flat, flat[0], flat[1]]),
            width: isProtection ? 3 : 2,
            material: Cesium.Color.fromCssColorString(color).withAlpha(0.9),
            clampToGround: true,
          },
        });
      }
    }
    this.requestRender();
  }

  private requestRender() {
    try {
      if (!this.viewer.isDestroyed()) this.viewer.scene.requestRender();
    } catch {
      /* ignore */
    }
  }
}

// 模块级注册表:让面板组件不经过 React 树也能拿到图层。
let _routeLayer: RouteLayer | null = null;
export function setRouteLayer(l: RouteLayer | null) {
  _routeLayer = l;
}
export function getRouteLayer(): RouteLayer | null {
  return _routeLayer;
}
