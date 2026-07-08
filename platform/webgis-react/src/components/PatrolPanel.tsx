import { useCallback, useEffect, useMemo, useState } from "react";
import { useUIStore } from "../stores/uiStore";
import { usePatrolStore } from "../stores/patrolStore";
import {
  planPatrol,
  createRoute,
  listRoutes,
  getRoute,
  deleteRoute,
  fetchPatrolStats,
  fetchPatrolConfig,
  qrUrl,
  type PatrolConfig,
} from "../api/patrol";
import type { PatrolRoute, PatrolStats } from "../types";
import { getRouteLayer } from "../map/RouteLayer";
import { PatrolReportModal } from "./PatrolReportModal";
import { confirmDialog } from "./ConfirmModal";

type TabKey = "plan" | "routes";

const PLAN_EXAMPLES = [
  "巡查武氏墓群石刻附近的大约5处文物",
  "规划本月的巡查路线",
  "嘉祥县保存较差的文物巡查",
];

function fmtKm(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
}

function fmtDur(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h > 0 ? `${h}小时${m}分` : `${m}分钟`;
}

const STATUS_LABEL: Record<string, string> = {
  planned: "待巡查",
  doing: "巡查中",
  done: "已完成",
};

export function PatrolPanel() {
  const open = useUIStore((s) => s.patrolPanelOpen);
  const showToast = useUIStore((s) => s.showToast);

  const picking = usePatrolStore((s) => s.picking);
  const pickingStart = usePatrolStore((s) => s.pickingStart);
  const startPoint = usePatrolStore((s) => s.startPoint);
  const stops = usePatrolStore((s) => s.stops);
  const suggestions = usePatrolStore((s) => s.suggestions);
  const activeSuggestion = usePatrolStore((s) => s.activeSuggestion);
  const previewMeta = usePatrolStore((s) => s.previewMeta);

  const [tab, setTab] = useState<TabKey>("plan");
  const [planText, setPlanText] = useState("");
  const [planning, setPlanning] = useState(false);
  const [planExplain, setPlanExplain] = useState("");
  const [planParser, setPlanParser] = useState("");
  const [routeName, setRouteName] = useState("");
  const [planDate, setPlanDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [optimize, setOptimize] = useState(true);
  const [saving, setSaving] = useState(false);

  const [routes, setRoutes] = useState<PatrolRoute[]>([]);
  const [activeRoute, setActiveRoute] = useState<PatrolRoute | null>(null);
  const [stats, setStats] = useState<PatrolStats | null>(null);
  const [config, setConfig] = useState<PatrolConfig | null>(null);
  const [reportRouteId, setReportRouteId] = useState<number | null>(null);

  // 打开面板 → 进入选点模式 + 拉基础数据;关闭 → 清理地图。
  useEffect(() => {
    const ps = usePatrolStore.getState();
    if (open) {
      ps.setPicking(true);
      fetchPatrolStats().then(setStats).catch(() => undefined);
      fetchPatrolConfig().then(setConfig).catch(() => undefined);
      refreshRoutes();
    } else {
      ps.resetAll();
      getRouteLayer()?.clearRoute();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const refreshRoutes = useCallback(() => {
    listRoutes().then(setRoutes).catch(() => undefined);
  }, []);

  const doPlan = async (text?: string) => {
    const t = (text ?? planText).trim();
    if (!t || planning) return;
    setPlanning(true);
    setPlanExplain("");
    try {
      const resp = await planPatrol(t);
      usePatrolStore.getState().setSuggestions(resp.routes);
      setPlanExplain(resp.explanation);
      setPlanParser(resp.parser);
      // 「从XX出发」解析出的出发点自动填入(未识别则保留手选的起点)
      if (resp.start) {
        usePatrolStore.getState().setStartPoint({
          lng: resp.start.lng,
          lat: resp.start.lat,
          name: resp.start.name || "AI 识别起点",
        });
      }
      if (resp.routes.length === 1) {
        usePatrolStore.getState().adoptSuggestion(0);
        const s0 = resp.routes[0];
        getRouteLayer()?.flyToRoute(
          resp.start ? [resp.start, ...s0.stops] : s0.stops,
        );
        // 路线名跟随本次规划结果(如 20260706嘉祥县国保巡查),覆盖旧值
        setRouteName(s0.name || "");
      }
    } catch (e) {
      const msg =
        (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail ||
        "规划失败,请换个说法试试";
      showToast(msg);
    } finally {
      setPlanning(false);
    }
  };

  const adopt = (i: number) => {
    usePatrolStore.getState().adoptSuggestion(i);
    const s = usePatrolStore.getState().suggestions[i];
    if (s) {
      getRouteLayer()?.flyToRoute(s.stops);
      setRouteName(s.name || "");
    }
  };

  const save = async () => {
    if (stops.length < 2) {
      showToast("请至少选择 2 个文物点");
      return;
    }
    setSaving(true);
    try {
      const sug = activeSuggestion >= 0 ? suggestions[activeSuggestion] : null;
      const route = await createRoute({
        name: routeName.trim() || sug?.name || "",
        codes: stops.map((s) => s.code),
        plan_date: planDate,
        mode: sug ? "ai" : "manual",
        optimize: sug ? false : optimize,
        start: startPoint ?? undefined,
      });
      showToast("路线已保存,扫码即可开始巡查");
      usePatrolStore.getState().clearStops();
      usePatrolStore.getState().setSuggestions([]);
      setPlanExplain("");
      setRouteName("");
      refreshRoutes();
      setTab("routes");
      openRoute(route.id);
    } catch (e) {
      const msg =
        (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail ||
        "保存失败";
      showToast(msg);
    } finally {
      setSaving(false);
    }
  };

  const openRoute = async (id: number) => {
    try {
      const r = await getRoute(id);
      setActiveRoute(r);
      getRouteLayer()?.showRoute(r.stops, r.polyline, r.start);
      getRouteLayer()?.flyToRoute(r.start ? [r.start, ...r.stops] : r.stops);
    } catch {
      showToast("路线加载失败");
    }
  };

  const removeRoute = async (id: number) => {
    const ok = await confirmDialog({
      title: "删除巡查路线",
      body: "删除这条巡查路线?打卡记录将一并删除。",
      danger: true,
      okText: "删除",
    });
    if (!ok) return;
    try {
      await deleteRoute(id);
      if (activeRoute?.id === id) {
        setActiveRoute(null);
        getRouteLayer()?.clearRoute();
      }
      refreshRoutes();
      showToast("已删除", "success");
    } catch {
      showToast("删除失败", "error");
    }
  };

  const dueSummary = useMemo(() => {
    if (!stats) return "";
    return `${stats.overdue_count} 处已逾期 · 未来 7 天到期 ${stats.due_7days} 处`;
  }, [stats]);

  if (!open) return null;

  return (
    <>
      <div className="patrol-panel">
        <div className="pp-hdr">
          <h3>巡查规划</h3>
          <span className="pp-hint">
            {config?.amap_enabled ? "高德路径已启用" : "直线连接(未配置高德 Key)"}
          </span>
        </div>

        <div className="pp-tabs">
          <button className={tab === "plan" ? "on" : ""} onClick={() => setTab("plan")}>
            规划路线
          </button>
          <button
            className={tab === "routes" ? "on" : ""}
            onClick={() => {
              setTab("routes");
              refreshRoutes();
            }}
          >
            路线管理{routes.length ? ` (${routes.length})` : ""}
          </button>
        </div>

        {tab === "plan" && (
          <div className="pp-body">
            {stats ? (
              <div className="pp-due">
                <div className="pp-due-text">
                  <b>巡查提醒</b>
                  <span>{dueSummary}</span>
                </div>
              </div>
            ) : null}

            <div className="pp-sec">
              <div className="pp-label">AI 智能规划</div>
              <div className="pp-ai-row">
                <textarea
                  value={planText}
                  placeholder='试试:"巡查武氏墓群石刻附近的大约5处文物"'
                  onChange={(e) => setPlanText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      doPlan();
                    }
                  }}
                  rows={2}
                />
                <button className="pp-btn primary" disabled={planning} onClick={() => doPlan()}>
                  {planning ? "规划中..." : "生成方案"}
                </button>
              </div>
              <div className="pp-examples">
                {PLAN_EXAMPLES.map((ex) => (
                  <span key={ex} onClick={() => setPlanText(ex)}>
                    {ex}
                  </span>
                ))}
              </div>
              {planExplain ? (
                <div className="pp-explain">
                  {planExplain}
                  {planParser === "llm" ? <em> · 大模型解析</em> : <em> · 规则解析</em>}
                </div>
              ) : null}
              {suggestions.length > 1 && (
                <div className="pp-suggestions">
                  {suggestions.map((s, i) => (
                    <div
                      key={i}
                      className={"pp-sug" + (activeSuggestion === i ? " on" : "")}
                      onClick={() => adopt(i)}
                    >
                      <div className="pp-sug-name">{s.name}</div>
                      <div className="pp-sug-meta">
                        {s.stops.length} 站 · {fmtKm(s.distance_m)} · {fmtDur(s.duration_s)}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="pp-sec">
              <div className="pp-label">
                出发起点(可选)
                <label className="pp-pick-toggle" title="开启后在地图上点击任意位置设为出发点">
                  <input
                    type="checkbox"
                    checked={pickingStart}
                    onChange={(e) => usePatrolStore.getState().setPickingStart(e.target.checked)}
                  />
                  地图选起点
                </label>
              </div>
              {startPoint ? (
                <div className="pp-start-row">
                  <span className="pp-start-badge">起</span>
                  <span className="pp-start-coord" title={`${startPoint.lng.toFixed(5)}, ${startPoint.lat.toFixed(5)}`}>
                    {startPoint.name && startPoint.name !== "自定义起点"
                      ? startPoint.name
                      : `${startPoint.lng.toFixed(5)}, ${startPoint.lat.toFixed(5)}`}
                  </span>
                  <button
                    className="pp-btn sm"
                    onClick={() => usePatrolStore.getState().setStartPoint(null)}
                  >
                    清除
                  </button>
                </div>
              ) : (
                <div className="pp-empty">
                  {pickingStart
                    ? "在地图上点击任意位置设为出发点..."
                    : "未设置,默认从第一站出发。勾选「地图选起点」后在地图上点选。"}
                </div>
              )}
            </div>

            <div className="pp-sec">
              <div className="pp-label">
                途经文物点 ({stops.length})
                <label className="pp-pick-toggle">
                  <input
                    type="checkbox"
                    checked={picking}
                    onChange={(e) => usePatrolStore.getState().setPicking(e.target.checked)}
                  />
                  地图选点
                </label>
              </div>
              {stops.length === 0 ? (
                <div className="pp-empty">
                  在地图上点击文物点加入路线,或使用上方 AI 规划。
                </div>
              ) : (
                <div className="pp-stops">
                  {stops.map((s, i) => (
                    <div key={s.code} className="pp-stop">
                      <span className="pp-stop-idx">{i + 1}</span>
                      <span className="pp-stop-name" title={s.code}>
                        {s.name}
                        {s.condition ? (
                          <em className={"cond-" + s.condition}>{s.condition}</em>
                        ) : null}
                      </span>
                      <span className="pp-stop-ops">
                        <button title="上移" onClick={() => usePatrolStore.getState().moveStop(s.code, -1)}>
                          <svg viewBox="0 0 24 24"><path d="M12 8l-6 6 1.4 1.4L12 10.8l4.6 4.6L18 14z" /></svg>
                        </button>
                        <button title="下移" onClick={() => usePatrolStore.getState().moveStop(s.code, 1)}>
                          <svg viewBox="0 0 24 24"><path d="M12 16l6-6-1.4-1.4L12 13.2 7.4 8.6 6 10z" /></svg>
                        </button>
                        <button title="移除" onClick={() => usePatrolStore.getState().removeStop(s.code)}>
                          <svg viewBox="0 0 24 24"><path d="M19 6.4L17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z" /></svg>
                        </button>
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {previewMeta ? (
                <div className="pp-preview-meta">
                  预计 {fmtKm(previewMeta.distance_m)} · {fmtDur(previewMeta.duration_s)}
                  {previewMeta.source === "amap" ? " · 高德驾车路径" : " · 直线估算"}
                </div>
              ) : null}
            </div>

            <div className="pp-sec">
              <div className="pp-label">保存为巡查路线</div>
              <input
                className="pp-input"
                placeholder="路线名称(留空自动命名)"
                value={routeName}
                onChange={(e) => setRouteName(e.target.value)}
              />
              <div className="pp-save-row">
                <input
                  type="date"
                  className="pp-input"
                  value={planDate}
                  onChange={(e) => setPlanDate(e.target.value)}
                />
                <label className="pp-pick-toggle">
                  <input
                    type="checkbox"
                    checked={optimize}
                    disabled={activeSuggestion >= 0}
                    onChange={(e) => setOptimize(e.target.checked)}
                  />
                  自动优化顺序
                </label>
              </div>
              <button
                className="pp-btn primary block"
                disabled={saving || stops.length < 2}
                onClick={save}
              >
                {saving ? "保存中..." : "保存并生成二维码"}
              </button>
              {stops.length > 0 && (
                <button
                  className="pp-btn block"
                  onClick={() => {
                    usePatrolStore.getState().clearStops();
                    usePatrolStore.getState().setSuggestions([]);
                    setPlanExplain("");
                  }}
                >
                  清空当前选点
                </button>
              )}
            </div>
          </div>
        )}

        {tab === "routes" && (
          <div className="pp-body">
            {routes.length === 0 ? (
              <div className="pp-empty">还没有巡查路线,先去"规划路线"创建一条。</div>
            ) : (
              <div className="pp-routes">
                {routes.map((r) => (
                  <div
                    key={r.id}
                    className={"pp-route" + (activeRoute?.id === r.id ? " on" : "")}
                    onClick={() => openRoute(r.id)}
                  >
                    <div className="pp-route-top">
                      <span className="pp-route-name">{r.name}</span>
                      <span className={"pp-status st-" + r.status}>
                        {STATUS_LABEL[r.status] || r.status}
                      </span>
                    </div>
                    <div className="pp-route-meta">
                      {r.plan_date || "未定日期"} · {r.stop_count} 站 · {fmtKm(r.distance_m)} ·
                      已巡 {r.checked_count}/{r.stop_count}
                    </div>
                    {r.stop_count > 0 ? (
                      <div className="pp-route-prog">
                        <i style={{ width: `${Math.min(100, (r.checked_count / r.stop_count) * 100)}%` }} />
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            )}

            {activeRoute ? (
              <div className="pp-route-detail">
                <div className="pp-label">
                  {activeRoute.name}
                  <button
                    className="pp-btn sm danger"
                    style={{ marginLeft: "auto" }}
                    onClick={() => removeRoute(activeRoute.id)}
                  >
                    删除
                  </button>
                </div>
                <div className="pp-qr">
                  <img src={qrUrl(activeRoute.id)} alt="巡查二维码" />
                  <div className="pp-qr-tip">
                    <b>手机扫码开始巡查</b>
                    <p>
                      微信/相机扫码打开移动端页面:一键唤起高德导航(自动带途经点),
                      到点拍照打卡,GPS 自动核验是否在现场。
                    </p>
                    <p className="pp-qr-url">{activeRoute.mobile_url}</p>
                  </div>
                </div>
                <div className="pp-stops">
                  {activeRoute.stops.map((s, i) => (
                    <div key={s.code} className="pp-stop">
                      <span
                        className={
                          "pp-stop-idx" +
                          (s.verified ? " ok" : s.checked ? " warn" : "")
                        }
                      >
                        {i + 1}
                      </span>
                      <span className="pp-stop-name">
                        {s.name}
                        {s.verified ? (
                          <em className="cond-好">已核验</em>
                        ) : s.checked ? (
                          <em className="cond-一般">已打卡</em>
                        ) : null}
                      </span>
                    </div>
                  ))}
                </div>
                <button
                  className="pp-btn primary block"
                  onClick={() => setReportRouteId(activeRoute.id)}
                >
                  查看巡查报告
                </button>
              </div>
            ) : null}
          </div>
        )}
      </div>

      {reportRouteId != null && (
        <PatrolReportModal
          routeId={reportRouteId}
          onClose={() => {
            setReportRouteId(null);
            if (activeRoute) openRoute(activeRoute.id);
          }}
        />
      )}
    </>
  );
}
