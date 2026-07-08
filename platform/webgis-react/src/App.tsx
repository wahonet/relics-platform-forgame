import { useCallback, useEffect, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { Header } from "./components/Header";
import { Toolbar } from "./components/Toolbar";
import { FilterPanel } from "./components/FilterPanel";
import { Dashboard } from "./components/Dashboard";
import { InfoPanel } from "./components/InfoPanel";
import { ChatPanel } from "./components/ChatPanel";
import { PatrolPanel } from "./components/PatrolPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { CoordReadout } from "./components/CoordReadout";
import { MapLegend } from "./components/MapLegend";
import { CoordReadoutRestore } from "./components/CoordReadoutRestore";
import { CrsInspectorPanel } from "./components/CrsInspectorPanel";
import { Toast } from "./components/Toast";
import { ConfirmHost } from "./components/ConfirmModal";
import { Compass } from "./components/Compass";
import { MapView } from "./map/MapView";
import DashboardPage from "./pages/DashboardPage";
import AdminPage from "./pages/AdminPage";
import { usePlatformStore } from "./stores/platformStore";
import { useRelicsStore } from "./stores/relicsStore";
import { useUIStore } from "./stores/uiStore";
import { ErrorBoundary } from "./components/ErrorBoundary";

export type AppTab = "map" | "dashboard" | "patrol" | "admin";

function tabFromPath(pathname: string): AppTab {
  if (pathname.startsWith("/dashboard")) return "dashboard";
  if (pathname.startsWith("/patrol")) return "patrol";
  if (pathname.startsWith("/admin")) return "admin";
  return "map";
}

function App() {
  const platformLoaded = usePlatformStore((s) => s.loaded);
  const platformLoad = usePlatformStore((s) => s.load);
  const relicsLoaded = useRelicsStore((s) => s.loaded);
  const relicsLoading = useRelicsStore((s) => s.loading);
  const relicsLoad = useRelicsStore((s) => s.load);
  const relicsRetry = useRelicsStore((s) => s.retry);
  const loadError = useRelicsStore((s) => s.loadError);
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const tab = tabFromPath(location.pathname);
  const isMap = tab === "map";
  const isPatrol = tab === "patrol";
  // 地图在总览与巡查两个标签共用同一个 Cesium 实例,仅切换布局
  const mapVisible = isMap || isPatrol;

  const [compassRot, setCompassRot] = useState(0);
  const [scale, setScale] = useState("");

  useEffect(() => {
    if (!platformLoaded) platformLoad();
  }, [platformLoaded, platformLoad]);

  useEffect(() => {
    if (!relicsLoaded && !relicsLoading) relicsLoad();
  }, [relicsLoaded, relicsLoading, relicsLoad]);

  // 旧链接 /?patrol=1 → 跳到独立巡查页。
  useEffect(() => {
    if (searchParams.get("patrol") === "1") {
      setSearchParams({}, { replace: true });
      navigate("/patrol", { replace: true });
    }
  }, [searchParams, setSearchParams, navigate]);

  // 巡查页:面板常开 + body 加布局类(地图让出左侧栏位);离开时自动清理路线与选点。
  useEffect(() => {
    useUIStore.getState().set({ patrolPanelOpen: isPatrol });
    document.body.classList.toggle("patrol-mode", isPatrol);
    return () => document.body.classList.remove("patrol-mode");
  }, [isPatrol]);

  const onCompassRotate = useCallback((deg: number) => setCompassRot(deg), []);
  const onScaleUpdate = useCallback((label: string) => setScale(label), []);

  return (
    <>
      <ErrorBoundary label="Header"><Header activeTab={tab} /></ErrorBoundary>

      {/* 地图常驻挂载,切换标签时仅隐藏,避免 Cesium 重建 */}
      <div style={{ display: mapVisible ? "contents" : "none" }}>
        <ErrorBoundary label="MapView">
          <MapView onCompassRotate={onCompassRotate} onScaleUpdate={onScaleUpdate} />
        </ErrorBoundary>
        <Compass rotation={compassRot} scale={scale} />
        {/* 巡查页左栏(patrolPanelOpen 由标签驱动,面板自身在非巡查页返回 null) */}
        <ErrorBoundary label="PatrolPanel"><PatrolPanel /></ErrorBoundary>
        <ErrorBoundary label="SettingsPanel"><SettingsPanel /></ErrorBoundary>
      </div>

      {/* 地图总览专属 UI,巡查页不显示 */}
      <div style={{ display: isMap ? "contents" : "none" }}>
        <ErrorBoundary label="Toolbar"><Toolbar /></ErrorBoundary>
        <ErrorBoundary label="FilterPanel"><FilterPanel /></ErrorBoundary>
        <ErrorBoundary label="Dashboard"><Dashboard /></ErrorBoundary>
        <ErrorBoundary label="InfoPanel"><InfoPanel /></ErrorBoundary>
        <ErrorBoundary label="ChatPanel"><ChatPanel /></ErrorBoundary>
        <ErrorBoundary label="CoordReadout"><CoordReadout /></ErrorBoundary>
        <ErrorBoundary label="MapLegend"><MapLegend /></ErrorBoundary>
        <ErrorBoundary label="CoordReadoutRestore"><CoordReadoutRestore /></ErrorBoundary>
        <ErrorBoundary label="CrsInspectorPanel"><CrsInspectorPanel /></ErrorBoundary>
      </div>

      {tab === "dashboard" && (
        <div className="page-host">
          <ErrorBoundary label="DashboardPage"><DashboardPage /></ErrorBoundary>
        </div>
      )}
      {tab === "admin" && (
        <div className="page-host">
          <ErrorBoundary label="AdminPage"><AdminPage /></ErrorBoundary>
        </div>
      )}

      {mapVisible && (!platformLoaded || (!relicsLoaded && relicsLoading)) && (
        <div className="center-loader">
          <div className="spinner" />
          {!platformLoaded ? "正在拉取平台配置..." : "正在加载文物数据..."}
        </div>
      )}
      {mapVisible && loadError ? (
        <div className="center-loader load-error">
          <span>数据加载失败: {loadError}</span>
          <button className="pp-btn sm" onClick={relicsRetry}>重试</button>
        </div>
      ) : null}
      <Toast />
      <ConfirmHost />
    </>
  );
}

export default App;
