/**
 * 行政区逐级下钻状态(县 → 镇街 → 村)。
 *
 * 地图双击与统计面板点击共用这一个 store:
 *   - 进入某级后联动 filterStore(county/township)与村级 code 集合,
 *     地图点位、筛选列表、统计图表同步只看该区域的文物;
 *   - 镜头飞行统一在这里做(按区域 bbox 取景)。
 *
 * 村级说明:文物台账没有村字段,村内文物按"点落在村多边形内"空间归组。
 */
import * as Cesium from "cesium";
import { create } from "zustand";
import { useFilterStore } from "./filterStore";
import { useRelicsStore } from "./relicsStore";
import { getViewer } from "../map/viewerRegistry";
import {
  ensureBaseRegions,
  ensureVillageRegions,
  getCounty,
  getTownship,
  getVillage,
  groupCodesByVillage,
  type Region,
} from "../map/adminRegionIndex";

export interface DrillTarget {
  county: string;
  township?: string;
  village?: string;
}

interface DrillState {
  county: string;
  township: string;
  village: string;
  /** 村级视图时=村内文物 archive_code 集合(空间归组);其余层级为 null。 */
  villageCodes: Set<string> | null;
  /** 下钻到某级(target 逐级给全:进镇要带县,进村要带县+镇)。 */
  drillTo: (target: DrillTarget, opts?: { fly?: boolean }) => void;
  /** 返回上一级(村→镇→县→全市)。 */
  back: (opts?: { fly?: boolean }) => void;
  /** 回到全市(清空下钻与联动筛选)。 */
  reset: (opts?: { fly?: boolean }) => void;
  /** FilterPanel 手动改县/镇时同步(不飞行、不回写 filterStore)。 */
  syncFromFilter: (county: string, township: string) => void;
}

function flyToRegion(region: Region | null): void {
  const viewer = getViewer();
  if (!viewer || viewer.isDestroyed()) return;
  let rectangle: Cesium.Rectangle;
  if (region) {
    const b = region.bounds;
    const padLng = Math.max((b.east - b.west) * 0.12, 0.008);
    const padLat = Math.max((b.north - b.south) * 0.12, 0.008);
    rectangle = Cesium.Rectangle.fromDegrees(
      b.west - padLng, b.south - padLat, b.east + padLng, b.north + padLat,
    );
  } else {
    const geoBounds = window.__PLATFORM_CONFIG?.geo?.bounds;
    if (!geoBounds || geoBounds.west >= geoBounds.east) return;
    const padLng = (geoBounds.east - geoBounds.west) * 0.15;
    const padLat = (geoBounds.north - geoBounds.south) * 0.15;
    rectangle = Cesium.Rectangle.fromDegrees(
      geoBounds.west - padLng, geoBounds.south - padLat,
      geoBounds.east + padLng, geoBounds.north + padLat,
    );
  }
  viewer.camera.cancelFlight();
  viewer.camera.flyTo({
    destination: rectangle,
    orientation: { heading: 0, pitch: Cesium.Math.toRadians(-90), roll: 0 },
    duration: 0.8,
  });
}

/** 镇名归一(台账里偶带数字前缀,标准边界不带)。 */
function normalizeTownship(name: string): string {
  return (name || "").replace(/^\d+/, "").trim();
}

function computeVillageCodes(county: string, township: string, village: string): Set<string> {
  const all = useRelicsStore.getState().all;
  const inTownship = all
    .filter(
      (r) =>
        (r.county || "") === county &&
        normalizeTownship(r.township || "") === normalizeTownship(township),
    )
    .map((r) => ({
      code: r.archive_code,
      lng: r.center_lng,
      lat: r.center_lat,
    }));
  const grouped = groupCodesByVillage(county, township, inTownship);
  return new Set(grouped.get(village) || []);
}

function applyFilter(county: string, township: string): void {
  const filter = useFilterStore.getState();
  if (filter.county !== county || filter.township !== township) {
    filter.setPartial({ county, township });
  }
}

export const useDrillStore = create<DrillState>((set, get) => ({
  county: "",
  township: "",
  village: "",
  villageCodes: null,

  drillTo(target, opts = {}) {
    const fly = opts.fly !== false;
    const county = target.county;
    const township = target.township || "";
    const village = target.village || "";
    if (!county) {
      get().reset(opts);
      return;
    }
    void ensureBaseRegions().then(() => {
      // 进入县级即后台预取村界,进镇/村时数据已就绪
      void ensureVillageRegions();
      const region = village
        ? getVillage(county, township, village)
        : township
          ? getTownship(county, township)
          : getCounty(county);
      set({
        county,
        township,
        village,
        villageCodes: village ? computeVillageCodes(county, township, village) : null,
      });
      applyFilter(county, township);
      if (fly) flyToRegion(region);
    });
  },

  back(opts = {}) {
    const { county, township, village } = get();
    if (village) {
      get().drillTo({ county, township }, opts);
    } else if (township) {
      get().drillTo({ county }, opts);
    } else if (county) {
      get().reset(opts);
    }
  },

  reset(opts = {}) {
    set({ county: "", township: "", village: "", villageCodes: null });
    applyFilter("", "");
    if (opts.fly !== false) flyToRegion(null);
  },

  syncFromFilter(county, township) {
    const cur = get();
    if (cur.county === county && cur.township === township && !cur.village) return;
    set({
      county,
      township: county ? township : "",
      village: "",
      villageCodes: null,
    });
    if (county) {
      void ensureBaseRegions().then(() => void ensureVillageRegions());
    }
  },
}));
