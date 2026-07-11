import { useEffect, useRef } from "react";
import * as Cesium from "cesium";
import { useCesiumViewer } from "./useCesiumViewer";
import { applyBaseLayer, setBaseLayerAlpha } from "./baseLayer";
import { PointRenderer } from "./PointRenderer";
import { ViewportManager } from "./ViewportManager";
import { BoundaryLayer } from "./BoundaryLayer";
import { HeatmapLayer } from "./HeatmapLayer";
import { OfflineCoverageLayer } from "./OfflineCoverageLayer";
import { OfflineVectorBasemapLayer } from "./OfflineVectorBasemapLayer";
import { AdminDrillController } from "./AdminDrillController";
import { invalidateRegionIndex } from "./adminRegionIndex";
import { RouteLayer, setRouteLayer } from "./RouteLayer";
import { TwoLineLayer } from "./TwoLineLayer";
import { ParcelLayer, setParcelLayer } from "./ParcelLayer";
import { useParcelStore } from "../stores/parcelStore";
import { useWeatherStore } from "../stores/weatherStore";
import { useDrillStore } from "../stores/drillStore";
import { useTimelineStore } from "../stores/timelineStore";
import { useUIStore, isLightTheme } from "../stores/uiStore";
import { useFilterStore } from "../stores/filterStore";
import { useCatalogScopeStore } from "../stores/catalogScopeStore";
import { useRelicsStore } from "../stores/relicsStore";
import { usePlatformStore } from "../stores/platformStore";
import { useHomeViewStore } from "../stores/homeViewStore";
import { useMouseCoordStore } from "../stores/mouseCoordStore";
import { usePatrolStore } from "../stores/patrolStore";
import { fetchRelicDetail, fetchPolygon } from "../api/relics";
import { computeHealth, todayWeatherRisk, HEALTH_COLOR } from "../utils/health";
import { passFilter } from "../components/FilterPanel";
import { relicInTimeline } from "../stores/timelineStore";
import { DIMS } from "../utils/dict";

interface MapViewProps {
  onCompassRotate?: (deg: number) => void;
  onScaleUpdate?: (label: string) => void;
}

export function MapView({ onCompassRotate, onScaleUpdate }: MapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useCesiumViewer(containerRef);

  const pointRendererRef = useRef<PointRenderer | null>(null);
  const viewportRef = useRef<ViewportManager | null>(null);
  const boundaryRef = useRef<BoundaryLayer | null>(null);
  const heatmapRef = useRef<HeatmapLayer | null>(null);
  const offlineCoverageRef = useRef<OfflineCoverageLayer | null>(null);
  const offlineVectorRef = useRef<OfflineVectorBasemapLayer | null>(null);
  const drillControllerRef = useRef<AdminDrillController | null>(null);
  const routeLayerRef = useRef<RouteLayer | null>(null);
  const twoLineRef = useRef<TwoLineLayer | null>(null);
  const parcelLayerRef = useRef<ParcelLayer | null>(null);

  const baseLayer = useUIStore((s) => s.baseLayer);
  const baseLayerAlpha = useUIStore((s) => s.baseLayerAlpha);
  const bndCounty = useUIStore((s) => s.bndCounty);
  const bndCountyName = useUIStore((s) => s.bndCountyName);
  const bndTownship = useUIStore((s) => s.bndTownship);
  const bndTownshipName = useUIStore((s) => s.bndTownshipName);
  const bndVillage = useUIStore((s) => s.bndVillage);
  const bndVillageName = useUIStore((s) => s.bndVillageName);
  const setUI = useUIStore((s) => s.set);

  const allRelicsLen = useRelicsStore((s) => s.all.length);
  // 拆成原始值订阅,避免 selector 每次返回新对象引发无限渲染。
  const filterActiveCats = useFilterStore((s) => s.activeCats);
  const filterCounty = useFilterStore((s) => s.county);
  const filterTownship = useFilterStore((s) => s.township);
  const filterLevel = useFilterStore((s) => s.level);
  const filterTier = useFilterStore((s) => s.tier);
  const filterCond = useFilterStore((s) => s.cond);
  const filterThreeD = useFilterStore((s) => s.threeD);
  const filterSearch = useFilterStore((s) => s.search);
  const filterStatFilters = useFilterStore((s) => s.statFilters);
  const catalogScope = useCatalogScopeStore((s) => s.scope);
  const timelineActive = useTimelineStore((s) => s.active);
  const timelineIndex = useTimelineStore((s) => s.index);

  const selectedRelic = useUIStore((s) => s.selectedRelic);
  const patrolStops = usePatrolStore((s) => s.stops);
  const patrolPreview = usePatrolStore((s) => s.previewPolyline);
  const patrolStart = usePatrolStore((s) => s.startPoint);

  const homeView = useHomeViewStore((s) => s.view);
  const offlineTick = useUIStore((s) => s.offlineCoverageTick);
  const boundaryReloadTick = useUIStore((s) => s.boundaryReloadTick);
  const theme = useUIStore((s) => s.theme);
  const twoLineVisible = useUIStore((s) => s.twoLineVisible);
  const parcelReloadTick = useParcelStore((s) => s.reloadTick);
  const parcelLayerIds = useParcelStore((s) => s.layers);
  const parcelVisible = useParcelStore((s) => s.visible);

  /** 两线范围整层显隐(工具栏「边界」菜单控制)。 */
  useEffect(() => {
    twoLineRef.current?.setVisible(twoLineVisible);
  }, [twoLineVisible]);

  /** 对比图斑:图层增删时增量同步,显隐变化时应用。 */
  useEffect(() => {
    const pl = parcelLayerRef.current;
    if (!pl) return;
    pl.sync(parcelLayerIds.map((l) => l.id)).then(() => {
      pl.applyVisibility(useParcelStore.getState().visible);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parcelReloadTick]);

  useEffect(() => {
    parcelLayerRef.current?.applyVisibility(parcelVisible);
  }, [parcelVisible]);

  /** 主题切换时更新域外遮罩配色(亮白=浅雾,深色=压暗)。 */
  useEffect(() => {
    boundaryRef.current?.setMaskTheme(isLightTheme(theme));
  }, [theme]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const renderer = new PointRenderer(viewer);
    const viewport = new ViewportManager(viewer, renderer);
    const boundary = new BoundaryLayer(viewer);
    const heatmap = new HeatmapLayer(viewer);
    const offlineCoverage = new OfflineCoverageLayer(viewer);
    const offlineVector = new OfflineVectorBasemapLayer(viewer);
    const drillController = new AdminDrillController(viewer, {
      canNavigate: () => {
        const patrol = usePatrolStore.getState();
        return !patrol.picking && !patrol.pickingStart;
      },
    });
    const routeLayer = new RouteLayer(viewer);
    const twoLine = new TwoLineLayer(viewer);
    const parcels = new ParcelLayer(viewer);

    pointRendererRef.current = renderer;
    viewportRef.current = viewport;
    boundaryRef.current = boundary;
    heatmapRef.current = heatmap;
    offlineCoverageRef.current = offlineCoverage;
    offlineVectorRef.current = offlineVector;
    drillControllerRef.current = drillController;
    routeLayerRef.current = routeLayer;
    twoLineRef.current = twoLine;
    setRouteLayer(routeLayer);
    parcelLayerRef.current = parcels;
    setParcelLayer(parcels);

    const initialUi = useUIStore.getState();
    offlineVector.setAlpha(initialUi.baseLayerAlpha);
    offlineVector.setCountyVisualSuppressed(
      initialUi.bndCounty,
      initialUi.bndCountyName,
    );
    offlineVector.setVisible(initialUi.baseLayer === "offline_vector");
    drillController.setEnabled(initialUi.drillEnabled);
    viewport.setCodeFilter(useDrillStore.getState().villageCodes);
    // 已导入过图斑时(刷新页面后),恢复渲染;refresh 会 bump reloadTick 触发 sync
    useParcelStore.getState().refresh();
    twoLine.setVisible(useUIStore.getState().twoLineVisible);
    twoLine.load();

    renderer.setOnPick(async (code: string) => {
      try {
        // 选起点模式下点到文物也不响应(由起点 handler 处理该次点击)
        if (usePatrolStore.getState().pickingStart) return;
        const r = useRelicsStore.getState().byCode.get(code);
        // 巡查选点模式:点击文物点 → 加入路线,不打开详情。
        if (usePatrolStore.getState().picking) {
          const s = r || (await fetchRelicDetail(code));
          if (s?.center_lng != null && s?.center_lat != null) {
            usePatrolStore.getState().addStop({
              code: s.archive_code,
              name: s.name,
              lng: s.center_lng,
              lat: s.center_lat,
              county: s.county,
              condition: s.condition_level,
            });
          }
          return;
        }
        if (r) {
          setUI({ selectedRelic: r });
          return;
        }
        const full = await fetchRelicDetail(code);
        if (full?.archive_code) setUI({ selectedRelic: full });
      } catch {
        /* ignore */
      }
    });

    boundary.setMaskTheme(isLightTheme(useUIStore.getState().theme));
    boundary.load().then(() => {
      const ui = useUIStore.getState();
      boundary.setVisibility({
        county: ui.bndCounty,
        countyName: ui.bndCountyName,
        township: ui.bndTownship,
        townshipName: ui.bndTownshipName,
        village: ui.bndVillage,
        villageName: ui.bndVillageName,
      });
      boundary.setMaskTheme(isLightTheme(useUIStore.getState().theme));
    });

    viewport.start((count, truncated) => {
      if (truncated) {
        useUIStore.getState().showToast(`视口内文物较多,仅显示前 ${count} 处`);
      }
    });

    const onPreRender = () => {
      const headDeg = -Cesium.Math.toDegrees(viewer.camera.heading);
      onCompassRotate?.(headDeg);
    };
    const onPostRender = () => {
      try {
        const canvas = viewer.canvas;
        const cx = canvas.clientWidth / 2;
        const cy = canvas.clientHeight / 2;
        const left = viewer.camera.pickEllipsoid(new Cesium.Cartesian2(cx - 50, cy));
        const right = viewer.camera.pickEllipsoid(new Cesium.Cartesian2(cx + 50, cy));
        if (!left || !right) return;
        const dist = Cesium.Cartesian3.distance(left, right);
        const mpp = dist / 100;
        const dpi = window.devicePixelRatio * 96;
        const mPerPx = 0.0254 / dpi;
        const ratio = Math.round(mpp / mPerPx);
        const nice = [
          500, 1000, 2000, 2500, 5000, 10000, 15000, 20000, 25000, 50000, 100000,
          150000, 200000, 250000, 500000, 1000000, 2000000, 5000000,
        ];
        let best = ratio;
        for (const n of nice) {
          if (n >= ratio * 0.8) {
            best = n;
            break;
          }
        }
        onScaleUpdate?.(`1 : ${best.toLocaleString()}`);
      } catch {
        /* ignore */
      }
    };
    viewer.scene.preRender.addEventListener(onPreRender);
    viewer.scene.postRender.addEventListener(onPostRender);

    // 巡查"选起点"模式:点击地图任意位置设为出发点。
    const startPickHandler = new Cesium.ScreenSpaceEventHandler(viewer.canvas);
    startPickHandler.setInputAction((click: { position: Cesium.Cartesian2 }) => {
      const ps = usePatrolStore.getState();
      if (!ps.pickingStart) return;
      const cart = viewer.camera.pickEllipsoid(click.position);
      if (!cart) return;
      const c = Cesium.Cartographic.fromCartesian(cart);
      ps.setStartPoint({
        lng: +Cesium.Math.toDegrees(c.longitude).toFixed(8),
        lat: +Cesium.Math.toDegrees(c.latitude).toFixed(8),
        name: "自定义起点",
      });
      drillController.suppressNextDoubleClick();
      ps.setPickingStart(false);
      useUIStore.getState().showToast("出发起点已设置");
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

    // 鼠标移动 → WGS84 经纬度,推到 mouseCoordStore 给底部坐标读数。
    // 用独立 store 避免 MapView 自己重渲染。节流到 ~60fps。
    const mouseHandler = new Cesium.ScreenSpaceEventHandler(viewer.canvas);
    let lastTs = 0;
    mouseHandler.setInputAction(
      (movement: Cesium.ScreenSpaceEventHandler.MotionEvent) => {
        const now = performance.now();
        if (now - lastTs < 16) return;
        lastTs = now;
        try {
          const ray = viewer.camera.getPickRay(movement.endPosition);
          let cart: Cesium.Cartesian3 | undefined;
          if (ray) {
            cart = viewer.scene.globe.pick(ray, viewer.scene) as Cesium.Cartesian3 | undefined;
          }
          if (!cart) {
            cart = viewer.camera.pickEllipsoid(movement.endPosition) as Cesium.Cartesian3 | undefined;
          }
          if (!cart) {
            useMouseCoordStore.getState().set(null, null, null);
            return;
          }
          const c = Cesium.Cartographic.fromCartesian(cart);
          useMouseCoordStore.getState().set(
            Cesium.Math.toDegrees(c.longitude),
            Cesium.Math.toDegrees(c.latitude),
            c.height,
          );
        } catch {
          useMouseCoordStore.getState().set(null, null, null);
        }
      },
      Cesium.ScreenSpaceEventType.MOUSE_MOVE,
    );

    return () => {
      // 注意:在 React 18 StrictMode + hook 依赖链下,父级 useCesiumViewer 的
      // cleanup (viewer.destroy()) 可能比这个 cleanup 更早跑,导致 viewer 已死。
      // 所以全部访问都要保护。
      try {
        if (!viewer.isDestroyed()) {
          viewer.scene.preRender.removeEventListener(onPreRender);
          viewer.scene.postRender.removeEventListener(onPostRender);
        }
      } catch {
        /* ignore */
      }
      try {
        mouseHandler.destroy();
      } catch {
        /* ignore */
      }
      try {
        startPickHandler.destroy();
      } catch {
        /* ignore */
      }
      drillController.destroy();
      boundary.destroy();
      heatmap.destroy();
      offlineVector.destroy();
      useMouseCoordStore.getState().set(null, null, null);
      viewport.stop();
      renderer.destroy();
      routeLayer.destroy();
      twoLine.destroy();
      parcels.destroy();
      setRouteLayer(null);
      setParcelLayer(null);
      parcelLayerRef.current = null;
      try {
        offlineCoverage.clear();
      } catch {
        /* ignore */
      }
      pointRendererRef.current = null;
      viewportRef.current = null;
      boundaryRef.current = null;
      heatmapRef.current = null;
      offlineCoverageRef.current = null;
      offlineVectorRef.current = null;
      drillControllerRef.current = null;
      routeLayerRef.current = null;
      twoLineRef.current = null;
    };
  }, [viewerRef, onCompassRotate, onScaleUpdate, setUI]);

  /** 双击下钻开关(系统管理 → 设置)。 */
  const drillEnabled = useUIStore((s) => s.drillEnabled);
  useEffect(() => {
    drillControllerRef.current?.setEnabled(drillEnabled);
  }, [drillEnabled]);

  /** 村级下钻:地图点位只保留村内文物(前端 code 集合过滤)。 */
  const villageCodes = useDrillStore((s) => s.villageCodes);
  useEffect(() => {
    viewportRef.current?.setCodeFilter(villageCodes);
  }, [villageCodes]);

  /** 健康度一张图:按健康分给点位红黄绿着色。 */
  const healthMode = useUIStore((s) => s.healthMode);
  const weatherForecast = useWeatherStore((s) => s.forecast);
  const allRelics = useRelicsStore((s) => s.all);
  useEffect(() => {
    const renderer = pointRendererRef.current;
    if (!renderer) return;
    if (!healthMode) {
      renderer.setHealthMode(false, new Map());
      return;
    }
    const risk = todayWeatherRisk(weatherForecast?.days, weatherForecast?.timezone);
    const colors = new Map<string, string>();
    allRelics.forEach((r) => {
      colors.set(r.archive_code, HEALTH_COLOR[computeHealth(r, risk).level]);
    });
    renderer.setHealthMode(true, colors);
  }, [healthMode, weatherForecast, allRelics]);

  /** 文物密度热力图:与当前筛选/时间轴/下钻同源,开启时隐藏点位。 */
  const heatMode = useUIStore((s) => s.heatMode);
  useEffect(() => {
    const heatmap = heatmapRef.current;
    const renderer = pointRendererRef.current;
    if (!heatmap || !renderer) return;
    if (!heatMode) {
      heatmap.clear();
      renderer.setVisible(true);
      return;
    }
    const filter = useFilterStore.getState();
    const timeline = useTimelineStore.getState();
    const lvDim = DIMS.find((d) => d.id === "heritage_level");
    const fstate = {
      search: filter.search,
      county: filter.county,
      township: filter.township,
      level: filter.level,
      cond: filter.cond,
      tier: filter.tier,
      threeD: filter.threeD,
      scope: catalogScope,
      activeCats: filter.activeCats,
      villageCodes,
    };
    const points: [number, number][] = [];
    allRelics.forEach((r) => {
      if (r.center_lng == null || r.center_lat == null) return;
      if (timeline.active && !relicInTimeline(r, timeline.index)) return;
      if (!passFilter(r, fstate, lvDim)) return;
      points.push([r.center_lng, r.center_lat]);
    });
    renderer.setVisible(false);
    heatmap.update(points);
  }, [
    heatMode,
    allRelics,
    villageCodes,
    timelineActive,
    timelineIndex,
    filterActiveCats,
    filterCounty,
    filterTownship,
    filterLevel,
    filterTier,
    filterCond,
    filterThreeD,
    filterSearch,
    catalogScope,
  ]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    applyBaseLayer(viewer, baseLayer, baseLayerAlpha);
    const vectorBasemap = offlineVectorRef.current;
    vectorBasemap?.setVisible(baseLayer === "offline_vector");
    vectorBasemap?.setAlpha(baseLayerAlpha);
    if (baseLayer === "offline_vector") {
      vectorBasemap?.load().catch((error) => {
        console.warn("[OfflineVectorBasemap] 加载失败:", error);
        if (useUIStore.getState().baseLayer === "offline_vector") {
          useUIStore.getState().showToast("离线专题矢量底图加载失败");
        }
      });
    }

    // 切到"离线瓦片影像 / 离线 OSM 瓦片"时,把已下载区域的 bbox 用红框标识在地图上,
    // 让用户一眼看到能滑过去的区域;切到其它底图时清掉。
    const cov = offlineCoverageRef.current;
    if (!cov) return;
    if (baseLayer === "arcgis_sat" || baseLayer === "osm") {
      cov.refresh().then((n) => {
        if (n > 0) {
          useUIStore.getState().showToast(`已加载 ${n} 个离线下载区域 (红色框)`);
        }
      });
    } else {
      cov.clear();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewerRef, baseLayer, offlineTick]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    setBaseLayerAlpha(viewer, baseLayerAlpha);
    offlineVectorRef.current?.setAlpha(baseLayerAlpha);
  }, [viewerRef, baseLayerAlpha]);

  useEffect(() => {
    offlineVectorRef.current?.setCountyVisualSuppressed(
      bndCounty,
      bndCountyName,
    );
    const b = boundaryRef.current;
    if (!b) return;
    b.setVisibility({
      county: bndCounty,
      countyName: bndCountyName,
      township: bndTownship,
      townshipName: bndTownshipName,
      village: bndVillage,
      villageName: bndVillageName,
    });
  }, [
    bndCounty,
    bndCountyName,
    bndTownship,
    bndTownshipName,
    bndVillage,
    bndVillageName,
  ]);

  /** 边界数据被重下载/清空后,重新载入并按当前可见性渲染。
   * 首次挂载时 boundaryReloadTick=0,跳过(避免重复 load,因为初始化 effect 已经 load 过一次)。 */
  useEffect(() => {
    if (boundaryReloadTick === 0) return;
    invalidateRegionIndex();
    const b = boundaryRef.current;
    if (!b) return;
    b.reload().then(() => {
      const ui = useUIStore.getState();
      b.setVisibility({
        county: ui.bndCounty,
        countyName: ui.bndCountyName,
        township: ui.bndTownship,
        townshipName: ui.bndTownshipName,
        village: ui.bndVillage,
        villageName: ui.bndVillageName,
      });
    });
  }, [boundaryReloadTick]);

  useEffect(() => {
    const vm = viewportRef.current;
    if (!vm) return;
    // 关键字输入防抖 250ms,避免每个按键都打一次 by-bbox 请求。
    const t = setTimeout(() => {
      const allCatNames = new Set(
        useRelicsStore
          .getState()
          .all.map((r) => r.category_main)
          .filter(Boolean) as string[],
      );
      const backend = useFilterStore.getState().toBackend(allCatNames);
      vm.setFilters(backend);
    }, 250);
    return () => clearTimeout(t);
  }, [
    filterActiveCats,
    filterCounty,
    filterTownship,
    filterLevel,
    filterTier,
    filterCond,
    filterThreeD,
    filterSearch,
    filterStatFilters,
    catalogScope,
    timelineActive,
    timelineIndex,
    allRelicsLen,
  ]);

  /** 巡查路线渲染:stops/预览折线/出发点变化时重画。 */
  useEffect(() => {
    const rl = routeLayerRef.current;
    if (!rl) return;
    rl.showRoute(patrolStops, patrolPreview, patrolStart);
  }, [patrolStops, patrolPreview, patrolStart]);

  /** 选中文物时自动叠加两线范围(保护范围红 / 建控地带蓝)。 */
  useEffect(() => {
    const rl = routeLayerRef.current;
    if (!rl) return;
    if (!selectedRelic?.archive_code || !selectedRelic?.has_boundary) {
      rl.clearBoundaries();
      return;
    }
    let cancelled = false;
    fetchPolygon(selectedRelic.archive_code)
      .then((fc) => {
        if (!cancelled) rl.showBoundaries(fc as { features?: [] });
      })
      .catch(() => {
        if (!cancelled) rl.clearBoundaries();
      });
    return () => {
      cancelled = true;
    };
  }, [selectedRelic?.archive_code, selectedRelic?.has_boundary]);

  // 初始视口:优先用户保存的主视角;否则等平台配置加载完成后按市域范围取景。
  // (viewer 创建时配置往往尚未拉取完成,useCesiumViewer 里只是兜底占位)
  const platformLoaded = usePlatformStore((s) => s.loaded);
  const homeAppliedRef = useRef(false);
  useEffect(() => {
    if (homeAppliedRef.current) return;
    const viewer = viewerRef.current;
    if (!viewer) return;
    const dest = homeView
      ? Cesium.Cartesian3.fromDegrees(homeView.lng, homeView.lat, homeView.h)
      : platformLoaded
        ? configHomeDestination()
        : null;
    if (!dest) return;
    viewer.camera.flyTo({
      destination: dest,
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-90), roll: 0 },
      duration: 0,
    });
    homeAppliedRef.current = true;
  }, [viewerRef, homeView, platformLoaded]);

  // 今日天气氛围(雨/雪/阴):在地图上叠一层极淡的效果,数据由天气面板写入
  const weatherAmbience = useWeatherStore((s) => s.ambience);
  const weatherFxEnabled = useUIStore((s) => s.weatherFxEnabled);

  return (
    <>
      <div ref={containerRef} className="map-container" />
      {weatherFxEnabled && weatherAmbience ? (
        <div className={`map-weather-fx ${weatherAmbience}`} aria-hidden="true" />
      ) : null}
      {baseLayer === "offline_vector" ? (
        <div className="offline-vector-attribution">
          <span>双击县区进入 · 单击右键返回</span>
          <a
            href="https://www.openstreetmap.org/copyright"
            target="_blank"
            rel="noreferrer"
          >
            © OpenStreetMap contributors
          </a>
        </div>
      ) : null}
    </>
  );
}

/**
 * 无用户主视角时的默认取景:优先按 config.geo.bounds 整域取景
 * (Cesium 自动算相机高度,任何窗口比例下都能完整装下全市),
 * 无 bounds 时退回 center 点位。
 */
function configHomeDestination(): Cesium.Cartesian3 | Cesium.Rectangle | null {
  const geo = window.__PLATFORM_CONFIG?.geo;
  const b = geo?.bounds;
  if (b && b.west < b.east && b.south < b.north) {
    // 四周留 ~15% 边距,还原大屏"市域居中、周边压暗"的构图
    const padLng = (b.east - b.west) * 0.15;
    const padLat = (b.north - b.south) * 0.15;
    return Cesium.Rectangle.fromDegrees(
      b.west - padLng, b.south - padLat, b.east + padLng, b.north + padLat,
    );
  }
  const c = geo?.center;
  if (c) return Cesium.Cartesian3.fromDegrees(c.lng, c.lat, c.alt ?? 220_000);
  return null;
}

export function flyHomeFn(viewer: Cesium.Viewer | null): void {
  if (!viewer) return;
  // 回家同时退出行政区下钻(自己飞 home,不再按区域飞)
  useDrillStore.getState().reset({ fly: false });
  const home = useHomeViewStore.getState().view;
  const dest = home
    ? Cesium.Cartesian3.fromDegrees(home.lng, home.lat, home.h)
    : configHomeDestination() ?? Cesium.Cartesian3.fromDegrees(116.587, 35.415, 220_000);
  viewer.camera.flyTo({
    destination: dest,
    orientation: { heading: 0, pitch: Cesium.Math.toRadians(-90), roll: 0 },
    duration: 1.2,
  });
}
