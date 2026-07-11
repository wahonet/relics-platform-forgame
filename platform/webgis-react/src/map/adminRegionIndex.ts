/**
 * 四级行政区索引:县 → 镇街 → 村。
 *
 * 数据来自 /boundaries/*.geojson(与 BoundaryLayer 同源的标准边界)。
 * 提供:
 *   - 点命中(双击下钻用):locate(lng, lat) → 点所在的县/镇/村
 *   - 取区域几何与 bbox(镜头飞行、高亮描边用)
 *   - 村级空间归组:文物台账没有村字段,按"点落在哪个村多边形"归组
 *
 * 县/镇在首次使用时一次性加载(11 县 + 157 镇,体量小);
 * 村(6500+ 面,~15MB)只在进入县/镇级视图后才懒加载。
 */
import { create } from "zustand";
import { sameTownship } from "../utils/township";

type Coordinate = [number, number];
type Ring = Coordinate[];
type Polygon = Ring[];

export type RegionLevel = "county" | "township" | "village";

export interface Bounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface Region {
  level: RegionLevel;
  name: string;
  /** 所属县(county 级 = 自身名)。 */
  county: string;
  /** 所属镇街(village 级才有)。 */
  township?: string;
  polygons: Polygon[];
  bounds: Bounds;
}

interface GeoJsonFeature {
  properties?: Record<string, unknown>;
  geometry?: { type?: string; coordinates?: unknown };
}

interface FeatureCollection {
  features?: GeoJsonFeature[];
}

/** 村数据加载状态(Dashboard 村级视图靠它触发重渲染)。 */
interface RegionIndexState {
  baseReady: boolean;
  villagesReady: boolean;
  villagesLoading: boolean;
}

export const useRegionIndexStore = create<RegionIndexState>(() => ({
  baseReady: false,
  villagesReady: false,
  villagesLoading: false,
}));

function polygonsFromGeometry(geometry?: { type?: string; coordinates?: unknown }): Polygon[] {
  if (!geometry?.coordinates) return [];
  if (geometry.type === "Polygon") return [geometry.coordinates as Polygon];
  if (geometry.type === "MultiPolygon") return geometry.coordinates as Polygon[];
  return [];
}

function boundsOfPolygons(polygons: Polygon[]): Bounds | null {
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  polygons.forEach((polygon) => {
    (polygon[0] || []).forEach(([lng, lat]) => {
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) return;
      west = Math.min(west, lng);
      south = Math.min(south, lat);
      east = Math.max(east, lng);
      north = Math.max(north, lat);
    });
  });
  return Number.isFinite(west) ? { west, south, east, north } : null;
}

function pointInRing(lng: number, lat: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const crosses =
      yi > lat !== yj > lat &&
      lng < ((xj - xi) * (lat - yi)) / (yj - yi || Number.EPSILON) + xi;
    if (crosses) inside = !inside;
  }
  return inside;
}

function pointInPolygons(lng: number, lat: number, polygons: Polygon[]): boolean {
  for (const polygon of polygons) {
    if (!polygon.length || !pointInRing(lng, lat, polygon[0])) continue;
    let inHole = false;
    for (let i = 1; i < polygon.length; i += 1) {
      if (pointInRing(lng, lat, polygon[i])) {
        inHole = true;
        break;
      }
    }
    if (!inHole) return true;
  }
  return false;
}

export function pointInRegion(lng: number, lat: number, region: Region): boolean {
  const b = region.bounds;
  if (lng < b.west || lng > b.east || lat < b.south || lat > b.north) return false;
  return pointInPolygons(lng, lat, region.polygons);
}

function prop(feature: GeoJsonFeature, key: string): string {
  return String(feature.properties?.[key] ?? "").trim();
}

function parseRegions(
  collection: FeatureCollection,
  level: RegionLevel,
): Region[] {
  const out: Region[] = [];
  collection.features?.forEach((feature) => {
    const name =
      level === "village"
        ? prop(feature, "ZLDWMC") || prop(feature, "XZQMC") || prop(feature, "name")
        : prop(feature, "XZQMC") || prop(feature, "name");
    if (!name) return;
    const county = level === "county" ? name : prop(feature, "_county_name");
    const township = level === "village" ? prop(feature, "_township_name") : undefined;
    const polygons = polygonsFromGeometry(feature.geometry).filter(
      (polygon) => (polygon[0]?.length || 0) >= 3,
    );
    if (!polygons.length) return;
    const bounds = boundsOfPolygons(polygons);
    if (!bounds) return;
    // 同名 region 的多个 feature(MultiPolygon 拆分)合并
    const existing = out.find(
      (r) => r.name === name && r.county === county && r.township === township,
    );
    if (existing) {
      existing.polygons.push(...polygons);
      existing.bounds = {
        west: Math.min(existing.bounds.west, bounds.west),
        south: Math.min(existing.bounds.south, bounds.south),
        east: Math.max(existing.bounds.east, bounds.east),
        north: Math.max(existing.bounds.north, bounds.north),
      };
      return;
    }
    out.push({ level, name, county, township, polygons, bounds });
  });
  return out;
}

async function fetchCollection(name: string): Promise<FeatureCollection | null> {
  try {
    const response = await fetch(`/boundaries/${name}.geojson`, { cache: "no-cache" });
    if (!response.ok) return null;
    const data = await response.json();
    return data && typeof data === "object" ? (data as FeatureCollection) : null;
  } catch {
    return null;
  }
}

let counties: Region[] = [];
let townshipsByCounty = new Map<string, Region[]>();
let villagesByTownship = new Map<string, Region[]>();
let basePromise: Promise<void> | null = null;
let villagesPromise: Promise<void> | null = null;

function townshipKey(county: string, township: string): string {
  return `${county}|${township}`;
}

/** 加载县 + 镇街索引(幂等)。 */
export function ensureBaseRegions(): Promise<void> {
  if (basePromise) return basePromise;
  basePromise = (async () => {
    const [county, townships] = await Promise.all([
      fetchCollection("county"),
      fetchCollection("townships"),
    ]);
    if (county) counties = parseRegions(county, "county");
    if (townships) {
      const list = parseRegions(townships, "township");
      townshipsByCounty = new Map();
      list.forEach((region) => {
        const arr = townshipsByCounty.get(region.county) || [];
        arr.push(region);
        townshipsByCounty.set(region.county, arr);
      });
    }
    useRegionIndexStore.setState({ baseReady: counties.length > 0 });
  })();
  return basePromise;
}

/** 懒加载村界索引(幂等)。~15MB,只在进入县/镇级视图后调用。 */
export function ensureVillageRegions(): Promise<void> {
  if (villagesPromise) return villagesPromise;
  useRegionIndexStore.setState({ villagesLoading: true });
  villagesPromise = (async () => {
    const villages = await fetchCollection("villages");
    if (villages) {
      const list = parseRegions(villages, "village");
      villagesByTownship = new Map();
      list.forEach((region) => {
        const key = townshipKey(region.county, region.township || "");
        const arr = villagesByTownship.get(key) || [];
        arr.push(region);
        villagesByTownship.set(key, arr);
      });
    }
    useRegionIndexStore.setState({
      villagesReady: villagesByTownship.size > 0,
      villagesLoading: false,
    });
  })();
  return villagesPromise;
}

/** 边界数据被重新下载后调用:清空索引,下次使用时重新加载。 */
export function invalidateRegionIndex(): void {
  counties = [];
  townshipsByCounty = new Map();
  villagesByTownship = new Map();
  basePromise = null;
  villagesPromise = null;
  useRegionIndexStore.setState({ baseReady: false, villagesReady: false, villagesLoading: false });
}

export interface RegionChain {
  county?: Region;
  township?: Region;
  village?: Region;
}

/** 点定位:返回点所在的县/镇/村(村需已加载,否则只到镇)。 */
export function locateRegion(lng: number, lat: number): RegionChain {
  const chain: RegionChain = {};
  for (const county of counties) {
    if (pointInRegion(lng, lat, county)) {
      chain.county = county;
      break;
    }
  }
  if (!chain.county) return chain;
  for (const township of townshipsByCounty.get(chain.county.name) || []) {
    if (pointInRegion(lng, lat, township)) {
      chain.township = township;
      break;
    }
  }
  if (!chain.township) return chain;
  const key = townshipKey(chain.county.name, chain.township.name);
  for (const village of villagesByTownship.get(key) || []) {
    if (pointInRegion(lng, lat, village)) {
      chain.village = village;
      break;
    }
  }
  return chain;
}

export function getCounty(name: string): Region | null {
  return counties.find((r) => r.name === name) || null;
}

export function getTownship(county: string, name: string): Region | null {
  const list = townshipsByCounty.get(county) || [];
  // 精确名优先;再按词干容错新旧名(台账[卧龙山街道] ↔ 边界[卧龙山镇])
  return (
    list.find((r) => r.name === name) ||
    list.find((r) => sameTownship(r.name, name)) ||
    null
  );
}

export function getVillage(county: string, township: string, name: string): Region | null {
  return getVillagesOf(county, township).find((r) => r.name === name) || null;
}

export function getVillagesOf(county: string, township: string): Region[] {
  const exact = villagesByTownship.get(townshipKey(county, township));
  if (exact?.length) return exact;
  // 村界按边界镇名分组;镇名是台账写法时按词干找同一镇
  for (const [key, list] of villagesByTownship) {
    const sep = key.indexOf("|");
    if (key.slice(0, sep) === county && sameTownship(key.slice(sep + 1), township)) {
      return list;
    }
  }
  return [];
}

/**
 * 村级空间归组:把镇内文物按"落在哪个村多边形"分组。
 * 返回 Map<村名, code[]>;落在所有村界之外的点归入 "" 键(调用方决定如何展示)。
 */
export function groupCodesByVillage(
  county: string,
  township: string,
  relics: { code: string; lng: number | null | undefined; lat: number | null | undefined }[],
): Map<string, string[]> {
  const villages = getVillagesOf(county, township);
  const out = new Map<string, string[]>();
  relics.forEach((relic) => {
    const lng = Number(relic.lng);
    const lat = Number(relic.lat);
    let hit = "";
    if (Number.isFinite(lng) && Number.isFinite(lat)) {
      for (const village of villages) {
        if (pointInRegion(lng, lat, village)) {
          hit = village.name;
          break;
        }
      }
    }
    const arr = out.get(hit) || [];
    arr.push(relic.code);
    out.set(hit, arr);
  });
  return out;
}
