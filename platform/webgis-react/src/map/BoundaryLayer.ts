import * as Cesium from "cesium";

type Coordinate = [number, number];
type Ring = Coordinate[];
type Polygon = Ring[];
type BoundaryLevel = "county" | "township" | "village";

interface LinePath {
  points: Ring;
  loop: boolean;
}

interface GeoJSONGeometry {
  type?: string;
  coordinates?: unknown;
}

interface BoundaryFeature {
  properties?: Record<string, unknown>;
  geometry?: GeoJSONGeometry;
}

interface FeatureCollection {
  features?: BoundaryFeature[];
}

interface BoundaryVisibility {
  county: boolean;
  countyName: boolean;
  township: boolean;
  townshipName: boolean;
  village: boolean;
  villageName: boolean;
}

interface LodState {
  countyName: boolean;
  township: boolean;
  townshipName: boolean;
  village: boolean;
  villageName: boolean;
}

type LineStyle =
  | {
      kind: "outline";
      width: number;
      color: string;
      alpha: number;
      outlineColor: string;
      outlineAlpha: number;
      outlineWidth: number;
    }
  | {
      kind: "dash";
      width: number;
      color: string;
      alpha: number;
      dashLength: number;
      dashPattern: number;
    };

const COUNTY_STYLE: LineStyle = {
  kind: "outline",
  width: 3,
  color: "#e6c36a",
  alpha: 0.9,
  outlineColor: "#18212c",
  outlineAlpha: 0.42,
  outlineWidth: 1,
};

const TOWNSHIP_STYLE: LineStyle = {
  kind: "dash",
  width: 1.5,
  color: "#78909c",
  alpha: 0.74,
  dashLength: 16,
  dashPattern: 0xf0f0,
};

const VILLAGE_STYLE: LineStyle = {
  kind: "dash",
  width: 1,
  color: "#82978a",
  alpha: 0.58,
  dashLength: 8,
  dashPattern: 0xaaaa,
};

const TOWNSHIP_MAX_HEIGHT = 180_000;
const VILLAGE_MAX_HEIGHT = 45_000;
const COUNTY_NAME_MIN_HEIGHT = 25_000;
const COUNTY_NAME_MAX_HEIGHT = 500_000;
const TOWNSHIP_NAME_MAX_HEIGHT = 100_000;
// 下钻进镇级视图时相机约 20~35km,阈值需覆盖到,否则村名只有贴地才出现
const VILLAGE_NAME_MAX_HEIGHT = 32_000;
const PRIMITIVE_BATCH_SIZE = 350;

// 域外遮罩配色：深色主题压暗聚焦，亮白主题使用浅雾。
const MASK_DARK = { css: "#060c18", alpha: 0.72 };
const MASK_LIGHT = { css: "#f4f7fb", alpha: 0.55 };

function polygonsFromGeometry(geometry?: GeoJSONGeometry): Polygon[] {
  if (!geometry?.coordinates) return [];
  if (geometry.type === "Polygon") {
    return [geometry.coordinates as Polygon];
  }
  if (geometry.type === "MultiPolygon") {
    return geometry.coordinates as Polygon[];
  }
  return [];
}

function sameCoordinate(a: Coordinate, b: Coordinate): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

/**
 * GeoJSON ring 通常已经首尾闭合。GroundPolylineGeometry 使用 loop 自行闭合，
 * 因此移除重复尾点和连续重复点，避免生成零长度线段。
 */
function normalizeRing(ring: Ring): Ring {
  const out: Ring = [];
  ring.forEach((point) => {
    const lng = Number(point?.[0]);
    const lat = Number(point?.[1]);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return;
    const next: Coordinate = [lng, lat];
    if (!out.length || !sameCoordinate(out[out.length - 1], next)) out.push(next);
  });
  if (out.length > 1 && sameCoordinate(out[0], out[out.length - 1])) out.pop();
  return out;
}

function coordinateKey(point: Coordinate): string {
  return `${point[0]},${point[1]}`;
}

/**
 * Polygon features on both sides of an administrative boundary carry the
 * same segment.  Drawing every ring therefore makes shared borders darker.
 * Collapse identical undirected segments and chain the resulting graph back
 * into continuous paths so the GPU still receives a small number of geometry
 * instances instead of hundreds of thousands of two-point lines.
 */
function lineNetworkFromRings(rings: Ring[]): LinePath[] {
  const vertices = new Map<string, Coordinate>();
  const uniqueSegments = new Map<string, [string, string]>();

  rings.forEach((ring) => {
    for (let index = 0; index < ring.length; index += 1) {
      const a = ring[index];
      const b = ring[(index + 1) % ring.length];
      if (sameCoordinate(a, b)) continue;
      const aKey = coordinateKey(a);
      const bKey = coordinateKey(b);
      vertices.set(aKey, a);
      vertices.set(bKey, b);
      const segmentKey = aKey < bKey ? `${aKey}|${bKey}` : `${bKey}|${aKey}`;
      if (!uniqueSegments.has(segmentKey)) {
        uniqueSegments.set(segmentKey, aKey < bKey ? [aKey, bKey] : [bKey, aKey]);
      }
    }
  });

  const edges = [...uniqueSegments.values()].map(([a, b]) => ({ a, b }));
  const adjacency = new Map<string, number[]>();
  edges.forEach((edge, edgeIndex) => {
    const aEdges = adjacency.get(edge.a) || [];
    aEdges.push(edgeIndex);
    adjacency.set(edge.a, aEdges);
    const bEdges = adjacency.get(edge.b) || [];
    bEdges.push(edgeIndex);
    adjacency.set(edge.b, bEdges);
  });

  const used = new Uint8Array(edges.length);
  const paths: LinePath[] = [];

  const follow = (startVertex: string, startEdge: number): LinePath | null => {
    const keys = [startVertex];
    let currentVertex = startVertex;
    let currentEdge = startEdge;

    while (!used[currentEdge]) {
      used[currentEdge] = 1;
      const edge = edges[currentEdge];
      const nextVertex = edge.a === currentVertex ? edge.b : edge.a;
      keys.push(nextVertex);
      if (nextVertex === startVertex) {
        const points = keys.slice(0, -1).map((key) => vertices.get(key) as Coordinate);
        return points.length >= 3 ? { points, loop: true } : null;
      }

      const incident = adjacency.get(nextVertex) || [];
      const nextEdges = incident.filter((edgeIndex) => !used[edgeIndex]);
      if (incident.length !== 2 || nextEdges.length === 0) {
        const points = keys.map((key) => vertices.get(key) as Coordinate);
        return points.length >= 2 ? { points, loop: false } : null;
      }
      currentVertex = nextVertex;
      currentEdge = nextEdges[0];
    }
    return null;
  };

  adjacency.forEach((edgeIndexes, vertex) => {
    if (edgeIndexes.length === 2) return;
    edgeIndexes.forEach((edgeIndex) => {
      if (used[edgeIndex]) return;
      const path = follow(vertex, edgeIndex);
      if (path) paths.push(path);
    });
  });

  edges.forEach((edge, edgeIndex) => {
    if (used[edgeIndex]) return;
    const path = follow(edge.a, edgeIndex);
    if (path) paths.push(path);
  });
  return paths;
}

function ringArea(ring: Ring): number {
  let area = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[(i + 1) % ring.length];
    area += x0 * y1 - x1 * y0;
  }
  return Math.abs(area / 2);
}

function ringCenter(ring: Ring): Coordinate {
  let west = Number.POSITIVE_INFINITY;
  let south = Number.POSITIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;
  ring.forEach(([lng, lat]) => {
    west = Math.min(west, lng);
    south = Math.min(south, lat);
    east = Math.max(east, lng);
    north = Math.max(north, lat);
  });
  if (!Number.isFinite(west)) return [0, 0];
  return [(west + east) / 2, (south + north) / 2];
}

function featureLabelPoint(feature: BoundaryFeature, polygons: Polygon[]): Coordinate | null {
  const properties = feature.properties || {};
  // New standard assets use label_lng/label_lat; keep the underscored aliases
  // for boundary files imported by earlier releases.
  const rawLng = properties.label_lng ?? properties._label_lng;
  const rawLat = properties.label_lat ?? properties._label_lat;
  const configuredLng = Number(rawLng);
  const configuredLat = Number(rawLat);
  if (
    rawLng !== null
    && rawLng !== undefined
    && rawLng !== ""
    && rawLat !== null
    && rawLat !== undefined
    && rawLat !== ""
    && Number.isFinite(configuredLng)
    && Number.isFinite(configuredLat)
  ) {
    return [configuredLng, configuredLat];
  }

  const largestOuter = polygons
    .map((polygon) => normalizeRing(polygon[0] || []))
    .filter((ring) => ring.length >= 3)
    .sort((a, b) => ringArea(b) - ringArea(a))[0];
  return largestOuter ? ringCenter(largestOuter) : null;
}

function featureName(feature: BoundaryFeature, level: BoundaryLevel): string {
  const p = feature.properties || {};
  if (level === "county") {
    return String(p.XZQMC || p.name || p._county_name || "").trim();
  }
  if (level === "township") {
    return String(p.XZQMC || p._township_name || p.ZLDWMC || p.name || "").trim();
  }
  return String(p.ZLDWMC || p.XZQMC || p.name || "").trim();
}

function color(css: string, alpha: number): Cesium.Color {
  return Cesium.Color.fromCssColorString(css).withAlpha(alpha);
}

function materialFor(style: LineStyle): Cesium.Material {
  if (style.kind === "outline") {
    return Cesium.Material.fromType("PolylineOutline", {
      color: color(style.color, style.alpha),
      outlineColor: color(style.outlineColor, style.outlineAlpha),
      outlineWidth: style.outlineWidth,
    });
  }
  return Cesium.Material.fromType("PolylineDash", {
    color: color(style.color, style.alpha),
    gapColor: Cesium.Color.TRANSPARENT,
    dashLength: style.dashLength,
    dashPattern: style.dashPattern,
  });
}

function sameLod(a: LodState | null, b: LodState): boolean {
  return !!a
    && a.countyName === b.countyName
    && a.township === b.township
    && a.townshipName === b.townshipName
    && a.village === b.village
    && a.villageName === b.villageName;
}

/**
 * 行政边界渲染层。
 *
 * - 线使用按层批处理的 GroundPolylinePrimitive，避免一条 ring 两个 Entity。
 * - 标签仍使用少量 Entity，按 feature 只创建一个。
 * - 缩放显隐统一由相机高度控制，仅在 moveEnd 跨 LOD 档时切换。
 * - 村界数据在用户启用且进入近景前不会请求或构建。
 */
export class BoundaryLayer {
  private viewer: Cesium.Viewer;
  private cityEntities: Cesium.Entity[] = [];
  private maskEntity: Cesium.Entity | null = null;
  private maskLight = false;
  private primitives: Record<BoundaryLevel, Cesium.GroundPolylinePrimitive[]> = {
    county: [],
    township: [],
    village: [],
  };
  private labels: Record<BoundaryLevel, Cesium.Entity[]> = {
    county: [],
    township: [],
    village: [],
  };
  private visibility: BoundaryVisibility = {
    county: false,
    countyName: false,
    township: false,
    townshipName: false,
    village: false,
    villageName: false,
  };
  private lod: LodState | null = null;
  private removeMoveEnd: (() => void) | null = null;
  private generation = 0;
  private loadPromise: Promise<void> | null = null;
  private villageLoadPromise: Promise<void> | null = null;
  private villageCollection: FeatureCollection | null = null;
  private villageLinesBuilt = false;
  private villageLabelsBuilt = false;
  private destroyed = false;
  public townshipNames: string[] = [];

  constructor(viewer: Cesium.Viewer) {
    this.viewer = viewer;
    this.removeMoveEnd = viewer.camera.moveEnd.addEventListener(() => {
      this.updateLod();
    });
    this.updateLod(true);
  }

  private cameraHeight(): number {
    const height = Number(this.viewer.camera.positionCartographic?.height);
    return Number.isFinite(height) ? Math.max(0, height) : Number.POSITIVE_INFINITY;
  }

  private computeLod(): LodState {
    const height = this.cameraHeight();
    return {
      countyName: height >= COUNTY_NAME_MIN_HEIGHT && height <= COUNTY_NAME_MAX_HEIGHT,
      township: height <= TOWNSHIP_MAX_HEIGHT,
      townshipName: height <= TOWNSHIP_NAME_MAX_HEIGHT,
      village: height <= VILLAGE_MAX_HEIGHT,
      villageName: height <= VILLAGE_NAME_MAX_HEIGHT,
    };
  }

  private updateLod(force = false): void {
    if (this.destroyed || this.viewer.isDestroyed()) return;
    const next = this.computeLod();
    if (!force && sameLod(this.lod, next)) return;
    this.lod = next;
    this.applyVisibility();
  }

  private setPrimitiveShow(
    primitives: Cesium.GroundPolylinePrimitive[],
    show: boolean,
  ): boolean {
    let changed = false;
    primitives.forEach((primitive) => {
      if (primitive.show !== show) {
        primitive.show = show;
        changed = true;
      }
    });
    return changed;
  }

  private setEntityShow(entities: Cesium.Entity[], show: boolean): boolean {
    let changed = false;
    entities.forEach((entity) => {
      if (entity.show !== show) {
        entity.show = show;
        changed = true;
      }
    });
    return changed;
  }

  private applyVisibility(): void {
    if (this.destroyed || this.viewer.isDestroyed()) return;
    const lod = this.lod || this.computeLod();
    let changed = false;
    changed = this.setPrimitiveShow(this.primitives.county, this.visibility.county) || changed;
    changed = this.setPrimitiveShow(
      this.primitives.township,
      this.visibility.township && lod.township,
    ) || changed;
    changed = this.setPrimitiveShow(
      this.primitives.village,
      this.visibility.village && lod.village,
    ) || changed;
    changed = this.setEntityShow(
      this.labels.county,
      this.visibility.countyName && lod.countyName,
    ) || changed;
    changed = this.setEntityShow(
      this.labels.township,
      this.visibility.townshipName && lod.townshipName,
    ) || changed;
    changed = this.setEntityShow(
      this.labels.village,
      this.visibility.villageName && lod.villageName,
    ) || changed;

    const needsVillageLines = this.visibility.village && lod.village;
    const needsVillageLabels = this.visibility.villageName && lod.villageName;
    if (needsVillageLines || needsVillageLabels) {
      if (this.villageCollection) {
        let built = false;
        if (needsVillageLines && !this.villageLinesBuilt) {
          this.buildVillageLines(this.villageCollection);
          built = true;
        }
        if (needsVillageLabels && !this.villageLabelsBuilt) {
          this.buildVillageLabels(this.villageCollection);
          built = true;
        }
        if (built) {
          this.ensurePrimitiveOrder();
          changed = this.setPrimitiveShow(this.primitives.village, needsVillageLines) || changed;
          changed = this.setEntityShow(this.labels.village, needsVillageLabels) || changed;
        }
      } else {
        void this.ensureVillages();
      }
    }
    if (changed) this.viewer.scene.requestRender();
  }

  private async fetchCollection(name: string, stamp: number): Promise<FeatureCollection | null> {
    try {
      const response = await fetch(`/boundaries/${name}.geojson?_=${stamp}`, {
        cache: "no-store",
      });
      if (!response.ok) return null;
      const data = await response.json();
      return data && typeof data === "object" ? data as FeatureCollection : null;
    } catch {
      return null;
    }
  }

  load(): Promise<void> {
    if (this.destroyed) return Promise.resolve();
    if (this.loadPromise) return this.loadPromise;
    const generation = this.generation;
    this.loadPromise = this.loadInternal(generation);
    return this.loadPromise;
  }

  private async loadInternal(generation: number): Promise<void> {
    const stamp = Date.now();
    const [city, county, township] = await Promise.all([
      this.fetchCollection("city", stamp),
      this.fetchCollection("county", stamp),
      this.fetchCollection("townships", stamp),
    ]);
    if (
      this.destroyed
      || generation !== this.generation
      || this.viewer.isDestroyed()
    ) return;

    try {
      if (city) this.addCityMask(city);
      if (county) this.buildLevel(county, "county", COUNTY_STYLE);
      if (township) this.buildLevel(township, "township", TOWNSHIP_STYLE);
      this.ensurePrimitiveOrder();
      this.updateLod(true);
      this.viewer.scene.requestRender();
    } catch {
      // 单个边界文件格式异常时保持其它图层可用。
    }
  }

  private buildLevel(
    collection: FeatureCollection,
    level: "county" | "township",
    style: LineStyle,
  ): void {
    const rings: Ring[] = [];
    const names = new Set<string>();
    collection.features?.forEach((feature) => {
      const polygons = polygonsFromGeometry(feature.geometry);
      polygons.forEach((polygon) => {
        polygon.forEach((ring) => {
          const normalized = normalizeRing(ring);
          if (normalized.length >= 3) rings.push(normalized);
        });
      });

      const name = featureName(feature, level);
      if (!name) return;
      names.add(name);
      const point = featureLabelPoint(feature, polygons);
      if (point) this.labels[level].push(this.addLabel(point[0], point[1], name, level));
    });
    this.addLinePrimitives(level, rings, style);
    if (level === "township") this.townshipNames = [...names].sort();
  }

  private async ensureVillages(): Promise<void> {
    if (
      this.destroyed
      || this.villageLoadPromise
      || this.villageCollection
      || this.viewer.isDestroyed()
    ) return;
    const generation = this.generation;
    const task = (async () => {
      const collection = await this.fetchCollection("villages", Date.now());
      if (
        !collection
        || this.destroyed
        || generation !== this.generation
        || this.viewer.isDestroyed()
      ) return;
      this.villageCollection = collection;
      this.updateLod(true);
      this.viewer.scene.requestRender();
    })();
    this.villageLoadPromise = task;
    try {
      await task;
    } finally {
      if (this.villageLoadPromise === task) this.villageLoadPromise = null;
    }
  }

  private buildVillageLines(collection: FeatureCollection): void {
    const rings: Ring[] = [];
    collection.features?.forEach((feature) => {
      const polygons = polygonsFromGeometry(feature.geometry);
      polygons.forEach((polygon) => {
        polygon.forEach((ring) => {
          const normalized = normalizeRing(ring);
          if (normalized.length >= 3) rings.push(normalized);
        });
      });
    });
    this.addLinePrimitives("village", rings, VILLAGE_STYLE);
    this.villageLinesBuilt = true;
  }

  private buildVillageLabels(collection: FeatureCollection): void {
    collection.features?.forEach((feature) => {
      const polygons = polygonsFromGeometry(feature.geometry);
      const name = featureName(feature, "village");
      if (!name) return;
      const point = featureLabelPoint(feature, polygons);
      if (point) {
        this.labels.village.push(this.addLabel(point[0], point[1], name, "village"));
      }
    });
    this.villageLabelsBuilt = true;
  }

  private addLinePrimitives(
    level: BoundaryLevel,
    rings: Ring[],
    style: LineStyle,
  ): void {
    if (!rings.length || this.viewer.isDestroyed()) return;
    const paths = lineNetworkFromRings(rings);
    for (let offset = 0; offset < paths.length; offset += PRIMITIVE_BATCH_SIZE) {
      const instances: Cesium.GeometryInstance[] = [];
      paths.slice(offset, offset + PRIMITIVE_BATCH_SIZE).forEach((path) => {
        const positions = path.points.map(([lng, lat]) => Cesium.Cartesian3.fromDegrees(lng, lat));
        if (positions.length < 2) return;
        instances.push(new Cesium.GeometryInstance({
          geometry: new Cesium.GroundPolylineGeometry({
            positions,
            width: style.width,
            loop: path.loop,
            arcType: Cesium.ArcType.GEODESIC,
          }),
        }));
      });
      if (!instances.length) continue;
      const primitive = new Cesium.GroundPolylinePrimitive({
        geometryInstances: instances,
        appearance: new Cesium.PolylineMaterialAppearance({
          material: materialFor(style),
          translucent: true,
        }),
        show: false,
        interleave: true,
        releaseGeometryInstances: true,
        allowPicking: false,
        asynchronous: true,
        classificationType: Cesium.ClassificationType.TERRAIN,
      });
      this.viewer.scene.groundPrimitives.add(primitive);
      this.primitives[level].push(primitive);
    }
  }

  /** 村 < 镇 < 县；村界延迟加入后也重新把高层级提到顶部。 */
  private ensurePrimitiveOrder(): void {
    if (this.viewer.isDestroyed()) return;
    const collection = this.viewer.scene.groundPrimitives;
    (["village", "township", "county"] as BoundaryLevel[]).forEach((level) => {
      this.primitives[level].forEach((primitive) => {
        try {
          collection.raiseToTop(primitive);
        } catch {
          /* primitive 可能已在异步 reload 中移除 */
        }
      });
    });
  }

  private addLabel(
    lng: number,
    lat: number,
    text: string,
    level: BoundaryLevel,
  ): Cesium.Entity {
    const style = level === "county"
      ? { fontSize: 17, scale: 0.9, fill: "#f2d17e", outlineWidth: 3 }
      : level === "township"
        ? { fontSize: 14, scale: 0.82, fill: "#cedee9", outlineWidth: 2 }
        : { fontSize: 12, scale: 0.8, fill: "#cbdacc", outlineWidth: 2 };
    return this.viewer.entities.add({
      show: false,
      position: Cesium.Cartesian3.fromDegrees(lng, lat),
      label: {
        text,
        font: `600 ${style.fontSize}px "Microsoft YaHei", sans-serif`,
        fillColor: Cesium.Color.fromCssColorString(style.fill),
        outlineColor: Cesium.Color.BLACK.withAlpha(0.72),
        outlineWidth: style.outlineWidth,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        scale: style.scale,
      },
    });
  }

  /** 市域外遮罩：大矩形挖去市域，市界使用弱光晕和细芯线。 */
  private addCityMask(collection: FeatureCollection): void {
    const rings: Ring[] = [];
    collection.features?.forEach((feature) => {
      polygonsFromGeometry(feature.geometry).forEach((polygon) => {
        const outer = normalizeRing(polygon[0] || []);
        if (outer.length >= 3) rings.push(outer);
      });
    });
    if (!rings.length) return;

    const outer = [
      [60, 0],
      [150, 0],
      [150, 65],
      [60, 65],
    ].map(([lng, lat]) => Cesium.Cartesian3.fromDegrees(lng, lat));
    const holes = rings.map((ring) => new Cesium.PolygonHierarchy(
      ring.map(([lng, lat]) => Cesium.Cartesian3.fromDegrees(lng, lat)),
    ));
    const mask = this.maskLight ? MASK_LIGHT : MASK_DARK;
    this.maskEntity = this.viewer.entities.add({
      polygon: {
        hierarchy: new Cesium.PolygonHierarchy(outer, holes),
        material: Cesium.Color.fromCssColorString(mask.css).withAlpha(mask.alpha),
        height: 0,
      },
    });
    this.cityEntities.push(this.maskEntity);

    rings.forEach((ring) => {
      const positions = ring.map(([lng, lat]) => Cesium.Cartesian3.fromDegrees(lng, lat));
      positions.push(positions[0]);
      this.cityEntities.push(this.viewer.entities.add({
        polyline: {
          positions,
          width: 6,
          material: new Cesium.PolylineGlowMaterialProperty({
            glowPower: 0.11,
            color: Cesium.Color.fromCssColorString("#f0cc65").withAlpha(0.35),
          }),
          clampToGround: true,
        },
      }));
      this.cityEntities.push(this.viewer.entities.add({
        polyline: {
          positions,
          width: 2.2,
          material: Cesium.Color.fromCssColorString("#f2d58a").withAlpha(0.92),
          clampToGround: true,
        },
      }));
    });
  }

  /** 主题切换：亮白用浅色遮罩，深色主题恢复压暗遮罩。 */
  setMaskTheme(light: boolean): void {
    if (this.destroyed || this.viewer.isDestroyed()) return;
    this.maskLight = light;
    if (this.maskEntity?.polygon) {
      const mask = light ? MASK_LIGHT : MASK_DARK;
      this.maskEntity.polygon.material = new Cesium.ColorMaterialProperty(
        Cesium.Color.fromCssColorString(mask.css).withAlpha(mask.alpha),
      );
      this.viewer.scene.requestRender();
    }
  }

  setVisibility(opts: BoundaryVisibility): void {
    if (this.destroyed) return;
    this.visibility = { ...opts };
    this.updateLod(true);
  }

  private removePrimitiveList(primitives: Cesium.GroundPolylinePrimitive[]): void {
    if (!this.viewer.isDestroyed()) {
      primitives.forEach((primitive) => {
        try {
          this.viewer.scene.groundPrimitives.remove(primitive);
        } catch {
          /* ignore */
        }
      });
    }
    primitives.length = 0;
  }

  /** 删除所有已渲染边界，保留用户开关，供 reload 重新加载。 */
  clear(): void {
    this.generation += 1;
    this.loadPromise = null;
    this.villageLoadPromise = null;
    this.villageCollection = null;
    this.villageLinesBuilt = false;
    this.villageLabelsBuilt = false;
    this.lod = null;

    this.removePrimitiveList(this.primitives.county);
    this.removePrimitiveList(this.primitives.township);
    this.removePrimitiveList(this.primitives.village);

    if (!this.viewer.isDestroyed()) {
      [
        ...this.cityEntities,
        ...this.labels.county,
        ...this.labels.township,
        ...this.labels.village,
      ].forEach((entity) => {
        try {
          this.viewer.entities.remove(entity);
        } catch {
          /* ignore */
        }
      });
    }
    this.cityEntities = [];
    this.labels = { county: [], township: [], village: [] };
    this.maskEntity = null;
    this.townshipNames = [];
    if (!this.viewer.isDestroyed()) this.viewer.scene.requestRender();
  }

  async reload(): Promise<void> {
    if (this.destroyed) return;
    this.clear();
    await this.load();
  }

  destroy(): void {
    if (this.destroyed) return;
    try {
      this.removeMoveEnd?.();
    } catch {
      /* viewer 可能已先销毁 */
    }
    this.removeMoveEnd = null;
    this.clear();
    this.destroyed = true;
  }
}
