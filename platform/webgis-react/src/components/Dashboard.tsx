import { useMemo, useState } from "react";
import ReactECharts from "echarts-for-react";
import { useRelicsStore } from "../stores/relicsStore";
import { useFilterStore } from "../stores/filterStore";
import { useUIStore } from "../stores/uiStore";
import { DIMS, dimValue, dimValues, buildColorMap, DEF_COLOR } from "../utils/dict";
import type { DimDef } from "../utils/dict";
import { useChartTheme } from "../utils/chartTheme";
import type { RelicSummary } from "../types";
import {
  DASH_MODULES,
  type DashChartType,
  type DashModuleCfg,
} from "./dashboardModules";
import { WeatherForecast } from "./WeatherForecast";

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

/** 统计口径:designated = 各级文物保护单位(排除"未核定"),all = 全部文物。 */
type StatScope = "designated" | "all";

function isDesignated(r: RelicSummary, lvDim?: DimDef): boolean {
  if (!lvDim) return !!r.heritage_level;
  return dimValue(r as Record<string, unknown>, lvDim) !== "未核定";
}

export function Dashboard() {
  const allRelics = useRelicsStore((s) => s.all);
  const search = useFilterStore((s) => s.search);
  const township = useFilterStore((s) => s.township);
  const level = useFilterStore((s) => s.level);
  const cond = useFilterStore((s) => s.cond);
  const threeD = useFilterStore((s) => s.threeD);
  const activeCats = useFilterStore((s) => s.activeCats);
  const statFilters = useFilterStore((s) => s.statFilters);
  const setStatFilters = useFilterStore((s) => s.setStatFilters);
  const dashModules = useUIStore((s) => s.dashModules);
  const [scope, setScope] = useState<StatScope>("designated");

  const toggleStat = (dimId: string, value: string) => {
    const next = { ...statFilters };
    if (next[dimId] === value) delete next[dimId];
    else next[dimId] = value;
    setStatFilters(next);
  };

  const lvDim = DIMS.find((d) => d.id === "heritage_level");

  const relicsFiltered = useMemo(() => {
    const twDim = DIMS.find((d) => d.id === "township");
    return allRelics.filter((r) => {
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
      if (township && twDim && dimValue(r as Record<string, unknown>, twDim) !== township)
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
  }, [allRelics, activeCats, search, township, level, cond, threeD, statFilters, lvDim]);

  // 图表数据按当前标签口径过滤;摘要卡片两个总数与标签无关。
  const relicsForChart = useMemo(
    () => (scope === "designated" ? relicsFiltered.filter((r) => isDesignated(r, lvDim)) : relicsFiltered),
    [relicsFiltered, scope, lvDim],
  );
  const totalRecords = relicsFiltered.length;
  const designated = relicsFiltered.filter((r) => isDesignated(r, lvDim)).length;

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

  const scopeTabs = (
    <div className="dash-scope">
      <button
        className={scope === "designated" ? "on" : ""}
        onClick={() => setScope("designated")}
      >
        文物保护单位
      </button>
      <button
        className={scope === "all" ? "on" : ""}
        onClick={() => setScope("all")}
      >
        文物总量
      </button>
    </div>
  );

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
        <WeatherForecast />
      </div>
    </>
  );
}
