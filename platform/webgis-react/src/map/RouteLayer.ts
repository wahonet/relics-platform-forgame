import * as Cesium from "cesium";

/**
 * 巡查路线 + 两线范围的地图渲染层。
 *
 * - showRoute: 导航风格路线(红色粗线 + 白色行车方向箭头,不画站点圆标,
 *   文物位置由点位图标本身表达)
 * - showBoundaries: 保护范围(红) / 建设控制地带(黄) 半透明面
 */

const ROUTE_COLOR = "#f5343b";        // 主线亮红
const ROUTE_CASING_COLOR = "#8f1216"; // 描边深红

function haversineM(lng1: number, lat1: number, lng2: number, lat2: number): number {
  const R = 6371000;
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLng = (lng2 - lng1) * rad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** A→B 的方位角(弧度,从正北顺时针)。 */
function bearingRad(lng1: number, lat1: number, lng2: number, lat2: number): number {
  const rad = Math.PI / 180;
  const dLng = (lng2 - lng1) * rad;
  const y = Math.sin(dLng) * Math.cos(lat2 * rad);
  const x =
    Math.cos(lat1 * rad) * Math.sin(lat2 * rad) -
    Math.sin(lat1 * rad) * Math.cos(lat2 * rad) * Math.cos(dLng);
  return Math.atan2(y, x);
}

let _arrowCanvas: HTMLCanvasElement | null = null;

/** 白色行车方向箭头(朝上),叠在红线上指示前进方向。 */
function arrowImage(): HTMLCanvasElement {
  if (_arrowCanvas) return _arrowCanvas;
  const S = 26;
  const c = document.createElement("canvas");
  c.width = S;
  c.height = S;
  const ctx = c.getContext("2d")!;
  ctx.translate(S / 2, S / 2);
  ctx.beginPath();
  ctx.moveTo(0, -S * 0.32);
  ctx.lineTo(S * 0.24, S * 0.18);
  ctx.lineTo(0, S * 0.05);
  ctx.lineTo(-S * 0.24, S * 0.18);
  ctx.closePath();
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = "rgba(90,10,10,0.9)";
  ctx.lineWidth = 1.5;
  ctx.fill();
  ctx.stroke();
  _arrowCanvas = c;
  return c;
}
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
   * 渲染路线(导航风格):红色粗线(深红描边) + 白色行车方向箭头。
   * 不再画站点圆标——文物位置由点位图标表达。
   * stops 顺序即巡查顺序;polyline 为可选的实际路径
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
    if (path.length < 2) {
      this.requestRender();
      return;
    }

    const positions = path.map(([lng, lat]) => Cesium.Cartesian3.fromDegrees(lng, lat, 2));
    // 深红描边在下、亮红主线在上,叠出导航软件的路线质感
    this.routeEntities.push(
      this.viewer.entities.add({
        polyline: {
          positions,
          width: 9,
          material: Cesium.Color.fromCssColorString(ROUTE_CASING_COLOR).withAlpha(0.9),
          clampToGround: true,
        },
      }),
    );
    this.routeEntities.push(
      this.viewer.entities.add({
        polyline: {
          positions,
          width: 6,
          material: Cesium.Color.fromCssColorString(ROUTE_COLOR),
          clampToGround: true,
        },
      }),
    );

    this.addDirectionArrows(path);
    this.requestRender();
  }

  /** 沿路径等距放置白色方向箭头(billboard 按行进方位角旋转)。 */
  private addDirectionArrows(path: [number, number][]) {
    let total = 0;
    for (let i = 1; i < path.length; i++) {
      total += haversineM(path[i - 1][0], path[i - 1][1], path[i][0], path[i][1]);
    }
    if (total < 200) return;
    // 箭头间距按总长自适应:短路线密一点,长路线稀一点
    const spacing = Math.min(Math.max(total / 14, 400), 4000);

    const img = arrowImage();
    let next = spacing / 2; // 首个箭头放在半个间距处,避免贴着起点
    let walked = 0;
    for (let i = 1; i < path.length; i++) {
      const [lng1, lat1] = path[i - 1];
      const [lng2, lat2] = path[i];
      const seg = haversineM(lng1, lat1, lng2, lat2);
      if (seg <= 0) continue;
      while (next <= walked + seg) {
        const t = (next - walked) / seg;
        const lng = lng1 + (lng2 - lng1) * t;
        const lat = lat1 + (lat2 - lat1) * t;
        // billboard.rotation 是逆时针,方位角是顺时针(自正北),取负号;
        // 2D 场景北朝上且禁用了旋转,屏幕旋转即地理旋转
        const rotation = -bearingRad(lng1, lat1, lng2, lat2);
        this.routeEntities.push(
          this.viewer.entities.add({
            position: Cesium.Cartesian3.fromDegrees(lng, lat, 3),
            billboard: {
              image: img,
              rotation,
              verticalOrigin: Cesium.VerticalOrigin.CENTER,
              horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
          }),
        );
        next += spacing;
      }
      walked += seg;
    }
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

  /** 渲染 FeatureCollection(properties.kind = protection|control|body)。 */
  showBoundaries(fc: {
    features?: { properties?: { kind?: string }; geometry?: { type?: string; coordinates?: unknown } }[];
  }) {
    this.clearBoundaries();
    const feats = fc?.features || [];
    for (const f of feats) {
      const kind = f.properties?.kind || "protection";
      const isProtection = kind === "protection";
      // protection=保护范围(红) control=建控地带(黄) body=本体边界(绿,四普测点围合)
      const color = kind === "body" ? "#3fb950" : isProtection ? "#f85149" : "#d29922";
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
