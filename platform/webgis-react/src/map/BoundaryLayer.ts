import * as Cesium from "cesium";

interface BoundaryItem {
  fill: Cesium.Entity;
  line: Cesium.Entity;
  type: string;
}

const COLORS = {
  county: { r: 255, g: 200, b: 50 },
  township: { r: 88, g: 166, b: 255 },
  village: { r: 63, g: 185, b: 80 },
};

// 注意:不要在这里做抽稀 / 平滑。
// 原本对 county / township 各自跑了一次 Douglas-Peucker + Laplacian,
// 两层用不同参数(eps / 迭代次数), 导致原本重合的县界和镇界外缘对不上。
// 现在一律用原始 ring, 抗锯齿交给 Cesium 自身的 FXAA / MSAA
// (设置面板里 "高清 / 超清" 即可启用)。

function ringCenter(ring: number[][]) {
  const lngs = ring.map((c) => c[0]);
  const lats = ring.map((c) => c[1]);
  return [
    (Math.min(...lngs) + Math.max(...lngs)) / 2,
    (Math.min(...lats) + Math.max(...lats)) / 2,
  ];
}

interface GeoJSONGeometry {
  type?: string;
  coordinates?: unknown;
}

/**
 * 把 Polygon / MultiPolygon 统一展开成 ring 列表(含洞,洞同样是真实边界线)。
 * 之前直接 `coordinates.forEach(ring)` 假设一定是 Polygon,遇到 MultiPolygon
 * 会把整个 polygon 当 ring 用,画出乱线甚至崩溃。
 */
function extractRings(geometry: GeoJSONGeometry | null | undefined): number[][][] {
  if (!geometry?.type || !geometry.coordinates) return [];
  if (geometry.type === "Polygon") {
    return (geometry.coordinates as number[][][]).filter((r) => r?.length >= 3);
  }
  if (geometry.type === "MultiPolygon") {
    const out: number[][][] = [];
    (geometry.coordinates as number[][][][]).forEach((poly) => {
      poly?.forEach((r) => {
        if (r?.length >= 3) out.push(r);
      });
    });
    return out;
  }
  return [];
}

// 域外遮罩配色:深色主题压暗聚焦,亮白主题用浅白雾(不能是黑色,
// 否则亮白 UI 下地图周边一片黑,图例文字都看不清)
const MASK_DARK = { css: "#060c18", alpha: 0.72 };
const MASK_LIGHT = { css: "#f4f7fb", alpha: 0.55 };

export class BoundaryLayer {
  private viewer: Cesium.Viewer;
  /** 市域外暗色遮罩 + 市界发光描边(仿驾驶舱大屏的区域聚焦效果)。 */
  private cityMask: Cesium.Entity[] = [];
  private maskEntity: Cesium.Entity | null = null;
  private maskLight = false;
  private layers = {
    county: [] as BoundaryItem[],
    countyLabel: [] as Cesium.Entity[],
    township: [] as BoundaryItem[],
    townLabel: [] as Cesium.Entity[],
    village: [] as BoundaryItem[],
    villageLabel: [] as Cesium.Entity[],
  };
  private villageGeojson: {
    features: {
      properties?: Record<string, string>;
      geometry: GeoJSONGeometry;
    }[];
  } | null = null;
  public townshipNames: string[] = [];

  constructor(viewer: Cesium.Viewer) {
    this.viewer = viewer;
  }

  private addBoundary(ring: number[][], type: string, name?: string): BoundaryItem {
    const c = COLORS[type as keyof typeof COLORS] || COLORS.county;
    const lineAlpha = type === "county" ? 0.9 : type === "township" ? 0.7 : 0.6;
    const lineW = type === "county" ? 2.5 * 1.3 : 2.5;
    // 直接用原始 ring,不做任何抽稀 / 平滑,保证与镇界共边精确重合
    const positions = ring.map((p) => Cesium.Cartesian3.fromDegrees(p[0], p[1]));

    const fillOpts: Cesium.Entity.ConstructorOptions = {
      polygon: {
        hierarchy: new Cesium.PolygonHierarchy(positions),
        material:
          type === "county"
            ? Cesium.Color.TRANSPARENT
            : new Cesium.Color(c.r / 255, c.g / 255, c.b / 255, 0.1),
        height: 0,
      },
    };
    if (name) {
      fillOpts.properties = new Cesium.PropertyBag({
        _boundaryType: type,
        _boundaryName: name,
      });
    }
    const fill = this.viewer.entities.add(fillOpts);
    const closed = [...positions, positions[0]];
    const line = this.viewer.entities.add({
      polyline: {
        positions: closed,
        width: lineW,
        material: new Cesium.Color(c.r / 255, c.g / 255, c.b / 255, lineAlpha),
        clampToGround: true,
      },
    });
    return { fill, line, type };
  }

  private addLabel(
    lng: number,
    lat: number,
    text: string,
    opts: {
      scale?: number;
      maxDist?: number;
      minDist?: number;
      color?: string;
      fontSize?: number;
    } = {},
  ) {
    const scale = opts.scale ?? 0.7;
    const maxDist = opts.maxDist ?? 80000;
    const minDist = opts.minDist ?? 0;
    const color = opts.color ?? "rgba(255,200,50,0.95)";
    const fontSize = opts.fontSize ?? 18;
    return this.viewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(lng, lat),
      label: {
        text,
        font: `bold ${fontSize}px "Microsoft YaHei", sans-serif`,
        fillColor: Cesium.Color.fromCssColorString(color),
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 4,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(minDist, maxDist),
        scale,
      },
    });
  }

  /** 市域外遮罩:大矩形挖去市界作为洞,外部压暗;市界用发光线描边。 */
  private addCityMask(fc: {
    features?: {
      properties?: Record<string, string>;
      geometry: { type: string; coordinates: unknown };
    }[];
  }) {
    const rings: number[][][] = [];
    fc.features?.forEach((f) => {
      const g = f.geometry;
      if (!g) return;
      if (g.type === "Polygon") {
        rings.push((g.coordinates as number[][][])[0]);
      } else if (g.type === "MultiPolygon") {
        (g.coordinates as number[][][][]).forEach((poly) => rings.push(poly[0]));
      }
    });
    if (!rings.length) return;

    // 覆盖全国范围的外框即可,不必全球(避免 2D 无限滚动下的接缝问题)
    const outer = [
      [60, 0], [150, 0], [150, 65], [60, 65],
    ].map(([lng, lat]) => Cesium.Cartesian3.fromDegrees(lng, lat));
    const holes = rings.map(
      (r) =>
        new Cesium.PolygonHierarchy(
          r.map((p) => Cesium.Cartesian3.fromDegrees(p[0], p[1])),
        ),
    );
    const mask = this.maskLight ? MASK_LIGHT : MASK_DARK;
    this.maskEntity = this.viewer.entities.add({
      polygon: {
        hierarchy: new Cesium.PolygonHierarchy(outer, holes),
        material: Cesium.Color.fromCssColorString(mask.css).withAlpha(mask.alpha),
        height: 0,
      },
    });
    this.cityMask.push(this.maskEntity);
    // 市界:内层实线 + 外层发光,双线叠出大屏效果
    rings.forEach((r) => {
      const positions = [...r, r[0]].map((p) =>
        Cesium.Cartesian3.fromDegrees(p[0], p[1]),
      );
      this.cityMask.push(
        this.viewer.entities.add({
          polyline: {
            positions,
            width: 12,
            material: new Cesium.PolylineGlowMaterialProperty({
              glowPower: 0.18,
              color: Cesium.Color.fromCssColorString("#ffe14d").withAlpha(0.9),
            }),
            clampToGround: true,
          },
        }),
      );
      this.cityMask.push(
        this.viewer.entities.add({
          polyline: {
            positions,
            width: 2.5,
            material: Cesium.Color.fromCssColorString("#fff3a0"),
            clampToGround: true,
          },
        }),
      );
    });
  }

  async load() {
    if (this.viewer.isDestroyed()) return;
    try {
      // 这些文件在"纯壳子"状态下会 404,这是预期的。后端 access log 里仍会
      // 显示 404,但前端要静默处理。
      // 加上时间戳避免重载时命中浏览器缓存,看不到刚下载的新数据。
      const ts = Date.now();
      const swallow = (url: string) =>
        fetch(`${url}?_=${ts}`).catch(() => new Response(null, { status: 404 }));
      const [cityRes, countyRes, townRes, villageRes] = await Promise.all([
        swallow("/boundaries/city.geojson"),
        swallow("/boundaries/county.geojson"),
        swallow("/boundaries/townships.geojson"),
        swallow("/boundaries/villages.geojson"),
      ]);
      // await 期间 viewer 可能已被销毁,再 add entity 会抛错
      if (this.viewer.isDestroyed()) return;
      if (cityRes.ok) {
        this.addCityMask(await cityRes.json());
      }
      if (countyRes.ok) {
        const county = await countyRes.json();
        county.features?.forEach(
          (f: {
            properties?: Record<string, string>;
            geometry: GeoJSONGeometry;
          }) => {
            // 县名取自 DataV(name/XZQMC)或 step06 输出。一个县多边形只挂一个 label
            // (取面积最大那个 ring 的中心),避免飞地重复显示。
            const name =
              f.properties?.XZQMC ||
              f.properties?.name ||
              f.properties?._county_name ||
              "";
            let mainRing: number[][] | null = null;
            let mainArea = -1;
            extractRings(f.geometry).forEach((ring) => {
              this.layers.county.push(this.addBoundary(ring, "county", name));
              // 用 bbox 近似面积,简单稳健,不需要球面积
              const lngs = ring.map((p) => p[0]);
              const lats = ring.map((p) => p[1]);
              const area =
                (Math.max(...lngs) - Math.min(...lngs)) *
                (Math.max(...lats) - Math.min(...lats));
              if (area > mainArea) {
                mainArea = area;
                mainRing = ring;
              }
            });
            if (name && mainRing) {
              const [cx, cy] = ringCenter(mainRing);
              this.layers.countyLabel.push(
                this.addLabel(cx, cy, name, {
                  scale: 0.85,
                  fontSize: 20,
                  // 县名远视角才有意义,近视角自动消失避免与镇名打架
                  minDist: 30000,
                  maxDist: 1500000,
                  color: "rgba(255,200,50,0.95)",
                }),
              );
            }
          },
        );
      }
      if (townRes.ok) {
        const towns = await townRes.json();
        const namesSet = new Set<string>();
        towns.features?.forEach(
          (f: {
            properties?: Record<string, string>;
            geometry: GeoJSONGeometry;
          }) => {
            const name = f.properties?.XZQMC || f.properties?._township_name || "";
            if (name) namesSet.add(name);
            extractRings(f.geometry).forEach((ring) => {
              this.layers.township.push(this.addBoundary(ring, "township", name));
              if (name) {
                const [cx, cy] = ringCenter(ring);
                this.layers.townLabel.push(
                  this.addLabel(cx, cy, name, {
                    scale: 0.7,
                    fontSize: 18,
                    maxDist: 80000,
                    color: "rgba(160,200,255,0.95)",
                  }),
                );
              }
            });
          },
        );
        this.townshipNames = [...namesSet].sort();
      }
      if (villageRes.ok) {
        this.villageGeojson = await villageRes.json();
      }
    } catch {
      /* 没数据时静默,不打 warn */
    }
  }

  private addVillageLabel(lng: number, lat: number, text: string) {
    return this.addLabel(lng, lat, text, {
      scale: 0.6,
      fontSize: 16,
      maxDist: 30000,
      color: "rgba(180,235,180,0.95)",
    });
  }

  private renderVillages() {
    this.layers.village.forEach((item) => {
      this.viewer.entities.remove(item.fill);
      this.viewer.entities.remove(item.line);
    });
    this.layers.village = [];
    if (!this.villageGeojson) return;
    this.villageGeojson.features.forEach((f) => {
      const name = f.properties?.ZLDWMC || "";
      extractRings(f.geometry).forEach((ring) => {
        this.layers.village.push(this.addBoundary(ring, "village", name));
      });
    });
  }

  private ensureVillageNameLabels() {
    if (this.layers.villageLabel.length > 0) return;
    if (!this.villageGeojson) return;
    this.villageGeojson.features.forEach((f) => {
      const name = f.properties?.ZLDWMC || "";
      if (!name) return;
      const rings = extractRings(f.geometry);
      if (!rings.length) return;
      const [cx, cy] = ringCenter(rings[0]);
      this.layers.villageLabel.push(this.addVillageLabel(cx, cy, name));
    });
  }

  /** 删除所有已渲染的边界 entities,准备重载。 */
  clear(): void {
    if (this.viewer.isDestroyed()) return;
    const removeItem = (it: BoundaryItem) => {
      try {
        this.viewer.entities.remove(it.fill);
        this.viewer.entities.remove(it.line);
      } catch {
        /* ignore */
      }
    };
    this.layers.county.forEach(removeItem);
    this.layers.township.forEach(removeItem);
    this.layers.village.forEach(removeItem);
    [
      ...this.cityMask,
      ...this.layers.countyLabel,
      ...this.layers.townLabel,
      ...this.layers.villageLabel,
    ].forEach((e) => {
      try {
        this.viewer.entities.remove(e);
      } catch {
        /* ignore */
      }
    });
    this.cityMask = [];
    this.maskEntity = null;
    this.layers = {
      county: [],
      countyLabel: [],
      township: [],
      townLabel: [],
      village: [],
      villageLabel: [],
    };
    this.villageGeojson = null;
    this.townshipNames = [];
    this.viewer.scene.requestRender();
  }

  /** 删除当前并重新拉取 /boundaries/*.geojson。 */
  async reload(): Promise<void> {
    this.clear();
    await this.load();
  }

  /** 主题切换:亮白用浅色遮罩,深色主题恢复压暗遮罩。 */
  setMaskTheme(light: boolean): void {
    // MapView 的异步 .then 回调可能在 viewer 销毁后才执行
    if (this.viewer.isDestroyed()) return;
    this.maskLight = light;
    if (this.maskEntity?.polygon) {
      const mask = light ? MASK_LIGHT : MASK_DARK;
      this.maskEntity.polygon.material = new Cesium.ColorMaterialProperty(
        Cesium.Color.fromCssColorString(mask.css).withAlpha(mask.alpha),
      );
      this.viewer.scene.requestRender();
    }
  }

  setVisibility(opts: {
    county: boolean;
    countyName: boolean;
    township: boolean;
    townshipName: boolean;
    village: boolean;
    villageName: boolean;
  }) {
    if (this.viewer.isDestroyed()) return;
    this.layers.county.forEach((it) => {
      it.fill.show = opts.county;
      it.line.show = opts.county;
    });
    this.layers.countyLabel.forEach((e) => (e.show = opts.countyName));

    this.layers.township.forEach((it) => {
      it.fill.show = opts.township;
      it.line.show = opts.township;
    });
    this.layers.townLabel.forEach((e) => (e.show = opts.townshipName));

    if (opts.village && this.layers.village.length === 0) this.renderVillages();
    this.layers.village.forEach((it) => {
      it.fill.show = opts.village;
      it.line.show = opts.village;
    });
    if (opts.villageName) this.ensureVillageNameLabels();
    this.layers.villageLabel.forEach((e) => (e.show = opts.villageName));
    this.viewer.scene.requestRender();
  }
}
