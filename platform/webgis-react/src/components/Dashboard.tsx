import { useEffect, useMemo } from "react";
import ReactECharts from "echarts-for-react";
import { useRelicsStore } from "../stores/relicsStore";
import { useFilterStore } from "../stores/filterStore";
import { useUIStore } from "../stores/uiStore";
import { useDrillStore } from "../stores/drillStore";
import { useTimelineStore, relicInTimeline } from "../stores/timelineStore";
import {
  ensureBaseRegions,
  groupCodesByVillage,
  useRegionIndexStore,
} from "../map/adminRegionIndex";
import { DIMS, dimValue, dimValues, buildColorMap, DEF_COLOR, PALETTE } from "../utils/dict";
import { sameTownship, mergeTownshipVariants } from "../utils/township";
import type { DimDef } from "../utils/dict";
import { useChartTheme, type ChartTheme } from "../utils/chartTheme";
import type { RelicSummary } from "../types";
import {
  DASH_MODULES,
  type DashChartType,
  type DashModuleCfg,
} from "./dashboardModules";
import { WeatherForecast } from "./WeatherForecast";
import { RelicScopeToggle } from "./RelicScopeToggle";
import { useCatalogScopeStore } from "../stores/catalogScopeStore";
import { isProtectedRelic } from "../utils/relicScope";

function countDim(relics: RelicSummary[], dim: DimDef) {
  const counts: Record<string, number> = {};
  relics.forEach((r) => {
    dimValues(r as unknown as Record<string, unknown>, dim).forEach((v) => {
      counts[v] = (counts[v] || 0) + 1;
    });
  });
  const keys = dim.order
    ? dim.order.filter((k) => counts[k])
    : Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
  return { counts, keys };
}

interface ChartCardProps {
  title: string;
  dimId: string;
  type: DashChartType;
  relics: RelicSummary[];
  colorMap: Record<string, string>;
  onClickItem?: (val: string) => void;
}

function ChartCard({ title, dimId, type, relics, colorMap, onClickItem }: ChartCardProps) {
  const P = useChartTheme();
  const dim = DIMS.find((d) => d.id === dimId)!;
  const { counts, keys } = countDim(relics, dim);
  const data = keys.map((k) => ({
    name: k,
    value: counts[k],
    itemStyle: { color: colorMap[k] || DEF_COLOR },
  }));

  let option: Record<string, unknown> = {};
  if (type === "pie") {
    option = {
      tooltip: { trigger: "item", formatter: "{b}: {c} ({d}%)", ...P.tooltip },
      series: [
        {
          type: "pie",
          radius: ["28%", "58%"],
          center: ["50%", "52%"],
          data,
          label: { color: P.text, fontSize: 10, formatter: "{b}\n{c}" },
          labelLine: { lineStyle: { color: P.labelLine } },
        },
      ],
    };
  } else if (type === "bar") {
    const rev = [...keys].reverse();
    option = {
      tooltip: { trigger: "axis", ...P.tooltip },
      grid: { left: 6, right: 36, top: 6, bottom: 6, containLabel: true },
      xAxis: {
        type: "value",
        splitLine: { lineStyle: { color: P.split } },
        axisLabel: { color: P.axis, fontSize: 9 },
      },
      yAxis: {
        type: "category",
        data: rev,
        axisLabel: { color: P.text, fontSize: 10, width: 90, overflow: "truncate" },
        axisTick: { show: false },
        axisLine: { lineStyle: { color: P.axisLine } },
      },
      series: [
        {
          type: "bar",
          data: rev.map((k) => ({
            value: counts[k],
            itemStyle: { color: colorMap[k] || DEF_COLOR },
          })),
          barWidth: 10,
          itemStyle: { borderRadius: [0, 3, 3, 0] },
          label: {
            show: true,
            position: "right",
            color: P.axis,
            fontSize: 9,
            formatter: "{c}",
          },
        },
      ],
    };
  } else {
    option = {
      tooltip: { trigger: "axis", ...P.tooltip },
      grid: { left: 6, right: 6, top: 12, bottom: 6, containLabel: true },
      xAxis: {
        type: "category",
        data: keys,
        axisLabel: { color: P.axis, fontSize: 9, rotate: 25, interval: 0 },
        axisTick: { show: false },
        axisLine: { lineStyle: { color: P.axisLine } },
      },
      yAxis: {
        type: "value",
        splitLine: { lineStyle: { color: P.split } },
        axisLabel: { color: P.axis, fontSize: 9 },
      },
      series: [
        {
          type: "bar",
          data: keys.map((k) => ({
            value: counts[k],
            itemStyle: { color: colorMap[k] || DEF_COLOR },
          })),
          barWidth: 14,
          itemStyle: { borderRadius: [3, 3, 0, 0] },
        },
      ],
    };
  }

  const onEvents: Record<string, (e: { name?: string }) => void> = onClickItem
    ? {
        click: (e: { name?: string }) => {
          if (e?.name) onClickItem(e.name);
        },
      }
    : {};

  return (
    <div className="dash-sec">
      <h4>{title}</h4>
      <ReactECharts
        option={option}
        notMerge
        lazyUpdate
        style={{ width: "100%", height: 220 }}
        onEvents={onEvents}
      />
    </div>
  );
}

/** pie/bar/vbar 三种分布图 option(RegionDrillCard 用,数据已分组好)。 */
function buildDistOption(
  type: DashChartType,
  data: { name: string; value: number; itemStyle: { color: string; opacity?: number } }[],
  P: ChartTheme,
): Record<string, unknown> {
  if (type === "pie") {
    return {
      tooltip: { trigger: "item", formatter: "{b}: {c} ({d}%)", ...P.tooltip },
      series: [
        {
          type: "pie",
          radius: ["28%", "58%"],
          center: ["50%", "52%"],
          data,
          label: { color: P.text, fontSize: 10, formatter: "{b}\n{c}" },
          labelLine: { lineStyle: { color: P.labelLine } },
        },
      ],
    };
  }
  if (type === "bar") {
    const rev = [...data].reverse();
    return {
      tooltip: { trigger: "axis", ...P.tooltip },
      grid: { left: 6, right: 36, top: 6, bottom: 6, containLabel: true },
      xAxis: {
        type: "value",
        splitLine: { lineStyle: { color: P.split } },
        axisLabel: { color: P.axis, fontSize: 9 },
      },
      yAxis: {
        type: "category",
        data: rev.map((d) => d.name),
        axisLabel: { color: P.text, fontSize: 10, width: 90, overflow: "truncate" },
        axisTick: { show: false },
        axisLine: { lineStyle: { color: P.axisLine } },
      },
      series: [
        {
          type: "bar",
          data: rev,
          barWidth: 10,
          itemStyle: { borderRadius: [0, 3, 3, 0] },
          label: { show: true, position: "right", color: P.axis, fontSize: 9, formatter: "{c}" },
        },
      ],
    };
  }
  return {
    tooltip: { trigger: "axis", ...P.tooltip },
    grid: { left: 6, right: 6, top: 12, bottom: 6, containLabel: true },
    xAxis: {
      type: "category",
      data: data.map((d) => d.name),
      axisLabel: { color: P.axis, fontSize: 9, rotate: 25, interval: 0 },
      axisTick: { show: false },
      axisLine: { lineStyle: { color: P.axisLine } },
    },
    yAxis: {
      type: "value",
      splitLine: { lineStyle: { color: P.split } },
      axisLabel: { color: P.axis, fontSize: 9 },
    },
    series: [
      {
        type: "bar",
        data,
        barWidth: 14,
        itemStyle: { borderRadius: [3, 3, 0, 0] },
      },
    ],
  };
}

interface RegionDrillCardProps {
  type: DashChartType;
  /** 已套口径与非行政区筛选、未按县/镇过滤的集合。 */
  relics: RelicSummary[];
  colorMap: Record<string, string>;
}

/**
 * 行政区分布卡(县区分布模块的下钻版)。
 * 全市 → 点县看乡镇分布 → 点镇看村级分布 → 点村只看该村,
 * 与地图双击下钻共用 drillStore;镜头联动受设置开关控制。
 */
function RegionDrillCard({ type, relics, colorMap }: RegionDrillCardProps) {
  const P = useChartTheme();
  const county = useDrillStore((s) => s.county);
  const township = useDrillStore((s) => s.township);
  const village = useDrillStore((s) => s.village);
  const drillTo = useDrillStore((s) => s.drillTo);
  const reset = useDrillStore((s) => s.reset);
  const chartFlyEnabled = useUIStore((s) => s.chartFlyEnabled);
  const baseReady = useRegionIndexStore((s) => s.baseReady);
  const villagesReady = useRegionIndexStore((s) => s.villagesReady);
  const villagesLoading = useRegionIndexStore((s) => s.villagesLoading);
  const fly = { fly: chartFlyEnabled };

  useEffect(() => {
    if (!baseReady) void ensureBaseRegions();
  }, [baseReady]);

  const { title, data, onClickName } = useMemo(() => {
    const count = (list: RelicSummary[], key: (r: RelicSummary) => string) => {
      const counts: Record<string, number> = {};
      list.forEach((r) => {
        const k = key(r);
        if (k) counts[k] = (counts[k] || 0) + 1;
      });
      return Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .map(([name, value]) => ({ name, value }));
    };

    if (!county) {
      return {
        title: "县区分布",
        data: count(relics, (r) => r.county || ""),
        onClickName: (name: string) => drillTo({ county: name }, fly),
      };
    }
    const inCounty = relics.filter((r) => (r.county || "") === county);
    if (!township) {
      return {
        title: `${county} · 乡镇分布`,
        // 词干合并新旧写法(卧龙山街道/卧龙山镇 记同一镇),取最常见写法展示
        data: mergeTownshipVariants(inCounty.map((r) => r.township || "")),
        onClickName: (name: string) => drillTo({ county, township: name }, fly),
      };
    }
    const inTownship = inCounty.filter((r) => sameTownship(r.township || "", township));
    if (!villagesReady) {
      return { title: `${township} · 村级分布`, data: [], onClickName: () => undefined };
    }
    const grouped = groupCodesByVillage(
      county,
      township,
      inTownship.map((r) => ({ code: r.archive_code, lng: r.center_lng, lat: r.center_lat })),
    );
    const villageData = [...grouped.entries()]
      .filter(([name]) => name)
      .map(([name, codes]) => ({ name, value: codes.length }))
      .sort((a, b) => b.value - a.value);
    return {
      title: `${township} · 村级分布`,
      data: villageData,
      onClickName: (name: string) => {
        if (name === village) drillTo({ county, township }, fly);
        else drillTo({ county, township, village: name }, fly);
      },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relics, county, township, village, villagesReady, chartFlyEnabled, drillTo]);

  const colored = data.map((d, i) => ({
    ...d,
    itemStyle: {
      color: colorMap[d.name] || PALETTE[i % PALETTE.length],
      opacity: village && d.name !== village ? 0.4 : 1,
    },
  }));
  const option = buildDistOption(type, colored, P);

  return (
    <div className="dash-sec">
      <h4>{title}</h4>
      <div className="drill-crumbs">
        <button type="button" className={county ? "" : "cur"} onClick={() => reset(fly)}>
          全市
        </button>
        {county ? (
          <>
            <span aria-hidden="true">›</span>
            <button
              type="button"
              className={township ? "" : "cur"}
              onClick={() => drillTo({ county }, fly)}
            >
              {county}
            </button>
          </>
        ) : null}
        {township ? (
          <>
            <span aria-hidden="true">›</span>
            <button
              type="button"
              className={village ? "" : "cur"}
              onClick={() => drillTo({ county, township }, fly)}
            >
              {township}
            </button>
          </>
        ) : null}
        {village ? (
          <>
            <span aria-hidden="true">›</span>
            <button type="button" className="cur" onClick={() => undefined}>
              {village}
            </button>
          </>
        ) : null}
      </div>
      {township && !villagesReady ? (
        <div className="drill-empty">
          {villagesLoading ? "村界数据加载中…" : "村界数据不可用"}
        </div>
      ) : data.length === 0 ? (
        <div className="drill-empty">该区域暂无文物记录</div>
      ) : (
        <ReactECharts
          option={option}
          notMerge
          lazyUpdate
          style={{ width: "100%", height: 220 }}
          onEvents={{
            click: (e: { name?: string }) => {
              if (e?.name) onClickName(e.name);
            },
          }}
        />
      )}
    </div>
  );
}

interface SummaryCardsProps {
  totalRecords: number;
  designated: number;
}

function SummaryCards({ totalRecords, designated }: SummaryCardsProps) {
  return (
    <div className="dash-cards">
      <div className="dc">
        <div className="n">{totalRecords}</div>
        <div className="l">文物总数</div>
      </div>
      <div className="dc y">
        <div className="n">{designated}</div>
        <div className="l">文物保护单位</div>
      </div>
    </div>
  );
}

export function Dashboard() {
  const allRelics = useRelicsStore((s) => s.all);
  const search = useFilterStore((s) => s.search);
  const county = useFilterStore((s) => s.county);
  const township = useFilterStore((s) => s.township);
  const level = useFilterStore((s) => s.level);
  const cond = useFilterStore((s) => s.cond);
  const threeD = useFilterStore((s) => s.threeD);
  const activeCats = useFilterStore((s) => s.activeCats);
  const statFilters = useFilterStore((s) => s.statFilters);
  const setStatFilters = useFilterStore((s) => s.setStatFilters);
  const villageCodes = useDrillStore((s) => s.villageCodes);
  const timelineActive = useTimelineStore((s) => s.active);
  const timelineIndex = useTimelineStore((s) => s.index);
  const dashModules = useUIStore((s) => s.dashModules);
  const weatherPanelVisible = useUIStore((s) => s.weatherPanelVisible);
  const scope = useCatalogScopeStore((s) => s.scope);

  const toggleStat = (dimId: string, value: string) => {
    const next = { ...statFilters };
    if (next[dimId] === value) delete next[dimId];
    else next[dimId] = value;
    setStatFilters(next);
  };

  const lvDim = DIMS.find((d) => d.id === "heritage_level");

  /** 非行政区筛选(类别/关键字/级别/状况/三维/统计点选/年代时间轴)。 */
  const relicsBase = useMemo(() => {
    return allRelics.filter((r) => {
      if (timelineActive && !relicInTimeline(r, timelineIndex)) return false;
      if (activeCats.size && r.category_main && !activeCats.has(r.category_main))
        return false;
      const kw = search.trim().toLowerCase();
      if (
        kw &&
        !(r.name || "").toLowerCase().includes(kw) &&
        !(r.archive_code || "").toLowerCase().includes(kw) &&
        !(r.address || "").toLowerCase().includes(kw)
      )
        return false;
      if (level && lvDim && dimValue(r as Record<string, unknown>, lvDim) !== level)
        return false;
      if (cond && r.condition_level !== cond) return false;
      if (threeD === "1" && !r.has_3d) return false;
      if (threeD === "0" && r.has_3d) return false;
      for (const [sfDim, sfVal] of Object.entries(statFilters)) {
        const dim = DIMS.find((d) => d.id === sfDim);
        if (dim) {
          const vals = dimValues(r as unknown as Record<string, unknown>, dim);
          if (!vals.includes(sfVal)) return false;
        }
      }
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allRelics, activeCats, search, level, cond, threeD, statFilters, lvDim, timelineActive, timelineIndex]);

  /** 再叠加行政区筛选(县/镇/村下钻),供摘要卡与常规统计图。 */
  const relicsFiltered = useMemo(() => {
    return relicsBase.filter((r) => {
      if (county && (r.county || "") !== county) return false;
      if (township && !sameTownship(r.township || "", township)) return false;
      if (villageCodes && !villageCodes.has(r.archive_code)) return false;
      return true;
    });
  }, [relicsBase, county, township, villageCodes]);

  // 图表数据按当前标签口径过滤;摘要卡片两个总数与标签无关。
  const relicsForChart = useMemo(
    () => (scope === "protected" ? relicsFiltered.filter(isProtectedRelic) : relicsFiltered),
    [relicsFiltered, scope],
  );
  // 行政区分布卡专用:不含县/镇/村切片(卡片内部按下钻层级自己分组)。
  const relicsForRegion = useMemo(
    () => (scope === "protected" ? relicsBase.filter(isProtectedRelic) : relicsBase),
    [relicsBase, scope],
  );
  const totalRecords = relicsFiltered.length;
  const designated = relicsFiltered.filter(isProtectedRelic).length;

  const colorMaps = useMemo(() => {
    const out: Record<string, Record<string, string>> = {};
    DIMS.forEach((d) => {
      out[d.id] = buildColorMap(allRelics as unknown as Record<string, unknown>[], d);
    });
    return out;
  }, [allRelics]);

  const renderModule = (moduleId: string, cfg: DashModuleCfg) => {
    if (moduleId === "summary") {
      return (
        <SummaryCards key="summary" totalRecords={totalRecords} designated={designated} />
      );
    }
    const meta = DASH_MODULES.find((m) => m.id === moduleId);
    if (!meta) return null;
    const type: DashChartType = cfg.type || meta.defaultType || "pie";
    // 县区分布 → 可逐级下钻的行政区分布卡(县→乡镇→村,与地图双击联动)
    if (moduleId === "county") {
      return (
        <RegionDrillCard
          key="county"
          type={type}
          relics={relicsForRegion}
          colorMap={colorMaps.county || {}}
        />
      );
    }
    return (
      <ChartCard
        key={moduleId}
        title={meta.title}
        dimId={moduleId}
        type={type}
        relics={relicsForChart}
        colorMap={colorMaps[moduleId] || {}}
        onClickItem={(v) => toggleStat(moduleId, v)}
      />
    );
  };

  // 按 DASH_MODULES 顺序分别归集到左/右两栏
  const leftIds: string[] = [];
  const rightIds: string[] = [];
  DASH_MODULES.forEach((m) => {
    const cfg = dashModules[m.id];
    if (!cfg) return;
    if (cfg.dock === "left") leftIds.push(m.id);
    else if (cfg.dock === "right") rightIds.push(m.id);
  });

  const scopeTabs = <RelicScopeToggle />;

  return (
    <>
      {leftIds.length > 0 && (
        <div className="dash dock-l">
          <div className="dash-hdr">综合统计{scopeTabs}</div>
          {leftIds.map((id) => renderModule(id, dashModules[id]))}
        </div>
      )}
      <div className="dash dock-r">
        <div className="dash-hdr">综合统计{scopeTabs}</div>
        {rightIds.map((id) => renderModule(id, dashModules[id]))}
        {weatherPanelVisible ? <WeatherForecast /> : null}
      </div>
    </>
  );
}
