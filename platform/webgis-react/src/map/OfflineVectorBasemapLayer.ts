import * as Cesium from "cesium";

type Coordinate = [number, number];
type Ring = Coordinate[];
type Polygon = Ring[];

interface LiteVectorItem {
  name?: string;
  len_km?: number;
  pts?: Coordinate[];
}

interface LiteVectorLayer {
  kind?: "line" | "poly";
  items?: LiteVectorItem[];
}

interface GeoJsonGeometry {
  type?: "Polygon" | "MultiPolygon" | string;
  coordinates?: unknown;
}

interface GeoJsonFeature {
  properties?: Record<string, unknown>;
  geometry?: GeoJsonGeometry;
}

interface FeatureCollection {
  features?: GeoJsonFeature[];
}

interface Bounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

interface CountyRegion {
  name: string;
  polygons: Polygon[];
  bounds: Bounds;
  rectangle: Cesium.Rectangle;
}

const ASSET_ROOT = "/static/vector_basemap";
const FALLBACK_BOUNDS: Bounds = {
  west: 115.87,
  south: 34.43,
  east: 117.6,
  north: 36.0,
};

const COLORS = {
  cityFill: "#fbfaf6",
  cityBorder: "#4d5560",
  countyBorder: "#aeb6c0",
  countyLabel: "#59636e",
  water: "#88b8d9",
  waterFill: "#cfe4f3",
  motorway: "#d59a50",
  railway: "#747b84",
};

function runtimeBounds(): Bounds {
  const configured = window.__PLATFORM_CONFIG?.geo?.bounds;
  if (
    configured &&
    configured.west < configured.east &&
    configured.south < configured.north
  ) {
    return configured;
  }
  return FALLBACK_BOUNDS;
}

function expandedBounds(bounds: Bounds, ratio = 0.08): Bounds {
  const padLng = (bounds.east - bounds.west) * ratio;
  const padLat = (bounds.north - bounds.south) * ratio;
  return {
    west: bounds.west - padLng,
    south: bounds.south - padLat,
    east: bounds.east + padLng,
    north: bounds.north + padLat,
  };
}

function boundsFromCoordinates(points: Coordinate[]): Bounds | null {
  if (!points.length) return null;
  let west = Number.POSITIVE_INFINITY;
  let south = Number.POSITIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;
  points.forEach(([lng, lat]) => {
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return;
    west = Math.min(west, lng);
    south = Math.min(south, lat);
    east = Math.max(east, lng);
    north = Math.max(north, lat);
  });
  if (!Number.isFinite(west)) return null;
  return { west, south, east, north };
}

function intersects(a: Bounds, b: Bounds): boolean {
  return !(
    a.east < b.west ||
    a.west > b.east ||
    a.north < b.south ||
    a.south > b.north
  );
}

function polygonsFromGeometry(geometry?: GeoJsonGeometry): Polygon[] {
  if (!geometry?.coordinates) return [];
  if (geometry.type === "Polygon") {
    return [geometry.coordinates as Polygon];
  }
  if (geometry.type === "MultiPolygon") {
    return geometry.coordinates as Polygon[];
  }
  return [];
}

function centroidOfRing(ring: Ring): Coordinate {
  let twiceArea = 0;
  let x = 0;
  let y = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[(i + 1) % ring.length];
    const cross = x0 * y1 - x1 * y0;
    twiceArea += cross;
    x += (x0 + x1) * cross;
    y += (y0 + y1) * cross;
  }
  if (Math.abs(twiceArea) < 1e-12) {
    const b = boundsFromCoordinates(ring);
    return b
      ? [(b.west + b.east) / 2, (b.south + b.north) / 2]
      : [0, 0];
  }
  return [x / (3 * twiceArea), y / (3 * twiceArea)];
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

function featureName(feature: GeoJsonFeature): string {
  const p = feature.properties || {};
  return String(p.XZQMC || p.name || p._county_name || "").trim();
}

function toPositions(ring: Ring): Cesium.Cartesian3[] {
  return ring.map(([lng, lat]) => Cesium.Cartesian3.fromDegrees(lng, lat));
}

function toHierarchy(polygon: Polygon): Cesium.PolygonHierarchy {
  const outer = toPositions(polygon[0] || []);
  const holes = polygon.slice(1).map(
    (ring) => new Cesium.PolygonHierarchy(toPositions(ring)),
  );
  return new Cesium.PolygonHierarchy(outer, holes);
}

/**
 * 从桌面端移植的真正离线矢量底图。
 *
 * 数据仍保持轻量 GeoJSON-lite，不经过在线瓦片服务；只绘制配置范围附近
 * 的水系、湖泊、高速和铁路，避免把全省要素全部塞进当前济宁视图。
 */
export class OfflineVectorBasemapLayer {
  private viewer: Cesium.Viewer;
  private dataSource = new Cesium.CustomDataSource("offline-vector-basemap");
  private opacity = 0.9;
  private counties: CountyRegion[] = [];
  private countyLineEntities: Cesium.Entity[] = [];
  private countyLabelEntities: Cesium.Entity[] = [];
  private suppressCountyLines = false;
  private suppressCountyLabels = false;
  private loading: Promise<void> | null = null;
  private addPromise: Promise<Cesium.DataSource>;
  private destroyed = false;

  constructor(viewer: Cesium.Viewer) {
    this.viewer = viewer;
    this.dataSource.show = false;
    this.addPromise = viewer.dataSources.add(this.dataSource);
    void this.addPromise
      .then((added) => {
        if (this.destroyed && !viewer.isDestroyed()) {
          viewer.dataSources.remove(added, true);
        }
      })
      .catch(() => {
        /* Viewer 在异步 add 完成前销毁时忽略 */
      });
  }

  load(): Promise<void> {
    if (this.loading) return this.loading;
    this.loading = this.loadInternal();
    return this.loading;
  }

  private async loadInternal(): Promise<void> {
    const getJson = async <T,>(name: string): Promise<T> => {
      const response = await fetch(`${ASSET_ROOT}/${name}`, { cache: "force-cache" });
      if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
      return response.json() as Promise<T>;
    };

    const [city, county, rivers, lakes, motorway, railway] = await Promise.all([
      getJson<FeatureCollection>("city.geojson"),
      getJson<FeatureCollection>("county.geojson"),
      getJson<LiteVectorLayer>("rivers.json"),
      getJson<LiteVectorLayer>("lakes.json"),
      getJson<LiteVectorLayer>("motorway.json"),
      getJson<LiteVectorLayer>("railway.json"),
    ]);
    if (this.destroyed || this.viewer.isDestroyed()) return;

    this.addCity(city);
    this.addLiteLayer(lakes, "lakes");
    this.addLiteLayer(rivers, "rivers");
    this.addLiteLayer(motorway, "motorway");
    this.addLiteLayer(railway, "railway");
    this.addCounties(county);
    this.viewer.scene.requestRender();
  }

  private dynamicColor(css: string, alpha: number): Cesium.CallbackProperty {
    const base = Cesium.Color.fromCssColorString(css);
    return new Cesium.CallbackProperty(
      () => base.withAlpha(Math.max(0, Math.min(1, alpha * this.opacity))),
      false,
    );
  }

  private material(css: string, alpha: number): Cesium.ColorMaterialProperty {
    return new Cesium.ColorMaterialProperty(this.dynamicColor(css, alpha));
  }

  private addCity(collection: FeatureCollection): void {
    collection.features?.forEach((feature) => {
      polygonsFromGeometry(feature.geometry).forEach((polygon) => {
        if (!polygon[0]?.length) return;
        this.dataSource.entities.add({
          polygon: {
            hierarchy: toHierarchy(polygon),
            material: this.material(COLORS.cityFill, 0.98),
            zIndex: 0,
          },
        });
        polygon.forEach((ring) => {
          if (ring.length < 2) return;
          this.dataSource.entities.add({
            polyline: {
              positions: toPositions(ring),
              width: 2.2,
              material: this.material(COLORS.cityBorder, 0.95),
              clampToGround: true,
            },
          });
        });
      });
    });
  }

  private addCounties(collection: FeatureCollection): void {
    const regions: CountyRegion[] = [];
    collection.features?.forEach((feature) => {
      const name = featureName(feature);
      const polygons = polygonsFromGeometry(feature.geometry).filter(
        (polygon) => polygon[0]?.length >= 3,
      );
      if (!name || !polygons.length) return;
      const allPoints = polygons.flatMap((polygon) => polygon.flat());
      const bounds = boundsFromCoordinates(allPoints);
      if (!bounds) return;
      regions.push({
        name,
        polygons,
        bounds,
        rectangle: Cesium.Rectangle.fromDegrees(
          bounds.west,
          bounds.south,
          bounds.east,
          bounds.north,
        ),
      });

      polygons.forEach((polygon) => {
        polygon.forEach((ring) => {
          if (ring.length < 2) return;
          const line = this.dataSource.entities.add({
            show: !this.suppressCountyLines,
            polyline: {
              positions: toPositions(ring),
              width: 1.2,
              material: this.material(COLORS.countyBorder, 0.92),
              clampToGround: true,
            },
          });
          this.countyLineEntities.push(line);
        });
      });

      const largestOuter = polygons
        .map((polygon) => polygon[0])
        .sort((a, b) => ringArea(b) - ringArea(a))[0];
      const rawLng = feature.properties?.label_lng ?? feature.properties?._label_lng;
      const rawLat = feature.properties?.label_lat ?? feature.properties?._label_lat;
      const configuredLng = Number(rawLng);
      const configuredLat = Number(rawLat);
      const [lng, lat] = rawLng !== null
        && rawLng !== undefined
        && rawLng !== ""
        && rawLat !== null
        && rawLat !== undefined
        && rawLat !== ""
        && Number.isFinite(configuredLng)
        && Number.isFinite(configuredLat)
        ? [configuredLng, configuredLat]
        : centroidOfRing(largestOuter);
      const label = this.dataSource.entities.add({
        show: !this.suppressCountyLabels,
        position: Cesium.Cartesian3.fromDegrees(lng, lat),
        label: {
          text: name,
          font: '600 14px "Microsoft YaHei", sans-serif',
          fillColor: this.dynamicColor(COLORS.countyLabel, 0.95),
          outlineColor: this.dynamicColor("#ffffff", 0.95),
          outlineWidth: 3,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          scale: 0.82,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 260_000),
        },
      });
      this.countyLabelEntities.push(label);
    });
    this.counties = regions;
  }

  private addLiteLayer(layer: LiteVectorLayer, layerId: string): void {
    const viewBounds = expandedBounds(runtimeBounds());
    const isPolygon = layer.kind === "poly";
    const style =
      layerId === "rivers"
        ? { color: COLORS.water, width: 1.4, alpha: 0.92 }
        : layerId === "motorway"
          ? { color: COLORS.motorway, width: 1.7, alpha: 0.9 }
          : { color: COLORS.railway, width: 1.25, alpha: 0.88 };

    layer.items?.forEach((item) => {
      const points = (item.pts || []).filter(
        ([lng, lat]) => Number.isFinite(lng) && Number.isFinite(lat),
      );
      if (points.length < (isPolygon ? 3 : 2)) return;
      const bounds = boundsFromCoordinates(points);
      if (!bounds || !intersects(bounds, viewBounds)) return;
      const lengthKm = Number(item.len_km || 0);
      const detailMaxDistance = lengthKm >= 35 ? 600_000 : 150_000;

      if (isPolygon) {
        this.dataSource.entities.add({
          polygon: {
            hierarchy: new Cesium.PolygonHierarchy(toPositions(points)),
            material: this.material(COLORS.waterFill, 0.88),
            zIndex: 1,
            distanceDisplayCondition: new Cesium.DistanceDisplayCondition(
              0,
              lengthKm >= 8 ? 600_000 : 150_000,
            ),
          },
        });
        this.dataSource.entities.add({
          polyline: {
            positions: toPositions(points),
            width: 1,
            material: this.material(COLORS.water, 0.9),
            clampToGround: true,
            distanceDisplayCondition: new Cesium.DistanceDisplayCondition(
              0,
              lengthKm >= 8 ? 600_000 : 150_000,
            ),
          },
        });
        return;
      }

      this.dataSource.entities.add({
        name: item.name || layerId,
        polyline: {
          positions: toPositions(points),
          width: style.width,
          material: this.material(style.color, style.alpha),
          clampToGround: true,
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(
            0,
            layerId === "rivers" ? detailMaxDistance : 600_000,
          ),
        },
      });
    });
  }

  setVisible(visible: boolean): void {
    this.dataSource.show = visible;
    if (!this.viewer.isDestroyed()) this.viewer.scene.requestRender();
  }

  setAlpha(alphaPercent: number): void {
    this.opacity = Math.max(0, Math.min(1, alphaPercent / 100));
    if (!this.viewer.isDestroyed()) this.viewer.scene.requestRender();
  }

  /** BoundaryLayer 的业务边界开启时，隐藏底图里重复的县线/县名。 */
  setCountyVisualSuppressed(lines: boolean, labels: boolean): void {
    this.suppressCountyLines = lines;
    this.suppressCountyLabels = labels;
    this.countyLineEntities.forEach((entity) => {
      entity.show = !lines;
    });
    this.countyLabelEntities.forEach((entity) => {
      entity.show = !labels;
    });
    if (!this.viewer.isDestroyed()) this.viewer.scene.requestRender();
  }

  destroy(): void {
    this.destroyed = true;
    try {
      if (!this.viewer.isDestroyed()) {
        this.viewer.dataSources.remove(this.dataSource, true);
        this.viewer.scene.requestRender();
      }
    } catch {
      /* viewer 可能已先销毁 */
    }
    this.counties = [];
    this.countyLineEntities = [];
    this.countyLabelEntities = [];
  }
}
