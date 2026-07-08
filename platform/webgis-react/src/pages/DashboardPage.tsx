import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import ReactECharts from "echarts-for-react";
import { fetchDashboardStats } from "../api/stats";
import { fetchPatrolStats } from "../api/patrol";
import type { DashboardStats, PatrolStats, NameValue } from "../types";
import { useChartTheme, withAlpha } from "../utils/chartTheme";
import {
  RANK_COLOR,
  CONDITION_COLOR,
  CATEGORY_MAP,
  categoryCode,
  rankCode,
} from "../utils/dict";

const RANK_SHORT: Record<string, string> = {
  全国重点文物保护单位: "国保",
  省级文物保护单位: "省保",
  市级文物保护单位: "市保",
  县级文物保护单位: "县保",
  尚未核定公布为文物保护单位的不可移动文物: "未定级",
};

const COMPLETENESS_LABEL: Record<string, string> = {
  coords: "空间坐标",
  intro: "文字简介",
  photo: "影像资料",
  boundary_of_designated: "两线范围",
  condition: "保存状况",
};

function Num({ v }: { v: number | string }) {
  return <b className="bs-num">{typeof v === "number" ? v.toLocaleString() : v}</b>;
}

export default function DashboardPage() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [patrol, setPatrol] = useState<PatrolStats | null>(null);
  const [now, setNow] = useState(new Date());
  const P = useChartTheme();
  const AXIS = useMemo(() => ({ color: P.axis, fontSize: 11 }), [P]);
  const SPLIT = useMemo(() => ({ lineStyle: { color: P.split } }), [P]);
  const TT = useMemo(
    () => ({ ...P.tooltip, textStyle: { ...P.tooltip.textStyle, fontSize: 12 } }),
    [P],
  );

  useEffect(() => {
    document.title = "资源概览 — 济宁市文物保护利用平台";
    fetchDashboardStats().then(setStats).catch(() => undefined);
    fetchPatrolStats().then(setPatrol).catch(() => undefined);
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  const rankOption = useMemo(() => {
    const data = (stats?.by_rank || []).map((d) => ({
      ...d,
      // 级别配色与地图图例同源(国保红/省保橙/市保蓝/县保绿/未定级紫)
      color: RANK_COLOR[rankCode(d.name)] || P.accent,
      name: RANK_SHORT[d.name] || d.name,
    }));
    return {
      tooltip: { trigger: "axis", ...TT },
      grid: { left: 8, right: 30, top: 10, bottom: 4, containLabel: true },
      xAxis: { type: "value", splitLine: SPLIT, axisLabel: AXIS },
      yAxis: {
        type: "category",
        data: data.map((d) => d.name).reverse(),
        axisLabel: { ...AXIS, color: P.text },
        axisTick: { show: false },
      },
      series: [
        {
          type: "bar",
          data: data
            .map((d) => ({ value: d.value, itemStyle: { color: d.color } }))
            .reverse(),
          barWidth: 14,
          itemStyle: { borderRadius: [0, 4, 4, 0] },
          label: { show: true, position: "right", color: P.axis, fontSize: 11 },
        },
      ],
    };
  }, [stats, P, AXIS, SPLIT, TT]);

  const countyOption = useMemo(() => {
    const data = stats?.by_county || [];
    return {
      tooltip: { trigger: "axis", ...TT },
      grid: { left: 8, right: 8, top: 24, bottom: 4, containLabel: true },
      xAxis: {
        type: "category",
        data: data.map((d) => d.name.replace(/(县|市|区)$/, "")),
        axisLabel: { ...AXIS, interval: 0, rotate: 30 },
        axisTick: { show: false },
      },
      yAxis: { type: "value", splitLine: SPLIT, axisLabel: AXIS },
      series: [
        {
          type: "bar",
          data: data.map((d) => d.value),
          barWidth: 16,
          itemStyle: {
            borderRadius: [4, 4, 0, 0],
            color: {
              type: "linear", x: 0, y: 0, x2: 0, y2: 1,
              colorStops: [
                { offset: 0, color: P.accent },
                { offset: 1, color: withAlpha(P.accent, 0.22) },
              ],
            },
          },
          label: { show: true, position: "top", color: P.axis, fontSize: 10 },
        },
      ],
    };
  }, [stats, P, AXIS, SPLIT, TT]);

  const pieOption = (data: NameValue[], name: string, colorOf?: (n: string) => string | undefined) => ({
    tooltip: { trigger: "item", formatter: "{b}: {c} ({d}%)", ...TT },
    legend: {
      bottom: 0,
      textStyle: { color: P.axis, fontSize: 10 },
      itemWidth: 10,
      itemHeight: 10,
    },
    series: [
      {
        name,
        type: "pie",
        radius: ["36%", "62%"],
        center: ["50%", "44%"],
        data: data.map((d, i) => ({
          ...d,
          itemStyle: { color: colorOf?.(d.name) || P.palette[i % P.palette.length] },
        })),
        label: { color: P.text, fontSize: 10, formatter: "{b} {c}" },
        labelLine: { lineStyle: { color: P.labelLine } },
      },
    ],
  });

  const eraOption = useMemo(() => {
    const data = stats?.by_era || [];
    return {
      tooltip: { trigger: "axis", ...TT },
      grid: { left: 8, right: 8, top: 24, bottom: 4, containLabel: true },
      xAxis: {
        type: "category",
        data: data.map((d) => d.name),
        axisLabel: { ...AXIS, interval: 0 },
        axisTick: { show: false },
      },
      yAxis: { type: "value", splitLine: SPLIT, axisLabel: AXIS },
      series: [
        {
          type: "line",
          data: data.map((d) => d.value),
          smooth: true,
          symbolSize: 7,
          lineStyle: { color: P.gold, width: 2.5 },
          itemStyle: { color: P.gold },
          areaStyle: { color: withAlpha(P.gold, 0.13) },
          label: { show: true, position: "top", color: P.axis, fontSize: 10 },
        },
      ],
    };
  }, [stats, P, AXIS, SPLIT, TT]);

  const gaugeOption = useMemo(
    () => ({
      series: [
        {
          type: "gauge",
          startAngle: 210,
          endAngle: -30,
          min: 0,
          max: 100,
          radius: "95%",
          center: ["50%", "60%"],
          progress: {
            show: true,
            width: 12,
            itemStyle: { color: P.green },
          },
          axisLine: { lineStyle: { width: 12, color: [[1, withAlpha(P.accent, 0.12)]] } },
          axisTick: { show: false },
          splitLine: { show: false },
          axisLabel: { show: false },
          pointer: { show: false },
          detail: {
            valueAnimation: true,
            formatter: "{value}",
            color: P.green,
            fontSize: 34,
            offsetCenter: [0, 0],
          },
          title: { color: P.axis, fontSize: 12, offsetCenter: [0, "46%"] },
          data: [{ value: stats?.quality_score ?? 0, name: "数据质量综合分" }],
        },
      ],
    }),
    [stats, P],
  );

  const s = stats;
  return (
    <div className="bs-page">
      <div className="bs-hdr">
        <h1>资源概览</h1>
        <div className="bs-clock">
          {now.toLocaleDateString("zh-CN")} {now.toLocaleTimeString("zh-CN", { hour12: false })}
        </div>
      </div>

      <div className="bs-kpis">
        <div className="bs-kpi hl">
          <Num v={s?.total ?? "—"} />
          <span>不可移动文物总量</span>
          <em>全市在册不可移动文物</em>
        </div>
        <div className="bs-kpi">
          <Num v={s?.designated_total ?? "—"} />
          <span>各级文物保护单位</span>
          <em>国保 {s?.by_rank?.[0]?.value ?? 0} · 省保 {s?.by_rank?.[1]?.value ?? 0}</em>
        </div>
        <div className="bs-kpi">
          <Num v={s?.assets.photos ?? "—"} />
          <span>文物影像 (张)</span>
          <em>图纸 {s?.assets.drawings ?? 0} 张</em>
        </div>
        <div className="bs-kpi">
          <Num v={s?.assets.models_3d ?? "—"} />
          <span>三维模型 (处)</span>
          <em>实景三维建模</em>
        </div>
        <div className="bs-kpi">
          <Num v={(s?.assets.archive_spu ?? 0) + (s?.assets.archive_fpu ?? 0)} />
          <span>普查档案 (卷)</span>
          <em>三普 / 四普档案</em>
        </div>
        <div className="bs-kpi">
          <Num v={s?.assets.boundaries ?? "—"} />
          <span>两线范围矢量 (处)</span>
          <em>保护范围 + 建控地带</em>
        </div>
      </div>

      <div className="bs-grid">
        <div className="bs-card">
          <h3>保护级别构成</h3>
          <ReactECharts option={rankOption} style={{ height: 220 }} notMerge />
        </div>
        <div className="bs-card">
          <h3>县市区分布</h3>
          <ReactECharts option={countyOption} style={{ height: 220 }} notMerge />
        </div>
        <div className="bs-card">
          <h3>文物类别</h3>
          <ReactECharts
            option={pieOption(s?.by_category || [], "类别", (n) => CATEGORY_MAP[categoryCode(n)]?.color)}
            style={{ height: 220 }}
            notMerge
          />
        </div>

        <div className="bs-card">
          <h3>保存状况</h3>
          <ReactECharts
            option={pieOption(s?.by_condition || [], "保存状况", (n) => CONDITION_COLOR[n])}
            style={{ height: 220 }}
            notMerge
          />
        </div>
        <div className="bs-card">
          <h3>年代序列</h3>
          <ReactECharts option={eraOption} style={{ height: 220 }} notMerge />
        </div>
        <div className="bs-card">
          <h3>数据质量</h3>
          <div className="bs-quality">
            <ReactECharts option={gaugeOption} style={{ height: 150, width: 170 }} notMerge />
            <div className="bs-comp">
              {Object.entries(s?.completeness || {}).map(([k, pct]) => (
                <div key={k} className="bs-comp-row">
                  <span>{COMPLETENESS_LABEL[k] || k}</span>
                  <div className="bs-bar">
                    <i style={{ width: `${pct}%` }} />
                  </div>
                  <b>{pct}%</b>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="bs-foot">
        <div className="bs-flow">
          <h3>巡查应用</h3>
          <div className="bs-flow-items">
            <div>
              <Num v={patrol?.route_total ?? 0} />
              <span>巡查路线</span>
            </div>
            <div>
              <Num v={patrol?.record_this_month ?? 0} />
              <span>本月打卡</span>
            </div>
            <div>
              <Num v={patrol?.overdue_count ?? 0} />
              <span>待巡查(逾期)</span>
            </div>
            <Link to="/patrol" className="bs-link">
              进入巡查规划 →
            </Link>
          </div>
        </div>
        <div className="bs-note">
          数据来源:{window.__PLATFORM_CONFIG?.project?.data_source || "演示数据"} ·
          截至 {window.__PLATFORM_CONFIG?.project?.data_cutoff || "—"}
        </div>
      </div>
    </div>
  );
}
